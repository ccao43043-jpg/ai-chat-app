package com.aichat.app.data.files

import java.io.ByteArrayOutputStream
import java.util.zip.Inflater

/**
 * 极简 PDF 文字抽取（不引入第三方库）。覆盖：经典 xref / 对象流（ObjStm）、FlateDecode、页面树顺序、
 * 页面（含继承）资源里的字体、ToUnicode CMap（bfchar / bfrange，1 或 2 字节编码）、Tj / TJ / ' / " 文本操作符和换行启发式。
 * 不支持：加密 PDF、LZW/DCT 以外的少见压缩、Type3 字体、无 ToUnicode 的 CID 字体（会得到乱码或空文本 → 按扫描版处理）。
 * 复杂排版的精度不如 pdf.js；需要更高精度时见 spec 问题（pdfbox-android）。
 */
object PdfText {
    data class Result(val text: String, val pages: Int, val scanned: Boolean)

    private class Obj(val dict: String, val stream: ByteArray?)

    fun extract(bytes: ByteArray, maxPages: Int = 300): Result {
        val raw = String(bytes, Charsets.ISO_8859_1)
        if (!raw.startsWith("%PDF")) throw IllegalArgumentException("无法解析 PDF：文件头不是 %PDF")
        if (Regex("/Encrypt\\s+\\d+\\s+\\d+\\s+R").containsMatchIn(raw)) throw IllegalArgumentException("该 PDF 已加密，需要密码才能读取")
        val objs = parseObjects(raw, bytes)
        val pages = pageOrder(objs)
        val parts = ArrayList<String>()
        var chars = 0
        val fontCache = HashMap<Int, Font>()
        for (pid in pages.take(maxPages)) {
            val page = objs[pid] ?: continue
            val fonts = fontsFor(objs, pid, fontCache)
            val content = contentsOf(objs, page.dict)
            var t = runCatching { textOf(content, fonts) }.getOrDefault("")
            t = FileText.normalizeCjk(t).replace(Regex("[ \\t]+\n"), "\n").replace(Regex("\n{3,}"), "\n\n").trim()
            chars += t.count { !it.isWhitespace() }
            parts += t
        }
        val n = pages.size
        val text = parts.mapIndexed { i, t -> if (n > 1) "--- 第 ${i + 1} 页 ---\n$t" else t }.joinToString("\n\n")
        val scanned = chars < maxOf(10, 5 * parts.size)
        return Result(if (scanned) "" else text, n, scanned)
    }

    // ---------------- 对象 ----------------

    private fun parseObjects(raw: String, bytes: ByteArray): Map<Int, Obj> {
        val out = HashMap<Int, Obj>()
        val re = Regex("(\\d+)\\s+(\\d+)\\s+obj\\b")
        for (m in re.findAll(raw)) {
            val num = m.groupValues[1].toInt()
            val start = m.range.last + 1
            val end = raw.indexOf("endobj", start).let { if (it < 0) raw.length else it }
            val body = raw.substring(start, end)
            val si = Regex("stream\r?\n").find(body)
            if (si != null && body.lastIndexOf(">>", si.range.first) >= 0) {
                val dict = body.substring(0, si.range.first)
                val dataStart = start + si.range.last + 1
                val es = raw.indexOf("endstream", dataStart).let { if (it < 0 || it > end) end else it }
                var data = bytes.copyOfRange(dataStart, es)
                data = decode(dict, data) ?: data
                out[num] = Obj(dict, data)
            } else out[num] = Obj(body, null)
        }
        // 对象流：/Type /ObjStm /N n /First f
        for (o in out.values.toList()) {
            if (o.stream == null || !Regex("/Type\\s*/ObjStm").containsMatchIn(o.dict)) continue
            val n = intKey(o.dict, "N") ?: continue
            val first = intKey(o.dict, "First") ?: continue
            val s = String(o.stream, Charsets.ISO_8859_1)
            val head = s.substring(0, minOf(first, s.length)).trim().split(Regex("\\s+")).mapNotNull { it.toIntOrNull() }
            for (k in 0 until minOf(n, head.size / 2)) {
                val num = head[2 * k]; val off = first + head[2 * k + 1]
                val next = if (k + 1 < head.size / 2) first + head[2 * k + 3] else s.length
                if (off in 0..s.length && next in off..s.length && num !in out) out[num] = Obj(s.substring(off, next), null)
            }
        }
        return out
    }

    private fun intKey(dict: String, key: String) = Regex("/$key\\s+(\\d+)").find(dict)?.groupValues?.get(1)?.toIntOrNull()

    private fun decode(dict: String, data: ByteArray): ByteArray? {
        val filters = Regex("/Filter\\s*(\\[[^]]*]|/\\w+)").find(dict)?.groupValues?.get(1) ?: return data
        var d = data
        for (f in Regex("/(\\w+)").findAll(filters).map { it.groupValues[1] }) {
            d = when (f) {
                "FlateDecode", "Fl" -> inflate(d) ?: return null
                "ASCIIHexDecode", "AHx" -> hex(String(d, Charsets.ISO_8859_1).substringBefore('>'))
                else -> return null
            }
        }
        return d
    }

    private fun inflate(d: ByteArray): ByteArray? {
        for (nowrap in listOf(false, true)) {
            val inf = Inflater(nowrap)
            try {
                inf.setInput(d)
                val bos = ByteArrayOutputStream(d.size * 3)
                val buf = ByteArray(16384)
                while (!inf.finished()) {
                    val n = inf.inflate(buf)
                    if (n == 0) { if (inf.needsInput() || inf.needsDictionary()) break }
                    bos.write(buf, 0, n)
                }
                if (bos.size() > 0) return bos.toByteArray()
            } catch (_: Exception) { } finally { inf.end() }
        }
        return null
    }

    private fun hex(s: String): ByteArray {
        val h = s.filter { it.isLetterOrDigit() }.let { if (it.length % 2 == 1) it + "0" else it }
        return ByteArray(h.length / 2) { h.substring(2 * it, 2 * it + 2).toInt(16).toByte() }
    }

    private fun ref(s: String?): Int? = s?.let { Regex("^\\s*(\\d+)\\s+\\d+\\s+R").find(it)?.groupValues?.get(1)?.toIntOrNull() }
    private fun refKey(dict: String, key: String) = Regex("/$key\\s+(\\d+)\\s+\\d+\\s+R").find(dict)?.groupValues?.get(1)?.toIntOrNull()

    /** 取 /Key 后面的值：<<…>> 子字典（处理嵌套）或间接引用解析后的字典 */
    private fun subDict(objs: Map<Int, Obj>, dict: String, key: String): String? {
        val m = Regex("/$key\\s*(<<|\\d+\\s+\\d+\\s+R)").find(dict) ?: return null
        if (m.groupValues[1] == "<<") {
            var depth = 0; var i = m.range.last - 1
            while (i < dict.length - 1) {
                if (dict.startsWith("<<", i)) { depth++; i += 2; continue }
                if (dict.startsWith(">>", i)) { depth--; i += 2; if (depth == 0) return dict.substring(m.range.last + 1, i - 2); continue }
                i++
            }
            return dict.substring(m.range.last + 1)
        }
        return ref(m.groupValues[1])?.let { objs[it]?.dict }
    }

    private fun pageOrder(objs: Map<Int, Obj>): List<Int> {
        val isPages = Regex("/Type\\s*/Pages\\b"); val isPage = Regex("/Type\\s*/Page\\b(?!s)")
        val root = objs.entries.firstOrNull { isPages.containsMatchIn(it.value.dict) && !it.value.dict.contains("/Parent") }?.key
        val out = ArrayList<Int>(); val seen = HashSet<Int>()
        fun walk(id: Int) {
            if (!seen.add(id)) return
            val d = objs[id]?.dict ?: return
            if (isPage.containsMatchIn(d)) { out += id; return }
            val kids = Regex("/Kids\\s*\\[([^]]*)]").find(d)?.groupValues?.get(1) ?: return
            Regex("(\\d+)\\s+\\d+\\s+R").findAll(kids).forEach { walk(it.groupValues[1].toInt()) }
        }
        if (root != null) walk(root)
        if (out.isEmpty()) out += objs.entries.filter { isPage.containsMatchIn(it.value.dict) }.map { it.key }.sorted()
        return out
    }

    private fun contentsOf(objs: Map<Int, Obj>, pageDict: String): ByteArray {
        val m = Regex("/Contents\\s*(\\[[^]]*]|\\d+\\s+\\d+\\s+R)").find(pageDict) ?: return ByteArray(0)
        var ids = Regex("(\\d+)\\s+\\d+\\s+R").findAll(m.groupValues[1]).map { it.groupValues[1].toInt() }.toList()
        // /Contents 可能指向一个数组对象
        if (ids.size == 1 && objs[ids[0]]?.stream == null) objs[ids[0]]?.dict?.let { d -> ids = Regex("(\\d+)\\s+\\d+\\s+R").findAll(d).map { it.groupValues[1].toInt() }.toList() }
        val bos = ByteArrayOutputStream()
        ids.forEach { objs[it]?.stream?.let { s -> bos.write(s); bos.write('\n'.code) } }
        return bos.toByteArray()
    }

    // ---------------- 字体 / CMap ----------------

    private class Font(val map: Map<Int, String>, val codeBytes: Int, val identity: Boolean, val ucs2: Boolean = false)

    private fun fontsFor(objs: Map<Int, Obj>, pageId: Int, fontCache: HashMap<Int, Font>): Map<String, Font> {
        var d = objs[pageId]?.dict; var guard = 0
        var res: String? = null
        while (d != null && guard++ < 20) {
            res = subDict(objs, d, "Resources")
            if (res != null) break
            d = refKey(d, "Parent")?.let { objs[it]?.dict }
        }
        val fontDict = res?.let { subDict(objs, it, "Font") } ?: return emptyMap()
        val out = HashMap<String, Font>()
        Regex("/([^\\s/<>\\[\\]()]+)\\s+(\\d+)\\s+\\d+\\s+R").findAll(fontDict).forEach { m ->
            val id = m.groupValues[2].toInt()
            out[m.groupValues[1]] = fontCache.getOrPut(id) { loadFont(objs, id) }
        }
        return out
    }

    private fun loadFont(objs: Map<Int, Obj>, id: Int): Font {
        val d = objs[id]?.dict ?: return Font(emptyMap(), 1, false)
        // 预定义 Unicode CMap（UniGB-UCS2-H / UniJIS-UTF16-H …）：编码本身就是 UCS-2 / UTF-16BE
        if (Regex("/Encoding\\s*/Uni\\w*-(UCS2|UTF16)-[HV]").containsMatchIn(d)) return Font(emptyMap(), 2, true, ucs2 = true)
        val identity = d.contains("/Identity-H") || d.contains("/Identity-V") || d.contains("/Type0")
        val tu = refKey(d, "ToUnicode")?.let { objs[it]?.stream } ?: return Font(emptyMap(), if (identity) 2 else 1, identity)
        return parseCMap(String(tu, Charsets.ISO_8859_1), identity)
    }

    private fun utf16(hexStr: String): String {
        val b = hex(hexStr)
        return if (b.size >= 2) String(b, Charsets.UTF_16BE) else String(b, Charsets.ISO_8859_1)
    }

    private fun parseCMap(s: String, identity: Boolean): Font {
        val map = HashMap<Int, String>()
        var codeBytes = if (identity) 2 else 1
        Regex("begincodespacerange([\\s\\S]*?)endcodespacerange").find(s)?.let { m ->
            Regex("<([0-9A-Fa-f]+)>").find(m.groupValues[1])?.let { codeBytes = maxOf(1, it.groupValues[1].length / 2) }
        }
        Regex("beginbfchar([\\s\\S]*?)endbfchar").findAll(s).forEach { blk ->
            Regex("<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]*)>").findAll(blk.groupValues[1]).forEach { m ->
                map[m.groupValues[1].toInt(16)] = utf16(m.groupValues[2])
            }
        }
        Regex("beginbfrange([\\s\\S]*?)endbfrange").findAll(s).forEach { blk ->
            Regex("<([0-9A-Fa-f]+)>\\s*<([0-9A-Fa-f]+)>\\s*(<([0-9A-Fa-f]*)>|\\[([^]]*)])").findAll(blk.groupValues[1]).forEach { m ->
                val lo = m.groupValues[1].toInt(16); val hi = m.groupValues[2].toInt(16)
                if (hi - lo > 65535 || hi < lo) return@forEach
                if (m.groups[4] != null) {
                    val base = m.groupValues[4]
                    val b = hex(base)
                    for (c in lo..hi) {
                        val bb = b.copyOf(); var carry = c - lo; var k = bb.size - 1
                        while (carry > 0 && k >= 0) { val v = (bb[k].toInt() and 0xFF) + carry; bb[k] = (v and 0xFF).toByte(); carry = v shr 8; k-- }
                        map[c] = if (bb.size >= 2) String(bb, Charsets.UTF_16BE) else String(bb, Charsets.ISO_8859_1)
                    }
                } else {
                    val arr = Regex("<([0-9A-Fa-f]*)>").findAll(m.groupValues[5]).map { utf16(it.groupValues[1]) }.toList()
                    for ((k, c) in (lo..hi).withIndex()) arr.getOrNull(k)?.let { map[c] = it }
                }
            }
        }
        return Font(map, codeBytes, identity)
    }

    private fun decodeString(b: ByteArray, f: Font?): String {
        if (f?.ucs2 == true) return String(b, Charsets.UTF_16BE)
        if (f == null || (f.map.isEmpty() && !f.identity)) {
            if (b.size >= 2 && b[0] == 0xFE.toByte() && b[1] == 0xFF.toByte()) return String(b, 2, b.size - 2, Charsets.UTF_16BE)
            return String(b, Charsets.ISO_8859_1)
        }
        if (f.map.isEmpty()) return ""   // Identity 编码但没有 ToUnicode：无法还原
        val sb = StringBuilder()
        var i = 0
        while (i < b.size) {
            val n = minOf(f.codeBytes, b.size - i)
            var code = 0
            for (k in 0 until n) code = (code shl 8) or (b[i + k].toInt() and 0xFF)
            sb.append(f.map[code] ?: if (f.codeBytes == 1) (code.toChar().toString()) else "")
            i += n
        }
        return sb.toString()
    }

    // ---------------- 内容流 ----------------

    private sealed interface Tok {
        data class Str(val b: ByteArray) : Tok
        data class Num(val v: Double) : Tok
        data class Name(val v: String) : Tok
        data class Op(val v: String) : Tok
        data object ArrOpen : Tok
        data object ArrClose : Tok
    }

    private fun textOf(content: ByteArray, fonts: Map<String, Font>): String {
        val s = content
        val out = StringBuilder()
        val stack = ArrayList<Tok>()
        var font: Font? = null
        var lastY: Double? = null
        var i = 0
        fun newline() { if (out.isNotEmpty() && out.last() != '\n') out.append('\n') }
        fun show(b: ByteArray) { out.append(decodeString(b, font)) }
        while (i < s.size) {
            val c = (s[i].toInt() and 0xFF).toChar()
            when {
                c.isWhitespace() -> i++
                c == '%' -> { while (i < s.size && s[i] != '\n'.code.toByte() && s[i] != '\r'.code.toByte()) i++ }
                c == '(' -> {
                    val bos = ByteArrayOutputStream(); var depth = 1; i++
                    while (i < s.size && depth > 0) {
                        val ch = s[i].toInt() and 0xFF
                        if (ch == '\\'.code && i + 1 < s.size) {
                            i++
                            when (val e = s[i].toInt() and 0xFF) {
                                'n'.code -> bos.write('\n'.code); 'r'.code -> bos.write('\r'.code); 't'.code -> bos.write('\t'.code)
                                'b'.code -> bos.write(8); 'f'.code -> bos.write(12)
                                '\r'.code, '\n'.code -> { if (e == '\r'.code && i + 1 < s.size && s[i + 1] == '\n'.code.toByte()) i++ }
                                in '0'.code..'7'.code -> {
                                    var v = e - '0'.code; var k = 0
                                    while (k < 2 && i + 1 < s.size && (s[i + 1].toInt() and 0xFF) in '0'.code..'7'.code) { i++; v = v * 8 + ((s[i].toInt() and 0xFF) - '0'.code); k++ }
                                    bos.write(v and 0xFF)
                                }
                                else -> bos.write(e)
                            }
                            i++; continue
                        }
                        if (ch == '('.code) depth++ else if (ch == ')'.code) { depth--; if (depth == 0) { i++; break } }
                        bos.write(ch); i++
                    }
                    stack += Tok.Str(bos.toByteArray())
                }
                c == '<' && i + 1 < s.size && s[i + 1] == '<'.code.toByte() -> { i += 2 }   // 字典：忽略结构
                c == '>' && i + 1 < s.size && s[i + 1] == '>'.code.toByte() -> { i += 2 }
                c == '<' -> {
                    val e = indexOf(s, '>'.code.toByte(), i + 1).let { if (it < 0) s.size else it }
                    stack += Tok.Str(hex(String(s, i + 1, e - i - 1, Charsets.ISO_8859_1))); i = e + 1
                }
                c == '[' -> { stack += Tok.ArrOpen; i++ }
                c == ']' -> { stack += Tok.ArrClose; i++ }
                c == '/' -> {
                    var j = i + 1
                    while (j < s.size && !isDelim((s[j].toInt() and 0xFF).toChar())) j++
                    stack += Tok.Name(String(s, i + 1, j - i - 1, Charsets.ISO_8859_1)); i = j
                }
                c.isDigit() || c == '-' || c == '+' || c == '.' -> {
                    var j = i + 1
                    while (j < s.size && ((s[j].toInt() and 0xFF).toChar().let { it.isDigit() || it == '.' })) j++
                    stack += Tok.Num(String(s, i, j - i, Charsets.ISO_8859_1).toDoubleOrNull() ?: 0.0); i = j
                }
                else -> {
                    var j = i + 1
                    while (j < s.size && !isDelim((s[j].toInt() and 0xFF).toChar())) j++
                    val op = String(s, i, j - i, Charsets.ISO_8859_1); i = j
                    when (op) {
                        "BI" -> { // 内联图片：跳到 EI
                            val ei = findEI(s, i); i = if (ei < 0) s.size else ei + 2
                        }
                        "Tf" -> { (stack.lastOrNull { it is Tok.Name } as? Tok.Name)?.let { font = fonts[it.v] } }
                        "Tj" -> (stack.lastOrNull() as? Tok.Str)?.let { show(it.b) }
                        "'", "\"" -> { newline(); (stack.lastOrNull() as? Tok.Str)?.let { show(it.b) } }
                        "TJ" -> {
                            val open = stack.indexOfLast { it == Tok.ArrOpen }
                            if (open >= 0) for (t in stack.subList(open + 1, stack.size)) when (t) {
                                is Tok.Str -> show(t.b)
                                is Tok.Num -> if (t.v < -250 && out.isNotEmpty() && out.last() != ' ' && out.last() != '\n') out.append(' ')
                                else -> {}
                            }
                        }
                        "Td", "TD" -> {
                            val ty = (stack.getOrNull(stack.size - 1) as? Tok.Num)?.v ?: 0.0
                            if (ty != 0.0) newline()
                        }
                        "T*" -> newline()
                        "Tm" -> {
                            val y = (stack.getOrNull(stack.size - 1) as? Tok.Num)?.v
                            if (y != null && lastY != null && kotlin.math.abs(y - lastY!!) > 0.5) newline()
                            lastY = y
                        }
                        "ET" -> {}
                    }
                    stack.clear()
                }
            }
            if (stack.size > 4096) stack.subList(0, stack.size - 1024).clear()
        }
        return out.toString()
    }

    private fun isDelim(c: Char) = c.isWhitespace() || c in "()<>[]{}/%"
    private fun indexOf(s: ByteArray, b: Byte, from: Int): Int { for (k in from until s.size) if (s[k] == b) return k; return -1 }
    private fun findEI(s: ByteArray, from: Int): Int {
        var k = from
        while (k < s.size - 1) {
            if (s[k] == 'E'.code.toByte() && s[k + 1] == 'I'.code.toByte() && (k == 0 || (s[k - 1].toInt() and 0xFF).toChar().isWhitespace()) &&
                (k + 2 >= s.size || (s[k + 2].toInt() and 0xFF).toChar().isWhitespace())) return k
            k++
        }
        return -1
    }
}
