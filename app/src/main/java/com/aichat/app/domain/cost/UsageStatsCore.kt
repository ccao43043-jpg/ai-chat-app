package com.aichat.app.domain.cost

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * usage-stats.js 的 VERSION / LOG_LIMIT / DEFAULT_PRICES / emptyState / normalize（以及 app.js usageMetaOf）。
 * D 的 FileUsageRepository 只管文件；读出 meta + log 后经 [normalize] 得到与 JS usageState 同形的状态。
 */
object UsageStatsCore {
    const val VERSION = 1
    const val LOG_LIMIT = 5000
    /** CostCore.USAGE_DEFAULT_PRICES：DEFAULT_PRICES + default 兜底（键序同 JS） */
    val DEFAULT_PRICES: JsonObject = com.aichat.app.net.Js.json.parseToJsonElement(
        """{"deepseek-flash":{"hit":0.006,"miss":0.3,"out":1.2,"match":"deepseek"},"deepseek-v4-pro":{"hit":0.044,"miss":1.32,"out":3.96,"match":"deepseek-v4-pro,deepseek-pro"},"default":{"hit":0,"miss":0.5,"out":1.5}}"""
    ) as JsonObject
    private val PRICE_MODES = setOf("auto", "peak", "offpeak")

    fun emptyState(): JsonObject = JsonObject(linkedMapOf(
        "version" to JsonPrimitive(VERSION), "backfilled" to JsonPrimitive(false), "log" to JsonArray(emptyList()),
        "prices" to DEFAULT_PRICES, "priceMode" to JsonPrimitive("auto"), "calib" to JsonObject(emptyMap())))

    /** Object.assign 对字符串源会按下标展开（"ab" → {0:"a",1:"b"}）；数字 / 布尔 / null 无效果 */
    private fun assignSource(e: JsonElement?): Map<String, JsonElement> = when {
        e is JsonObject -> e
        e is JsonArray -> e.withIndex().associate { (i, v) -> i.toString() to v }
        e is JsonPrimitive && e.isString -> e.content.withIndex().associate { (i, c) -> i.toString() to JsonPrimitive(c.toString()) }
        else -> emptyMap()
    }

    /** normalize(raw)：补齐默认字段、prices 叠加默认价目、log 非数组 → []、priceMode 非法 → auto、calib 非对象 → {}、version = 1 */
    fun normalize(raw: JsonElement?): JsonObject {
        val s = LinkedHashMap<String, JsonElement>(emptyState())
        val src = if (raw == null || raw is JsonNull || (raw is JsonPrimitive && !com.aichat.app.net.Js.truthy(raw))) emptyMap() else assignSource(raw)
        s.putAll(src)
        val pr = s["prices"]
        s["prices"] = com.aichat.app.net.Js.jsObject(LinkedHashMap<String, JsonElement>(DEFAULT_PRICES).apply {
            if (com.aichat.app.net.Js.truthy(pr)) putAll(assignSource(pr))
        })
        if (s["log"] !is JsonArray) s["log"] = JsonArray(emptyList())
        val pm = s["priceMode"]
        if (!(pm is JsonPrimitive && pm.isString && pm.content in PRICE_MODES)) s["priceMode"] = JsonPrimitive("auto")
        val c = s["calib"]
        if (!(c is JsonObject || c is JsonArray)) s["calib"] = JsonObject(emptyMap())
        s["version"] = JsonPrimitive(VERSION)
        return com.aichat.app.net.Js.jsObject(s)
    }

    /** app.js usageMetaOf：{ version, backfilled, prices, priceMode, calib } */
    fun metaOf(st: JsonObject): JsonObject = JsonObject(linkedMapOf(
        "version" to (st["version"] ?: JsonNull), "backfilled" to (st["backfilled"] ?: JsonNull), "prices" to (st["prices"] ?: JsonNull),
        "priceMode" to (st["priceMode"] ?: JsonNull), "calib" to (st["calib"]?.takeIf { com.aichat.app.net.Js.truthy(it) } ?: JsonObject(emptyMap()))))
}
