package com.aichat.app.ui.common.fake

import com.aichat.app.data.DataGraph
import com.aichat.app.domain.*
import com.aichat.app.domain.model.*
import com.aichat.app.ui.common.UiDeps
import com.aichat.app.ui.settings.ProviderPresets
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
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
 * B/C 就位前的 fake：ChatEngine（演示流式回复）与 PluginRegistry（6 个插件空壳）。仓库用 D 的 DataGraph.inMemory()。
 */

private val seq = AtomicLong(0)
internal fun fakeId(prefix: String) = prefix + System.currentTimeMillis().toString(36) + seq.incrementAndGet().toString(36)

/** 6 个插件的空壳（id / 名称 / 默认开关与旧版一致，hook 全部空跑），供插件开关页演示 */
private class StubPlugin(override val id: String, override val name: String, override val defaultEnabled: Boolean,
                         override val perConversation: Boolean) : ChatPlugin

class FakePluginRegistry : PluginRegistry {
    override val plugins: List<ChatPlugin> = listOf(
        StubPlugin("knowledge", "本地资料库", false, false),
        StubPlugin("rpcache", "RP 缓存优化器（DeepSeek / 千问）", true, true),
        StubPlugin("usage", "Token 用量显示", false, false),
        StubPlugin("gcache", "Gemini 提示缓存（OpenRouter）", true, false),
        StubPlugin("mmcache", "MiniMax 提示缓存（OpenRouter）", true, false),
        StubPlugin("affect", "好感度 / 心情", true, false),
    )
    override fun isActive(id: String, settings: AppSettings, conv: Conversation?) = false
    override suspend fun runBeforeRequest(ctx: RequestContext, status: (String?) -> Unit) = ctx
    override fun runAfterResponse(ctx: RequestContext, result: TurnResult) = ctx.conv
    override fun messageBadges(msg: Message, settings: AppSettings, conv: Conversation) = emptyList<Badge>()
    override fun headerBadges(settings: AppSettings, conv: Conversation) = emptyList<Badge>()
    override fun messageState(msg: Message, settings: AppSettings, conv: Conversation) = MessageState()
    override val errors: StateFlow<List<JsonObject>> = MutableStateFlow(emptyList())
}

/**
 * 假引擎，语义照协调者确认的契约：
 *  - send：流式前先存用户消息；流开始时创建助手消息并保存；结束时保存；取消时也保存并标 truncated=true；
 *  - 出错时把 error 写进助手消息（输入里含「#error」可演示）；
 *  - regenerate：UI 已整理好版本，这里在同一条助手消息上原位重写（单版本失败的最后一条：删旧建新，Started 带新 id）；continueGeneration：在同一条消息后追加。
 *  - 第一个事件是 Started(userMsgId, assistantMsgId)（契约 #c）；输入含「#notice」时演示 Notice。
 */
class FakeChatEngine(private val repo: ChatRepository, private val chunkDelayMs: Long = 35,
                     private val now: () -> Long = System::currentTimeMillis) : ChatEngine {
    private val running = ConcurrentHashMap<String, Job>()

    override fun send(convId: String, userText: String, images: List<String>, files: List<FileAttachment>): Flow<StreamEvent> = flow {
        val conv = repo.load(convId) ?: run { emit(StreamEvent.Error(0, "对话不存在", "")); return@flow }
        val user = Message(fakeId("m"), Role.USER, userText, now(), images = images, files = files.map { com.aichat.app.data.codec.AttachmentCodec.encode(it) })
        val title = if (conv.messages.isEmpty() && conv.title == "新对话") userText.lineSequence().first().take(24).ifBlank { "新对话" } else conv.title
        repo.save(conv.copy(title = title, messages = conv.messages + user))
        val bot = Message(fakeId("m"), Role.ASSISTANT, "", now())
        repo.load(convId)?.let { repo.save(it.copy(messages = it.messages + bot)) }
        emit(StreamEvent.Started(user.id, bot.id))
        reply(convId, bot.id, demoReply(userText, images.size), append = false)
    }

    override fun regenerate(convId: String, assistantMsgId: String): Flow<StreamEvent> = flow {
        val conv = repo.load(convId) ?: return@flow
        val idx = conv.messages.indexOfFirst { it.id == assistantMsgId }
        if (idx < 0) { emit(StreamEvent.Error(0, "消息不存在", "")); return@flow }
        val lastUser = conv.messages.take(idx).lastOrNull { it.role == Role.USER }?.content.orEmpty()
        val m = conv.messages[idx]
        // 照 app.js 写入顺序：最后一条、单版本、失败 / 中断且没有正文 → pop 掉旧消息，新建一条助手消息（新 id）
        if (idx == conv.messages.size - 1 && m.versions.size <= 1 && m.content.isEmpty() && (m.error != null || m.truncated)) {
            val bot = Message(fakeId("m"), Role.ASSISTANT, "", now())
            repo.save(conv.copy(messages = conv.messages.dropLast(1) + bot))
            emit(StreamEvent.Started(null, bot.id))
            reply(convId, bot.id, demoReply(lastUser, 0), append = false)
            return@flow
        }
        emit(StreamEvent.Started(null, assistantMsgId))
        reply(convId, assistantMsgId, demoReply(lastUser, 0), append = false)
    }

    override fun continueGeneration(convId: String, assistantMsgId: String): Flow<StreamEvent> = flow {
        emit(StreamEvent.Started(null, assistantMsgId))
        if (repo.load(convId)?.messages?.any { it.id == assistantMsgId } != true) emit(StreamEvent.Notice("演示：找不到要续写的消息"))
        reply(convId, assistantMsgId, "（续写）这是续写出来的演示文字。", append = true)
    }

    override fun stop(convId: String) { running[convId]?.cancel() }

    private suspend fun kotlinx.coroutines.flow.FlowCollector<StreamEvent>.reply(convId: String, msgId: String, text: String, append: Boolean) {
        currentCoroutineContext()[Job]?.let { running[convId] = it }
        val acc = StringBuilder()
        var finished = false
        var error: String? = null
        var usage: Usage? = null
        try {
            emit(StreamEvent.Status(200))
            if (text.contains("#notice")) emit(StreamEvent.Notice("演示提示：额度不足，已将最大输出降至 1024 并重试"))
            val fail = text.contains("#error")
            for ((n, piece) in chunk(text).withIndex()) {
                delay(chunkDelayMs); acc.append(piece); emit(StreamEvent.Delta(piece))
                if (fail && n == 6) { error = "HTTP 500：演示错误"; emit(StreamEvent.Error(500, error, "")); return }
            }
            usage = Usage(prompt = 42, completion = acc.length.toLong() / 2, source = "fake")
            emit(StreamEvent.UsageUpdate(usage))
            emit(StreamEvent.Finish("stop"))
            finished = true
        } finally {
            running.remove(convId)
            withContext(NonCancellable) {
                val c = repo.load(convId)
                if (c != null) repo.save(c.copy(messages = c.messages.map {
                    if (it.id != msgId) it else it.copy(
                        content = (if (append) it.content else "") + acc,
                        reasoning = if (append) it.reasoning else null,
                        truncated = !finished && acc.isNotEmpty(), error = error,
                        finishReason = if (finished) "stop" else null, usage = usage ?: if (append) it.usage else null,
                        createdAt = if (append) it.createdAt else now())
                }))
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
        if (user.contains("#error")) append("#error ")
        if (user.contains("#notice")) append("#notice ")
        append("\n\n你说：\n\n> ").append(user.take(400).lines().joinToString("\n> "))
        append("\n\n## 渲染测试\n\n- 列表项一，含 `行内代码`\n- 列表项二，含 [链接](https://example.com)\n  1. 嵌套有序\n\n")
        append("```kotlin\nfun greet(name: String): String {\n    // 注释\n    return \"你好，\$name\" + 42\n}\n```\n\n")
        append("| 列 A | 列 B |\n|:--|--:|\n| 1 | 2 |\n\n完成。")
    }
}

object FakeDeps {
    /**
     * 仓库 / KeyVault / 备份全部用 D 的真实实现（DataGraph.inMemory：MemFileStore + FakeKeyVault，进程内、不落盘）；
     * 只有 ChatEngine（等 B）和 PluginRegistry（等 C）还是本文件的 fake。
     */
    fun create(data: DataGraph = DataGraph.inMemory(), engineDelayMs: Long = 35, now: () -> Long = System::currentTimeMillis,
               plugins: PluginRegistry = FakePluginRegistry()): UiDeps {
        if (data.settings.settings.value.providers.isEmpty()) runBlocking {
            data.settings.update { it.copy(providers = ProviderPresets.defaults()) }
        }
        return UiDeps(data.chats, data.settings, data.library, data.keys, FakeChatEngine(data.chats, engineDelayMs, now), plugins,
            data.migration, isFake = true)
    }
}
