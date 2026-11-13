package com.aichat.app.net

import com.aichat.app.domain.model.Usage
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * providers.js normalizeUsage / mergeUsage。输出保持 JS 的 JsonObject 形状（含 cost / upstreamCost / cacheSaved 等 Usage 未建模字段），
 * [toUsage] 再转成领域 Usage。
 */
object UsageCodec {
    private fun obj(e: JsonElement?) = e as? JsonObject

    fun normalizeUsage(type: String, u: JsonElement?): JsonObject? {
        val o = u as? JsonObject ?: return null
        val out = LinkedHashMap<String, JsonElement>()
        fun n(k: String) = Js.num(o[k])
        when (type) {
            "anthropic" -> {
                val input = n("input_tokens"); val read = n("cache_read_input_tokens"); val write = n("cache_creation_input_tokens")
                if (input != null || read != null || write != null) {
                    val prompt = (input ?: 0.0) + (read ?: 0.0) + (write ?: 0.0)
                    out["prompt"] = Js.number(prompt)
                    if (read != null || write != null) {
                        val hit = read ?: 0.0
                        out["hit"] = Js.number(hit); out["miss"] = Js.number(prompt - hit)
                        out["cacheSupported"] = JsonPrimitive(true); out["source"] = JsonPrimitive("anthropic")
                        if (write != null && write != 0.0) out["cacheWrite"] = o["cache_creation_input_tokens"]!!
                    }
                }
                if (n("output_tokens") != null) out["completion"] = o["output_tokens"]!!
            }
            "gemini" -> {
                if (n("promptTokenCount") != null) out["prompt"] = o["promptTokenCount"]!!
                n("candidatesTokenCount")?.let { out["completion"] = Js.number(it + (n("thoughtsTokenCount") ?: 0.0)) }
                n("cachedContentTokenCount")?.let { hit ->
                    out["hit"] = o["cachedContentTokenCount"]!!
                    out["miss"] = Js.number((Js.num(out["prompt"]) ?: 0.0) - hit)
                    out["cacheSupported"] = JsonPrimitive(true); out["source"] = JsonPrimitive("gemini")
                }
            }
            else -> {
                if (n("prompt_tokens") != null) out["prompt"] = o["prompt_tokens"]!!
                if (n("completion_tokens") != null) out["completion"] = o["completion_tokens"]!!
                val det = obj(o["prompt_tokens_details"]) ?: JsonObject(emptyMap())
                val prompt0 = Js.num(out["prompt"])
                if (n("prompt_cache_hit_tokens") != null) { // DeepSeek
                    val hit = n("prompt_cache_hit_tokens")!!
                    out["hit"] = o["prompt_cache_hit_tokens"]!!
                    val missRaw = n("prompt_cache_miss_tokens")
                    val miss = missRaw ?: ((prompt0 ?: 0.0) - hit)
                    out["miss"] = if (missRaw != null) o["prompt_cache_miss_tokens"]!! else Js.number(miss)
                    if (prompt0 == null) out["prompt"] = Js.number(hit + miss)
                    out["cacheSupported"] = JsonPrimitive(true); out["source"] = JsonPrimitive("deepseek")
                } else if (Js.num(det["cached_tokens"]) != null) {
                    val hit = Js.num(det["cached_tokens"])!!
                    out["hit"] = det["cached_tokens"]!!; out["miss"] = Js.number((prompt0 ?: 0.0) - hit)
                    out["cacheSupported"] = JsonPrimitive(true); out["source"] = JsonPrimitive("openai")
                } else if (n("cache_read_input_tokens") != null || n("cached_tokens") != null) {
                    val key = if (n("cache_read_input_tokens") != null) "cache_read_input_tokens" else "cached_tokens"
                    out["hit"] = o[key]!!; out["miss"] = Js.number((prompt0 ?: 0.0) - n(key)!!)
                    out["cacheSupported"] = JsonPrimitive(true); out["source"] = JsonPrimitive("openai")
                }
                // OpenRouter：实际扣费与缓存节省
                if (n("cost") != null) out["cost"] = o["cost"]!!
                val cd = obj(o["cost_details"])
                if (cd != null && Js.num(cd["upstream_inference_cost"]) != null) out["upstreamCost"] = cd["upstream_inference_cost"]!!
                if (n("cache_discount") != null) out["cacheSaved"] = o["cache_discount"]!!
                else if (n("cost_cache") != null && n("cost_cache")!! < 0) out["cacheSaved"] = Js.number(-n("cost_cache")!!)
                else if (cd != null && Js.num(cd["cache_discount"]) != null) out["cacheSaved"] = cd["cache_discount"]!!
                val cw = Js.num(det["cache_write_tokens"])
                if (cw != null && cw > 0 && out["cacheWrite"] == null) out["cacheWrite"] = det["cache_write_tokens"]!!
                if (Js.num(det["cache_creation_input_tokens"]) != null) {
                    out["cacheWrite"] = det["cache_creation_input_tokens"]!!
                    if (out["hit"] == null) {
                        out["hit"] = JsonPrimitive(0); out["miss"] = out["prompt"] ?: JsonPrimitive(0)
                        out["cacheSupported"] = JsonPrimitive(true); out["source"] = JsonPrimitive("openai")
                    }
                }
            }
        }
        return if (out.isEmpty()) null else JsonObject(out)
    }

    fun mergeUsage(a: JsonObject?, b: JsonObject?): JsonObject? {
        if (b == null) return a
        val out = LinkedHashMap<String, JsonElement>(a ?: emptyMap())
        for ((k, v) in b) out[k] = v
        if (Js.truthy(out["cacheSupported"]) && out["prompt"] != null && out["hit"] != null) {
            val miss = Js.toNumber(out["prompt"]) - Js.toNumber(out["hit"])
            out["miss"] = if (miss.isNaN()) JsonNull else Js.number(maxOf(0.0, miss))
        }
        return JsonObject(out)
    }

    private fun long(e: JsonElement?): Long? = Js.num(e)?.toLong()
    /** 归一化 usage（JS 形状）→ 契约 Usage；raw = 服务商原始 usage JSON（多块时浅合并，后到覆盖） */
    fun toUsage(u: JsonObject?, raw: JsonObject? = null): Usage? {
        if (u == null) return null
        return Usage(
            prompt = long(u["prompt"]), completion = long(u["completion"]), hit = long(u["hit"]), miss = long(u["miss"]),
            cacheWrite = long(u["cacheWrite"]),
            cacheSupported = (u["cacheSupported"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.booleanOrNull,
            source = (u["source"] as? JsonPrimitive)?.takeIf { it.isString }?.content,
            costUsd = Js.num(u["cost"]),
            upstreamCost = Js.num(u["upstreamCost"]),
            cacheSaved = Js.num(u["cacheSaved"]),
            raw = raw,
        )
    }
}
