package com.aichat.app.plugins.js

/** parseInt(s, 10)：跳过前导空白，可选符号，取最长十进制数字前缀；无数字 → NaN */
fun Js.parseInt(s0: String): Double {
    val s = trimStart(s0); var i = 0; var neg = false
    if (i < s.length && (s[i] == '+' || s[i] == '-')) { neg = s[i] == '-'; i++ }
    val st = i; while (i < s.length && s[i] in '0'..'9') i++
    if (i == st) return Double.NaN
    val v = java.math.BigDecimal(s.substring(st, i)).toDouble()
    return if (neg) -v else v
}
/** parseFloat(s)：跳过前导空白，取最长 StrDecimalLiteral 前缀（含 Infinity）；否则 NaN */
fun Js.parseFloat(s0: String): Double {
    val s = trimStart(s0)
    val m = Regex("^[+-]?(Infinity|(\\d+\\.?\\d*|\\.\\d+)([eE][+-]?\\d+)?)").find(s) ?: return Double.NaN
    val t = m.value
    if (t.endsWith("Infinity")) return if (t.startsWith("-")) Double.NEGATIVE_INFINITY else Double.POSITIVE_INFINITY
    return t.toDouble()
}
