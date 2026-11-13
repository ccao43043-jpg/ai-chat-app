package com.aichat.app.net

import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Locale

/** providers.js 中与服务商判定 / OpenRouter / max_tokens 相关的纯函数（逐个对照 JS，golden 测试比对） */
object ProviderRules {
    val STREAM_USAGE_PRESETS = listOf("openai", "deepseek", "qwen", "qwen-intl", "openrouter")
    private val JSON_MODE_PRESETS = listOf("openai", "deepseek", "qwen", "qwen-intl", "openrouter")
    private val RE_DEEPSEEK = Regex("//api\\.deepseek\\.com", RegexOption.IGNORE_CASE)
    private val RE_DEEPSEEK_OPENAI = Regex("//api\\.(deepseek|openai)\\.com", RegexOption.IGNORE_CASE)
    private val RE_QWEN = Regex("dashscope(-intl|-us)?\\.aliyuncs\\.com|\\.maas\\.aliyuncs\\.com|dashscope", RegexOption.IGNORE_CASE)
    private val RE_OPENROUTER = Regex("openrouter\\.ai", RegexOption.IGNORE_CASE)

    /** 阿里云百炼 / DashScope 接口 */
    fun isQwenEndpoint(p: ProviderConfig?): Boolean {
        if (p == null) return false
        if (p.presetId == "qwen" || p.presetId == "qwen-intl") return true
        return RE_QWEN.containsMatchIn(p.baseUrl)
    }
    fun streamUsageEnabled(p: ProviderConfig?): Boolean {
        if (p == null || p.type != ProviderType.OPENAI) return false
        p.streamUsage?.let { return it }
        return p.presetId in STREAM_USAGE_PRESETS || RE_DEEPSEEK.containsMatchIn(p.baseUrl) || isQwenEndpoint(p)
    }
    fun jsonModeSupported(p: ProviderConfig?): Boolean {
        if (p == null || p.type != ProviderType.OPENAI) return false
        return p.presetId in JSON_MODE_PRESETS || RE_DEEPSEEK_OPENAI.containsMatchIn(p.baseUrl) || isQwenEndpoint(p)
    }
    fun isOpenRouterProvider(p: ProviderConfig?): Boolean {
        if (p == null) return false
        return p.presetId == "openrouter" || RE_OPENROUTER.containsMatchIn(p.baseUrl)
    }
    internal fun isOpenRouterBase(presetId: String, trimmedBase: String) = presetId == "openrouter" || RE_OPENROUTER.containsMatchIn(trimmedBase)

    // ---------------- OpenRouter ----------------
    private val OR_SORTS = setOf("balanced", "price", "throughput")
    fun normalizeOrSort(v: String?): String { val s = (v ?: "").lowercase(Locale.ROOT); return if (s in OR_SORTS) s else "balanced" }
    /** 无钉定时的 provider 字段；balanced 返回 null（不设 sort） */
    fun openRouterSortField(provider: ProviderConfig?, optsOrSort: String? = null): JsonObject? {
        val sort = normalizeOrSort(optsOrSort ?: provider?.orSort)
        if (sort == "balanced") return null
        return buildJsonObject { put("sort", sort) }
    }
    /** router.js buildProviderField(slug, {enabled:true}) */
    fun buildProviderField(chosenSlug: String?, enabled: Boolean = true): JsonObject =
        if (!enabled || chosenSlug.isNullOrEmpty()) buildJsonObject { put("sort", "price") }
        else buildJsonObject {
            put("order", buildJsonArray { add(JsonPrimitive(chosenSlug)) })
            put("allow_fallbacks", true)
            put("require_parameters", true)
        }

    /** 稳定 session_id：FNV-1a ×4 → UUID 形状（与 cache-common.js sessionIdFor(convId,'or') 逐字一致） */
    fun orSessionIdFor(convId: String?, ns: String? = null): String {
        if (convId.isNullOrEmpty()) return ""
        val n = if (ns.isNullOrEmpty()) "or" else ns
        val s = "$n:$convId"
        val h = fnv(s) + fnv("a$s") + fnv("b$s") + fnv("c$s")
        return h.substring(0, 8) + "-" + h.substring(8, 12) + "-" + h.substring(12, 16) + "-" + h.substring(16, 20) + "-" + h.substring(20, 32)
    }
    fun fnv(str: String): String {
        var h = 0x811c9dc5.toInt()
        for (ch in str) { h = h xor ch.code; h *= 0x01000193 }
        return Integer.toHexString(h).padStart(8, '0')
    }

    // ---------------- max_tokens ----------------
    const val SAFE_DEFAULT_MAX_TOKENS = 8192
    const val MIN_DOWNGRADE_MAX_TOKENS = 256

    /** resolveMaxTokens(provider, model, userMax)；userMax 允许 JS 原值（''、数字串、数字、null） */
    fun resolveMaxTokens(modelMeta: JsonObject?, model: String?, userMax: JsonElement?): Double {
        // typeof userMax === 'number' ? userMax : parseFloat(userMax)
        val n = if (userMax is JsonPrimitive && userMax !is JsonNull && !userMax.isString && userMax.booleanOrNull == null)
            userMax.doubleOrNull ?: Double.NaN
        else Js.parseFloat(Js.str(userMax))
        val meta = if (modelMeta != null && !model.isNullOrEmpty()) modelMeta[model] as? JsonObject else null
        val rawCap = meta?.get("maxOutput")
        val capNum = if (rawCap == null) Double.NaN else Js.toNumber(rawCap)
        val modelCap = if (capNum > 0) capNum else 0.0
        if (!n.isNaN() && n > 0) return if (modelCap > 0) minOf(n, modelCap) else n
        if (modelCap > 0) return minOf(modelCap, SAFE_DEFAULT_MAX_TOKENS.toDouble())
        return SAFE_DEFAULT_MAX_TOKENS.toDouble()
    }
    /** 设置里的 maxTokens（Int? / 未设）→ 发出的 max_tokens */
    fun resolveMaxTokens(provider: ProviderConfig?, model: String?, userMax: Int?): Int =
        resolveMaxTokens(provider?.modelMeta, model, userMax?.let { JsonPrimitive(it) }).let { if (it >= Int.MAX_VALUE) Int.MAX_VALUE else it.toInt() }

    private val AFFORD = Regex("can only afford\\s+(\\d+)", RegexOption.IGNORE_CASE)
    /** OpenRouter 402 文案中的 can only afford N */
    fun parseAffordTokens(text: String?): Long? {
        val m = AFFORD.find(text ?: "null") ?: return null
        val n = m.groupValues[1].toBigInteger()
        return if (n.signum() > 0) (if (n.bitLength() < 63) n.toLong() else Long.MAX_VALUE) else null
    }
    /** 402 降级：floor(afford*0.8)，至少 256 */
    fun downgradeMaxTokens(afford: Double?, min: Int? = null): Long {
        val lo = if (min != null && min > 0) min.toLong() else MIN_DOWNGRADE_MAX_TOKENS.toLong()
        val a = afford ?: 0.0
        if (!(a > 0)) return lo
        return maxOf(lo, Math.floor(a * 0.8).toLong())
    }
}
