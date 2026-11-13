package com.aichat.app.net

import com.aichat.app.domain.ModelRouter
import com.aichat.app.domain.WireMessage
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.Usage
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * providers.js planOpenRouterRoute / observeRoute + app.js 2213–2229、2324–2332 的发送前后路由步骤。
 */
object OpenRouterRouting {

    /** planOpenRouterRoute 的返回（toJson 键序同 JS） */
    data class RoutePlan(
        val slug: String?,
        val providerField: JsonObject?,
        val view: JsonObject?,
        val affinity: Boolean,
        val prices: List<JsonObject>? = null,
        val state: Router.State? = null,
        val reason: String? = null,
    ) {
        fun toJson(): JsonObject {
            val m = LinkedHashMap<String, JsonElement>()
            m["slug"] = slug?.let { JsonPrimitive(it) } ?: JsonNull
            m["providerField"] = providerField ?: JsonNull
            m["view"] = view ?: JsonNull
            m["affinity"] = JsonPrimitive(affinity)
            prices?.let { m["prices"] = JsonArray(it) }
            state?.let { m["state"] = it.toJson() }
            reason?.let { m["reason"] = JsonPrimitive(it) }
            return JsonObject(m)
        }
    }

    /**
     * 规划本轮上游。routerState 会被就地写入（ensureModel），同 JS。
     * @param cacheAffinity JS opts.cacheAffinity（app.js 不传 = true）；provider.cacheAffinity == false 也关闭
     */
    fun plan(provider: ProviderConfig?, model: String?, endpoints: JsonElement?, routerState: Router.State?,
             cacheAffinity: Boolean = true, orSort: String? = null, calib: JsonObject? = null, prefixTokens: Double = 0.0,
             routerOpts: Router.Settings = Router.DEFAULTS): RoutePlan {
        val affinity = cacheAffinity && provider != null && provider.cacheAffinity != false
        val sortField = ProviderRules.openRouterSortField(provider, orSort)
        if (!affinity) return RoutePlan(null, sortField, null, false)
        var prices = ModelCatalog.endpointRoutePrices(endpoints)
        if (calib != null) prices = Router.applyCalibScale(prices, calib, model)
        if (prices.isEmpty()) return RoutePlan(null, sortField, null, true, reason = "no-prices")
        val state = routerState ?: Router.State()
        val ms = Router.ensureModel(state, model ?: "")
        val chosen = Router.chooseUpstream(prices, ms, ms.current, prefixTokens, routerOpts)
        if (chosen.isNullOrEmpty()) return RoutePlan(null, sortField, Router.panelView(ms, null), true, prices, state, "no-choice")
        val priceMap = LinkedHashMap<String, JsonObject>()
        prices.forEach { p -> priceMap[Js.str(p["slug"])] = p }
        return RoutePlan(chosen, Router.buildProviderField(chosen), Router.panelView(ms, priceMap), true, prices, state)
    }

    /** observeRoute：usage（normalizeUsage 形）更新命中后验；prompt>0 用 hit/prompt，否则 hit>0 记整轮命中 */
    fun observeRoute(state: Router.State?, model: String?, slug: String?, prompt: Double?, hit: Double?, usageLatencyMs: Double?,
                     now: Double?, extraLatencyMs: Double? = null): Router.State {
        val st = state ?: Router.State()
        if (slug.isNullOrEmpty() || model.isNullOrEmpty()) return st
        val p = prompt ?: 0.0
        val h = hit ?: 0.0
        val latencyMs = if (extraLatencyMs != null && extraLatencyMs > 0) extraLatencyMs
            else if (usageLatencyMs != null && usageLatencyMs > 0) usageLatencyMs else 0.0
        val ev = if (p > 0) Router.Observation(hitTokens = h, promptTokens = p, ok = true, latencyMs = latencyMs.takeIf { it > 0 })
            else Router.Observation(hit = h > 0, ok = true, latencyMs = latencyMs.takeIf { it > 0 })
        Router.observe(st, model, slug, ev, now)
        return st
    }
    fun observeRoute(state: Router.State?, model: String?, slug: String?, usage: Usage?, now: Double?, extraLatencyMs: Double? = null) =
        observeRoute(state, model, slug, usage?.prompt?.toDouble(), usage?.hit?.toDouble(), null, now, extraLatencyMs)

    /** app.js：prefixEst = max(0, Σ content.length × 0.5 | 0)（UTF-16 长度，同 JS） */
    fun prefixEstimate(messages: List<WireMessage>): Double {
        val sum = messages.fold(0.0) { s, m -> s + m.content.length }
        return maxOf(0, Js.toInt32(sum * 0.5)).toDouble()
    }

    /** endpoints：modelMeta[model]._endpoints || modelMeta[model].endpoints || [] */
    fun endpointsFor(provider: ProviderConfig, model: String): JsonElement {
        val meta = provider.modelMeta[model] as? JsonObject
        return meta?.get("_endpoints")?.takeIf { Js.truthy(it) } ?: meta?.get("endpoints")?.takeIf { Js.truthy(it) } ?: JsonArray(emptyList())
    }
}

/**
 * ModelRouter 契约实现 + app.js 发送前后两步（beforeSend / afterResponse）。线程安全（单锁）。
 * 持久化：load / save 由 D 的存储层提供（router-affinity.json），每次状态变动后调用 save。
 */
class AffinityRouter(
    initial: JsonObject? = null,
    private val save: ((JsonObject) -> Unit)? = null,
    private val opts: Router.Settings = Router.DEFAULTS,
) : ModelRouter {
    private val lock = Any()
    private val st: Router.State = Router.State.fromJson(initial)

    /** 发送前结果：slug 非空时 ChatOptions.routeSlug / providerOrder = [slug]；affinityOff 时 ChatOptions.cacheAffinity = false */
    data class Pick(val slug: String?, val view: JsonObject?, val affinityOff: Boolean, val plan: OpenRouterRouting.RoutePlan)

    /** app.js 2213–2229 */
    fun beforeSend(provider: ProviderConfig, model: String, messages: List<WireMessage>, calib: JsonObject?, nowMs: Long): Pick? {
        if (!ProviderRules.isOpenRouterProvider(provider)) return null
        synchronized(lock) {
            val plan = OpenRouterRouting.plan(provider, model, OpenRouterRouting.endpointsFor(provider, model), st,
                calib = calib, prefixTokens = OpenRouterRouting.prefixEstimate(messages), routerOpts = opts.copy(now = nowMs.toDouble()))
            if (!plan.slug.isNullOrEmpty()) {
                val prev = st.models[model]?.current
                if (!prev.isNullOrEmpty() && prev != plan.slug) Router.recordSwitch(st, model, prev, plan.slug, nowMs.toDouble())
                else Router.ensureModel(st, model).current = plan.slug
                save?.invoke(st.toJson())
                return Pick(plan.slug, plan.view ?: Router.panelView(Router.ensureModel(st, model), null), false, plan)
            }
            return Pick(null, null, !plan.affinity, plan)
        }
    }

    /** app.js 2324–2332：成功且有 usage → observeRoute；失败 → markFail。返回新面板。 */
    fun afterResponse(model: String, slug: String?, ok: Boolean, usage: Usage?, latencyMs: Long?, nowMs: Long): JsonObject? {
        if (slug.isNullOrEmpty()) return null
        synchronized(lock) {
            if (ok && usage != null) OpenRouterRouting.observeRoute(st, model, slug, usage, nowMs.toDouble(), latencyMs?.toDouble())
            else if (!ok) Router.markFail(st, model, slug, nowMs.toDouble())
            else return null
            save?.invoke(st.toJson())
            return Router.panelView(Router.ensureModel(st, model), null)
        }
    }

    override fun chooseUpstream(model: String, routePrices: List<JsonObject>, prefixTokens: Long, nowMs: Long): String? = synchronized(lock) {
        val ms = Router.ensureModel(st, model)
        Router.chooseUpstream(routePrices, ms, ms.current, prefixTokens.toDouble(), opts.copy(now = nowMs.toDouble()))
    }

    override fun observe(model: String, slug: String, usage: Usage, latencyMs: Long?, ok: Boolean, nowMs: Long) {
        afterResponse(model, slug, ok, usage, latencyMs, nowMs)
    }

    override fun panelView(model: String): JsonObject = synchronized(lock) { Router.panelView(Router.ensureModel(st, model), null) }
    override fun state(): JsonObject = synchronized(lock) { st.toJson() }
}
