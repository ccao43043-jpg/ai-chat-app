package com.aichat.app.ui.common

// 轻量 Markdown 解析（纯 Kotlin，无 Android 依赖，可 JVM 单测）。
// 覆盖旧版 marked 在聊天里常见的子集：标题、段落、围栏代码块、列表（含任务框）、引用、分隔线、表格；
// 行内：反引号代码、双星号/双下划线粗体、单星号/单下划线斜体、双波浪线删除线、[链接](url)、裸 http(s) 链接、反斜杠转义。
//
// 流式增量：文本按「围栏外的空行」切成段，每段独立解析并按段文本缓存（MarkdownCache）。
// 流式时只有最后一段在变，前面的段命中缓存、块对象不变，Compose 跳过重组。
// 未闭合的围栏视为代码块一直延伸到末尾（closed=false），未闭合的强调符号按字面显示。

sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Paragraph(val text: String) : MdBlock
    data class Code(val lang: String, val code: String, val closed: Boolean) : MdBlock
    data class ListBlock(val items: List<MdListItem>) : MdBlock
    data class Quote(val blocks: List<MdBlock>) : MdBlock
    data class Table(val header: List<String>, val align: List<MdAlign>, val rows: List<List<String>>) : MdBlock
    data object Rule : MdBlock
}

/** indent = 嵌套层级（0 起）；number = 有序列表序号（无序为 null）；checked = 任务框（非任务项为 null） */
data class MdListItem(val indent: Int, val number: Int?, val text: String, val checked: Boolean? = null)

enum class MdAlign { Start, Center, End }

object Markdown {
    private val FENCE = Regex("^ {0,3}(`{3,}|~{3,})\\s*([^`\\s]*)?.*$")
    private val HEADING = Regex("^ {0,3}(#{1,6})(?:\\s+(.*?))?\\s*#*\\s*$")
    private val RULE = Regex("^ {0,3}([-*_])(?:\\s*\\1){2,}\\s*$")
    private val BULLET = Regex("^(\\s*)([-*+])\\s+(.*)$")
    private val ORDERED = Regex("^(\\s*)(\\d{1,9})[.)]\\s+(.*)$")
    private val TASK = Regex("^\\[([ xX])]\\s+(.*)$")
    private val TABLE_SEP = Regex("^\\s*\\|?\\s*:?-{1,}:?\\s*(\\|\\s*:?-{1,}:?\\s*)*\\|?\\s*$")

    /** 按围栏外空行切段；围栏内的空行不切。每段末尾不含分隔空行。 */
    fun segments(text: String): List<String> {
        val out = ArrayList<String>()
        val cur = StringBuilder()
        var fence: String? = null
        for (line in text.replace("\r\n", "\n").split('\n')) {
            val m = FENCE.find(line)
            if (fence == null) {
                if (m != null) fence = m.groupValues[1]
                if (fence == null && line.isBlank()) {
                    if (cur.isNotEmpty()) { out += cur.toString(); cur.setLength(0) }
                    continue
                }
            } else if (m != null && m.groupValues[1].startsWith(fence[0]) && m.groupValues[1].length >= fence.length &&
                line.trim().all { it == fence!![0] }) {
                fence = null
            }
            if (cur.isNotEmpty()) cur.append('\n')
            cur.append(line)
        }
        if (cur.isNotEmpty()) out += cur.toString()
        return out
    }

    fun parse(text: String): List<MdBlock> = segments(text).flatMap { parseSegment(it) }

    /** 解析一段（不含围栏外空行）。 */
    fun parseSegment(seg: String): List<MdBlock> {
        val lines = seg.split('\n')
        val out = ArrayList<MdBlock>()
        val para = ArrayList<String>()
        fun flushPara() { if (para.isNotEmpty()) { out += MdBlock.Paragraph(para.joinToString("\n")); para.clear() } }
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val fm = FENCE.find(line)
            if (fm != null) {
                flushPara()
                val marker = fm.groupValues[1]
                val lang = fm.groupValues.getOrNull(2).orEmpty()
                val body = ArrayList<String>()
                var j = i + 1; var closed = false
                while (j < lines.size) {
                    val t = lines[j].trim()
                    if (t.length >= marker.length && t.all { it == marker[0] }) { closed = true; break }
                    body += lines[j]; j++
                }
                out += MdBlock.Code(lang, body.joinToString("\n"), closed)
                i = if (closed) j + 1 else j
                continue
            }
            val hm = HEADING.find(line)
            if (hm != null) { flushPara(); out += MdBlock.Heading(hm.groupValues[1].length, hm.groupValues[2]); i++; continue }
            if (RULE.matches(line) && !(para.isNotEmpty() && line.trim().all { it == '-' })) { flushPara(); out += MdBlock.Rule; i++; continue }
            if (para.isNotEmpty() && line.trim().let { it.length >= 2 && (it.all { c -> c == '=' } || it.all { c -> c == '-' }) }) {
                // Setext 标题
                val t = para.joinToString(" "); para.clear()
                out += MdBlock.Heading(if (line.trim()[0] == '=') 1 else 2, t); i++; continue
            }
            if (line.trimStart().startsWith(">")) {
                flushPara()
                val q = ArrayList<String>()
                while (i < lines.size && lines[i].trimStart().startsWith(">")) {
                    q += lines[i].trimStart().removePrefix(">").removePrefix(" "); i++
                }
                out += MdBlock.Quote(parse(q.joinToString("\n")))
                continue
            }
            if (BULLET.matches(line) || ORDERED.matches(line)) {
                flushPara()
                val items = ArrayList<MdListItem>()
                while (i < lines.size) {
                    val l = lines[i]
                    val b = BULLET.find(l); val o = if (b == null) ORDERED.find(l) else null
                    if (b != null || o != null) {
                        val g = (b ?: o)!!.groupValues
                        val indent = g[1].replace("\t", "    ").length / 2
                        var text = g[3]; var checked: Boolean? = null
                        TASK.find(text)?.let { checked = it.groupValues[1] != " "; text = it.groupValues[2] }
                        items += MdListItem(indent.coerceAtMost(6), o?.groupValues?.get(2)?.toIntOrNull(), text, checked)
                        i++
                    } else if (items.isNotEmpty() && (l.startsWith("  ") || l.startsWith("\t")) && FENCE.find(l) == null) {
                        val last = items.removeAt(items.size - 1)
                        items += last.copy(text = last.text + "\n" + l.trim()); i++
                    } else break
                }
                out += MdBlock.ListBlock(items)
                continue
            }
            if (line.contains('|') && i + 1 < lines.size && TABLE_SEP.matches(lines[i + 1]) && lines[i + 1].contains('-')) {
                val header = splitRow(line)
                val seps = splitRow(lines[i + 1])
                if (header.size == seps.size || seps.size >= 1) {
                    flushPara()
                    val align = seps.map { s -> val t = s.trim(); when {
                        t.startsWith(":") && t.endsWith(":") -> MdAlign.Center
                        t.endsWith(":") -> MdAlign.End
                        else -> MdAlign.Start } }
                    val rows = ArrayList<List<String>>()
                    var j = i + 2
                    while (j < lines.size && lines[j].contains('|')) { rows += splitRow(lines[j]); j++ }
                    out += MdBlock.Table(header, List(header.size) { align.getOrElse(it) { MdAlign.Start } }, rows)
                    i = j; continue
                }
            }
            para += line
            i++
        }
        flushPara()
        return out
    }

    private fun splitRow(line: String): List<String> {
        var t = line.trim()
        if (t.startsWith("|")) t = t.substring(1)
        if (t.endsWith("|") && !t.endsWith("\\|")) t = t.dropLast(1)
        val cells = ArrayList<String>(); val cur = StringBuilder(); var k = 0
        while (k < t.length) {
            val c = t[k]
            if (c == '\\' && k + 1 < t.length && t[k + 1] == '|') { cur.append('|'); k += 2; continue }
            if (c == '|') { cells += cur.toString().trim(); cur.setLength(0) } else cur.append(c)
            k++
        }
        cells += cur.toString().trim()
        return cells
    }

    // ---------------- 行内 ----------------

    /** 解析行内标记为若干 run；相邻同样式 run 已合并。 */
    fun inline(text: String): List<InlineRun> {
        val out = ArrayList<InlineRun>()
        parseInline(text, InlineStyle(), out)
        return merge(out)
    }

    private fun merge(runs: List<InlineRun>): List<InlineRun> {
        val out = ArrayList<InlineRun>()
        for (r in runs) {
            if (r.text.isEmpty()) continue
            val last = out.lastOrNull()
            if (last != null && last.style == r.style) out[out.size - 1] = last.copy(text = last.text + r.text) else out += r
        }
        return out
    }

    private val AUTOLINK = Regex("^https?://[^\\s<>()\\[\\]]*[^\\s<>()\\[\\].,;:!?'\"。，；：！？）」』]")

    private fun parseInline(s: String, st: InlineStyle, out: MutableList<InlineRun>) {
        val buf = StringBuilder()
        fun flush() { if (buf.isNotEmpty()) { out += InlineRun(buf.toString(), st); buf.setLength(0) } }
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '\\' && i + 1 < s.length && s[i + 1] in ESCAPABLE) { buf.append(s[i + 1]); i += 2; continue }
            if (c == '`') {
                var n = 1; while (i + n < s.length && s[i + n] == '`') n++
                val ticks = "`".repeat(n)
                val end = s.indexOf(ticks, i + n)
                if (end > 0) {
                    flush()
                    var code = s.substring(i + n, end)
                    if (code.length >= 2 && code.startsWith(" ") && code.endsWith(" ") && code.isNotBlank()) code = code.substring(1, code.length - 1)
                    out += InlineRun(code, st.copy(code = true))
                    i = end + n; continue
                }
                buf.append(ticks); i += n; continue
            }
            if (c == '[' ) {
                val close = findClosingBracket(s, i)
                if (close > 0 && close + 1 < s.length && s[close + 1] == '(') {
                    val pe = s.indexOf(')', close + 2)
                    if (pe > 0) {
                        flush()
                        val url = s.substring(close + 2, pe).trim().substringBefore(' ').removeSurrounding("<", ">")
                        parseInline(s.substring(i + 1, close), st.copy(link = url), out)
                        i = pe + 1; continue
                    }
                }
            }
            if ((c == 'h') && st.link == null && (i == 0 || !s[i - 1].isLetterOrDigit())) {
                val m = AUTOLINK.find(s.substring(i))
                if (m != null) { flush(); out += InlineRun(m.value, st.copy(link = m.value)); i += m.value.length; continue }
            }
            if (c == '~' && s.startsWith("~~", i)) {
                val end = s.indexOf("~~", i + 2)
                if (end > i + 2) { flush(); parseInline(s.substring(i + 2, end), st.copy(strike = true), out); i = end + 2; continue }
            }
            if (c == '*' || c == '_') {
                val dbl = i + 1 < s.length && s[i + 1] == c
                val mk = if (dbl) "$c$c" else "$c"
                val leftOk = i + mk.length < s.length && !s[i + mk.length].isWhitespace() &&
                    (c == '*' || i == 0 || !s[i - 1].isLetterOrDigit())
                if (leftOk) {
                    val end = findCloser(s, i + mk.length, mk, c)
                    if (end > 0) {
                        flush()
                        val inner = s.substring(i + mk.length, end)
                        parseInline(inner, if (dbl) st.copy(bold = true) else st.copy(italic = true), out)
                        i = end + mk.length; continue
                    }
                }
                buf.append(mk); i += mk.length; continue
            }
            buf.append(c); i++
        }
        flush()
    }

    private fun findClosingBracket(s: String, open: Int): Int {
        var depth = 0; var k = open
        while (k < s.length) {
            when (s[k]) { '\\' -> k++; '[' -> depth++; ']' -> { depth--; if (depth == 0) return k } }
            k++
        }
        return -1
    }

    private fun findCloser(s: String, from: Int, mk: String, c: Char): Int {
        var k = from
        while (k <= s.length - mk.length) {
            if (s[k] == '\\') { k += 2; continue }
            if (s[k] == '`') { val e = s.indexOf('`', k + 1); if (e > 0) { k = e + 1; continue } }
            if (s.startsWith(mk, k) && k > from && !s[k - 1].isWhitespace()) {
                val after = k + mk.length
                val single = mk.length == 1
                // 单个 * 不能被 ** 的一半截走；_ 右侧不能紧跟字母数字
                if (single && after < s.length && s[after] == c) { k += 2; continue }
                if (c == '_' && after < s.length && s[after].isLetterOrDigit()) { k++; continue }
                return k
            }
            k++
        }
        return -1
    }

    private const val ESCAPABLE = "\\`*_{}[]()#+-.!|~>"
}

data class InlineStyle(val bold: Boolean = false, val italic: Boolean = false, val strike: Boolean = false,
                       val code: Boolean = false, val link: String? = null)
data class InlineRun(val text: String, val style: InlineStyle)

/** 按段缓存解析结果：流式时前面的段文本不变 → 返回同一批块对象。 */
class MarkdownCache(private val capacity: Int = 512) {
    private val map = object : LinkedHashMap<String, List<MdBlock>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, List<MdBlock>>?) = size > capacity
    }
    @Synchronized
    fun parse(text: String): List<MdBlock> = Markdown.segments(text).flatMap { seg -> map.getOrPut(seg) { Markdown.parseSegment(seg) } }
}
