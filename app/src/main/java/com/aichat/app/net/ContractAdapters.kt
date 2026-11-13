package com.aichat.app.net

import com.aichat.app.SecretStore
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject

/*
 * 过渡适配层：Grok Bot 已定的契约变更（D 在 native/D 上改 Contracts.kt / Models.kt）落地前，B 先在这里写。
 * rebase 到 D 的契约 commit 后：
 *  - [NetOptions] 的字段改为直接读 ChatOptions.cacheSystem / cacheAffinity / orSort / orGemini / orMiniMax / routePrices，删掉本类；
 *  - [ProviderRegistry] 改为 KeyVault 提供的登记 baseUrl；
 *  - DefaultProviderClient 的 notices 回调改为发 StreamEvent.Notice(text)；
 *  - UsageCodec.toUsage 填 Usage.upstreamCost / cacheSaved / raw。
 */

/** ChatOptions 待加字段（约定 #2）。默认值 = JS opts 未设置时的行为。 */
data class NetOptions(
    val cacheSystem: Boolean = true,          // JS: opts.cacheSystem !== false
    val cacheAffinity: Boolean = true,        // JS: opts.cacheAffinity !== false
    val orSort: String? = null,               // JS: opts.orSort（null = 取 provider.orSort）
    val orGemini: Boolean = false,            // gcache 对本请求生效：不写 session_id
    val orMiniMax: Boolean = false,           // mmcache 对本请求生效：不写 session_id
    val routePrices: List<JsonObject> = emptyList(),   // [{slug,pMiss,pHit,ok,completion,latencyMs,calibScale?}]（ModelCatalog.endpointRoutePrices）
    // ---- routePrices 分支的其余 JS opts（routerState/routerModel/routerModelState/routeCurrent/prefixTokens/routerOpts/onRouteChosen） ----
    // TODO(D 契约 #2)：这些不进 ChatOptions（含可变状态与回调）；ChatEngine 通常先用 OpenRouterRouting.plan 选好 slug 再走 routeSlug。
    val routerState: Router.State? = null,
    val routerModel: String? = null,
    val routerModelState: Router.ModelState? = null,
    val routeCurrent: String? = null,
    val prefixTokens: Double = 0.0,
    val routerOpts: Router.Settings = Router.DEFAULTS,
    val onRouteChosen: ((String) -> Unit)? = null,
)

/** 服务商登记的 baseUrl（约定 #5；旧版 SecretStore r:<id> = baseUrl\nauthType）。null = 未登记。 */
fun interface ProviderRegistry {
    fun registeredBaseUrl(keyId: String): String?
}

/** D 的契约落地前的实现：直接读 SecretStore 的登记（只读，不改加密格式）。 */
class SecretStoreRegistry(private val store: SecretStore) : ProviderRegistry {
    override fun registeredBaseUrl(keyId: String): String? = store.reg(keyId)?.getOrNull(0)
}

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
