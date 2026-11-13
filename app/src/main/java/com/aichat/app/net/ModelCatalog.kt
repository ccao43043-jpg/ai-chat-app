package com.aichat.app.net

import com.aichat.app.domain.BuiltRequest
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * providers.js 的模型列表 / 元数据 / 价格 / OpenRouter endpoints 部分（纯函数，golden 对齐）：
 * classifyModel、buildModelsRequest、parseModelsResponse、parseModelsMeta、parsePricing / pricingFromRaw、effectiveTokenPricing、
 * floorPricingFromEndpoints、buildEndpointsRequest、parseEndpointsResponse、endpointLatencyMs、endpointRoutePrices、applyFloorToMeta。
 *
 * 价格单位：prompt / completion / cacheRead / imageOut = 美元/百万 Token；image = 美元/张。
 * endpoints 的 pricing 已是折后实付价：只按 pricingFromRaw(pr, 1) 折算，**绝不再乘 (1 − discount)**。
 */
object ModelCatalog {

    // ---------------- 分类 ----------------
    private val R_EMBED = Regex("embed")
    private val R_VIDEO = Regex("video")
    private val R_IMAGE = Regex("image")
    private val R_AUDIO_SPEECH = Regex("audio|speech")
    private val R_TRANSCRI = Regex("transcri")
    private val R_AUDIO = Regex("audio")
    private val R_IMG_VID = Regex("image|video")
    private val R_ASR_ID = Regex("whisper|transcri|asr|stt", RegexOption.IGNORE_CASE)
    private val N_EMBED = Regex("embed|bge-|\\bm3e\\b")
    private val N_TRANSCRI = Regex("whisper|transcri|\\basr\\b|stt|paraformer|sensevoice")
    private val N_SPEECH = Regex("tts|speech|cosyvoice|sambert|fishaudio")
    private val N_VIDEO = Regex("video|sora|kling|wanx?[\\d.-]*-?(t2v|i2v)|cogvideo|veo|hunyuanvideo|ltx")
    private val N_IMAGE = Regex("image|kolors|cogview|flux|wanx|dall-?e|stable-diffusion|sdxl|imagen|seedream")

    /** text | image | video | embedding | speech | transcription */
    fun classifyModel(id: String?, meta: JsonObject?): String {
        val modE = meta?.get("modality")
        val mod = if (Js.truthy(modE)) Js.str(modE).lowercase(java.util.Locale.ROOT) else ""
        if (mod.isNotEmpty()) {
            val parts = mod.split("->")
            val inp = parts[0]; val out = parts.getOrElse(1) { "" }
            if (R_EMBED.containsMatchIn(out) || (out.isEmpty() && R_EMBED.containsMatchIn(mod))) return "embedding"
            if (R_VIDEO.containsMatchIn(out)) return "video"
            if (R_IMAGE.containsMatchIn(out)) return "image"
            if (R_AUDIO_SPEECH.containsMatchIn(out)) return "speech"
            if (R_TRANSCRI.containsMatchIn(out)) return "transcription"
            if (R_AUDIO.containsMatchIn(inp) && Js.trim(out) == "text" && !R_IMG_VID.containsMatchIn(inp) && R_ASR_ID.containsMatchIn(id ?: "")) return "transcription"
            if (out.isNotEmpty()) return "text"
        }
        val n = (id ?: "").lowercase(java.util.Locale.ROOT)
        return when {
            N_EMBED.containsMatchIn(n) -> "embedding"
            N_TRANSCRI.containsMatchIn(n) -> "transcription"
            N_SPEECH.containsMatchIn(n) -> "speech"
            N_VIDEO.containsMatchIn(n) -> "video"
            N_IMAGE.containsMatchIn(n) -> "image"
            else -> "text"
        }
    }

    // ---------------- 模型列表 ----------------
    private val RE_OR = Regex("openrouter\\.ai", RegexOption.IGNORE_CASE)
    /** 不含认证头（AuthInjector 注入）；anthropic 带 anthropic-version */
    fun buildModelsRequest(provider: ProviderConfig): BuiltRequest {
        val base = Js.trimSlash(provider.baseUrl)
        return when {
            provider.type == ProviderType.ANTHROPIC -> BuiltRequest("$base/v1/models?limit=1000", "GET", mapOf("anthropic-version" to "2023-06-01"), "")
            provider.type == ProviderType.GEMINI -> BuiltRequest("$base/models?pageSize=1000", "GET", emptyMap(), "")
            provider.presetId == "openrouter" || RE_OR.containsMatchIn(base) -> BuiltRequest("$base/models?output_modalities=all", "GET", emptyMap(), "")
            else -> BuiltRequest("$base/models", "GET", emptyMap(), "")
        }
    }

    private fun listOf(obj: JsonElement): List<JsonElement> = when (obj) {
        is JsonArray -> obj
        is JsonObject -> (obj["data"]?.takeIf { Js.truthy(it) } ?: obj["models"]?.takeIf { Js.truthy(it) }) as? JsonArray ?: emptyList()
        else -> emptyList()
    }
    /** m.id || m.name || ''（真值链，原值） */
    private fun idOf(m: JsonObject): JsonElement? = m["id"]?.takeIf { Js.truthy(it) } ?: m["name"]?.takeIf { Js.truthy(it) }

    /** 模型列表 → 去重、localeCompare 排序的 id；Gemini 只留支持 generateContent 的。JSON 非法抛异常（同 JSON.parse）。 */
    fun parseModelsResponse(type: ProviderType, text: String): List<String> {
        val obj = Js.json.parseToJsonElement(text)
        val ids: List<String> = if (type == ProviderType.GEMINI) {
            val models = ((obj as? JsonObject)?.get("models")?.takeIf { Js.truthy(it) } as? JsonArray) ?: emptyList()
            models.filter { m ->
                val sgm = (m as? JsonObject)?.get("supportedGenerationMethods")
                !Js.truthy(sgm) || (sgm is JsonArray && sgm.any { it is JsonPrimitive && it.isString && it.content == "generateContent" })
            }.map { m -> Js.str((m as? JsonObject)?.get("name")?.takeIf { Js.truthy(it) } ?: JsonPrimitive("")).removePrefix("models/") }
        } else {
            listOf(obj).map { m ->
                when {
                    m is JsonPrimitive && m.isString -> m.content
                    m is JsonObject -> idOf(m)?.let { Js.str(it) } ?: ""
                    else -> ""
                }
            }
        }
        val out = ArrayList<String>()
        for (v in ids) if (v.isNotEmpty() && v !in out) out += v
        return out.sortedWith { a, b -> Js.localeCompareZh(a, b) }
    }

    private fun firstTruthy(vararg es: JsonElement?): JsonElement? = es.firstOrNull { Js.truthy(it) }
    private val R_META_TYPE = Regex("embed|image|video|audio|tts|stt", RegexOption.IGNORE_CASE)

    /** 列表元数据 → { id: { context, maxOutput, modality, price } }；JSON 非法返回 {} */
    fun parseModelsMeta(type: ProviderType, text: String): JsonObject {
        val obj = try { Js.json.parseToJsonElement(text) } catch (e: Exception) { return JsonObject(emptyMap()) }
        val out = LinkedHashMap<String, JsonElement>()
        for (m in listOf(obj)) {
            if (m !is JsonObject) continue
            val id = Js.str(idOf(m) ?: JsonPrimitive("")).removePrefix("models/"); if (id.isEmpty()) continue
            val tp = m["top_provider"] as? JsonObject
            val ctx = firstTruthy(m["context_length"], m["context_window"], m["max_context_length"], m["max_input_tokens"], m["inputTokenLimit"],
                tp?.get("context_length"))
            val outT = firstTruthy(m["outputTokenLimit"], m["max_output_tokens"], tp?.get("max_completion_tokens"))
            val arch = (m["architecture"]?.takeIf { Js.truthy(it) } as? JsonObject) ?: JsonObject(emptyMap())
            val im = arch["input_modalities"]; val om = arch["output_modalities"]
            val modality: String = when {
                Js.truthy(arch["modality"]) -> Js.str(arch["modality"])
                im is JsonArray && om is JsonArray ->   // 数组恒为真值；Array.join：null → ''
                    im.joinToString("+") { if (it is JsonNull) "" else Js.str(it) } + "->" + om.joinToString("+") { if (it is JsonNull) "" else Js.str(it) }
                (m["modality"] as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotEmpty() } != null -> (m["modality"] as JsonPrimitive).content
                Js.truthy(m["type"]) && R_META_TYPE.containsMatchIn(Js.str(m["type"])) -> Js.str(m["type"]) + "->" + Js.str(m["type"])
                else -> ""
            }
            val o = LinkedHashMap<String, JsonElement>()
            if (Js.toNumber(ctx) > 0) {
                o["context"] = Js.number(Js.toNumber(ctx))
                if (Js.toNumber(outT) > 0) o["maxOutput"] = Js.number(Js.toNumber(outT))
            }
            if (modality.isNotEmpty()) o["modality"] = JsonPrimitive(modality)
            parsePricing(m["pricing"])?.let { o["price"] = it }
            if (o.isNotEmpty()) out[id] = JsonObject(o)
        }
        return Js.jsObject(out)
    }

    // ---------------- 价格 ----------------
    fun parsePricing(pr: JsonElement?): JsonObject? = pricingFromRaw(pr, 1.0)

    /** 美元/Token（image 美元/张）× factor → $/M（四舍五入到 1e-6）；0 / 负 / 缺失不存；全缺 → null */
    fun pricingFromRaw(pr: JsonElement?, factor: Double): JsonObject? {
        if (pr !is JsonObject) return null
        val mul = if (factor.isFinite() && factor > 0) factor else 0.0
        if (mul == 0.0) return null
        fun num(v: JsonElement?): Double { val n = Js.toNumber(v); return if (n.isFinite() && n > 0) n else 0.0 }
        fun r(x: Double) = Js.round(x * 1e6) / 1e6
        val o = LinkedHashMap<String, JsonElement>()
        for ((k, src) in kotlin.collections.listOf("prompt" to "prompt", "completion" to "completion", "cacheRead" to "input_cache_read", "imageOut" to "image_output")) {
            val n = num(pr[src]) * mul
            if (n > 0) o[k] = Js.number(r(n * 1e6))
        }
        val img = num(pr["image"]) * mul
        if (img > 0) o["image"] = Js.number(r(img))
        return if (o.isEmpty()) null else JsonObject(o)
    }

    /** endpoints 单项 pricing → $/M；已是折后价，不乘 (1 − discount) */
    fun effectiveTokenPricing(pr: JsonElement?): JsonObject? = if (pr !is JsonObject) null else pricingFromRaw(pr, 1.0)

    private fun d(o: JsonObject, k: String): Double = o[k]?.let { Js.toNumber(it) }?.takeIf { !it.isNaN() } ?: 0.0

    /** 有效价最低的一端：比较 prompt+completion，同分再比 prompt；严格小于才替换（先到先得） */
    fun floorPricingFromEndpoints(endpoints: JsonElement?): JsonObject? {
        if (endpoints !is JsonArray || endpoints.isEmpty()) return null
        var best: JsonObject? = null
        var bestSum = Double.POSITIVE_INFINITY; var bestPrompt = Double.POSITIVE_INFINITY
        for (ep in endpoints) {
            val eff = effectiveTokenPricing((ep as? JsonObject)?.get("pricing")) ?: continue
            val sum = d(eff, "prompt") + d(eff, "completion")
            val prompt = d(eff, "prompt")
            if (sum < bestSum || (sum == bestSum && prompt < bestPrompt)) { best = eff; bestSum = sum; bestPrompt = prompt }
        }
        return best
    }

    /** GET {base}/models/{modelId 按段 encodeURIComponent}/endpoints（不含认证头） */
    fun buildEndpointsRequest(provider: ProviderConfig, modelId: String?): BuiltRequest {
        val base = Js.trimSlash(provider.baseUrl)
        val pathId = (modelId ?: "").split("/").joinToString("/") { WireUtil.encodeURIComponent(it) }
        return BuiltRequest("$base/models/$pathId/endpoints", "GET", emptyMap(), "")
    }

    /** endpoints 响应 → 数组（[…] / {endpoints} / {data:{endpoints}} / {data:[…]}）；非法 → [] */
    fun parseEndpointsResponse(text: String?): JsonArray {
        val obj = try { Js.json.parseToJsonElement(text ?: "") } catch (e: Exception) { return JsonArray(emptyList()) }
        if (obj is JsonArray) return obj
        if (obj !is JsonObject) return JsonArray(emptyList())
        (obj["endpoints"] as? JsonArray)?.let { return it }
        val data = obj["data"]
        ((data as? JsonObject)?.get("endpoints") as? JsonArray)?.let { return it }
        (data as? JsonArray)?.let { return it }
        return JsonArray(emptyList())
    }

    /** latency / latency_p50 / stats.latency / stats.latency_p50；<20 视为秒 ×1000；四舍五入为毫秒 */
    fun endpointLatencyMs(ep: JsonElement?): Double {
        if (ep !is JsonObject) return 0.0
        fun nn(e: JsonElement?) = e != null && e !is JsonNull
        val stats = ep["stats"]
        val raw: JsonElement? = when {
            nn(ep["latency"]) -> ep["latency"]
            nn(ep["latency_p50"]) -> ep["latency_p50"]
            stats is JsonObject -> if (nn(stats["latency"])) stats["latency"] else stats["latency_p50"]
            else -> null
        }
        val n = Js.toNumber(raw)
        if (!(n > 0) || !n.isFinite()) return 0.0
        return if (n < 20) Js.round(n * 1000) else Js.round(n)
    }

    /** endpoints → 路由候选 [{slug,pMiss,pHit,ok,completion,latencyMs}] */
    fun endpointRoutePrices(endpoints: JsonElement?): List<JsonObject> {
        if (endpoints !is JsonArray) return emptyList()
        val out = ArrayList<JsonObject>()
        for (ep in endpoints) {
            if (ep !is JsonObject) continue
            val prov = ep["provider"]?.takeIf { Js.truthy(it) } as? JsonObject
            val slug = firstTruthy(ep["tag"], ep["provider_name"], ep["name"], prov?.let { firstTruthy(it["slug"], it["name"]) }) ?: continue
            val eff = effectiveTokenPricing(ep["pricing"]) ?: continue
            if (!(Js.toNumber(eff["prompt"]) > 0)) continue
            out += buildJsonObject {
                put("slug", Js.str(slug))
                put("pMiss", eff["prompt"]!!)
                put("pHit", eff["cacheRead"]?.takeIf { it !is JsonNull } ?: eff["prompt"]!!)
                put("ok", true)
                put("completion", eff["completion"]?.takeIf { Js.truthy(it) } ?: JsonPrimitive(0))
                put("latencyMs", Js.number(endpointLatencyMs(ep)))
            }
        }
        return out
    }

    /**
     * app.js applyFloorToMeta 的纯函数版：modelMeta[modelId] 写 price = floor、priceIsFloor = true，有 endpoints 时写 _endpoints。
     * 返回新 modelMeta；无 floor / modelId 返回 null（JS 返回 false）。价目同步另走 [com.aichat.app.domain.cost.FloorPrices]。
     */
    fun applyFloorToMeta(modelMeta: JsonObject, modelId: String?, floor: JsonObject?, endpoints: JsonElement?): JsonObject? {
        if (floor == null || modelId.isNullOrEmpty()) return null
        val m = LinkedHashMap<String, JsonElement>(modelMeta)
        val e = LinkedHashMap<String, JsonElement>((m[modelId]?.takeIf { Js.truthy(it) } as? JsonObject) ?: JsonObject(emptyMap()))
        e["price"] = floor
        e["priceIsFloor"] = JsonPrimitive(true)
        if (endpoints is JsonArray && endpoints.isNotEmpty()) e["_endpoints"] = endpoints
        m[modelId] = JsonObject(e)
        return JsonObject(m)
    }

    // ---------------- M4：价格 / 上下文显示（providers.js fmtUsd / formatModelPrice / formatContext） ----------------
    fun fmtUsd(n: Double): String = when {
        n >= 100 -> "$" + Js.toFixed(n, 0)
        n >= 0.01 -> "$" + Js.toFixed(n, 2)
        else -> "$" + Js.numberToString(Js.toPrecisionNumber(n, 2))
    }
    /** meta → 「输入 $0.50 / 输出 $3.00 · 百万Token」/「约 $0.01/张」/「—」；最低价时前缀「最低 」 */
    fun formatModelPrice(meta: JsonObject?): String {
        val pf = meta?.get("priceFloor")
        val p = (if (Js.truthy(pf)) pf else meta?.get("price"))?.takeIf { Js.truthy(it) } ?: return "—"
        fun f(k: String) = (p as? JsonObject)?.get(k)
        fun usd(e: JsonElement?) = fmtUsd(Js.toNumber(e))
        val parts = ArrayList<String>()
        if (Js.truthy(f("prompt")) || Js.truthy(f("completion"))) {
            parts += (if (Js.truthy(f("prompt"))) "输入 " + usd(f("prompt")) else "输入 —") + " / " + (if (Js.truthy(f("completion"))) "输出 " + usd(f("completion")) else "输出 —") + " · 百万Token"
        } else if (Js.truthy(f("imageOut"))) parts += "图片输出 " + usd(f("imageOut")) + " · 百万Token"
        if (Js.truthy(f("image")) && parts.isEmpty()) parts += "约 " + usd(f("image")) + "/张"
        if (parts.isEmpty()) return "—"
        val body = parts.joinToString(" · ")
        val isFloor = Js.truthy(meta?.get("priceIsFloor")) || Js.truthy(pf)
        return if (isFloor) "最低 $body" else body
    }
    /** n ≥ 1e6 → 「1.3M」；≥ 1000 → 「128K」；否则原数 */
    fun formatContext(n: Double): String = when {
        n >= 1e6 -> Js.numberToString(Js.toFixed(n / 1e6, 1).toDouble()) + "M"
        n >= 1000 -> Js.numberToString(Js.round(n / 1000)) + "K"
        else -> Js.numberToString(n)
    }
}
