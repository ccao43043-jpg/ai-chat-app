package com.aichat.app.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/** 工作流 B · M1：Kotlin 实现 vs providers.js（Node 导出的 golden） */
class ProvidersGoldenTest {

    @Test fun buildChatRequestOpenAiMatchesJsByteForByte() {
        val cases = Golden.load("buildChatRequest.openai.jsonl")
        assertTrue(cases.size >= 30)
        for (c in cases) {
            val (p, model, msgs, sys, opts) = c.input
            val r = OpenAiCompat.build(Golden.provider(p), (model as JsonPrimitive).content, Golden.messages(msgs),
                (sys as JsonPrimitive).content, Golden.opts(opts))
            val exp = c.out as JsonObject
            assertEquals("${c.name} url", (exp["url"] as JsonPrimitive).content, r.url)
            assertEquals("${c.name} method", (exp["method"] as JsonPrimitive).content, r.method)
            Golden.assertSemantic("${c.name} headers", exp["headers"], JsonObject(r.headers.mapValues { JsonPrimitive(it.value) }))
            val expBody = (exp["body"] as JsonPrimitive).content
            Golden.assertSemantic("${c.name} body(semantic)", Js.json.parseToJsonElement(expBody), Js.json.parseToJsonElement(r.body))
            // 缓存前缀稳定性：整串逐字一致（键序、转义、数字格式）
            assertEquals("${c.name} body(bytes)", expBody, r.body)
        }
    }

    @Test fun bodyPatchOverridesSessionIdInPlace() {
        val c = Golden.load("buildChatRequest.openai.jsonl").first { it.name == "openrouter-session" }
        val (p, model, msgs, sys, opts) = c.input
        val patch = buildJsonObject { put("session_id", "gc-123"); put("cachedContent", "x") }
        val body = OpenAiCompat.buildBody(Golden.provider(p), (model as JsonPrimitive).content, Golden.messages(msgs),
            (sys as JsonPrimitive).content, Golden.opts(opts), patch)
        assertEquals("gc-123", (body["session_id"] as JsonPrimitive).content)
        assertEquals(listOf("session_id", "cachedContent"), body.keys.toList().takeLast(2))
    }

    @Test fun orSessionIdFor() {
        for (c in Golden.load("orSessionIdFor.jsonl")) {
            val id = (c.input[0] as JsonPrimitive).content
            val ns = (c.input.getOrNull(1) as? JsonPrimitive)?.content
            assertEquals(id, (c.out as JsonPrimitive).content, ProviderRules.orSessionIdFor(id, ns))
        }
        assertEquals("", ProviderRules.orSessionIdFor(""))
        assertEquals("", ProviderRules.orSessionIdFor(null))
    }

    @Test fun normalizeUsage() {
        val cases = Golden.load("normalizeUsage.jsonl")
        assertTrue(cases.size >= 20)
        for ((i, c) in cases.withIndex()) {
            val type = (c.input[0] as JsonPrimitive).content
            Golden.assertSemantic("normalizeUsage#$i $type ${Js.stringify(c.input[1])}", c.out, UsageCodec.normalizeUsage(type, c.input[1]) ?: JsonNull)
        }
    }

    @Test fun mergeUsage() {
        for ((i, c) in Golden.load("mergeUsage.jsonl").withIndex()) {
            Golden.assertSemantic("mergeUsage#$i", c.out, UsageCodec.mergeUsage(c.input[0] as? JsonObject, c.input[1] as? JsonObject) ?: JsonNull)
        }
    }

    private fun runParser(type: String, text: String, cuts: List<Int>): Pair<List<JsonElement>, Boolean> {
        val p = StreamParser(type)
        val out = mutableListOf<StreamDelta>()
        var prev = 0
        for (cut in cuts + text.length) { out += p.push(text.substring(prev, cut)); prev = cut }
        out += p.end()
        return out.map { it.toJson() } to p.done
    }

    /** 录制形态的 SSE：整块喂入 + 每份随机切分 200 次（固定种子），增量序列都必须等于 JS 输出 */
    @Test fun createStreamParserRandomSplits() {
        val rnd = Random(20261113)
        val cases = Golden.load("createStreamParser.openai.jsonl") + Golden.load("createStreamParser.other.jsonl")
        assertTrue(cases.size >= 10)
        for (c in cases) {
            val type = (c.input[0] as JsonPrimitive).content
            val text = (c.input[1] as JsonPrimitive).content
            val exp = c.out as JsonObject
            val expDeltas = exp["deltas"] as JsonArray
            val expDone = (exp["done"] as JsonPrimitive).booleanOrNull
            repeat(201) { iter ->
                val cuts = if (iter == 0) emptyList() else List(rnd.nextInt(0, 12)) { rnd.nextInt(0, text.length + 1) }.sorted()
                val (got, done) = runParser(type, text, cuts)
                Golden.assertSemantic("${c.name} cuts=$cuts", expDeltas, JsonArray(got))
                assertEquals("${c.name} done", expDone, done)
            }
            // 逐字符喂入
            val (got, _) = runParser(type, text, (1 until text.length).toList())
            Golden.assertSemantic("${c.name} char-by-char", expDeltas, JsonArray(got))
        }
    }

    @Test fun parseFullResponse() {
        for (c in Golden.load("parseFullResponse.openai.jsonl")) {
            val got = Deltas.parseFullResponse((c.input[0] as JsonPrimitive).content, (c.input[1] as JsonPrimitive).content)
            Golden.assertSemantic("parseFullResponse", c.out, JsonArray(got.map { it.toJson() }))
        }
    }

    @Test fun parseError() {
        for (c in Golden.load("parseError.jsonl")) {
            val s = (c.input[0] as JsonPrimitive).intOrNull!!
            assertEquals((c.out as JsonPrimitive).content, Deltas.parseError(s, (c.input[1] as JsonPrimitive).content))
        }
    }

    @Test fun maxTokensHelpers() {
        for (c in Golden.load("resolveMaxTokens.jsonl")) {
            val meta = (c.input[0] as? JsonObject)?.get("modelMeta") as? JsonObject
            val got = ProviderRules.resolveMaxTokens(meta, (c.input[1] as? JsonPrimitive)?.content, c.input[2])
            Golden.assertSemantic("resolveMaxTokens ${Js.stringify(c.input)}", c.out, Js.number(got))
        }
        for (c in Golden.load("parseAffordTokens.jsonl")) {
            val t = (c.input[0] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
            val got = ProviderRules.parseAffordTokens(t)
            Golden.assertSemantic("parseAffordTokens $t", c.out, got?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        for (c in Golden.load("downgradeMaxTokens.jsonl")) {
            val a = (c.input[0] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.doubleOrNull
            val min = ((c.input.getOrNull(1) as? JsonObject)?.get("min") as? JsonPrimitive)?.intOrNull
            Golden.assertSemantic("downgradeMaxTokens ${Js.stringify(c.input)}", c.out, JsonPrimitive(ProviderRules.downgradeMaxTokens(a, min)))
        }
        val meta = Js.json.parseToJsonElement("""{"m":{"maxOutput":4096}}""") as JsonObject
        val p = com.aichat.app.domain.model.ProviderConfig("p", "openrouter", "OR", com.aichat.app.domain.model.ProviderType.OPENAI, "https://openrouter.ai/api/v1", listOf("m"), modelMeta = meta)
        assertEquals(4096, ProviderRules.resolveMaxTokens(p, "m", null))
        assertEquals(2000, ProviderRules.resolveMaxTokens(p, "m", 2000))
        assertEquals(8192, ProviderRules.resolveMaxTokens(p, "other", null))
    }
}
