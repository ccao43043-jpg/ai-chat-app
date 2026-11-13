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

    @Test fun regenerateKeepsOldReplyAsVersion() = runBlocking {
        val conv = setup()
        val engine = DefaultChatEngine(g.chats, g.settings, client, Plugins())
        server.handlers += ok("一"); engine.send(conv.id, "hi", emptyList()).toList()
        val first = g.chats.load(conv.id)!!.messages.last()
        server.handlers += ok("二"); engine.regenerate(conv.id, first.id).toList()
        val m = g.chats.load(conv.id)!!.messages.last()
        assertEquals(first.id, m.id); assertEquals("二", m.content)
        assertEquals(2, m.versions.size); assertEquals(1, m.vi)
        assertEquals("一", (m.versions[0]!!["content"] as JsonPrimitive).content)
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
