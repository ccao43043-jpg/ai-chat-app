package com.aichat.app.ui.chat

import com.aichat.app.domain.StreamEvent
import com.aichat.app.domain.model.AppSettings
import com.aichat.app.domain.model.Conversation
import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.Role
import com.aichat.app.domain.model.Usage
import com.aichat.app.ui.common.UiDeps
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 一路进行中的流式回复（UI 侧临时态；落盘由 ChatEngine 负责） */
data class Streaming(
    val convId: String,
    val base: List<Message>,          // 发送时对话已有的消息
    val pendingUser: Message?,        // 本轮用户消息（乐观显示）
    val text: String = "",
    val reasoning: String = "",
    val error: String? = null,
    val usage: Usage? = null,
    val startedAt: Long = System.currentTimeMillis(),
)

data class ChatUiState(
    val convId: String? = null,
    val conv: Conversation? = null,
    val streams: Map<String, Streaming> = emptyMap(),
    val toast: String? = null,
    /** 输入区待发送的图片（data URL）。放在这里而不是 rememberSaveable：体积大，不能进 Bundle */
    val draftImages: List<String> = emptyList(),
) {
    val streaming: Streaming? get() = convId?.let { streams[it] }
    val isStreaming: Boolean get() = streaming != null

    /** 消息列表 = 已落盘消息；流式中 = 发送时快照 + 乐观用户消息 + 正在生成的助手消息 */
    val messages: List<Message> get() {
        val s = streaming ?: return conv?.messages.orEmpty()
        val live = Message(STREAMING_ID, Role.ASSISTANT, s.text, s.startedAt, reasoning = s.reasoning.ifEmpty { null }, error = s.error, usage = s.usage)
        return s.base + listOfNotNull(s.pendingUser) + live
    }

    companion object { const val STREAMING_ID = "__streaming__" }
}

/**
 * 聊天页逻辑（与 Compose 无关，可 JVM 单测）。只依赖契约：ChatRepository / SettingsRepository / ChatEngine。
 */
class ChatController(private val deps: UiDeps, private val scope: CoroutineScope, private val now: () -> Long = System::currentTimeMillis) {
    private val _state = MutableStateFlow(ChatUiState())
    val state: StateFlow<ChatUiState> = _state.asStateFlow()
    private val jobs = HashMap<String, Job>()
    @Volatile private var touched = false

    val index get() = deps.chats.index
    val settings get() = deps.settings.settings

    init {
        // 启动：打开最近一次的对话
        scope.launch {
            val first = deps.chats.index.first { it.isNotEmpty() }.first()
            if (!touched && _state.value.convId == null) select(first.id)
        }
    }

    fun setDraftImages(list: List<String>) = _state.update { it.copy(draftImages = list) }

    fun consumeToast() = _state.update { it.copy(toast = null) }
    fun toast(msg: String) = _state.update { it.copy(toast = msg) }

    fun select(id: String?) {
        touched = true
        if (id == null) { _state.update { it.copy(convId = null, conv = null) }; return }
        _state.update { it.copy(convId = id) }
        scope.launch {
            val c = deps.chats.load(id)
            _state.update { if (it.convId == id) it.copy(conv = c) else it }
        }
    }

    /** 新建对话；当前对话本就是空的时直接复用（与旧版一致，避免一堆空对话） */
    fun newConversation() {
        val cur = _state.value.conv
        touched = true
        if (cur != null && cur.messages.isEmpty() && !_state.value.isStreaming) return
        _state.update { it.copy(convId = null, conv = null) }
    }

    fun delete(id: String) {
        scope.launch {
            jobs[id]?.let { deps.engine.stop(id); it.cancel() }
            deps.chats.delete(id)
            if (_state.value.convId == id) {
                _state.update { it.copy(convId = null, conv = null) }
                deps.chats.index.value.firstOrNull()?.let { select(it.id) }
            }
        }
    }

    fun rename(id: String, title: String) {
        val t = title.trim().ifEmpty { return }
        scope.launch {
            val c = deps.chats.load(id) ?: return@launch
            val nc = c.copy(title = t)
            deps.chats.save(nc, touch = false)
            _state.update { if (it.convId == id) it.copy(conv = nc) else it }
        }
    }

    /** 当前生效的服务商 / 模型：对话自己的优先，否则用 settings.lastProviderId/lastModel，再否则第一个可用的 */
    fun currentTarget(s: AppSettings = settings.value): Pair<ProviderConfig, String>? {
        val c = _state.value.conv
        val pid = c?.providerId?.takeIf { it.isNotEmpty() } ?: s.lastProviderId
        val p = s.providers.firstOrNull { it.id == pid } ?: s.providers.firstOrNull { it.models.any { m -> m.isNotBlank() } } ?: return null
        val wanted = c?.model?.takeIf { c.providerId == p.id && it.isNotEmpty() } ?: s.lastModel.takeIf { s.lastProviderId == p.id }
        val m = wanted?.takeIf { it.isNotEmpty() } ?: p.models.firstOrNull { it.isNotBlank() } ?: return null
        return p to m
    }

    fun setModel(providerId: String, model: String) {
        scope.launch {
            deps.settings.update { it.copy(lastProviderId = providerId, lastModel = model) }
            val c = _state.value.conv ?: return@launch
            val nc = c.copy(providerId = providerId, model = model)
            deps.chats.save(nc, touch = false)
            _state.update { if (it.convId == c.id) it.copy(conv = nc) else it }
        }
    }

    fun send(text: String, images: List<String>): Boolean {
        val body = text.trim()
        if (body.isEmpty() && images.isEmpty()) return false
        if (_state.value.isStreaming) return false
        val target = currentTarget()
        if (target == null) { toast("请先在设置里添加服务商和模型"); return false }
        scope.launch {
            val conv = _state.value.conv ?: deps.chats.create(target.first.id, target.second).also { c ->
                _state.update { it.copy(convId = c.id, conv = c) }
            }
            startStream(conv.id, conv.messages, Message(PENDING_USER_ID, Role.USER, body, now(), images = images)) {
                deps.engine.send(conv.id, body, images)
            }
        }
        return true
    }

    /** M2：重新生成 / 续写（UI 入口在 M2 接；这里先把管线备好） */
    fun regenerate(assistantId: String) = streamOnCurrent { id, c -> c.messages.takeWhile { it.id != assistantId } to deps.engine.regenerate(id, assistantId) }
    fun continueGeneration(assistantId: String) = streamOnCurrent { id, c -> c.messages to deps.engine.continueGeneration(id, assistantId) }

    private fun streamOnCurrent(make: (String, Conversation) -> Pair<List<Message>, kotlinx.coroutines.flow.Flow<StreamEvent>>) {
        val c = _state.value.conv ?: return
        if (_state.value.isStreaming) return
        val (base, flow) = make(c.id, c)
        scope.launch { startStream(c.id, base, null) { flow } }
    }

    fun stop() {
        val id = _state.value.convId ?: return
        deps.engine.stop(id)
        jobs[id]?.cancel()
    }

    private fun startStream(convId: String, base: List<Message>, pendingUser: Message?, open: () -> kotlinx.coroutines.flow.Flow<StreamEvent>) {
        _state.update { it.copy(streams = it.streams + (convId to Streaming(convId, base, pendingUser, startedAt = now()))) }
        val job = scope.launch {
            try {
                open().collect { ev -> onEvent(convId, ev) }
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                onEvent(convId, StreamEvent.Error(0, e.message ?: e.toString(), ""))
            } finally {
                withContext(NonCancellable) { finish(convId) }
            }
        }
        jobs[convId] = job
    }

    private fun onEvent(convId: String, ev: StreamEvent) = _state.update { st ->
        val s = st.streams[convId] ?: return@update st
        val ns = when (ev) {
            is StreamEvent.Delta -> s.copy(text = s.text + ev.text)
            is StreamEvent.Reasoning -> s.copy(reasoning = s.reasoning + ev.text)
            is StreamEvent.UsageUpdate -> s.copy(usage = ev.usage)
            is StreamEvent.Error -> s.copy(error = ev.message.ifEmpty { "HTTP ${ev.httpStatus}" })
            else -> s
        }
        st.copy(streams = st.streams + (convId to ns))
    }

    private suspend fun finish(convId: String) {
        jobs.remove(convId)
        val err = _state.value.streams[convId]?.error
        val reloaded = deps.chats.load(convId)
        _state.update { st ->
            st.copy(streams = st.streams - convId, conv = if (st.convId == convId) reloaded ?: st.conv else st.conv,
                toast = if (err != null && reloaded?.messages?.lastOrNull()?.error == null) "请求失败：$err" else st.toast)
        }
    }

    companion object { const val PENDING_USER_ID = "__pending_user__" }
}
