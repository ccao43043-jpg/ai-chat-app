package com.aichat.app.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * providers.js migrateSettings / migrateModelName / migrateConversation 的移植。
 * [hook] 就是 D 的 StoreMigrationService(providerMigration = …) 要的签名：(settings.json 原始 JSON) → 新 JSON；不需迁移返回 null。
 * 不碰 API Key（同 JS）。纯函数：不改入参。
 */
object ProviderMigration {
    /** StoreMigrationService 的 providerMigration 钩子（AppGraph / DataGraph 由 D 接线） */
    val hook: (JsonObject) -> JsonObject? = { json -> migrateSettings(json).takeIf { it.second }?.first }

    private fun strs(e: JsonElement?): List<JsonElement> = (e as? JsonArray) ?: emptyList()
    private fun jsEq(a: JsonElement, b: JsonElement): Boolean =
        a is JsonPrimitive && b is JsonPrimitive && a !is JsonNull && b !is JsonNull && a.isString == b.isString && a.content == b.content

    /** sameSet：filter(Boolean) 后长度相同且 x 的每项都在 y 中 */
    private fun sameSet(a: JsonElement?, b: JsonElement?): Boolean {
        val x = strs(a).filter { Js.truthy(it) }; val y = strs(b).filter { Js.truthy(it) }
        return x.size == y.size && x.all { v -> y.any { jsEq(it, v) } }
    }
    private fun dedupe(arr: List<JsonElement>): List<JsonElement> {
        val out = ArrayList<JsonElement>()
        for (v in arr) if (Js.truthy(v) && out.none { jsEq(it, v) }) out += v
        return out
    }

    /** 已下线模型名 → 替代模型；无需迁移原样返回 */
    fun migrateModelName(presetId: String?, model: String?): String? {
        val m = ProviderPresets.RETIRED[presetId ?: return model] as? JsonObject ?: return model
        val n = m[model ?: return model]
        return if (Js.truthy(n)) Js.str(n) else model
    }
    private fun migrateModelEl(presetId: String?, e: JsonElement): JsonElement {
        if (e !is JsonPrimitive || e is JsonNull) return e
        val n = migrateModelName(presetId, e.content)
        return if (n == e.content) e else JsonPrimitive(n)
    }

    /** migrateSettings：返回 (settings, changed)。settingsVersion ≥ 2 原样返回 */
    fun migrateSettings(settings: JsonObject?): Pair<JsonObject, Boolean> {
        val s = LinkedHashMap<String, JsonElement>(settings ?: emptyMap())
        val ver = s["settingsVersion"].let { if (Js.truthy(it)) Js.toNumber(it) else 1.0 }
        if (ver >= ProviderPresets.SETTINGS_VERSION) return JsonObject(s) to false
        val provs = s["providers"] as? JsonArray
        if (provs != null) {
            s["providers"] = JsonArray(provs.map { pe ->
                val p0 = pe as? JsonObject ?: return@map pe
                val presetId = (p0["presetId"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
                val old = ProviderPresets.OLD_DEFAULTS[presetId ?: ""] as? JsonObject
                val preset = ProviderPresets.preset(presetId)
                if (old == null || preset == null) return@map pe
                val p = LinkedHashMap<String, JsonElement>(p0)
                if (sameSet(p["models"], old["models"])) p["models"] = preset["models"]!!
                else p["models"] = JsonArray(dedupe(strs(p["models"]).map { migrateModelEl(presetId, it) }))
                if ((p["models"] as JsonArray).isEmpty()) p["models"] = preset["models"]!!
                if (Js.truthy(old["imageModel"]) && p["imageModel"]?.let { jsEq(it, old["imageModel"]!!) } == true) p["imageModel"] = preset["imageModel"]!!
                if (Js.truthy(old["baseUrl"])) {
                    val b = p["baseUrl"]?.takeIf { Js.truthy(it) }?.let { Js.str(it) } ?: ""
                    if (b.trimEnd('/') == Js.str(old["baseUrl"])) p["baseUrl"] = preset["baseUrl"]!!
                }
                if (Js.truthy(old["name"]) && p["name"]?.let { jsEq(it, old["name"]!!) } == true) p["name"] = preset["name"]!!
                JsonObject(p)
            })
        }
        val lpId = s["lastProviderId"]
        val lp = (s["providers"] as? JsonArray)?.firstOrNull { pe -> (pe as? JsonObject)?.let { o -> o["id"].let { id ->   // ===：undefined===undefined、null===null 也算
                (id == null && lpId == null) || (id != null && lpId != null && (jsEq(id, lpId) || (id is JsonNull && lpId is JsonNull))) } } == true } as? JsonObject
        val lm = s["lastModel"]
        if (lp != null && Js.truthy(lm) && lm is JsonPrimitive) {
            s["lastModel"] = migrateModelEl((lp["presetId"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content, lm)
        }
        s["settingsVersion"] = JsonPrimitive(ProviderPresets.SETTINGS_VERSION)
        return JsonObject(s) to true
    }

    /** migrateConversation：按对话所属服务商迁移模型名；返回新 model（无变化返回 null） */
    fun migrateConversationModel(providerPresetId: String?, model: String?): String? {
        val n = migrateModelName(providerPresetId, model)
        return if (n != model) n else null
    }
}
