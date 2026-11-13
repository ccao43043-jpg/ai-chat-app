package com.aichat.app.plugins

import com.aichat.app.plugins.js.*
import com.aichat.app.plugins.knowledge.Knowledge
import com.aichat.app.plugins.knowledge.RetrievalCore
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Test

/** M3 golden（tests/golden-export/c-m3-domain.mjs）：retrieval-core / knowledge / affect / charcard / worlds / autochar */
class DomainGoldenTest {
    companion object {
        const val NOW = 1763000000000.0
        @BeforeClass @JvmStatic fun fix() {
            Knowledge.clock = { NOW }
            Knowledge.uid = { java.lang.Long.toString(NOW.toLong(), 36) + "i" }
            JsCollate.testRanks = listOf("zh", "default").associateWith { k ->
                val txt = DomainGoldenTest::class.java.classLoader!!.getResource("collate/$k.json")?.readText() ?: "{}"
                (Js.parse(txt) as JObj).mapValues { it.value.d().toInt() }
            }
        }
        @Suppress("UNCHECKED_CAST") fun L(v: Any?): List<Any?> = (v as? List<Any?>) ?: emptyList()
        @Suppress("UNCHECKED_CAST") fun O(v: Any?): List<JObj> = L(v).map { it as JObj }
        fun nInt(v: Any?): Int? = v?.let { Js.toNumber(it).toInt() }
        fun nD(v: Any?): Double? = v?.let { Js.toNumber(it) }
        /** 与导出端 safe() 一致：抛错 → {throws: message} */
        fun safe(f: () -> Any?): Any? = try { f() } catch (e: JsSyntaxError) { jobj("throws" to "<JSON>") } catch (e: JsError) { jobj("throws" to e.message) }
    }

    private fun suite(dir: String, table: Map<String, (List<Any?>) -> Any?>) {
        val files = Golden.list(dir)
        assertEquals("$dir：golden 文件与 Kotlin 对照表不一致", files.toSet(), table.keys)
        var n = 0
        for (f in files) n += Golden.run("$dir/$f", table[f]!!)
        println("[golden] $dir：${files.size} 个函数，$n 条向量全部一致")
    }

    @Test fun retrieval() = suite("retrieval", mapOf(
        "grams" to { a -> RetrievalCore.grams(a[0], nInt(a[1])) },
        "jaccard3" to { a -> RetrievalCore.jaccard3(a[0], a[1]) },
        "bm25f" to { a ->
            val docs = O(a[0]); val fields = a[1]?.let { L(it).map { x -> x as String } }
            val w = a[2]?.let { (it as JObj).mapValues { e -> e.value.d() } }
            val idx = RetrievalCore.buildIndex(docs, fields)
            val scores = docs.map { RetrievalCore.bm25f(idx, a[3], it, w) }
            val scores2 = docs.map { RetrievalCore.bm25f(idx, RetrievalCore.addQuery(RetrievalCore.buildQuery(a[3], 2.0), a[6], 0.3), it, w, nD(a[4]), nD(a[5])) }
            jobj("scores" to scores, "scores2" to scores2, "N" to idx.n, "avgLen" to JObj(idx.avgLen), "df" to JObj(idx.df.mapValues { it.value.toDouble() }))
        },
        "mmr" to { a -> RetrievalCore.mmr(O(a[0]), nD(a[1]), null, nInt(a[2])).map { it["id"] } },
        "pickByBudget" to { a -> RetrievalCore.pickByBudget(O(a[0]), null, a[1]) },
    ))

    @Test fun knowledge() = suite("knowledge", mapOf(
        "normalizeDoc" to { a -> Knowledge.normalizeDoc(a[0], a[1]) },
        "exportJSON" to { a -> Knowledge.exportJSON(a[0], a[1]) },
        "exportNdjson" to { a -> Knowledge.exportNdjson(a[0]) },
        "exportMarkdown" to { a -> Knowledge.exportMarkdown(a[0]) },
        "listEntries" to { a -> Knowledge.listEntries(a[0], a[1]) },
        "normalizeKeywords" to { a -> Knowledge.normalizeKeywords(a[0]) },
        "tokenize" to { a -> Knowledge.tokenize(a[0]) },
        "search" to { a -> Knowledge.resetIndexCache(); Knowledge.search(a[0], a[1], a[2]) },
        "selectForInject" to { a -> Knowledge.resetIndexCache(); Knowledge.selectForInject(a[0], a[1], a[2]) },
        "renderInjection" to { a -> Knowledge.renderInjection(a[0]?.let { L(it) }) },
        "spliceIntoUserContent" to { a -> Knowledge.spliceIntoUserContent(a[0], a[1]) },
        "detectImportFormat" to { a -> Knowledge.detectImportFormat(a[0]) },
        "parseImport" to { a -> safe { Knowledge.parseImport(a[0], a[1]) } },
        "mergeDoc" to { a -> safe { Knowledge.mergeDoc(a[0], a[1], a[2]) } },
        "crud" to { a ->
            val d = a[1] as JObj; val g = L(a[2]); val now = a[3]
            safe {
                when (a[0]) {
                    "addCategory" -> Knowledge.addCategory(d, g[0], now)
                    "updateCategory" -> Knowledge.updateCategory(d, g[0], g[1], now)
                    "removeCategory" -> Knowledge.removeCategory(d, g[0], now)
                    "reorderCategories" -> Knowledge.reorderCategories(d, L(g[0]), now)
                    "addEntry" -> Knowledge.addEntry(d, g[0], g[1], now)
                    "updateEntry" -> Knowledge.updateEntry(d, g[0], g[1], g[2], now)
                    "removeEntry" -> Knowledge.removeEntry(d, g[0], g[1], now)
                    "setPinned" -> Knowledge.setPinned(d, g[0], g[1], g[2], now)
                    else -> error("未知 op")
                }
            }
        },
    ))
}
