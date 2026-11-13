package com.aichat.app.data.convlog

import com.aichat.app.data.json.Js
import com.aichat.app.data.json.JsObj
import com.aichat.app.data.store.MemFileStore
import com.aichat.app.data.store.StoreJs
import com.aichat.app.golden.Golden
import com.aichat.app.golden.Golden.assertGolden
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume
import org.junit.Test
import java.io.File

/** conv-log.js ↔ JsConvLog 双向 golden（spec §5 D 验收）。向量：tests/golden-export/exporters/convlog.mjs */
class ConvLogGoldenTest {
    private val FIXED_NOW = 1700000000000L
    private fun engine() = JsConvLog(now = { FIXED_NOW }, random = { 0.5 })
    private val C = JsConvLog.Companion

    private fun each(fn: String, block: (Golden.Case) -> Unit) {
        val cs = Golden.cases("convlog", fn)
        assertTrue("$fn 没有用例", cs.isNotEmpty())
        cs.forEach(block)
    }

    @Test fun extractMeta() = each("extractMeta") { assertGolden(it.out, C.extractMeta(it.arg(0)), it.label) }
    @Test fun convToOps() = each("convToOps") { assertGolden(it.out, C.convToOps(it.obj(0)!!, it.arg(1)), it.label) }
    @Test fun replay() = each("replay") {
        @Suppress("UNCHECKED_CAST") assertGolden(it.out, C.replay(it.arg(0), it.arg(1) as List<Any?>), it.label)
    }
    @Test fun toConv() = each("toConv") { assertGolden(it.out, C.toConv(it.obj(0)!!, legacy = it.arg(1) == true), it.label) }
    @Test fun takeSnapshot() = each("takeSnapshot") { assertGolden(it.out, C.takeSnapshot(it.obj(0)!!, false), it.label) }
    @Test fun stateFromSnapshot() = each("stateFromSnapshot") { assertGolden(it.out, C.stateFromSnapshot(it.arg(0)), it.label) }
    @Test fun stateToOps() = each("stateToOps") { assertGolden(it.out, C.stateToOps(it.obj(0)!!), it.label) }
    @Test fun diff() = each("diff") { assertGolden(it.out, C.diff(it.arg(0), it.arg(1)), it.label) }
    @Test fun stampCmp() = each("stampCmp") { assertGolden(it.out, C.stampCmp(it.arg(0), it.arg(1)).toDouble(), it.label) }
    /** JS(fflate) 压缩的 contentZ 必须能被 Kotlin 解开 */
    @Test fun decompressJsOutput() = each("decompressStr") { assertGolden(it.out, C.decompressStr(it.arg(0)), it.label) }
    @Test fun packUnpackRoundTrip() = each("packChapters") { assertGolden(it.out, C.unpackChapters(C.packChapters(it.arg(0))), it.label) }

    @Test fun load() = each("load") { c ->
        val fs = memStore(c.obj(0)!!)
        val e = engine(); val st = StoreJs(fs)
        val id = c.arg(1) as String
        val conv = e.load(st, id)
        val out = c.out as JsObj
        assertGolden(out["conv"], conv, c.label + ".conv")
        assertGolden(out["meta"], e.loadMeta(st, id), c.label + ".meta")
        assertGolden(out["ids"], e.listConvIds(st).sorted(), c.label + ".ids")
        assertGolden(out["legacy"], e.exportLegacy(st, id), c.label + ".legacy")
        assertFiles(out["files"] as JsObj, fs, c.label)
    }

    @Test fun commitSequence() = each("commit") { c ->
        val fs = memStore(c.obj(0)!!)
        val e = engine(); val st = StoreJs(fs)
        val id = c.arg(1) as String
        val legacy = c.arg(2) == true
        if (legacy) e.load(st, id)
        val out = c.out as JsObj
        @Suppress("UNCHECKED_CAST") val seq = c.arg(3) as List<Any?>
        @Suppress("UNCHECKED_CAST") val expected = out["results"] as List<Any?>
        seq.forEachIndexed { i, conv ->
            val r = e.commit(st, Js.clone(conv) as JsObj)
            if (expected[i] != null) assertGolden(expected[i], r, "${c.label}.results[$i]")
        }
        assertFiles(out["files"] as JsObj, fs, c.label)
        e.clearSessions()
        assertGolden(out["reload"], e.load(st, id), c.label + ".reload")
    }

    /** Kotlin 写 → JS 读：Kotlin commit 出来的 store 交给 JS ConvLog.load，结果须与 Kotlin load 语义相等 */
    @Test fun kotlinWrittenStoresReplayInJs() {
        val lines = ArrayList<String>()
        Golden.cases("convlog", "commit").forEach { c ->
            val fs = memStore(c.obj(0)!!)
            val e = engine(); val st = StoreJs(fs)
            val id = c.arg(1) as String
            if (c.arg(2) == true) e.load(st, id)
            @Suppress("UNCHECKED_CAST") (c.arg(3) as List<Any?>).forEach { conv -> e.commit(st, Js.clone(conv) as JsObj) }
            e.clearSessions()
            val expect = e.load(st, id)
            val files = JsObj(); fs.files.keys.sorted().filterNot { it.endsWith(".bak") }.forEach { files[it] = fs.files[it] }
            lines += Js.stringify(JsObj("label" to c.label, "id" to id, "files" to files, "expect" to expect))!!
        }
        val f = File(Golden.kotlinOutDir, "convlog-k2j.jsonl"); f.writeText(lines.joinToString("\n") + "\n")
        Assume.assumeTrue("node 不可用，跳过 Kotlin→JS 方向", Golden.nodeBinary() != null)
        val (code, text) = Golden.runNode("tests/golden-export/verify-kotlin.mjs", "convlog", f.path)
        assertEquals("JS 回放 Kotlin 产物失败：\n$text", 0, code)
    }

    private fun memStore(files: JsObj): MemFileStore = MemFileStore(files.keys().associateWith { files[it] as String })

    /** 文件集合比对：忽略 .bak（JS memStore 不产生）；JSON 文件按语义比较；快照里的 chapters 先 unpack（contentZ 字节因压缩器不同而异） */
    private fun assertFiles(expected: JsObj, fs: MemFileStore, label: String) {
        val names = fs.files.keys.filterNot { it.endsWith(".bak") }.sorted()
        assertEquals("$label 文件集合", expected.keys().sorted(), names)
        names.forEach { n -> assertGolden(normFile(n, expected[n] as String), normFile(n, fs.files[n]!!), "$label.files[$n]") }
    }
    private fun normFile(name: String, text: String): Any? {
        if (name.endsWith(".jsonl")) return StoreJs.parseJsonl(text)
        val v = Js.parseOrNull(text) ?: return text
        if (name.endsWith(".snap.json") && v is JsObj) v["chapters"] = C.unpackChapters(v["chapters"])
        return v
    }
}
