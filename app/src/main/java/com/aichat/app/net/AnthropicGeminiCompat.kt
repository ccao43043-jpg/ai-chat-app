package com.aichat.app.net

import com.aichat.app.domain.BuiltRequest
import com.aichat.app.domain.ChatOptions
import com.aichat.app.domain.WireMessage
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.Role
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** providers.js 的共用小工具 */
object WireUtil {
    private val DATA_URL = Regex("^data:([^;,]+)(;base64)?,(.*)$", RegexOption.DOT_MATCHES_ALL)
    /** splitDataUrl：data:image/png;base64,xxxx → (mime, data)；不匹配（如 http URL）→ ("image/jpeg", "") */
    fun splitDataUrl(dataUrl: String?): Pair<String, String> {
        val m = DATA_URL.find(dataUrl ?: "") ?: return "image/jpeg" to ""
        return m.groupValues[1] to m.groupValues[3]
    }
    /** encodeURIComponent（UTF-8，大写十六进制；保留 A-Z a-z 0-9 - _ . ! ~ * ' ( )） */
    fun encodeURIComponent(s: String): String {
        val sb = StringBuilder()
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xff
            val ch = c.toChar()
            if (c < 0x80 && (ch.isLetterOrDigit() || ch in "-_.!~*'()")) sb.append(ch)
            else sb.append('%').append(String.format("%02X", c))
        }
        return sb.toString()
    }
}

/**
 * buildChatRequest 的 anthropic 分支（/v1/messages）。键序同 JS：model, max_tokens, stream, messages, system, temperature。
 * JS 这一分支没有 thinking / jsonMode 字段，所以这里也不写（逐字对齐）。认证头 x-api-key 由 AuthInjector 注入。
 */
object AnthropicCompat {
    private val CC: JsonObject = buildJsonObject { put("type", "ephemeral") }

    /** Claude 消息的内容块数（文本块 + 图片块） */
    fun claudeBlocks(bm: JsonObject): Int = when (val c = bm["content"]) {
        is JsonPrimitive -> if (c.isString && c.content.isNotEmpty()) 1 else 0
        is JsonArray -> c.size
        else -> 0
    }
    fun claudeHasText(bm: JsonObject): Boolean = when (val c = bm["content"]) {
        is JsonPrimitive -> c.isString && c.content.isNotEmpty()
        is JsonArray -> c.any { b -> (b as? JsonObject)?.let { (it["type"] as? JsonPrimitive)?.content == "text" && Js.truthy(it["text"]) } == true }
        else -> false
    }
    /** 历史断点：以最后一个 _cache 消息为末尾断点，向前每累计 ≥ every 个块插一个锚点；最多 max（≤3）个；返回升序下标 */
    fun claudeCacheAnchors(bodyMessages: List<JsonObject>, marked: List<Int>, maxIn: Int?, everyIn: Int? = null): List<Int> {
        val max = maxOf(0, minOf(3, maxIn ?: 3)); val every = if (everyIn == null || everyIn == 0) 15 else everyIn
        if (max == 0 || marked.isEmpty()) return emptyList()
        var tail = marked.last()
        while (tail >= 0 && !claudeHasText(bodyMessages[tail])) tail--
        if (tail < 0) return emptyList()
        val out = mutableListOf(tail)
        var since = claudeBlocks(bodyMessages[tail])
        var i = tail - 1
        while (i >= 0 && out.size < max) {
            since += claudeBlocks(bodyMessages[i])
            if (since >= every && claudeHasText(bodyMessages[i])) { out += i; since = 0 }
            i--
        }
        return out.reversed()
    }
    /** markLastText：在最后一个 text 块上打 cache_control（不打在图片块上） */
    private fun markLastText(bm: JsonObject): JsonObject {
        val c = bm["content"]
        if (c is JsonPrimitive) {
            if (!c.isString || c.content.isEmpty()) return bm
            return JsonObject(bm + ("content" to buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", c.content); put("cache_control", CC) }) }))
        }
        val arr = (c as? JsonArray)?.toMutableList() ?: return bm
        for (j in arr.indices.reversed()) {
            val b = arr[j] as? JsonObject ?: continue
            if ((b["type"] as? JsonPrimitive)?.content == "text" && Js.truthy(b["text"])) {
                arr[j] = JsonObject(LinkedHashMap(b).apply { put("cache_control", CC) })
                return JsonObject(bm + ("content" to JsonArray(arr)))
            }
        }
        return bm
    }

    fun buildBody(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String,
                  opts: ChatOptions, bodyPatch: JsonObject = JsonObject(emptyMap())): JsonObject {
        val msgs = OpenAiCompat.filterMessages(messages)
        val sys = Js.trim(systemPrompt)
        val temp = opts.temperature?.takeIf { !it.isNaN() }
        var bodyMessages: MutableList<JsonObject> = msgs.map { m ->
            if (m.role == Role.USER && m.images.isNotEmpty()) buildJsonObject {
                put("role", "user")
                put("content", buildJsonArray {
                    m.images.forEach { img ->
                        val (mime, data) = WireUtil.splitDataUrl(img)
                        add(buildJsonObject { put("type", "image"); put("source", buildJsonObject { put("type", "base64"); put("media_type", mime); put("data", data) }) })
                    }
                    if (m.content.isNotEmpty()) add(buildJsonObject { put("type", "text"); put("text", m.content) })
                })
            } else buildJsonObject { put("role", m.role.wire); put("content", m.content) }
        }.toMutableList()
        val body = LinkedHashMap<String, JsonElement>()
        body["model"] = JsonPrimitive(model)
        body["max_tokens"] = JsonPrimitive(if (opts.maxTokens != null && opts.maxTokens != 0) opts.maxTokens else 4096)
        body["stream"] = JsonPrimitive(opts.stream)
        if (sys.isNotEmpty()) body["system"] = JsonPrimitive(sys)   // 位置在 messages 之后（下方先占位 messages）
        if (opts.cacheControl) {
            if (sys.isNotEmpty()) body["system"] = buildJsonArray { add(buildJsonObject { put("type", "text"); put("text", sys); put("cache_control", CC) }) }
            val marked = msgs.indices.filter { msgs[it].cacheMark }
            val idx = claudeCacheAnchors(bodyMessages, marked, if (sys.isNotEmpty()) 3 else 4)
            idx.forEach { bodyMessages[it] = markLastText(bodyMessages[it]) }
        }
        // 重新按 JS 键序组装：model, max_tokens, stream, messages, system, temperature
        val ordered = LinkedHashMap<String, JsonElement>()
        ordered["model"] = body["model"]!!; ordered["max_tokens"] = body["max_tokens"]!!; ordered["stream"] = body["stream"]!!
        ordered["messages"] = JsonArray(bodyMessages)
        body["system"]?.let { ordered["system"] = it }
        if (temp != null) ordered["temperature"] = Js.number(temp)
        return JsonMergePatch.applyObject(JsonObject(ordered), bodyPatch)
    }

    fun build(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String,
              opts: ChatOptions, bodyPatch: JsonObject = JsonObject(emptyMap())): BuiltRequest {
        val body = buildBody(provider, model, messages, systemPrompt, opts, bodyPatch)
        val headers = linkedMapOf("Content-Type" to "application/json", "anthropic-version" to "2023-06-01",
            "Accept" to if (opts.stream) "text/event-stream" else "application/json")
        return BuiltRequest(Js.trimSlash(provider.baseUrl) + "/v1/messages", "POST", headers, Js.stringify(body))
    }
}

/**
 * buildChatRequest 的 gemini 分支（:streamGenerateContent?alt=sse / :generateContent）。键序同 JS：contents, systemInstruction, generationConfig。
 * JS 这一分支没有 thinkingConfig；Gemini 显式缓存（cachedContent）由 gcache 插件经 bodyPatch 写入，不在这里。
 */
object GeminiCompat {
    fun buildBody(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String,
                  opts: ChatOptions, bodyPatch: JsonObject = JsonObject(emptyMap())): JsonObject {
        val msgs = OpenAiCompat.filterMessages(messages)
        val sys = Js.trim(systemPrompt)
        val temp = opts.temperature?.takeIf { !it.isNaN() }
        val body = LinkedHashMap<String, JsonElement>()
        body["contents"] = buildJsonArray {
            msgs.forEach { m ->
                add(buildJsonObject {
                    put("role", if (m.role == Role.ASSISTANT) "model" else "user")
                    put("parts", buildJsonArray {
                        if (m.role == Role.USER) m.images.forEach { img ->
                            val (mime, data) = WireUtil.splitDataUrl(img)
                            add(buildJsonObject { put("inline_data", buildJsonObject { put("mime_type", mime); put("data", data) }) })
                        }
                        if (m.content.isNotEmpty()) add(buildJsonObject { put("text", m.content) })
                    })
                })
            }
        }
        if (sys.isNotEmpty()) body["systemInstruction"] = buildJsonObject { put("parts", buildJsonArray { add(buildJsonObject { put("text", sys) }) }) }
        val gc = LinkedHashMap<String, JsonElement>()
        if (temp != null) gc["temperature"] = Js.number(temp)
        if (opts.maxTokens != null && opts.maxTokens != 0) gc["maxOutputTokens"] = JsonPrimitive(opts.maxTokens)
        if (opts.jsonMode) gc["responseMimeType"] = JsonPrimitive("application/json")
        if (gc.isNotEmpty()) body["generationConfig"] = JsonObject(gc)
        return JsonMergePatch.applyObject(JsonObject(body), bodyPatch)
    }

    fun build(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String,
              opts: ChatOptions, bodyPatch: JsonObject = JsonObject(emptyMap())): BuiltRequest {
        val body = buildBody(provider, model, messages, systemPrompt, opts, bodyPatch)
        val path = if (opts.stream) ":streamGenerateContent?alt=sse" else ":generateContent"
        return BuiltRequest(Js.trimSlash(provider.baseUrl) + "/models/" + WireUtil.encodeURIComponent(model) + path, "POST",
            linkedMapOf("Content-Type" to "application/json"), Js.stringify(body))
    }
}
