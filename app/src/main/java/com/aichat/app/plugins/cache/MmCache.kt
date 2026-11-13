package com.aichat.app.plugins.cache

import com.aichat.app.plugins.js.*

/** www/plugins/cache/mmcache.js 纯逻辑部分的逐函数移植（golden：golden/mmcache 下的 jsonl） */
object MmCache {
    const val ID = "mmcache"
    val DEFAULTS: JObj get() = jobj("sessionId" to true, "mergeSystem" to true, "toast" to false, "diagToast" to true)
    const val MIN_TOKENS = 512
    const val STICKY_SEC = 600
    const val DIAG_LOW = 40; const val DIAG_GOOD = 70; const val ROLL_N = 8
    val PRICES: JObj get() = jobj("minimax-m3.1-flash" to 0.1, "minimax-m3" to 0.2, "minimax-m2.7" to 0.2, "minimax-m2.5" to 0.11)

    fun priceFor(model: Any?): JObj {
        val m = Js.replace(Js.re(":.*$"), Js.str(Js.or(model, "")).lowercase().let { Js.replace(Js.re("^~"), it, false, "") }.split("/").last(), false, "")
        val p = PRICES
        val k = p.keys.sortedWith { a, b -> b.length - a.length }.firstOrNull { x -> m == x || m.startsWith("$x-") }
        return jobj("read" to (if (k != null) p[k] else 0.2), "write" to 1.0, "known" to (k != null))
    }
    fun isMiniMaxModel(model: Any?): Boolean = Js.test(Js.re("^~?minimax/", "i"), Js.trim(Js.str(Js.or(model, ""))))
    fun isOpenRouterMiniMax(provider: Any?, model: Any?): Boolean = isMiniMaxModel(model) && CacheCommonImpl.isOpenRouterProvider(provider.o())
    fun supportsCacheControl(): Boolean = false
    fun sessionIdFor(id: Any?): String = if (id == null || id == "") "" else CacheCommonImpl.sessionIdFor(Js.str(id), ID)

    fun mergeLeadingSystem(msgs: List<Any?>): MutableList<Any?> {
        var n = 0; while (n < msgs.size && msgs[n]["role"] == "system" && msgs[n]["content"] is String) n++
        if (n < 2) return msgs.toMutableList()
        return (listOf<Any?>(jobj("role" to "system", "content" to msgs.take(n).joinToString("\n\n") { it["content"] as String })) + msgs.drop(n)).toMutableList()
    }
    fun prefixOf(body: Any?): String {
        val msgs = body["messages"].a() ?: mutableListOf()
        val sys = StringBuilder(); for (m in msgs) { if (m["role"] != "system") break; sys.append(CacheCommonImpl.partsText(m["content"])).append('\n') }
        return (if (body["tools"].truthy()) Js.stringify(body["tools"]) + "\n" else "") + sys
    }
    /** applyToRequest(req, cfg, info)：req.body 可为字符串或对象 */
    fun applyToRequest(req: JObj, cfg0: Map<String, Any?>?, info0: Map<String, Any?>?): JObj {
        val cfg = Js.assign(DEFAULTS, cfg0); val info = info0 ?: JObj()
        val strBody = req["body"] is String
        val body: JObj = try { (if (strBody) Js.parse(req["body"] as String) else Js.assign(req["body"].o())) as? JObj ?: return jobj("req" to req, "prefix" to "", "applied" to false) }
            catch (e: Exception) { return jobj("req" to req, "prefix" to "", "applied" to false) }
        val msgs0 = body["messages"].a() ?: return jobj("req" to req, "prefix" to "", "applied" to false)
        if (cfg["mergeSystem"].truthy()) body["messages"] = mergeLeadingSystem(msgs0)
        var sid: Any? = ""
        if (cfg["sessionId"].truthy() && info["sessionId"].truthy()) { if (body["session_id"] == null) body["session_id"] = info["sessionId"]; sid = body["session_id"] }
        val prefix = prefixOf(body)
        val out = Js.assign(req); out["body"] = if (strBody) Js.stringify(body) else body
        val pv = body["provider"]
        val route = jobj("model" to body["model"], "order" to (pv.truthy() && pv["order"] is List<*> && (pv["order"] as List<*>).isNotEmpty()))
        return jobj("req" to out, "prefix" to prefix, "session_id" to sid, "prefixTokens" to CacheCommonImpl.estTokens(prefix),
            "promptTokens" to CacheCommonImpl.estTokens(Js.stringify(body["messages"])), "route" to route, "applied" to false)
    }
    fun diagnose(s: Any?): JObj {
        val rate = CacheCommonImpl.rollingRate(s["roll"].a())
        val issues = mutableListOf<Any?>()
        if (rate == null) issues += "服务商未返回 cached_tokens，无法统计（可能路由到不报告缓存的供应商）"
        if (s["lastPromptEst"] != null && s["lastPromptEst"].d() < MIN_TOKENS) issues += "输入约 " + Js.str(s["lastPromptEst"]) + " Token，低于 MiniMax 自动缓存门槛 " + MIN_TOKENS
        val pc = s["prefixChanges"].d(); val rq = s["requests"].d()
        if (pc > 0 && rq > 1 && pc / rq > 0.3) issues += "固定前缀（tools/system）频繁变化 " + Js.str(s["prefixChanges"]) + " 次：把时间、随机内容移到对话尾部"
        if (s["routeOrder"].truthy()) issues += "请求指定了 provider.order，OpenRouter 不会做 sticky routing，缓存易落空"
        if (!s["session_id"].truthy()) issues += "未发送 session_id（设置里已关闭），首轮起的 sticky 路由失效"
        val gaps = Js.slice(s["gaps"].a() ?: mutableListOf(), -ROLL_N)
        if (gaps.size >= 3 && gaps.count { it.d() > STICKY_SEC }.toDouble() / gaps.size > 0.5) issues += "多数请求间隔超过 " + Js.numToString(STICKY_SEC / 60.0) + " 分钟，sticky 会话已过期、缓存可能已被驱逐"
        val level = if (rate == null) "unknown" else if (rate >= DIAG_GOOD) "good" else if (rate < DIAG_LOW) "low" else "ok"
        if (level == "low" && issues.isEmpty()) issues += "前缀稳定但未命中：MiniMax 缓存过期随负载变化，或被路由到不同供应商"
        return jobj("rate" to rate, "level" to level, "issues" to issues)
    }
    fun usageText(i: Any?): String {
        if (i["known"] == false) return "MiniMax 缓存命中未知（未返回 cached_tokens；输入 " + Js.str(i["prompt"]) + " Token）"
        return if (i["hit"].truthy()) "MiniMax 缓存命中 " + Js.str(i["hit"]) + "/" + Js.str(i["prompt"]) + " Token（" + Js.str(i["pct"]) + "%）" else "MiniMax 缓存未命中（输入 " + Js.str(i["prompt"]) + " Token）"
    }
}
