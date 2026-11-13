package com.aichat.app.domain.cost

import com.aichat.app.domain.model.*
import kotlinx.serialization.json.JsonObject

/** 工作流 B：www/cost-core.js + usage-stats.js + balance.js + search.js（纯 Kotlin，golden 比对） */
interface CostCore {
    fun priceFor(model: String, prices: JsonObject): JsonObject?   // { miss, hit, out, write? } USD / 1M token
    fun costOf(usage: Usage, price: JsonObject, atMs: Long, peak: JsonObject?): Double
    /** EWMA 校准（EWMA_ALPHA / BIAS_ABS_THRESHOLD / BIAS_STREAK_MARK 同 JS 常量） */
    fun reconcile(calib: JsonObject, model: String, estimated: Double, billed: Double): JsonObject
    fun calibView(calib: JsonObject): JsonObject
}

interface UsageStats {
    fun makeEntry(usage: Usage, type: String, convId: String?, providerId: String, model: String, msgId: String?, atMs: Long, prices: JsonObject): JsonObject
    fun byDay(log: List<JsonObject>, fromMs: Long, toMs: Long): List<JsonObject>
    fun groupBy(log: List<JsonObject>, key: String): Map<String, JsonObject>
    fun toCsv(log: List<JsonObject>): String
}

/** 余额：SUPPORTED = deepseek / siliconflow / moonshot / openrouter；缓存 balance-cache.json */
interface BalanceClient { suspend fun fetch(provider: ProviderConfig): Result<JsonObject> }

/** 联网搜索：tavily / bocha / brave / searxng；Key 名 search_key:<id> */
interface SearchClient {
    suspend fun search(query: String, settings: AppSettings): Result<List<JsonObject>>   // [{title,url,content}]
    fun buildSearchContext(results: List<JsonObject>, query: String): String
}
