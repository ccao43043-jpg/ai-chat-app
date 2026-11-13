package com.aichat.app.ui

import com.aichat.app.ui.common.CodeHighlighter
import com.aichat.app.ui.common.InlineStyle
import com.aichat.app.ui.common.Markdown
import com.aichat.app.ui.common.MarkdownCache
import com.aichat.app.ui.common.MdAlign
import com.aichat.app.ui.common.MdBlock
import com.aichat.app.ui.common.TokKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
    @Test fun blocks() {
        val b = Markdown.parse("# 标题\n\n第一段\n续行\n\n- a\n- [x] b\n  1. c\n\n> 引用\n\n---\n\n| A | B |\n|:-:|--:|\n| 1 | 2 |")
        assertEquals(MdBlock.Heading(1, "标题"), b[0])
        assertEquals(MdBlock.Paragraph("第一段\n续行"), b[1])
        val list = b[2] as MdBlock.ListBlock
        assertEquals(3, list.items.size)
        assertEquals(true, list.items[1].checked); assertEquals("b", list.items[1].text)
        assertEquals(1, list.items[2].indent); assertEquals(1, list.items[2].number)
        assertEquals(MdBlock.Quote(listOf(MdBlock.Paragraph("引用"))), b[3])
        assertEquals(MdBlock.Rule, b[4])
        val t = b[5] as MdBlock.Table
        assertEquals(listOf("A", "B"), t.header); assertEquals(listOf(MdAlign.Center, MdAlign.End), t.align); assertEquals(listOf(listOf("1", "2")), t.rows)
    }

    @Test fun fencedCodeKeepsBlankLinesAndMarkup() {
        val b = Markdown.parse("前\n```kotlin\nval a = 1\n\n// **不是粗体**\n```\n后")
        assertEquals(3, b.size)
        assertEquals(MdBlock.Code("kotlin", "val a = 1\n\n// **不是粗体**", true), b[1])
        assertEquals(MdBlock.Paragraph("后"), b[2])
    }

    @Test fun unclosedFenceDuringStreaming() {
        val b = Markdown.parse("看代码：\n\n```py\nprint(1)\n\nx = 2")
        assertEquals(MdBlock.Code("py", "print(1)\n\nx = 2", false), b.last())
    }

    @Test fun inlineStyles() {
        val r = Markdown.inline("普通 **粗** *斜* `c*o*de` ~~删~~ [链接](https://a.b/c) 和 https://x.y/z。 snake_case_name 2*3*4")
        fun styleOf(t: String) = r.first { it.text == t }.style
        assertEquals(InlineStyle(bold = true), styleOf("粗"))
        assertEquals(InlineStyle(italic = true), styleOf("斜"))
        assertEquals(InlineStyle(code = true), styleOf("c*o*de"))
        assertEquals(InlineStyle(strike = true), styleOf("删"))
        assertEquals("https://a.b/c", styleOf("链接").link)
        assertEquals("https://x.y/z", styleOf("https://x.y/z").link)
        assertTrue(r.any { it.text.contains("snake_case_name") && it.style == InlineStyle() })
    }

    @Test fun unclosedEmphasisIsLiteral() {
        assertEquals("这是 **未闭合", Markdown.inline("这是 **未闭合").joinToString("") { it.text })
        assertEquals("a \\* b", Markdown.inline("a \\\\* b").joinToString("") { it.text })
    }

    @Test fun nestedBoldItalic() {
        val r = Markdown.inline("**粗 *斜粗* 粗**")
        assertEquals(InlineStyle(bold = true, italic = true), r.first { it.text == "斜粗" }.style)
    }

    @Test fun streamingCacheMatchesFullParseAndReusesBlocks() {
        val text = "# T\n\n段落 **粗**\n\n```js\nconst a = 1;\n\nlet b = `x`;\n```\n\n- a\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n结尾"
        val cache = MarkdownCache()
        for (i in 0..text.length) assertEquals("prefix $i", Markdown.parse(text.substring(0, i)), cache.parse(text.substring(0, i)))
        val a = cache.parse("第一段\n\n第二段")
        val b = cache.parse("第一段\n\n第二段继续")
        assertSame(a[0], b[0])
    }

    @Test fun setextAndRuleVsHeading() {
        assertEquals(MdBlock.Heading(2, "副标题"), Markdown.parse("副标题\n---").single())
        assertEquals(MdBlock.Rule, Markdown.parse("***").single())
    }

    @Test fun highlighter() {
        val code = "fun a() { // hi\n  val s = \"x\"; return 42 }"
        val toks = CodeHighlighter.tokenize(code, "kotlin")
        fun kindOf(t: String) = toks.first { code.substring(it.start, it.end) == t }.kind
        assertEquals(TokKind.Keyword, kindOf("fun"))
        assertEquals(TokKind.Comment, kindOf("// hi"))
        assertEquals(TokKind.Str, kindOf("\"x\""))
        assertEquals(TokKind.Number, kindOf("42"))
        val py = CodeHighlighter.tokenize("def f():  # c\n    return None", "python")
        assertTrue(py.any { it.kind == TokKind.Comment })
        assertFalse(CodeHighlighter.tokenize("{\"a\": true}", "json").any { it.kind == TokKind.Comment })
    }
}
