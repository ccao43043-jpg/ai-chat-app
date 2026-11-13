package com.aichat.app.domain.cost

import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.net.Js
import com.aichat.app.net.ModelCatalog
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * OpenRouter endpoints 最低价 → 用量 / 路由共用价目（usageState.prices，形如 { model: { miss, hit, out, source, syncedAt } }）。
 *
 * 对齐 cost-core.js mergeFloorPrice、providers.js syncFloorPrices、app.js syncUsagePricesFromEndpoints / syncPricesFromProviderMeta。
 * 与 JS 的区别（有意）：全部是纯函数，输入 → 新价目，不读写任何全局、不调用保存；
 * 所以不存在 v0.26.0 那个「syncPricesFromProviderMeta 在 const saveUsageMeta 声明前就调用它」的 TDZ 时序问题——
 * 调用方拿到 changed=true 后自己决定何时保存（ChatEngine / UsageRepo 初始化完成后）。
 */
object FloorPrices {
    /** USAGE_DEFAULT_PRICES.default */
    private val USAGE_DEFAULT = JsonObject(mapOf("hit" to JsonPrimitive(0), "miss" to JsonPrimitive(0.5), "out" to JsonPrimitive(1.5)))

    /** finNum：null / '' → null；数字或数字串且有限 → 数 */
    fun finNum(v: JsonElement?): Double? {
        if (v == null || v is JsonNull) return null
        if (v is JsonPrimitive && v.isString && v.content.isEmpty()) return null
        val n = Js.toNumber(v)
        return if (n.isFinite()) n else null
    }

    /** mergeFloorPrice(prices, model, floor, now)：最低价写进 miss/hit/out，缺的用旧条目 → bag.default → {0,0.5,1.5} 补齐 */
    fun mergeFloorPrice(prices: JsonObject?, model: String?, floor: JsonObject?, now: Long): JsonObject {
        if (model.isNullOrEmpty() || floor == null) return prices ?: JsonObject(emptyMap())
        val bag = LinkedHashMap<String, JsonElement>(prices ?: emptyMap())
        val prev = (bag[model] as? JsonObject) ?: JsonObject(emptyMap())
        val rec = LinkedHashMap<String, JsonElement>(prev)
        if (Js.toNumber(floor["prompt"]) > 0) rec["miss"] = floor["prompt"]!!
        if (Js.toNumber(floor["cacheRead"]) > 0) rec["hit"] = floor["cacheRead"]!!
        if (Js.toNumber(floor["completion"]) > 0) rec["out"] = floor["completion"]!!
        val bd = bag["default"] as? JsonObject
        val def = if (bd != null && finNum(bd["miss"]) != null) bd else USAGE_DEFAULT
        fun undef(e: JsonElement?) = e ?: JsonNull   // JS 里 undefined 赋值会在 JSON 中消失；这里 def 缺键时退成 null（极端情况）
        if (finNum(rec["miss"]) == null) rec["miss"] = if (finNum(prev["miss"]) != null) prev["miss"]!! else undef(def["miss"])
        if (finNum(rec["out"]) == null) rec["out"] = if (finNum(prev["out"]) != null) prev["out"]!! else undef(def["out"])
        if (finNum(rec["hit"]) == null) rec["hit"] = if (finNum(prev["hit"]) != null) prev["hit"]!! else (if (finNum(def["hit"]) != null) def["hit"]!! else JsonPrimitive(0))
        if (!Js.truthy(rec["source"])) rec["source"] = JsonPrimitive("openrouter-floor")
        rec["syncedAt"] = JsonPrimitive(if (now != 0L) now else System.currentTimeMillis())
        bag[model] = JsonObject(rec)
        return JsonObject(bag)
    }

    /** providers.js syncFloorPrices：endpoints 求最低价（pricingFromRaw(pr, 1)，不乘折扣）后合并；无最低价原样返回 */
    fun syncFloorPrices(prices: JsonObject?, model: String?, endpoints: JsonElement?, now: Long): JsonObject? {
        val floor = ModelCatalog.floorPricingFromEndpoints(endpoints) ?: return prices
        return mergeFloorPrice(prices, model, floor, now)
    }

    /** JS === （undefined===undefined，数字按值，字符串按内容，类型不同即不等） */
    private fun strictEq(a: JsonElement?, b: JsonElement?): Boolean {
        if (a == null || b == null) return a == null && b == null
        if (a is JsonNull || b is JsonNull) return a is JsonNull && b is JsonNull
        if (a is JsonPrimitive && b is JsonPrimitive) {
            if (a.isString != b.isString) return false
            if (a.isString) return a.content == b.content
            val ab = a.content == "true" || a.content == "false"; val bb = b.content == "true" || b.content == "false"
            if (ab || bb) return a.content == b.content
            return Js.toNumber(a) == Js.toNumber(b)
        }
        return a === b   // 对象 / 数组：引用相等
    }

    /**
     * app.js syncUsagePricesFromEndpoints：返回新价目（有变化）或 null（无最低价 / miss、hit、out 都没变）。
     * 调用方拿到非 null 再保存。
     */
    fun syncUsagePricesFromEndpoints(prices: JsonObject?, modelId: String?, endpoints: JsonElement?, now: Long): JsonObject? {
        if (modelId.isNullOrEmpty() || endpoints == null || endpoints is JsonNull) return null
        val prev = prices?.get(modelId)?.takeIf { Js.truthy(it) } as? JsonObject
        val next = syncFloorPrices(prices, modelId, endpoints, now)
        val rec = next?.get(modelId)?.takeIf { Js.truthy(it) } as? JsonObject ?: return null
        if (prev != null && strictEq(prev["miss"], rec["miss"]) && strictEq(prev["hit"], rec["hit"]) && strictEq(prev["out"], rec["out"])) return null
        return next
    }

    /** syncPricesFromProviderMeta 的结果 */
    data class SyncResult(val prices: JsonObject, val changed: Boolean)

    /**
     * app.js syncPricesFromProviderMeta：遍历 providers[].modelMeta[mid]._endpoints || endpoints（非空数组），逐个同步。
     * 纯函数：不保存。顺序同 JS（providers 顺序 × modelMeta 键序），后者覆盖前者。
     */
    fun syncPricesFromProviderMeta(providers: List<ProviderConfig>, prices: JsonObject?, now: Long): SyncResult {
        var cur = prices ?: JsonObject(emptyMap())
        var changed = false
        for (p in providers) {
            for ((mid, m) in p.modelMeta) {
                val mo = m as? JsonObject ?: continue
                val eps = mo["_endpoints"]?.takeIf { Js.truthy(it) } ?: mo["endpoints"]?.takeIf { Js.truthy(it) } ?: continue
                if (eps !is JsonArray || eps.isEmpty()) continue
                syncUsagePricesFromEndpoints(cur, mid, eps, now)?.let { cur = it; changed = true }
            }
        }
        return SyncResult(cur, changed)
    }
}
