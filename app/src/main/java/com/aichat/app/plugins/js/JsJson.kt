package com.aichat.app.plugins.js

/** JS 抛出的普通 Error（message 与 JS 逐字一致） */
open class JsError(message: String) : RuntimeException(message)
/** JSON.parse 的 SyntaxError（V8 文案不复刻；golden 侧统一记为 "<JSON>"） */
class JsSyntaxError(message: String) : JsError(message)

/** 严格 JSON.parse（ECMA-404；重复键后者覆盖、位置保持首次出现）+ JSON.stringify(v, null, indent) */
object JsJson {
    fun parse(s: String): Any? {
        val p = P(s); p.ws(); val v = p.value(); p.ws()
        if (p.i != s.length) throw JsSyntaxError("Unexpected non-whitespace character after JSON at position ${p.i}")
        return v
    }
    private class P(val s: String) {
        var i = 0
        fun err(): Nothing = throw JsSyntaxError(if (i >= s.length) "Unexpected end of JSON input" else "Unexpected token in JSON at position $i")
        fun ws() { while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++ }
        fun value(): Any? {
            if (i >= s.length) err()
            return when (s[i]) {
                '{' -> { i++; val o = JObj(); ws()
                    if (i < s.length && s[i] == '}') { i++; return o }
                    while (true) { ws(); if (i >= s.length || s[i] != '"') err(); val k = string(); ws(); if (i >= s.length || s[i] != ':') err(); i++; ws(); o[k] = value(); ws()
                        if (i < s.length && s[i] == ',') { i++; continue }; if (i < s.length && s[i] == '}') { i++; return o }; err() } 
                    o }
                '[' -> { i++; val a: JArr = ArrayList(); ws()
                    if (i < s.length && s[i] == ']') { i++; return a }
                    while (true) { ws(); a.add(value()); ws(); if (i < s.length && s[i] == ',') { i++; continue }; if (i < s.length && s[i] == ']') { i++; return a }; err() }
                    a }
                '"' -> string()
                't' -> lit("true", true); 'f' -> lit("false", false); 'n' -> lit("null", null)
                else -> number()
            }
        }
        fun lit(w: String, v: Any?): Any? { if (!s.startsWith(w, i)) err(); i += w.length; return v }
        fun number(): Double {
            val st = i
            if (i < s.length && s[i] == '-') i++
            if (i >= s.length) err()
            if (s[i] == '0') i++ else if (s[i] in '1'..'9') { while (i < s.length && s[i].isAsciiDigit()) i++ } else err()
            if (i < s.length && s[i] == '.') { i++; if (i >= s.length || !s[i].isAsciiDigit()) err(); while (i < s.length && s[i].isAsciiDigit()) i++ }
            if (i < s.length && (s[i] == 'e' || s[i] == 'E')) { i++; if (i < s.length && (s[i] == '+' || s[i] == '-')) i++; if (i >= s.length || !s[i].isAsciiDigit()) err(); while (i < s.length && s[i].isAsciiDigit()) i++ }
            return s.substring(st, i).toDouble()
        }
        private fun Char.isAsciiDigit() = this in '0'..'9'
        fun string(): String {
            i++; val sb = StringBuilder()
            while (true) {
                if (i >= s.length) err()
                val c = s[i]
                when {
                    c == '"' -> { i++; return sb.toString() }
                    c == '\\' -> { i++; if (i >= s.length) err()
                        when (s[i]) { '"' -> sb.append('"'); '\\' -> sb.append('\\'); '/' -> sb.append('/'); 'b' -> sb.append('\b'); 'f' -> sb.append('\u000C')
                            'n' -> sb.append('\n'); 'r' -> sb.append('\r'); 't' -> sb.append('\t')
                            'u' -> { if (i + 4 >= s.length) err(); val h = s.substring(i + 1, i + 5); if ( !h.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) err(); sb.append(h.toInt(16).toChar()); i += 4 }
                            else -> err() }
                        i++ }
                    c.code < 0x20 -> err()
                    else -> { sb.append(c); i++ }
                }
            }
        }
    }

    /** JSON.stringify(v, null, indent) */
    fun stringify(v: Any?, indent: Int): String { if (indent <= 0) return Js.stringify(v); val sb = StringBuilder(); write(sb, v, " ".repeat(indent), ""); return sb.toString() }
    private fun write(sb: StringBuilder, v: Any?, gap: String, cur: String) {
        when (v) {
            is Map<*, *> -> {
                val es = Js.orderedEntries(v).filter { it.second !== Undefined }
                if (es.isEmpty()) { sb.append("{}"); return }
                val inner = cur + gap; sb.append("{\n")
                es.forEachIndexed { k, (key, x) -> if (k > 0) sb.append(",\n"); sb.append(inner); Js.quote(sb, key); sb.append(": "); write(sb, x, gap, inner) }
                sb.append('\n').append(cur).append('}')
            }
            is List<*> -> {
                if (v.isEmpty()) { sb.append("[]"); return }
                val inner = cur + gap; sb.append("[\n")
                v.forEachIndexed { k, x -> if (k > 0) sb.append(",\n"); sb.append(inner); if (x === Undefined) sb.append("null") else write(sb, x, gap, inner) }
                sb.append('\n').append(cur).append(']')
            }
            else -> sb.append(Js.stringify(v))
        }
    }
}

/** String.prototype.localeCompare（ICU 排序）：Android 上用 android.icu，JVM 单测回退 java.text.Collator */
object JsCollate {
    private val cache = HashMap<String, java.util.Comparator<Any>>()
    @Suppress("UNCHECKED_CAST")
    private fun collator(locale: String?): java.util.Comparator<Any> = synchronized(cache) {
        cache.getOrPut(locale ?: "") {
            try {
                val ul = Class.forName("android.icu.util.ULocale").getConstructor(String::class.java).newInstance(locale ?: "en_US")
                Class.forName("android.icu.text.Collator").getMethod("getInstance", ul.javaClass).invoke(null, ul) as java.util.Comparator<Any>
            } catch (_: Throwable) {
                val loc = if (locale == "zh") java.util.Locale.CHINESE else java.util.Locale.US
                val base = java.text.Collator.getInstance(loc) as java.util.Comparator<Any>
                if (locale != "zh") base else java.util.Comparator<Any> { a, b -> hanFirst(a as String, b as String) ?: base.compare(a, b) }
            }
        }
    }
    private fun isHan(c: Char) = c in '\u3400'..'\u9fff' || c in '\uf900'..'\ufaff'
    /** JVM 回退：CLDR zh 排序把汉字（Hani）重排到拉丁字母之前；首个不同字符一边是汉字、一边是字母时直接判定 */
    private fun hanFirst(a: String, b: String): Int? {
        var i = 0
        while (i < a.length && i < b.length && a[i].lowercaseChar() == b[i].lowercaseChar()) i++
        if (i >= a.length || i >= b.length) return null
        val ha = isHan(a[i]); val hb = isHan(b[i])
        if (ha && !hb && b[i].isLetter()) return -1
        if (hb && !ha && a[i].isLetter()) return 1
        return null
    }
    /** 仅供 JVM 单测：按 ICU 名次表比较（tests/golden-export 导出） */
    @Volatile var testRanks: Map<String, Map<String, Int>>? = null
    fun compare(a: String, b: String, locale: String? = null): Int {
        testRanks?.get(locale ?: "default")?.let { r -> val ra = r[a]; val rb = r[b]; if (ra != null && rb != null) return ra.compareTo(rb).coerceIn(-1, 1) }
        return compareIcu(a, b, locale)
    }
    private fun compareIcu(a: String, b: String, locale: String?): Int = collator(locale).compare(a, b).let { if (it < 0) -1 else if (it > 0) 1 else 0 }
}
