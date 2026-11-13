package com.aichat.app.plugins.affect

import com.aichat.app.plugins.cache.GCache
import com.aichat.app.plugins.js.*
import java.time.Instant
import java.time.ZoneId
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * www/affect.js 纯逻辑移植（A6 好感 / 心情：协议解析、护栏、词典观测、一维卡尔曼 + CUSUM 五档、legacy 路径、多角色混合）。
 * 状态沿用 JS 值模型（bot.affect 原样存 Message.extras["affect"]）。本地自然日按 [zone]（设备时区）计。
 */
object Affect {
    var zone: ZoneId = ZoneId.systemDefault()

    const val BASE_AFF = 0.30
    const val AFF_HALF_LIFE = 3.0 * 86400; const val MOOD_HALF_LIFE = 3600.0
    const val AFF_HALF_LIFE_TURN = 300.0; const val MOOD_HALF_LIFE_TURN = 8.0
    val BASE_VEC: JObj get() = jobj("val" to 0.0, "aro" to 0.20)
    val DELTA = mapOf("-2" to -0.12, "-1" to -0.05, "0" to 0.0, "1" to 0.04, "2" to 0.08)
    const val NEG_MULT = 1.25; const val DAILY_GAIN_CAP = 0.15; const val INERTIA = 0.5; const val HYS = 0.12
    val TIER_TH = listOf(0.15, 0.35, 0.55, 0.75)
    val TIER_LABELS = mapOf(1 to "疏远", 2 to "戒备", 3 to "熟悉", 4 to "亲近", 5 to "亲密")
    val MOODS = listOf("平静", "开心", "兴奋", "害羞", "不悦", "低落", "愤怒")
    val TARGET: Map<String, Pair<Double, Double>> = mapOf("平静" to (0.0 to 0.20), "开心" to (0.6 to 0.45), "兴奋" to (0.7 to 0.85), "害羞" to (0.3 to 0.6),
        "不悦" to (-0.4 to 0.5), "低落" to (-0.6 to 0.15), "愤怒" to (-0.75 to 0.9))
    val NEG_MOODS = listOf("不悦", "低落", "愤怒")
    const val MISS_WINDOW = 10; const val MISS_THRESHOLD = 3; const val DEMO_K = 3
    const val STRONG_REMIND = "[AFFECT_REMIND] 必须在回复末尾单独一行输出 <state>{\"a\":-2..2整数,\"m\":心情,\"why\":依据}</state>，勿漏标。"
    private val RX_BOUNDARY get() = Js.re("(脱光|裸照|发.{0,3}(裸|色)图|约炮|强奸|nude|nsfw)", "i")
    private val RX_ABUSE get() = Js.re("(滚|闭嘴|傻[逼比Bb]|\\bsb\\b|蠢货|白痴|废物|去死|垃圾|弱智|脑残|shut up|stupid|idiot|fuck)", "i")
    private val RX_PRAISE get() = Js.re("(谢谢|感谢|你真(好|棒|厉害|可爱|聪明|美|贴心)|好可爱|喜欢你|爱你|太棒了|你最好|抱抱|亲亲|想你|love you|thank|you'?re (great|amazing|cute|sweet))", "i")
    const val WHY_TH = 0.3
    const val KF_Q = 0.04; const val KF_R = 0.30; const val KF_W = 0.65; const val KF_W_WHY = 0.75; const val KF_W_INCONSISTENT = 0.7
    const val CUSUM_K_UP = 0.15; const val CUSUM_K_DN = -0.15; const val CUSUM_H_UP = 0.45; const val CUSUM_H_DN = 0.45; const val CUSUM_D = 4
    const val CHAR_SELF_W = 0.70; const val CHAR_SCENE_W = 0.30
    const val VEC_KF_ALPHA = 0.35; const val VEC_KF_G_MIN = 0.25; const val VEC_KF_G_MAX = 0.65
    val LEX_POS = listOf("谢谢", "感谢", "喜欢", "爱你", "真棒", "厉害", "可爱", "开心", "高兴", "棒", "贴心", "抱抱", "亲亲", "想你", "优秀", "温柔", "thank", "love", "great", "amazing", "cute", "sweet", "nice")
    val LEX_NEG = listOf("滚", "闭嘴", "讨厌", "恨", "烦", "蠢", "白痴", "废物", "垃圾", "去死", "恶心", "失望", "分手", "生气", "伤心", "难过", "恨你", "stupid", "idiot", "hate", "fuck", "shut")
    val LEX_NEGATE = listOf("并非", "不是", "没有", "不要", "别再", "绝不", "毫无", "不", "没", "别", "未", "勿")
    val LEX_DEGREE = linkedMapOf("很" to 1.5, "太" to 1.6, "非常" to 1.7, "超级" to 1.8, "极其" to 1.8, "特别" to 1.5, "真" to 1.3, "有点" to 0.6, "有些" to 0.6, "稍" to 0.5, "略" to 0.5, "比较" to 0.8,
        "so" to 1.4, "very" to 1.5, "really" to 1.4, "extremely" to 1.8, "slightly" to 0.5)
    private val DEG_KEYS = LEX_DEGREE.keys.sortedByDescending { it.length }   // Array.prototype.sort 稳定，同长保持插入序
    private val RX_CARE get() = Js.re("(担心你|我担心|抱歉|对不起|不好意思|想你|抱抱|亲亲|心疼|照顾|爱你|安慰|别难过|没事的|我在|陪伴)")
    private val RX_REBUKE get() = Js.re("(滚开|闭嘴|讨厌你|恶心|无聊透|失望透顶|分手吧|你滚|别烦我|受够了|恨你)")
    val MODES = listOf("normal", "dark", "nsfw")

    // ── 工具 ──
    fun clamp(x: Double, lo: Double, hi: Double) = maxOf(lo, minOf(hi, x))
    fun r4(x: Double) = Js.round(x * 1e4) / 1e4
    private fun dk(b: Double, v: Double, hl: Double, dt: Double) = if (dt <= 0) v else b + (v - b) * 0.5.pow(dt / hl)
    fun dayKey(ms: Double): String { val d = Instant.ofEpochMilli(ms.toLong()).atZone(zone); return d.year.toString() + "-" + Js.padStart(d.monthValue.toString(), 2, '0') + "-" + Js.padStart(d.dayOfMonth.toString(), 2, '0') }
    fun tier(aff: Double): Int { var t = 1; TIER_TH.forEach { if (aff >= it) t++ }; return t }
    fun tierLabel(t: Any?): String = TIER_LABELS[(t as? Number)?.toDouble()?.let { if (it == floor(it)) it.toInt() else -1 }] ?: TIER_LABELS[1]!!
    fun relationOf(st: Any?): String = tierLabel(if (Js.truthy(st?.let { it["cusum"] }?.let { it["tier"] })) st["cusum"]["tier"] else tier(if (st?.let { it["aff"] } != null) st["aff"].d() else BASE_AFF).toDouble())
    private fun vv(v: Any?) = v["val"].d(); private fun va(v: Any?) = v["aro"].d()
    private fun dist(v: Any?, m: String) = hypot(vv(v) - TARGET[m]!!.first, va(v) - TARGET[m]!!.second)
    fun classify(vec: Any?, prev: Any?): String {
        var best = MOODS[0]; MOODS.forEach { m -> if (dist(vec, m) < dist(vec, best)) best = m }
        if (Js.truthy(prev) && prev is String && TARGET.containsKey(prev) && prev != best && dist(vec, prev) - dist(vec, best) <= HYS) return prev
        return best
    }
    private fun tgOf(m: Any?): JObj = (m as? String)?.let { TARGET[it] }?.let { jobj("val" to it.first, "aro" to it.second) } ?: BASE_VEC
    private fun has(o: Any?, k: String) = (o as? Map<*, *>)?.let { it.containsKey(k) && it[k] != null && it[k] !== Undefined } == true

    fun baseState(now: Double, opts: Any?): JObj {
        val s = jobj("v" to 1, "aff" to BASE_AFF, "vec" to BASE_VEC, "mood" to "平静", "ts" to now)
        if (opts?.let { it["clock"] } == "turn") s["turn"] = if (has(opts, "turn")) opts["turn"] else 0.0
        return s
    }
    fun decay(st: Any?, now: Double, opts: Any?): JObj {
        val clock = if (opts?.let { it["clock"] } == "turn") "turn" else "wall"
        if (st == null || !Js.truthy(st)) return baseState(now, jobj("clock" to clock, "turn" to opts?.let { it["turn"] }))
        val vec0 = st["vec"]
        if (clock == "turn") {
            val turnNow = if (has(opts, "turn")) opts["turn"].d() else if (has(st, "turn")) st["turn"].d() else 0.0
            val dt = maxOf(0.0, turnNow - (if (has(st, "turn")) st["turn"].d() else turnNow))
            val vec = jobj("val" to r4(dk(0.0, if (Js.truthy(vec0)) vv(vec0) else 0.0, MOOD_HALF_LIFE_TURN, dt)), "aro" to r4(dk(0.20, if (Js.truthy(vec0)) va(vec0) else 0.20, MOOD_HALF_LIFE_TURN, dt)))
            val o = Js.assign(st as Map<String, Any?>)
            o["aff"] = r4(dk(BASE_AFF, if (st["aff"] == null) BASE_AFF else st["aff"].d(), AFF_HALF_LIFE_TURN, dt)); o["vec"] = vec; o["mood"] = classify(vec, st["mood"]); o["ts"] = now; o["turn"] = turnNow
            return o
        }
        val dt = maxOf(0.0, (now - Js.toNumber(Js.or(st["ts"], now))) / 1000)
        val vec = jobj("val" to r4(dk(0.0, if (Js.truthy(vec0)) vv(vec0) else 0.0, MOOD_HALF_LIFE, dt)), "aro" to r4(dk(0.20, if (Js.truthy(vec0)) va(vec0) else 0.20, MOOD_HALF_LIFE, dt)))
        @Suppress("UNCHECKED_CAST") val o = Js.assign(st as Map<String, Any?>)
        o["aff"] = r4(dk(BASE_AFF, if (st["aff"] == null) BASE_AFF else st["aff"].d(), AFF_HALF_LIFE, dt)); o["vec"] = vec; o["mood"] = classify(vec, st["mood"]); o["ts"] = now
        return o
    }

    // ── 协议解析 / 剥离 ──
    private val STATE_RX get() = Js.re("<state>\\s*([\\s\\S]*?)\\s*<\\/state>", "gi")
    fun parseState(text: Any?): JObj? {
        val t = if (Js.truthy(text)) Js.str(text) else ""
        var last: String? = null
        STATE_RX.findAll(t).forEach { last = it.groupValues[1] }   // 模式里没有 . 和按码元区分的字符类，直接匹配即可
        val l = last ?: return null
        val o = try { JsJson.parse(l) } catch (_: JsSyntaxError) { return null }
        if (o !is Map<*, *> && o !is List<*>) return null
        val an = if (o is Map<*, *> && o.containsKey("a")) Js.toNumber(o["a"]) else Double.NaN
        val a = Js.round(an)
        if (!a.isFinite()) return null
        val m = o["m"]
        val r = jobj("a" to clamp(a, -2.0, 2.0), "m" to if (m is String && m in MOODS) m else null)
        val why = o["why"]
        if (why is String && Js.trim(why).isNotEmpty()) r["why"] = Js.slice(Js.trim(why), 0, 80)
        return r
    }
    fun stripState(text: Any?): Any? {
        if (text !is String || (!text.contains("<state") && !text.contains("</state>"))) return text
        var s = Js.replace(STATE_RX, text, true, "")
        s = Js.replace(Js.re("<state>[\\s\\S]*$", "i"), s, false, "")
        s = Js.replace(Js.re("<\\/state>", "gi"), s, true, "")
        return Js.trimEnd(s)
    }

    // ── A1 证据锚 ──
    private fun isPS(cp: Int): Boolean = when (Character.getType(cp).toByte()) {
        Character.CONNECTOR_PUNCTUATION, Character.DASH_PUNCTUATION, Character.START_PUNCTUATION, Character.END_PUNCTUATION, Character.INITIAL_QUOTE_PUNCTUATION,
        Character.FINAL_QUOTE_PUNCTUATION, Character.OTHER_PUNCTUATION, Character.MATH_SYMBOL, Character.CURRENCY_SYMBOL, Character.MODIFIER_SYMBOL, Character.OTHER_SYMBOL -> true
        else -> false
    }
    fun grams(t: Any?): Set<String> {
        val src = (if (Js.truthy(t)) Js.str(t) else "").lowercase(java.util.Locale.ROOT)
        val sb = StringBuilder(); var i = 0
        while (i < src.length) { val cp = src.codePointAt(i); val n = Character.charCount(cp); if (!(n == 1 && Js.isWs(src[i])) && !isPS(cp)) sb.append(src, i, i + n); i += n }
        val x = sb.toString(); val g = LinkedHashSet<String>()
        if (x.length == 1) g += x
        var k = 0; while (k + 1 < x.length) { g += x.substring(k, k + 2); k++ }
        return g
    }
    fun jaccard(a: Any?, b: Any?): Double {
        val A = grams(a); val B = grams(b); if (A.isEmpty() || B.isEmpty()) return 0.0
        var n = 0; A.forEach { if (it in B) n++ }
        return r4(maxOf(n.toDouble() / (A.size + B.size - n), n.toDouble() / A.size * 0.8))
    }

    // ── 护栏 ──
    fun directText(u: Any?): String {
        val s = Js.replace(Js.re("「[^」]*」|『[^』]*』|“[^”]*”|\"[^\"]*\"|‘[^’]*’|《[^》]*》|\\*[^*\\n]+\\*|（[^）]*）|\\([^)]*\\)|【[^】]*】", "g"), if (Js.truthy(u)) Js.str(u) else "", true, " ")
        return s.split("\n").filter { !Js.test(Js.re("^\\s*>"), it) }.joinToString("\n")
    }
    private fun hitLevel(rx: Regex, u: String): String? { if (!Js.test(rx, u)) return null; return if (!Js.test(rx, directText(u))) "story" else "direct" }
    fun modeOf(conv: Any?): String {
        if (!Js.truthy(conv)) return "normal"
        val am = conv["affectMode"]; if (am is String && am in MODES) return am
        val tags = ArrayList<Any?>()
        fun add(v: Any?) { if (v is List<*>) tags.addAll(v) else if (v != null) tags.add(v) }
        add(Js.or(conv["tags"], ArrayList<Any?>())); add(Js.or(conv["personaTags"], ArrayList<Any?>())); add(Js.or(conv["charCard"]?.let { it["tags"] }, ArrayList<Any?>()))
        val ts = tags.map { Js.str(it).lowercase(java.util.Locale.ROOT) }
        if (ts.any { Js.test(Js.re("nsfw|r18|18\\+"), it) }) return "nsfw"
        if (ts.any { Js.test(Js.re("dark|黑暗|致郁|暗黑"), it) }) return "dark"
        return "normal"
    }
    /** 时钟：conv.affectClock 显式；GCache.isRpConv（旧版 root.GeminiCache）或 rpcache 生效 → turn；否则 wall */
    fun clockOf(conv: Any?, meta: Any?): String {
        val ac = conv?.let { it["affectClock"] }; if (Js.truthy(conv) && (ac == "wall" || ac == "turn")) return ac as String
        val rpActive = Js.truthy(meta?.let { it["rp"] }) && !Js.truthy(meta["rp"]["skipped"])
        try { if (GCache.isRpConv(conv, rpActive)) return "turn" } catch (_: Throwable) {}
        if (rpActive) return "turn"
        if (Js.truthy(conv) && Js.truthy(conv["plugins"]) && (Js.truthy(conv["plugins"]["rpcache"]) || Js.truthy(conv["plugins"]["rp"]))) return "turn"
        return "wall"
    }

    fun guard(a0: Double, m0: Any?, userText: Any?, opts: Any?): JObj {
        var a = a0; var m = m0
        val u = if (Js.truthy(userText)) Js.str(userText) else ""; val hit: JArr = ArrayList()
        val mode = opts?.let { it["mode"] }.let { if (it is String && it in MODES) it else "normal" }
        val bd = hitLevel(RX_BOUNDARY, u); val ab = hitLevel(RX_ABUSE, u)
        val why = opts?.let { it["why"] }; val wj = if (Js.truthy(why)) jaccard(why, u) else 0.0
        val founded: Boolean? = if (Js.truthy(why)) wj >= WHY_TH else null
        if (bd == "direct" && mode == "normal") { a = -2.0; hit.add("boundary"); if (m !in NEG_MOODS) m = "愤怒" }
        else if (ab == "direct") {
            val soft = a >= 0 && !Js.truthy(opts?.let { it["missingState"] })
            if (soft) hit.add("abuse_soft")
            else if (mode == "dark") { if (a > 0) a = 0.0; hit.add("abuse_dark") }
            else { if (a > -1) a = -1.0; hit.add("abuse"); if (m !in NEG_MOODS) m = "不悦" }
        } else {
            if (bd == "story" || ab == "story") hit.add("story_ref")
            else if (bd == "direct") hit.add("boundary_$mode")
            if (a == 2.0 && !Js.test(RX_PRAISE, directText(u)) && founded != true) { a = 1.0; hit.add("a2_unfounded") }
            else if (a == -2.0 && founded == false) { a = -1.0; hit.add("why_weak") }
        }
        if (Js.truthy(why)) hit.add("why:" + Js.toFixed(wj, 2))
        return jobj("a" to a, "m" to m, "hit" to hit)
    }
    private fun forcedHit(h: List<Any?>) = h.any { it == "abuse" || it == "boundary" || it == "abuse_dark" || it == "boundary_dark" || it == "boundary_nsfw" }
    private fun optsWith(opts: Any?, vararg kv: Pair<String, Any?>): JObj { @Suppress("UNCHECKED_CAST") val o = Js.assign(opts as? Map<String, Any?>); kv.forEach { o[it.first] = it.second }; return o }
    private fun applyDelta(a: Double, s0aff: Double, net: Double): Double {
        var d = DELTA[Js.numToString(a)] ?: Double.NaN
        if (d > 0) { d *= (1 - s0aff) / (1 - BASE_AFF); d = maxOf(0.0, minOf(d, DAILY_GAIN_CAP - net)) } else if (d < 0) d *= NEG_MULT
        return d
    }
    private fun turnNowOf(clock: String, prev: Any?, opts: Any?): Double? = if (clock != "turn") null else if (has(opts, "turn")) opts["turn"].d() else (if (has(prev, "turn")) prev["turn"].d() else 0.0) + 1
    private fun netOf(prev: Any?, day: String) = if (Js.truthy(prev) && Js.truthy(prev["g"]) && prev["g"]["day"] == day) Js.toNumber(Js.or(prev["g"]["net"], 0.0)) else 0.0

    fun stepLegacy(prev: Any?, parsed: Any?, userText: Any?, now: Double, opts: Any?): JObj {
        val clock = if (opts?.let { it["clock"] } == "turn") "turn" else "wall"
        val turnNow = turnNowOf(clock, prev, opts)
        val s0 = decay(prev, now, jobj("clock" to clock, "turn" to turnNow))
        val day = dayKey(now); var net = netOf(prev, day)
        val s0aff = s0["aff"].d()
        if (parsed == null) {
            val gd = guard(0.0, null, userText, optsWith(opts, "why" to null, "missingState" to true))
            if (!forcedHit(gd["hit"] as List<*>)) {
                val out = jobj("v" to 1, "aff" to s0["aff"], "vec" to s0["vec"], "mood" to s0["mood"], "ts" to now, "a" to null, "m" to null, "g" to jobj("day" to day, "net" to net, "guard" to gd["hit"]), "p" to "missing_state", "stateMissing" to true)
                if (clock == "turn") out["turn"] = turnNow
                return out
            }
            val a = gd["a"].d(); val m = gd["m"]
            val aff = clamp(s0aff + applyDelta(a, s0aff, net), 0.0, 1.0); net = r4(net + (aff - s0aff))
            val tg = if (Js.truthy(m)) tgOf(m) else BASE_VEC
            val vec = jobj("val" to r4(vv(s0["vec"]) + INERTIA * (vv(tg) - vv(s0["vec"]))), "aro" to r4(va(s0["vec"]) + INERTIA * (va(tg) - va(s0["vec"]))))
            val out = jobj("v" to 1, "aff" to r4(aff), "vec" to vec, "mood" to classify(vec, s0["mood"]), "ts" to now, "a" to a, "m" to m, "g" to jobj("day" to day, "net" to net, "guard" to gd["hit"]), "p" to "missing_state+guard", "stateMissing" to true)
            if (clock == "turn") out["turn"] = turnNow
            return out
        }
        val gd = guard(parsed["a"].d(), parsed["m"], userText, optsWith(opts, "why" to parsed["why"]))
        val a = gd["a"].d(); val m = gd["m"]
        val aff = clamp(s0aff + applyDelta(a, s0aff, net), 0.0, 1.0); net = r4(net + (aff - s0aff))
        val tg = if (Js.truthy(m)) tgOf(m) else BASE_VEC
        val vec = jobj("val" to r4(vv(s0["vec"]) + INERTIA * (vv(tg) - vv(s0["vec"]))), "aro" to r4(va(s0["vec"]) + INERTIA * (va(tg) - va(s0["vec"]))))
        val whyLoc = if (Js.truthy(parsed["why"])) locateWhy(parsed["why"], userText) else null
        val hits = gd["hit"] as List<*>
        val out = jobj("v" to 1, "aff" to r4(aff), "vec" to vec, "mood" to classify(vec, s0["mood"]), "ts" to now, "a" to a, "m" to m,
            "g" to jobj("day" to day, "net" to net, "guard" to hits), "p" to if (hits.any { !Js.str(it).startsWith("why:") }) "model+guard" else "model",
            "stateMissing" to false, "explicitNeutral" to (a == 0.0))
        if (Js.truthy(parsed["why"])) out["why"] = parsed["why"]
        if (whyLoc != null) out["whyLoc"] = whyLoc
        if (clock == "turn") out["turn"] = turnNow
        return out
    }

    fun lexiconScore(userText: Any?): Double {
        val u = if (Js.truthy(userText)) Js.str(userText) else ""
        if (Js.trim(u).isEmpty()) return 0.0
        val lower = u.lowercase(java.util.Locale.ROOT)
        var score = 0.0
        fun weightAt(idx: Int): Double {
            var w = 1.0
            val prev = lower.substring(maxOf(0, idx - 10), idx)
            for (adv in DEG_KEYS) { val p = prev.lastIndexOf(adv); if (p >= 0 && prev.length - (p + adv.length) <= 2) { w *= LEX_DEGREE[adv]!!; break } }
            var neg = false
            for (ng in LEX_NEGATE) {
                val p = prev.lastIndexOf(ng)
                if (p < 0 || prev.length - (p + ng.length) > 3) continue
                val after = prev.substring(p)
                if (DEG_KEYS.any { adv -> adv.startsWith(ng) && adv.length > ng.length && after.startsWith(adv) }) continue
                neg = true; break
            }
            return if (neg) -w else w
        }
        fun addAll(words: List<String>, sign: Int) {
            for (wd in words) { val key = wd.lowercase(java.util.Locale.ROOT); var from = 0
                while (true) { val idx = lower.indexOf(key, from); if (idx < 0) break; score += sign * weightAt(idx); from = idx + maxOf(key.length, 1) } }
        }
        addAll(LEX_POS, 1); addAll(LEX_NEG, -1)
        return r4(clamp(score, -2.0, 2.0))
    }

    fun affToX(aff: Any?): Double { val a = if (aff == null) BASE_AFF else aff.d(); return r4(clamp((a - BASE_AFF) / ((1 - BASE_AFF) / 2), -2.0, 2.0)) }
    fun deltaFromA(a: Double): Double {
        val x = clamp(a, -2.0, 2.0); val lo = floor(x); val hi = ceil(x)
        if (lo == hi) return DELTA[Js.numToString(lo)]!!
        val t = x - lo
        return DELTA[Js.numToString(lo)]!! * (1 - t) + DELTA[Js.numToString(hi)]!! * t
    }
    private fun finite(v: Any?) = v != null && v is Double && v.isFinite()

    fun kfUpdate(prevKf: Any?, y: Double, affHint: Any?): JObj {
        val x = if (prevKf != null && finite(prevKf["x"])) prevKf["x"].d() else affToX(affHint)
        val P = if (prevKf != null && finite(prevKf["P"]) && prevKf["P"].d() > 0) prevKf["P"].d() else 1.0
        val xPrior = x; val PPrior = P + KF_Q
        var yUsed = y; var robust = false
        val gate = 3 * sqrt(PPrior + KF_R)
        if (abs(y - xPrior) > gate) { yUsed = xPrior + 0.5 * (y - xPrior); robust = true }
        val K = PPrior / (PPrior + KF_R)
        val xPost = xPrior + K * (yUsed - xPrior); val PPost = (1 - K) * PPrior
        return jobj("x" to r4(clamp(xPost, -2.0, 2.0)), "P" to r4(maxOf(PPost, 1e-6)), "yUsed" to r4(yUsed), "K" to r4(K), "robust" to robust, "xPrior" to r4(xPrior), "PPrior" to r4(PPrior))
    }
    fun cusumUpdate(prevCu: Any?, x: Double, affHint: Any?): JObj {
        val prev = prevCu ?: JObj()
        var sp = Js.toNumber(Js.or(prev["sp"], 0.0)); var sm = Js.toNumber(Js.or(prev["sm"], 0.0))
        var dwell = (if (prev["dwell"] != null) prev["dwell"].d() else 0.0) + 1
        val t0 = if (prev["tier"] != null) prev["tier"].d() else tier(if (affHint != null) affHint.d() else BASE_AFF).toDouble()
        var t = clamp(Js.toInt32(t0).toDouble(), 1.0, 5.0)
        sp = maxOf(0.0, sp + (x - CUSUM_K_UP)); sm = maxOf(0.0, sm + (CUSUM_K_DN - x))
        var changed = false
        if (sp > CUSUM_H_UP && dwell >= CUSUM_D && t < 5) { t += 1; sp = 0.0; sm = 0.0; dwell = 0.0; changed = true }
        else if (sm > CUSUM_H_DN && dwell >= CUSUM_D && t > 1) { t -= 1; sp = 0.0; sm = 0.0; dwell = 0.0; changed = true }
        return jobj("sp" to r4(sp), "sm" to r4(sm), "dwell" to dwell, "tier" to t, "changed" to changed)
    }
    fun checkConsistency(assistantText: Any?, a: Double, m: Any?): JObj {
        val t = if (Js.truthy(assistantText)) Js.str(assistantText) else ""
        if (t.isEmpty()) return jobj("wMul" to 1, "inconsistent" to false, "hit" to ArrayList<Any?>())
        val negMood = m in NEG_MOODS
        if (Js.test(RX_CARE, t) && (a <= -1 || negMood)) return jobj("wMul" to KF_W_INCONSISTENT, "inconsistent" to true, "hit" to jarr("inconsistent"))
        if (Js.test(RX_REBUKE, t) && a >= 1) return jobj("wMul" to KF_W_INCONSISTENT, "inconsistent" to true, "hit" to jarr("inconsistent"))
        return jobj("wMul" to 1, "inconsistent" to false, "hit" to ArrayList<Any?>())
    }
    fun useKfEstimator(opts: Any?): Boolean {
        val o = opts ?: JObj()
        if (o["estimator"] == "legacy") return false
        if (o["estimator"] == "kf") return true
        val src = o["settings"] ?: JObj()
        if (src["affectKf"] == false || src["affectEstimator"] == "legacy") return false
        if (o["affectKf"] == false || o["affectEstimator"] == "legacy") return false
        if (Js.truthy(o["conv"]) && (o["conv"]["affectKf"] == false || o["conv"]["affectEstimator"] == "legacy")) return false
        return true
    }
    fun estimatorOf(conv: Any?, settings: Any?): String {
        val e = Js.or(conv?.let { it["affectEstimator"] }, settings?.let { it["affectEstimator"] })
        if (e == "legacy" || e == "kf") return e as String
        if (conv?.let { it["affectKf"] } == false) return "legacy"
        if (settings?.let { it["affectKf"] } == false) return "legacy"
        return "kf"
    }
    fun vecStepKf(s0vec: Any?, mood: Any?, kf: Any?): JObj {
        val prev = if (Js.truthy(s0vec)) s0vec else BASE_VEC
        val tgMood = if (Js.truthy(mood) && mood is String && TARGET.containsKey(mood)) tgOf(mood) else BASE_VEC
        val x = if (kf != null && finite(kf["x"])) kf["x"].d() else 0.0
        val tgX = jobj("val" to r4(clamp(x / 2, -1.0, 1.0)), "aro" to r4(clamp(0.20 + 0.4 * abs(x) / 2, 0.0, 1.0)))
        val a = VEC_KF_ALPHA
        val tg = jobj("val" to r4((1 - a) * vv(tgMood) + a * vv(tgX)), "aro" to r4((1 - a) * va(tgMood) + a * va(tgX)))
        val K = if (kf != null && finite(kf["K"])) kf["K"].d() else INERTIA
        val g = r4(clamp(0.5 * INERTIA + 0.5 * K, VEC_KF_G_MIN, VEC_KF_G_MAX))
        return jobj("vec" to jobj("val" to r4(vv(prev) + g * (vv(tg) - vv(prev))), "aro" to r4(va(prev) + g * (va(tg) - va(prev)))), "tg" to tg, "g" to g, "tgMood" to tgMood, "tgX" to tgX)
    }
    fun formatKfHint(st: Any?): String {
        if (!Js.truthy(st) || !Js.truthy(st["kf"]) || st["kf"]["x"] == null) return ""
        val bits = mutableListOf("â=" + Js.toFixed(Js.toNumber(st["kf"]["x"]), 2), "P=" + Js.toFixed(Js.toNumber(st["kf"]["P"] ?: 0.0), 3))
        val g = st["g"] ?: JObj()
        if (g["yT"] != null) bits += "yT=" + Js.toFixed(Js.toNumber(g["yT"]), 2)
        if (g["yModel"] != null) bits += "yM=" + Js.str(g["yModel"])
        if (g["yLex"] != null) bits += "yL=" + Js.toFixed(Js.toNumber(g["yLex"]), 2)
        if (g["w"] != null) bits += "w=" + Js.toFixed(Js.toNumber(g["w"]), 2)
        if (Js.truthy(g["robust"])) bits += "robust"
        return bits.joinToString(" · ")
    }
    fun formatCusumHint(st: Any?): String {
        if (!Js.truthy(st) || !Js.truthy(st["cusum"])) return ""
        val c = st["cusum"]
        return "档" + Js.strOrEmptyUndef(c as Map<*, *>, "tier") + "/5 · dwell=" + Js.str(c["dwell"] ?: 0.0) + " · S+=" + Js.toFixed(Js.toNumber(Js.or(c["sp"], 0.0)), 2) + " · S-=" + Js.toFixed(Js.toNumber(Js.or(c["sm"], 0.0)), 2)
    }
    fun blendAffect(own: Any?, scene: Any?): JObj? {
        val ho = Js.truthy(own); val hs = Js.truthy(scene)
        @Suppress("UNCHECKED_CAST") run {
            if (!ho && !hs) return null
            if (!hs) return Js.assign(own as Map<String, Any?>)
            if (!ho) { val s = Js.assign(scene as Map<String, Any?>); if (s["aff"] == null) s["aff"] = BASE_AFF; return s }
        }
        val aff = r4(CHAR_SELF_W * (if (own["aff"] != null) own["aff"].d() else BASE_AFF) + CHAR_SCENE_W * (if (scene["aff"] != null) scene["aff"].d() else BASE_AFF))
        val ov = if (Js.truthy(own["vec"])) own["vec"] else BASE_VEC; val sv = if (Js.truthy(scene["vec"])) scene["vec"] else BASE_VEC
        val vec = jobj("val" to r4(CHAR_SELF_W * vv(ov) + CHAR_SCENE_W * vv(sv)), "aro" to r4(CHAR_SELF_W * va(ov) + CHAR_SCENE_W * va(sv)))
        @Suppress("UNCHECKED_CAST") val o = Js.assign(own as Map<String, Any?>)
        o["aff"] = aff; o["vec"] = vec; o["mood"] = classify(vec, own["mood"]); o["blended"] = true
        return o
    }

    fun step(prev: Any?, parsed: Any?, userText: Any?, now: Double, opts: Any?): JObj {
        if (!useKfEstimator(opts)) return stepLegacy(prev, parsed, userText, now, opts)
        val clock = if (opts?.let { it["clock"] } == "turn") "turn" else "wall"
        val turnNow = turnNowOf(clock, prev, opts)
        val s0 = decay(prev, now, jobj("clock" to clock, "turn" to turnNow))
        val s0aff = s0["aff"].d()
        val day = dayKey(now); var net = netOf(prev, day)
        var forcedMissing = false; var guardHitForced: List<Any?>? = null; var parsedUse = parsed
        if (parsedUse == null) {
            val gd0 = guard(0.0, null, userText, optsWith(opts, "why" to null, "missingState" to true))
            if (!forcedHit(gd0["hit"] as List<*>)) {
                @Suppress("UNCHECKED_CAST")
                val out = jobj("v" to 1, "aff" to s0["aff"], "vec" to s0["vec"], "mood" to s0["mood"], "ts" to now, "a" to null, "m" to null,
                    "g" to jobj("day" to day, "net" to net, "guard" to gd0["hit"]), "p" to "missing_state", "stateMissing" to true,
                    "kf" to if (Js.truthy(prev) && Js.truthy(prev["kf"])) Js.assign(prev["kf"] as Map<String, Any?>) else jobj("x" to affToX(s0aff), "P" to 1),
                    "cusum" to if (Js.truthy(prev) && Js.truthy(prev["cusum"])) Js.assign(prev["cusum"] as Map<String, Any?>) else jobj("sp" to 0, "sm" to 0, "dwell" to 0, "tier" to tier(s0aff)))
                if (clock == "turn") out["turn"] = turnNow
                return out
            }
            parsedUse = jobj("a" to gd0["a"], "m" to gd0["m"]); forcedMissing = true; guardHitForced = gd0["hit"] as List<Any?>
        }
        val gd = if (forcedMissing) jobj("a" to parsedUse["a"], "m" to parsedUse["m"], "hit" to (guardHitForced ?: ArrayList<Any?>()))
            else guard(parsedUse["a"].d(), parsedUse["m"], userText, optsWith(opts, "why" to parsedUse["why"]))
        val a = gd["a"].d(); val m = gd["m"]
        val cons = checkConsistency(opts?.let { it["assistantText"] }, a, m)
        val guardHit: JArr = (gd["hit"] as List<*>).toMutableList()
        if (Js.truthy(cons["inconsistent"])) guardHit.add("inconsistent")
        val yModel = a; val yLex = lexiconScore(userText)
        val why = parsedUse["why"]
        val founded = if (Js.truthy(why)) jaccard(why, userText) >= WHY_TH else false
        var w = if (founded) KF_W_WHY else KF_W
        w *= cons["wMul"].d()
        val yT = r4(w * yModel + (1 - w) * yLex)
        val kf = kfUpdate(if (Js.truthy(prev)) prev["kf"] else null, yT, s0aff)
        val aff = clamp(s0aff + run { var d = deltaFromA(kf["x"].d()); if (d > 0) { d *= (1 - s0aff) / (1 - BASE_AFF); d = maxOf(0.0, minOf(d, DAILY_GAIN_CAP - net)) } else if (d < 0) d *= NEG_MULT; d }, 0.0, 1.0)
        net = r4(net + (aff - s0aff))
        val vs = vecStepKf(s0["vec"], m, kf); val vec = vs["vec"]
        val cu = cusumUpdate(if (Js.truthy(prev)) prev["cusum"] else null, kf["x"].d(), s0aff)
        val whyLoc = if (Js.truthy(parsedUse["why"])) locateWhy(parsedUse["why"], userText) else null
        val hardGuard = guardHit.any { !Js.str(it).startsWith("why:") && it != "inconsistent" }
        val pBase = if (forcedMissing) "missing_state+guard" else if (hardGuard) "model+guard" else "model"
        val out = jobj("v" to 1, "aff" to r4(aff), "vec" to vec, "mood" to classify(vec, s0["mood"]), "ts" to now, "a" to a, "m" to m,
            "g" to jobj("day" to day, "net" to net, "guard" to guardHit, "inconsistent" to Js.truthy(cons["inconsistent"]), "w" to r4(w), "yModel" to yModel, "yLex" to yLex, "yT" to yT, "robust" to Js.truthy(kf["robust"]), "vecG" to vs["g"]),
            "p" to "$pBase+kf", "stateMissing" to forcedMissing, "explicitNeutral" to (a == 0.0),
            "kf" to jobj("x" to kf["x"], "P" to kf["P"], "K" to kf["K"]), "cusum" to jobj("sp" to cu["sp"], "sm" to cu["sm"], "dwell" to cu["dwell"], "tier" to cu["tier"]))
        if (Js.truthy(parsedUse["why"])) out["why"] = parsedUse["why"]
        if (whyLoc != null) out["whyLoc"] = whyLoc
        if (clock == "turn") out["turn"] = turnNow
        return out
    }
    fun stepLight(prev: Any?, userText: Any?, now: Double, opts: Any?) = step(prev, null, userText, now, opts)

    fun locateWhy(why: Any?, userText: Any?): JObj? {
        val u = if (Js.truthy(userText)) Js.str(userText) else ""; val w = Js.trim(if (Js.truthy(why)) Js.str(why) else "")
        if (w.isEmpty() || u.isEmpty()) return null
        val i = u.indexOf(w)
        if (i >= 0) return jobj("start" to i, "end" to i + w.length, "quote" to u.substring(i, i + w.length))
        fun strip(s: String) = buildString { for (c in s) if (!Js.isWs(c)) append(c) }
        val us = strip(u); val ws = strip(w)
        val j = us.indexOf(ws)
        if (j < 0) return jobj("start" to -1, "end" to -1, "quote" to w, "approx" to true)
        var ci = 0; var start = -1; var end = -1
        for (k in u.indices) {
            if (Js.isWs(u[k])) continue
            if (ci == j) start = k
            if (ci == j + ws.length - 1) { end = k + 1; break }
            ci++
        }
        return jobj("start" to start, "end" to if (end < 0) (if (start >= 0) start + w.length else -1) else end, "quote" to if (start >= 0) Js.slice(u, start, end) else w, "approx" to true)
    }
}
