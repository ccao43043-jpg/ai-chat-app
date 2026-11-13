package com.aichat.app.golden

import com.aichat.app.data.json.Js
import com.aichat.app.data.json.JsObj
import com.aichat.app.data.json.Undef
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.fail
import java.io.File

/**
 * JS ↔ Kotlin golden 对照框架（spec §6，D 所有；B/C 直接复用）。
 *
 * 向量：`app/src/test/resources/golden/<module>/<fn>.jsonl`，每行 `{"in":[…],"out":…}`，由 `node tests/golden-export/run.mjs` 生成。
 * 比对规则 [assertGolden]：数字相对误差 ≤ 1e-9（绝对误差 ≤ 1e-12 时也算相等）；字符串逐字相等；对象按 JSON 语义（键顺序无关，
 * `undefined` 与缺键等价）；数组按位比较。失败信息带 JSON 路径与两侧取值。
 *
 * 用法：
 * ```
 * Golden.cases("convlog", "diff").forEach { c -> Golden.assertGolden(c.out, myDiff(c.arg(0), c.arg(1)), c.label) }
 * ```
 * Kotlin → JS 方向：把 Kotlin 产物写到 [kotlinOutDir]，再用 [runNode] 调 `tests/golden-export/verify-kotlin.mjs` 让 JS 回放比对。
 */
object Golden {
    const val REL_TOL = 1e-9
    const val ABS_TOL = 1e-12

    class Case(val module: String, val fn: String, val index: Int, val input: List<Any?>, val out: Any?) {
        fun arg(i: Int): Any? = input.getOrElse(i) { Undef }
        fun obj(i: Int): JsObj? = arg(i) as? JsObj
        val label get() = "$module/$fn#$index"
    }

    /** 仓库根目录（Gradle 单测的工作目录是 app/） */
    val repoRoot: File by lazy {
        var d: File? = File("").absoluteFile
        while (d != null && !File(d, "settings.gradle").exists()) d = d.parentFile
        d ?: File("").absoluteFile
    }
    val kotlinOutDir: File get() = File(repoRoot, "app/build/golden-kotlin").also { it.mkdirs() }

    fun cases(module: String, fn: String): List<Case> {
        val res = "golden/$module/$fn.jsonl"
        val text = Golden::class.java.classLoader!!.getResourceAsStream(res)?.use { it.readBytes().toString(Charsets.UTF_8) }
            ?: error("缺少 golden 向量 $res，请运行 node tests/golden-export/run.mjs $module")
        return text.split('\n').filter { it.isNotBlank() }.mapIndexed { i, line ->
            val o = Js.parse(line) as JsObj
            @Suppress("UNCHECKED_CAST")
            Case(module, fn, i, (o["in"] as? List<Any?>) ?: emptyList(), o["out"])
        }
    }

    fun assertGolden(expected: Any?, actual: Any?, label: String) {
        val diffs = ArrayList<String>()
        compare(norm(expected), norm(actual), "$", diffs)
        if (diffs.isNotEmpty()) fail("$label 与 JS 不一致（${diffs.size} 处）：\n" + diffs.take(10).joinToString("\n"))
    }
    fun assertGolden(expected: Any?, actual: JsonElement?, label: String) = assertGolden(expected, actual?.let { Js.fromJson(it) } ?: null, label)

    fun numEq(a: Double, b: Double): Boolean {
        if (a == b) return true
        if (a.isNaN() && b.isNaN()) return true
        val d = Math.abs(a - b)
        return d <= ABS_TOL || d <= REL_TOL * maxOf(Math.abs(a), Math.abs(b))
    }

    private fun norm(v: Any?): Any? = if (v is Number && v !is Double) v.toDouble() else v

    private fun compare(e: Any?, a: Any?, path: String, out: MutableList<String>) {
        if (out.size > 50) return
        val ee = norm(e); val aa = norm(a)
        when {
            ee is Double && aa is Double -> if (!numEq(ee, aa)) out += "$path: 期望 ${Js.numToString(ee)}，实际 ${Js.numToString(aa)}"
            ee is JsObj && aa is JsObj -> {
                val keys = LinkedHashSet<String>().apply { ee.keys().forEach { if (ee[it] !== Undef) add(it) }; aa.keys().forEach { if (aa[it] !== Undef) add(it) } }
                keys.forEach { k -> compare(ee[k], aa[k], "$path.$k", out) }
            }
            ee is List<*> && aa is List<*> -> {
                if (ee.size != aa.size) out += "$path: 数组长度 期望 ${ee.size}，实际 ${aa.size}"
                for (i in 0 until minOf(ee.size, aa.size)) compare(ee[i], aa[i], "$path[$i]", out)
            }
            else -> if (!(ee == aa || (ee === Undef && aa === Undef))) out += "$path: 期望 ${show(ee)}，实际 ${show(aa)}"
        }
    }
    private fun show(v: Any?): String = (if (v === Undef) "undefined" else Js.stringify(v) ?: "undefined").let { if (it.length > 200) it.take(200) + "…" else it }

    /** 找 node；没有时返回 null（调用方用 Assume 跳过 Kotlin→JS 方向） */
    fun nodeBinary(): String? = listOf(System.getenv("NODE"), "/usr/local/bin/node", "/usr/bin/node", "node").firstOrNull { c ->
        c != null && runCatching { ProcessBuilder(c, "--version").redirectErrorStream(true).start().waitFor() == 0 }.getOrDefault(false)
    }
    /** 运行 node 脚本，返回 (退出码, 输出) */
    fun runNode(script: String, vararg args: String): Pair<Int, String> {
        val node = nodeBinary() ?: return -1 to "node 不可用"
        val p = ProcessBuilder(listOf(node, File(repoRoot, script).path) + args).directory(repoRoot).redirectErrorStream(true).start()
        val text = p.inputStream.bufferedReader().readText()
        return p.waitFor() to text
    }
}
