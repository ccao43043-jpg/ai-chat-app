package com.aichat.app.data

import com.aichat.app.data.diag.StoreDump
import com.aichat.app.data.json.Js
import com.aichat.app.data.secret.FakeKeyVault
import com.aichat.app.data.store.JsonFileStore
import com.aichat.app.golden.Golden
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Assume
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files

/**
 * M3 回归：模拟器上用真实 UI 生成的旧数据（v0.24 原始 / 升级到 v0.28.7 后，Key 不在 store 里，夹具无任何 Key）。
 * 原生迁移 → 仓库 dump → 与 JS 参考实现（conv-log.js / personas.js / templates.js）读同一份 store 的结果逐项比对；
 * 并校验导出→导入后仓库内容不变。
 */
class StoreRegressionTest {
    private fun fixture(name: String): File {
        val src = File(javaClass.classLoader!!.getResource("regression/$name")!!.toURI())
        val dir = Files.createTempDirectory("reg-$name").toFile()
        src.copyRecursively(dir); return dir
    }
    private val KEYED = listOf("deepseek", "openrouter", "anthropic", "mwfa572sicuf3v", "search:tavily")
    private fun canon(o: JsonElement) = Js.stringify(Js.sortKeys(Js.fromJson(o)))!!

    private fun check(name: String, convs: Int) = runBlocking {
        val pristine = fixture(name)
        val dir = fixture(name)
        // 未带 Key（例如换机只拷了文件）：每个标记 hasKey 的服务商 / 搜索源各一条警告（含搜索 Key，M3 修正）
        val bare = fixture(name)
        val w = DataGraph(JsonFileStore(bare), FakeKeyVault(), Files.createTempDirectory("bk").toFile()).migration.run().warnings
        assertEquals(w.toString(), 5, w.size); assertTrue(w.any { "tavily" in it })
        // 正常覆盖安装：SecretStore 里有 Key（假占位，不是真实 Key）
        val vault = FakeKeyVault().apply { KEYED.forEach { set(it, "placeholder-not-a-key") } }
        val g = DataGraph(JsonFileStore(dir), vault, Files.createTempDirectory("bk").toFile())
        val r = g.migration.run()
        assertEquals(5, r.keys)
        assertTrue("corrupt ${r.corruptFiles}", r.corruptFiles.isEmpty())
        assertEquals("warnings ${r.warnings}", 0, r.warnings.size)
        assertEquals(convs, r.conversations)
        assertTrue(File(dir, ".native-migrated").exists())
        assertTrue(File(r.backupPath!!).exists())

        val g2 = DataGraph(JsonFileStore(dir), vault, Files.createTempDirectory("bk").toFile())
        val withKeys = StoreDump.dump(g2)
        KEYED.forEach { id -> assertEquals("$id", "true", (withKeys["keys"] as JsonObject)[id].toString().let { if ("\"canDecrypt\":true" in it) "true" else it }) }
        val dump = JsonObject(withKeys - "keys")
        assertEquals(convs, (dump["convs"] as JsonObject).size)
        val df = File(Golden.kotlinOutDir, "store-dump-$name.json").apply { parentFile.mkdirs(); writeText(StoreDump.stringify(dump)) }

        // 备份：导出 → 导入到新 store，内容一致
        val zip = ByteArrayOutputStream().also { g2.migration.exportBackup(it) }.toByteArray()
        val g3 = DataGraph(JsonFileStore(Files.createTempDirectory("restore").toFile()), FakeKeyVault(), Files.createTempDirectory("bk").toFile())
        g3.migration.importBackup(ByteArrayInputStream(zip))
        assertEquals("$name 导出→导入", canon(dump), canon(StoreDump.dump(g3, withKeys = false)))

        Assume.assumeTrue("node 不可用", Golden.nodeBinary() != null)
        // JS 读原生迁移/重写后的 store（验证 Kotlin 写出的 snap/log 对 JS 可读）与读原始 store 都应得到同样的仓库内容
        for (d in listOf(dir, pristine)) {
            val (code, out) = Golden.runNode("tests/golden-export/verify-store.mjs", d.path, df.path)
            assertEquals("$name JS 对照（${d.name}）：\n$out", 0, code)
        }
    }

    @Test fun v024StoreMigratesAndMatchesJs() = check("v024", 4)
    @Test fun v0287StoreMigratesAndMatchesJs() = check("v0287", 7)
}
