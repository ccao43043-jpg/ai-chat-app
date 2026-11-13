package com.aichat.app.engine

import com.aichat.app.domain.model.FileAttachment
import com.aichat.app.domain.model.Message
import com.aichat.app.net.Js
import com.aichat.app.net.SearchCore
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * files.js 的 buildFileContext / capText + app.js toRequestMsg（文件展开、扫描版 PDF 提示、本轮搜索结果注入）。
 * 文件抽取（pdf.js / docx / xlsx…）在 UI 侧完成，引擎只拿抽好的文字（契约 #m FileAttachment）。golden：files.context.jsonl。
 */
object FileContext {
    const val DEFAULT_FILE_MAX = 30000
    const val DEFAULT_TOTAL_MAX = 80000

    data class Capped(val text: String, val truncated: Boolean, val total: Int)
    fun capText(text: String?, max: Int): Capped {
        val t = text ?: ""
        return if (t.length <= max) Capped(t, false, t.length) else Capped(t.substring(0, max), true, t.length)
    }

    /** buildFileContext(files, question, {totalMax})：files 为 app.js user.files[] 形状（JsonObject） */
    fun buildFileContext(files: List<JsonElement?>, question: String?, totalMax: Int = DEFAULT_TOTAL_MAX): String {
        var used = 0
        val blocks = files.filter { f -> f is JsonObject && Js.truthy(f["text"]) }.map { fe ->
            val f = fe as JsonObject
            var body = Js.str(f["text"]); var truncated = Js.truthy(f["truncated"])
            val remain = totalMax - used
            if (body.length > remain) { body = body.substring(0, maxOf(0, remain)); truncated = true }
            used += body.length
            val meta = listOf(if (Js.truthy(f["pages"])) Js.str(f["pages"]) + " 页" else "", if (Js.truthy(f["total"])) Js.str(f["total"]) + " 字符" else "")
                .filter { it.isNotEmpty() }.joinToString("，")
            "【文件：" + Js.str(f["name"]) + "】" + (if (meta.isNotEmpty()) "（$meta）" else "") + "\n" + body +
                (if (truncated) "\n【注意：文件内容过长，以上仅为前 " + body.length + " 个字符，后续内容已截断】" else "") + "\n【文件结束：" + Js.str(f["name"]) + "】"
        }
        if (blocks.isEmpty()) return question ?: ""
        return "用户上传了以下文件，请基于文件内容回答：\n\n" + blocks.joinToString("\n\n") + "\n\n" +
            (if (!question.isNullOrEmpty()) "用户的问题：$question" else "请先概括这些文件的主要内容。")
    }

    /**
     * app.js toRequestMsg(m, injectSearch) 的 content 部分：用户消息展开 files[]（有文字的拼上下文，扫描版加识图提示），
     * injectSearch 时把 m.search.results 拼成搜索上下文（today = 本地日期）。
     */
    fun requestContent(role: String, content: String?, files: List<JsonObject>, search: JsonElement?, injectSearch: Boolean, today: String): String {
        var c = content ?: ""
        if (role == "user" && files.isNotEmpty()) {
            val withText = files.filter { Js.truthy(it["text"]) }
            if (withText.isNotEmpty()) c = buildFileContext(withText, c)
            val scanned = files.filter { Js.truthy(it["scanned"]) }
            if (scanned.isNotEmpty()) c = "（附带的 " + scanned.joinToString("、") { "「" + Js.str(it["name"]) + "」" } + " 为扫描版 PDF，已转成图片附上，请识别图片中的文字。）\n" +
                c.ifEmpty { "请识别并概括这些图片中的内容。" }
        }
        val results = ((search as? JsonObject)?.get("results") as? JsonArray)
        if (injectSearch && Js.truthy(search) && results != null && results.isNotEmpty())
            c = SearchCore.buildSearchContext(results.mapNotNull { it as? JsonObject }, c, today)
        return c
    }
    fun requestContent(m: Message, injectSearch: Boolean, today: String): String =
        requestContent(m.role.wire, m.content, m.files, m.extras["search"], injectSearch, today)

    /** 契约 FileAttachment → user.files[] 元素：用 D 的 AttachmentCodec（键名键序同 app.js send()） */
    fun encode(f: FileAttachment): JsonObject = com.aichat.app.data.codec.AttachmentCodec.encode(f)
}
