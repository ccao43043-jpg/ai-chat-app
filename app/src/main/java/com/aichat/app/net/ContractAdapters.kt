package com.aichat.app.net

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/**
 * OpenRouter routePrices 分支里 JS opts 的其余字段（routerState / routerModel / routerModelState / routeCurrent / prefixTokens /
 * routerOpts / onRouteChosen）。含可变状态与回调，不进契约 ChatOptions（契约只有 routePrices）；B 内部可选参数。
 * app.js 实际走 planOpenRouterRoute → routeSlug（见 [AffinityRouter.beforeSend]），这里只为与 providers.js 逐分支对齐。
 */
data class RouteInputs(
    val routerState: Router.State? = null,
    val routerModel: String? = null,
    val routerModelState: Router.ModelState? = null,
    val routeCurrent: String? = null,
    val prefixTokens: Double = 0.0,
    val routerOpts: Router.Settings = Router.DEFAULTS,
    val onRouteChosen: ((String) -> Unit)? = null,
)

/** RFC 7386 JSON Merge Patch（约定 #3）：对象深合并、null 删除键、非对象整体替换；已有键保持原位置，新键追加。 */
object JsonMergePatch {
    fun apply(target: JsonElement?, patch: JsonElement): JsonElement {
        if (patch !is JsonObject) return patch
        val base = LinkedHashMap<String, JsonElement>((target as? JsonObject) ?: emptyMap())
        for ((k, v) in patch) {
            if (v is JsonNull) base.remove(k)
            else base[k] = apply(base[k], v)
        }
        return JsonObject(base)
    }
    fun applyObject(target: JsonObject, patch: JsonObject): JsonObject = apply(target, patch) as JsonObject
}
