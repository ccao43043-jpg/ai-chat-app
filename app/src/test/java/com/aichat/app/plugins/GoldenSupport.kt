package com.aichat.app.plugins

import com.aichat.app.plugins.js.*
import org.junit.Assert.fail
import java.io.File
import java.util.zip.GZIPInputStream
import kotlin.math.abs
import kotlin.math.max

/**
 * C 侧 golden 对照支持（数据由 tests/golden-export/exporters/c/m2-cache.mjs 从 JS 实现导出）。
 * 比对规则（spec §6）：数字相对误差 ≤ 1e-9；字符串逐字相等；对象按 JSON 语义（键序无关；缺键 ≡ null，对应 JS 的 undefined）。
 */
object Golden {
    data class Vec(val input: List<Any?>, val out: Any?, val line: Int)
    private fun resource(path: String): File? {
        val cl = Golden::class.java.classLoader!!
        cl.getResource("golden/$path.jsonl")?.let { return File(it.toURI()) }
        cl.getResource("golden/$path.jsonl.gz")?.let { return File(it.toURI()) }
        return null
    }
    fun rawLines(path: String): List<String> {
        val f = resource(path) ?: error("缺少 golden 文件：$path（先运行 node tests/golden-export/run.mjs）")
        val text = if (f.name.endsWith(".gz")) GZIPInputStream(f.inputStream()).bufferedReader(Charsets.UTF_8).readText() else f.readText(Charsets.UTF_8)
        return text.split("\n").filter { it.isNotBlank() }
    }
    fun vectors(path: String): List<Vec> = rawLines(path).mapIndexed { i, l -> val o = Js.parse(l) as JObj; Vec(o["in"].a() ?: mutableListOf(), o["out"], i + 1) }
    fun list(dir: String): List<String> {
        val url = Golden::class.java.classLoader!!.getResource("golden/$dir") ?: return emptyList()
        return File(url.toURI()).listFiles()!!.map { it.name.removeSuffix(".gz").removeSuffix(".jsonl") }.sorted()
    }

    /** 返回 null 表示相等，否则返回首个差异的路径与说明 */
    fun diff(exp: Any?, act: Any?, path: String = "$"): String? {
        val e = norm(exp); val a = norm(act)
        if (e == null || a == null) return if (e == null && a == null) null else "$path: 期望 ${show(e)}，实际 ${show(a)}"
        if (e is Double && a is Double) {
            if (e.isNaN() && a.isNaN()) return null
            if (e == a) return null
            val tol = 1e-9 * max(abs(e), abs(a))
            return if (abs(e - a) <= tol) null else "$path: 数值 期望 $e，实际 $a"
        }
        if (e is String && a is String) return if (e == a) null else "$path: 字符串不同\n  期望 ${Js.quote(e)}\n  实际 ${Js.quote(a)}\n  首个差异位置 ${firstDiff(e, a)}"
        if (e is Boolean && a is Boolean) return if (e == a) null else "$path: 期望 $e，实际 $a"
        if (e is Map<*, *> && a is Map<*, *>) {
            for (k in (e.keys + a.keys).map { it.toString() }.toSet()) diff(e[k], a[k], "$path.$k")?.let { return it }
            return null
        }
        if (e is List<*> && a is List<*>) {
            if (e.size != a.size) return "$path: 数组长度 期望 ${e.size}，实际 ${a.size}；期望 ${show(e)}；实际 ${show(a)}"
            for (i in e.indices) diff(e[i], a[i], "$path[$i]")?.let { return it }
            return null
        }
        return "$path: 类型不同 期望 ${show(e)}，实际 ${show(a)}"
    }
    private fun firstDiff(a: String, b: String): Int { var i = 0; while (i < a.length && i < b.length && a[i] == b[i]) i++; return i }
    private fun norm(v: Any?): Any? = when (v) { Undefined -> null; is Int -> v.toDouble(); is Long -> v.toDouble(); is Float -> v.toDouble(); is Set<*> -> v.toList(); else -> v }
    private fun show(v: Any?): String = (if (v == null) "null" else Js.stringify(v)).let { if (it.length > 300) it.take(300) + "…" else it }

    /** 跑一个 golden 文件；返回通过条数（失败时汇总前 8 条差异后 fail） */
    fun run(path: String, fn: (List<Any?>) -> Any?): Int {
        val vs = vectors(path); val errs = mutableListOf<String>()
        for (v in vs) {
            val act = try { fn(v.input) } catch (e: Throwable) { errs += "$path#${v.line}: 抛出 ${e::class.simpleName}: ${e.message}"; continue }
            diff(v.out, act)?.let { errs += "$path#${v.line}: $it\n  输入 ${show(v.input)}" }
        }
        if (errs.isNotEmpty()) fail("${errs.size}/${vs.size} 条不一致：\n" + errs.take(8).joinToString("\n"))
        return vs.size
    }
}
