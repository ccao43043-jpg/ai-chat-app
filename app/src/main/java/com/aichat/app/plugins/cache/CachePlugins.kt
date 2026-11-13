package com.aichat.app.plugins.cache

import com.aichat.app.domain.*
import com.aichat.app.domain.model.*
import com.aichat.app.domain.rp.GCachePlugin
import com.aichat.app.domain.rp.MmCachePlugin
import com.aichat.app.plugins.PluginHost
import com.aichat.app.plugins.PluginRegistryImpl
import com.aichat.app.plugins.js.*
import kotlinx.serialization.json.JsonObject

/** Usage（providers.normalizeUsage 输出）→ JS 值；null 字段 = 缺键（undefined） */
fun usageJs(u: Usage?): JObj? {
    if (u == null) return null
    val o = JObj()
    u.prompt?.let { o["prompt"] = it.toDouble() }; u.completion?.let { o["completion"] = it.toDouble() }
    u.hit?.let { o["hit"] = it.toDouble() }; u.miss?.let { o["miss"] = it.toDouble() }
    u.cacheWrite?.let { o["cacheWrite"] = it.toDouble() }; u.cacheSupported?.let { o["cacheSupported"] = it }
    u.source?.let { o["source"] = it }; u.costUsd?.let { o["costUsd"] = it }
    return o
}
internal fun JsonObject.plus(k: String, v: Any?): JsonObject = JsonObject(LinkedHashMap(this).also { it[k] = Js.toJson(v) })
internal fun RequestContext.metaJs(k: String): Any? = Js.fromJson(meta[k])
internal fun BuiltRequest.toJs(): JObj = jobj("url" to url, "method" to method, "headers" to JObj(headers), "body" to body)
@Suppress("UNCHECKED_CAST")
internal fun JObj.toBuilt(): BuiltRequest = BuiltRequest(this["url"].jstr(), Js.str(Js.or(this["method"], "POST")),
    (this["headers"].o() ?: JObj()).mapValues { Js.str(it.value) }, this["body"].jstr())
/** 把插件信息写到本轮回复消息（result.bot.<key> = info） */
internal fun withBotInfo(conv: Conversation, botId: String, key: String, info: Any?): Conversation =
    conv.copy(messages = conv.messages.map { m -> if (m.id == botId) m.copy(extras = m.extras.plus(key, info)) else m })

/** www/plugins/cache/gcache.js 插件部分（hooks + transformRequest） */
class GCachePluginImpl(private val host: PluginHost) : GCachePlugin {
    override val id = GCache.ID
    override val name = "Gemini 提示缓存（OpenRouter）"
    override val defaultEnabled = true
    override val perConversation = false
    /** 仅运行时：convId → 上一轮 system 前缀 / 完整请求体 */
    private val lastPrefix = HashMap<String, String>()
    private val lastReqBody = HashMap<String, String>()

    fun cfgOf(settings: AppSettings): JObj = Js.assign(GCache.DEFAULTS, host.config(settings, id))
    fun statOf(conv: Conversation): JObj {
        val d = host.convData(conv, id)
        val s = jobj("requests" to 0, "hits" to 0, "prompt" to 0, "cached" to 0, "write" to 0, "unknown" to 0, "prefixChanges" to 0, "prefixLen" to 0, "lastDiff" to null,
            "roll" to jarr(), "hist" to jarr(), "static_hash" to "", "static_prompt_version" to GCache.STATIC_PROMPT_VERSION, "session_id" to "", "decision" to "", "diag" to null)
        d["stat"].o()?.let { s.putAll(it) }
        d["stat"] = s; return s
    }
    private fun memOf(conv: Conversation): JObj {
        val d = host.convData(conv, id); val m = jobj("L0" to jarr(), "backups" to jarr()); d["memory"].o()?.let { m.putAll(it) }; d["memory"] = m; return m
    }
    private fun rpActive(settings: AppSettings, conv: Conversation): Boolean = try { host.isActive("rpcache", settings, conv) } catch (e: Throwable) { false }
    private fun convJs(conv: Conversation): JObj = jobj("id" to conv.id, "systemPrompt" to conv.systemPrompt, "plugins" to Js.fromJson(conv.extras["plugins"]))

    override suspend fun onBeforeRequest(ctx: RequestContext, status: (String?) -> Unit): RequestContext {
        if (!GCache.isOpenRouterGemini(PluginRegistryImpl.providerJs(ctx.provider), ctx.model)) return ctx
        val rpa = rpActive(ctx.settings, ctx.conv)
        return ctx.copy(meta = ctx.meta.plus("orGemini", cfgOf(ctx.settings)).plus("gcacheRp", GCache.isRpConv(convJs(ctx.conv), rpa)).plus("gcacheRpcache", rpa))
    }

    override fun transformRequest(req: BuiltRequest, ctx: RequestContext): BuiltRequest {
        val o = ctx.metaJs("orGemini").o() ?: return req
        val conv = ctx.conv
        val s = statOf(conv)
        val adapter = GCache.resolveCacheAdapter(PluginRegistryImpl.providerJs(ctx.provider), ctx.model)
        val full = GCache.cacheAdapterFull(adapter)
        val hyOn = o["hybrid"] != false && !ctx.metaJs("gcacheRpcache").truthy()
        val hd = host.convData(conv, id)
        if (hyOn) hd["hybrid"] = if (hd["hybrid"].truthy() && hd["hybrid"]["v"].truthy()) hd["hybrid"] else GCache.emptyHybrid()
        val now = host.now().toDouble()
        val idleSec = if (s["lastT"].truthy()) (now - s["lastT"].d()) / 1000 else null
        val ttlEff = GCache.TTL_EFF_DEFAULT.toDouble()
        val rr = GCache.rollingRate(s["roll"].a())
        val cacheStats = jobj("hitRate" to rr?.let { it / 100 }, "hitSamples" to (s["roll"].a() ?: jarr()).count { it.truthy() && it["known"].truthy() })
        val segs = if (ctx.metaJs("gcacheRpcache").truthy() && ctx.metaJs("rpSegments").truthy()) ctx.metaJs("rpSegments") else null
        val r = GCache.applyToRequest(req.toJs(), o, jobj("adapter" to adapter, "sessionId" to if (full) GCache.sessionIdFor(conv.id) else "", "rp" to ctx.metaJs("gcacheRp").truthy(),
            "prevStaticHash" to s["static_hash"], "hybrid" to if (hyOn) hd["hybrid"] else null, "ids" to ctx.messages.map { it.srcId }.toMutableList<Any?>(),
            "idleSec" to idleSec, "ttlEff" to ttlEff, "segments" to segs, "cacheStats" to cacheStats))
        s["hybridInfo"] = r["hybrid"] ?: jobj("off" to if (o["hybrid"] == false) "setting" else "rpcache")
        s["requests"] = s["requests"].d() + 1
        if (s["lastT"].truthy()) s["gaps"] = Js.slice((s["gaps"].a() ?: jarr()) + listOf<Any?>(Js.round((now - s["lastT"].d()) / 100) / 10), -50)
        val outReq = r["req"].o()!!
        val curBody = outReq["body"]?.let { Js.str(it) } ?: ""
        val prevBody = lastReqBody[conv.id]
        val ratio = prevBody?.let { GCache.lcpRatio(it, curBody) }
        val prefix = r["prefix"].jstr()
        val compressed = r["hybrid"].truthy() && r["hybrid"]["summaryCreated"].truthy()
        val curMeta = jobj("prefix_hash" to GCache.hash(prefix), "t" to now, "body" to curBody, "lcpRatio" to ratio, "compressed" to compressed)
        s["expect"] = GCache.expectedHit(s["lastReq"], curMeta, ttlEff)
        s["lastLcp"] = ratio
        s["lastReq"] = jobj("explicit" to r["applied"].truthy(), "prefix_hash" to curMeta["prefix_hash"], "t" to now, "lcpRatio" to ratio, "compressed" to compressed)
        lastReqBody[conv.id] = curBody
        s["lastT"] = now
        s["applied"] = r["applied"]
        val prevPrefix = lastPrefix[conv.id]; val ph = GCache.hash(prefix)
        if (if (prevPrefix != null) prevPrefix != prefix else (s["prefix_hash"].truthy() && s["prefix_hash"] != ph)) {
            s["prefixChanges"] = s["prefixChanges"].d() + 1; if (prevPrefix != null) s["lastDiff"] = GCache.firstDiff(prevPrefix, prefix)
        }
        lastPrefix[conv.id] = prefix
        s.remove("prefix"); s["prefix_hash"] = ph; s["prefixLen"] = prefix.length
        val layers = r["layers"].o()
        if (layers != null) {
            val route = r["route"]
            s["static_hash"] = layers["static_hash"]; s["decision"] = r["decision"]["reason"]; s["session_id"] = r["session_id"]; s["layered"] = layers["layered"]
            s["hist"] = Js.slice((s["hist"].a() ?: jarr()) + listOf<Any?>(jobj("t" to host.now(), "static_hash" to layers["static_hash"], "prefix_hash" to GCache.hash(prefix),
                "model" to route["model"], "provider" to route["provider"], "session_id" to r["session_id"], "tokens" to GCache.estTokens(layers["staticText"]))), -GCache.ROLL_N)
            val mem = memOf(conv); val l0 = GCache.extractL0(layers)
            if (l0.isNotEmpty()) {
                val L0 = mem["L0"].a() ?: jarr(); val have = L0.map { it["fp"] }.toMutableSet()
                l0.forEach { x -> if (x["fp"] !in have) L0 += x }
                mem["L0"] = Js.slice(L0, -200)
            }
            s["l0Missing"] = GCache.missingL0(mem["L0"].a(), outReq["body"]).size
        }
        return outReq.toBuilt()
    }

    override fun onAfterResponse(result: TurnResult, ctx: RequestContext): Conversation? {
        val o = ctx.metaJs("orGemini").o()
        if (o == null || !result.ok) return null
        var conv = ctx.conv
        val i = GCache.usageInfo(usageJs(result.usage))
        val s = statOf(conv)
        if (i != null) {
            if (i["known"] == false) s["unknown"] = s["unknown"].d() + 1
            else { s["prompt"] = s["prompt"].d() + i["prompt"].d(); s["cached"] = s["cached"].d() + i["hit"].d(); s["write"] = s["write"].d() + i["write"].d(); if (i["hit"].truthy()) s["hits"] = s["hits"].d() + 1 }
            s["roll"] = Js.slice((s["roll"].a() ?: jarr()) + listOf<Any?>(jobj("prompt" to i["prompt"], "hit" to i["hit"], "known" to (i["known"] != false))), -GCache.ROLL_N)
            conv = withBotInfo(conv, result.assistant.id, "gcache", i)
            val prev = s["diag"]["level"]
            s["diag"] = GCache.diagnose(s)
            if (i["known"] != false) {
                val actual = if (i["prompt"].truthy()) i["hit"].d() / i["prompt"].d() else 0.0
                val gaps = s["gaps"].a()
                val gapForAttr = if (gaps != null && gaps.isNotEmpty()) gaps.last() else null
                s["hitAttr"] = GCache.attributeCacheHit(jobj("expected" to (s["lastLcp"] ?: (if (s["lastReq"].truthy()) s["lastReq"]["lcpRatio"] else null)), "actual" to actual,
                    "gapSec" to gapForAttr, "compressed" to (s["lastReq"].truthy() && s["lastReq"]["compressed"].truthy()), "ttlEff" to GCache.TTL_EFF_DEFAULT))
                s["diag"] = GCache.diagnose(s)
                val should = s["expect"].truthy() || (s["hitAttr"].truthy() && s["hitAttr"]["shouldHit"].truthy())
                if (should) {
                    s["missStreak"] = if (i["hit"].truthy()) 0.0 else Js.i32(s["missStreak"]) + 1.0
                    if (s["missStreak"].d() == 2.0 && o["missAlert"] != false) {
                        val why = Js.str(Js.or(if (s["hitAttr"].truthy()) s["hitAttr"]["text"] else null, "LCP≥90% 且在 TTL 内，可能被路由到不同供应商或缓存被驱逐"))
                        host.notify("💎 连续 2 轮应命中却未命中：$why")
                    }
                } else if (i["hit"].truthy()) s["missStreak"] = 0.0
            } else if (i["hit"].truthy()) s["missStreak"] = 0.0
            if (o["toast"].truthy()) {
                var t = GCache.usageText(i)
                if (s["hitAttr"].truthy() && s["hitAttr"]["text"].truthy()) t += " · " + s["hitAttr"]["text"].jstr()
                host.notify(t)
            }
            if (o["diagToast"].truthy() && s["diag"]["level"] == "low" && prev != "low") host.notify("💎 缓存命中率 " + Js.str(s["diag"]["rate"]) + "%：" + Js.str(s["diag"]["issues"].a()!![0]))
        }
        return conv
    }

    override fun messageBadges(msg: Message, conv: Conversation): List<Badge> {
        val i = if (msg.role == Role.ASSISTANT) Js.fromJson(msg.extras["gcache"]) else null
        if (!i.truthy()) return emptyList()
        if (i["known"] == false) return listOf(Badge(id, "💎 缓存 ?", "info", GCache.usageText(i), action = id))
        val pct = i["pct"].d()
        return listOf(Badge(id, "💎 缓存 " + Js.str(i["pct"]), if (pct >= GCache.DIAG_GOOD) "ok" else if (i["hit"].truthy()) "warn" else "info", GCache.usageText(i), action = id).let { it.copy(text = it.text + "%") })
    }
    override fun headerBadges(conv: Conversation): List<Badge> {
        val s = Js.fromJson((conv.extras["plugins"] as? JsonObject)?.get(id))["stat"]
        if (!s.truthy() || (s["roll"].a() ?: jarr()).isEmpty()) return emptyList()
        val d = if (s["diag"].truthy()) s["diag"] else GCache.diagnose(s)
        if (d["rate"] == null) return emptyList()
        val tn = when (d["level"]) { "good" -> "ok"; "low" -> "bad"; "ok" -> "warn"; else -> "info" }
        return listOf(Badge(id, "命中 " + Js.str(d["rate"]) + "%", tn, "Gemini 滚动命中率（近 " + GCache.ROLL_N + " 次）", action = id))
    }
}

/** www/plugins/cache/mmcache.js 插件部分 */
class MmCachePluginImpl(private val host: PluginHost) : MmCachePlugin {
    override val id = MmCache.ID
    override val name = "MiniMax 提示缓存（OpenRouter）"
    override val defaultEnabled = true
    override val perConversation = false
    private val lastPrefix = HashMap<String, String>()
    private val lastBody = HashMap<String, String>()

    fun cfgOf(settings: AppSettings): JObj = Js.assign(MmCache.DEFAULTS, host.config(settings, id))
    fun statOf(conv: Conversation): JObj {
        val d = host.convData(conv, id)
        val s = jobj("requests" to 0, "hits" to 0, "prompt" to 0, "cached" to 0, "unknown" to 0, "prefixChanges" to 0, "prefixLen" to 0, "prefix_hash" to "", "roll" to jarr(), "gaps" to jarr(),
            "session_id" to "", "lastDiff" to null, "diag" to null)
        d["stat"].o()?.let { s.putAll(it) }
        d["stat"] = s; return s
    }
    override suspend fun onBeforeRequest(ctx: RequestContext, status: (String?) -> Unit): RequestContext {
        if (!MmCache.isOpenRouterMiniMax(PluginRegistryImpl.providerJs(ctx.provider), ctx.model)) return ctx
        return ctx.copy(meta = ctx.meta.plus("orMiniMax", cfgOf(ctx.settings)))
    }
    override fun transformRequest(req: BuiltRequest, ctx: RequestContext): BuiltRequest {
        val o = ctx.metaJs("orMiniMax").o() ?: return req
        val conv = ctx.conv
        val s = statOf(conv); val now = host.now().toDouble()
        val r = MmCache.applyToRequest(req.toJs(), o, jobj("sessionId" to MmCache.sessionIdFor(conv.id)))
        s["requests"] = s["requests"].d() + 1
        if (s["lastT"].truthy()) s["gaps"] = Js.slice((s["gaps"].a() ?: jarr()) + listOf<Any?>(Js.round((now - s["lastT"].d()) / 100) / 10), -50)
        s["lastT"] = now; s["session_id"] = Js.or(r["session_id"], ""); s["routeOrder"] = r["route"].truthy() && r["route"]["order"].truthy()
        val prefix = r["prefix"].jstr(); val ph = CacheCommonImpl.hash(prefix); val prevP = lastPrefix[conv.id]
        if (if (prevP != null) prevP != prefix else (s["prefix_hash"].truthy() && s["prefix_hash"] != ph)) { s["prefixChanges"] = s["prefixChanges"].d() + 1; if (prevP != null) s["lastDiff"] = CacheCommonImpl.firstDiff(prevP, prefix) }
        val outReq = r["req"].o()!!
        val body = outReq["body"]?.let { Js.str(it) } ?: ""; val pb = lastBody[conv.id]
        s["lastLcp"] = pb?.let { CacheCommonImpl.lcpRatio(it, body) }
        lastPrefix[conv.id] = prefix; lastBody[conv.id] = body
        s["prefix_hash"] = ph; s["prefixLen"] = prefix.length; s["prefixTokens"] = r["prefixTokens"]
        return outReq.toBuilt()
    }
    override fun onAfterResponse(result: TurnResult, ctx: RequestContext): Conversation? {
        val o = ctx.metaJs("orMiniMax").o()
        if (o == null || !result.ok) return null
        val i = CacheCommonImpl.usageInfo(usageJs(result.usage)) ?: return null
        val s = statOf(ctx.conv)
        if (i["known"] == false) s["unknown"] = s["unknown"].d() + 1 else { s["prompt"] = s["prompt"].d() + i["prompt"].d(); s["cached"] = s["cached"].d() + i["hit"].d(); if (i["hit"].truthy()) s["hits"] = s["hits"].d() + 1 }
        s["roll"] = Js.slice((s["roll"].a() ?: jarr()) + listOf<Any?>(jobj("prompt" to i["prompt"], "hit" to i["hit"], "known" to (i["known"] != false))), -MmCache.ROLL_N)
        s["lastPromptEst"] = i["prompt"]
        val conv = withBotInfo(ctx.conv, result.assistant.id, "mmcache", i)
        val prev = s["diag"]["level"]; s["diag"] = MmCache.diagnose(s)
        if (o["toast"].truthy()) host.notify(MmCache.usageText(i))
        if (o["diagToast"].truthy() && s["diag"]["level"] == "low" && prev != "low") host.notify("🧊 MiniMax 缓存命中率 " + Js.str(s["diag"]["rate"]) + "%：" + Js.str(s["diag"]["issues"].a()!![0]))
        return conv
    }
    override fun messageBadges(msg: Message, conv: Conversation): List<Badge> {
        val i = if (msg.role == Role.ASSISTANT) Js.fromJson(msg.extras["mmcache"]) else null
        if (!i.truthy()) return emptyList()
        if (i["known"] == false) return listOf(Badge(id, "🧊 缓存 ?", "info", MmCache.usageText(i)))
        return listOf(Badge(id, "🧊 缓存 " + Js.str(i["pct"]) + "%", if (i["pct"].d() >= MmCache.DIAG_GOOD) "ok" else if (i["hit"].truthy()) "warn" else "info", MmCache.usageText(i)))
    }
    override fun headerBadges(conv: Conversation): List<Badge> {
        val s = Js.fromJson((conv.extras["plugins"] as? JsonObject)?.get(id))["stat"]
        if (!s.truthy() || (s["roll"].a() ?: jarr()).isEmpty()) return emptyList()
        val d = if (s["diag"].truthy()) s["diag"] else MmCache.diagnose(s)
        if (d["rate"] == null) return emptyList()
        val tn = when (d["level"]) { "good" -> "ok"; "low" -> "bad"; "ok" -> "warn"; else -> "info" }
        return listOf(Badge(id, "命中 " + Js.str(d["rate"]) + "%", tn, "MiniMax 滚动命中率（近 " + MmCache.ROLL_N + " 次）", action = id))
    }
}
