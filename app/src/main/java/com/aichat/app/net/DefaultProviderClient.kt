package com.aichat.app.net

import com.aichat.app.domain.BuiltRequest
import com.aichat.app.domain.ChatOptions
import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.ProviderClient
import com.aichat.app.domain.StreamEvent
import com.aichat.app.domain.WireMessage
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emitAll
import kotlinx.coroutines.withContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.io.InputStreamReader
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicReference

/**
 * ProviderClient 实现（工作流 B）。三种请求格式（openai 兼容 / anthropic / gemini）的构造 + 流式；模型列表 / OpenRouter endpoints；RouteChosen。
 * 流式语义对照 app.js 2236–2320：
 *  - 只有 2xx 且为流式时才逐块喂 SSE 解析器；非 2xx 读完整个错误体 → Error(status, parseError, raw)
 *  - 流结束后若一个内容增量都没收到而 raw 非空 → 按整包 JSON 兜底解析（parseFullResponse）
 *  - OpenRouter 402 且未收到任何内容：按 can only afford N 的 80% 降 max_tokens 重试一次
 *  - 取消收集协程 = 断开 OkHttp call（不再发任何事件）
 */
class DefaultProviderClient(
    private val auth: AuthInjector,
    private val client: OkHttpClient = HttpClients.authed,
) : ProviderClient {

    constructor(keys: KeyVault?) : this(AuthInjector(keys))

    override fun buildChatRequest(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String,
                                  opts: ChatOptions, bodyPatch: JsonObject): BuiltRequest =
        buildChatRequest(provider, model, messages, systemPrompt, opts, bodyPatch, RouteInputs())

    /** 带 OpenRouter 路由状态的版本（opts.routePrices 分支用；B 内部） */
    fun buildChatRequest(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String,
                         opts: ChatOptions, bodyPatch: JsonObject, route: RouteInputs): BuiltRequest = when (provider.type) {
        ProviderType.OPENAI -> OpenAiCompat.build(provider, model, messages, systemPrompt, opts, bodyPatch, route)
        ProviderType.ANTHROPIC -> AnthropicCompat.build(provider, model, messages, systemPrompt, opts, bodyPatch)
        ProviderType.GEMINI -> GeminiCompat.build(provider, model, messages, systemPrompt, opts, bodyPatch)
    }

    override fun stream(provider: ProviderConfig, request: BuiltRequest): Flow<StreamEvent> = callbackFlow {
        val current = AtomicReference<Call?>(null)
        val type = provider.type.wire
        val streaming = request.headers.entries.any { it.key.equals("Accept", true) && it.value.contains("text/event-stream") } ||
            request.url.contains("alt=sse")
        launch(Dispatchers.IO) {
            var req = request
            var downgraded = false
            var usage: JsonObject? = null
            var rawUsage: JsonObject? = null
            while (true) {
                val authed = try { auth.authorize(provider.id, req) } catch (e: AuthInjector.Rejected) {
                    send(StreamEvent.Error(0, e.message ?: "请求失败", "")); break
                }
                val call = client.newCall(toOkHttp(authed)); current.set(call)
                if (!isActive) { call.cancel(); break }
                var gotDelta = false
                var status = 0
                val raw = StringBuilder()
                var retry = false
                suspend fun apply(ds: List<StreamDelta>) {
                    for (d in ds) {
                        if (d.countsAsContent) gotDelta = true
                        when (d) {
                            is StreamDelta.Text -> send(StreamEvent.Delta(d.text))
                            is StreamDelta.Reasoning -> send(StreamEvent.Reasoning(d.text))
                            is StreamDelta.Error -> send(StreamEvent.Error(status, d.text, ""))
                            is StreamDelta.Finish -> send(StreamEvent.Finish(d.reason))
                            is StreamDelta.UsageDelta -> {
                                usage = UsageCodec.mergeUsage(usage, d.usage)
                                d.raw?.let { r -> rawUsage = JsonObject(LinkedHashMap<String, JsonElement>(rawUsage ?: emptyMap()).apply { putAll(r) }) }
                                UsageCodec.toUsage(usage, rawUsage)?.let { send(StreamEvent.UsageUpdate(it)) }
                            }
                        }
                    }
                }
                try {
                    call.execute().use { resp ->
                        status = resp.code
                        send(StreamEvent.Status(status))
                        val ok = status in 200..299
                        val parser = StreamParser(type)
                        val body = resp.body
                        if (body != null) InputStreamReader(body.byteStream(), StandardCharsets.UTF_8).use { r ->
                            val cbuf = CharArray(4096)
                            while (true) {
                                val n = r.read(cbuf); if (n < 0) break
                                if (n == 0) continue
                                val t = String(cbuf, 0, n)
                                raw.append(t)
                                if (ok && streaming) apply(parser.push(t))
                            }
                        }
                        if (!ok) {
                            val rawS = raw.toString()
                            if (status == 402 && !gotDelta && !downgraded) {
                                val afford = ProviderRules.parseAffordTokens(rawS)
                                if (afford != null) {
                                    downgraded = true
                                    val next = ProviderRules.downgradeMaxTokens(afford)
                                    req = withMaxTokens(req, provider.type, next)
                                    send(StreamEvent.Notice(downgradeNotice(next)))
                                    retry = true
                                    return@use
                                }
                            }
                            var msg = Deltas.parseError(status, rawS)
                            if (status == 402 && downgraded) msg += "\n请在设置里调小「最大输出 tokens」后再试。"
                            else if (status == 402 && RE_402.containsMatchIn(rawS)) msg += "\n请在设置里调小「最大输出 tokens」。"
                            send(StreamEvent.Error(status, msg, rawS))
                        } else if (streaming) {
                            apply(parser.end())
                            if (!gotDelta && Js.trim(raw.toString()).isNotEmpty()) apply(Deltas.parseFullResponse(type, raw.toString()))
                        } else {
                            apply(Deltas.parseFullResponse(type, raw.toString()))
                        }
                    }
                } catch (e: IOException) {
                    if (!isActive || call.isCanceled()) break
                    val m = e.javaClass.simpleName + (if (e.message != null) ": " + e.message else "")
                    send(StreamEvent.Error(status, "网络错误：$m\n请检查网络连接和 Base URL。", raw.toString()))
                }
                if (!retry) break
            }
            channel.close()
        }
        awaitClose { current.get()?.cancel() }
    }

    /**
     * 带路由结果的流：先发 RouteChosen(slug)（ChatEngine 用它在 afterResponse 里 observeRoute / markFail），再照常流式。
     * slug 来自 AffinityRouter.beforeSend（或 buildChatRequest 的 routePrices 分支 onRouteChosen）。
     */
    fun stream(provider: ProviderConfig, request: BuiltRequest, routeSlug: String?): Flow<StreamEvent> =
        if (routeSlug.isNullOrEmpty()) stream(provider, request)
        else kotlinx.coroutines.flow.flow { emit(StreamEvent.RouteChosen(routeSlug)); emitAll(stream(provider, request)) }

    /**
     * app.js requestText(authed(req, p.id), _, timeoutMs)：已认证的一次性请求 → (status, body)。
     * 超时抛 IOException("请求超时")；取消随协程取消 Call。改写搜索查询（rewriteQuery）用。
     */
    suspend fun requestText(provider: ProviderConfig, req: BuiltRequest, timeoutMs: Long): Pair<Int, String> = withContext(Dispatchers.IO) {
        val authed = auth.authorize(provider.id, req)
        val call = client.newBuilder().callTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).build().newCall(toOkHttp(authed))
        kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]?.invokeOnCompletion { if (it != null) call.cancel() }
        try { call.execute().use { r -> r.code to (r.body?.string() ?: "") } }
        catch (e: java.io.InterruptedIOException) { if (call.isCanceled()) throw e; throw IOException("请求超时") }
    }

    /** 已认证 GET → (status, body)；未登记 / 跨源抛 AuthInjector.Rejected */
    private suspend fun getText(provider: ProviderConfig, req: BuiltRequest): Pair<Int, String> = withContext(Dispatchers.IO) {
        val authed = auth.authorize(provider.id, req)
        val call = client.newCall(toOkHttp(authed))
        kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]?.invokeOnCompletion { if (it != null) call.cancel() }
        call.execute().use { resp -> resp.code to (resp.body?.string() ?: "") }
    }

    /**
     * 获取模型列表：ids（去重 + localeCompare 排序）+ modelMeta（context / maxOutput / modality / price）。
     * 非 2xx 抛 IOException(parseError 文案)；空列表原样返回（「接口没有返回任何模型」提示归 UI）。
     */
    override suspend fun listModels(provider: ProviderConfig): Pair<List<String>, JsonObject> {
        val (status, text) = getText(provider, ModelCatalog.buildModelsRequest(provider))
        if (status >= 400 || status == 0) throw IOException(Deltas.parseError(status, text))
        val ids = try { ModelCatalog.parseModelsResponse(provider.type, text) } catch (e: Exception) { throw IOException("模型列表不是合法 JSON：" + (e.message ?: ""), e) }
        return ids to ModelCatalog.parseModelsMeta(provider.type, text)
    }

    /**
     * OpenRouter GET /models/{id}/endpoints → { "floor": 最低价 $/M | null, "endpoints": [...] }（app.js doFetchOpenRouterFloor）。
     * 非 2xx 抛 IOException。floor 用 pricingFromRaw(pr, 1)：endpoints 已是折后价，不再乘 (1 − discount)。
     * 调用方随后：ModelCatalog.applyFloorToMeta + FloorPrices.syncUsagePricesFromEndpoints（非 null 才保存）。
     */
    override suspend fun openRouterEndpoints(provider: ProviderConfig, modelId: String): JsonObject {
        val (status, text) = getText(provider, ModelCatalog.buildEndpointsRequest(provider, modelId))
        if (status >= 400 || status == 0) throw IOException(Deltas.parseError(status, text))
        val eps = ModelCatalog.parseEndpointsResponse(text)
        return JsonObject(linkedMapOf("floor" to (ModelCatalog.floorPricingFromEndpoints(eps) ?: kotlinx.serialization.json.JsonNull), "endpoints" to eps))
    }

    companion object {
        /** 与 app.js 2285 行逐字一致 */
        fun downgradeNotice(next: Double) = "额度不足，已将最大输出降至 ${Js.numberToString(next)} 并重试…"
        private val RE_402 = Regex("can only afford|max_tokens", RegexOption.IGNORE_CASE)
        private val JSON_MT = "application/json; charset=utf-8".toMediaType()

        fun toOkHttp(r: BuiltRequest): Request {
            val b = Request.Builder().url(r.url)
            r.headers.forEach { (k, v) -> b.header(k, v) }
            val method = r.method.ifEmpty { "GET" }.uppercase()
            val ct = r.headers.entries.firstOrNull { it.key.equals("Content-Type", true) }?.value
            val body = if (method == "GET" || method == "HEAD") null
                else r.body.toByteArray(StandardCharsets.UTF_8).toRequestBody(ct?.toMediaType() ?: JSON_MT)
            return b.method(method, body).build()
        }

        /** 402 降级：只改 max_tokens（openai / anthropic）或 generationConfig.maxOutputTokens（gemini），其余逐字不变 */
        fun withMaxTokens(r: BuiltRequest, type: ProviderType, maxTokens: Double): BuiltRequest {
            val body = Js.parse(r.body) as? JsonObject ?: return r
            val m = LinkedHashMap<String, JsonElement>(body)
            if (type == ProviderType.GEMINI) {
                val gc = LinkedHashMap<String, JsonElement>((m["generationConfig"] as? JsonObject) ?: JsonObject(emptyMap()))
                gc["maxOutputTokens"] = Js.number(maxTokens); m["generationConfig"] = JsonObject(gc)
            } else m["max_tokens"] = Js.number(maxTokens)
            return r.copy(body = Js.stringify(JsonObject(m)))
        }
    }
}
