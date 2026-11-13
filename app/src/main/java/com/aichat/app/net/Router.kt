package com.aichat.app.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * router.js 的逐行移植：按 (model, upstream) 维护命中率 Beta 后验，用有效成本选上游。
 * p_eff = h·p_hit + (1−h)·p_miss；滞回 + 熔断 + 延迟维 + 空闲粘滞；OpenRouter 用 provider.order 钉上游。
 *
 * 数值运算顺序与 JS 一字不差（golden 比的是 double 精确相等）。所有「now || Date.now()」处
 * 在 Kotlin 里同样回退到 System.currentTimeMillis()，测试一律显式传 now。
 * 状态树与 router-affinity.json 同构：{ [model]: { current, lastSwitchAt, upstreams: { [slug]: {a,b,obs,lastAt,fails,latEwma,latN} } } }
 */
object Router {

    /** DEFAULTS + settingsOf 结果（now / idleMs 为可选覆盖） */
    data class Settings(
        val priorA: Double = 6.0,
        val priorB: Double = 4.0,
        val minObs: Double = 5.0,
        val defaultH: Double = 0.5,
        val dwell: Double = 8.0,
        val switchMargin: Double = 0.97,
        val zPessimistic: Double = 1.28,
        val failBreak: Double = 3.0,
        val enabled: Boolean = true,
        val latencyWeight: Double = 0.15,
        val latencyRefMs: Double = 2000.0,
        val latEwmaAlpha: Double = 0.3,
        val stickyIdleMs: Double = 3_600_000.0,
        val idleSwitchMargin: Double = 0.5,
        val now: Double? = null,
        val idleMs: Double? = null,
    ) {
        companion object {
            /** settingsOf(Object.assign({}, DEFAULTS, cfg))；null 值视同未给 */
            fun of(cfg: JsonObject?): Settings {
                val d = Settings()
                fun n(k: String, def: Double): Double {
                    val e = cfg?.get(k); return if (e == null || e is JsonNull) def else Js.toNumber(e)
                }
                fun opt(k: String): Double? { val e = cfg?.get(k); return if (e == null || e is JsonNull) null else Js.toNumber(e) }
                return Settings(
                    priorA = n("priorA", d.priorA), priorB = n("priorB", d.priorB), minObs = n("minObs", d.minObs),
                    defaultH = n("defaultH", d.defaultH), dwell = n("dwell", d.dwell), switchMargin = n("switchMargin", d.switchMargin),
                    zPessimistic = n("zPessimistic", d.zPessimistic), failBreak = n("failBreak", d.failBreak),
                    enabled = (cfg?.get("enabled") as? JsonPrimitive)?.let { !(!it.isString && it.content == "false") } ?: true,
                    latencyWeight = n("latencyWeight", d.latencyWeight), latencyRefMs = n("latencyRefMs", d.latencyRefMs),
                    latEwmaAlpha = n("latEwmaAlpha", d.latEwmaAlpha), stickyIdleMs = n("stickyIdleMs", d.stickyIdleMs),
                    idleSwitchMargin = n("idleSwitchMargin", d.idleSwitchMargin), now = opt("now"), idleMs = opt("idleMs"),
                ).normalized()
            }
        }
        fun normalized() = copy(
            minObs = maxOf(0, Js.toInt32(minObs)).toDouble(),
            dwell = maxOf(1, Js.toInt32(dwell)).toDouble(),
            failBreak = maxOf(1, Js.toInt32(failBreak)).toDouble(),
        )
    }
    val DEFAULTS = Settings()

    class UpstreamStats(
        var a: Double = DEFAULTS.priorA, var b: Double = DEFAULTS.priorB, var obs: Double = 0.0, var lastAt: Double = 0.0,
        var fails: Double = 0.0, var latEwma: Double = 0.0, var latN: Double = 0.0,
    ) {
        fun toJson() = buildJsonObject {
            put("a", Js.number(a)); put("b", Js.number(b)); put("obs", Js.number(obs)); put("lastAt", Js.number(lastAt))
            put("fails", Js.number(fails)); put("latEwma", Js.number(latEwma)); put("latN", Js.number(latN))
        }
        fun copy() = UpstreamStats(a, b, obs, lastAt, fails, latEwma, latN)
        companion object {
            fun fromJson(o: JsonObject): UpstreamStats {
                fun n(k: String, def: Double) = o[k]?.let { Js.toNumber(it) } ?: def
                return UpstreamStats(n("a", DEFAULTS.priorA), n("b", DEFAULTS.priorB), n("obs", 0.0), n("lastAt", 0.0),
                    n("fails", 0.0), n("latEwma", 0.0), n("latN", 0.0))
            }
        }
    }

    class ModelState(var current: String? = null, var lastSwitchAt: Double = 0.0,
                     val upstreams: LinkedHashMap<String, UpstreamStats> = LinkedHashMap()) {
        fun toJson() = buildJsonObject {
            put("current", current?.let { JsonPrimitive(it) } ?: JsonNull)
            put("lastSwitchAt", Js.number(lastSwitchAt))
            put("upstreams", JsonObject(upstreams.mapValues { it.value.toJson() }))
        }
        fun copy() = ModelState(current, lastSwitchAt, LinkedHashMap(upstreams.mapValues { it.value.copy() }))
        companion object {
            fun fromJson(o: JsonObject?): ModelState {
                if (o == null) return ModelState()
                val cur = o["current"]?.let { if (Js.truthy(it)) Js.str(it) else null }
                val ups = LinkedHashMap<String, UpstreamStats>()
                (o["upstreams"] as? JsonObject)?.forEach { (k, v) -> if (v is JsonObject) ups[k] = UpstreamStats.fromJson(v) }
                return ModelState(cur, o["lastSwitchAt"]?.let { Js.toNumber(it) }?.takeIf { !it.isNaN() } ?: 0.0, ups)
            }
        }
    }

    /** 整棵状态树（router-affinity.json） */
    class State(val models: LinkedHashMap<String, ModelState> = LinkedHashMap()) {
        fun toJson() = JsonObject(models.mapValues { it.value.toJson() })
        fun copy() = State(LinkedHashMap(models.mapValues { it.value.copy() }))
        companion object {
            fun fromJson(o: JsonObject?): State {
                val m = LinkedHashMap<String, ModelState>()
                o?.forEach { (k, v) -> if (v is JsonObject && Js.truthy(v)) m[k] = ModelState.fromJson(v) }
                return State(m)
            }
            fun parse(text: String?): State {
                if (text == null) return State()
                return try { fromJson(Js.json.parseToJsonElement(text) as? JsonObject) } catch (e: Exception) { State() }
            }
        }
    }

    private fun now(at: Double?): Double = if (at == null || at == 0.0 || at.isNaN()) System.currentTimeMillis().toDouble() else at

    /** 悲观命中率分位（Beta 均值 − z·σ），夹到 [0, 0.95] */
    fun hitQuantile(a: Double, b: Double, z: Double? = null): Double {
        val A = maxOf(1e-9, a); val B = maxOf(1e-9, b)
        val n = A + B
        val mean = A / n
        val v = (A * B) / (n * n * (n + 1))
        val h = mean - (z ?: DEFAULTS.zPessimistic) * Math.sqrt(maxOf(0.0, v))
        return maxOf(0.0, minOf(0.95, h))
    }
    private fun jsMax(a: Double, b: Double) = if (a.isNaN() || b.isNaN()) Double.NaN else maxOf(a, b)
    private fun jsMin(a: Double, b: Double) = if (a.isNaN() || b.isNaN()) Double.NaN else minOf(a, b)

    fun effectivePrice(pMiss: Double, pHit: Double, h: Double): Double {
        if (!pMiss.isFinite()) return Double.POSITIVE_INFINITY
        val hit = if (pHit.isFinite()) pHit else pMiss
        val hh = maxOf(0.0, minOf(0.95, if (h.isNaN()) 0.0 else h))
        return hh * hit + (1 - hh) * pMiss
    }
    fun effectivePrice(pMiss: JsonElement?, pHit: JsonElement?, h: Double) = effectivePrice(Js.toNumber(pMiss), Js.toNumber(pHit), h)

    fun scaleAmount(v: JsonElement?, scale: Double): JsonElement? {
        if (!(scale > 0) || scale == 1.0) return v
        val n = Js.toNumber(v)
        return if (n.isFinite()) Js.number(n * scale) else v
    }

    /** 把 calib[model].scale（或单项 x.scale）接到路由候选价上，加 calibScale 字段 */
    fun applyCalibScale(list: List<JsonObject>, calib: JsonObject?, model: String?): List<JsonObject> {
        val c = if (calib != null && !model.isNullOrEmpty()) calib[model] as? JsonObject else null
        val cs = c?.get("scale")?.let { Js.toNumber(it) } ?: Double.NaN
        val scale = if (cs > 0) cs else 1.0
        return list.map { x ->
            val xs = Js.toNumber(x["scale"])
            val sl = if (xs > 0) xs else scale
            val m = LinkedHashMap<String, JsonElement>(x)
            if (!(sl > 0) || sl == 1.0) { m["calibScale"] = Js.number(if (sl > 0) sl else 1.0); return@map JsonObject(m) }
            m["pMiss"] = scaleAmount(x["pMiss"], sl) ?: JsonNull
            val ph = x["pHit"]
            if (ph != null && ph !is JsonNull) m["pHit"] = scaleAmount(ph, sl) ?: JsonNull
            m["calibScale"] = Js.number(sl)
            JsonObject(m)
        }
    }

    fun latencyOf(priceItem: JsonObject?, stats: UpstreamStats?): Double {
        val fromPrice = Js.toNumber(priceItem?.get("latencyMs"))
        if (fromPrice > 0) return fromPrice
        val ew = stats?.latEwma ?: Double.NaN
        return if (ew > 0) ew else 0.0
    }

    fun effectiveScore(pe: Double, latencyMs: Double, cfg: Settings = DEFAULTS): Double {
        if (!pe.isFinite()) return pe
        if (!(latencyMs > 0) || !(cfg.latencyWeight > 0)) return pe
        val ref = if (cfg.latencyRefMs > 0) cfg.latencyRefMs else DEFAULTS.latencyRefMs
        val factor = 1 + cfg.latencyWeight * (latencyMs / ref - 1)
        return pe * maxOf(0.7, minOf(1.8, factor))
    }

    fun ensureModel(state: State, model: String): ModelState = state.models.getOrPut(model) { ModelState() }
    fun ensureUpstream(ms: ModelState, slug: String): UpstreamStats = ms.upstreams.getOrPut(slug) { UpstreamStats() }

    /** 证据权重：默认 1；infoWeight 时 log2(1+pt)/log2(1+ref)，夹到 [0.5, 2] */
    fun evidenceWeight(promptTokens: Double, infoWeight: Boolean = false, refTokens: Double? = null): Double {
        if (!infoWeight) return 1.0
        val pt = maxOf(0.0, if (promptTokens.isNaN()) 0.0 else promptTokens)
        val ref = if (refTokens != null && refTokens > 0) refTokens else 8000.0
        val w = log2(1 + pt) / log2(1 + ref)
        return maxOf(0.5, minOf(2.0, w))
    }
    private fun log2(x: Double) = Math.log(x) / Math.log(2.0)

    /** 一次观测。hitTokens/promptTokens 优先，其次 hit: Boolean；ok=false 记失败，否则清零；latencyMs 进 EWMA */
    data class Observation(
        val hitTokens: Double? = null, val promptTokens: Double? = null, val hit: Boolean? = null,
        val ok: Boolean? = null, val latencyMs: Double? = null,
        val infoWeight: Boolean = false, val refTokens: Double? = null,
    )

    fun observe(state: State, model: String, slug: String, obs: Observation, now: Double?, latEwmaAlpha: Double? = null): State {
        val ms = ensureModel(state, model)
        val u = ensureUpstream(ms, slug)
        val at = now(now)
        val pt = obs.promptTokens; val ht = obs.hitTokens
        if (ht != null && pt != null && pt > 0) {
            val hit = jsMax(0.0, jsMin(pt, ht))
            val h = hit / pt
            val w = evidenceWeight(pt, obs.infoWeight, obs.refTokens)
            u.a += w * h
            u.b += w * (1 - h)
            u.obs += 1
        } else if (obs.hit != null) {
            val w = evidenceWeight(1.0, obs.infoWeight, obs.refTokens)
            if (obs.hit) u.a += w else u.b += w
            u.obs += 1
        }
        u.lastAt = at
        if (obs.ok == false) u.fails = (Js.toInt32(u.fails) + 1).toDouble() else u.fails = 0.0
        val lat = obs.latencyMs ?: Double.NaN
        if (lat > 0) {
            val alpha = latEwmaAlpha ?: DEFAULTS.latEwmaAlpha
            u.latEwma = if (u.latN > 0 && u.latEwma > 0) (u.latEwma * (1 - alpha) + lat * alpha) else lat
            u.latN = (Js.toInt32(u.latN) + 1).toDouble()
        }
        ms.current = slug
        return state
    }

    fun markFail(state: State, model: String, slug: String, now: Double?): State = observe(state, model, slug, Observation(ok = false), now)

    fun switchCost(curPe: Double, bestPe: Double, prefixTokens: Double, pMissCur: Double, pHitCur: Double): Double {
        val P = maxOf(0, Js.toInt32(prefixTokens)).toDouble()
        val delta = if (pMissCur.isFinite() && pHitCur.isFinite()) maxOf(0.0, pMissCur - pHitCur)
        else maxOf(0.0, (if (curPe.isNaN() || curPe == 0.0) 0.0 else curPe) - (if (bestPe.isNaN() || bestPe == 0.0) 0.0 else bestPe)) * 2
        return P * delta / 1e6
    }

    /** chooseUpstream 内部的打分项（也给面板 / 调试用） */
    data class Scored(val slug: String, val pe: Double, val score: Double, val latencyMs: Double, val h: Double, val obs: Int,
                      val pMiss: Double, val pHit: Double, val cold: Boolean)

    private fun jsSub(a: Double, b: Double): Int { val d = a - b; return if (d.isNaN() || d == 0.0) 0 else if (d < 0) -1 else 1 }

    /**
     * price: [{ slug, pMiss, pHit?, ok?, latencyMs?, calibScale? }]；stats: 该模型的 ModelState（可空）
     * 返回选中的 slug（可能为 null）。
     */
    fun chooseUpstream(price: List<JsonObject>?, stats: ModelState?, current: String?, prefixTokens: Double, cfg: Settings = DEFAULTS): String? {
        val cur0 = current?.takeIf { it.isNotEmpty() }
        if (!cfg.enabled) return cur0 ?: price?.firstOrNull()?.get("slug")?.takeIf { Js.truthy(it) }?.let { Js.str(it) }
        val list = price ?: emptyList()
        val ups = stats?.upstreams ?: emptyMap<String, UpstreamStats>()
        val scored = ArrayList<Scored>()
        for (x in list) {
            val slugE = x["slug"]
            if (!Js.truthy(slugE)) continue
            val okE = x["ok"]
            if (okE is JsonPrimitive && !okE.isString && okE.content == "false") continue
            val slug = Js.str(slugE)
            val st = ups[slug] ?: UpstreamStats()
            if (Js.toInt32(st.fails) >= cfg.failBreak) continue
            val obs = Js.toInt32(st.obs)
            val h = if (obs >= cfg.minObs) hitQuantile(st.a, st.b, cfg.zPessimistic) else cfg.defaultH
            val ph = x["pHit"].let { if (it == null || it is JsonNull) x["pMiss"] else it }
            val pe = effectivePrice(x["pMiss"], ph, h)
            val lat = latencyOf(x, st)
            val score = effectiveScore(pe, lat, cfg)
            scored += Scored(slug, pe, score, lat, h, obs, Js.toNumber(x["pMiss"]), Js.toNumber(ph), obs < cfg.minObs)
        }
        if (scored.isEmpty()) return cur0
        val ripe = scored.filter { !it.cold }.toMutableList()
        if (ripe.isEmpty()) return cur0 ?: scored[0].slug
        ripe.sortWith { a, b ->
            jsSub(a.score, b.score).takeIf { it != 0 } ?: jsSub(a.pe, b.pe).takeIf { it != 0 } ?: Js.localeCompare(a.slug, b.slug)
        }
        val best = ripe[0]
        if (cur0 == null) return best.slug
        val cur = ripe.firstOrNull { it.slug == cur0 } ?: scored.firstOrNull { it.slug == cur0 } ?: return best.slug
        if (best.slug == cur0) return cur0
        val curSt = ups[cur0]
        val now = cfg.now ?: System.currentTimeMillis().toDouble()
        val idleMs = cfg.idleMs ?: (if (curSt != null && curSt.lastAt > 0) maxOf(0.0, now - curSt.lastAt) else 0.0)
        if (cfg.stickyIdleMs > 0 && idleMs >= cfg.stickyIdleMs && !(curSt != null && Js.toInt32(curSt.fails) > 0)) {
            val m = if (cfg.idleSwitchMargin > 0) cfg.idleSwitchMargin else DEFAULTS.idleSwitchMargin
            return if (best.score < cur.score * m) best.slug else cur0
        }
        if (!(best.score < cur.score * cfg.switchMargin)) return cur0
        val savedPerTurn = maxOf(0, Js.toInt32(prefixTokens)) * (cur.pe - best.pe) / 1e6
        val cost = switchCost(cur.pe, best.pe, prefixTokens, cur.pMiss, cur.pHit)
        if (savedPerTurn * cfg.dwell > cost) return best.slug
        val peClose = Math.abs(cur.pe - best.pe) <= maxOf(1e-9, cur.pe * (1 - cfg.switchMargin))
        if (peClose) return best.slug
        return cur0
    }

    /** OpenRouter provider 字段：钉上游或回退 sort:price */
    fun buildProviderField(chosenSlug: String?, enabled: Boolean = true): JsonObject =
        if (!enabled || chosenSlug.isNullOrEmpty()) buildJsonObject { put("sort", "price") }
        else buildJsonObject {
            put("order", buildJsonArray { add(JsonPrimitive(chosenSlug)) })
            put("allow_fallbacks", true); put("require_parameters", true)
        }

    /** 面板摘要（用 DEFAULTS，不随 opts 变化，同 JS） */
    fun panelView(ms: ModelState?, priceMap: Map<String, JsonObject>?): JsonObject {
        val slug = ms?.current?.takeIf { it.isNotEmpty() }
        val st = if (slug != null) ms.upstreams[slug] else null
        var pe: Double? = null; var h: Double? = null
        val p = if (slug != null) priceMap?.get(slug) else null
        if (p != null) {
            h = if (st != null && Js.toInt32(st.obs) >= DEFAULTS.minObs) hitQuantile(st.a, st.b) else DEFAULTS.defaultH
            val ph = p["pHit"].let { if (it == null || it is JsonNull) p["pMiss"] else it }
            pe = effectivePrice(p["pMiss"], ph, h)
        } else if (st != null) {
            h = if (Js.toInt32(st.obs) >= DEFAULTS.minObs) hitQuantile(st.a, st.b) else DEFAULTS.defaultH
        }
        // lat：stats.latEwma>0 优先，否则 priceMap[slug].latencyMs 原值（|| 0）
        val latE: JsonElement = if (st != null && st.latEwma > 0) Js.number(st.latEwma)
            else p?.get("latencyMs")?.takeIf { Js.truthy(it) } ?: JsonPrimitive(0)
        val score = pe?.let { effectiveScore(it, Js.toNumber(latE)) }
        return buildJsonObject {
            put("upstream", slug?.let { JsonPrimitive(it) } ?: JsonNull)
            put("effectivePrice", pe?.let { Js.number(it) } ?: JsonNull)
            put("effectiveScore", score?.let { Js.number(it) } ?: JsonNull)
            put("latencyMs", if (Js.truthy(latE)) latE else JsonNull)
            put("hitRate", h?.let { Js.number(it) } ?: JsonNull)
            put("lastSwitchAt", Js.number(ms?.lastSwitchAt?.takeIf { !it.isNaN() } ?: 0.0))
            put("obs", JsonPrimitive(if (st != null) Js.toInt32(st.obs) else 0))
            p?.get("calibScale")?.let { put("calibScale", it) }
        }
    }

    fun recordSwitch(state: State, model: String, from: String?, to: String?, now: Double?): State {
        val ms = ensureModel(state, model)
        if (from != to) ms.lastSwitchAt = now(now)
        ms.current = to
        return state
    }

    /** 回放步骤 */
    data class Step(val prices: List<JsonObject>, val at: Double? = null, val prefixTokens: Double? = null,
                    val promptTokens: Double? = null, val hitTokens: Double? = null, val hit: Boolean? = null, val ok: Boolean? = null)
    data class ReplayResult(val trail: List<String?>, val switches: Int, val effCost: Double, val state: State, val current: String?) {
        fun toJson() = buildJsonObject {
            put("trail", JsonArray(trail.map { it?.let { s -> JsonPrimitive(s) } ?: JsonNull }))
            put("switches", switches); put("effCost", Js.number(effCost)); put("state", state.toJson())
            put("current", current?.let { JsonPrimitive(it) } ?: JsonNull)
        }
    }

    fun replay(steps: List<Step>, cfg: Settings = DEFAULTS, model: String = "m", prefixTokens0: Double? = null): ReplayResult {
        val state = State()
        val prefixTokens = prefixTokens0?.takeIf { it != 0.0 && !it.isNaN() } ?: 20000.0
        var current: String? = null
        var switches = 0
        var effCost = 0.0
        val trail = ArrayList<String?>()
        for (step in steps) {
            val chosen = chooseUpstream(step.prices, ensureModel(state, model), current, step.prefixTokens ?: prefixTokens, cfg)
            if (!current.isNullOrEmpty() && chosen != null && chosen.isNotEmpty() && chosen != current) {
                switches++
                recordSwitch(state, model, current, chosen, step.at)
            } else if (current.isNullOrEmpty() && !chosen.isNullOrEmpty()) {
                recordSwitch(state, model, null, chosen, step.at)
            }
            current = chosen
            val p = step.prices.firstOrNull { (it["slug"] as? JsonPrimitive)?.takeIf { s -> s.isString }?.content == chosen } ?: step.prices.firstOrNull()
            if (p != null) {
                val st = ensureUpstream(ensureModel(state, model), chosen.toString())
                val h = if (Js.toInt32(st.obs) >= cfg.minObs) hitQuantile(st.a, st.b) else cfg.defaultH
                val ph = p["pHit"].let { if (it == null || it is JsonNull) p["pMiss"] else it }
                val pe = effectivePrice(p["pMiss"], ph, h)
                val tok = step.promptTokens ?: prefixTokens
                effCost += tok * pe / 1e6
            }
            if (!chosen.isNullOrEmpty()) {
                observe(state, model, chosen, Observation(hitTokens = step.hitTokens, promptTokens = step.promptTokens ?: prefixTokens,
                    hit = step.hit, ok = step.ok), step.at)
            }
            trail += chosen
        }
        return ReplayResult(trail, switches, effCost, state, current)
    }
}
