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

    /** 以 JS Number→String 的方式生成数字（整数不带 .0） */
    fun number(d: Double): JsonPrimitive =
        if (d.isFinite() && d == Math.floor(d) && Math.abs(d) < 1e15) JsonPrimitive(d.toLong()) else JsonPrimitive(d)
    fun number(n: Long): JsonPrimitive = JsonPrimitive(n)

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
