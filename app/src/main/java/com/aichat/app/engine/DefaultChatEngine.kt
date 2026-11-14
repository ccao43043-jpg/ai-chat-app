package com.aichat.app.engine

import com.aichat.app.data.codec.MessageCodec
import com.aichat.app.domain.BuiltRequest
import com.aichat.app.domain.ChatEngine
import com.aichat.app.domain.ChatOptions
import com.aichat.app.domain.ChatRepository
import com.aichat.app.domain.PluginContext
import com.aichat.app.domain.PluginRegistry
import com.aichat.app.domain.RequestContext
import com.aichat.app.domain.SettingsRepository
import com.aichat.app.domain.StreamEvent
import com.aichat.app.domain.TurnResult
import com.aichat.app.domain.WireMessage
import com.aichat.app.domain.model.Conversation
import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.Role
import com.aichat.app.domain.model.Usage
import com.aichat.app.net.AffinityRouter
import com.aichat.app.net.DefaultProviderClient
import com.aichat.app.net.ProviderRules
import com.aichat.app.net.Js
import com.aichat.app.net.NetRetry
import com.aichat.app.net.SearchCore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.util.concurrent.ConcurrentHashMap

/**
 * ChatEngine（app.js runChat / send / regenerate / continueGen 的移植，契约变更 #b #c #g #h #i）。
 *
 * 一轮的顺序：Started → runBeforeRequest（插件）→ injectNowLine → meta.orGemini/orMiniMax → ChatOptions → OpenRouter 路由（beforeSend）
 * → buildChatRequest(+bodyPatch) → PluginRegistry.transformRequest → ProviderClient.stream（RouteChosen / 402 降级 Notice）
 * → runAfterResponse → 用量回调 → Router.afterResponse（observeRoute / markFail）→ ChatRepository.save。
 * 持久化：发送前存用户消息；流式中只改内存；结束 / 取消（truncated=true）/ 出错（error 字段）各存一次。
 *
 * 已接：files 展开（toRequestMsg）。尚未接入引擎（核心已移植 + golden）：联网搜索与改写查询（search.js）、NetRetry 退避重试、
 * UsageStats.makeEntry（这里先把 (conv, provider, model, msg, usage) 交给 [onUsage]）、calib 校准（beforeSend 传 null）。
 */
class DefaultChatEngine(
    private val chats: ChatRepository,
    private val settingsRepo: SettingsRepository,
    private val client: DefaultProviderClient,
    private val plugins: PluginRegistry,
    private val router: AffinityRouter? = null,
    private val onUsage: (suspend (conv: Conversation, provider: ProviderConfig, model: String, msg: Message, usage: Usage) -> Unit)? = null,
    private val now: () -> Long = System::currentTimeMillis,
    /** app.js uid()：Date.now().toString(36) + 6 位随机 base36 */
    private val uid: () -> String = { java.lang.Long.toString(System.currentTimeMillis(), 36) + (1..6).map { "0123456789abcdefghijklmnopqrstuvwxyz"[(Math.random() * 36).toInt()] }.joinToString("") },
    /** 联网搜索（app.js webSearch）；null = 不搜索 */
    private val search: com.aichat.app.net.DefaultSearchClient? = null,
    /** NetRetry 等待（测试注入）与抖动随机数 */
    private val sleep: suspend (Long) -> Unit = { kotlinx.coroutines.delay(it) },
    private val rnd: () -> Double = Math::random,
) : ChatEngine {
    private val running = ConcurrentHashMap<String, Job>()

    override fun stop(convId: String) { running[convId]?.cancel() }

    override fun send(convId: String, userText: String, images: List<String>, files: List<com.aichat.app.domain.model.FileAttachment>): Flow<StreamEvent> = channelFlow {
        val conv = chats.load(convId) ?: return@channelFlow fail("对话不存在")
        // app.js send()：只收读成功的文件（有文字或扫描版）；files[] 键名键序同 JS（AttachmentCodec）
        val okDocs = files.filter { it.text.isNotEmpty() || it.scanned }
        val text = Js.trim(userText)
        if (text.isEmpty() && images.isEmpty() && okDocs.isEmpty()) return@channelFlow fail("消息不能为空")
        val user = Message(uid(), Role.USER, text, now(), images, okDocs.map { FileContext.encode(it) })
        var title = conv.title
        if (title == "新对话") {
            val t = text.ifEmpty { okDocs.firstOrNull()?.let { "📄 " + it.name } ?: "" }
            if (t.isNotEmpty()) title = titleOf(conv.personaEmoji, text, t)
        }
        val conv1 = conv.copy(title = title, messages = conv.messages + user, updatedAt = now())
        chats.save(conv1)                                   // #b.1：流式前先存用户消息
        turn(conv1, botIndex = null, continuing = false)
    }

    /**
     * 重新生成（与 UI 的写入分工，对齐 app.js regenerate）：
     *  - 目标消息只有一个版本：引擎先删掉旧消息（存盘），再新建一条助手消息（新 id，经 Started 发出）——失败 / 空回复同样走这条；
     *  - 多版本（UI 已用 Versions.addVersion 建好新版本并保存）：就地写进这条消息。
     */
    override fun regenerate(convId: String, assistantMsgId: String): Flow<StreamEvent> = channelFlow {
        val conv = chats.load(convId) ?: return@channelFlow fail("对话不存在")
        val i = conv.messages.indexOfFirst { it.id == assistantMsgId && it.role == Role.ASSISTANT }
        if (i < 0) return@channelFlow fail("找不到要重新生成的回复")
        val m = conv.messages[i]
        if (m.versions.size < 2) {
            if (i != conv.messages.lastIndex) return@channelFlow fail("较早的回复请先建新版本再重新生成")
            val conv1 = conv.copy(messages = conv.messages.dropLast(1), updatedAt = now())
            chats.save(conv1)                               // 旧消息先删并落盘，再走与 send 相同的流程（新 id）
            turn(conv1, botIndex = null, continuing = false)
        } else turn(conv, botIndex = i, continuing = false)
    }

    /** 续写：发送前清掉 error / stopped / truncated / finishReason 并存盘（D5：删除的键写 null），再追加到同一条消息 */
    override fun continueGeneration(convId: String, assistantMsgId: String): Flow<StreamEvent> = channelFlow {
        val conv = chats.load(convId) ?: return@channelFlow fail("对话不存在")
        val i = conv.messages.indexOfFirst { it.id == assistantMsgId && it.role == Role.ASSISTANT }
        if (i < 0 || conv.messages[i].content.isEmpty()) return@channelFlow fail("这条回复不能继续生成")
        val m = conv.messages[i]
        val cleared = m.copy(error = null, truncated = false, finishReason = null, extras = JsonObject(m.extras - "stopped"))
        val conv1 = conv.copy(messages = conv.messages.map { if (it.id == m.id) cleared else it })
        chats.save(conv1)
        turn(conv1, botIndex = i, continuing = true)
    }

    private suspend fun ProducerScope<StreamEvent>.fail(msg: String) { send(StreamEvent.Error(0, msg, "")) }

    /** app.js injectNowLine：system 含「本轮动态信息」时，本轮最后一条 user 消息尾部追加 [现在] 行（不写回历史） */
    internal fun injectNowLine(msgs: List<WireMessage>, sys: String?, nowLine: () -> String = { TimeLine.nowLine(now()) }): List<WireMessage> {
        if ((sys ?: "").indexOf(TimeLine.NOW_MARKER) < 0) return msgs
        val i = msgs.lastIndex
        if (i < 0 || msgs[i].role != Role.USER) return msgs
        val m = msgs[i]
        return msgs.toMutableList().also { it[i] = m.copy(content = (if (m.content.isNotEmpty()) m.content + "\n\n" else "") + nowLine()) }
    }

    private suspend fun ProducerScope<StreamEvent>.turn(conv0: Conversation, botIndex: Int?, continuing: Boolean) {
        val settings = settingsRepo.settings.value
        val provider = settings.providers.firstOrNull { it.id == conv0.providerId } ?: return fail("请先在设置里选择服务商")
        val reuse = botIndex?.let { conv0.messages[it] }
        val lastUser = conv0.messages.lastOrNull { it.role == Role.USER && !Js.truthy(it.extras["imageGen"]) && it !== reuse }
        val prior = if (continuing) reuse!!.content else ""
        var bot = (reuse ?: Message(uid(), Role.ASSISTANT, "")).copy(
            content = prior, reasoning = if (continuing) reuse?.reasoning ?: "" else "", error = null, truncated = false, finishReason = null,
            createdAt = if (continuing) reuse!!.createdAt.takeIf { it > 0 } ?: now() else now(),
            extras = JsonObject((reuse?.extras ?: JsonObject(emptyMap())) - "stopped" + mapOf("model" to JsonPrimitive(conv0.model))),
        )
        var conv = if (reuse == null) conv0.copy(messages = conv0.messages + bot) else conv0.copy(messages = conv0.messages.map { if (it.id == bot.id) bot else it })
        send(StreamEvent.Started(lastUser?.id, bot.id))     // #c：第一个事件；助手消息此时只在内存

        val wantSearch = !continuing && search != null && settings.searchOn && SearchCore.ready(SearchCore.cfgOf(settings)) &&
            lastUser != null && Js.trim(lastUser.content).isNotEmpty()
        // app.js：if (lastUser && !continuing) delete lastUser.search（内存；收尾时随对话落盘，D5 写 null）
        if (lastUser != null && !continuing && lastUser.extras.containsKey("search"))
            conv = conv.copy(messages = conv.messages.map { if (it.id == lastUser.id) it.copy(extras = JsonObject(it.extras - "search")) else it })

        fun buildCtx(c: Conversation): RequestContext {
            val lu = c.messages.firstOrNull { it.id == lastUser?.id }
            val wire = c.messages.filter { it.id != bot.id && it.error == null && !Js.truthy(it.extras["imageGen"]) && !Js.truthy(it.extras["pending"]) }
                .map { WireMessage(it.role, FileContext.requestContent(it, lu != null && it.id == lu.id, TimeLine.localDateStr(now())), it.images, srcId = it.id) }
            var sys = c.systemPrompt ?: ""
            var msgs = wire
            if (continuing && prior.isNotEmpty()) {
                msgs = msgs + WireMessage(Role.ASSISTANT, prior) + WireMessage(Role.USER, "请从上次中断处继续，不要重复已生成的内容。")
                sys = (if (sys.isNotEmpty()) "$sys\n\n" else "") + "【续写】请从上次中断处继续，不要重复。"
            }
            val temp = c.extras["temperature"]?.takeIf { Js.truthy(it) || (it is JsonPrimitive && !it.isString) }
                ?.let { Js.parseFloat(Js.str(it)).takeIf { d -> !d.isNaN() } } ?: settings.temperature
            return RequestContext(c, provider, c.model, sys, msgs,
                ChatOptions(stream = settings.stream, temperature = temp, maxTokens = ProviderRules.resolveMaxTokens(provider, c.model, settings.maxTokens),
                    convId = c.id), settings, lu?.id)
        }
        var ctx = buildCtx(conv)

        val job = launch {
            if (wantSearch) {                                                       // app.js runChat 联网搜索段
                bot = bot.copy(extras = JsonObject(bot.extras + ("searching" to JsonPrimitive(true))))
                try {
                    var q = Js.trim(lastUser!!.content)
                    if (Js.truthy(settings.search["rewrite"])) {
                        val hist = conv.messages.filter { it.id != bot.id && it.id != lastUser.id && it.error == null && !Js.truthy(it.extras["imageGen"]) }
                        q = rewriteQuery(provider, conv.model, q, hist)
                    }
                    val sq = SearchCore.sliceUtf16(q, 120)
                    bot = bot.copy(extras = JsonObject(bot.extras + ("searchQuery" to JsonPrimitive(sq))))
                    send(StreamEvent.Notice("正在联网搜索：$sq"))
                    val results = search!!.webSearch(SearchCore.cfgOf(settings), q)
                    if (results.isEmpty()) throw java.io.IOException("没有搜索到相关结果")
                    val so = JsonObject(mapOf("query" to JsonPrimitive(sq), "results" to JsonArray(results)))
                    conv = conv.copy(messages = conv.messages.map { if (it.id == lastUser.id) it.copy(extras = JsonObject(it.extras + ("search" to so))) else it })
                    bot = bot.copy(extras = JsonObject(bot.extras + ("sources" to JsonArray(results))))
                } catch (e: CancellationException) { throw e
                } catch (e: Exception) {
                    val msg = "联网搜索失败：" + (e.message ?: e.javaClass.simpleName) + "。以下为模型直接回答。"
                    bot = bot.copy(extras = JsonObject(bot.extras + ("searchError" to JsonPrimitive(msg))))
                    send(StreamEvent.Notice(msg))
                }
                bot = bot.copy(extras = JsonObject(bot.extras - "searching"))
                conv = conv.copy(messages = conv.messages.map { if (it.id == bot.id) bot else it })
                ctx = buildCtx(conv)
            }
            plugins.attach(object : PluginContext { override fun notify(text: String) { trySend(StreamEvent.Notice(text)) } })   // #i
            ctx = plugins.runBeforeRequest(ctx) { /* pluginStatus：临时状态，UI 用 Notice 之外的通道，v1 不显示 */ }
            ctx = ctx.copy(messages = injectNowLine(ctx.messages, ctx.systemPrompt.ifEmpty { conv.systemPrompt }))
            // #h：插件写的 meta.orGemini / orMiniMax → ChatOptions
            ctx = ctx.copy(opts = ctx.opts.copy(orGemini = Js.truthy(ctx.meta["orGemini"]), orMiniMax = Js.truthy(ctx.meta["orMiniMax"])))
            // OpenRouter 缓存亲和路由（app.js 2213–2229）
            var routeSlug: String? = null
            if (router != null) router.beforeSend(provider, ctx.model, ctx.messages, null, now())?.let { pick ->
                if (pick.slug != null) {
                    routeSlug = pick.slug
                    ctx = ctx.copy(opts = ctx.opts.copy(routeSlug = pick.slug, providerOrder = listOf(pick.slug)))
                } else if (pick.affinityOff) ctx = ctx.copy(opts = ctx.opts.copy(cacheAffinity = false))
            }
            var req: BuiltRequest = client.buildChatRequest(ctx.provider, ctx.model, ctx.messages, ctx.systemPrompt, ctx.opts, ctx.bodyPatch)
            req = plugins.transformRequest(req, ctx)                                                                         // #g
            val startedAt = now()
            var status = 0
            // A6 NetRetry：失败且还没收到正文时按 classify / backoff 重试（最多 2 次）；402 降级在 ProviderClient 内
            var attempt = 0
            while (true) {
                status = 0
                var gotDelta = false
                var failure: StreamEvent.Error? = null
                client.stream(provider, req, routeSlug).collect { ev ->
                    when (ev) {
                        is StreamEvent.Status -> status = ev.httpStatus
                        is StreamEvent.Delta -> { gotDelta = true; bot = bot.copy(content = bot.content + ev.text) }
                        is StreamEvent.Reasoning -> { gotDelta = true; bot = bot.copy(reasoning = (bot.reasoning ?: "") + ev.text) }
                        is StreamEvent.Finish -> bot = bot.copy(finishReason = ev.reason, truncated = bot.truncated || ev.reason == "length")
                        is StreamEvent.UsageUpdate -> bot = bot.copy(usage = ev.usage)
                        is StreamEvent.RouteChosen -> bot = bot.copy(routeSlug = ev.slug)
                        is StreamEvent.Error -> {
                            val transport = ev.httpStatus >= 400 || ev.message.startsWith(NET_ERR)
                            if (transport && failure == null) { failure = ev; return@collect }      // 先扣住，决定是否重试
                            gotDelta = true
                            bot = bot.copy(error = (bot.error?.let { "$it\n" } ?: "") + ev.message)
                        }
                        else -> {}
                    }
                    send(ev)
                }
                val f = failure
                if (f != null) {
                    val netErr = if (f.message.startsWith(NET_ERR)) f.message.removePrefix(NET_ERR).substringBefore(NET_HINT) else null
                    val c = NetRetry.classify(if (netErr != null) 0 else f.httpStatus, f.raw, netErr)
                    if (NetRetry.shouldRetry(c, attempt, gotDelta, false)) {
                        val wait = NetRetry.backoff(attempt, c.kind, rnd())
                        send(StreamEvent.Notice(c.label + "，" + Js.numberToString(Math.round(wait / 100.0) / 10.0) + " 秒后重试（" + (attempt + 1) + "/" + NetRetry.MAX_RETRIES + "）"))
                        sleep(wait)
                        attempt++
                        continue
                    }
                    if (attempt > 0) bot = bot.copy(extras = JsonObject(bot.extras + ("retries" to JsonPrimitive(attempt))))
                    val msg = withRetries(f.message, attempt)
                    bot = bot.copy(error = (bot.error?.let { "$it\n" } ?: "") + msg, truncated = bot.truncated || bot.content.isNotEmpty())
                    send(f.copy(message = msg))
                }
                break
            }
            if (status == 0 && bot.error == null) bot = bot.copy(error = "请求失败：没有收到响应")
            finishTurn(ctx, provider, bot, status, startedAt, routeSlug, stopped = false).let { conv = it }
        }
        running[conv.id] = job
        try { job.join() } finally { running.remove(conv.id, job) }
        if (job.isCancelled) withContext(NonCancellable) {                   // #b.4：取消 → truncated=true 存
            val stoppedBot = bot.copy(truncated = bot.content.isNotEmpty() || bot.truncated,
                extras = JsonObject(bot.extras + ("stopped" to JsonPrimitive(true))))
            finishTurn(ctx, provider, stoppedBot, 0, now(), bot.routeSlug, stopped = true)
        }
    }

    /** app.js rewriteQuery：非流式、temperature 0、maxTokens 256、20s；失败回退原问题（取消照常抛出） */
    private suspend fun rewriteQuery(p: ProviderConfig, model: String, q: String, history: List<Message>): String = try {
        val prompt = SearchCore.buildRewritePrompt(q, history.map { SearchCore.Turn(it.role.wire, it.content) })
        val req = client.buildChatRequest(p, model, listOf(WireMessage(Role.USER, prompt)), "", ChatOptions(stream = false, temperature = 0.0, maxTokens = 256))
        val (st, text) = client.requestText(p, req, 20_000)
        if (st >= 400 || st == 0) q
        else SearchCore.cleanRewrite(com.aichat.app.net.Deltas.parseFullResponse(p.type.wire, text)
            .filterIsInstance<com.aichat.app.net.StreamDelta.Text>().joinToString("") { it.text }, q)
    } catch (e: CancellationException) { throw e } catch (e: Exception) { q }

    /** 收尾：写回助手消息 → runAfterResponse → 用量 → 路由观测 → save */
    private suspend fun finishTurn(ctx: RequestContext, provider: ProviderConfig, bot: Message, status: Int, startedAt: Long,
                                   routeSlug: String?, stopped: Boolean): Conversation = withContext(NonCancellable) {
        // ctx.conv = runBeforeRequest 之后的对话（插件可能改了 rpState / extras）；把本轮助手消息写回（不在则追加）
        val bot = bot.copy(extras = JsonObject(bot.extras - "searching"))   // 临时字段不落盘（app.js finish：delete bot.searching）
        val conv = ctx.conv.let { c ->
            val msgs = if (c.messages.any { it.id == bot.id }) c.messages.map { if (it.id == bot.id) bot else it } else c.messages + bot
            c.copy(messages = msgs, updatedAt = now())
        }
        val ok = bot.error == null && !stopped && status in 200..299
        val after = try { plugins.runAfterResponse(ctx.copy(conv = conv), TurnResult(ok, status, bot.usage, bot)) } catch (e: Exception) { conv }
        if (ok && bot.usage != null) onUsage?.invoke(after, provider, ctx.model, bot, bot.usage!!)
        router?.afterResponse(ctx.model, routeSlug, ok, bot.usage, now() - startedAt, now())
        chats.save(after)
        after
    }
}

private const val NET_ERR = "网络错误："
private const val NET_HINT = "\n请检查网络连接和 Base URL。"
/** app.js：错误文案后接「（已重试 N 次）」；402 附注在 ProviderClient 里已拼好，接在其前（402 不在重试范围内，实际不会同时出现） */
internal fun withRetries(msg: String, attempt: Int): String = if (attempt > 0) "$msg（已重试 $attempt 次）" else msg

/** timeutil.js 的 nowLine / NOW_MARKER（本地时区） */
object TimeLine {
    const val NOW_MARKER = "本轮动态信息"
    /** timeutil.js localDateStr：本地 YYYY-MM-DD */
    fun localDateStr(nowMs: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
        val d = java.time.Instant.ofEpochMilli(nowMs).atZone(zone.toZoneId())
        return String.format("%04d-%02d-%02d", d.year, d.monthValue, d.dayOfMonth)
    }
    fun nowLine(nowMs: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
        val cal = java.util.Calendar.getInstance(zone).apply { timeInMillis = nowMs }
        val date = String.format("%04d-%02d-%02d", cal.get(java.util.Calendar.YEAR), cal.get(java.util.Calendar.MONTH) + 1, cal.get(java.util.Calendar.DAY_OF_MONTH))
        val time = String.format("%02d:%02d", cal.get(java.util.Calendar.HOUR_OF_DAY), cal.get(java.util.Calendar.MINUTE))
        return "[现在] 现在是 $date $time（${zoneLabel(nowMs, zone)}，现实时间，仅供参考）"
    }
    /** zoneLabel：Asia/Shanghai 等 → 北京时间；否则 IANA 名；无名时 UTC±hh:mm */
    fun zoneLabel(nowMs: Long, zone: java.util.TimeZone): String {
        val z = zone.id ?: ""
        if (Regex("^(Asia/(Shanghai|Chongqing|Harbin|Urumqi)|PRC)$").matches(z)) return "北京时间"
        if (z.isNotEmpty()) return z
        val off = zone.getOffset(nowMs) / 60000
        return "UTC" + (if (off >= 0) "+" else "-") + String.format("%02d:%02d", Math.abs(off) / 60, Math.abs(off) % 60)
    }
}

/** versions.js 的 addVersion / applySnap({}) 子集（重新生成用） */
object Versions {
    private val KEEP = setOf("id", "role", "versions", "vi")
    private val TRANSIENT = setOf("pending", "searching", "pluginStatus")
    fun snapshot(m: Message): JsonObject = JsonObject(MessageCodec.encode(m).filterKeys { it !in KEEP && it !in TRANSIENT })
    /** 在第 i 条上新增空版本：旧版本（连同其后消息作 tail）存进 versions，返回到第 i 条为止的新路径 */
    fun addVersion(msgs: List<Message>, i: Int): List<Message> {
        val m = msgs[i]
        val vs: MutableList<JsonObject?> = if (m.versions.isEmpty()) mutableListOf(null) else m.versions.toMutableList()
        val vi = if (m.versions.isEmpty()) 0 else m.vi
        vs[vi] = JsonObject(snapshot(m) + ("tail" to JsonArray(msgs.drop(i + 1).map { MessageCodec.encode(it) as JsonElement })))
        vs += null
        val fresh = Message(m.id, m.role, "", versions = vs, vi = vs.lastIndex)
        return msgs.take(i) + fresh
    }
    /** applySnap(m, {})：清空当前版本字段，保留 id / role / versions / vi */
    fun clearCurrent(m: Message): Message = Message(m.id, m.role, "", versions = m.versions, vi = m.vi)
}

/** app.js send() 的新对话标题：有正文时加人设 emoji 前缀；空白折叠为一个空格，截 24 个 UTF-16 单元 */
internal fun titleOf(personaEmoji: String?, text: String, t: String): String =
    (if (!personaEmoji.isNullOrEmpty() && text.isNotEmpty()) "$personaEmoji " else "") +
        t.replace(Regex("[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"), " ").let { if (it.length > 24) it.substring(0, 24) else it }
