package com.aichat.app.plugins.cache

import com.aichat.app.plugins.js.*
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * www/plugins/cache/gcache.js 纯逻辑部分的逐函数移植（v1.4.0）。
 * 值模型见 [Js]；所有字符串拼接与 JS 逐字一致（golden：golden/gcache 下的 jsonl）。
 * 时间相关只有 Hybrid 摘要的 at（本地日期），由 [localDate] 注入。
 */
object GCache {
    const val ID = "gcache"
    val DEFAULTS: JObj get() = jobj("mode" to "auto", "mergeSystem" to true, "ttl" to "", "responseCache" to false, "toast" to true, "sessionId" to true,
        "rpGuardrails" to "auto", "diagToast" to true, "hybrid" to true, "autoTarget" to "history", "writePrice" to 1.0, "keepaliveMaxPings" to 3,
        "missAlert" to true, "summaryStrategy" to "semantic")
    const val STATIC_PROMPT_VERSION = 2
    const val DIAG_LOW = 40; const val DIAG_GOOD = 70; const val ROLL_N = 8
    val PRICE: JObj get() = jobj("read" to 0.25, "write" to 1.0)

    /** 注入：本地日期 YYYY-MM-DD（TimeUtil.localDateStr()） */
    @Volatile var localDate: () -> String = { java.time.LocalDate.now().toString() }

    fun hash(s: Any?): String = CacheCommonImpl.hash(Js.strOrEmpty(s))
    fun staticHash(st: String): String = "sha256:" + Js.sha256("$STATIC_PROMPT_VERSION\n$st")
    fun sha(s: String): String = Js.sha256(s)

    fun isGeminiModel(model: Any?): Boolean {
        val m = Js.str(Js.or(model, "")).lowercase()
        return m.startsWith("google/gemini") || m.startsWith("~google/gemini") || Js.test(Js.re("(^|/)gemini-"), m)
    }
    fun resolveCacheAdapter(provider: Any?, model: Any?): String {
        val p = provider.o() ?: JObj()
        val forced = Js.trim(Js.str(Js.or(p["cacheAdapter"], ""))).lowercase()
        if (forced == "openrouter" || forced == "openai-compat" || forced == "none") return forced
        if (p["presetId"] == "openrouter" || Js.test(Js.re("openrouter\\.ai", "i"), Js.str(Js.or(p["baseUrl"], "")))) return "openrouter"
        if (isGeminiModel(model) && (!p["type"].truthy() || p["type"] == "openai")) return "openai-compat"
        return "none"
    }
    fun cacheAdapterActive(a: String?) = a == "openrouter" || a == "openai-compat"
    fun cacheAdapterFull(a: String?) = a == "openrouter"
    fun isOpenRouterGemini(provider: Any?, model: Any?): Boolean {
        val p = provider.o() ?: JObj()
        if (p["type"].truthy() && p["type"] != "openai") return false
        if (!isGeminiModel(model)) return false
        return cacheAdapterActive(resolveCacheAdapter(p, model))
    }

    fun partsText(c: Any?): String = CacheCommonImpl.partsText(c)
    fun hasText(c: Any?): Boolean = (c is String && c.isNotEmpty()) || (c is List<*> && c.any { p -> p != null && p["type"] == "text" && p["text"].truthy() })

    fun stripCC(msg: JObj) {
        val c = msg["content"].a() ?: return
        val n = c.map { p -> if (p != null && p["cache_control"].truthy()) { val q = JObj(p as Map<String, Any?>); q.remove("cache_control"); q } else p }.toMutableList()
        msg["content"] = n
        if (n.size == 1 && n[0]["type"] == "text" && (n[0] as Map<*, *>).size == 2) msg["content"] = n[0]["text"]
    }
    fun addBreakpoint(msg: JObj, ttl: Any?): Boolean {
        val cc = jobj("type" to "ephemeral"); if (ttl.truthy()) cc["ttl"] = ttl
        val c = msg["content"]
        if (c is String) { if (c.isEmpty()) return false; msg["content"] = mutableListOf<Any?>(jobj("type" to "text", "text" to c, "cache_control" to cc)); return true }
        val arr = c.a()
        if (arr != null) for (i in arr.indices.reversed()) {
            val p = arr[i]
            if (p != null && p["type"] == "text" && p["text"].truthy()) { val q = JObj(p as Map<String, Any?>); q["cache_control"] = cc; arr[i] = q; return true }
        }
        return false
    }
    fun firstDiff(a: String, b: String): JObj {
        val n = min(a.length, b.length); var i = 0
        while (i < n && a[i] == b[i]) i++
        return jobj("pos" to i, "before" to Js.slice(a, max(0, i - 30), i + 50), "after" to Js.slice(b, max(0, i - 30), i + 50))
    }

    // ───────── PromptBuilder ─────────
    const val RP_ANCHOR = "【RP 协议】\n- 玩家角色的言行与决定只由玩家给出：不替玩家说话、行动或做选择。\n- NPC 的猜测、推断只能以猜测的口吻呈现，不得写成既定事实。\n- 人物核心性格保持一致；情绪、伤势、位置等临时状态单独描述，不改写核心设定。"
    private data class LayerDef(val id: String, val kind: String, val re: Regex)
    private val LAYERS = listOf(
        LayerDef("A", "static", Js.re("^(RP ?协议|协议|系统协议)$", "i")), LayerDef("B", "static", Js.re("^(世界观|世界背景|背景设定|世界设定)$")),
        LayerDef("C", "static", Js.re("^(角色卡|角色设定|人物设定|角色|人物核心|核心性格)$")),
        LayerDef("D", "static", Js.re("^(RP ?规则|规则|扮演规则|玩法规则|输出格式|回复格式|格式|示例对白|示例对话|对白示例|禁止事项|禁止|写作风格|文风|风格)$", "i")),
        LayerDef("E", "dynamic", Js.re("^(长期记忆|记忆|剧情摘要|摘要|章节摘要|前情提要)$")), LayerDef("F", "dynamic", Js.re("^(近期剧情|最近剧情|近期事件)$")),
        LayerDef("G", "dynamic", Js.re("^(当前场景|当前状态|状态|场景|临时状态)$")),
    )
    private val HEAD_RE = Js.re("^\\s*(?:#+\\s*)?(?:\\*\\*)?【([^】]{1,12})】")

    fun analyzeLayers(text: Any?): JObj {
        val blocks = mutableListOf<JObj>()
        var cur = jobj("layer" to "-", "kind" to "static", "title" to ""); var lines = mutableListOf<String>(); var known = 0
        fun flush() { if (lines.isNotEmpty()) { cur["text"] = lines.joinToString("\n"); blocks += cur } }
        Js.str(Js.or(text, "")).split("\n").forEach { line ->
            val m = Js.match(HEAD_RE, line)
            if (m != null) {
                val t = Js.trim(m[1]!!); val L = LAYERS.firstOrNull { Js.test(it.re, t) }
                flush()
                cur = jobj("layer" to (L?.id ?: "?"), "kind" to (L?.kind ?: "static"), "title" to t); lines = mutableListOf(line); if (L != null) known++
                return@forEach
            }
            lines += line
        }
        flush()
        val st = blocks.filter { it["kind"] == "static" }.joinToString("\n") { it["text"] as String }
        val dy = blocks.filter { it["kind"] == "dynamic" }.joinToString("\n") { it["text"] as String }
        var seenDyn = false; var ordered = true
        blocks.forEach { b -> if (b["kind"] == "dynamic") seenDyn = true else if (seenDyn) ordered = false }
        return jobj("blocks" to blocks.toMutableList<Any?>(), "staticText" to st, "dynamicText" to dy, "static_hash" to staticHash(st), "dynamic_hash" to hash(dy),
            "layered" to (known >= 2), "ordered" to ordered, "static_prompt_version" to STATIC_PROMPT_VERSION)
    }

    fun layersFromSegments(text0: Any?, segments: Any?): JObj {
        val text = Js.str(Js.or(text0, ""))
        val segs = segments.a()
        if (segs == null || segs.isEmpty()) return analyzeLayers(text)
        val dyn = segs.filter { x -> x.truthy() && x["kind"] == "dynamic" && x["text"].truthy() }
        data class R(val at: Int, val end: Int, val seg: Any?)
        val ranges = mutableListOf<R>()
        for (d in dyn) {
            val dt = d["text"].jstr(); val at = text.lastIndexOf(dt); if (at < 0) return analyzeLayers(text)
            ranges += R(at, at + dt.length, d)
        }
        val sorted = ranges.sortedBy { it.at }
        val blocks = mutableListOf<JObj>(); var pos = 0
        fun pushStatic(a: Int, b: Int) { val t = Js.slice(text, a, b); if (Js.trim(t).isNotEmpty()) blocks += jobj("layer" to "-", "kind" to "static", "title" to "", "text" to t) }
        sorted.forEach { r -> if (r.at < pos) return@forEach; pushStatic(pos, r.at); blocks += jobj("layer" to Js.or(r.seg["gl"], "E"), "kind" to "dynamic", "title" to Js.or(r.seg["title"], ""), "text" to r.seg["text"]); pos = r.end }
        pushStatic(pos, text.length)
        segs.filter { x -> x.truthy() && x["kind"] == "static" && (x["gl"] == "B" || x["gl"] == "C") && x["text"].truthy() && text.indexOf(x["text"].jstr()) >= 0 }
            .forEach { x -> blocks += jobj("layer" to x["gl"], "kind" to "ref", "title" to x["title"], "text" to x["text"]) }
        val stat = blocks.filter { it["kind"] == "static" }
        val st = stat.joinToString("\n\n") { Js.replace(Js.re("^\\s+|\\s+$"), it["text"].jstr(), true, "") }
        val dy = blocks.filter { it["kind"] == "dynamic" }.joinToString("\n") { it["text"].jstr() }
        var seenDyn = false; var ordered = true
        blocks.forEach { b -> if (b["kind"] == "dynamic") seenDyn = true else if (b["kind"] == "static" && seenDyn) ordered = false }
        return jobj("blocks" to blocks.toMutableList<Any?>(), "staticText" to st, "dynamicText" to dy, "static_hash" to staticHash(st), "dynamic_hash" to hash(dy),
            "layered" to true, "ordered" to ordered, "structured" to true, "static_prompt_version" to STATIC_PROMPT_VERSION)
    }

    // ───────── CachePolicyEngine ─────────
    fun minCacheTokens(model: Any?): Int {
        val m = Js.str(Js.or(model, ""))
        if (Js.test(Js.re("pro", "i"), m)) return 4096
        if (Js.test(Js.re("flash[-_]?lite|lite", "i"), m)) return 2048
        return 1024
    }
    fun adaptiveMinTokens(model: Any?, stats: Any?): Double {
        val base = minCacheTokens(model).toDouble()
        val n = if (stats.truthy()) Js.i32(stats["hitSamples"]) else 0
        val h = if (stats.truthy()) stats["hitRate"] else null
        if (!(n >= 4) || h == null) return base
        val hd = h.d(); if (hd.isNaN() || hd.isInfinite()) return base
        if (hd < 0.40) return Js.round(base * 1.5)
        if (hd < 0.55) return Js.round(base * 1.25)
        return base
    }
    fun isFlashLite(model: Any?): Boolean { val m = Js.str(Js.or(model, "")); return Js.test(Js.re("flash[-_]?lite|lite", "i"), m) && !Js.test(Js.re("pro", "i"), m) }
    fun flashLitePrefixNote(model: Any?, est: Any?): String? {
        if (!isFlashLite(model) || !(est.d() < 3000)) return null
        return "Flash-Lite 系统/固定前缀约 " + Js.str(est) + " Token < ~3k，隐式命中可能不稳；请以真实 cached_tokens 为准，勿用估计命中率"
    }
    fun estTokens(s: Any?): Int = CacheCommonImpl.estTokensAny(s)

    fun decide(cfg: JObj, info: JObj): JObj {
        val mode = cfg["mode"]
        if (mode == "off") return jobj("explicit" to false, "reason" to "已关闭显式断点，仅隐式缓存")
        if (mode == "prefix" || mode == "history") return jobj("explicit" to true, "reason" to "手动模式：" + Js.str(mode))
        val need = adaptiveMinTokens(info["model"], info["cacheStats"]); val have = estTokens(info["staticText"])
        if (have < need) {
            val note = flashLitePrefixNote(info["model"], have.toDouble())
            return jobj("explicit" to false, "reason" to "固定前缀约 " + have + " Token < 门槛 " + Js.numToString(need) + "，走隐式缓存（不填充凑门槛）" + (if (note != null) "；$note" else ""))
        }
        if (!info["prevStaticHash"].truthy()) return jobj("explicit" to false, "reason" to "首轮先走隐式缓存，确认前缀稳定后再写显式缓存")
        if (info["prevStaticHash"] != info["static_hash"]) return jobj("explicit" to false, "reason" to "固定层刚发生变化，本轮不写显式缓存")
        return jobj("explicit" to true, "reason" to "固定前缀约 " + have + " Token 且稳定，启用显式断点")
    }
    fun decideHistory(cfg: JObj, info: JObj): JObj {
        val need = adaptiveMinTokens(info["model"], info["cacheStats"]); val have = estTokens(info["cacheText"])
        if (have < need) {
            val note = flashLitePrefixNote(info["model"], have.toDouble())
            return jobj("explicit" to false, "reason" to "固定前缀+历史约 " + have + " Token < 门槛 " + Js.numToString(need) + "，走隐式缓存" + (if (note != null) "；$note" else ""))
        }
        if (!info["prevStaticHash"].truthy()) return jobj("explicit" to false, "reason" to "首轮先走隐式缓存，确认前缀稳定后再写显式缓存")
        if (info["prevStaticHash"] != info["static_hash"]) return jobj("explicit" to false, "reason" to "固定层刚发生变化，本轮不写显式缓存")
        return jobj("explicit" to true, "history" to true, "reason" to "固定前缀+历史约 " + have + " Token 且固定层稳定，断点放在本轮 user 之前（历史进缓存）")
    }

    // ───────── OpenRouterAdapter ─────────
    /** gcache 自己的 session_id（带 aichat- 前缀与 UUIDv4 形状，与 cache-common.sessionIdFor 不同） */
    fun sessionIdFor(convId: Any?): String {
        if (convId == null || convId == "") return ""
        val s = Js.str(convId); val h = hash(s) + hash("a$s") + hash("b$s") + hash("c$s")
        return "aichat-" + h.substring(0, 8) + "-" + h.substring(8, 12) + "-4" + h.substring(13, 16) + "-8" + h.substring(17, 20) + "-" + h.substring(20, 32)
    }
    fun applySession(body: JObj, sid: String): JObj { if (sid.isNotEmpty() && body["session_id"] == null) body["session_id"] = sid; return body }
    fun routeOf(body: JObj): JObj = jobj("model" to Js.or(body["model"], ""), "provider" to if (body["provider"].truthy()) Js.stringify(body["provider"]) else "")

    // ───────── MemoryManager ─────────
    fun tokenize(s0: Any?): Set<String> {
        val s = Js.str(Js.or(s0, "")).lowercase(); val out = LinkedHashSet<String>()
        Js.matchAll(Js.re("[a-z0-9]+", "g"), s).forEach { out += it }
        val c = Js.replace(Js.re("[^\\u4e00-\\u9fff]"), s, true, "")
        for (i in 0 until c.length - 1) out += c.substring(i, i + 2)
        return out
    }
    fun score(query: Any?, text: Any?): Double { val q = tokenize(query); val t = tokenize(text); if (q.isEmpty() || t.isEmpty()) return 0.0; var n = 0; q.forEach { if (it in t) n++ }; return n.toDouble() / q.size }
    fun extractL0(layers: Any?): MutableList<Any?> {
        val out = mutableListOf<Any?>()
        (layers["blocks"].a() ?: mutableListOf()).filter { b -> b["layer"] == "A" || b["layer"] == "B" || b["layer"] == "C" }.forEach { b ->
            b["text"].jstr().split("\n").drop(1).map { Js.trim(it) }.filter { it.length >= 4 }.forEach { x -> out += jobj("layer" to b["layer"], "text" to x, "fp" to hash(x)) }
        }
        return out
    }
    fun memSearch(entries: List<Any?>?, query: Any?, k: Int?): List<Any?> = (entries ?: emptyList()).map { e -> e to score(query, e["text"]) }.filter { it.second > 0 }
        .sortedWith { a, b -> b.second.compareTo(a.second).let { if (it == 0) 0 else it } }.take(if (k == null || k == 0) 5 else k)
        .map { (e, s) -> val o = jobj("score" to Js.round(s * 100) / 100); (e as Map<String, Any?>).forEach { (kk, v) -> o[kk] = v }; o }
    fun missingL0(entries: List<Any?>?, requestText: Any?): List<Any?> {
        val t = Js.strOrEmpty(Js.or(requestText, ""))
        return (entries ?: emptyList()).filter { e -> val et = e["text"].jstr(); t.indexOf(et) < 0 && t.indexOf(Js.quote(et).let { it.substring(1, it.length - 1) }) < 0 }
    }

    // ───────── HybridWindow ─────────
    const val RAW_MIN = 20; const val RAW_MAX = 40; const val SOFT = RAW_MIN + 0.6 * (RAW_MAX - RAW_MIN); const val HARD = RAW_MAX
    const val TTL_EFF_DEFAULT = 240; const val SUM_HEAD = "【前情提要（冻结摘要）】"; const val HW_SENT_MAX = 120
    const val SUM_CAP = 8000; const val SUM_MERGE_K = 4; const val SUM_L2_LINE = 36; const val SUM_L2_MIN = 8
    const val HYBRID_SUMMARY_MIN_QUALITY = 0.50

    private fun sumLen(ss: List<Any?>): Int = ss.sumOf { it["text"].jstr().length } + max(0, ss.size - 1)
    fun mergeSummaries(ss: List<Any?>, turns: List<List<Any?>>): JObj {
        val k = ss.take(SUM_MERGE_K); val from = k[0]["from"].i(); val to = k[k.size - 1]["to"].i()
        val raw = k.flatMap { s -> val t = s["text"].jstr(); if (s["level"].d() == 2.0) t.split("\n").drop(1).joinToString("\n").split("；") else t.split("\n") }
        val n = max(SUM_L2_MIN, min(SUM_L2_LINE, floor(SUM_CAP / 2.0 / raw.size).toInt() - 1))
        val lines = raw.map { clip(it, n) }
        val text = "【二级摘要 第" + (from + 1) + "–" + to + "轮】\n" + lines.joinToString("；")
        return jobj("from" to from, "to" to to, "fp" to batchFp(Js.slice(turns, from, to)), "text" to text, "level" to 2, "at" to k[k.size - 1]["at"])
    }
    private val DATE_RE = Js.re("(\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|\\d{4}年\\d{1,2}月\\d{1,2}日)(?:[ T]|\\s*)(?:\\d{1,2}[:：]\\d{2}[:：]\\d{2}(?:\\.\\d+)?(?:Z|[+-]\\d{2}:?\\d{2})?|\\d{1,2}[:：]\\d{2}(?:Z|[+-]\\d{2}:?\\d{2}))")
    fun normalizeDates(s: Any?): String = Js.replace(DATE_RE, Js.strOrEmpty(s), true, "$1")
    fun splitTurns(hist: List<Any?>): MutableList<MutableList<Any?>> {
        val turns = mutableListOf<MutableList<Any?>>(); var cur: MutableList<Any?>? = null
        hist.forEach { m -> if (m["role"] == "user" || cur == null) { cur = mutableListOf(); turns += cur!! }; cur!! += m }
        return turns
    }
    private val WS_RE = Js.re("\\s+")
    fun clip(s0: Any?, n: Int): String { val s = Js.trim(Js.replace(WS_RE, Js.str(Js.or(s0, "")), true, " ")); return if (s.length > n) s.substring(0, n) + "…" else s }
    private val NAME_RE = Js.re("[\\u4e00-\\u9fff]{2,4}|[A-Z][a-z]{2,}")
    private val ACTION_RE = Js.re("(把.{2,12}(?:交给|递给|交给了|藏进|放进|交给)|发现.{2,16}|保存.{2,12}|转移.{2,12}|交给.{2,8}|告诉.{2,12}|隐瞒.{2,12}|不知道.{2,16}|知道.{2,16}|秘密.{2,16}|证据.{2,12}|喜欢|讨厌|背叛|结盟)")
    private val SECRET_RE = Js.re("不知道[^。！？\\n]{2,20}|知道[^。！？\\n]{2,20}|秘密[^。！？\\n]{0,16}")
    private val DEC_TAIL_RE = Js.re("[。！？!?.…]+$")
    fun extractHybridEvidence(batch: List<List<Any?>>?): List<JObj> {
        val ev = mutableListOf<JObj>()
        (batch ?: emptyList()).forEachIndexed { ti, turn ->
            (turn).forEach { m ->
                val role = Js.str(Js.or(m["role"], ""))
                val text = Js.trim(Js.replace(WS_RE, partsText(origOrContent(m)), true, " "))
                if (text.isEmpty()) return@forEach
                val id = Js.or(m["id"], null)
                val mid = if (text.length > 40) text.substring(floor(text.length * 0.25).toInt(), floor(text.length * 0.75).toInt()) else text
                val tail = if (text.length > 24) Js.slice(text, -48) else text
                val head = Js.slice(text, 0, 36)
                val zones = if (role == "user") listOf(tail, text) else listOf(mid, tail, head)
                zones.forEach { z -> Js.matchAll(ACTION_RE, z).forEach { a -> ev += jobj("kind" to "action", "text" to a, "role" to role, "turn" to ti, "id" to id) } }
                if (role == "user" && text.length > 8) {
                    val decision = Js.slice(Js.replace(DEC_TAIL_RE, tail, true, ""), -24)
                    if (decision.length >= 4) ev += jobj("kind" to "decision", "text" to decision, "role" to role, "turn" to ti, "id" to id)
                }
                Js.matchAll(SECRET_RE, text).forEach { s -> ev += jobj("kind" to "secret", "text" to s, "role" to role, "turn" to ti, "id" to id) }
                Js.matchAll(NAME_RE, text).forEach { n -> if (n.length >= 2) ev += jobj("kind" to "name", "text" to n, "role" to role, "turn" to ti, "id" to id) }
            }
        }
        val seen = HashSet<String>(); val out = mutableListOf<JObj>()
        ev.forEach { e -> val k = e["kind"].jstr() + ":" + e["text"].jstr(); if (seen.add(k)) out += e }
        return out
    }
    private fun roleName(m: Any?) = if (m["role"] == "user") "玩家" else if (m["role"] == "assistant") "回复" else Js.str(m["role"])
    fun summarizeTurnsFast(turns: List<List<Any?>>, startNo: Int): String =
        turns.mapIndexed { i, t -> "第" + (startNo + i + 1) + "轮：" + t.joinToString(" → ") { m -> roleName(m) + "「" + clip(partsText(m["content"]), if (m["role"] == "user") 60 else 90) + "」" } }.joinToString("\n")
    fun summarizeTurnsSemantic(turns: List<List<Any?>>, startNo: Int): String {
        val lines = mutableListOf<String>()
        turns.forEachIndexed { i, t ->
            val no = startNo + i + 1
            val user = t.firstOrNull { it["role"] == "user" }
            val asst = t.reversed().firstOrNull { it["role"] == "assistant" }
            val ut = Js.trim(Js.replace(WS_RE, partsText(if (user.truthy()) user["content"] else null), true, " "))
            val at = Js.trim(Js.replace(WS_RE, partsText(if (asst.truthy()) asst["content"] else null), true, " "))
            fun tail(s: String, n: Int) = if (s.length <= n) s else "…" + Js.slice(s, -n)
            fun mid(s: String, n: Int): String { if (s.length <= n) return s; val start = max(0, s.length / 2 - n / 2); return "…" + Js.slice(s, start, start + n) + "…" }
            val names = LinkedHashSet<String>().apply { addAll(Js.matchAll(NAME_RE, ut)); addAll(Js.matchAll(NAME_RE, at)) }.take(8)
            val uBit = if (ut.length <= 64) ut else clip(ut, 28) + "…" + Js.slice(ut, -36)
            val aBit = if (at.length <= 96) at else mid(at, 40) + "｜" + tail(at, 40)
            val acts = extractHybridEvidence(listOf(t)).filter { it["kind"] == "action" || it["kind"] == "secret" }.take(4).map { it["text"].jstr() }
            lines += "第" + no + "轮：玩家「" + uBit + "」→ 结果「" + aBit + "」" + (if (names.isNotEmpty()) "｜人物:" + names.joinToString("/") else "") + (if (acts.isNotEmpty()) "｜证据:" + acts.joinToString("；") else "")
        }
        return lines.joinToString("\n")
    }
    fun summarizeTurns(turns: List<List<Any?>>, startNo: Int, strategy: String?): String =
        if ((strategy ?: "semantic") == "fast_local") summarizeTurnsFast(turns, startNo) else summarizeTurnsSemantic(turns, startNo)
    fun scoreHybridSummary(text0: Any?, batch: List<List<Any?>>?): Double {
        val t = Js.str(Js.or(text0, ""))
        if (t.isEmpty() || t.length < 20) return 0.0
        val evidence = extractHybridEvidence(batch)
        val critical = evidence.filter { it["kind"] == "action" || it["kind"] == "decision" || it["kind"] == "secret" }
        val names = evidence.filter { it["kind"] == "name" }
        fun coverOf(list: List<JObj>): Double {
            if (list.isEmpty()) return 1.0
            var hit = 0.0
            list.forEach { e ->
                val s = e["text"].jstr()
                if (t.indexOf(s) >= 0) { hit++; return@forEach }
                if (s.length >= 6) {
                    val core = s.substring(0, min(8, s.length))
                    if (t.indexOf(core) >= 0) { hit += 0.7; return@forEach }
                    val core2 = Js.slice(s, -min(8, s.length))
                    if (t.indexOf(core2) >= 0) hit += 0.5
                } else if (s.length >= 2 && t.indexOf(s) >= 0) hit++
            }
            return min(1.0, hit / list.size)
        }
        val critCover = coverOf(critical.take(12)); val nameCover = coverOf(names.take(10))
        val dens = min(1.0, t.length / max(80.0, (batch ?: emptyList()).size * 48.0))
        if (critical.isEmpty() && names.isEmpty()) return Js.round(min(0.35, dens * 0.5) * 100) / 100
        val score = if (critical.isNotEmpty()) critCover * 0.65 + nameCover * 0.20 + dens * 0.15 else nameCover * 0.7 + dens * 0.3
        return Js.round(min(1.0, score) * 100) / 100
    }
    fun batchText(batch: List<List<Any?>>): String = batch.flatten().joinToString("\n") { m -> Js.str(m["role"]) + ":" + partsText(origOrContent(m)) }
    fun batchFp(batch: List<List<Any?>>): String = "sha256:" + sha(batchText(batch))
    fun batchValid(s: JObj, batch: List<List<Any?>>): Boolean {
        val fp = s["fp"]
        if (fp is String && Js.test(Js.re("^[0-9a-f]{8}$"), fp)) {
            if (hash(batchText(batch)) != fp) return false
            s["fp"] = batchFp(batch); return true
        }
        return batchFp(batch) == fp
    }
    fun emptyHybrid(): JObj = jobj("v" to 1, "cut" to 0, "summaries" to mutableListOf<Any?>(), "sent" to JObj())

    /** hwApply：history 不含开头 system 与本轮 user；state 原地更新 */
    fun hwApply(history: List<Any?>?, state0: JObj?, summaryStrategy: Any? = null, idleSec0: Any? = null, ttlEff0: Any? = null): JObj {
        val state: JObj = if (state0 != null && state0["v"].truthy()) state0 else Js.assign(emptyHybrid(), state0 ?: JObj())
        state["summaries"] = state["summaries"].a() ?: mutableListOf<Any?>(); hwMigrateSent(state)
        val strategy = Js.str(Js.or(summaryStrategy, Js.or(state["summaryStrategy"], "semantic")))
        val turns = splitTurns(history ?: emptyList())
        var prefixChanged = false; var summaryCreated = false; var summaryFailed = false; var summaryQuality: Double? = null; var earlyCompressed = false
        fun summaries(): JArr = state["summaries"].a()!!
        if (turns.size < state["cut"].d()) { state["cut"] = 0.0; state["summaries"] = mutableListOf<Any?>(); prefixChanged = true }
        run {
            var i = 0
            while (i < summaries().size) {
                val s0 = summaries()[i] as JObj
                if (!batchValid(s0, Js.slice(turns, s0["from"].i(), s0["to"].i()))) {
                    state["summaries"] = Js.slice(summaries(), 0, i); state["cut"] = if (i != 0) summaries()[i - 1]["to"] else 0.0; prefixChanged = true; break
                }
                i++
            }
        }
        var temporaryFallback: JObj? = null
        val ttlEff = if (ttlEff0 != null) ttlEff0.d() else TTL_EFF_DEFAULT.toDouble()
        val idleSec: Double? = idleSec0?.d()
        val strat = if (strategy == "fast_local") "fast_local" else "semantic"
        while (true) {
            val cut = state["cut"].d()
            val raw = turns.size - cut
            val force = raw >= HARD
            val early = raw >= SOFT && idleSec != null && idleSec > ttlEff
            if (!force && !early) break
            if (early && !force) earlyCompressed = true
            val from = cut.toInt(); val to = from + (RAW_MAX - RAW_MIN); val batch = Js.slice(turns, from, to)
            val text = summarizeTurns(batch, from, strat)
            val quality = scoreHybridSummary(text, batch)
            summaryQuality = quality
            if (quality >= HYBRID_SUMMARY_MIN_QUALITY) {
                summaries() += jobj("from" to from, "to" to to, "fp" to batchFp(batch), "text" to text, "at" to localDate(), "quality" to quality, "strategy" to strat, "sourceFp" to batchFp(batch), "permanent" to true)
                state["cut"] = to.toDouble(); summaryCreated = true; prefixChanged = true
            } else {
                val fallback = summarizeTurns(batch, from, "fast_local")
                val q2 = scoreHybridSummary(fallback, batch)
                temporaryFallback = jobj("from" to from, "to" to to, "text" to fallback, "quality" to q2, "strategy" to "fast_local", "permanent" to false)
                summaryFailed = true
                break
            }
        }
        var summaryMerged = false
        if (summaryCreated) {
            while (summaries().size >= SUM_MERGE_K && sumLen(summaries()) > SUM_CAP) {
                val m = mergeSummaries(summaries(), turns); val old = sumLen(summaries().take(SUM_MERGE_K))
                if (m["text"].jstr().length >= old) break
                state["summaries"] = (listOf<Any?>(m) + Js.slice(summaries(), SUM_MERGE_K)).toMutableList(); summaryMerged = true
            }
        }
        val cut = state["cut"].i()
        val raw = Js.slice(turns, cut).flatten()
        val out: List<Any?> = if (summaries().isNotEmpty()) listOf<Any?>(jobj("role" to "system", "content" to SUM_HEAD + "\n" + summaries().joinToString("\n") { it["text"].jstr() })) + raw else raw
        val rawTurns = turns.size - cut
        var messagesForRequest = out
        if (summaryFailed && temporaryFallback != null && temporaryFallback["text"].truthy()) {
            val parts = summaries().map { it["text"].jstr() } + temporaryFallback["text"].jstr()
            val tmpRaw = Js.slice(turns, temporaryFallback["to"].i()).flatten()
            messagesForRequest = listOf<Any?>(jobj("role" to "system", "content" to SUM_HEAD + "\n" + parts.joinToString("\n"))) + tmpRaw
        }
        return jobj("messagesForRequest" to messagesForRequest.toMutableList(), "state" to state, "prefixChanged" to prefixChanged, "summaryCreated" to summaryCreated,
            "summaryMerged" to summaryMerged, "summaryFailed" to summaryFailed, "summaryQuality" to summaryQuality, "temporaryFallback" to temporaryFallback,
            "earlyCompressed" to earlyCompressed, "rawTurns" to rawTurns, "totalTurns" to turns.size, "untilNext" to HARD - rawTurns)
    }
    fun sentKey(id: Any?, ord: Int?): String? = if (id != null && id != "") "i:" + Js.str(id) else if (ord != null) "u#$ord" else null
    fun hwRecordSent(state: JObj, key: String?, original: Any?, sent: Any?) {
        if (key == null || original !is String) return
        val st = state["sent"].o() ?: JObj().also { state["sent"] = it }
        st.remove(key)
        if (original == sent) return
        st[key] = jobj("h" to sha(original), "n" to original.length, "sent" to sent)
        val ks = Js.keys(st); if (ks.size > HW_SENT_MAX) ks.take(ks.size - HW_SENT_MAX).forEach { st.remove(it) }
    }
    fun hwOutbound(state: JObj, m: Any?, key: String?): Any? {
        val content = m["content"]
        if (m["role"] != "user" || content !is String || key == null) return m
        val r = state["sent"][key]
        if (r == null || r !is Map<*, *> || r["n"].d() != content.length.toDouble() || r["h"] != sha(content)) return m
        val o = OrigMsg(m as Map<String, Any?>, content); o["content"] = r["sent"]; return o
    }
    fun hwMigrateSent(state: JObj) { val o = state["sent"].o() ?: JObj(); o.keys.toList().forEach { k -> val v = o[k]; if (!v.truthy() || v !is Map<*, *>) o.remove(k) }; state["sent"] = o }

    // ───────── 诊断 ─────────
    fun rollingRate(samples: List<Any?>?): Double? {
        val k = (samples ?: emptyList()).filter { it.truthy() && it["known"].truthy() }
        if (k.isEmpty()) return null
        val p = k.sumOf { it["prompt"].d() }; val h = k.sumOf { it["hit"].d() }
        return if (p != 0.0 && !p.isNaN()) Js.round(h / p * 100) else null
    }
    fun diagnose(stat: Any?): JObj {
        val rate = rollingRate(stat["roll"].a()); val issues = mutableListOf<Any?>()
        if (rate == null) return jobj("level" to "unknown", "rate" to null, "issues" to mutableListOf<Any?>("尚无带缓存字段的 usage，命中率未知（服务商未返回 cached_tokens）"))
        if (rate >= DIAG_GOOD) return jobj("level" to "good", "rate" to rate, "issues" to issues)
        if (rate >= DIAG_LOW) return jobj("level" to "ok", "rate" to rate, "issues" to issues)
        val h = stat["hist"].a() ?: mutableListOf()
        fun ch(key: String): Boolean { val v = h.map { it[key] }; return v.indices.any { i -> i != 0 && !jsStrictEq(v[i], v[i - 1]) } }
        if (ch("static_hash")) issues += "固定层 static_hash 发生过变化：设定里有随机/时间/频繁修改的内容，应移到动态层（【当前状态】等）"
        if (ch("prefix_hash") && !ch("static_hash")) issues += "前缀哈希变化（合并后的 system 有改动）"
        if (ch("model")) issues += "请求间切换过模型，缓存按模型隔离"
        if (ch("provider")) issues += "provider 路由偏好变化，可能被分到不同供应商"
        if (ch("session_id")) issues += "session_id 不稳定"
        if (h.isNotEmpty() && !h.last()["session_id"].truthy()) issues += "未发送 session_id，OpenRouter 只能在命中后才 sticky"
        for (i in 1 until h.size) if (h[i]["t"].d() - h[i - 1]["t"].d() > 5 * 60 * 1000) { issues += "请求间隔超过 5 分钟，隐式缓存可能已过期（sticky 会话 10 分钟失效）"; break }
        if (h.isNotEmpty() && h.last()["tokens"].d() < 1024) issues += "固定前缀较短（约 " + Js.str(h.last()["tokens"]) + " Token），低于 Gemini 缓存门槛，命中率低属正常"
        if (h.isNotEmpty()) { val last = h.last(); flashLitePrefixNote(last["model"], last["tokens"])?.let { issues += it } }
        val ha = stat["hitAttr"]
        if (ha.truthy() && ha["text"].truthy()) issues += ha["text"]
        if (stat["lastDiff"].truthy()) issues += "最近前缀变化位置 #" + Js.str(stat["lastDiff"]["pos"]) + (if (ha.truthy() && ha["code"] == "prefix_broken") "（firstDiff）" else "")
        if (issues.isEmpty()) issues += "未发现明显原因：可能是供应商侧缓存未命中或刚写入"
        return jobj("level" to "low", "rate" to rate, "issues" to issues)
    }
    /** === （值模型下：数字按值、字符串按值、对象按引用） */
    fun jsStrictEq(a: Any?, b: Any?): Boolean = when {
        a == null || b == null -> a == null && b == null
        a is Double && b is Double -> a == b && !a.isNaN()
        a is String || a is Boolean -> a == b
        else -> a === b
    }

    /**
     * applyToRequest(req, cfg, extra)：req = { url, headers, body(string) }。
     * extra：adapter / sessionId / rp / prevStaticHash / hybrid（原地更新）/ ids / idleSec / ttlEff / segments / cacheStats
     */
    fun applyToRequest(req: JObj, cfg0: Map<String, Any?>?, extra0: Map<String, Any?>?): JObj {
        val cfg = Js.assign(DEFAULTS, cfg0 ?: JObj()); val extra = extra0 ?: JObj()
        val adapter = Js.str(Js.or(extra["adapter"], Js.or(cfg["cacheAdapter"], "openrouter")))
        val full = cacheAdapterFull(adapter)
        val body: JObj = try { Js.parse(req["body"].jstr()) as? JObj ?: return jobj("req" to req, "applied" to null, "prefix" to "") } catch (e: Exception) { return jobj("req" to req, "applied" to null, "prefix" to "") }
        val headers = Js.assign(req["headers"].o())
        if (full && cfg["responseCache"].truthy()) headers["X-OpenRouter-Cache"] = "true"
        val msgs: JArr = body["messages"].a() ?: mutableListOf()
        var applied: JObj? = null; var k = 0
        val src = extra["ids"].a() ?: mutableListOf()
        val ids: MutableList<Any?> = msgs.indices.map { i -> val j = i - (msgs.size - src.size); if (j >= 0) src[j] else null }.toMutableList()
        while (k < msgs.size && msgs[k]["role"] == "system") k++
        if (k > 1 && cfg["mergeSystem"].truthy() && msgs.take(k).all { it["content"] is String }) {
            val merged = jobj("role" to "system", "content" to msgs.take(k).map { it["content"] as String }.filter { it.isNotEmpty() }.joinToString("\n\n"))
            repeat(k) { msgs.removeAt(0) }; msgs.add(0, merged)
            repeat(k) { ids.removeAt(0) }; ids.add(0, null); k = 1
        }
        val g = cfg["rpGuardrails"]
        val guard = g == "on" || g == true || (g == "auto" && extra["rp"].truthy())
        if (guard && g != "off") {
            if (k > 0 && msgs[0]["content"] is String) { val c0 = msgs[0]["content"] as String; if (c0.indexOf(RP_ANCHOR) < 0) (msgs[0] as JObj)["content"] = RP_ANCHOR + "\n\n" + c0 }
            else if (k == 0) { msgs.add(0, jobj("role" to "system", "content" to RP_ANCHOR)); ids.add(0, null); k = 1 }
        }
        var hybrid: JObj? = null
        val stH = extra["hybrid"].o()
        if (stH != null && cfg["hybrid"] != false) {
            val st = stH
            for (i in 0 until k) { val c = msgs[i]["content"]; if (c is String) (msgs[i] as JObj)["content"] = normalizeDates(c) }
            var lastUser = msgs.size - 1; if (lastUser < k || msgs[lastUser]["role"] != "user") lastUser = -1
            var dyn = ""
            if (k == 1 && msgs[0]["content"] is String) {
                val la = analyzeLayers(msgs[0]["content"])
                if (la["dynamicText"].truthy() && lastUser > 0) {
                    dyn = la["dynamicText"].jstr()
                    (msgs[0] as JObj)["content"] = Js.replace(Js.re("\\s+$"), la["blocks"].a()!!.filter { it["kind"] == "static" }.joinToString("\n") { it["text"].jstr() }, false, "")
                }
            }
            val tail = if (lastUser > 0) msgs[lastUser] else null
            var ord = 0
            val histSrc = Js.slice(msgs, k, if (lastUser > 0) lastUser else msgs.size)
            val hist = histSrc.mapIndexed { i, m -> hwOutbound(st, m, if (m["role"] == "user") sentKey(ids.getOrNull(k + i), ord++) else null) }
            val w = hwApply(hist, st, Js.or(cfg["summaryStrategy"], "semantic"), extra["idleSec"], if (extra["ttlEff"] != null) extra["ttlEff"] else TTL_EFF_DEFAULT.toDouble())
            var sentUser: Any? = null
            if (tail != null) {
                val orig = tail["content"]
                if (orig is String) {
                    val su = Js.assign(tail as Map<String, Any?>); su["content"] = if (dyn.isNotEmpty()) Js.replace(Js.re("\\s+$"), dyn, false, "") + "\n\n" + orig else orig
                    sentUser = su; hwRecordSent(st, sentKey(ids.getOrNull(lastUser), ord), orig, su["content"])
                } else sentUser = tail
            }
            while (msgs.size > k) msgs.removeAt(msgs.size - 1)
            msgs.addAll(w["messagesForRequest"].a()!! + (if (sentUser != null) listOf(sentUser) else emptyList()))
            hybrid = jobj("prefixChanged" to w["prefixChanged"], "summaryCreated" to w["summaryCreated"], "earlyCompressed" to w["earlyCompressed"].truthy(), "rawTurns" to w["rawTurns"],
                "totalTurns" to w["totalTurns"], "untilNext" to w["untilNext"], "summaries" to st["summaries"].a()!!.size, "movedDynamic" to dyn.isNotEmpty())
        }
        val prefix = msgs.take(k).joinToString("\n\u0000\n") { partsText(it["content"]) }
        val layers = if (extra["segments"].truthy()) layersFromSegments(prefix, extra["segments"]) else analyzeLayers(prefix)
        var lastU = -1; for (i in msgs.indices.reversed()) if (msgs[i]["role"] == "user") { lastU = i; break }
        val autoHist = cfg["mode"] == "auto" && hybrid != null && cfg["autoTarget"] != "prefix" && lastU > k
        val decision = if (autoHist)
            decideHistory(cfg, jobj("model" to body["model"], "cacheText" to msgs.take(lastU).joinToString("\n") { partsText(it["content"]) }, "static_hash" to layers["static_hash"], "prevStaticHash" to extra["prevStaticHash"], "cacheStats" to extra["cacheStats"]))
        else decide(cfg, jobj("model" to body["model"], "staticText" to if (layers["dynamicText"].truthy()) layers["staticText"] else prefix, "static_hash" to layers["static_hash"], "prevStaticHash" to extra["prevStaticHash"], "cacheStats" to extra["cacheStats"]))
        if (full && cfg["mode"] != "off" && msgs.isNotEmpty()) {
            msgs.forEach { stripCC(it as JObj) }
            if (decision["explicit"].truthy()) {
                var target = -1
                if (cfg["mode"] == "history" || decision["history"].truthy()) {
                    var lu = -1; for (i in msgs.indices.reversed()) if (msgs[i]["role"] == "user") { lu = i; break }
                    for (i in (if (lu > 0) lu else msgs.size) - 1 downTo 0) if (hasText(msgs[i]["content"])) { target = i; break }
                }
                if (target < 0 && cfg["mode"] == "auto" && k == 1 && msgs[0]["content"] is String && layers["dynamicText"].truthy() && layers["ordered"].truthy()) {
                    val c = msgs[0]["content"] as String
                    val cut = c.indexOf(layers["blocks"].a()!!.first { it["kind"] == "dynamic" }["text"].jstr())
                    if (cut > 0) {
                        val cc = jobj("type" to "ephemeral"); if (cfg["ttl"].truthy()) cc["ttl"] = cfg["ttl"]
                        (msgs[0] as JObj)["content"] = mutableListOf<Any?>(jobj("type" to "text", "text" to c.substring(0, cut), "cache_control" to cc), jobj("type" to "text", "text" to c.substring(cut)))
                        applied = jobj("index" to 0, "mode" to "auto", "split" to true)
                    }
                }
                if (applied == null) {
                    if (target < 0 && k > 0) target = k - 1
                    if (target >= 0 && addBreakpoint(msgs[target] as JObj, if (cfg["ttl"].truthy()) cfg["ttl"] else null)) { applied = jobj("index" to target, "mode" to cfg["mode"]); if (decision["history"].truthy()) applied["history"] = true }
                }
            }
        }
        body["messages"] = msgs
        val sid = if (full && cfg["sessionId"] != false && extra["sessionId"].truthy()) Js.str(extra["sessionId"]) else ""
        if (sid.isNotEmpty()) applySession(body, sid)
        val route = routeOf(body)
        val outReq = Js.assign(req); outReq["headers"] = headers; outReq["body"] = Js.stringify(body)
        return jobj("req" to outReq, "applied" to applied, "prefix" to prefix, "layers" to layers, "decision" to decision, "session_id" to Js.or(body["session_id"], ""),
            "route" to route, "hybrid" to hybrid, "adapter" to adapter)
    }

    fun usageInfo(u: Map<String, Any?>?): JObj? = CacheCommonImpl.usageInfo(u)
    fun usageText(i: Any?): String {
        if (i["known"] == false) return "Gemini 缓存命中未知（服务商未返回 cached_tokens；输入 " + Js.str(i["prompt"]) + " Token）"
        val w = i["write"]
        return if (i["hit"].truthy()) "Gemini 缓存命中 " + Js.str(i["hit"]) + "/" + Js.str(i["prompt"]) + " Token（" + Js.str(i["pct"]) + "%）" + (if (w.truthy()) "，写入 " + Js.str(w) else "")
        else "Gemini 缓存未命中（输入 " + Js.str(i["prompt"]) + " Token" + (if (w.truthy()) "，写入 " + Js.str(w) else "") + "）"
    }
    fun estimateCost(i: Map<String, Any?>?, price: Map<String, Any?>?): JObj? = CacheCommonImpl.estimateCost(i, Js.assign(PRICE, price))

    // ───────── KeepAlive ─────────
    fun pingsForGap(gap: Double, interval: Double, maxP: Double, ttl: Double?): Double {
        if (ttl != null && gap <= ttl) return 0.0
        if (!(interval > 0) || gap <= interval) return 0.0
        val n = ceil(gap / interval) - 1
        return if (n > maxP) 0.0 else n
    }
    fun netForGap(gap: Double, ttl: Double, interval: Double, maxP: Double, read0: Double?): Double {
        val read = read0 ?: 0.25
        if (gap <= ttl || !(interval > 0)) return 0.0
        val n = ceil(gap / interval) - 1
        if (n > maxP) return 0.0
        return (1 - read) * 1 - read * n
    }
    fun keepaliveRecommend(gaps0: List<Any?>?, ttl: Double, interval: Double, maxP: Double, read: Double?): JObj {
        val gaps = (gaps0 ?: emptyList()).map { it.d() }.filter { it > 0 }
        if (gaps.isEmpty()) return jobj("samples" to 0, "median" to null, "net" to 0, "enable" to false, "overTtl" to 0)
        val net = gaps.fold(0.0) { a, g -> a + netForGap(g, ttl, interval, maxP, read) } / gaps.size
        val so = gaps.sorted(); val mid = so.size shr 1
        val median = if (so.size % 2 == 1) so[mid] else (so[mid - 1] + so[mid]) / 2
        return jobj("samples" to gaps.size, "median" to Js.round(median * 10) / 10, "net" to Js.round(net * 10000) / 10000, "enable" to (net > 0), "overTtl" to gaps.count { it > ttl })
    }
    fun ttlSec(cfg: Any?): Int = if (cfg.truthy() && cfg["ttl"] == "1h") 3600 else 300

    fun lcpLen(a: Any?, b: Any?): Int = CacheCommonImpl.lcpLen(Js.strOrEmpty(a), Js.strOrEmpty(b))
    fun lcpRatio(prev: Any?, cur0: Any?): Double { val cur = Js.strOrEmpty(cur0); if (cur.isEmpty()) return 0.0; return lcpLen(prev, cur).toDouble() / cur.length }

    fun attributeCacheHit(o: Any?): JObj {
        val expected = o["expected"]?.d(); val actual = o["actual"]?.d(); val gap = o["gapSec"]?.d(); val compressed = o["compressed"].truthy()
        val ttlEff = if (o["ttlEff"] != null) o["ttlEff"].d() else TTL_EFF_DEFAULT.toDouble()
        val ttlS = Js.numToString(ttlEff)
        if (expected == null || actual == null) return jobj("code" to "unknown", "text" to null, "shouldHit" to false)
        if (expected < 0.5 && compressed) return jobj("code" to "normal_compress", "text" to "正常（压缩轮预期 miss：LCP 占比 " + Js.toFixed(expected * 100, 0) + "%）", "shouldHit" to false)
        if (expected < 0.8 && !compressed) return jobj("code" to "prefix_broken", "text" to "客户端前缀被破坏（LCP 占比 " + Js.toFixed(expected * 100, 0) + "% < 80%）：请用 firstDiff 定位第 k 条消息 / 哪一层", "shouldHit" to false)
        val shouldHit = expected >= 0.9 && (gap == null || gap < ttlEff)
        if (expected >= 0.9 && actual < 0.3) {
            if (gap != null && gap >= ttlEff) return jobj("code" to "ttl_expired", "text" to "TTL 过期（正常：间隔 " + Js.numToString(Js.round(gap)) + "s ≥ TTL_eff " + ttlS + "s）", "shouldHit" to false)
            return jobj("code" to "provider_miss", "text" to "服务商侧未命中（路由/驱逐/门槛；LCP≥90% 且间隔在 TTL 内，实际命中 " + Js.toFixed(actual * 100, 0) + "%）", "shouldHit" to true)
        }
        return jobj("code" to if (shouldHit) "expect_hit" else "observe", "text" to null, "shouldHit" to shouldHit)
    }
    fun expectedHit(prev: Any?, cur: Any?, ttl: Double?): Boolean {
        if (!prev.truthy() || !cur.truthy()) return false
        val expected = if (cur["lcpRatio"] != null) cur["lcpRatio"].d() else if (prev["body"] != null && cur["body"] != null) lcpRatio(prev["body"], cur["body"]) else null
        if (expected == null) return false
        val ttlEff = ttl ?: TTL_EFF_DEFAULT.toDouble()
        return expected >= 0.9 && (cur["t"].d() - prev["t"].d()) < ttlEff * 1000
    }
    fun isRpConv(conv: Any?, rpActive: Boolean): Boolean {
        if (rpActive) return true
        val d = conv["plugins"]["rpcache"]
        val st = d["state"]
        if (st is Map<*, *> && st.keys.any { Js.test(Js.re("world|character|layers|fields"), it.toString()) }) return true
        return conv.truthy() && analyzeLayers(Js.or(conv["systemPrompt"], ""))["layered"] == true
    }
}
