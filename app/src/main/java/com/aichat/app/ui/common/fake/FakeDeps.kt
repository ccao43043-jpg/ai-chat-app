package com.aichat.app.ui.common.fake

import com.aichat.app.domain.*
import com.aichat.app.domain.model.*
import com.aichat.app.ui.common.UiDeps
import com.aichat.app.ui.settings.ProviderPresets
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/*
 * M1 用的内存 fake（D/B/C 的真实实现就位前，UI 先跑通）。只实现契约语义，不读写磁盘、不联网。
 */

private val seq = AtomicLong(0)
internal fun fakeId(prefix: String) = prefix + System.currentTimeMillis().toString(36) + seq.incrementAndGet().toString(36)

class FakeChatRepository(private val now: () -> Long = System::currentTimeMillis) : ChatRepository {
    private val convs = ConcurrentHashMap<String, Conversation>()
    private val _index = MutableStateFlow<List<ConversationMeta>>(emptyList())
    override val index: StateFlow<List<ConversationMeta>> = _index.asStateFlow()
    private val lock = Mutex()

    private fun reindex() {
        _index.value = convs.values.sortedByDescending { it.updatedAt }
            .map { ConversationMeta(it.id, it.title, it.providerId, it.model, it.updatedAt, it.personaName, it.personaEmoji) }
    }
    override suspend fun load(id: String): Conversation? = convs[id]
    override suspend fun save(conv: Conversation, touch: Boolean) = lock.withLock {
        convs[conv.id] = if (touch) conv.copy(updatedAt = now()) else conv; reindex()
    }
    override suspend fun create(providerId: String, model: String, title: String): Conversation = lock.withLock {
        val t = now()
        val c = Conversation(fakeId("c"), title, providerId, model, t, t, emptyList())
        convs[c.id] = c; reindex(); c
    }
    override suspend fun delete(id: String) = lock.withLock { convs.remove(id); reindex() }
    override suspend fun exportJson(id: String): String = "{\"id\":\"$id\",\"note\":\"fake\"}"
    override suspend fun exportAllJson(): String = "[]"
    override suspend fun importJson(json: String): List<String> = emptyList()
}

class FakeSettingsRepository(initial: AppSettings = AppSettings(providers = ProviderPresets.defaults())) : SettingsRepository {
    private val _s = MutableStateFlow(initial)
    override val settings: StateFlow<AppSettings> = _s.asStateFlow()
    private val origins = HashMap<String, String>()
    var keys: FakeKeyVault? = null
    override suspend fun update(transform: (AppSettings) -> AppSettings) { _s.value = transform(_s.value) }
    override suspend fun registerProvider(id: String, baseUrl: String, auth: AuthType): Boolean {
        val o = originOf(baseUrl)
        val prev = origins.put(id, o)
        if (prev != null && prev != o && keys?.has(id) == true) { keys?.delete(id); return true }
        return false
    }
    private fun originOf(u: String) = Regex("^(https?://[^/]+)").find(u.trim().lowercase())?.value ?: u
}

class FakeLibraryRepository : LibraryRepository {
    override val personas = MutableStateFlow<List<Persona>>(emptyList())
    override val prompts = MutableStateFlow<List<PromptSnippet>>(emptyList())
    override val templates = MutableStateFlow<List<PromptTemplate>>(emptyList())
    override val worlds = MutableStateFlow<List<World>>(emptyList())
    override suspend fun savePersonas(list: List<Persona>) { personas.value = list }
    override suspend fun savePrompts(list: List<PromptSnippet>) { prompts.value = list }
    override suspend fun saveTemplates(list: List<PromptTemplate>) { templates.value = list }
    override suspend fun saveWorlds(list: List<World>) { worlds.value = list }
}

class FakeKeyVault : KeyVault {
    private val m = ConcurrentHashMap<String, String>()
    override fun has(providerId: String) = m.containsKey(providerId)
    override fun set(providerId: String, key: String): Boolean { if (key.isEmpty()) m.remove(providerId) else m[providerId] = key; return true }
    override fun delete(providerId: String) { m.remove(providerId) }
    override fun keyFor(providerId: String, requestUrl: String): String? = null   // fake 永不交出明文
    override fun authType(providerId: String) = AuthType.BEARER
}

class FakePluginRegistry : PluginRegistry {
    override val plugins: List<ChatPlugin> = emptyList()
    override fun isActive(id: String, settings: AppSettings, conv: Conversation?) = false
    override suspend fun runBeforeRequest(ctx: RequestContext, status: (String?) -> Unit) = ctx
    override fun runAfterResponse(ctx: RequestContext, result: TurnResult) = ctx.conv
    override fun messageBadges(msg: Message, settings: AppSettings, conv: Conversation) = emptyList<Badge>()
    override fun headerBadges(settings: AppSettings, conv: Conversation) = emptyList<Badge>()
    override fun messageState(msg: Message, settings: AppSettings, conv: Conversation) = MessageState()
    override val errors: StateFlow<List<JsonObject>> = MutableStateFlow(emptyList())
}

/**
 * 假引擎：把用户消息写进对话，然后逐段「流式」吐出一段演示回复（含 Markdown 和代码块）。
 * 契约语义照真引擎：取消 = 停止，已收到的正文保留并设 truncated=true；对同一对话串行。
 */
class FakeChatEngine(private val repo: ChatRepository, private val chunkDelayMs: Long = 35,
                     private val now: () -> Long = System::currentTimeMillis) : ChatEngine {
    private val running = ConcurrentHashMap<String, Job>()

    override fun send(convId: String, userText: String, images: List<String>): Flow<StreamEvent> = flow {
        val conv = repo.load(convId) ?: run { emit(StreamEvent.Error(0, "对话不存在", "")); return@flow }
        val user = Message(fakeId("m"), Role.USER, userText, now(), images = images)
        val title = if (conv.messages.isEmpty() && conv.title == "新对话") userText.lineSequence().first().take(24).ifBlank { "新对话" } else conv.title
        repo.save(conv.copy(title = title, messages = conv.messages + user))
        reply(convId, demoReply(userText, images.size), null)
    }

    override fun regenerate(convId: String, assistantMsgId: String): Flow<StreamEvent> = flow {
        val conv = repo.load(convId) ?: return@flow
        val idx = conv.messages.indexOfFirst { it.id == assistantMsgId }
        if (idx < 0) return@flow
        repo.save(conv.copy(messages = conv.messages.take(idx)))
        val lastUser = conv.messages.take(idx).lastOrNull { it.role == Role.USER }?.content.orEmpty()
        reply(convId, demoReply(lastUser, 0), null)
    }

    override fun continueGeneration(convId: String, assistantMsgId: String): Flow<StreamEvent> = flow {
        reply(convId, "\n\n（续写）这是续写出来的演示文字。", assistantMsgId)
    }

    override fun stop(convId: String) { running[convId]?.cancel() }

    private suspend fun kotlinx.coroutines.flow.FlowCollector<StreamEvent>.reply(convId: String, text: String, appendTo: String?) {
        currentCoroutineContext()[Job]?.let { running[convId] = it }
        val acc = StringBuilder()
        var finished = false
        try {
            emit(StreamEvent.Status(200))
            for (piece in chunk(text)) { delay(chunkDelayMs); acc.append(piece); emit(StreamEvent.Delta(piece)) }
            val usage = Usage(prompt = 42, completion = acc.length.toLong() / 2, source = "fake")
            emit(StreamEvent.UsageUpdate(usage))
            emit(StreamEvent.Finish("stop"))
            finished = true
        } finally {
            running.remove(convId)
            withContext(NonCancellable) {
                val c = repo.load(convId)
                if (c != null) {
                    val msgs = if (appendTo != null) c.messages.map { if (it.id == appendTo) it.copy(content = it.content + acc, truncated = !finished) else it }
                    else c.messages + Message(fakeId("m"), Role.ASSISTANT, acc.toString(), now(), truncated = !finished,
                        finishReason = if (finished) "stop" else null, usage = if (finished) Usage(42, acc.length.toLong() / 2, source = "fake") else null)
                    repo.save(c.copy(messages = msgs))
                }
            }
        }
    }

    private fun chunk(s: String): List<String> {
        val out = ArrayList<String>(); var i = 0
        while (i < s.length) { val n = (2 + (i * 7919 % 5)).coerceAtMost(s.length - i); out += s.substring(i, i + n); i += n }
        return out
    }

    private fun demoReply(user: String, imgs: Int): String = buildString {
        append("这是**演示回复**（数据/网络层接入前的 fake 引擎）。")
        if (imgs > 0) append("收到 $imgs 张图片。")
        append("\n\n你说：\n\n> ").append(user.lines().joinToString("\n> ").take(400))
        append("\n\n## 渲染测试\n\n- 列表项一，含 `行内代码`\n- 列表项二，含 [链接](https://example.com)\n  1. 嵌套有序\n\n")
        append("```kotlin\nfun greet(name: String): String {\n    // 注释\n    return \"你好，\$name\" + 42\n}\n```\n\n")
        append("| 列 A | 列 B |\n|:--|--:|\n| 1 | 2 |\n\n完成。")
    }
}

/** 没有 D 的真实实现时用：导出 / 导入给出明确的失败原因 */
class FakeMigrationService : MigrationService {
    override suspend fun needed() = false
    override suspend fun run() = MigrationReport(0, 0, 0, emptyList(), null, listOf("fake"))
    override suspend fun exportBackup(target: android.net.Uri): Result<Long> = Result.failure(IllegalStateException("数据层尚未接入（等待工作流 D 的 MigrationService）"))
    override suspend fun importBackup(source: android.net.Uri): Result<Int> = Result.failure(IllegalStateException("数据层尚未接入（等待工作流 D 的 MigrationService）"))
}

object FakeDeps {
    fun create(): UiDeps {
        val chats = FakeChatRepository()
        val keys = FakeKeyVault()
        val settings = FakeSettingsRepository().also { it.keys = keys }
        return UiDeps(chats, settings, FakeLibraryRepository(), keys, FakeChatEngine(chats), FakePluginRegistry(), FakeMigrationService(), isFake = true)
    }
}
