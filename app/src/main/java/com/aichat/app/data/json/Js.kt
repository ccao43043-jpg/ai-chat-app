package com.aichat.app.data.json

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.booleanOrNull
import java.math.BigDecimal

/*
 * JS 语义一致的可变 JSON 值模型（D 所有）。用于逐行移植 conv-log.js 等「靠 JSON.stringify 判等 / 依赖键顺序」的旧逻辑。
 *
 * 值域：null（JSON null）| [Undef]（JS undefined，只出现在读取不存在的键时）| Boolean | Double | String | [JsObj] | MutableList<Any?>
 *  - JsObj 的键顺序与 JS 对象一致：数组下标形式的键（"0".."4294967294"）按数值升序排在前，其余按插入顺序；
 *    给已存在的键赋值保持原位置；删除后再加入到末尾；JSON.parse 的重复键保留首次位置、取最后的值。
 *  - 数字一律为 Double；[stringify] 按 ECMAScript Number::toString 输出（1 → "1"，1e21 → "1e+21"，0.000001 → "0.000001"）。
 *  - [stringify] 与 JSON.stringify 逐字一致（转义规则、缩进 2 格格式、undefined 属性省略、数组里 undefined→null、NaN→null）。
 */
object Undef { override fun toString() = "undefined" }

class JsObj() {
    private val map = LinkedHashMap<String, Any?>()

    constructor(vararg pairs: Pair<String, Any?>) : this() { pairs.forEach { (k, v) -> set(k, v) } }

    operator fun get(k: String): Any? = if (map.containsKey(k)) map[k] else Undef
    /** 赋值 undefined 等价于删除（stringify / clone 后两者不可区分，见文件头说明） */
    operator fun set(k: String, v: Any?) { if (v === Undef) map.remove(k) else map[k] = normNum(v) }
    fun has(k: String) = map.containsKey(k)
    fun remove(k: String) { map.remove(k) }
    val size get() = map.size
    fun isEmpty() = map.isEmpty()

    /** Object.keys 顺序 */
    fun keys(): List<String> {
        var idx: MutableList<String>? = null
        val rest = ArrayList<String>(map.size)
        for (k in map.keys) if (isArrayIndex(k)) { (idx ?: ArrayList<String>().also { idx = it }).add(k) } else rest.add(k)
        val i = idx ?: return rest
        i.sortBy { it.toLong() }
        return i + rest
    }
    fun entries(): List<Pair<String, Any?>> = keys().map { it to map[it] }

    override fun toString() = Js.stringify(this) ?: "undefined"

    companion object {
        fun isArrayIndex(k: String): Boolean {
            if (k.isEmpty() || k.length > 10) return false
            if (k.length > 1 && k[0] == '0') return false
            for (c in k) if (c !in '0'..'9') return false
            return k.toLong() <= 4294967294L
        }
        internal fun normNum(v: Any?): Any? = when (v) {
            is Int -> v.toDouble(); is Long -> v.toDouble(); is Float -> v.toDouble(); is Short -> v.toDouble(); is Byte -> v.toDouble()
            else -> v
        }
    }
}

fun jsArr(vararg items: Any?): MutableList<Any?> = items.mapTo(ArrayList()) { JsObj.normNum(it) }

object Js {
    // ---------------- 类型与转换（ECMAScript 抽象操作的子集） ----------------
    fun isObj(v: Any?) = v is JsObj
    fun isArr(v: Any?) = v is MutableList<*>
    @Suppress("UNCHECKED_CAST") fun arr(v: Any?): MutableList<Any?> = v as MutableList<Any?>
    fun obj(v: Any?): JsObj = v as JsObj

    fun truthy(v: Any?): Boolean = when (v) {
        null, Undef -> false
        is Boolean -> v
        is Double -> !(v == 0.0 || v.isNaN())
        is Number -> v.toDouble().let { !(it == 0.0 || it.isNaN()) }
        is String -> v.isNotEmpty()
        else -> true
    }
    /** a || b */
    fun or(a: Any?, b: Any?): Any? = if (truthy(a)) a else b
    /** x == null（宽松：null 或 undefined） */
    fun nullish(v: Any?) = v == null || v === Undef

    /** 属性读取：非对象一律 undefined（JS 读字符串/数字的属性对本仓库无意义） */
    fun prop(v: Any?, k: String): Any? = if (v is JsObj) v[k] else Undef
    /** a && a.k 链：任何一级为假返回 undefined */
    fun path(v: Any?, vararg ks: String): Any? {
        var cur = v
        for (k in ks) { if (!truthy(cur)) return Undef; cur = prop(cur, k) }
        return cur
    }

    fun toNumber(v: Any?): Double = when (v) {
        null -> 0.0
        Undef -> Double.NaN
        is Boolean -> if (v) 1.0 else 0.0
        is Double -> v
        is Number -> v.toDouble()
        is String -> strToNumber(v)
        is MutableList<*> -> if (v.isEmpty()) 0.0 else if (v.size == 1) toNumber(toStr(v[0])) else Double.NaN
        else -> Double.NaN
    }
    private fun strToNumber(s0: String): Double {
        val s = s0.trim()
        if (s.isEmpty()) return 0.0
        if (s == "Infinity" || s == "+Infinity") return Double.POSITIVE_INFINITY
        if (s == "-Infinity") return Double.NEGATIVE_INFINITY
        if (s.startsWith("0x") || s.startsWith("0X")) return s.substring(2).toLongOrNull(16)?.toDouble() ?: Double.NaN
        if (!Regex("[+-]?(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?").matches(s)) return Double.NaN
        return s.toDoubleOrNull() ?: Double.NaN
    }
    /** x | 0（ToInt32） */
    fun int32(v: Any?): Int {
        val d = toNumber(v)
        if (d.isNaN() || d.isInfinite()) return 0
        val t = if (d < 0) Math.ceil(d) else Math.floor(d)
        val m = BigDecimal(t).toBigInteger().toLong() // |t| 很大时也正确取模
        return m.toInt()
    }
    /** String(x) */
    fun toStr(v: Any?): String = when (v) {
        null -> "null"
        Undef -> "undefined"
        is Boolean -> v.toString()
        is Double -> numToString(v)
        is Number -> numToString(v.toDouble())
        is String -> v
        is JsObj -> "[object Object]"
        is MutableList<*> -> v.joinToString(",") { if (it == null || it === Undef) "" else toStr(it) }
        else -> v.toString()
    }
    /** ===（对象按引用） */
    fun strictEq(a: Any?, b: Any?): Boolean = when {
        a is Double && b is Double -> a == b && !a.isNaN()
        a is String && b is String -> a == b
        a is Boolean && b is Boolean -> a == b
        a == null && b == null -> true
        a === Undef && b === Undef -> true
        else -> a === b
    }
    /** SameValueZero 的可哈希键（Set / includes 用） */
    fun svzKey(v: Any?): Any = when (v) {
        null -> "\u0000null"; Undef -> "\u0000undef"
        is Double -> if (v.isNaN()) "\u0000NaN" else if (v == 0.0) 0.0 else v
        is String -> "s:$v"; is Boolean -> v
        else -> IdentityKey(v)
    }
    private class IdentityKey(val v: Any) { override fun equals(other: Any?) = other is IdentityKey && other.v === v; override fun hashCode() = System.identityHashCode(v) }
    fun includes(list: List<Any?>, v: Any?): Boolean { val k = svzKey(v); return list.any { svzKey(it) == k } }

    // ---------------- Number::toString ----------------
    /** 能还原 d 的最短十进制（同长度取最近）= ECMAScript Number::toString 的数字串；JDK17 的 Double.toString 不总是最短（如 4.9E-324） */
    private fun shortest(d: Double): BigDecimal {
        val exact = BigDecimal(d)
        for (p in 1..17) {
            val r = exact.round(java.math.MathContext(p, java.math.RoundingMode.HALF_EVEN))
            if (r.toDouble() == d) return r.stripTrailingZeros()
        }
        return BigDecimal(java.lang.Double.toString(d)).stripTrailingZeros()
    }

    fun numToString(d: Double): String {
        if (d.isNaN()) return "NaN"
        if (d == 0.0) return "0"
        if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
        if (d < 0) return "-" + numToString(-d)
        if (d < 9.007199254740992E15 && d == Math.floor(d)) return d.toLong().toString()
        val bd = shortest(d)
        val digits = bd.unscaledValue().toString()
        val k = digits.length
        val n = k - bd.scale()           // value = 0.digits × 10^n
        return when {
            n in k..21 -> digits + "0".repeat(n - k)
            n in 1..21 -> digits.substring(0, n) + "." + digits.substring(n)
            n in -5..0 -> "0." + "0".repeat(-n) + digits
            else -> {
                val e = n - 1
                val es = if (e >= 0) "+$e" else "-${-e}"
                if (k == 1) digits + "e" + es else digits[0] + "." + digits.substring(1) + "e" + es
            }
        }
    }

    // ---------------- JSON.stringify ----------------
    fun stringify(v: Any?, indent: Int = 0): String? {
        val sb = StringBuilder()
        return if (write(sb, v, if (indent > 0) " ".repeat(indent) else "", "")) sb.toString() else null
    }
    private fun write(sb: StringBuilder, v: Any?, gap: String, cur: String): Boolean {
        when (v) {
            Undef -> return false
            null -> sb.append("null")
            is Boolean -> sb.append(if (v) "true" else "false")
            is Double -> sb.append(if (v.isNaN() || v.isInfinite()) "null" else numToString(v))
            is Number -> { val d = v.toDouble(); sb.append(if (d.isNaN() || d.isInfinite()) "null" else numToString(d)) }
            is String -> quote(sb, v)
            is JsObj -> {
                val ks = v.keys()
                val inner = cur + gap
                var first = true
                sb.append('{')
                for (k in ks) {
                    val x = v[k]
                    if (x === Undef) continue
                    if (!first) sb.append(',')
                    if (gap.isNotEmpty()) sb.append('\n').append(inner)
                    quote(sb, k); sb.append(':'); if (gap.isNotEmpty()) sb.append(' ')
                    write(sb, x, gap, inner)
                    first = false
                }
                if (!first && gap.isNotEmpty()) sb.append('\n').append(cur)
                sb.append('}')
            }
            is List<*> -> {
                val inner = cur + gap
                sb.append('[')
                v.forEachIndexed { i, x ->
                    if (i > 0) sb.append(',')
                    if (gap.isNotEmpty()) sb.append('\n').append(inner)
                    if (!write(sb, x, gap, inner)) sb.append("null")
                }
                if (v.isNotEmpty() && gap.isNotEmpty()) sb.append('\n').append(cur)
                sb.append(']')
            }
            else -> return false
        }
        return true
    }
    private val HEX = "0123456789abcdef"
    fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000c' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> u(sb, c)
                Character.isHighSurrogate(c) -> {
                    if (i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) { sb.append(c).append(s[i + 1]); i++ } else u(sb, c)
                }
                Character.isLowSurrogate(c) -> u(sb, c)
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }
    private fun u(sb: StringBuilder, c: Char) {
        val x = c.code
        sb.append("\\u").append(HEX[(x shr 12) and 15]).append(HEX[(x shr 8) and 15]).append(HEX[(x shr 4) and 15]).append(HEX[x and 15])
    }

    // ---------------- JSON.parse（严格，与 V8 接受的语法一致） ----------------
    class ParseError(msg: String) : RuntimeException(msg)
    fun parse(text: String): Any? {
        val p = Parser(text)
        p.ws(); val v = p.value(); p.ws()
        if (p.i != text.length) throw ParseError("Unexpected token at ${p.i}")
        return v
    }
    fun parseOrNull(text: String?): Any? = if (text == null) null else try { parse(text) } catch (e: ParseError) { null }

    private class Parser(val s: String) {
        var i = 0
        fun ws() { while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++ }
        fun err(): Nothing = throw ParseError("Unexpected token at $i")
        fun value(): Any? {
            if (i >= s.length) err()
            return when (s[i]) {
                '{' -> objectV()
                '[' -> arrayV()
                '"' -> str()
                't' -> lit("true", true)
                'f' -> lit("false", false)
                'n' -> lit("null", null)
                else -> num()
            }
        }
        fun objectV(): JsObj {
            i++; val o = JsObj(); ws()
            if (peek('}')) { i++; return o }
            while (true) {
                ws(); if (!peek('"')) err()
                val k = str(); ws(); expect(':'); ws(); o[k] = value(); ws()
                if (peek(',')) { i++; continue }
                expect('}'); return o
            }
        }
        fun arrayV(): MutableList<Any?> {
            i++; val a = ArrayList<Any?>(); ws()
            if (peek(']')) { i++; return a }
            while (true) {
                ws(); a.add(value()); ws()
                if (peek(',')) { i++; continue }
                expect(']'); return a
            }
        }
        fun peek(c: Char) = i < s.length && s[i] == c
        fun expect(c: Char) { if (!peek(c)) err(); i++ }
        fun lit(w: String, v: Any?): Any? { if (!s.startsWith(w, i)) err(); i += w.length; return v }
        fun num(): Double {
            val st = i
            if (peek('-')) i++
            if (peek('0')) i++ else { if (i >= s.length || s[i] !in '1'..'9') err(); while (i < s.length && s[i] in '0'..'9') i++ }
            if (peek('.')) { i++; val d = i; while (i < s.length && s[i] in '0'..'9') i++; if (i == d) err() }
            if (peek('e') || peek('E')) { i++; if (peek('+') || peek('-')) i++; val d = i; while (i < s.length && s[i] in '0'..'9') i++; if (i == d) err() }
            return s.substring(st, i).toDouble()
        }
        fun str(): String {
            i++
            val sb = StringBuilder()
            while (true) {
                if (i >= s.length) err()
                val c = s[i++]
                when {
                    c == '"' -> return sb.toString()
                    c == '\\' -> {
                        if (i >= s.length) err()
                        when (val e = s[i++]) {
                            '"' -> sb.append('"'); '\\' -> sb.append('\\'); '/' -> sb.append('/')
                            'b' -> sb.append('\b'); 'f' -> sb.append('\u000c'); 'n' -> sb.append('\n'); 'r' -> sb.append('\r'); 't' -> sb.append('\t')
                            'u' -> { if (i + 4 > s.length) err(); val h = s.substring(i, i + 4); if (!h.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) err(); sb.append(h.toInt(16).toChar()); i += 4 }
                            else -> { if (e == '\u0000') err(); err() }
                        }
                    }
                    c < ' ' -> err()
                    else -> sb.append(c)
                }
            }
        }
    }

    // ---------------- clone = JSON.parse(JSON.stringify(v))（v == null 时原样返回） ----------------
    fun clone(v: Any?): Any? = if (v == null || v === Undef) v else cloneIn(v)
    private fun cloneIn(v: Any?): Any? = when (v) {
        is JsObj -> { val o = JsObj(); for ((k, x) in v.entries()) { if (x === Undef || !serializable(x)) continue; o[k] = cloneIn(x) }; o }
        is List<*> -> v.mapTo(ArrayList()) { if (it === Undef || !serializable(it)) null else cloneIn(it) }
        is Double -> if (v.isNaN() || v.isInfinite()) null else if (v == 0.0) 0.0 else v
        is Number -> cloneIn(v.toDouble())
        else -> v
    }
    private fun serializable(v: Any?) = v == null || v is Boolean || v is Number || v is String || v is JsObj || v is List<*>
    fun cloneObj(v: Any?): JsObj? = clone(v) as? JsObj

    /** Object.assign(target, ...sources)：按源对象 Object.keys 顺序逐个赋值（浅拷贝） */
    fun assign(target: JsObj, vararg sources: Any?): JsObj {
        for (s in sources) if (s is JsObj) for ((k, v) in s.entries()) target[k] = v
        return target
    }

    /** equal(a,b) = a === b || JSON.stringify(a) === JSON.stringify(b)（键顺序敏感，与 conv-log.js 一致） */
    fun equal(a: Any?, b: Any?): Boolean {
        if (strictEq(a, b)) return true
        return stringify(a) == stringify(b)
    }
    /** 键顺序无关的 JSON 语义相等（golden 比对 / 无损往返校验用） */
    fun semanticEqual(a: Any?, b: Any?): Boolean = canonical(a) == canonical(b)
    fun canonical(v: Any?): String? = stringify(sortKeys(v))
    fun sortKeys(v: Any?): Any? = when (v) {
        is JsObj -> { val o = JsObj(); v.keys().sorted().forEach { k -> o[k] = sortKeys(v[k]) }; o }
        is List<*> -> v.mapTo(ArrayList()) { sortKeys(it) }
        else -> v
    }

    // ---------------- 与 kotlinx.serialization JsonElement 互转 ----------------
    fun fromJson(e: JsonElement?): Any? = when (e) {
        null -> Undef
        JsonNull -> null
        is JsonObject -> { val o = JsObj(); e.forEach { (k, v) -> o[k] = fromJson(v) }; o }
        is JsonArray -> e.mapTo(ArrayList()) { fromJson(it) }
        is JsonPrimitive -> when {
            e.isString -> e.content
            e.booleanOrNull != null -> e.booleanOrNull
            else -> e.content.toDoubleOrNull() ?: e.content
        }
    }
    @OptIn(ExperimentalSerializationApi::class)
    fun toJson(v: Any?): JsonElement = when (v) {
        null, Undef -> JsonNull
        is Boolean -> JsonPrimitive(v)
        is Double -> if (v.isNaN() || v.isInfinite()) JsonNull else JsonUnquotedLiteral(numToString(v))
        is Number -> toJson(v.toDouble())
        is String -> JsonPrimitive(v)
        is JsObj -> JsonObject(LinkedHashMap<String, JsonElement>().also { m -> v.entries().forEach { (k, x) -> if (x !== Undef) m[k] = toJson(x) } })
        is List<*> -> JsonArray(v.map { toJson(it) })
        else -> JsonNull
    }
    fun toJsonObject(v: Any?): JsonObject? = toJson(v) as? JsonObject
    fun parseJson(text: String): JsonElement = toJson(parse(text))
}
