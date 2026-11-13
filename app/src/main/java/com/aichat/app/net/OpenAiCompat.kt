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

/**
 * providers.js buildChatRequest 的 OpenAI 兼容分支（openai / deepseek / qwen / qwen-intl / moonshot / zhipu / siliconflow /
 * xiaomi / openrouter / custom）。键的插入顺序与 JS 完全相同，body 用 [Js.stringify] 输出，与 JSON.stringify 逐字一致。
 *
 * ChatOptions 待加的 opts（cacheSystem / cacheAffinity / orSort / orGemini / orMiniMax / routePrices）暂由 [NetOptions] 传入。
 * routePrices / chooseUpstream 分支等 Router 移植后接入；现在只支持 providerOrder / routeSlug 钉定。
 * bodyPatch 按 RFC 7386 合并（[JsonMergePatch]）。
 * 不含认证头：由 [AuthInjector] 注入。
 */
object OpenAiCompat {
    private val EPHEMERAL: JsonObject = buildJsonObject { put("type", "ephemeral") }

    /** buildChatRequest 的消息过滤：只要 user / assistant，且有正文或图片 */
    fun filterMessages(messages: List<WireMessage>): List<WireMessage> =
        messages.filter { (it.role == Role.USER || it.role == Role.ASSISTANT) && (it.content.isNotEmpty() || it.images.isNotEmpty()) }

    private fun textPart(text: String, cc: Boolean): JsonObject = buildJsonObject {
        put("type", "text"); put("text", text); if (cc) put("cache_control", EPHEMERAL)
    }

    /** mark()：转为数组形式，最后一段加 cache_control */
    private fun mark(content: JsonElement): JsonArray {
        val parts: List<JsonObject> = if (content is JsonArray) content.map { it as JsonObject }
            else listOf(textPart((content as? JsonPrimitive)?.content ?: "", false))
        return JsonArray(parts.mapIndexed { i, p -> if (i == parts.lastIndex) JsonObject(p + ("cache_control" to EPHEMERAL)) else p })
    }

    fun buildBody(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String,
                  opts: ChatOptions, bodyPatch: JsonObject = JsonObject(emptyMap()), ext: NetOptions = NetOptions()): JsonObject {
        val stream = opts.stream
        val base = Js.trimSlash(provider.baseUrl)
        val msgs = filterMessages(messages)
        val sys = Js.trim(systemPrompt)
        val temp = opts.temperature?.takeIf { !it.isNaN() }
        val cc = opts.cacheControl
        val cacheSystem = ext.cacheSystem
        val split = if (cc && cacheSystem && opts.cacheSystemSplit > 0 && opts.cacheSystemSplit < sys.length) opts.cacheSystemSplit else 0

        val out = buildJsonArray {
            if (sys.isNotEmpty()) add(buildJsonObject {
                put("role", "system")
                put("content", when {
                    split > 0 -> buildJsonArray { add(textPart(sys.substring(0, split), true)); add(textPart(sys.substring(split), true)) }
                    cc && cacheSystem -> mark(JsonPrimitive(sys))
                    else -> JsonPrimitive(sys)
                })
            })
            for (m in msgs) {
                val content: JsonElement = if (m.role == Role.USER && m.images.isNotEmpty()) buildJsonArray {
                    if (m.content.isNotEmpty()) add(textPart(m.content, false))
                    m.images.forEach { img -> add(buildJsonObject { put("type", "image_url"); put("image_url", buildJsonObject { put("url", img) }) }) }
                } else JsonPrimitive(m.content)
                add(buildJsonObject { put("role", m.role.wire); put("content", if (cc && m.cacheMark) mark(content) else content) })
            }
        }

        val body = LinkedHashMap<String, JsonElement>()
        body["model"] = JsonPrimitive(model)
        body["messages"] = out
        body["stream"] = JsonPrimitive(stream)
        val th: Boolean? = opts.thinking ?: when (provider.thinking) { "on" -> true; "off" -> false; else -> null }
        if (th != null && ProviderRules.isQwenEndpoint(provider)) body["enable_thinking"] = JsonPrimitive(th)
        if (stream && ProviderRules.streamUsageEnabled(provider)) body["stream_options"] = buildJsonObject { put("include_usage", true) }
        if (temp != null) body["temperature"] = Js.number(temp)
        if (opts.maxTokens != null && opts.maxTokens != 0) body["max_tokens"] = JsonPrimitive(opts.maxTokens)
        if (opts.jsonMode && ProviderRules.jsonModeSupported(provider)) body["response_format"] = buildJsonObject { put("type", "json_object") }

        if (ProviderRules.isOpenRouterBase(provider.presetId, base)) {
            val affinity = ext.cacheAffinity && provider.cacheAffinity != false
            var pinned = false
            if (affinity && opts.providerOrder.isNotEmpty()) {
                body["provider"] = ProviderRules.buildProviderField(opts.providerOrder[0]); pinned = true
            } else if (affinity && !opts.routeSlug.isNullOrEmpty()) {
                body["provider"] = ProviderRules.buildProviderField(opts.routeSlug); pinned = true
            }
            if (!pinned) ProviderRules.openRouterSortField(provider, ext.orSort)?.let { body["provider"] = it }
            // v0.28.7：稳定 session_id；gcache / mmcache 生效时由插件经 bodyPatch 写自己的 session_id（下方合并时覆盖）
            if (body["session_id"] == null && !opts.convId.isNullOrEmpty() && !ext.orGemini && !ext.orMiniMax) {
                val sid = ProviderRules.orSessionIdFor(opts.convId)
                if (sid.isNotEmpty()) body["session_id"] = JsonPrimitive(sid)
            }
        }
        // 插件补丁（gcache.transformRequest / mmcache.transformRequest 的等价物）：RFC 7386 Merge Patch
        return JsonMergePatch.applyObject(JsonObject(body), bodyPatch)
    }

    fun build(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String,
              opts: ChatOptions, bodyPatch: JsonObject = JsonObject(emptyMap()), ext: NetOptions = NetOptions()): BuiltRequest {
        val body = buildBody(provider, model, messages, systemPrompt, opts, bodyPatch, ext)
        val headers = LinkedHashMap<String, String>()
        headers["Content-Type"] = "application/json"
        if (opts.stream) headers["Accept"] = "text/event-stream"
        return BuiltRequest(Js.trimSlash(provider.baseUrl) + "/chat/completions", "POST", headers, Js.stringify(body))
    }
}
