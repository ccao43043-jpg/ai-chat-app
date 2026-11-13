package com.aichat.app.domain.cost

import com.aichat.app.domain.model.Usage
import com.aichat.app.net.Js
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * www/cost-core.js 的逐函数移植（统一价目 + costOf + 真实账单 EWMA 对账，EWMA_ALPHA=0.3 / 15% / 连续 3 轮）。
 * 价目 / calib 都是 JS 同形 JsonObject（usage-stats-meta.json 原样），返回值键序与 JS 相同；golden：costCore.jsonl。
 */
object CostCoreJs {
    const val CNY_PER_USD = 7.2
    const val EWMA_ALPHA = 0.3
    const val BIAS_ABS_THRESHOLD = 0.15
    const val BIAS_STREAK_MARK = 3
    private fun parse(s: String) = Js.json.parseToJsonElement(s) as JsonObject
    val DEFAULT_PEAK: JsonObject = parse("""{"windows":"09:00-12:00,14:00-18:00","tz":8,"weekdays":true,"off_factor":0.5}""")
    val DEFAULT_PRICES: JsonObject = parse("""{"deepseek-flash":{"hit":0.006,"miss":0.3,"out":1.2,"match":"deepseek"},"deepseek-v4-pro":{"hit":0.044,"miss":1.32,"out":3.96,"match":"deepseek-v4-pro,deepseek-pro"}}""")
    /** 由 node 从 cost-core.js 导出（qp() 已按 JS 舍入），逐字一致 */
    val BUILTIN_PRICES: JsonObject = parse("""{"deepseek-flash":{"hit":0.006,"miss":0.3,"out":1.2,"match":"deepseek","builtin":true},"deepseek-v4-pro":{"hit":0.044,"miss":1.32,"out":3.96,"match":"deepseek-v4-pro,deepseek-pro","builtin":true},"qwen3.8-max":{"hit":0.33333,"hit_explicit":0.16667,"write":2.08333,"miss":1.66667,"out":5,"match":"qwen3.8-max,qwen3.7-max","peak":false,"builtin":true},"qwen3.7-plus":{"hit":0.05556,"hit_explicit":0.02778,"write":0.34722,"miss":0.27778,"out":1.11111,"match":"qwen3.7-plus","peak":false,"builtin":true},"qwen3.6-plus":{"hit":0.05556,"hit_explicit":0.02778,"write":0.34722,"miss":0.27778,"out":1.66667,"match":"qwen3.6-plus","peak":false,"builtin":true},"qwen3.5-plus":{"hit":0.02222,"hit_explicit":0.01111,"write":0.13889,"miss":0.11111,"out":0.66667,"match":"qwen3.5-plus","peak":false,"builtin":true},"qwen-plus":{"hit":0.02222,"hit_explicit":0.01111,"write":0.13889,"miss":0.11111,"out":0.27778,"match":"qwen-plus,qwen","peak":false,"builtin":true},"qwen3.8-flash":{"hit":0.02222,"hit_explicit":0.01111,"write":0.13889,"miss":0.11111,"out":0.375,"match":"qwen3.8-flash","peak":false,"builtin":true},"qwen3.7-flash":{"hit":0.00556,"hit_explicit":0.00278,"write":0.03472,"miss":0.02778,"out":0.11111,"match":"qwen3.7-flash","peak":false,"builtin":true},"qwen3.6-flash":{"hit":0.03333,"hit_explicit":0.01667,"write":0.20833,"miss":0.16667,"out":1,"match":"qwen3.6-flash","peak":false,"builtin":true},"qwen3.5-flash":{"hit":0.00556,"hit_explicit":0.00278,"write":0.03472,"miss":0.02778,"out":0.27778,"match":"qwen3.5-flash","peak":false,"builtin":true},"qwen-flash":{"hit":0.00417,"hit_explicit":0.00208,"write":0.02604,"miss":0.02083,"out":0.20833,"match":"qwen-flash,qwen-turbo","peak":false,"builtin":true},"qwen-max":{"hit":0.06667,"hit_explicit":0.03333,"write":0.41667,"miss":0.33333,"out":1.33333,"match":"qwen-max","peak":false,"builtin":true},"qwen3-coder-flash":{"hit":0.02778,"hit_explicit":0.01389,"write":0.17361,"miss":0.13889,"out":0.55556,"match":"qwen3-coder-flash,qwen3-coder","peak":false,"builtin":true},"qwen3-vl-plus":{"hit":0.02778,"hit_explicit":0.01389,"write":0.17361,"miss":0.13889,"out":1.38889,"match":"qwen3-vl-plus,qwen-vl","peak":false,"builtin":true},"qwen-plus-character":{"hit":0.02222,"hit_explicit":0.01111,"write":0.13889,"miss":0.11111,"out":0.27778,"match":"qwen-plus-character,character","peak":false,"builtin":true},"qwen-long":{"hit":0.01389,"hit_explicit":0.00694,"write":0.08681,"miss":0.06944,"out":0.27778,"match":"qwen-long","peak":false,"builtin":true},"gemini-2.5-flash-lite":{"hit":0.025,"miss":0.1,"out":0.4,"match":"gemini-2.5-flash-lite,flash-lite","peak":false,"builtin":true}}""")
    val USAGE_DEFAULT_PRICES: JsonObject get() = UsageStatsCore.DEFAULT_PRICES

    // ---------------- 小工具（JS 语义） ----------------
    fun finNum(v: JsonElement?): Double? = FloorPrices.finNum(v)
    fun fin0(v: JsonElement?): Double = finNum(v) ?: 0.0
    internal fun prop(o: JsonElement?, k: String): JsonElement? = (o as? JsonObject)?.get(k)
    internal fun num(d: Double): JsonElement = Js.number(d)
    private val SPLIT_MATCH = Regex("[,，\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")
    private fun lowerJs(s: String) = s.lowercase(java.util.Locale.ROOT)

    /** priceForRules(model, prices, builtinOnly)：最长 match 关键字；DeepSeek 兜底 */
    fun priceForRules(model: String?, prices: JsonObject?, builtinOnly: Boolean = false): JsonElement? {
        val bag = prices ?: DEFAULT_PRICES
        val m = lowerJs(model ?: "")
        if (builtinOnly) {
            var b: JsonElement? = null; var bl = -1
            for ((_, p) in bag) for (k in Js.str(prop(p, "match")).split(',')) {
                if (k.isNotEmpty() && m.contains(k) && k.length > bl) { b = p; bl = k.length }
            }
            return b
        }
        var best: JsonElement? = null; var bestLen = -1
        for ((name, p) in bag) {
            if (!Js.truthy(p)) continue
            val mt = prop(p, "match")
            val src = if (mt != null && mt !is JsonNull) Js.str(mt) else name
            val keys = lowerJs(src).split(SPLIT_MATCH).filter { it.isNotEmpty() }
            for (k in keys) if (m.contains(k) && k.length > bestLen) { best = p; bestLen = k.length }
        }
        if (best != null) return best
        if (!m.contains("deepseek")) return null
        return (if (m.contains("pro")) bag["deepseek-v4-pro"] else bag["deepseek-flash"]).takeIf { Js.truthy(it) }
    }

    fun priceFor(model: String?, prices: JsonObject?): JsonElement? =
        priceForRules(model, prices) ?: if (!model.isNullOrEmpty()) priceForRules(model, BUILTIN_PRICES, true) else null

    /** 用量页：priceFor → bag[model] → bag.default → USAGE_DEFAULT_PRICES.default */
    fun priceForUsage(model: String?, prices: JsonObject?): JsonElement? {
        priceFor(model, prices)?.let { return it }
        val bag = prices ?: USAGE_DEFAULT_PRICES
        bag[model ?: "null"]?.takeIf { Js.truthy(it) }?.let { return it }
        return bag["default"]?.takeIf { Js.truthy(it) } ?: USAGE_DEFAULT_PRICES["default"]
    }

    private val WINDOW_SPLIT = Regex("[,，;\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")
    private val WINDOW_RE = Regex("^(\\d{1,2}):?(\\d{2})?-(\\d{1,2}):?(\\d{2})?$")
    fun parseWindows(str: String?): List<IntArray> = (str ?: "").split(WINDOW_SPLIT).mapNotNull { WINDOW_RE.find(it) }.map { r ->
        intArrayOf(r.groupValues[1].toInt() * 60 + (r.groups[2]?.value?.toInt() ?: 0), r.groupValues[3].toInt() * 60 + (r.groups[4]?.value?.toInt() ?: 0))
    }.filter { it[0] >= 0 && it[1] <= 1440 && it[0] < it[1] }

    private fun peakCfg(peak: JsonObject?): JsonObject = JsonObject(LinkedHashMap<String, JsonElement>(DEFAULT_PEAK).apply { peak?.let { putAll(it) } })

    fun isPeak(at: Double, peak: JsonObject?): Boolean {
        val pk = peakCfg(peak)
        val tz = Js.toNumber(pk["tz"]).let { if (it.isNaN() || it == 0.0) 0.0 else it }
        var t = at + tz * 3600e3
        if (!t.isFinite() || Math.abs(t) > 8.64e15) return false
        t = if (t < 0) Math.ceil(t) else Math.floor(t)
        val dayNo = Math.floor(t / 864e5)
        val day = Math.floorMod((dayNo.toLong() + 4), 7L).toInt()
        val mins = (Math.floorMod(t.toLong(), 86_400_000L) / 60_000L).toInt()
        if (Js.truthy(pk["weekdays"]) && (day == 0 || day == 6)) return false
        val w = pk["windows"]
        return parseWindows(if (w == null) "" else if (!Js.truthy(w)) "" else Js.str(w)).any { mins >= it[0] && mins < it[1] }
    }

    fun peakFactor(at: Double, mode: String?, peak: JsonObject?): Double {
        val f = Js.toNumber(peakCfg(peak)["off_factor"])
        val offF = if (f.isNaN()) 0.5 else f
        return when (mode) { "peak" -> 1.0; "offpeak" -> offF; else -> if (isPeak(at, peak)) 1.0 else offF }
    }

    fun factorFor(p: JsonElement?, at: Double, mode: String?, peak: JsonObject?): Double {
        val pk = prop(p, "peak")
        return if (Js.truthy(p) && pk is JsonPrimitive && !pk.isString && pk.content == "false") 1.0 else peakFactor(at, mode, peak)
    }

    /** scalePrice：hit/hit_explicit/write/miss/out × scale（Math.round(v·s·1e6)/1e6），加 calibScale */
    fun scalePrice(p: JsonElement?, scale: Double): JsonElement? {
        if (!Js.truthy(p) || !(scale > 0) || scale == 1.0) return p
        val o = p as? JsonObject ?: return p
        val out = LinkedHashMap<String, JsonElement>(o)
        for (k in listOf("hit", "hit_explicit", "write", "miss", "out")) {
            val v = out[k]
            if (v != null && v !is JsonNull) out[k] = num(Js.round(Js.toNumber(v) * scale * 1e6) / 1e6)
        }
        out["calibScale"] = num(scale)
        return JsonObject(out)
    }

    private fun calibEntry(calib: JsonObject?, model: String?): JsonElement? =
        if (calib == null || model.isNullOrEmpty()) null else calib[model]?.takeIf { Js.truthy(it) }

    fun priceForCalibrated(model: String?, prices: JsonObject?, calib: JsonObject?): JsonElement? {
        val p = priceFor(model, prices) ?: return null
        val c = calibEntry(calib, model) ?: return p
        val s = Js.toNumber(prop(c, "scale"))
        return if (!(s > 0)) p else scalePrice(p, s)
    }

    fun calibScale(calib: JsonObject?, model: String?): Double {
        val c = calibEntry(calib, model) ?: return 1.0
        val s = Js.toNumber(prop(c, "scale"))
        return if (s > 0) s else 1.0
    }

    data class Cost(val actual: Double, val noCache: Double, val saved: Double) {
        fun toJson() = JsonObject(linkedMapOf("actual" to num(actual), "noCache" to num(noCache), "saved" to num(saved)))
    }

    /** costOf（rpcache 形态 e）；calib 非 null 时用校准价 */
    fun costOf(e: JsonObject?, prices: JsonObject?, mode: String?, peak: JsonObject?, calib: JsonObject?): Cost? {
        if (e == null) return null
        val sup = e["supported"]
        if (sup is JsonPrimitive && !sup.isString && sup.content == "false") return null
        val model = e["model"]?.takeIf { it !is JsonNull }?.let { Js.str(it) }
        val p = (if (calib != null) priceForCalibrated(model, prices, calib) else priceFor(model, prices)) ?: return null
        val f0 = factorFor(p, Js.toNumber(e["timestamp"]), mode, peak)
        val f = if (f0.isFinite()) f0 else 1.0
        val miss = fin0(prop(p, "miss")); val out = fin0(prop(p, "out"))
        val hitP = if (Js.str(e["cache_mode"]) == "explicit" && e["cache_mode"] is JsonPrimitive && finNum(prop(p, "hit_explicit")) != null) fin0(prop(p, "hit_explicit")) else fin0(prop(p, "hit"))
        val writeP = if (finNum(prop(p, "write")) != null) fin0(prop(p, "write")) else miss
        val write = fin0(e["cache_write_tokens"]) * Math.max(0.0, writeP - miss)
        val actual = (fin0(e["cache_hit_tokens"]) * hitP + fin0(e["cache_miss_tokens"]) * miss + write + fin0(e["completion_tokens"]) * out) / 1e6 * f
        val noCache = (fin0(e["prompt_tokens"]) * miss + fin0(e["completion_tokens"]) * out) / 1e6 * f
        return Cost(actual, noCache, noCache - actual)
    }

    /** costOfEntry（usage-stats 形态 e）→ 美元或 null */
    fun costOfEntry(e: JsonObject?, prices: JsonObject?, mode: String?, peak: JsonObject?, calib: JsonObject?): Double? {
        if (e == null) return null
        val cache = Js.truthy(e["cache"])
        val mapped = LinkedHashMap<String, JsonElement>()
        e["model"]?.let { mapped["model"] = it }
        mapped["supported"] = JsonPrimitive(true)
        e["at"]?.let { mapped["timestamp"] = it }
        mapped["prompt_tokens"] = JsonPrimitive(Js.i32(e["prompt"]))
        mapped["cache_hit_tokens"] = JsonPrimitive(if (cache) Js.i32(e["hit"]) else 0)
        mapped["cache_miss_tokens"] = JsonPrimitive(if (cache) Js.i32(e["miss"]) else Js.i32(e["prompt"]))
        mapped["completion_tokens"] = JsonPrimitive(Js.i32(e["completion"]))
        mapped["cache_write_tokens"] = JsonPrimitive(Js.i32(e["write"]))
        mapped["cache_mode"] = e["cacheMode"]?.takeIf { Js.truthy(it) } ?: JsonPrimitive("implicit")
        val model = e["model"]?.takeIf { it !is JsonNull }?.let { Js.str(it) }
        val p = priceForUsage(model, prices) ?: return null
        val usePrices = prices ?: USAGE_DEFAULT_PRICES
        if (priceFor(model, usePrices) != null) {
            val r = costOf(JsonObject(mapped), usePrices, mode, peak, calib)
            return if (r != null && r.actual.isFinite()) r.actual else null
        }
        val f0 = factorFor(p, Js.toNumber(e["at"]), mode, peak)
        val f = if (f0.isFinite()) f0 else 1.0
        val inCost = if (cache) fin0(e["hit"]) * fin0(prop(p, "hit")) + fin0(e["miss"]) * fin0(prop(p, "miss"))
            else fin0(e["prompt"]) * (if (finNum(prop(p, "miss")) != null) fin0(prop(p, "miss")) else fin0(prop(p, "in")))
        val outCost = fin0(e["completion"]) * fin0(prop(p, "out"))
        val v = (inCost + outCost) / 1e6 * f
        return if (v.isFinite()) v else null
    }

    fun emptyCalib(): JsonObject = JsonObject(emptyMap())

    /** reconcile：bias=(est−actual)/actual；scale/biasEwma 做 EWMA(α)；|bias|>thr 连续 mark 轮标记 distorted */
    fun reconcile(calib: JsonObject?, model: String?, estimated: Double, actual: Double, now: Long,
                  alpha: Double = EWMA_ALPHA, threshold: Double = BIAS_ABS_THRESHOLD, streakMark: Int = BIAS_STREAK_MARK): JsonObject {
        val bag = LinkedHashMap<String, JsonElement>(calib ?: emptyMap())
        if (model.isNullOrEmpty() || !(actual > 0) || !(estimated > 0) || !actual.isFinite() || !estimated.isFinite()) return JsonObject(bag)
        val bias = (estimated - actual) / actual
        val ratio = actual / estimated
        val prev: JsonObject = bag[model]?.takeIf { Js.truthy(it) } as? JsonObject
            ?: if (Js.truthy(bag[model])) JsonObject(emptyMap()) else JsonObject(linkedMapOf("scale" to JsonPrimitive(1), "biasEwma" to JsonPrimitive(0),
                "streak" to JsonPrimitive(0), "distorted" to JsonPrimitive(false), "n" to JsonPrimitive(0)))
        fun orNum(e: JsonElement?, d: Double) = if (Js.truthy(e)) Js.toNumber(e) else d
        val scale = orNum(prev["scale"], 1.0) * (1 - alpha) + ratio * alpha
        val biasEwma = orNum(prev["biasEwma"], 0.0) * (1 - alpha) + bias * alpha
        val streak = if (Math.abs(bias) > threshold) Js.i32(prev["streak"]) + 1 else 0
        val distorted: JsonElement? = if (streak >= streakMark) JsonPrimitive(true)
            else if (!Js.truthy(prev["distorted"])) prev["distorted"]
            else JsonPrimitive(Math.abs(biasEwma) > threshold)
        val rec = LinkedHashMap<String, JsonElement>()
        rec["scale"] = num(scale); rec["biasEwma"] = num(biasEwma); rec["streak"] = JsonPrimitive(streak)
        if (distorted != null) rec["distorted"] = distorted
        rec["n"] = JsonPrimitive(Js.i32(prev["n"]) + 1)
        rec["lastBias"] = num(bias); rec["lastEst"] = num(estimated); rec["lastActual"] = num(actual)
        rec["updatedAt"] = JsonPrimitive(now)
        bag[model] = JsonObject(rec)
        return JsonObject(bag)
    }

    fun calibView(calib: JsonObject?, model: String?): JsonObject? {
        val c = calibEntry(calib, model) ?: return null
        val o = c as? JsonObject ?: JsonObject(emptyMap())
        val out = LinkedHashMap<String, JsonElement>()
        out["model"] = JsonPrimitive(model)
        o["scale"]?.let { out["scale"] = it }
        o["biasEwma"]?.let { out["biasEwma"] = it }
        out["biasPct"] = num(Js.round(orZero(o["biasEwma"]) * 1000) / 10)
        out["streak"] = JsonPrimitive(Js.i32(o["streak"]))
        out["distorted"] = JsonPrimitive(Js.truthy(o["distorted"]))
        out["n"] = JsonPrimitive(Js.i32(o["n"]))
        o["lastBias"]?.let { out["lastBias"] = it }
        o["lastEst"]?.let { out["lastEst"] = it }
        o["lastActual"]?.let { out["lastActual"] = it }
        return JsonObject(out)
    }
    private fun orZero(e: JsonElement?) = if (Js.truthy(e)) Js.toNumber(e) else 0.0

    fun distortedModels(calib: JsonObject?): List<JsonObject> =
        (calib ?: JsonObject(emptyMap())).filter { (_, v) -> Js.truthy(v) && Js.truthy(prop(v, "distorted")) }.keys.mapNotNull { calibView(calib, it) }

    // ---------------- Usage（契约）→ usage-stats 条目所需的 JS usage 形状 ----------------
    /** 契约 Usage → JS normalizeUsage 形状（makeEntry / recordUsage 的输入）：cost = costUsd */
    fun usageJson(u: Usage?): JsonObject? {
        if (u == null) return null
        val m = LinkedHashMap<String, JsonElement>()
        u.prompt?.let { m["prompt"] = JsonPrimitive(it) }; u.completion?.let { m["completion"] = JsonPrimitive(it) }
        u.hit?.let { m["hit"] = JsonPrimitive(it) }; u.miss?.let { m["miss"] = JsonPrimitive(it) }
        u.cacheSupported?.let { m["cacheSupported"] = JsonPrimitive(it) }; u.source?.let { m["source"] = JsonPrimitive(it) }
        u.costUsd?.let { m["cost"] = num(it) }; u.upstreamCost?.let { m["upstreamCost"] = num(it) }; u.cacheSaved?.let { m["cacheSaved"] = num(it) }
        u.cacheWrite?.let { m["cacheWrite"] = JsonPrimitive(it) }
        return JsonObject(m)
    }
}

/** 契约 CostCore（CostContracts.kt）的实现：委托 [CostCoreJs]。签名与 JS 不完全一一对应处见各方法注释。 */
class DefaultCostCore(private val mode: String? = "auto") : CostCore {
    override fun priceFor(model: String, prices: JsonObject): JsonObject? = CostCoreJs.priceFor(model, prices) as? JsonObject
    /** 契约给的是单个价目条目：按 costOfEntry 的 default 兜底分支等价计算（含 peak 系数） */
    override fun costOf(usage: Usage, price: JsonObject, atMs: Long, peak: JsonObject?): Double {
        val e = UsageStatsCore.makeEntry(JsonObject(linkedMapOf("usage" to (CostCoreJs.usageJson(usage) ?: JsonObject(emptyMap())),
            "at" to JsonPrimitive(atMs), "model" to JsonPrimitive("__single__"), "id" to JsonPrimitive("x"))), atMs) { "" }
        return CostCoreJs.costOfEntry(e, JsonObject(mapOf("__single__" to price, "default" to price)), mode, peak, null) ?: 0.0
    }
    override fun reconcile(calib: JsonObject, model: String, estimated: Double, billed: Double): JsonObject =
        CostCoreJs.reconcile(calib, model, estimated, billed, System.currentTimeMillis())
    /** 契约无 model 参数：返回 { model: calibView } 全量 */
    override fun calibView(calib: JsonObject): JsonObject =
        JsonObject(calib.keys.associateWith { (CostCoreJs.calibView(calib, it) ?: JsonNull) as JsonElement })
}
