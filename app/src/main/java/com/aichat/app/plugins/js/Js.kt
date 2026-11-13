package com.aichat.app.plugins.js

import kotlinx.serialization.json.*
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import kotlin.math.abs
import kotlin.math.floor

/*
 * JS 语义兼容层（工作流 C）。移植 www 下的 JS 时用它保证「逐字一致」：
 *  - 值模型：null / Boolean / Double / String / MutableList<Any?> / LinkedHashMap<String, Any?>（= JS 的 null/bool/number/string/array/object）。
 *    缺键 = undefined。数字一律 Double（与 JS Number 一致）。
 *  - JSON.stringify / JSON.parse、Number→String（最短往返）、Math.round、toFixed、| 0、String.trim、\s 等与 V8 一致。
 */
typealias JObj = LinkedHashMap<String, Any?>
typealias JArr = MutableList<Any?>

fun jobj(vararg pairs: Pair<String, Any?>): JObj { val o = JObj(); for ((k, v) in pairs) o[k] = num(v); return o }
fun jarr(vararg xs: Any?): JArr = xs.map { num(it) }.toMutableList()
/** Int/Long/Float → Double，其余原样 */
fun num(v: Any?): Any? = when (v) { is Int -> v.toDouble(); is Long -> v.toDouble(); is Float -> v.toDouble(); else -> v }

object Js {
    // ───────── 类型判断 / 转换 ─────────
    fun truthy(v: Any?): Boolean = when (v) {
        null, Undefined -> false; is Boolean -> v; is Double -> !(v == 0.0 || v.isNaN()); is Number -> v.toDouble().let { !(it == 0.0 || it.isNaN()) }
        is String -> v.isNotEmpty(); else -> true
    }
    fun isStr(v: Any?) = v is String
    /** a || b */
    fun or(a: Any?, b: Any?): Any? = if (truthy(a)) a else b
    @Suppress("UNCHECKED_CAST") fun obj(v: Any?): JObj? = v as? JObj
    @Suppress("UNCHECKED_CAST") fun arr(v: Any?): JArr? = v as? MutableList<Any?>

    /** ToNumber */
    fun toNumber(v: Any?): Double = when (v) {
        null -> 0.0; is Boolean -> if (v) 1.0 else 0.0; is Double -> v; is Number -> v.toDouble()
        is String -> { val t = trim(v); if (t.isEmpty()) 0.0 else parseNumberLiteral(t) }
        is List<*> -> if (v.isEmpty()) 0.0 else if (v.size == 1) toNumber(str(v[0])) else Double.NaN
        else -> Double.NaN
    }
    /** Number(undefined) = NaN；这里 undefined 用 [UNDEF] 表示，null → 0 */
    private fun parseNumberLiteral(t: String): Double {
        if (t == "Infinity" || t == "+Infinity") return Double.POSITIVE_INFINITY
        if (t == "-Infinity") return Double.NEGATIVE_INFINITY
        if (Regex("^0[xX][0-9a-fA-F]+$").matches(t)) return t.substring(2).toBigInteger(16).toDouble()
        if (Regex("^0[oO][0-7]+$").matches(t)) return t.substring(2).toBigInteger(8).toDouble()
        if (Regex("^0[bB][01]+$").matches(t)) return t.substring(2).toBigInteger(2).toDouble()
        if (!Regex("^[+-]?(\\d+\\.?\\d*([eE][+-]?\\d+)?|\\.\\d+([eE][+-]?\\d+)?)$").matches(t)) return Double.NaN
        return t.toDouble()
    }
    /** x | 0 */
    fun i32(v: Any?): Int { val d = toNumber(v); return toInt32(d) }
    fun toInt32(d: Double): Int {
        if (d.isNaN() || d.isInfinite()) return 0
        val t = if (d < 0) -floor(-d) else floor(d)
        return BigDecimal(t).toBigInteger().toInt()   // 取低 32 位（模 2^32）
    }
    /** x >>> 0 */
    fun u32(d: Double): Long = toInt32(d).toLong() and 0xffffffffL

    /** String(v) */
    fun str(v: Any?): String = when (v) {
        null -> "null"; is String -> v; is Boolean -> v.toString(); is Double -> numToString(v); is Number -> numToString(v.toDouble())
        is List<*> -> v.joinToString(",") { if (it == null) "" else str(it) }
        is Map<*, *> -> "[object Object]"
        else -> v.toString()
    }
    /** o[k] 缺失 / undefined 时按 JS 拼接规则得到 "undefined"，null 得到 "null" */
    fun strOrEmptyUndef(o: Map<*, *>, k: String): String = if (!o.containsKey(k) || o[k] === Undefined) "undefined" else str(o[k])
    /** String(x == null ? '' : x) */
    fun strOrEmpty(v: Any?): String = if (v == null) "" else str(v)

    // ───────── Number → String（ECMAScript Number::toString，最短往返位数） ─────────
    fun numToString(d: Double): String {
        if (d.isNaN()) return "NaN"
        if (d == Double.POSITIVE_INFINITY) return "Infinity"
        if (d == Double.NEGATIVE_INFINITY) return "-Infinity"
        if (d == 0.0) return "0"
        if (d < 0) return "-" + numToString(-d)
        if (d == floor(d) && d < 9.007199254740992E15) return d.toLong().toString()
        val bd = BigDecimal(d)
        var digits = ""; var n = 0
        for (p in 1..17) {
            val r = bd.round(MathContext(p, RoundingMode.HALF_EVEN))
            if (r.toDouble() == d) {
                val u = r.unscaledValue().abs().toString().trimEnd('0').ifEmpty { "0" }
                // r = unscaled × 10^-scale；digits×10^(n-k)
                val unscaled = r.unscaledValue().abs().toString()
                n = unscaled.length - r.scale()
                digits = u; break
            }
        }
        val k = digits.length
        return when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> { val e = n - 1; val es = if (e >= 0) "+$e" else "-${-e}"
                if (k == 1) digits + "e" + es else digits[0] + "." + digits.substring(1) + "e" + es }
        }
    }

    /** Math.round */
    fun round(d: Double): Double {
        if (d.isNaN() || d.isInfinite()) return d
        val f = floor(d)
        val r = if (d - f >= 0.5) f + 1 else f
        return if (r == 0.0 && (d < 0 || (d == 0.0 && 1.0 / d < 0))) -0.0 else r
    }
    /** Number.prototype.toFixed */
    fun toFixed(d: Double, digits: Int): String {
        if (d.isNaN()) return "NaN"
        if (abs(d) >= 1e21) return numToString(d)
        val neg = d < 0
        val s = BigDecimal(abs(d)).setScale(digits, RoundingMode.HALF_UP).toPlainString()
        return if (neg) "-$s" else s
    }

    // ───────── 字符串 ─────────
    /** ECMAScript WhiteSpace + LineTerminator（String.prototype.trim / \s） */
    const val WS = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    fun isWs(c: Char): Boolean = c == '\t' || c == '\n' || c == '\u000B' || c == '\u000C' || c == '\r' || c == ' ' || c == '\u00A0' ||
        c == '\u1680' || c in '\u2000'..'\u200A' || c == '\u2028' || c == '\u2029' || c == '\u202F' || c == '\u205F' || c == '\u3000' || c == '\uFEFF'
    fun trim(s: String): String { var a = 0; var b = s.length; while (a < b && isWs(s[a])) a++; while (b > a && isWs(s[b - 1])) b--; return s.substring(a, b) }
    fun trimEnd(s: String): String { var b = s.length; while (b > 0 && isWs(s[b - 1])) b--; return s.substring(0, b) }
    fun trimStart(s: String): String { var a = 0; while (a < s.length && isWs(s[a])) a++; return s.substring(a) }
    /** String.prototype.slice */
    fun slice(s: String, start: Int, end: Int = s.length): String {
        val len = s.length
        val a = if (start < 0) maxOf(len + start, 0) else minOf(start, len)
        val b = if (end < 0) maxOf(len + end, 0) else minOf(end, len)
        return if (a >= b) "" else s.substring(a, b)
    }
    fun <T> slice(l: List<T>, start: Int, end: Int = l.size): MutableList<T> {
        val len = l.size
        val a = if (start < 0) maxOf(len + start, 0) else minOf(start, len)
        val b = if (end < 0) maxOf(len + end, 0) else minOf(end, len)
        return if (a >= b) mutableListOf() else l.subList(a, b).toMutableList()
    }
    fun padStart(s: String, n: Int, pad: Char = ' '): String = if (s.length >= n) s else pad.toString().repeat(n - s.length) + s
    /** str.indexOf(sub)；JS 对空串返回 0 */
    fun indexOf(s: String, sub: String, from: Int = 0): Int = s.indexOf(sub, from.coerceIn(0, s.length))
    fun lastIndexOf(s: String, sub: String): Int = s.lastIndexOf(sub)

    // ───────── 正则（把 JS 正则源码翻译成 java.util.regex） ─────────
    private val reCache = HashMap<String, Regex>()
    /**
     * flags：i m s（g/y 由调用方处理）。翻译：\s \S → ECMAScript 空白集合；\b \B → ASCII 单词边界；
     * 非 m 模式下的 $ → (?![\s\S])（JS 的 $ 只匹配串尾，Java 的 $ 还会匹配末尾换行之前）；[^] → [\s\S]。
     */
    fun re(src: String, flags: String = ""): Regex = synchronized(reCache) {
        reCache.getOrPut(flags + "/" + src) {
            val opts = mutableSetOf<RegexOption>()
            if ('i' in flags) opts += RegexOption.IGNORE_CASE
            if ('m' in flags) opts += RegexOption.MULTILINE
            if ('s' in flags) opts += RegexOption.DOT_MATCHES_ALL
            Regex(translate(src, 'm' in flags, 's' in flags), opts)
        }
    }
    private const val W = "A-Za-z0-9_"
    fun translate(src: String, multiline: Boolean, dotAll: Boolean = false): String {
        val sb = StringBuilder(); var i = 0; var inClass = false
        while (i < src.length) {
            val c = src[i]
            if (c == '\\' && i + 1 < src.length) {
                val n = src[i + 1]
                when (n) {
                    's' -> sb.append(if (inClass) WS else "[$WS]")
                    'S' -> sb.append("[^$WS]")
                    'd' -> sb.append(if (inClass) "0-9" else "[0-9]")
                    'D' -> sb.append("[^0-9]")
                    'w' -> sb.append(if (inClass) W else "[$W]")
                    'W' -> sb.append("[^$W]")
                    'b' -> sb.append(if (inClass) "\\x08" else "(?:(?<=[$W])(?![$W])|(?<![$W])(?=[$W]))")
                    'B' -> sb.append("(?:(?<=[$W])(?=[$W])|(?<![$W])(?![$W]))")
                    'u' -> if (i + 2 < src.length && src[i + 2] == '{') { val e = src.indexOf('}', i); sb.append("\\x{").append(src, i + 3, e).append('}'); i = e + 1; continue } else sb.append("\\u")
                    '/' -> sb.append('/')
                    '-' -> sb.append("\\-")
                    else -> sb.append(c).append(n)
                }
                i += 2; continue
            }
            if (inClass) {
                if (c == ']') inClass = false
                if (c == '[') sb.append("\\[") else if (c == '&' ) sb.append("\\&") else sb.append(c)
                i++; continue
            }
            when (c) {
                '[' -> {
                    if (src.startsWith("[^]", i)) { sb.append("[\\s\\S]"); i += 3; continue }
                    if (src.startsWith("[]", i)) { sb.append("(?!)"); i += 2; continue }
                    inClass = true; sb.append('[')
                    if (i + 1 < src.length && src[i + 1] == '^') { sb.append('^'); i++ }
                    if (i + 1 < src.length && src[i + 1] == ']') { sb.append("\\]"); i++ }
                }
                '$' -> sb.append(if (multiline) "(?=[\\n\\r\\u2028\\u2029]|(?![\\s\\S]))" else "(?![\\s\\S])")
                '^' -> sb.append(if (multiline) "(?:(?<=[\\n\\r\\u2028\\u2029])|(?<![\\s\\S]))" else "^")
                '.' -> sb.append(if (dotAll) "[\\s\\S]" else "[^\\n\\r\\u2028\\u2029]")
                else -> sb.append(c)
            }
            i++
        }
        return sb.toString()
    }
    /**
     * JS（无 u 标志）的正则按 UTF-16 码元匹配，java.util.regex 按码点匹配（代理对算 1 个字符）。
     * 输入含代理项时，把 D800–DFFF 与 E000–E7FF 两段互换（双射；本项目的正则都不涉及这两段），匹配完再换回，得到逐码元语义。
     */
    private fun hasSur(s: String): Boolean { for (c in s) if (c in '\uD800'..'\uDFFF') return true; return false }
    private fun swap(s: String): String { val a = s.toCharArray(); for (i in a.indices) { val c = a[i]; if (c in '\uD800'..'\uDFFF') a[i] = c + 0x800 else if (c in '\uE000'..'\uE7FF') a[i] = c - 0x800 }; return String(a) }
    /** re.test(s) */
    fun test(r: Regex, s: String): Boolean = r.containsMatchIn(if (hasSur(s)) swap(s) else s)
    /** s.match(/…/g) → 全部匹配（无匹配返回空列表，等价于 (m || [])） */
    fun matchAll(r: Regex, s: String): List<String> = if (hasSur(s)) r.findAll(swap(s)).map { swap(it.value) }.toList() else r.findAll(s).map { it.value }.toList()
    /** s.match(/…/)（非 g）：返回分组（0 = 整体；未参与的分组为 null） */
    fun match(r: Regex, s: String): List<String?>? { val sw = hasSur(s); return r.find(if (sw) swap(s) else s)?.let { m -> (0..m.groupValues.lastIndex).map { m.groups[it]?.value?.let { v -> if (sw) swap(v) else v } } } }
    /** s.split(re) */
    fun split(r: Regex, s: String): List<String> = if (hasSur(s)) r.split(swap(s)).map { swap(it) } else r.split(s)
    /** s.replace(re, fn) / replaceAll；fn 收到分组列表 */
    fun replace(r: Regex, s: String, global: Boolean, fn: (List<String?>) -> String): String {
        val sw = hasSur(s); val src = if (sw) swap(s) else s
        val sb = StringBuilder(); var last = 0
        for (m in r.findAll(src)) {
            sb.append(s, last, m.range.first)
            sb.append(fn((0..m.groupValues.lastIndex).map { m.groups[it]?.value?.let { v -> if (sw) swap(v) else v } }))
            last = m.range.last + 1
            if (!global) break
        }
        sb.append(s, last, s.length); return sb.toString()
    }
    /** s.replace(re, 'str with $1 $& $$') */
    fun replace(r: Regex, s: String, global: Boolean, repl: String): String = replace(r, s, global) { g -> expandRepl(repl, g) }
    private fun expandRepl(repl: String, g: List<String?>): String {
        if ('$' !in repl) return repl
        val sb = StringBuilder(); var i = 0
        while (i < repl.length) {
            val c = repl[i]
            if (c == '$' && i + 1 < repl.length) {
                val n = repl[i + 1]
                when {
                    n == '$' -> { sb.append('$'); i += 2; continue }
                    n == '&' -> { sb.append(g[0] ?: ""); i += 2; continue }
                    n.isDigit() -> {
                        val two = if (i + 2 < repl.length && repl[i + 2].isDigit()) (repl.substring(i + 1, i + 3)).toInt() else -1
                        if (two in 1 until g.size) { sb.append(g[two] ?: ""); i += 3; continue }
                        val one = n - '0'
                        if (one in 1 until g.size) { sb.append(g[one] ?: ""); i += 2; continue }
                    }
                }
            }
            sb.append(c); i++
        }
        return sb.toString()
    }
    /** s.replace('str', 'x')（只替换第一个，替换串中的 $ 模式也会展开） */
    fun replaceFirstLiteral(s: String, find: String, repl: String): String { val i = s.indexOf(find); return if (i < 0) s else s.substring(0, i) + expandRepl(repl, listOf(find)) + s.substring(i + find.length) }

    // ───────── UTF-8（TextEncoder：孤立代理项 → U+FFFD） ─────────
    fun utf8(s: String): ByteArray {
        val out = java.io.ByteArrayOutputStream(s.length * 3)
        var i = 0
        while (i < s.length) {
            var cp = s[i].code
            if (cp in 0xD800..0xDBFF && i + 1 < s.length && s[i + 1].code in 0xDC00..0xDFFF) { cp = 0x10000 + ((cp - 0xD800) shl 10) + (s[i + 1].code - 0xDC00); i++ }
            else if (cp in 0xD800..0xDFFF) cp = 0xFFFD
            when {
                cp < 0x80 -> out.write(cp)
                cp < 0x800 -> { out.write(0xC0 or (cp shr 6)); out.write(0x80 or (cp and 0x3F)) }
                cp < 0x10000 -> { out.write(0xE0 or (cp shr 12)); out.write(0x80 or ((cp shr 6) and 0x3F)); out.write(0x80 or (cp and 0x3F)) }
                else -> { out.write(0xF0 or (cp shr 18)); out.write(0x80 or ((cp shr 12) and 0x3F)); out.write(0x80 or ((cp shr 6) and 0x3F)); out.write(0x80 or (cp and 0x3F)) }
            }
            i++
        }
        return out.toByteArray()
    }
    fun sha256(s: String): String = java.security.MessageDigest.getInstance("SHA-256").digest(utf8(s)).joinToString("") { "%02x".format(it.toInt() and 0xff) }

    // ───────── JSON ─────────
    fun stringify(v: Any?): String { val sb = StringBuilder(); writeJson(sb, v); return sb.toString() }
    /** JSON.stringify(v) 对 undefined 返回 undefined；这里的调用方保证 v 非 undefined */
    private fun writeJson(sb: StringBuilder, v: Any?) {
        when (v) {
            null -> sb.append("null")
            is Boolean -> sb.append(v)
            is Double -> if (v.isNaN() || v.isInfinite()) sb.append("null") else sb.append(numToString(v))
            is Number -> writeJson(sb, v.toDouble())
            is String -> quote(sb, v)
            is Map<*, *> -> {
                sb.append('{'); var first = true
                for ((k, x) in orderedEntries(v)) {
                    if (x === Undefined) continue
                    if (!first) sb.append(','); first = false
                    quote(sb, k); sb.append(':'); writeJson(sb, x)
                }
                sb.append('}')
            }
            is List<*> -> { sb.append('['); v.forEachIndexed { i, x -> if (i > 0) sb.append(','); if (x === Undefined) sb.append("null") else writeJson(sb, x) }; sb.append(']') }
            is JsonElement -> writeJson(sb, fromJson(v))
            Undefined -> sb.append("null")
            else -> quote(sb, v.toString())
        }
    }
    /** JS 对象键序：整数索引键（0..2^32-2）按数值升序在前，其余按插入顺序 */
    fun orderedEntries(m: Map<*, *>): List<Pair<String, Any?>> {
        val ints = ArrayList<Pair<Long, Pair<String, Any?>>>(); val rest = ArrayList<Pair<String, Any?>>()
        for ((k, x) in m) { val ks = k.toString(); val n = arrayIndex(ks); if (n != null) ints += n to (ks to x) else rest += ks to x }
        if (ints.isEmpty()) return rest
        ints.sortBy { it.first }
        return ints.map { it.second } + rest
    }
    private fun arrayIndex(k: String): Long? {
        if (k.isEmpty() || k.length > 10) return null
        if (k != "0" && k[0] == '0') return null
        if (!k.all { it in '0'..'9' }) return null
        val n = k.toLong(); return if (n <= 4294967294L) n else null
    }
    fun keys(m: Map<*, *>): List<String> = orderedEntries(m).map { it.first }
    fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        for (i in s.indices) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c.code < 0x20 -> sb.append("\\u").append(padStart(Integer.toHexString(c.code), 4, '0'))
                c.isHighSurrogate() -> if (i + 1 < s.length && s[i + 1].isLowSurrogate()) sb.append(c) else sb.append("\\u").append(Integer.toHexString(c.code))
                c.isLowSurrogate() -> if (i > 0 && s[i - 1].isHighSurrogate()) sb.append(c) else sb.append("\\u").append(Integer.toHexString(c.code))
                else -> sb.append(c)
            }
        }
        sb.append('"')
    }
    fun quote(s: String): String { val sb = StringBuilder(); quote(sb, s); return sb.toString() }

    private val lenient = Json { isLenient = false }
    /** JSON.parse → JS 值模型 */
    fun parse(s: String): Any? = fromJson(lenient.parseToJsonElement(s))
    fun fromJson(e: JsonElement?): Any? = when (e) {
        null, JsonNull -> null
        is JsonObject -> { val o = JObj(); e.forEach { (k, v) -> o[k] = fromJson(v) }; o }
        is JsonArray -> e.mapTo(ArrayList()) { fromJson(it) }
        is JsonPrimitive -> when {
            e.isString -> e.content
            e.content == "true" -> true
            e.content == "false" -> false
            else -> e.content.toDouble()
        }
    }
    fun toJson(v: Any?): JsonElement = when (v) {
        null, Undefined -> JsonNull
        is Boolean -> JsonPrimitive(v)
        is Double -> if (v == floor(v) && abs(v) < 9.007199254740992E15) JsonPrimitive(v.toLong()) else JsonPrimitive(v)
        is Number -> toJson(v.toDouble())
        is String -> JsonPrimitive(v)
        is Map<*, *> -> JsonObject(LinkedHashMap<String, JsonElement>().also { m -> orderedEntries(v).forEach { (k, x) -> if (x !== Undefined) m[k] = toJson(x) } })
        is List<*> -> JsonArray(v.map { toJson(it) })
        is JsonElement -> v
        else -> JsonPrimitive(v.toString())
    }
    /** structuredClone 等价（深拷贝 JS 值） */
    fun clone(v: Any?): Any? = when (v) {
        is Map<*, *> -> { val o = JObj(); v.forEach { (k, x) -> o[k.toString()] = clone(x) }; o }
        is List<*> -> v.mapTo(ArrayList()) { clone(it) }
        else -> v
    }
    /** Object.assign({}, a, b, …)（null 跳过） */
    fun assign(vararg xs: Map<String, Any?>?): JObj { val o = JObj(); xs.forEach { if (it != null) o.putAll(it) }; return o }
}

/** 显式 undefined（键存在但值为 undefined：JSON.stringify 会跳过） */
object Undefined { override fun toString() = "undefined" }
