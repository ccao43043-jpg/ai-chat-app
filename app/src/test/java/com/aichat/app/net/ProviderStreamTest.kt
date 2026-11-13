package com.aichat.app.net

import com.aichat.app.domain.ChatOptions
import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.StreamEvent
import com.aichat.app.domain.WireMessage
import com.aichat.app.domain.model.AuthType
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType
import com.aichat.app.domain.model.Role
import com.aichat.app.domain.model.Usage
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.flow.takeWhile
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/** MockWebServer 等价的集成测试：SSE 分片、usage 合并、错误体、402 降级重试、取消、认证注入 */
class ProviderStreamTest {
    private val server = TinySseServer()
    private val vault = FakeVault(mapOf("or" to "sk-test"))
    private val http = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).followRedirects(false).build()
    private val client = DefaultProviderClient(AuthInjector(vault), http)

    private fun provider(preset: String = "openrouter") = ProviderConfig("or", preset, "P", ProviderType.OPENAI, server.baseUrl + "/api/v1", listOf("m"))
    private fun req(p: ProviderConfig = provider(), stream: Boolean = true, maxTokens: Int? = 65536) = client.buildChatRequest(
        p, "m", listOf(WireMessage(Role.USER, "hi")), "sys", ChatOptions(stream = stream, maxTokens = maxTokens, convId = "c1"))

    @After fun tearDown() = server.close()

    private fun collect(r: com.aichat.app.domain.BuiltRequest, p: ProviderConfig = provider()) =
        runBlocking { withTimeout(10_000) { client.stream(p, r).toList() } }

    @Test fun streamsDeltasReasoningUsageFinishWithByteSplits() {
        val sse = ": OPENROUTER PROCESSING\n\n" +
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\"想\"}}]}\n\n" +
            "data: {\"choices\":[{\"delta\":{\"content\":\"你好😀\"}}]}\r\n\r\n" +
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":3,\"cost\":0.0012,\"prompt_tokens_details\":{\"cached_tokens\":64}}}\n\n" +
            "data: [DONE]\n\n"
        server.handlers += TinySseServer.Handler { _, ex ->
            ex.head(200)
            val bytes = sse.toByteArray(Charsets.UTF_8)
            // 每 3 字节一片：会切开 UTF-8 多字节字符和 \r\n
            bytes.toList().chunked(3).forEach { ex.raw(it.toByteArray()); Thread.sleep(1) }
        }
        val ev = collect(req())
        assertEquals(StreamEvent.Status(200), ev.first())
        assertEquals(listOf(StreamEvent.Reasoning("想"), StreamEvent.Delta("你好😀"), StreamEvent.Finish("stop")),
            ev.filter { it is StreamEvent.Reasoning || it is StreamEvent.Delta || it is StreamEvent.Finish })
        val u = ev.filterIsInstance<StreamEvent.UsageUpdate>().last().usage
        assertEquals(Usage(prompt = 100, completion = 3, hit = 64, miss = 36, cacheSupported = true, source = "openai", costUsd = 0.0012), u)
        assertTrue(ev.none { it is StreamEvent.Error })

        val rec = server.requests.poll(1, TimeUnit.SECONDS)!!
        assertEquals("POST", rec.method); assertEquals("/api/v1/chat/completions", rec.path)
        assertEquals("Bearer sk-test", rec.headers["authorization"])
        assertEquals("text/event-stream", rec.headers["accept"])
        val body = Js.json.parseToJsonElement(rec.body) as JsonObject
        assertEquals(ProviderRules.orSessionIdFor("c1"), (body["session_id"] as JsonPrimitive).content)
        assertEquals(true, (body["stream_options"] as JsonObject)["include_usage"].let { (it as JsonPrimitive).content.toBoolean() })
    }

    @Test fun usageMergesAcrossChunks() {
        server.handlers += TinySseServer.Handler { _, ex ->
            ex.head(200)
            ex.text("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}],\"usage\":{\"prompt_tokens\":50}}\n\n")
            ex.text("data: {\"choices\":[],\"usage\":{\"completion_tokens\":7,\"prompt_cache_hit_tokens\":40,\"prompt_cache_miss_tokens\":10,\"prompt_tokens\":50}}\n\ndata: [DONE]\n\n")
        }
        val us = collect(req()).filterIsInstance<StreamEvent.UsageUpdate>().map { it.usage }
        assertEquals(Usage(prompt = 50), us[0])
        assertEquals(Usage(prompt = 50, completion = 7, hit = 40, miss = 10, cacheSupported = true, source = "deepseek"), us[1])
    }

    @Test fun httpErrorBodyBecomesReadableError() {
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(401, "application/json"); ex.text("{\"error\":{\"message\":\"bad key\"}}") }
        val ev = collect(req())
        assertEquals(StreamEvent.Status(401), ev[0])
        val e = ev[1] as StreamEvent.Error
        assertEquals(401, e.httpStatus)
        assertEquals("HTTP 401（API Key 无效或未填写）：bad key", e.message)
        assertEquals("{\"error\":{\"message\":\"bad key\"}}", e.raw)
        assertEquals(2, ev.size)
    }

    @Test fun openRouter402DowngradesMaxTokensOnceAndRetries() {
        server.handlers += TinySseServer.Handler { _, ex ->
            ex.head(402, "application/json")
            ex.text("{\"error\":{\"message\":\"You requested up to 65536 tokens, but can only afford 10000.\",\"code\":402}}")
        }
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(200); ex.text("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n") }
        val ev = collect(req())
        assertEquals(listOf(StreamEvent.Status(402), StreamEvent.Status(200), StreamEvent.Delta("ok")), ev)
        val first = server.requests.poll(1, TimeUnit.SECONDS)!!; val second = server.requests.poll(1, TimeUnit.SECONDS)!!
        assertTrue(first.body.contains("\"max_tokens\":65536"))
        // 与 JS 重建请求体逐字一致（只有 max_tokens 不同）
        val rebuilt = client.buildChatRequest(provider(), "m", listOf(WireMessage(Role.USER, "hi")), "sys", ChatOptions(maxTokens = 8000, convId = "c1"))
        assertEquals(rebuilt.body, second.body)
        assertEquals("Bearer sk-test", second.headers["authorization"])
    }

    @Test fun second402IsReportedWithHint() {
        repeat(2) {
            server.handlers += TinySseServer.Handler { _, ex -> ex.head(402, "application/json"); ex.text("{\"error\":{\"message\":\"can only afford 300\"}}") }
        }
        val ev = collect(req())
        val err = ev.filterIsInstance<StreamEvent.Error>().single()
        assertEquals(402, err.httpStatus)
        assertTrue(err.message, err.message.endsWith("\n请在设置里调小「最大输出 tokens」后再试。"))
        assertEquals(2, server.requests.size)
    }

    @Test fun nonStreamAndJsonFallback() {
        server.handlers += TinySseServer.Handler { _, ex ->
            ex.head(200, "application/json")
            ex.text("{\"choices\":[{\"message\":{\"content\":\"整包\",\"reasoning_content\":\"r\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}")
        }
        // 请求了流式，服务商却回了整包 JSON → 兜底解析
        val ev = collect(req(stream = true))
        assertEquals(listOf(StreamEvent.Status(200), StreamEvent.Reasoning("r"), StreamEvent.Delta("整包"), StreamEvent.Finish("stop"),
            StreamEvent.UsageUpdate(Usage(prompt = 3, completion = 2))), ev)
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(200, "application/json"); ex.text("{\"choices\":[{\"message\":{\"content\":\"x\"}}]}") }
        val ev2 = collect(req(stream = false))
        assertEquals(listOf(StreamEvent.Status(200), StreamEvent.Delta("x")), ev2)
        server.requests.poll(); assertFalse(server.requests.poll(1, TimeUnit.SECONDS)!!.headers.containsKey("accept"))
    }

    @Test fun cancellingCollectorDisconnectsCall() {
        server.handlers += TinySseServer.Handler { _, ex ->
            ex.head(200)
            ex.text("data: {\"choices\":[{\"delta\":{\"content\":\"first\"}}]}\n\n")
            // 之后持续慢速写 keep-alive，直到客户端断开（写失败抛异常 → clientClosed）
            repeat(500) { Thread.sleep(20); ex.text(": ping\n\n") }
        }
        val started = System.nanoTime()
        val firstDelta = runBlocking { withTimeout(5_000) { client.stream(provider(), req()).first { it is StreamEvent.Delta } } }
        assertEquals(StreamEvent.Delta("first"), firstDelta)
        assertTrue("server should observe disconnect", server.clientClosed.await(5, TimeUnit.SECONDS))
        assertTrue((System.nanoTime() - started) / 1_000_000 < 8_000)
    }

    @Test fun takeWhileStopsEarlyToo() {
        server.handlers += TinySseServer.Handler { _, ex ->
            ex.head(200)
            ex.text("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n")
            repeat(500) { Thread.sleep(20); ex.text("data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}\n\n") }
        }
        val got = runBlocking { withTimeout(5_000) { client.stream(provider(), req()).takeWhile { it !is StreamEvent.Delta || (it as StreamEvent.Delta).text == "a" || it is StreamEvent.Status }.toList() } }
        assertEquals(listOf(StreamEvent.Status(200), StreamEvent.Delta("a")), got)
        assertTrue(server.clientClosed.await(5, TimeUnit.SECONDS))
    }

    @Test fun midStreamErrorObjectIsSurfaced() {
        server.handlers += TinySseServer.Handler { _, ex ->
            ex.head(200); ex.text("data: {\"choices\":[{\"delta\":{\"content\":\"部分\"}}]}\n\ndata: {\"error\":{\"message\":\"upstream overloaded\"}}\n\n")
        }
        val ev = collect(req())
        assertEquals(listOf(StreamEvent.Status(200), StreamEvent.Delta("部分"), StreamEvent.Error(200, "upstream overloaded", "")), ev)
    }

    @Test fun authInjectorStripsCallerHeadersAndRejectsForeignOrigin() {
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(200); ex.text("data: [DONE]\n\n") }
        val r = req().let { it.copy(headers = it.headers + mapOf("authorization" to "Bearer stolen", "X-Api-Key" to "x", "X-Custom" to "1")) }
        collect(r)
        val rec = server.requests.poll(1, TimeUnit.SECONDS)!!
        assertEquals("Bearer sk-test", rec.headers["authorization"]); assertNull(rec.headers["x-api-key"]); assertEquals("1", rec.headers["x-custom"])

        val foreign = r.copy(url = "http://example.invalid/api/v1/chat/completions")
        val ev = collect(foreign)
        assertEquals(listOf(StreamEvent.Error(0, "请求地址与服务商 Base URL 不一致，已拒绝", "")), ev)
        assertEquals(0, server.requests.size)
    }

    @Test fun anthropicKeyHeaderAndNoKeyCase() {
        val inj = AuthInjector(FakeVault(mapOf("a" to "k1"), AuthType.ANTHROPIC))
        val br = com.aichat.app.domain.BuiltRequest("https://api.anthropic.com/v1/messages", "POST", mapOf("x-api-key" to "old"), "{}")
        assertEquals(mapOf("x-api-key" to "k1"), inj.authorize("a", "https://api.anthropic.com", br).headers)
        assertEquals(emptyMap<String, String>(), AuthInjector(FakeVault(emptyMap())).authorize("a", "https://api.anthropic.com", br).headers)
    }

    @Test fun redirectsAreNotFollowedForKeyedRequests() {
        server.handlers += TinySseServer.Handler { _, ex -> ex.head(307, "text/plain", mapOf("Location" to "http://example.invalid/steal")); ex.text("moved") }
        val ev = collect(req(), provider())
        assertEquals(StreamEvent.Status(307), ev[0])
        assertTrue(ev[1] is StreamEvent.Error)
        assertEquals(1, server.requests.size)
        assertFalse(HttpClients.authed.followRedirects)
    }

    @Test fun networkErrorMessage() {
        val dead = ProviderConfig("or", "custom", "P", ProviderType.OPENAI, "http://127.0.0.1:1/v1", listOf("m"))
        val ev = runBlocking { withTimeout(10_000) { client.stream(dead, client.buildChatRequest(dead, "m", listOf(WireMessage(Role.USER, "hi")), "", ChatOptions())).toList() } }
        val e = ev.single() as StreamEvent.Error
        assertTrue(e.message, e.message.startsWith("网络错误：") && e.message.endsWith("\n请检查网络连接和 Base URL。"))
    }

    class FakeVault(private val keys: Map<String, String>, private val type: AuthType = AuthType.BEARER) : KeyVault {
        override fun has(providerId: String) = keys.containsKey(providerId)
        override fun set(providerId: String, key: String) = false
        override fun delete(providerId: String) {}
        override fun keyFor(providerId: String, requestUrl: String) = keys[providerId]
        override fun authType(providerId: String) = type
    }
}
