package com.aichat.app.net

import com.aichat.app.engine.FileContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import org.junit.Assert.assertEquals
import org.junit.Test

/** M4 golden（export-m4.js）：NetRetry / 搜索 / 文件展开 */
class M4GoldenTest {
    private fun s(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
    private fun nn(e: JsonElement?): JsonElement? = e?.takeIf { it !is JsonNull }
    private fun obj(e: JsonElement?): JsonObject = e as? JsonObject ?: JsonObject(emptyMap())

    @Test fun netRetry() {
        for (c in Golden.load("netretry.jsonl")) {
            val label = Js.stringify(c.input)
            when (c.name) {
                "classify" -> {
                    val st = Js.toNumber(c.input[0]).let { if (it.isNaN()) 0.0 else it }
                    val k = NetRetry.classify(st, s(c.input[1]), s(c.input[2]))
                    Golden.assertExact(label, c.out, JsonObject(linkedMapOf("kind" to JsonPrimitive(k.kind), "retry" to JsonPrimitive(k.retry), "label" to JsonPrimitive(k.label))))
                }
                "backoff" -> assertEquals(label, Js.toNumber(c.out).toLong(),
                    NetRetry.backoff(Js.toNumber(c.input[0]), s(c.input[1]), Js.toNumber(c.input[2])))
                "shouldRetry" -> {
                    val k = (c.input[0] as? JsonObject)?.let { NetRetry.Kind("x", (it["retry"] as JsonPrimitive).booleanOrNull == true, "") }
                    assertEquals(label, (c.out as JsonPrimitive).booleanOrNull, NetRetry.shouldRetry(k, Js.toNumber(c.input[1]).toInt(),
                        (c.input[2] as JsonPrimitive).booleanOrNull!!, (c.input[3] as JsonPrimitive).booleanOrNull!!))
                }
                else -> error("unknown ${c.name}")
            }
        }
    }

    @Test fun searchRequest() {
        for (c in Golden.load("search.request.jsonl")) {
            val o = obj(c.input[0])
            val cfg = SearchCore.Cfg(s(o["provider"])!!, false, s(o["baseUrl"]) ?: "", nn(o["count"]), s(o["apiKey"]) ?: "")
            val got: JsonElement = try {
                val r = SearchCore.buildSearchRequest(cfg, s(c.input[1]))
                JsonObject(linkedMapOf("url" to JsonPrimitive(r.url), "method" to JsonPrimitive(r.method),
                    "headers" to JsonObject(r.headers.mapValues { JsonPrimitive(it.value) }),
                    "body" to (if (r.body.isEmpty()) JsonNull else JsonPrimitive(r.body))))
            } catch (e: IllegalArgumentException) { JsonObject(mapOf("error" to JsonPrimitive(e.message))) }
            Golden.assertExact(Js.stringify(c.input).take(120), c.out, got)
        }
    }

    @Test fun searchParse() {
        for (c in Golden.load("search.parse.jsonl")) {
            val got: JsonElement = try { JsonArray(SearchCore.parseSearchResponse(s(c.input[0])!!, s(c.input[1])!!, nn(c.input[2]))) }
                catch (e: SearchCore.SearchParseException) { JsonObject(mapOf("error" to JsonPrimitive(if (e.syntax) "SyntaxError" else e.message))) }
            Golden.assertExact(Js.stringify(c.input).take(120), c.out, got)
        }
    }

    @Test fun searchContextRewriteErrorText() {
        for (c in Golden.load("search.context.jsonl")) {
            val o = obj(c.input[2])
            val got = SearchCore.buildSearchContext((c.input[0] as JsonArray).map { it as JsonObject }, s(c.input[1])!!, s(o["today"])!!,
                nn(o["maxChars"])?.let { Js.toNumber(it).toInt() } ?: 6000)
            assertEquals(Js.stringify(c.input).take(120), s(c.out), got)
        }
        for (c in Golden.load("search.rewrite.jsonl")) {
            val label = Js.stringify(c.input).take(120)
            when (c.name) {
                "prompt" -> assertEquals(label, s(c.out), SearchCore.buildRewritePrompt(s(c.input[0])!!,
                    (nn(c.input[1]) as? JsonArray)?.map { SearchCore.Turn(s(obj(it)["role"])!!, s(obj(it)["content"])) }))
                "clean" -> assertEquals(label, s(c.out), SearchCore.cleanRewrite(s(c.input[0]), s(c.input[1])!!))
                "host" -> assertEquals(label, s(c.out), SearchCore.hostOf(s(c.input[0])))
            }
        }
        for (c in Golden.load("search.errorText.jsonl"))
            assertEquals(Js.stringify(c.input).take(120), s(c.out), SearchCore.searchErrorText(Js.toNumber(c.input[0]).toInt(), s(c.input[1])))
    }

    @Test fun filesContext() {
        for (c in Golden.load("files.context.jsonl")) {
            val label = Js.stringify(c.input).take(120)
            when (c.name) {
                "buildFileContext" -> {
                    val max = nn(obj(nn(c.input[2]))["totalMax"])?.let { Js.toNumber(it).toInt() } ?: FileContext.DEFAULT_TOTAL_MAX
                    assertEquals(label, s(c.out), FileContext.buildFileContext((c.input[0] as JsonArray).map { nn(it) }, s(c.input[1]), max))
                }
                "capText" -> {
                    val r = FileContext.capText(s(c.input[0]), Js.toNumber(c.input[1]).toInt())
                    Golden.assertExact(label, c.out, JsonObject(linkedMapOf("text" to JsonPrimitive(r.text), "truncated" to JsonPrimitive(r.truncated), "total" to JsonPrimitive(r.total))))
                }
                "toRequestMsg" -> {
                    val m = obj(c.input[0])
                    val got = FileContext.requestContent(s(m["role"])!!, s(m["content"]), (nn(m["files"]) as? JsonArray)?.map { it as JsonObject } ?: emptyList(),
                        nn(m["search"]), (c.input[1] as JsonPrimitive).booleanOrNull!!, s(c.input[2])!!)
                    assertEquals(label, s(obj(c.out)["content"]), got)
                }
            }
        }
    }
}
