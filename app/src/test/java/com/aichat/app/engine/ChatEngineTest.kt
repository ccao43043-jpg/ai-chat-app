package com.aichat.app.engine

import com.aichat.app.data.DataGraph
import com.aichat.app.data.secret.FakeKeyVault
import com.aichat.app.domain.*
import com.aichat.app.domain.model.*
import com.aichat.app.net.AffinityRouter
import com.aichat.app.net.AuthInjector
import com.aichat.app.net.DefaultProviderClient
import com.aichat.app.net.Js
import com.aichat.app.net.ProviderMigration
import com.aichat.app.net.TinySseServer
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

/** ChatEngine：契约 #b（持久化时机）#c（Started）#g（transformRequest）#h（meta → ChatOptions）#i（notify → Notice）+ 路由 / 取消 / 出错 */
class ChatEngineTest {
    private val server = TinySseServer()
    private val keys = FakeKeyVault()
    private val g = DataGraph.inMemory(keys = keys)
    private val http = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).followRedirects(false).build()
    private val client = DefaultProviderClient(AuthInjector(keys), http)

    @After fun tearDown() = server.close()

    private fun setup(preset: String = "openrouter", meta: JsonObject = JsonObject(emptyMap())): Conversation = runBlocking {
        val base = server.baseUrl + "/api/v1"
        keys.register("or", base, AuthType.BEARER); keys.set("or", "sk-t")
        g.settings.update { it.copy(providers = listOf(ProviderConfig("or", preset, "OR", ProviderType.OPENAI, base, listOf("m"), modelMeta = meta))) }
        g.chats.create("or", "m")
    }

    private class Plugins(val onBefore: (RequestContext, PluginContext?) -> RequestContext = { c, _ -> c }) : PluginRegistry {
        var host: PluginContext? = null
        var after: TurnResult? = null
        override fun attach(context: PluginContext) { host = context }
        override fun transformRequest(req: BuiltRequest, ctx: RequestContext) = req.copy(headers = req.headers + ("X-Plugin" to "gcache"))
        override val plugins: List<ChatPlugin> = emptyList()
        override fun isActive(id: String, settings: AppSettings, conv: Conversation?) = true
        override suspend fun runBeforeRequest(ctx: RequestContext, status: (String?) -> Unit) = onBefore(ctx, host)
        override fun runAfterResponse(ctx: RequestContext, result: TurnResult): Conversation { after = result; return ctx.conv }
        override fun messageBadges(msg: Message, settings: AppSettings, conv: Conversation) = emptyList<Badge>()
        override fun headerBadges(settings: AppSettings, conv: Conversation) = emptyList<Badge>()
        override fun messageState(msg: Message, settings: AppSettings, conv: Conversation) = MessageState()
        override val errors: StateFlow<List<JsonObject>> = MutableStateFlow(emptyList())
    }

    private fun ok(text: String = "你好") = TinySseServer.Handler { _, ex ->
        ex.head(200)
        ex.text("data: {\"choices\":[{\"delta\":{\"content\":\"$text\"}}]}\n\n")
        ex.text("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")
    }

    @Test fun sendPersistsUserFirstThenAssistantAndRunsPipeline() = runBlocking {
        val conv = setup()
        val plugins = Plugins { ctx, host ->
            host!!.notify("插件提示")
            ctx.copy(meta = JsonObject(mapOf("orGemini" to JsonPrimitive(true))))
        }
        val engine = DefaultChatEngine(g.chats, g.settings, client, plugins)
        var userSavedBeforeStream = false
        server.handlers += TinySseServer.Handler { r, ex ->
            userSavedBeforeStream = runBlocking { g.chats.load(conv.id)!!.messages.any { it.role == Role.USER && it.content == "hi" } }
            ok().handle(r, ex)
        }
        val ev = withTimeout(10_000) { engine.send(conv.id, "hi", emptyList()).toList() }
        val started = ev.first() as StreamEvent.Started                         // #c
        assertTrue(ev.contains(StreamEvent.Notice("插件提示")))                  // #i
        assertTrue(userSavedBeforeStream)                                        // #b.1
        val rec = server.requests.poll(1, TimeUnit.SECONDS)!!
        assertEquals("gcache", rec.headers["x-plugin"])                          // #g transformRequest 在 build 之后
        assertFalse("orGemini 时不得写 session_id", rec.body.contains("session_id"))   // #h
        assertEquals("Bearer sk-t", rec.headers["authorization"])
        val saved = g.chats.load(conv.id)!!
        val bot = saved.messages.last()
        assertEquals(started.assistantMsgId, bot.id); assertEquals(started.userMsgId, saved.messages[saved.messages.size - 2].id)
        assertEquals("你好", bot.content); assertEquals("stop", bot.finishReason); assertEquals(10L, bot.usage?.prompt)
        assertTrue(plugins.after!!.ok)
    }

    @Test fun withoutOrGeminiSessionIdIsWritten() = runBlocking {
        val conv = setup()
        server.handlers += ok()
        DefaultChatEngine(g.chats, g.settings, client, Plugins()).send(conv.id, "hi", emptyList()).toList()
        assertTrue(server.requests.poll(1, TimeUnit.SECONDS)!!.body.contains("\"session_id\""))
    }

    @Test fun errorIsWrittenToAssistantAndSaved() = runBlocking {
        val conv = setup()
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(401, "application/json"); ex.text("{\"error\":{\"message\":\"bad key\"}}") }
        val ev = DefaultChatEngine(g.chats, g.settings, client, Plugins()).send(conv.id, "hi", emptyList()).toList()
        assertTrue(ev.any { it is StreamEvent.Error })
        val bot = g.chats.load(conv.id)!!.messages.last()
        assertEquals(Role.ASSISTANT, bot.role); assertNotNull(bot.error); assertTrue(bot.error!!.contains("bad key"))
    }

    @Test fun stopKeepsPartialTextAsTruncated() = runBlocking {
        val conv = setup()
        val gate = java.util.concurrent.CountDownLatch(1)
        server.handlers += TinySseServer.Handler { _, ex ->
            ex.head(200); ex.text("data: {\"choices\":[{\"delta\":{\"content\":\"半句\"}}]}\n\n")
            gate.await(5, TimeUnit.SECONDS)
        }
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins())
        withTimeout(10_000) {
            engine.send(conv.id, "hi", emptyList()).collect { if (it is StreamEvent.Delta) engine.stop(conv.id) }
        }
        gate.countDown()
        val bot = g.chats.load(conv.id)!!.messages.last()
        assertEquals("半句", bot.content); assertTrue(bot.truncated)
    }

    @Test fun openRouterAffinityPinsUpstreamAndObserves() = runBlocking {
        val eps = Js.json.parseToJsonElement("""{"m":{"_endpoints":[{"tag":"deepinfra","pricing":{"prompt":"0.0000001","completion":"0.0000003","input_cache_read":"0.00000002"}},{"tag":"together","pricing":{"prompt":"0.0000002","completion":"0.0000002"}}]}}""") as JsonObject
        val conv = setup(meta = eps)
        var saved: JsonObject? = null
        val router = AffinityRouter(save = { saved = it })
        server.handlers += ok()
        val ev = DefaultChatEngine(g.chats, g.settings, client, Plugins(), router).send(conv.id, "hi", emptyList()).toList()
        assertTrue(ev.contains(StreamEvent.RouteChosen("deepinfra")))
        val body = server.requests.poll(1, TimeUnit.SECONDS)!!.body
        assertTrue(body, body.contains("\"provider\":{\"order\":[\"deepinfra\"],\"allow_fallbacks\":true,\"require_parameters\":true}"))
        assertEquals("deepinfra", g.chats.load(conv.id)!!.messages.last().routeSlug)
        val st = saved!!["m"] as JsonObject
        assertEquals("1", ((st["upstreams"] as JsonObject)["deepinfra"] as JsonObject)["obs"].toString())
    }

    /** C1：只有一个版本 → 引擎先删旧消息再建新消息（新 id 经 Started 发出），同 app.js regenerate 的 pop + runChat */
    @Test fun regenerateSingleVersionReplacesMessageWithNewId() = runBlocking {
        val conv = setup()
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins())
        server.handlers += ok("一"); engine.send(conv.id, "hi", emptyList()).toList()
        val first = g.chats.load(conv.id)!!.messages.last()
        var oldGoneBeforeStream = false
        server.handlers += TinySseServer.Handler { r, ex ->
            oldGoneBeforeStream = runBlocking { g.chats.load(conv.id)!!.messages.none { it.id == first.id } }
            ok("二").handle(r, ex)
        }
        val ev = engine.regenerate(conv.id, first.id).toList()
        val started = ev.first() as StreamEvent.Started
        assertNotEquals(first.id, started.assistantMsgId)
        assertTrue(oldGoneBeforeStream)
        val msgs = g.chats.load(conv.id)!!.messages
        assertEquals(2, msgs.size); assertEquals(started.assistantMsgId, msgs.last().id)
        assertEquals("二", msgs.last().content); assertTrue(msgs.last().versions.isEmpty())
    }

    /** C1：失败回复（单版本）同样删旧建新；新消息上不带旧 error */
    @Test fun regenerateFailedSingleVersionAlsoReplaces() = runBlocking {
        val conv = setup()
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins())
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(500, "application/json"); ex.text("{\"error\":{\"message\":\"boom\"}}") }
        engine.send(conv.id, "hi", emptyList()).toList()
        val bad = g.chats.load(conv.id)!!.messages.last(); assertNotNull(bad.error)
        server.handlers += ok("好了")
        val started = engine.regenerate(conv.id, bad.id).toList().first() as StreamEvent.Started
        val msgs = g.chats.load(conv.id)!!.messages
        assertEquals(2, msgs.size); assertEquals(started.assistantMsgId, msgs.last().id); assertNotEquals(bad.id, msgs.last().id)
        assertNull(msgs.last().error); assertEquals("好了", msgs.last().content)
    }

    /** C1：多版本（UI 已 addVersion 并保存）→ 就地写进同一条消息 */
    @Test fun regenerateMultiVersionWritesInPlace() = runBlocking {
        val conv = setup()
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins())
        server.handlers += ok("一"); engine.send(conv.id, "hi", emptyList()).toList()
        val c1 = g.chats.load(conv.id)!!
        val first = c1.messages.last()
        g.chats.save(c1.copy(messages = Versions.addVersion(c1.messages, c1.messages.lastIndex)))   // UI 的一步
        server.handlers += ok("二")
        val started = engine.regenerate(conv.id, first.id).toList().first() as StreamEvent.Started
        assertEquals(first.id, started.assistantMsgId)
        val m = g.chats.load(conv.id)!!.messages.last()
        assertEquals(first.id, m.id); assertEquals("二", m.content)
        assertEquals(2, m.versions.size); assertEquals(1, m.vi)
        assertEquals("一", (m.versions[0]!!["content"] as JsonPrimitive).content)
    }

    /** C2：续写发送前清掉 error / stopped / truncated / finishReason 并落盘，再追加 */
    @Test fun continueClearsFlagsBeforeSendingAndAppends() = runBlocking {
        val conv = setup()
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins())
        server.handlers += ok("前半"); engine.send(conv.id, "hi", emptyList()).toList()
        val c1 = g.chats.load(conv.id)!!
        val m0 = c1.messages.last().copy(error = "网络错误", truncated = true, finishReason = "length",
            extras = JsonObject(c1.messages.last().extras + ("stopped" to JsonPrimitive(true))))
        g.chats.save(c1.copy(messages = c1.messages.dropLast(1) + m0))
        var seen: Message? = null
        server.handlers += TinySseServer.Handler { r, ex ->
            seen = runBlocking { g.chats.load(conv.id)!!.messages.last() }
            ok("后半").handle(r, ex)
        }
        engine.continueGeneration(conv.id, m0.id).toList()
        seen!!.let { assertNull(it.error); assertFalse(it.truncated); assertNull(it.finishReason); assertFalse(Js.truthy(it.extras["stopped"])) }
        val m = g.chats.load(conv.id)!!.messages.last()
        assertEquals(m0.id, m.id); assertEquals("前半后半", m.content); assertNull(m.error); assertFalse(Js.truthy(m.extras["stopped"]))
    }

    /** C3：新对话标题加助手 emoji 前缀（app.js send：有正文才加；空白折叠、截 24） */
    @Test fun newConversationTitleGetsPersonaEmoji() = runBlocking {
        val conv = setup()
        g.chats.save(g.chats.load(conv.id)!!.copy(personaEmoji = "🐱"))
        server.handlers += ok()
        DefaultChatEngine(g.chats, g.settings, client, Plugins()).send(conv.id, "  你好\n  世界  ", emptyList()).toList()
        assertEquals("🐱 你好 世界", g.chats.load(conv.id)!!.title)
        assertEquals("🐱 " + "a".repeat(24), titleOf("🐱", "x", "a".repeat(30)))
        assertEquals("📄 a.pdf", titleOf("🐱", "", "📄 a.pdf"))
        assertEquals("你好", titleOf(null, "你好", "你好"))
    }

    /** B：files 按旧 JS 存进 user.files[] 并在请求里展开成文件上下文；只发文件时标题用 📄 文件名 */
    @Test fun filesAreStoredAndExpandedInRequest() = runBlocking {
        val conv = setup()
        server.handlers += ok()
        val f = FileAttachment("a.txt", 12, "text", "文件正文", 4, pages = null)
        val bad = FileAttachment("b.pdf", 9, "pdf", "", 0)
        DefaultChatEngine(g.chats, g.settings, client, Plugins()).send(conv.id, "", emptyList(), listOf(f, bad)).toList()
        val c = g.chats.load(conv.id)!!
        val user = c.messages.first { it.role == Role.USER }
        assertEquals(1, user.files.size); assertEquals("a.txt", Js.str(user.files[0]["name"]))
        assertEquals("📄 a.txt", c.title)
        val body = server.requests.poll(1, TimeUnit.SECONDS)!!.body
        assertTrue(body, body.contains("用户上传了以下文件，请基于文件内容回答：") && body.contains("【文件：a.txt】") && body.contains("文件正文"))
    }

    // ---------------- M4：NetRetry ----------------
    private fun fail(status: Int) = TinySseServer.Handler { _, ex -> ex.head(status, "application/json"); ex.text("{\"error\":{\"message\":\"busy\"}}") }

    @Test fun netRetryBacksOffThenSucceeds() = runBlocking {
        val conv = setup()
        val waits = mutableListOf<Long>()
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins(), sleep = { waits += it }, rnd = { 0.5 })
        server.handlers += fail(503); server.handlers += fail(503); server.handlers += ok("终于")
        val ev = engine.send(conv.id, "hi", emptyList()).toList()
        assertEquals(listOf(800L, 1600L), waits)                                  // backoff(0/1, server, 0.5)
        assertTrue(ev.contains(StreamEvent.Notice("服务端暂时不可用（503），0.8 秒后重试（1/2）")))
        assertTrue(ev.contains(StreamEvent.Notice("服务端暂时不可用（503），1.6 秒后重试（2/2）")))
        assertFalse(ev.any { it is StreamEvent.Error })
        val bot = g.chats.load(conv.id)!!.messages.last()
        assertEquals("终于", bot.content); assertNull(bot.error); assertNull(bot.extras["retries"])
        assertEquals(3, server.requests.size)
    }

    @Test fun netRetryGivesUpAfterTwoAndRecordsRetries() = runBlocking {
        val conv = setup()
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins(), sleep = { }, rnd = { 0.0 })
        repeat(3) { server.handlers += fail(429) }
        val ev = engine.send(conv.id, "hi", emptyList()).toList()
        assertTrue(ev.contains(StreamEvent.Notice("请求过于频繁（429），1.6 秒后重试（1/2）")))
        assertEquals(1, ev.count { it is StreamEvent.Error })
        val bot = g.chats.load(conv.id)!!.messages.last()
        assertTrue(bot.error!!, bot.error!!.endsWith("（已重试 2 次）")); assertEquals("2", bot.extras["retries"].toString())
    }

    @Test fun netRetrySkipsAuthErrors() = runBlocking {
        val conv = setup()
        val waits = mutableListOf<Long>()
        server.handlers += fail(401)
        DefaultChatEngine(g.chats, g.settings, client, Plugins(), sleep = { waits += it }).send(conv.id, "hi", emptyList()).toList()
            .let { assertTrue(it.any { e -> e is StreamEvent.Error }) }
        assertTrue(waits.isEmpty()); assertEquals(1, server.requests.size)
        assertFalse(g.chats.load(conv.id)!!.messages.last().error!!.contains("已重试"))
    }

    // ---------------- M4：联网搜索 ----------------
    private fun searchOn(rewrite: Boolean) = runBlocking {
        g.settings.update { it.copy(searchOn = true, search = Js.json.parseToJsonElement(
            """{"provider":"searxng","urls":{"searxng":"${server.baseUrl}/sx"},"count":3,"rewrite":$rewrite}""") as JsonObject) }
    }
    private val sx = TinySseServer.Handler { _, ex ->
        ex.head(200, "application/json")
        ex.text("""{"results":[{"title":"<b>标题</b>","url":"https://www.example.com/a","content":"摘要 正文","publishedDate":"2026-11-01"}]}""")
    }

    @Test fun searchRewritesQueryInjectsResultsAndPersists() = runBlocking {
        val conv = setup(); searchOn(true)
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(200, "application/json"); ex.text("""{"choices":[{"message":{"content":"改写后的查询"}}]}""") }
        server.handlers += sx
        server.handlers += ok("答")
        val ev = DefaultChatEngine(g.chats, g.settings, client, Plugins(), search = com.aichat.app.net.DefaultSearchClient(AuthInjector(keys), http))
            .send(conv.id, "今天有什么新闻", emptyList()).toList()
        assertTrue(ev.first() is StreamEvent.Started)
        assertTrue(ev.contains(StreamEvent.Notice("正在联网搜索：改写后的查询")))
        val rw = server.requests.poll(1, TimeUnit.SECONDS)!!
        assertTrue(rw.body, rw.body.contains("\"temperature\":0") && rw.body.contains("\"max_tokens\":256") && rw.body.contains("\"stream\":false"))
        val sr = server.requests.poll(1, TimeUnit.SECONDS)!!
        assertEquals("/sx/search?q=" + com.aichat.app.net.SearchCore.encodeURIComponent("改写后的查询") + "&format=json", sr.path)
        val chat = server.requests.poll(1, TimeUnit.SECONDS)!!.body
        assertTrue(chat, chat.contains("example.com") && chat.contains("今天有什么新闻"))
        val saved = g.chats.load(conv.id)!!
        val user = saved.messages.first { it.role == Role.USER }; val bot = saved.messages.last()
        assertEquals("\"改写后的查询\"", (user.extras["search"] as JsonObject)["query"].toString())
        assertEquals(1, (bot.extras["sources"] as kotlinx.serialization.json.JsonArray).size)
        assertEquals("\"改写后的查询\"", bot.extras["searchQuery"].toString())
        assertFalse(Js.truthy(bot.extras["searching"])); assertEquals("答", bot.content)
    }

    @Test fun searchFailureFallsBackToDirectAnswer() = runBlocking {
        val conv = setup(); searchOn(false)
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(500, "text/html"); ex.text("<h1>Internal</h1>") }
        server.handlers += ok("直接答")
        DefaultChatEngine(g.chats, g.settings, client, Plugins(), search = com.aichat.app.net.DefaultSearchClient(AuthInjector(keys), http))
            .send(conv.id, "问题", emptyList()).toList()
        val bot = g.chats.load(conv.id)!!.messages.last()
        assertEquals("联网搜索失败：HTTP 500：Internal。以下为模型直接回答。", Js.str(bot.extras["searchError"]))
        assertEquals("直接答", bot.content)
        assertFalse(Js.truthy(g.chats.load(conv.id)!!.messages.first().extras["search"]))
    }

    @Test fun continueDoesNotSearch() = runBlocking {
        val conv = setup()
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins(), search = com.aichat.app.net.DefaultSearchClient(AuthInjector(keys), http))
        server.handlers += ok("前"); engine.send(conv.id, "hi", emptyList()).toList()
        searchOn(false); server.requests.clear()
        server.handlers += ok("后")
        engine.continueGeneration(conv.id, g.chats.load(conv.id)!!.messages.last().id).toList()
        assertEquals(1, server.requests.size)
        assertEquals("前后", g.chats.load(conv.id)!!.messages.last().content)
    }

    @Test fun injectNowLineOnlyWithMarker() {
        val e = DefaultChatEngine(g.chats, g.settings, client, Plugins())
        val msgs = listOf(WireMessage(Role.USER, "问"))
        assertEquals(msgs, e.injectNowLine(msgs, "普通 system") { "[现在] x" })
        assertEquals("问\n\n[现在] x", e.injectNowLine(msgs, "见本轮动态信息") { "[现在] x" }.last().content)
        assertEquals("[现在] 现在是 2026-01-01 08:00（北京时间，现实时间，仅供参考）", TimeLine.nowLine(1767225600000L, java.util.TimeZone.getTimeZone("Asia/Shanghai")))
    }

    @Test fun providerMigrationHookRunsOnFirstLaunch() = runBlocking {
        val store = com.aichat.app.data.store.MemFileStore(mapOf(
            "settings.json" to """{"providers":[{"id":"d","presetId":"deepseek","name":"DeepSeek","type":"openai","baseUrl":"https://api.deepseek.com/v1","models":["deepseek-chat","deepseek-reasoner"]}],"lastProviderId":"d","lastModel":"deepseek-reasoner"}""",
            "convs.json" to "[]"))
        @Suppress("DEPRECATION") val dir = kotlin.io.createTempDir("migB")
        val dg = DataGraph(store, FakeKeyVault(), dir, providerMigration = ProviderMigration.hook)
        val r = dg.migration.run()
        val s = Js.json.parseToJsonElement(store.get("settings.json")!!) as JsonObject
        assertEquals(2, (s["settingsVersion"] as JsonPrimitive).content.toInt())
        assertEquals("deepseek-flash", (s["lastModel"] as JsonPrimitive).content)
        assertTrue(Js.stringify(s["providers"]).contains("\"models\":[\"deepseek-flash\",\"deepseek-v4-pro\"]"))
        assertTrue(Js.stringify(s["providers"]).contains("\"baseUrl\":\"https://api.deepseek.com\""))
        assertTrue(r.warnings.none { it.contains("待 B 接线") })
    }
}
