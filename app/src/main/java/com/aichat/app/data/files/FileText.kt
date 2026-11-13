package com.aichat.app.data.files

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.charset.Charset
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Locale
import java.util.zip.ZipInputStream

/**
 * 文件文本抽取（files.js 的 Kotlin 移植，工作流 A 所有）。纯 JVM，可单测。
 * PDF 用本目录的 [PdfText]（不引入第三方库，覆盖常见的文字型 PDF）；扫描版 PDF 由 UI 用系统 PdfRenderer 转成图片。
 */
object FileText {
    val TEXT_EXTS = setOf("txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "html", "htm", "yaml", "yml", "toml", "ini", "cfg", "conf", "log",
        "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "java", "kt", "kts", "c", "h", "cpp", "hpp", "cc", "cs", "go", "rs", "rb", "php", "swift", "m", "mm",
        "sh", "bash", "zsh", "bat", "ps1", "sql", "r", "lua", "dart", "scala", "vue", "svelte", "css", "scss", "less", "gradle", "properties", "srt", "vtt", "tex", "rst", "org")
    val IMAGE_EXTS = setOf("png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif")
    const val DEFAULT_FILE_MAX = 30000
    const val DEFAULT_TOTAL_MAX = 80000

    fun extOf(name: String?): String = Regex("\\.([A-Za-z0-9]+)$").find(name ?: "")?.groupValues?.get(1)?.lowercase(Locale.ROOT) ?: ""

    /** image | pdf | docx | pptx | xlsx | text | unsupported | unknown */
    fun classifyFile(name: String?, mime: String?): String {
        val ext = extOf(name); val m = (mime ?: "").lowercase(Locale.ROOT)
        return when {
            m.startsWith("image/") || ext in IMAGE_EXTS -> "image"
            ext == "pdf" || m == "application/pdf" -> "pdf"
            ext == "docx" || m.contains("wordprocessingml") -> "docx"
            ext == "pptx" || m.contains("presentationml") -> "pptx"
            ext == "xlsx" || m.contains("spreadsheetml") -> "xlsx"
            ext in setOf("doc", "ppt", "xls") -> "unsupported"
            ext in TEXT_EXTS || m.startsWith("text/") || Regex("json|xml|javascript|yaml|csv").containsMatchIn(m) -> "text"
            else -> "unknown"
        }
    }

    /** 优先 UTF-8（含 BOM）；UTF-16 BOM；失败按 GB18030（兼容 GBK） */
    fun decodeText(b: ByteArray): Pair<String, String> {
        if (b.size >= 2 && b[0] == 0xFF.toByte() && b[1] == 0xFE.toByte()) return String(b, 2, b.size - 2, Charsets.UTF_16LE) to "utf-16le"
        if (b.size >= 2 && b[0] == 0xFE.toByte() && b[1] == 0xFF.toByte()) return String(b, 2, b.size - 2, Charsets.UTF_16BE) to "utf-16be"
        return try {
            val dec = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            dec.decode(ByteBuffer.wrap(b)).toString().removePrefix("\uFEFF") to "utf-8"
        } catch (e: CharacterCodingException) {
            runCatching { String(b, Charset.forName("GB18030")) to "gb18030" }.getOrElse { String(b, Charsets.UTF_8) to "utf-8" }
        }
    }

    fun looksBinary(text: String): Boolean {
        if (text.isEmpty()) return false
        val sample = text.take(4000)
        val bad = sample.count { c -> c.code == 0xFFFD || c.code < 9 || (c.code in 14..31) }
        return bad.toDouble() / sample.length > 0.08
    }

    fun decodeXmlEntities(s: String): String {
        var t = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'")
        t = Regex("&#x([0-9a-fA-F]+);").replace(t) { m -> m.groupValues[1].toIntOrNull(16)?.let { String(Character.toChars(it)) } ?: m.value }
        t = Regex("&#(\\d+);").replace(t) { m -> m.groupValues[1].toIntOrNull()?.let { String(Character.toChars(it)) } ?: m.value }
        return t.replace("&amp;", "&")
    }

    fun docxXmlToText(xml: String): String {
        val body = xml.replace("<w:tab/>", "\t").replace(Regex("<w:br[^>]*/>"), "\n").replace("<w:cr/>", "\n")
        val re = Regex("<w:t(?:\\s[^>]*)?>([\\s\\S]*?)</w:t>|(\t)|(\n)")
        val out = body.split("</w:p>").map { p ->
            val sb = StringBuilder()
            re.findAll(p).forEach { m -> sb.append(m.groups[1]?.value ?: m.groups[2]?.value ?: m.groups[3]?.value ?: "") }
            decodeXmlEntities(sb.toString())
        }
        return out.joinToString("\n").replace(Regex("\n{3,}"), "\n\n").trim()
    }

    fun pptxXmlToText(xml: String): String = xml.split("</a:p>").map { p ->
        decodeXmlEntities(Regex("<a:t>([\\s\\S]*?)</a:t>").findAll(p).joinToString("") { it.groupValues[1] })
    }.filter { it.isNotBlank() }.joinToString("\n")

    private fun unzip(bytes: ByteArray, want: (String) -> Boolean): Map<String, ByteArray> {
        val out = LinkedHashMap<String, ByteArray>()
        ZipInputStream(ByteArrayInputStream(bytes)).use { z ->
            while (true) {
                val e = z.nextEntry ?: break
                if (!e.isDirectory && want(e.name)) out[e.name] = z.readBytes()
            }
        }
        return out
    }
    private fun ByteArray.utf8() = String(this, Charsets.UTF_8)
    private fun num(n: String) = Regex("\\d+").find(n)?.value?.toInt() ?: 0

    fun extractDocx(bytes: ByteArray): String {
        val z = unzip(bytes) { it == "word/document.xml" || it == "word/footnotes.xml" || it == "word/endnotes.xml" }
        val doc = z["word/document.xml"] ?: throw IllegalArgumentException("不是有效的 Word（.docx）文件")
        var text = docxXmlToText(doc.utf8())
        listOf("word/footnotes.xml", "word/endnotes.xml").forEach { n -> z[n]?.let { val t = docxXmlToText(it.utf8()); if (t.isNotEmpty()) text += "\n\n" + t } }
        return text
    }

    fun extractPptx(bytes: ByteArray): String {
        val re = Regex("^ppt/slides/slide\\d+\\.xml$")
        val z = unzip(bytes) { re.matches(it) }
        val slides = z.keys.sortedBy { num(it) }
        if (slides.isEmpty()) throw IllegalArgumentException("不是有效的 PowerPoint（.pptx）文件")
        return slides.mapIndexed { i, n -> "--- 第 ${i + 1} 页 ---\n" + pptxXmlToText(z[n]!!.utf8()) }.joinToString("\n\n")
    }

    private fun colIndex(ref: String): Int {
        val m = Regex("^([A-Z]+)").find(ref) ?: return 0
        var n = 0; for (ch in m.groupValues[1]) n = n * 26 + (ch.code - 64)
        return n - 1
    }

    fun extractXlsx(bytes: ByteArray, maxRows: Int = 2000): String {
        val sheetRe = Regex("^xl/worksheets/sheet\\d+\\.xml$")
        val z = unzip(bytes) { it == "xl/sharedStrings.xml" || it == "xl/workbook.xml" || sheetRe.matches(it) }
        val shared = ArrayList<String>()
        z["xl/sharedStrings.xml"]?.utf8()?.let { xml ->
            Regex("<si>[\\s\\S]*?</si>").findAll(xml).forEach { si ->
                shared += decodeXmlEntities(Regex("<t(?:\\s[^>]*)?>([\\s\\S]*?)</t>").findAll(si.value).joinToString("") { it.groupValues[1] })
            }
        }
        val names = z["xl/workbook.xml"]?.utf8()?.let { wb -> Regex("<sheet [^>]*name=\"([^\"]*)\"").findAll(wb).map { decodeXmlEntities(it.groupValues[1]) }.toList() }.orEmpty()
        val sheets = z.keys.filter { sheetRe.matches(it) }.sortedBy { num(it) }
        if (sheets.isEmpty()) throw IllegalArgumentException("不是有效的 Excel（.xlsx）文件")
        val cellRe = Regex("<c ([^>]*?)(?:/>|>([\\s\\S]*?)</c>)")
        return sheets.mapIndexed { si, n ->
            val xml = z[n]!!.utf8()
            val rows = Regex("<row[\\s\\S]*?</row>").findAll(xml).take(maxRows).map { row ->
                val cells = ArrayList<String?>()
                cellRe.findAll(row.value).forEach { m ->
                    val attrs = m.groupValues[1]; val inner = m.groups[2]?.value ?: ""
                    val r = Regex("r=\"([A-Z]+\\d+)\"").find(attrs); val t = Regex("t=\"(\\w+)\"").find(attrs)?.groupValues?.get(1)
                    var v: String? = Regex("<v>([\\s\\S]*?)</v>").find(inner)?.groupValues?.get(1)
                    if (t == "s") v = v?.toIntOrNull()?.let { shared.getOrNull(it) }
                    else if (t == "inlineStr") v = Regex("<t[^>]*>([\\s\\S]*?)</t>").find(inner)?.groupValues?.get(1)
                    val s = if (v == null) "" else decodeXmlEntities(v)
                    val cell = if (Regex("[,\"\n]").containsMatchIn(s)) "\"" + s.replace("\"", "\"\"") + "\"" else s
                    val idx = if (r != null) colIndex(r.groupValues[1]) else cells.size
                    while (cells.size <= idx) cells += null
                    cells[idx] = cell
                }
                cells.joinToString(",") { it ?: "" }
            }.toList()
            "--- 工作表：" + (names.getOrNull(si) ?: "Sheet${si + 1}") + " ---\n" + rows.joinToString("\n")
        }.joinToString("\n\n")
    }

    private const val RADICALS = "⻓长⻚页⻔门⻛风⻜飞⻝食⻢马⻥鱼⻦鸟⻰龙⻆角⻅见⻋车⻉贝⻨麦⻩黄⻬齐⻮齿⻳龟⻁虎⻄西⻘青⻙韦⻗雨⻈讠⻊足⻣骨⻤鬼⻧卤"
    /** PDF 字体常把常用汉字映射成康熙部首 / 部首补充字符，还原成常用汉字 */
    fun normalizeCjk(t: String): String {
        val sb = StringBuilder(t.length)
        for (ch in t) {
            if (ch.code in 0x2E80..0x2EFF || ch.code in 0x2F00..0x2FDF) {
                val i = RADICALS.indexOf(ch)
                if (i >= 0 && i % 2 == 0) sb.append(RADICALS[i + 1]) else sb.append(java.text.Normalizer.normalize(ch.toString(), java.text.Normalizer.Form.NFKC))
            } else sb.append(ch)
        }
        return sb.toString()
    }

    data class Capped(val text: String, val truncated: Boolean, val total: Int)
    fun capText(text: String, max: Int): Capped = if (text.length <= max) Capped(text, false, text.length) else Capped(text.substring(0, max), true, text.length)

    private fun JsonObject.s(k: String) = (this[k] as? JsonPrimitive)?.content
    private fun JsonObject.b(k: String) = (this[k] as? JsonPrimitive)?.content == "true"
    private fun JsonObject.n(k: String) = (this[k] as? JsonPrimitive)?.content?.toDoubleOrNull()?.toLong()

    /** 把文件内容拼进用户消息（逐字照 files.js buildFileContext）；files = [{name, text, truncated, total, pages}] */
    fun buildFileContext(files: List<JsonObject>, question: String, totalMax: Int = DEFAULT_TOTAL_MAX): String {
        var used = 0
        val blocks = files.filter { !it.s("text").isNullOrEmpty() }.map { f ->
            var body = f.s("text")!!; var truncated = f.b("truncated")
            val remain = totalMax - used
            if (body.length > remain) { body = body.substring(0, maxOf(0, remain)); truncated = true }
            used += body.length
            val meta = listOf(f.n("pages")?.takeIf { it > 0 }?.let { "$it 页" } ?: "", f.n("total")?.takeIf { it > 0 }?.let { "$it 字符" } ?: "")
                .filter { it.isNotEmpty() }.joinToString("，")
            val name = f.s("name") ?: ""
            "【文件：$name】" + (if (meta.isNotEmpty()) "（$meta）" else "") + "\n" + body +
                (if (truncated) "\n【注意：文件内容过长，以上仅为前 ${body.length} 个字符，后续内容已截断】" else "") + "\n【文件结束：$name】"
        }
        if (blocks.isEmpty()) return question
        return "用户上传了以下文件，请基于文件内容回答：\n\n" + blocks.joinToString("\n\n") + "\n\n" +
            (if (question.isNotEmpty()) "用户的问题：$question" else "请先概括这些文件的主要内容。")
    }

    fun formatSize(n: Long): String = when {
        n < 1024 -> "$n B"
        n < 1048576 -> String.format(Locale.ROOT, "%.1f KB", n / 1024.0)
        else -> String.format(Locale.ROOT, "%.1f MB", n / 1048576.0)
    }

    /** 抽取结果 → 旧版 user.files[] 元素形状 {name,size,kind,text,total,truncated,pages?,scanned?} */
    data class Extracted(val kind: String, val text: String, val pages: Int? = null, val scanned: Boolean = false)

    /** 同步抽取（在 IO 线程调用）。失败抛异常，消息是给用户看的中文。 */
    fun extract(bytes: ByteArray, name: String, mime: String?): Extracted {
        return when (val kind = classifyFile(name, mime)) {
            "docx" -> Extracted(kind, extractDocx(bytes))
            "pptx" -> Extracted(kind, extractPptx(bytes))
            "xlsx" -> Extracted(kind, extractXlsx(bytes))
            "pdf" -> { val r = PdfText.extract(bytes); Extracted(kind, r.text, r.pages, r.scanned) }
            "unsupported" -> throw IllegalArgumentException("暂不支持旧版 Office 格式（.doc/.ppt/.xls），请另存为 .docx/.pptx/.xlsx")
            "image" -> throw IllegalArgumentException("图片请用「从相册选择」")
            else -> {
                val (t, _) = decodeText(bytes)
                if (kind == "unknown" && looksBinary(t)) throw IllegalArgumentException("无法识别的文件类型")
                Extracted("text", t)
            }
        }
    }

    fun toFileJson(name: String, size: Long, ex: Extracted, max: Int = DEFAULT_FILE_MAX): JsonObject {
        val c = capText(ex.text, max)
        return JsonObject(buildMap {
            put("name", JsonPrimitive(name)); put("size", JsonPrimitive(size)); put("kind", JsonPrimitive(ex.kind))
            put("text", JsonPrimitive(c.text)); put("total", JsonPrimitive(c.total)); put("truncated", JsonPrimitive(c.truncated))
            ex.pages?.let { put("pages", JsonPrimitive(it)) }
            if (ex.scanned) put("scanned", JsonPrimitive(true))
        })
    }
}
