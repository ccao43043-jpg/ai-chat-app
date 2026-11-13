package com.aichat.app.plugins.cache

import com.aichat.app.domain.rp.CacheCommon
import com.aichat.app.plugins.js.JObj
import com.aichat.app.plugins.js.Js
import com.aichat.app.plugins.js.jobj
import kotlin.math.ceil
import kotlin.math.max

/** www/plugins/cache/cache-common.js 的逐函数移植（golden：golden/cache-common 下的 jsonl） */
object CacheCommonImpl : CacheCommon {
    /** FNV-1a 32 位 hex（padStart 8） */
    override fun hash(s: String): String {
        var h = 0x811c9dc5.toInt()
        for (ch in s) { h = h xor ch.code; h *= 0x01000193 }
        return Js.padStart(java.lang.Long.toHexString(h.toLong() and 0xffffffffL), 8, '0')
    }
    fun hashAny(v: Any?): String = hash(Js.strOrEmpty(v))

    override fun sessionIdFor(convId: String, ns: String): String {
        if (convId.isEmpty()) return ""
        val s = (if (ns.isNotEmpty()) "$ns:" else "") + convId
        val h = hash(s) + hash("a$s") + hash("b$s") + hash("c$s")
        return h.substring(0, 8) + "-" + h.substring(8, 12) + "-" + h.substring(12, 16) + "-" + h.substring(16, 20) + "-" + h.substring(20, 32)
    }

    /** CJK（\u3000-\u9fff\uff00-\uffef）1 字 ≈ 1 Token，其余 4 字符 ≈ 1 Token */
    override fun estTokens(s: String): Int {
        var cjk = 0
        for (c in s) if (c in '\u3000'..'\u9fff' || c in '\uff00'..'\uffef') cjk++
        return ceil(cjk + (s.length - cjk) / 4.0).toInt()
    }
    fun estTokensAny(v: Any?): Int = estTokens(if (Js.truthy(v)) Js.str(v) else "")

    fun partsText(c: Any?): String = when (c) {
        is String -> c
        is List<*> -> c.joinToString("") { p -> val o = p as? Map<*, *>; if (o != null && o["type"] == "text") (o["text"]?.let { if (it === com.aichat.app.plugins.js.Undefined) "" else Js.str(it) } ?: "") else "[" + (if (o != null && Js.truthy(o["type"])) Js.str(o["type"]) else "?") + "]" }
        else -> Js.stringify(c ?: "")
    }

    override fun lcpLen(a: String, b: String): Int { val n = minOf(a.length, b.length); var i = 0; while (i < n && a[i] == b[i]) i++; return i }
    override fun lcpRatio(a: String, b: String): Double = if (b.isNotEmpty()) lcpLen(a, b).toDouble() / b.length else 0.0
    fun firstDiff(a: String, b: String): JObj {
        val i = lcpLen(a, b)
        return jobj("pos" to i, "before" to Js.slice(a, max(0, i - 20), i + 40), "after" to Js.slice(b, max(0, i - 20), i + 40))
    }

    /** 统一 usage → { prompt, hit, write, pct, known? } */
    fun usageInfo(u: Map<String, Any?>?): JObj? {
        if (u == null || u["prompt"] == null) return null
        val prompt = Js.i32(u["prompt"]); val hit = Js.i32(u["hit"]); val write = Js.i32(u["cacheWrite"])
        if (u["hit"] == null && !Js.truthy(u["cacheSupported"])) return jobj("prompt" to prompt, "hit" to 0, "write" to write, "pct" to null, "known" to false)
        return jobj("prompt" to prompt, "hit" to hit, "write" to write, "pct" to if (prompt != 0) Js.round(hit.toDouble() / prompt * 100) else 0.0)
    }
    fun rollingRate(roll: List<Any?>?): Double? {
        val k = (roll ?: emptyList()).mapNotNull { it as? Map<*, *> }.filter { it["known"] != false && Js.toNumber(it["prompt"]) > 0 }
        if (k.isEmpty()) return null
        val p = k.sumOf { Js.toNumber(it["prompt"]) }; val h = k.sumOf { Js.toNumber(it["hit"]) }
        return if (p != 0.0) Js.round(h / p * 100) else 0.0
    }
    fun estimateCost(i: Map<String, Any?>?, price: Map<String, Any?>?): JObj? {
        if (i == null || i["known"] == false) return null
        val read = Js.toNumber((price?.get("read")) ?: 1.0); val write = Js.toNumber((price?.get("write")) ?: 1.0)
        val prompt = Js.toNumber(i["prompt"]); val hit = Js.toNumber(i["hit"]); val w = Js.toNumber(i["write"])
        val miss = max(0.0, prompt - hit - w)
        val equiv = miss + hit * read + w * write
        return jobj("equiv" to Js.round(equiv), "saved" to Js.round(prompt - equiv), "pctSaved" to if (prompt != 0.0) Js.round((prompt - equiv) / prompt * 100) else 0.0)
    }
    fun isOpenRouterProvider(p: Map<String, Any?>?): Boolean {
        val pp = p ?: emptyMap()
        if (Js.truthy(pp["type"]) && pp["type"] != "openai") return false
        val forced = Js.trim(Js.str(Js.or(pp["cacheAdapter"], ""))).lowercase()
        if (forced == "none" || forced == "openai-compat") return false
        return forced == "openrouter" || pp["presetId"] == "openrouter" || Js.test(Js.re("openrouter\\.ai", "i"), Js.strOrEmpty(pp["baseUrl"]))
    }
}
