package com.aichat.app.net

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * 与 JS 语义对齐的小工具：trim / 真值判断 / 数字 / JSON.stringify。
 * 请求体必须与 providers.js 的 JSON.stringify 输出逐字一致（缓存前缀稳定性依赖于此），所以序列化自己写，不用 kotlinx 的 encoder。
 */
object Js {
    val json = Json { ignoreUnknownKeys = true; isLenient = false }

    private val JSON_NUM = Regex("^-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?$")
    /**
     * JSON.parse 语义：kotlinx 非 lenient 模式仍会把裸词（如 `<h1>x</h1>`、`abc`）读成非字符串字面量，
     * JS 会抛 SyntaxError；这里逐个检查非字符串字面量只能是 true / false / null / 合法数字，否则抛 IllegalArgumentException。
     */
    fun parse(text: String): JsonElement {
        val e = json.parseToJsonElement(text)
        fun check(x: JsonElement) {
            when (x) {
                is JsonObject -> x.values.forEach(::check)
                is JsonArray -> x.forEach(::check)
                is JsonPrimitive -> if (!x.isString && x !is JsonNull && x.content != "true" && x.content != "false" && !JSON_NUM.matches(x.content))
                    throw IllegalArgumentException("Unexpected token in JSON: " + x.content.take(20))
            }
        }
        check(e)
        return e
    }

    /** String.prototype.trim 的空白集合（含 BOM、全角空格、NBSP），与 Kotlin 的 isWhitespace 不完全相同 */
    fun isJsSpace(c: Char): Boolean = when (c) {
        '\t', '\n', '\u000B', '\u000C', '\r', ' ', '\u00A0', '\u1680', '\u2028', '\u2029', '\u202F', '\u205F', '\u3000', '\uFEFF' -> true
        else -> c in '\u2000'..'\u200A'
    }
    fun trim(s: String?): String {
        if (s == null) return ""
        var a = 0; var b = s.length
        while (a < b && isJsSpace(s[a])) a++
        while (b > a && isJsSpace(s[b - 1])) b--
        return s.substring(a, b)
    }
    /** trimSlash：String(u||'').trim().replace(/\/+$/, '') */
    fun trimSlash(u: String?): String = trim(u).trimEnd('/')

    /** JS 真值 */
    fun truthy(e: JsonElement?): Boolean {
        if (e == null || e is JsonNull) return false
        if (e is JsonPrimitive) {
            if (e.isString) return e.content.isNotEmpty()
            e.booleanOrNull?.let { return it }
            val d = e.doubleOrNull ?: return true
            return d != 0.0 && !d.isNaN()
        }
        return true
    }
    /** providers.js num()：typeof v === 'number' && isFinite(v) */
    fun num(e: JsonElement?): Double? {
        if (e !is JsonPrimitive || e.isString || e is JsonNull) return null
        if (e.booleanOrNull != null) return null
        val d = e.doubleOrNull ?: return null
        return if (d.isFinite()) d else null
    }
    fun isNumber(e: JsonElement?) = num(e) != null

    /** 以 JS Number→String 的方式生成数字（整数不带 .0）；NaN / ±Infinity → null（同 JSON.stringify） */
    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    fun number(d: Double): JsonPrimitive = when {
        !d.isFinite() -> JsonNull
        d == Math.floor(d) && Math.abs(d) < 1e15 -> JsonPrimitive(d.toLong())
        else -> kotlinx.serialization.json.JsonUnquotedLiteral(numberToString(d))
    }
    /** 能精确回读为 d 的最短十进制（JDK 17 的 Double.toString 并不总是最短，如 4.9E-324 vs 5e-324） */
    private fun shortest(d: Double): java.math.BigDecimal {
        val exact = java.math.BigDecimal(d)
        for (p in 1..17) {
            val r = exact.round(java.math.MathContext(p, java.math.RoundingMode.HALF_EVEN))
            if (r.toDouble() == d) return r.stripTrailingZeros()
        }
        return java.math.BigDecimal(java.lang.Double.toString(d)).stripTrailingZeros()
    }
    /** Number.prototype.toString()（ECMAScript Number::toString，基数 10）：1e21 → "1e+21"，1e-7 → "1e-7"，8e19 → "80000000000000000000" */
    fun numberToString(d: Double): String {
        if (d.isNaN()) return "NaN"
        if (d == Double.POSITIVE_INFINITY) return "Infinity"
        if (d == Double.NEGATIVE_INFINITY) return "-Infinity"
        if (d == 0.0) return "0"
        if (d < 0) return "-" + numberToString(-d)
        val bd = shortest(d)
        val digits = bd.unscaledValue().toString()
        val k = digits.length
        val n = k - bd.scale()
        return when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val e = n - 1
                (if (k == 1) digits else digits[0] + "." + digits.substring(1)) + "e" + (if (e >= 0) "+" else "-") + Math.abs(e)
            }
        }
    }
    /** JS 对象键序：数组下标形的键（"0"、"12"，< 2^32−1，无前导 0）按数值升序排最前，其余保持插入序 */
    fun jsObject(m: Map<String, JsonElement>): JsonObject {
        fun idx(k: String): Long? = if (k.isEmpty() || k.length > 10 || (k.length > 1 && k[0] == '0') || !k.all { it in '0'..'9' }) null
            else k.toLong().takeIf { it < 4294967295L }
        if (m.keys.none { idx(it) != null }) return JsonObject(m)
        val out = LinkedHashMap<String, JsonElement>()
        m.keys.mapNotNull { k -> idx(k)?.let { k to it } }.sortedBy { it.second }.forEach { (k, _) -> out[k] = m[k]!! }
        m.forEach { (k, v) -> if (idx(k) == null) out[k] = v }
        return JsonObject(out)
    }
    /** JS 的 x | 0（ToInt32） */
    fun toInt32(d: Double): Int {
        if (!d.isFinite()) return 0
        val t = if (d < 0) Math.ceil(d) else Math.floor(d)
        return java.math.BigDecimal(t).toBigInteger().toInt()
    }
    /** JS Math.round：最近整数，.5 向 +∞ */
    fun round(d: Double): Double = if (!d.isFinite() || Math.abs(d) >= 4.5e15) d else Math.floor(d + 0.5).let { f ->
        // floor(d+0.5) 在 d = 0.49999999999999994 之类处会因加法进位出错；与 JS 对齐需再核一次
        if (f - d > 0.5) f - 1 else f
    }

    // ---------------- String.prototype.localeCompare（ICU 根排序的近似，Node / WebView 一致） ----------------
    /** Node（ICU）对可打印 ASCII 的一级排序；同组只差大小写（三级） */
    private val ASCII_GROUPS = listOf(" ", "_", "-", ",", ";", ":", "!", "?", ".", "'", "\"", "(", ")", "[", "]", "{", "}", "@", "*", "/", "\\",
        "&", "#", "%", "`", "^", "+", "<", "=", ">", "|", "~", "$", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9") +
        ('a'..'z').map { "$it${it.uppercaseChar()}" }
    private val PRIMARY = IntArray(128) { -1 }.also { t ->
        "\t\n\u000B\u000C\r".forEachIndexed { i, c -> t[c.code] = i + 1 }
        ASCII_GROUPS.forEachIndexed { i, g -> g.forEach { c -> t[c.code] = 10 + i } }
    }
    private data class CE(val p: Int, val s: Int, val t: Int)
    private fun elements(str: String): List<CE> {
        val out = ArrayList<CE>()
        val nfd = java.text.Normalizer.normalize(str, java.text.Normalizer.Form.NFD)
        var i = 0
        while (i < nfd.length) {
            val cp = nfd.codePointAt(i); i += Character.charCount(cp)
            val type = Character.getType(cp)
            if (type == Character.NON_SPACING_MARK.toInt() || type == Character.ENCLOSING_MARK.toInt()) {
                if (out.isNotEmpty()) { val l = out.removeAt(out.lastIndex); out += l.copy(s = l.s * 31 + 1 + (cp and 0xffff)) }
                continue
            }
            if (cp < 128) {
                val p = PRIMARY[cp]; if (p < 0) continue                       // 控制字符：完全可忽略
                out += CE(p, 0, if (cp in 'A'.code..'Z'.code) 1 else 0)
            } else {
                val lower = Character.toLowerCase(cp)
                out += CE(1000 + lower, 0, if (lower != cp) 1 else 0)
            }
        }
        return out
    }
    private fun cmpLevel(a: List<CE>, b: List<CE>, f: (CE) -> Int): Int {
        val n = minOf(a.size, b.size)
        for (k in 0 until n) { val c = f(a[k]).compareTo(f(b[k])); if (c != 0) return c }
        return a.size.compareTo(b.size)
    }
    /** a.localeCompare(b) 的符号（-1 / 0 / 1）。ASCII 与带重音拉丁字母和 ICU 一致；其他脚本按码位近似（中文不是拼音序）。 */
    fun localeCompare(a: String, b: String): Int {
        val ea = elements(a); val eb = elements(b)
        cmpLevel(ea, eb) { it.p }.let { if (it != 0) return Integer.signum(it) }
        cmpLevel(ea, eb) { it.s }.let { if (it != 0) return Integer.signum(it) }
        cmpLevel(ea, eb) { it.t }.let { if (it != 0) return Integer.signum(it) }
        return 0
    }
    private val zhCollator: java.text.Collator by lazy { java.text.Collator.getInstance(java.util.Locale.CHINESE) }
    /**
     * 规格 D6：用户可见排序（模型 id）用 Collator(Locale.CHINESE) 对齐 localeCompare。
     * 纯拉丁（< U+0250）两侧沿用上面的 ICU 近似（已由 golden 与 Node 逐条核对，标点 / 大小写位次与 java Collator 不同）；含中文等其他文字时交给 Collator。
     */
    fun localeCompareZh(a: String, b: String): Int =
        if (a.all { it.code < 0x250 } && b.all { it.code < 0x250 }) localeCompare(a, b) else Integer.signum(zhCollator.compare(a, b))
    fun number(n: Long): JsonPrimitive = JsonPrimitive(n)

    /** x | 0（undefined / NaN → 0） */
    fun i32(e: JsonElement?): Int = toInt32(toNumber(e))

    /** Number.prototype.toFixed(digits)：按 double 的精确十进制值四舍五入（两个候选等距时取大者）；|x| ≥ 1e21 走 String(x) */
    fun toFixed(x: Double, digits: Int): String {
        if (x.isNaN()) return "NaN"
        if (Math.abs(x) >= 1e21 || x.isInfinite()) return numberToString(x)
        val neg = x < 0
        val bd = java.math.BigDecimal(Math.abs(x)).setScale(digits, java.math.RoundingMode.HALF_UP)
        val s = bd.toPlainString()
        return if (neg) "-$s" else s
    }

    /** Number(x.toPrecision(p))：按精确十进制值保留 p 位有效数字（等距取大者）后再转回 double */
    fun toPrecisionNumber(x: Double, p: Int): Double {
        if (!x.isFinite() || x == 0.0) return x
        val neg = x < 0
        val r = java.math.BigDecimal(Math.abs(x)).round(java.math.MathContext(p, java.math.RoundingMode.HALF_UP)).toDouble()
        return if (neg) -r else r
    }

    /** String(x) 用于数值：JS 的 Number→String */
    fun numStr(d: Double): String = numberToString(d)

    /** String(x)：给 JSON 值做字符串拼接时的 JS 表现（够用：string / number / bool / null） */
    fun str(e: JsonElement?): String = when {
        e == null -> "undefined"
        e is JsonNull -> "null"
        e is JsonPrimitive -> e.content
        e is JsonArray -> e.joinToString(",") { if (it is JsonNull) "" else str(it) }
        else -> "[object Object]"
    }

    /** JSON.stringify 等价输出（键序 = 插入序；字符串转义规则同 ECMAScript well-formed JSON.stringify） */
    fun stringify(e: JsonElement?): String = StringBuilder().also { write(it, e ?: JsonNull) }.toString()

    private fun write(sb: StringBuilder, e: JsonElement) {
        when (e) {
            is JsonNull -> sb.append("null")
            is JsonPrimitive -> if (e.isString) quote(sb, e.content) else sb.append(e.content)
            is JsonArray -> { sb.append('['); e.forEachIndexed { i, x -> if (i > 0) sb.append(','); write(sb, x) }; sb.append(']') }
            is JsonObject -> {
                sb.append('{'); var first = true
                for ((k, v) in e) { if (!first) sb.append(','); first = false; quote(sb, k); sb.append(':'); write(sb, v) }
                sb.append('}')
            }
        }
    }

    fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append("\\u").append(String.format("%04x", c.code))
                Character.isHighSurrogate(c) -> {
                    if (i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) { sb.append(c).append(s[i + 1]); i++ }
                    else sb.append("\\u").append(String.format("%04x", c.code))
                }
                Character.isLowSurrogate(c) -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    /** parseFloat：取最长合法数字前缀，失败 NaN */
    private val FLOAT_PREFIX = Regex("^[+-]?(Infinity|(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?)")
    fun parseFloat(s: String?): Double {
        val t = trim(s ?: return Double.NaN)
        val m = FLOAT_PREFIX.find(t) ?: return Double.NaN
        val v = m.value
        return when (v.trimStart('+', '-')) {
            "Infinity" -> if (v.startsWith("-")) Double.NEGATIVE_INFINITY else Double.POSITIVE_INFINITY
            else -> v.toDouble()
        }
    }
    /** Number(x)（宽松：数字 / 数字串 / null→0 / 其他 NaN） */
    fun toNumber(e: JsonElement?): Double = when {
        e == null -> Double.NaN
        e is JsonNull -> 0.0
        e is JsonPrimitive && e.isString -> { val t = trim(e.content); if (t.isEmpty()) 0.0 else t.toDoubleOrNull() ?: Double.NaN }
        e is JsonPrimitive -> e.booleanOrNull?.let { if (it) 1.0 else 0.0 } ?: (e.doubleOrNull ?: Double.NaN)
        else -> Double.NaN
    }
}
