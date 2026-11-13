package com.aichat.app.ui

import com.aichat.app.data.files.FileText
import com.aichat.app.data.files.PdfText
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** 用例照搬 tests/files.test.js（fixtures 直接读仓库里的 tests/fixtures） */
class FileTextTest {
    private fun fixture(n: String) = listOf(File("../tests/fixtures/$n"), File("tests/fixtures/$n")).first { it.exists() }.readBytes()
    private fun zip(vararg e: Pair<String, String>): ByteArray {
        val bos = ByteArrayOutputStream()
        ZipOutputStream(bos).use { z -> e.forEach { (n, s) -> z.putNextEntry(ZipEntry(n)); z.write(s.toByteArray()); z.closeEntry() } }
        return bos.toByteArray()
    }
    private fun f(vararg kv: Pair<String, Any>) = JsonObject(kv.associate { (k, v) -> k to (if (v is Number) JsonPrimitive(v) else if (v is Boolean) JsonPrimitive(v) else JsonPrimitive(v.toString())) })

    @Test fun classify() {
        assertEquals("pdf", FileText.classifyFile("a.PDF", ""))
        assertEquals("docx", FileText.classifyFile("x.docx", null))
        assertEquals("unsupported", FileText.classifyFile("x.doc", null))
        assertEquals("text", FileText.classifyFile("a.kt", ""))
        assertEquals("image", FileText.classifyFile("a", "image/png"))
        assertEquals("unknown", FileText.classifyFile("LICENSE", ""))
    }

    @Test fun pdfTextTwoPages() {
        val r = PdfText.extract(fixture("sample-text.pdf"))
        assertEquals(2, r.pages); assertFalse(r.scanned)
        assertTrue(r.text, r.text.contains("--- 第 1 页 ---") && r.text.contains("--- 第 2 页 ---"))
        assertTrue(r.text, r.text.contains("2026 年第三季度销售报告"))
        assertTrue(r.text, r.text.contains("同比增长 23%"))
        assertTrue(r.text, r.text.contains("第二页：下季度计划"))
        assertTrue(r.text, r.text.contains("Key takeaway: online channel grew 57%"))
        assertFalse(Regex("[\u2E80-\u2FDF]").containsMatchIn(r.text))
    }

    @Test fun pdfPredefinedCMap() = assertEquals("你好世界，联网搜索测试", PdfText.extract(fixture("sample-unigb.pdf")).text)

    @Test fun pdfScanned() {
        val r = PdfText.extract(fixture("sample-scanned.pdf"))
        assertTrue(r.scanned); assertEquals("", r.text); assertEquals(1, r.pages)
    }

    @Test fun pdfBroken() {
        val e = assertThrows(IllegalArgumentException::class.java) { PdfText.extract("not a pdf".toByteArray()) }
        assertTrue(e.message!!.contains("无法解析 PDF"))
    }

    @Test fun office() {
        val docx = zip("[Content_Types].xml" to "<Types/>",
            "word/document.xml" to "<w:document><w:body><w:p><w:r><w:t>第一段：</w:t></w:r><w:r><w:t xml:space=\"preserve\">项目 &amp; 预算</w:t></w:r></w:p>" +
                "<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>换行</w:t></w:r></w:p></w:body></w:document>")
        assertEquals("第一段：项目 & 预算\nA\tB\n换行", FileText.extractDocx(docx))
        assertThrows(IllegalArgumentException::class.java) { FileText.extractDocx(zip("a.txt" to "x")) }
        val pt = FileText.extractPptx(zip("ppt/slides/slide2.xml" to "<p:sld><a:p><a:r><a:t>第二页标题</a:t></a:r></a:p></p:sld>",
            "ppt/slides/slide1.xml" to "<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p><a:p><a:r><a:t>副标题</a:t></a:r></a:p></p:sld>"))
        assertTrue(pt, pt.indexOf("封面") < pt.indexOf("第二页标题")); assertTrue(pt.contains("副标题"))
        val xt = FileText.extractXlsx(zip("xl/workbook.xml" to "<workbook><sheets><sheet name=\"销售\" sheetId=\"1\"/></sheets></workbook>",
            "xl/sharedStrings.xml" to "<sst><si><t>城市</t></si><si><t>营收</t></si><si><t>成都</t></si></sst>",
            "xl/worksheets/sheet1.xml" to "<worksheet><sheetData><row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>" +
                "<row r=\"2\"><c r=\"A2\" t=\"s\"><v>2</v></c><c r=\"B2\"><v>300</v></c></row></sheetData></worksheet>"))
        assertTrue(xt, xt.contains("销售") && xt.contains("城市,营收") && xt.contains("成都,300"))
    }

    @Test fun decode() {
        assertEquals("你", FileText.decodeText(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte(), 0xE4.toByte(), 0xBD.toByte(), 0xA0.toByte())).first)
        val d = FileText.decodeText(byteArrayOf(0xC4.toByte(), 0xE3.toByte(), 0xBA.toByte(), 0xC3.toByte()))
        assertEquals("gb18030" to "你好", d.second to d.first)
        assertFalse(FileText.looksBinary("普通文本\nhello")); assertTrue(FileText.looksBinary("\u0000\u0001\u0002\u0003abc"))
    }

    @Test fun fileContext() {
        val c = FileText.capText("a".repeat(100), 40)
        assertEquals(Triple(40, true, 100), Triple(c.text.length, c.truncated, c.total))
        val ctx = FileText.buildFileContext(listOf(f("name" to "报告.pdf", "text" to "营收 1280 万", "pages" to 2, "total" to 9),
            f("name" to "长文.txt", "text" to c.text, "truncated" to true, "total" to 100)), "营收多少？")
        assertTrue(ctx.contains("【文件：报告.pdf】（2 页，9 字符）\n营收 1280 万\n【文件结束：报告.pdf】"))
        assertTrue(ctx.contains("【文件：长文.txt】") && ctx.contains("后续内容已截断"))
        assertTrue(ctx.endsWith("用户的问题：营收多少？"))
        val big = FileText.buildFileContext(listOf(f("name" to "a", "text" to "x".repeat(50)), f("name" to "b", "text" to "y".repeat(50))), "", 70)
        assertTrue(big.contains("前 20 个字符")); assertTrue(big.endsWith("请先概括这些文件的主要内容。"))
        assertEquals("仅问题", FileText.buildFileContext(emptyList(), "仅问题"))
        assertEquals("1.5 KB", FileText.formatSize(1536))
    }
}
