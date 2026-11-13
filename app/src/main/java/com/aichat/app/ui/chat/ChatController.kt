package com.aichat.app.ui.chat

import com.aichat.app.domain.StreamEvent
import com.aichat.app.domain.model.AppSettings
import com.aichat.app.domain.model.Conversation
import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.Role
import com.aichat.app.domain.model.Usage
import com.aichat.app.data.files.FileText
import com.aichat.app.ui.common.UiDeps
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** 一路进行中的流式回复（UI 侧临时态；落盘由 ChatEngine 负责） */
data class Streaming(
    val convId: String,
    val base: List<Message>,          // 流开始时、生成目标之前的消息
    val pendingUser: Message?,        // 本轮用户消息（乐观显示；收到 Started 后换成真实 id）
    val liveId: String = ChatUiState.STREAMING_ID,
    val prefix: Message? = null,      // 续写 / 原位重生成：目标消息原有的字段（版本信息、续写前的正文）
    val text: String = "",
    val reasoning: String = "",
    val error: String? = null,
    val usage: Usage? = null,
    val startedAt: Long = System.currentTimeMillis(),
    /** 带文件附件发送时：流结束后把用户消息改回「原文 + files」（见 [ChatController.send]） */
    val filePatch: FilePatch? = null,
)

data class FilePatch(val sentText: String, val rawText: String, val files: List<JsonObject>)

data class ChatUiState(
    val convId: String? = null,
    val conv: Conversation? = null,
    val streams: Map<String, Streaming> = emptyMap(),
    val toast: String? = null,
    /** 输入区待发送的图片（data URL）/ 文件（已抽取文字）。放在这里而不是 rememberSaveable：体积大，不能进 Bundle */
    val draftImages: List<String> = emptyList(),
    val draftFiles: List<JsonObject> = emptyList(),
) {
    val streaming: Streaming? get() = convId?.let { streams[it] }
    val isStreaming: Boolean get() = streaming != null

    /** 消息列表 = 已落盘消息；流式中 = 目标之前的消息 + 乐观用户消息 + 正在生成的助手消息 */
    val messages: List<Message> get() {
        val s = streaming ?: return conv?.messages.orEmpty()
        val p = s.prefix
        val live = (p ?: Message(s.liveId, Role.ASSISTANT, "", s.startedAt)).copy(
            id = s.liveId, content = (p?.content ?: "") + s.text,
            reasoning = ((p?.reasoning ?: "") + s.reasoning).ifEmpty { null },
            error = s.error, usage = s.usage ?: p?.usage, truncated = false)
        return s.base + listOfNotNull(s.pendingUser) + live
    }

    companion object { const val STREAMING_ID = "__streaming__" }
}

/**
 * 聊天页逻辑（与 Compose 无关，可 JVM 单测）。只依赖契约：ChatRepository / SettingsRepository / ChatEngine。
 *
 * 与引擎的分工（照 app.js：UI 的 regenerate()/editMsg() 先整理版本，再交给 runChat()）：
 *  - 重新生成：UI 先 Versions.addVersion（或失败/空回复原位清空）并保存，再调 engine.regenerate(convId, 该消息 id)，引擎原位写入；
 *  - 编辑并重发：UI 在用户消息上 addVersion，追加一条空助手消息并保存，再对它调 engine.regenerate；
 *  - 续写：直接 engine.continueGeneration，引擎在同一条消息后追加。
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
    fun setDraftFiles(list: List<JsonObject>) = _state.update { it.copy(draftFiles = list) }

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
            save(c.copy(title = t), touch = false)
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
            save(c.copy(providerId = providerId, model = model), touch = false)
        }
    }

    /** 当前对话的系统提示词（模板 / 清空）。templateId 等是旧版 conv 上的未建模键，经 extras 原样保留 */
    fun setConversationSystem(text: String, templateId: String?, templateName: String?, templateEmoji: String?) {
        scope.launch {
            val c = _state.value.conv ?: deps.chats.create(currentTarget()?.first?.id ?: "", currentTarget()?.second ?: "")
            val ex = c.extras.toMutableMap()
            if (templateId != null) {
                ex["templateId"] = JsonPrimitive(templateId); ex["templateName"] = JsonPrimitive(templateName ?: "")
                ex["templateEmoji"] = JsonPrimitive(templateEmoji ?: "")
            } else { ex.remove("templateId"); ex.remove("templateName"); ex.remove("templateEmoji") }
            _state.update { it.copy(convId = c.id) }
            save(c.copy(systemPrompt = text, extras = JsonObject(ex)), touch = false)
        }
    }

    /** 发送时联网搜索开关（settings.searchOn，同旧版输入框左侧地球按钮） */
    fun setSearchOn(on: Boolean) {
        scope.launch { deps.settings.update { it.copy(searchOn = on) }; toast(if (on) "联网搜索已开启" else "联网搜索已关闭") }
    }

    /** 对话级插件开关：conv.extras.plugins[id].enabled */
    fun setConversationPlugin(pluginId: String, on: Boolean) {
        val c = _state.value.conv ?: return
        scope.launch { save(c.copy(extras = com.aichat.app.ui.settings.PluginToggles.withConvEnabled(c.extras, pluginId, on)), touch = false) }
    }

    /** 单个对话导出（与旧版 exportConvLegacy 同格式，由数据层生成） */
    suspend fun exportJson(id: String): String = deps.chats.exportJson(id)

    fun titleOf(id: String): String = deps.chats.index.value.firstOrNull { it.id == id }?.title ?: "对话"

    // ---------------- 发送 / 生成 ----------------

    fun send(text: String, images: List<String>, files: List<JsonObject> = emptyList()): Boolean {
        val body = text.trim()
        if (body.isEmpty() && images.isEmpty() && files.isEmpty()) return false
        if (_state.value.isStreaming) return false
        val target = currentTarget()
        if (target == null) { toast("请先在设置里添加服务商和模型"); return false }
        // ChatEngine.send 没有 files 参数：先按旧版 Files.buildFileContext 把文件拼进本轮文字（模型看到的与旧版一致），
        // 流结束后再把落盘的用户消息改回「原文 + files[]」。TODO(D/B)：契约加 files 参数后去掉这段。
        val withText = files.filter { !(it["text"] as? JsonPrimitive)?.content.isNullOrEmpty() }
        val scanned = files.filter { (it["scanned"] as? JsonPrimitive)?.content == "true" }
        // 扫描版 PDF 的提示语与 app.js toRequestMsg 一致（页图已作为 images 一起发送）
        val body2 = if (scanned.isEmpty()) body else "（附带的 " + scanned.joinToString("、") { "「" + ((it["name"] as? JsonPrimitive)?.content ?: "") + "」" } +
            " 为扫描版 PDF，已转成图片附上，请识别图片中的文字。）\n" + body.ifEmpty { "请识别并概括这些图片中的内容。" }
        val sent = if (withText.isNotEmpty()) FileText.buildFileContext(withText, body2) else body2
        scope.launch {
            val conv = _state.value.conv ?: deps.chats.create(target.first.id, target.second).also { c ->
                _state.update { it.copy(convId = c.id, conv = c) }
            }
            val pending = Message(PENDING_USER_ID, Role.USER, body, now(), images = images, files = files)
            startStream(conv.id, Streaming(conv.id, conv.messages, pending, startedAt = now(),
                filePatch = if (files.isNotEmpty()) FilePatch(sent, body, files) else null)) {
                deps.engine.send(conv.id, sent, images)
            }
        }
        return true
    }

    /** 重新生成（app.js regenerate）：返回 null = 已开始；否则为需要用户确认的提示（后面还有消息时） */
    fun regenerateNeedsConfirm(assistantId: String): String? {
        val c = _state.value.conv ?: return null
        val i = c.messages.indexOfFirst { it.id == assistantId }
        if (i < 0 || i == c.messages.size - 1) return null
        return "会为这条回复生成一个新版本。之后的 ${c.messages.size - i - 1} 条对话保留在旧版本里，可以用 ‹ › 切换回去。"
    }

    fun regenerate(assistantId: String) {
        val c = _state.value.conv ?: return
        if (_state.value.isStreaming) return
        val i = c.messages.indexOfFirst { it.id == assistantId }
        val m = c.messages.getOrNull(i) ?: return
        if (m.role != Role.ASSISTANT) return
        // 失败 / 空的回复不保留为版本，直接在原位置重试
        val path = if ((m.error != null || m.truncated) && m.content.isEmpty() && i == c.messages.size - 1)
            c.messages.take(i) + Versions.clearFields(m)
        else Versions.addVersion(c.messages, i)
        scope.launch {
            val nc = c.copy(messages = path)
            save(nc, touch = true)
            val target = path[i]
            startStream(c.id, Streaming(c.id, path.take(i), null, liveId = target.id, prefix = target.copy(content = "", reasoning = null), startedAt = now())) {
                deps.engine.regenerate(c.id, target.id)
            }
        }
    }

    fun canContinue(m: Message) = m.role == Role.ASSISTANT && m.content.isNotEmpty() &&
        (m.truncated || m.finishReason == "length" || m.error != null)

    fun continueGeneration(assistantId: String) {
        val c = _state.value.conv ?: return
        if (_state.value.isStreaming) return
        val i = c.messages.indexOfFirst { it.id == assistantId }
        val m = c.messages.getOrNull(i) ?: return
        if (!canContinue(m)) return
        scope.launch {
            startStream(c.id, Streaming(c.id, c.messages.take(i), null, liveId = m.id, prefix = m.copy(error = null), startedAt = now())) {
                deps.engine.continueGeneration(c.id, m.id)
            }
        }
    }

    /** 编辑（只保存）：app.js editMsg 的「保存」——改内容并标 edited */
    fun editMessage(msgId: String, text: String): Boolean {
        val c = _state.value.conv ?: return false
        val m = c.messages.firstOrNull { it.id == msgId } ?: return false
        if (text == m.content) return true
        if (m.role == Role.USER && text.isBlank() && m.images.isEmpty() && m.files.isEmpty()) { toast("消息不能为空"); return false }
        val nm = m.copy(content = text, extras = JsonObject(m.extras + ("edited" to JsonPrimitive(true)) - "rpSent"))
        scope.launch { save(c.copy(messages = c.messages.map { if (it.id == msgId) nm else it }), touch = true); toast("已保存") }
        return true
    }

    /** 编辑并重新发送：在这条用户消息上开新版本（原内容和之后的对话留在旧版本里），然后生成回复 */
    fun editAndResend(userMsgId: String, text: String): Boolean {
        val c = _state.value.conv ?: return false
        if (_state.value.isStreaming) { toast("请先停止当前生成"); return false }
        val i = c.messages.indexOfFirst { it.id == userMsgId }
        val m = c.messages.getOrNull(i) ?: return false
        if (m.role != Role.USER) return false
        if (text.isBlank() && m.images.isEmpty() && m.files.isEmpty()) { toast("消息不能为空"); return false }
        val init = buildMap {
            put("content", JsonPrimitive(text)); put("createdAt", JsonPrimitive(now()))
            if (m.images.isNotEmpty()) put("images", JsonArray(m.images.map { JsonPrimitive(it) }))
            if (m.files.isNotEmpty()) put("files", JsonArray(m.files))
        }
        val path = Versions.addVersion(c.messages, i, JsonObject(init))
        val placeholder = Message(newId(), Role.ASSISTANT, "", now())
        scope.launch {
            val nc = c.copy(messages = path + placeholder)
            save(nc, touch = true)
            startStream(c.id, Streaming(c.id, path, null, liveId = placeholder.id, prefix = placeholder, startedAt = now())) {
                deps.engine.regenerate(c.id, placeholder.id)
            }
        }
        return true
    }

    /** 切换版本 ‹ n/m ›（versions.select）；较早消息切换时后面的对话随之切到对应分支 */
    fun selectVersion(msgId: String, k: Int) {
        val c = _state.value.conv ?: return
        if (_state.value.isStreaming) return
        val i = c.messages.indexOfFirst { it.id == msgId }
        if (i < 0) return
        val path = Versions.select(c.messages, i, k)
        if (path === c.messages) return
        scope.launch { save(c.copy(messages = path), touch = false) }
    }

    fun stop() {
        val id = _state.value.convId ?: return
        deps.engine.stop(id)
        jobs[id]?.cancel()
    }

    private suspend fun save(c: Conversation, touch: Boolean) {
        deps.chats.save(c, touch)
        val fresh = deps.chats.load(c.id) ?: c
        _state.update { if (it.convId == c.id) it.copy(conv = fresh) else it }
    }

    private fun startStream(convId: String, s: Streaming, open: () -> Flow<StreamEvent>) {
        _state.update { it.copy(streams = it.streams + (convId to s)) }
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
            else -> started(ev)?.let { (u, a) ->
                s.copy(pendingUser = s.pendingUser?.copy(id = u ?: s.pendingUser.id), liveId = a ?: s.liveId)
            } ?: s
        }
        st.copy(streams = st.streams + (convId to ns))
    }

    private suspend fun finish(convId: String) {
        jobs.remove(convId)
        val s = _state.value.streams[convId]
        var reloaded = deps.chats.load(convId)
        // 带文件发送：把用户消息改回原文 + files（引擎存的是拼接后的文字）
        val fp = s?.filePatch
        if (fp != null && reloaded != null) {
            val uid = s.pendingUser?.id?.takeIf { it != PENDING_USER_ID }
            val idx = reloaded.messages.indexOfLast { it.role == Role.USER && (it.id == uid || (uid == null && it.content == fp.sentText)) }
            if (idx >= 0) {
                val msgs = reloaded.messages.toMutableList()
                msgs[idx] = msgs[idx].copy(content = fp.rawText, files = fp.files)
                deps.chats.save(reloaded.copy(messages = msgs, title = fixTitle(reloaded.title, fp)), touch = false)
                reloaded = deps.chats.load(convId)
            }
        }
        // 出错时引擎已把 error 写进助手消息（契约），这里不再重复提示
        _state.update { st ->
            st.copy(streams = st.streams - convId, conv = if (st.convId == convId) reloaded ?: st.conv else st.conv)
        }
    }

    private fun fixTitle(title: String, fp: FilePatch): String {
        val sentTitle = fp.sentText.lineSequence().first().take(24)
        if (title != sentTitle) return title
        val name = (fp.files.firstOrNull()?.get("name") as? JsonPrimitive)?.content
        return (fp.rawText.ifBlank { name?.let { "📄 $it" } ?: title }).replace(Regex("\\s+"), " ").take(24)
    }

    private var idSeq = 0
    private fun newId() = now().toString(36) + (++idSeq).toString(36) + (Math.random() * 1e6).toLong().toString(36)

    companion object {
        const val PENDING_USER_ID = "__pending_user__"

        /**
         * StreamEvent.Started(userMsgId, assistantMsgId)：协调者已确认、D 将加入契约（native/D）。
         * 契约落地前这里按名字反射读取，D 合入后改成 `is StreamEvent.Started ->` 一行即可。
         */
        fun started(ev: StreamEvent): Pair<String?, String?>? {
            if (ev.javaClass.simpleName != "Started") return null
            fun get(name: String) = runCatching { ev.javaClass.getMethod("get" + name.replaceFirstChar { it.uppercase() }).invoke(ev) as? String }.getOrNull()
            return get("userMsgId") to get("assistantMsgId")
        }
    }
}
