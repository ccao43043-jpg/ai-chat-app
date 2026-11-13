package com.aichat.app.plugins

import com.aichat.app.domain.*
import com.aichat.app.domain.model.*
import com.aichat.app.plugins.cache.GCache
import com.aichat.app.plugins.js.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** PluginRegistry 行为（移植 tests/plugins.test.js）+ gcache/mmcache 多轮管线 golden（浏览器模式加载的 JS 插件逐轮对照） */
class PluginPipelineTest {
    private fun conv(id: String = "c", plugins: JsonObject = JsonObject(emptyMap()), msgs: List<Message> = emptyList(), sys: String? = null) =
        Conversation(id, "t", "or", "m", 0, 0, msgs, systemPrompt = sys, extras = JsonObject(mapOf("plugins" to plugins)))
    private fun settings(plugins: JsonObject = JsonObject(emptyMap()), providers: List<ProviderConfig> = emptyList()) = AppSettings(providers = providers, plugins = plugins)
    private val P0 = ProviderConfig("or", "openrouter", "OpenRouter", ProviderType.OPENAI, "https://openrouter.ai/api/v1", emptyList())
    private fun ctx(c: Conversation, s: AppSettings, msgs: List<WireMessage> = listOf(WireMessage(Role.USER, "hi"))) =
        RequestContext(c, P0, "m", "S", msgs, ChatOptions(), s, null)

    private class Fake(override val id: String, override val perConversation: Boolean = false, val order: MutableList<String>, val boom: Boolean = false) : ChatPlugin {
        override val name = id; override val defaultEnabled = true
        override suspend fun onBeforeRequest(ctx: RequestContext, status: (String?) -> Unit): RequestContext {
            if (boom) { throw IllegalStateException("炸了") }
            order += id; return ctx.copy(systemPrompt = ctx.systemPrompt + "[$id]", messages = ctx.messages + WireMessage(Role.USER, id))
        }
        override fun onResponseUsage(usage: Usage, ctx: RequestContext) { if (!boom) order += "usage-$id:" + usage.prompt }
        override fun onAfterResponse(result: TurnResult, ctx: RequestContext): Conversation? { if (!boom) order += "after-$id:" + result.ok; return null }
        override fun messageBadges(msg: Message, conv: Conversation): List<Badge> = if (boom) error("x") else listOf(Badge("", id.uppercase(), "ok"))
    }
    private fun mk(): Pair<PluginRegistryImpl, MutableList<String>> {
        val order = mutableListOf<String>(); val reg = PluginRegistryImpl()
        reg.register(Fake("a", order = order)); reg.register(Fake("boom", order = order, boom = true)); reg.register(Fake("b", order = order)); reg.register(Fake("conv", true, order))
        return reg to order
    }

    @Test fun registerUniqueIds() {
        val reg = PluginRegistryImpl(); reg.register(Fake("x", order = mutableListOf()))
        assertThrows(IllegalArgumentException::class.java) { reg.register(Fake("x", order = mutableListOf())) }
    }
    @Test fun globalAndConversationSwitches() {
        val (reg, _) = mk()
        val s = settings(); val c = conv()
        assertTrue(reg.isActive("a", s, c)); assertFalse("对话级插件默认不在对话中开启", reg.isActive("conv", s, c))
        val c2 = conv(plugins = buildJsonObject { putJsonObject("conv") { put("enabled", true) }; putJsonObject("a") { put("enabled", false) } })
        assertTrue(reg.isActive("conv", s, c2))
        assertFalse(reg.isActive("conv", settings(buildJsonObject { putJsonObject("conv") { put("enabled", false) } }), c2))
        assertFalse("全局插件可在对话中单独关闭", reg.isActive("a", s, c2))
        assertEquals(listOf("boom", "b", "conv"), reg.active(s, c2).map { it.id })
    }
    @Test fun beforeRequestOrderAndErrorIsolation() = runBlocking {
        val (reg, order) = mk()
        val c = conv(plugins = buildJsonObject { putJsonObject("conv") { put("enabled", true) } })
        val out = reg.runBeforeRequest(ctx(c, settings()), {})
        assertEquals(listOf("a", "b", "conv"), order)
        assertEquals("S[a][b][conv]", out.systemPrompt)
        assertEquals(listOf("hi", "a", "b", "conv"), out.messages.map { it.content })
        assertEquals(listOf("a", "boom", "b", "conv"), out.activePlugins)
        assertEquals("boom", reg.errors.value[0]["plugin"]!!.jsonPrimitive.content)
    }
    @Test fun noActivePluginsKeepsRequest() = runBlocking {
        val (reg, _) = mk()
        val off = buildJsonObject { listOf("a", "boom", "b", "conv").forEach { putJsonObject(it) { put("enabled", false) } } }
        val c0 = ctx(conv(), settings(off))
        val out = reg.runBeforeRequest(c0, {})
        assertEquals(c0.copy(activePlugins = emptyList()), out)
    }
    @Test fun afterResponseAndBadges() {
        val (reg, order) = mk()
        val bot = Message("b1", Role.ASSISTANT, "x")
        reg.runAfterResponse(ctx(conv(), settings()), TurnResult(true, 200, Usage(prompt = 10), bot))
        assertEquals(listOf("usage-a:10", "after-a:true", "usage-b:10", "after-b:true"), order)
        assertEquals(listOf(Badge("a", "A", "ok"), Badge("b", "B", "ok")), reg.messageBadges(bot, settings(), conv()))
    }
    @Test fun errorsCappedAndDeduped() {
        val reg = PluginRegistryImpl(); var n = 0
        reg.register(object : ChatPlugin { override val id = "bad"; override val name = "bad"; override val defaultEnabled = true; override val perConversation = false
            override fun messageBadges(msg: Message, conv: Conversation): List<Badge> = error("e" + (if (n++ % 2 != 0) "" else n.toString())) })
        repeat(300) { reg.messageBadges(Message("m", Role.ASSISTANT, ""), settings(), conv()) }
        assertEquals(50, reg.errors.value.size)
        val reg2 = PluginRegistryImpl()
        reg2.register(object : ChatPlugin { override val id = "bad"; override val name = "bad"; override val defaultEnabled = true; override val perConversation = false
            override fun messageBadges(msg: Message, conv: Conversation): List<Badge> = error("same") })
        repeat(30) { reg2.messageBadges(Message("m", Role.ASSISTANT, ""), settings(), conv()) }
        assertEquals(1, reg2.errors.value.size); assertEquals(30, reg2.errors.value[0]["count"]!!.jsonPrimitive.int)
    }
    @Test fun defaultOrderMatchesLegacyScriptOrder() {
        val reg = PluginRegistryImpl.createDefault()
        val ids = reg.plugins.map { it.id }
        assertEquals(PluginRegistryImpl.ORDER.filter { it in ids }, ids)
        assertEquals(listOf("usage", "gcache", "mmcache"), ids)   // M2 已实现的插件；knowledge / rpcache / affect 在 M3 补齐
    }

    // ───────── 多轮管线 golden ─────────
    @Test fun pipelineGolden() {
        GCache.localDate = { "2026-11-13" }
        var total = 0
        for (name in Golden.list("pipeline")) { total += runScenario(name) }
        println("[golden] pipeline：${Golden.list("pipeline").size} 个场景，$total 轮全部一致")
    }
    @Suppress("UNCHECKED_CAST")
    private fun runScenario(name: String): Int = runBlocking {
        val lines = Golden.rawLines("pipeline/$name").map { Js.parse(it) as JObj }
        val head = lines[0]["in"]!!
        val pj = head["provider"].o()!!
        val provider = ProviderConfig(pj["id"].jstr(), pj["presetId"].jstr(), pj["name"].jstr(), ProviderType.of(pj["type"] as String?), pj["baseUrl"].jstr(), emptyList(),
            extras = Js.toJson(JObj(pj.filterKeys { it !in setOf("id", "presetId", "name", "type", "baseUrl") })) as JsonObject)
        val model = head["model"].jstr()
        val s = AppSettings(providers = listOf(provider), plugins = (Js.toJson(head["settings"]["plugins"] ?: JObj()) as JsonObject))
        var now = 0L; val toasts = mutableListOf<String>()
        val reg = PluginRegistryImpl.createDefault(clock = { now }, onToast = { toasts += it })
        var c = Conversation(head["convId"].jstr(), "", provider.id, model, 0, 0, emptyList(), extras = JsonObject(mapOf("plugins" to Js.toJson(head["convPlugins"] ?: JObj()))))
        lines.drop(1).forEachIndexed { t, line ->
            val inp = line["in"]!!; val exp = line["out"]!!; val where = "$name 第 ${t} 轮"
            val cx = inp["ctx"]!!
            now = cx["now"].d().toLong(); toasts.clear()
            c = c.copy(systemPrompt = cx["systemPrompt"] as String?, messages = c.messages + Message(inp["userId"].jstr(), Role.USER, ""))
            val wire = cx["messages"].a()!!.map { m -> WireMessage(Role.of(m["role"] as String), m["content"].jstr(), srcId = m["srcId"] as String?) }
            var ctx = RequestContext(c, provider, model, c.systemPrompt ?: "", wire, ChatOptions(convId = c.id, maxTokens = 8192), s, inp["userId"] as String?)
            ctx = reg.runBeforeRequest(ctx) {}
            assertEquals("$where active", exp["active"].a()!!.map { it.jstr() }, ctx.activePlugins)
            for (k in listOf("gcacheRp", "gcacheRpcache"))   // orGemini/orMiniMax 在 JS 里挂在 ctx.opts，Kotlin 挂在 meta（ChatOptions 无此字段），由请求体对照覆盖
            Golden.diff(exp["meta"][k], Js.fromJson(ctx.meta[k]), "$where meta.$k")?.let { fail(it) }
            val rq = inp["req"]!!
            val req = BuiltRequest(rq["url"].jstr(), rq["method"].jstr(), (rq["headers"].o()!!).mapValues { it.value.jstr() }, rq["body"].jstr())
            val out = reg.transformRequest(req, ctx)
            Golden.diff(exp["req"]["body"], out.body, "$where req.body")?.let { fail(it) }
            Golden.diff(exp["req"]["headers"], JObj(out.headers), "$where req.headers")?.let { fail(it) }
            val bot = Message(inp["botId"].jstr(), Role.ASSISTANT, inp["botContent"].jstr())
            c = ctx.conv.copy(messages = ctx.conv.messages + bot)
            val u = inp["usage"]
            val usage = if (u == null) null else Usage(prompt = u["prompt"]?.d()?.toLong(), completion = u["completion"]?.d()?.toLong(), hit = u["hit"]?.d()?.toLong(),
                cacheWrite = u["cacheWrite"]?.d()?.toLong(), cacheSupported = u["cacheSupported"] as Boolean?)
            c = reg.runAfterResponse(ctx.copy(conv = c), TurnResult(true, 200, usage, bot))
            Golden.diff(exp["plugins"], Js.fromJson(c.extras["plugins"]), "$where conv.plugins")?.let { fail(it) }
            val botNow = c.messages.last()
            for (k in listOf("gcache", "mmcache")) Golden.diff(exp["bot"][k], Js.fromJson(botNow.extras[k]), "$where bot.$k")?.let { fail(it) }
            Golden.diff(exp["toasts"], toasts.toMutableList<Any?>(), "$where toasts")?.let { fail(it) }
            // 徽章（与 JS 钩子文案一致）
            reg.messageBadges(botNow, s, c); reg.headerBadges(s, c)
        }
        assertTrue(reg.errors.value.toString(), reg.errors.value.isEmpty())
        lines.size - 1
    }
}
