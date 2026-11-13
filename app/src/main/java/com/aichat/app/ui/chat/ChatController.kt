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

/** 需要 UI 配合的操作结果：直接提示 / 先确认再执行（文案照 app.js dialog） */
sealed interface Plan {
    data class Toast(val text: String) : Plan
    data class Ask(val title: String, val body: String?, val okText: String, val danger: Boolean = false, val run: () -> Unit) : Plan
    data object Done : Plan
}

data class ChatUiState(
    val convId: String? = null,
    val conv: Conversation? = null,
    val streams: Map<String, Streaming> = emptyMap(),
    val toast: String? = null,
    /** 输入区待发送的图片（data URL）/ 文件（已抽取文字）。放在这里而不是 rememberSaveable：体积大，不能进 Bundle */
    val draftImages: List<String> = emptyList(),
    val draftFiles: List<JsonObject> = emptyList(),
    /** 开着联网搜索但没配置好：UI 弹 app.js askSearchSetup 的对话框 */
    val askSearchSetup: Boolean = false,
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

    /** app.js applyTemplate：tpl=null 为清空；RP 对话先确认（RP_WARN）；已在使用时提示 */
    fun planApplyTemplate(tplId: String?, name: String?, emoji: String?, text: String, skill: Boolean = false): Plan {
        val c = _state.value.conv
        val rp = rpOn(c)
        if (tplId == null) {
            if (c?.systemPrompt.isNullOrEmpty() && c?.extras?.get("templateId") == null) return Plan.Toast("当前没有系统提示词")
            val go = { setConversationSystem("", null, null, null, JsonObject(mapOf("kind" to JsonPrimitive("clear")))); toast("已清空本对话的系统提示词") }
            if (rp) return Plan.Ask("清空系统提示词？", RP_WARN, "仍然清空") { go() }
            go(); return Plan.Done
        }
        if (text == (c?.systemPrompt ?: "") && (c?.extras?.get("templateId") as? JsonPrimitive)?.content == tplId) return Plan.Toast("已经在使用「$name」")
        val go = {
            setConversationSystem(text, tplId, name, emoji, JsonObject(mapOf("kind" to JsonPrimitive("template"), "name" to JsonPrimitive(name ?: ""))))
            toast(if (skill) "已启用「$name」：直接发一句想法或贴旧设定；之后可说「精修一下」「加秘密」等"
                else "已切换为「$name」" + if (c?.messages?.isNotEmpty() == true) "，从下一条消息开始生效" else "")
        }
        if (rp) return Plan.Ask("切换为「$name」？", RP_WARN, "切换") { go() }
        go(); return Plan.Done
    }

    /** app.js setConvSystem：模板键 templateId/templateName/templateEmoji 是旧版对话 JSON 顶层键（经 extras 原样往返）。
     *  RP 对话且规范化后内容变了 → RPCache.explicitBaseUpdate（C 的钩子）。JS 只在对话已有消息或 plugins 时保存；这里没有对话就先建一个 */
    fun setConversationSystem(text: String, templateId: String?, templateName: String?, templateEmoji: String?,
                              cause: JsonObject = JsonObject(emptyMap())) {
        scope.launch {
            val c = _state.value.conv ?: deps.chats.create(currentTarget()?.first?.id ?: "", currentTarget()?.second ?: "")
            val before = c.systemPrompt ?: ""
            val ex = c.extras.toMutableMap()
            if (templateId != null) {
                ex["templateId"] = JsonPrimitive(templateId); ex["templateName"] = JsonPrimitive(templateName ?: "")
                ex["templateEmoji"] = JsonPrimitive(templateEmoji ?: "")
            } else { ex.remove("templateId"); ex.remove("templateName"); ex.remove("templateEmoji") }
            var nc = c.copy(systemPrompt = text, extras = JsonObject(ex))
            if (rpOn(nc)) nc = ChatMounts.rp?.systemPromptChanged(nc, before, text, cause, now()) ?: nc
            _state.update { it.copy(convId = c.id) }
            save(nc, touch = false)
        }
    }

    /** app.js startFromPersona：新对话 + 助手的服务商/模型/系统提示词/温度；角色卡世界书 → rpcache；开场白作为首条助手消息 */
    fun startFromPersona(p: com.aichat.app.domain.model.Persona) {
        if (_state.value.isStreaming) { toast("请先停止当前生成"); return }
        scope.launch {
            val s = settings.value
            val cur = currentTarget(s)
            val prov = s.providers.firstOrNull { it.id == p.providerId && p.providerId.isNotEmpty() && it.hasKey }
            val providerId = prov?.id ?: cur?.first?.id ?: ""
            val model = if (prov != null) p.model.ifEmpty { prov.models.firstOrNull { it.isNotBlank() } ?: cur?.second ?: "" } else cur?.second ?: ""
            val c0 = deps.chats.create(providerId, model)
            val ex = c0.extras.toMutableMap()
            ex["personaId"] = JsonPrimitive(p.id)
            p.temperature?.let { ex["temperature"] = JsonPrimitive(it) }
            val lore = (p.extras["loreText"] as? JsonPrimitive)?.content.orEmpty()
            var c = c0.copy(systemPrompt = p.systemPrompt, personaName = p.name, personaEmoji = p.emoji, extras = JsonObject(ex))
            if (lore.isNotEmpty()) {
                c = ChatMounts.rp?.setLore(c, lore) ?: c
                c = c.copy(extras = com.aichat.app.ui.settings.PluginToggles.withConvEnabled(c.extras, "rpcache", true))
            }
            val first = (p.extras["firstMes"] as? JsonPrimitive)?.content.orEmpty()
            if (first.isNotEmpty()) c = c.copy(messages = c.messages + Message(newId(), Role.ASSISTANT, first, now(),
                extras = JsonObject(mapOf("model" to JsonPrimitive(model), "personaName" to JsonPrimitive(p.name), "personaEmoji" to JsonPrimitive(p.emoji)))))
            _state.update { it.copy(convId = c.id, conv = c) }
            save(c, touch = true)
            toast("已切换到「${p.name}」" + if (lore.isNotEmpty()) "（已导入世界书）" else "")
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
        if (searchNotReady()) return false
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

    // ---------------- RP / 冻结 ----------------
    /** app.js rpOn：本对话 rpcache 插件是否生效 */
    fun rpOn(c: Conversation? = _state.value.conv) = c != null && deps.plugins.isActive("rpcache", settings.value, c)
    /** app.js rpFrozen：插件把消息标为 dim（已写入章节摘要 / 超预算未发送） */
    fun frozen(m: Message, c: Conversation? = _state.value.conv) = c != null && deps.plugins.messageState(m, settings.value, c).dim
    private fun markHistory(c: Conversation, kind: String) = ChatMounts.rp?.markHistoryCause(c, kind, now()) ?: c

    private fun searchNotReady(): Boolean {
        val s = settings.value
        if (s.searchOn && !com.aichat.app.ui.settings.SearchConfig.ready(s, deps.keys)) { _state.update { it.copy(askSearchSetup = true) }; return true }
        return false
    }
    fun consumeAskSearch() = _state.update { it.copy(askSearchSetup = false) }

    /** 重新生成（app.js regenerate）：最后一条直接开始；较早的回复先确认（RP 对话附加提示）；冻结的不能重新生成 */
    fun planRegenerate(assistantId: String): Plan {
        val c = _state.value.conv ?: return Plan.Done
        if (_state.value.isStreaming) return Plan.Done
        val i = c.messages.indexOfFirst { it.id == assistantId }
        val m = c.messages.getOrNull(i) ?: return Plan.Done
        if (m.role != Role.ASSISTANT) return Plan.Done
        if (i < c.messages.size - 1) {
            if (frozen(m, c)) return Plan.Toast("这条回复已写入章节摘要，不能重新生成")
            val rest = c.messages.size - i - 1
            val rp = rpOn(c)
            return Plan.Ask("从这里重新生成？", "会为这条回复生成一个新版本。之后的 $rest 条对话保留在旧版本里，可以用 ‹ › 切换回去。" +
                (if (rp) "\n\n本对话开启了 RP 缓存优化：从较早的回复重新生成会改变对话历史，下一轮缓存命中率会下降一次。" else ""), "重新生成") {
                regenerate(assistantId, markKind = if (rp) "regen" else null)
            }
        }
        regenerate(assistantId)
        return Plan.Done
    }

    fun regenerate(assistantId: String, markKind: String? = null) {
        val c0 = _state.value.conv ?: return
        if (_state.value.isStreaming) return
        if (currentTarget() == null) { toast("请先选择服务商和模型"); return }
        if (searchNotReady()) return
        val c = if (markKind != null) markHistory(c0, markKind) else c0
        val i = c.messages.indexOfFirst { it.id == assistantId }
        val m = c.messages.getOrNull(i) ?: return
        if (m.role != Role.ASSISTANT) return
        // 失败 / 空的回复不保留为版本，直接在原位置重试（app.js：(error||stopped) && !content && 最后一条）。
        // 差异：JS 单版本时 pop 后 runChat 新建助手消息；这里原位清空、沿用同一 id（引擎只有 regenerate(msgId) 入口）
        val failed = (m.error != null || stopped(m) || m.truncated) && m.content.isEmpty() && i == c.messages.size - 1
        val path = if (failed) c.messages.take(i) + Versions.clearFields(m) else Versions.addVersion(c.messages, i)
        scope.launch {
            val nc = c.copy(messages = path)
            save(nc, touch = true)
            val target = path[i]
            startStream(c.id, Streaming(c.id, path.take(i), null, liveId = target.id, prefix = target.copy(content = "", reasoning = null), startedAt = now())) {
                deps.engine.regenerate(c.id, target.id)
            }
        }
    }

    private fun stopped(m: Message) = (m.extras["stopped"] as? JsonPrimitive)?.content == "true"

    /** app.js canContinueMsg */
    fun canContinue(m: Message) = m.role == Role.ASSISTANT && m.content.isNotEmpty() && m.extras["imageGen"] == null &&
        (m.truncated || m.finishReason == "length" || m.error != null || stopped(m))

    fun continueGeneration(assistantId: String) {
        val c = _state.value.conv ?: return
        if (_state.value.isStreaming) return
        val i = c.messages.indexOfFirst { it.id == assistantId }
        val m = c.messages.getOrNull(i) ?: return
        if (!canContinue(m)) return
        if (currentTarget() == null) { toast("请先选择服务商和模型"); return }
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
        if (currentTarget() == null) { toast("请先选择服务商和模型"); return false }
        if (searchNotReady()) return false
        // app.js confirmHistoryChange(m, …, false, 'branch')：编辑器里已提示过，不再弹窗，只记录历史变更原因
        val c1 = if (i < c.messages.size - 1 && rpOn(c)) markHistory(c, "branch") else c
        val init = buildMap {
            put("content", JsonPrimitive(text)); put("createdAt", JsonPrimitive(now()))
            if (m.images.isNotEmpty()) put("images", JsonArray(m.images.map { JsonPrimitive(it) }))
            if (m.files.isNotEmpty()) put("files", JsonArray(m.files))
        }
        val path = Versions.addVersion(c1.messages, i, JsonObject(init))
        val placeholder = Message(newId(), Role.ASSISTANT, "", now())
        scope.launch {
            val nc = c1.copy(messages = path + placeholder)
            save(nc, touch = true)
            startStream(c.id, Streaming(c.id, path, null, liveId = placeholder.id, prefix = placeholder, startedAt = now())) {
                deps.engine.regenerate(c.id, placeholder.id)
            }
        }
        return true
    }

    /** 切换版本（app.js switchVersion）：生成中 / 冻结时提示；RP 对话改较早历史先确认（VER_RP_WARN） */
    fun planSwitch(msgId: String, k: Int): Plan {
        val c = _state.value.conv ?: return Plan.Done
        if (_state.value.isStreaming) return Plan.Toast("请先停止当前生成")
        val i = c.messages.indexOfFirst { it.id == msgId }
        val m = c.messages.getOrNull(i) ?: return Plan.Done
        val n = Versions.count(m)
        if (k < 0 || k >= n || k == Versions.index(m)) return Plan.Done
        if (frozen(m, c)) return Plan.Toast("这条消息已写入章节摘要（或超出预算未发送），不能切换版本")
        if (i < c.messages.size - 1 && rpOn(c)) return Plan.Ask("切换到第 ${k + 1} 个版本？", VER_RP_WARN, "继续") { selectVersion(msgId, k, "version") }
        selectVersion(msgId, k)
        return Plan.Done
    }

    fun selectVersion(msgId: String, k: Int, markKind: String? = null) {
        val c0 = _state.value.conv ?: return
        if (_state.value.isStreaming) return
        val i = c0.messages.indexOfFirst { it.id == msgId }
        if (i < 0) return
        val c = if (markKind != null) markHistory(c0, markKind) else c0
        val before = c.messages.size - i - 1
        val path = Versions.select(c.messages, i, k)
        if (path === c.messages) return
        scope.launch {
            save(c.copy(messages = path), touch = false)
            val after = path.size - i - 1
            if (before > 0 || after > 0) toast("已切换到第 ${k + 1} 个版本" + if (after > 0) "，后面显示该版本的 $after 条对话" else "（该版本之后还没有对话）")
        }
    }

    /** app.js deleteVersion */
    fun planDeleteVersion(msgId: String, k: Int): Plan {
        val c = _state.value.conv ?: return Plan.Done
        if (_state.value.isStreaming) return Plan.Toast("请先停止当前生成")
        val i = c.messages.indexOfFirst { it.id == msgId }
        val m = c.messages.getOrNull(i) ?: return Plan.Done
        if (frozen(m, c)) return Plan.Toast("这条消息已写入章节摘要，不能修改版本")
        val tl = Versions.tailLength(c.messages, i, k)
        val later = rpOn(c) && i < c.messages.size - 1
        return Plan.Ask("删除第 ${k + 1} 个版本？", (if (tl > 0) "这个版本之后的 $tl 条对话也会一起删除。" else "删除后无法恢复。") + (if (later) "\n$VER_RP_WARN" else ""),
            "删除", danger = true) {
            val cur = _state.value.conv ?: return@Ask
            val j = cur.messages.indexOfFirst { it.id == msgId }; if (j < 0) return@Ask
            val c1 = if (later) markHistory(cur, "delete") else cur
            scope.launch { save(c1.copy(messages = Versions.removeVersion(c1.messages, j, k)), touch = false); toast("已删除该版本") }
        }
    }

    /** app.js keepOnlyVersion */
    fun planKeepOnly(msgId: String): Plan {
        val c = _state.value.conv ?: return Plan.Done
        if (_state.value.isStreaming) return Plan.Toast("请先停止当前生成")
        val m = c.messages.firstOrNull { it.id == msgId } ?: return Plan.Done
        val n = Versions.count(m)
        return Plan.Ask("只保留当前版本？", "其他 ${n - 1} 个版本（以及它们之后的对话分支）会被删除，当前显示的内容不变。", "只保留这个", danger = true) {
            val cur = _state.value.conv ?: return@Ask
            val j = cur.messages.indexOfFirst { it.id == msgId }; if (j < 0) return@Ask
            scope.launch { save(cur.copy(messages = Versions.keepOnly(cur.messages, j)), touch = false); toast("已只保留当前版本") }
        }
    }

    /** app.js deleteMsg（不确认，直接删；保存时 touch） */
    fun deleteMessage(msgId: String) {
        val c = _state.value.conv ?: return
        if (_state.value.isStreaming) return
        scope.launch { save(c.copy(messages = c.messages.filterNot { it.id == msgId }), touch = true) }
    }

    /** 编辑器提示（app.js editMsg 的 hint / warn） */
    fun editHint(msgId: String): Pair<String, Boolean>? {
        val c = _state.value.conv ?: return null
        val idx = c.messages.indexOfFirst { it.id == msgId }
        val m = c.messages.getOrNull(idx) ?: return null
        val user = m.role == Role.USER
        val after = c.messages.size - idx - 1
        val rp = rpOn(c)
        var hint = if (user) (if (after > 0) "「保存并重新发送」会从这里开出一个新分支重新生成，原来的内容和之后的 $after 条消息保留在旧版本里（可用 ‹ › 切换回去）；「保存」只修改这条消息。"
            else "「保存并重新发送」会用新内容重新生成回复。")
        else "修改这条 AI 回复的内容，后续对话会以修改后的内容作为上下文。"
        if (m.images.isNotEmpty() || m.files.isNotEmpty()) hint += "图片和文件附件会保留。"
        val warn = rp && (after > 0 || !user)
        if (warn) hint += "\n本对话开启了 RP 缓存优化：修改历史消息会改变历史前缀，下一轮缓存命中率会下降一次。"
        return hint to warn
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
            // 契约 #c：第一个事件给出真实 id（用户消息已落盘、助手消息为空占位），替换乐观显示用的临时 id
            is StreamEvent.Started -> s.copy(pendingUser = s.pendingUser?.copy(id = ev.userMsgId ?: s.pendingUser.id), liveId = ev.assistantMsgId)
            // 契约 #4：给用户的轻提示（如 402 降级重试），不影响正文
            is StreamEvent.Notice -> return@update st.copy(toast = ev.text)
            else -> s
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
        /** app.js 1678 */
        const val VER_RP_WARN = "本对话开启了 RP 缓存优化：切换较早回复的版本会改变对话历史，下一轮缓存命中率会下降一次。"
        /** app.js 4030 */
        const val RP_WARN = "本对话开启了 RP 缓存优化：系统提示词属于 L1 固定前缀，切换提示词会改变固定前缀，下一轮缓存命中率会下降一次（之后恢复）。"
    }
}
