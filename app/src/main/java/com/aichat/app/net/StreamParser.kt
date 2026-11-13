package com.aichat.app.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** providers.js extractDeltas 的输出：{kind:'text'|'reasoning'|'error'|'usage'|'finish', …} */
sealed interface StreamDelta {
    data class Text(val text: String) : StreamDelta
    data class Reasoning(val text: String) : StreamDelta
    data class Error(val text: String) : StreamDelta
    data class UsageDelta(val usage: JsonObject) : StreamDelta
    data class Finish(val reason: String) : StreamDelta

    /** 与 JS 对象同形（golden 比对用） */
    fun toJson(): JsonObject = when (this) {
        is Text -> buildJsonObject { put("kind", "text"); put("text", text) }
        is Reasoning -> buildJsonObject { put("kind", "reasoning"); put("text", text) }
        is Error -> buildJsonObject { put("kind", "error"); put("text", text) }
        is UsageDelta -> buildJsonObject { put("kind", "usage"); put("usage", usage) }
        is Finish -> buildJsonObject { put("kind", "finish"); put("reason", reason) }
    }
    /** app.js apply()：text / reasoning / error 计为「已收到内容」（gotDelta），usage / finish 不计 */
    val countsAsContent: Boolean get() = this is Text || this is Reasoning || this is Error
}

object Deltas {
    private fun o(e: JsonElement?) = e as? JsonObject
    private fun s(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun errText(err: JsonElement): String {
        val m = o(err)?.get("message")
        return if (Js.truthy(m)) Js.str(m) else Js.stringify(err)
    }

    fun extract(type: String, obj: JsonElement?): List<StreamDelta> {
        val out = mutableListOf<StreamDelta>()
        if (!Js.truthy(obj)) return out
        val ob = obj as? JsonObject ?: JsonObject(emptyMap())
        when (type) {
            "anthropic" -> {
                val t = s(ob["type"])
                val au = if (t == "message_start" && Js.truthy(ob["message"])) o(ob["message"])?.get("usage") else ob["usage"]
                UsageCodec.normalizeUsage("anthropic", au)?.let { out += StreamDelta.UsageDelta(it) }
                val delta = o(ob["delta"])
                if (t == "content_block_delta" && Js.truthy(ob["delta"])) {
                    when (s(delta?.get("type"))) {
                        "text_delta" -> out += StreamDelta.Text(textOr(delta?.get("text")))
                        "thinking_delta" -> out += StreamDelta.Reasoning(textOr(delta?.get("thinking")))
                    }
                } else if (t == "error") {
                    val m = o(ob["error"])?.get("message")
                    out += StreamDelta.Error(if (Js.truthy(ob["error"]) && Js.truthy(m)) Js.str(m) else Js.stringify(ob))
                } else if (ob["content"] is JsonArray) {
                    (ob["content"] as JsonArray).forEach { c ->
                        val co = o(c)
                        when (s(co?.get("type"))) {
                            "text" -> out += StreamDelta.Text(Js.str(co?.get("text")))
                            "thinking" -> out += StreamDelta.Reasoning(Js.str(co?.get("thinking")))
                        }
                    }
                }
            }
            "gemini" -> {
                if (Js.truthy(ob["error"])) { out += StreamDelta.Error(errText(ob["error"]!!)); return out }
                UsageCodec.normalizeUsage("gemini", ob["usageMetadata"])?.let { out += StreamDelta.UsageDelta(it) }
                val c0 = o((ob["candidates"] as? JsonArray)?.firstOrNull())
                val parts = o(c0?.get("content"))?.get("parts")
                if (Js.truthy(c0?.get("content")) && Js.truthy(parts)) (parts as? JsonArray)?.forEach { p ->
                    val po = o(p); val txt = s(po?.get("text"))
                    if (txt != null) out += if (Js.truthy(po?.get("thought"))) StreamDelta.Reasoning(txt) else StreamDelta.Text(txt)
                }
            }
            else -> {
                if (Js.truthy(ob["error"])) { out += StreamDelta.Error(errText(ob["error"]!!)); return out }
                val ch = o((ob["choices"] as? JsonArray)?.firstOrNull())
                if (ch != null) {
                    val d = o(if (Js.truthy(ch["delta"])) ch["delta"] else if (Js.truthy(ch["message"])) ch["message"] else null) ?: JsonObject(emptyMap())
                    val r = if (Js.truthy(d["reasoning_content"])) d["reasoning_content"] else d["reasoning"]
                    s(r)?.takeIf { it.isNotEmpty() }?.let { out += StreamDelta.Reasoning(it) }
                    s(d["content"])?.takeIf { it.isNotEmpty() }?.let { out += StreamDelta.Text(it) }
                    if (Js.truthy(ch["finish_reason"])) out += StreamDelta.Finish(Js.str(ch["finish_reason"]))
                }
                UsageCodec.normalizeUsage("openai", ob["usage"])?.let { out += StreamDelta.UsageDelta(it) }
            }
        }
        return out
    }
    /** JS: obj.delta.text || '' */
    private fun textOr(e: JsonElement?) = if (Js.truthy(e)) Js.str(e) else ""

    /** 非流式完整响应（也用于「请求了流式但服务商回了整包 JSON」的兜底） */
    fun parseFullResponse(type: String, text: String): List<StreamDelta> {
        val obj = try { Js.json.parseToJsonElement(text) } catch (e: Exception) {
            return listOf(StreamDelta.Error("无法解析响应：" + text.take(300)))
        }
        if (obj is JsonArray) return obj.flatMap { extract(type, it) }
        return extract(type, obj)
    }

    private val HINTS = mapOf(
        401 to "API Key 无效或未填写", 403 to "无权限访问（检查 Key/地区/账户）", 404 to "地址或模型名不存在",
        429 to "请求过于频繁或额度不足", 400 to "请求参数有误",
        402 to "额度不足或 max_tokens 过大（请在设置里调小「最大输出 tokens」）",
    )
    /** HTTP 错误 → 可读信息（parseError） */
    fun parseError(status: Int, text: String?): String {
        var msg = ""
        try {
            val obj = Js.json.parseToJsonElement(text ?: "")
            val oo = obj as? JsonObject
            val e: JsonElement? = if (obj is JsonArray) { val f = obj.firstOrNull(); if (Js.truthy(f)) o(f)?.get("error") else f } else oo?.get("error")
            if (obj is kotlinx.serialization.json.JsonNull) throw IllegalStateException()
            val fromE: JsonElement? = if (Js.truthy(e)) {
                val m = o(e)?.get("message")
                if (Js.truthy(m)) m else if (e is JsonPrimitive && e.isString) e else JsonPrimitive("")
            } else e
            msg = when {
                Js.truthy(fromE) -> Js.str(fromE)
                Js.truthy(oo?.get("message")) -> Js.str(oo!!["message"])
                Js.truthy(oo?.get("msg")) -> Js.str(oo!!["msg"])
                else -> ""
            }
        } catch (e: Exception) { /* 非 JSON */ }
        if (msg.isEmpty()) msg = (text ?: "").take(500)
        val hint = HINTS[status]
        return "HTTP " + status + (if (hint != null) "（$hint）" else "") + (if (msg.isNotEmpty()) "：$msg" else "")
    }
}

/**
 * createStreamParser(type)：喂任意切分的文本块，按 SSE 规则拆事件 → JSON.parse → extractDeltas。
 * 规则同 JS：\n 分行、去尾部 \r、空行结束事件、':' 开头为注释、只认 data:（去掉 1 个前导空格），event:/id:/retry: 忽略；
 * 多行 data 以 \n 连接；"[DONE]" 置 done（之后的数据仍会处理，与 JS 一致）；非 JSON 忽略。
 */
class StreamParser(private val type: String) {
    private val buf = StringBuilder()
    private val dataLines = mutableListOf<String>()
    var done = false
        private set

    private fun flushEvent(out: MutableList<StreamDelta>) {
        if (dataLines.isEmpty()) return
        val data = dataLines.joinToString("\n"); dataLines.clear()
        if (Js.trim(data) == "[DONE]") { done = true; return }
        val obj = try { Js.json.parseToJsonElement(data) } catch (e: Exception) { return }
        out += Deltas.extract(type, obj)
    }
    private fun processLine(raw: String, out: MutableList<StreamDelta>) {
        val line = if (raw.endsWith("\r")) raw.dropLast(1) else raw
        if (line.isEmpty()) { flushEvent(out); return }
        if (line.startsWith(":")) return
        if (line.startsWith("data:")) dataLines += line.substring(5).let { if (it.startsWith(" ")) it.substring(1) else it }
    }
    fun push(chunk: String): List<StreamDelta> {
        val out = mutableListOf<StreamDelta>()
        buf.append(chunk)
        var start = 0
        while (true) {
            val idx = buf.indexOf("\n", start); if (idx < 0) break
            processLine(buf.substring(start, idx), out); start = idx + 1
        }
        if (start > 0) buf.delete(0, start)
        return out
    }
    fun end(): List<StreamDelta> {
        val out = mutableListOf<StreamDelta>()
        if (buf.isNotEmpty()) { processLine(buf.toString(), out); buf.setLength(0) }
        flushEvent(out)
        return out
    }
}
