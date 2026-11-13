package com.aichat.app.data.migration

import com.aichat.app.data.DataGraph
import com.aichat.app.data.json.Js
import com.aichat.app.data.secret.FakeKeyVault
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.zip.ZipInputStream

class MigrationTest {
    private val OLD_STORE = mapOf(
        "settings.json" to """{"providers":[{"id":"p1","presetId":"deepseek","name":"DeepSeek","type":"openai","baseUrl":"https://api.deepseek.com","models":["deepseek-chat"],"apiKey":" sk-plain "},
            {"id":"p2","presetId":"openrouter","name":"OR","type":"openai","baseUrl":"https://openrouter.ai/api/v1","models":[],"hasKey":true}],"search":{"provider":"brave","keys":{"brave":"bk"}},"autoCharMode":"ask"}""",
        "settings.json.bak" to """{"providers":[]}""",
        "convs.json" to """[{"id":"c1","title":"旧","providerId":"p1","model":"m","updatedAt":2}]""",
        "conv_c1.json" to """{"id":"c1","title":"旧","providerId":"p1","model":"m","createdAt":1,"updatedAt":2,"messages":[{"id":"u","role":"user","content":"hi","createdAt":1}]}""",
        "personas.json" to "{not json",
        "personas.json.bak" to """[{"id":"p-x","emoji":"🤖","name":"x","desc":"","systemPrompt":"","providerId":"","model":"","temperature":"","builtin":false}]""",
        "usage-stats.json" to """{"version":2,"log":[{"key":"k1"}],"prices":{}}""",
        "device-id.json" to """{"dev":"dev-old"}""",
    )
    private fun graph(keys: FakeKeyVault = FakeKeyVault(), dir: File = createTempDir()) = DataGraph(com.aichat.app.data.store.MemFileStore(OLD_STORE), keys, dir, now = { 1700000000000L })
    @Suppress("DEPRECATION") private fun createTempDir(): File = kotlin.io.createTempDir("mig")

    @Test fun firstLaunchMigration() = runBlocking {
        val keys = FakeKeyVault(); val dir = createTempDir()
        val g = graph(keys, dir)
        val m = g.migration
        assertTrue(m.needed())
        val r = m.run()
        assertFalse(m.needed())
        assertEquals(1, r.conversations)
        // a) 备份 zip：store 原样（不含 Key）
        val zip = File(r.backupPath!!); assertTrue(zip.exists())
        val names = ZipInputStream(zip.inputStream()).use { z -> generateSequence { z.nextEntry?.name }.toList() }
        assertTrue(names.containsAll(listOf("settings.json", "conv_c1.json", "aichat-backup.json")))
        assertTrue("损坏文件的原件以 .corrupt-<ts> 进备份", names.any { it.startsWith("personas.json.corrupt-") })
        val zipped = ZipInputStream(zip.inputStream()).use { z -> var t = ""; while (true) { val e = z.nextEntry ?: break; if (e.name == "settings.json") t = z.readBytes().toString(Charsets.UTF_8) }; t }
        assertTrue("备份是迁移前的原文件", zipped.contains("sk-plain"))
        // b) 损坏的 personas.json → .corrupt-<ts> 留底并从 .bak 恢复
        assertTrue(r.corruptFiles.contains("personas.json"))
        assertTrue(g.store.list().any { it.startsWith("personas.json.corrupt-") })
        assertTrue(g.store.get("personas.json")!!.contains("p-x"))
        // 对话体检在副本上做：真实 store 没被写快照
        assertFalse(g.store.exists("conv_c1.snap.json"))
        // c) 明文 Key 进安全存储并从 settings 删除；autoChar 迁移；usage 转 jsonl
        val s = g.store.get("settings.json")!!
        assertFalse(s.contains("sk-plain")); assertFalse(s.contains("\"bk\""))
        assertEquals("sk-plain", keys.keyFor("p1", "https://api.deepseek.com/x"))
        assertTrue(keys.has("search:brave"))
        assertTrue(s.contains("\"autoCharMode\":\"auto\""))
        assertTrue(g.store.exists("usage-stats.jsonl")); assertTrue(g.store.exists("usage-stats.json.migrated"))
        // d) Key 体检：p1 可解密；p2 标记有 Key 却不在安全存储
        assertEquals("p1 + search:brave", 2, r.keys)
        assertTrue(r.warnings.any { it.contains("OR") && it.contains("重新填写") })
        // e) 标记文件
        val marker = Js.parse(g.store.get(".native-migrated")!!)
        assertEquals(1.0, Js.prop(Js.prop(marker, "report"), "conversations"))
        // 迁移后仓库能正常读
        g.reloadAll()
        assertEquals("hi", g.chats.load("c1")!!.messages.single().content)
    }

    @Test fun neverThrowsAndUndecryptableKeyReported() = runBlocking {
        val keys = FakeKeyVault(); keys.register("p2", "https://openrouter.ai/api/v1", com.aichat.app.domain.model.AuthType.BEARER); keys.set("p2", "x"); keys.undecryptable += "p2"
        val g = DataGraph(com.aichat.app.data.store.MemFileStore(OLD_STORE), keys, File("/proc/nonexistent-dir-for-test"), now = { 1L })
        val r = g.migration.run()   // 备份目录不可写：记警告，不抛
        assertNull(r.backupPath)
        assertTrue(r.warnings.any { it.startsWith("整库备份 失败") })
        assertTrue(r.warnings.any { it.contains("无法解密") })
    }

    @Test fun emptyStoreNeedsNoMigration() = runBlocking { assertFalse(DataGraph.inMemory().migration.needed()) }

    @Test fun backupExportImportRoundTrip() = runBlocking {
        val g = graph()
        val c = g.chats.create("p", "m")
        val out = ByteArrayOutputStream(); val n = g.migration.exportBackup(out)
        assertTrue(n >= OLD_STORE.size)
        val g2 = DataGraph.inMemory(mapOf("convs.json" to "[]", "stale.json" to "{}", "device-id.json" to """{"dev":"dev-new"}"""))
        val restored = g2.migration.importBackup(ByteArrayInputStream(out.toByteArray()))
        assertTrue(restored > 0)
        assertFalse("导入是整库替换", g2.store.exists("stale.json"))
        assertTrue(g2.store.get("device-id.json")!!.contains("dev-new"))   // 本机 device id 保留
        assertEquals(c.id, g2.chats.index.value.first().id)                  // 仓库已重读
        assertNotNull(g2.chats.load(c.id))
    }

    @Test fun importRejectsForeignZip() = runBlocking {
        val bad = ByteArrayOutputStream().also { java.util.zip.ZipOutputStream(it).use { z -> z.putNextEntry(java.util.zip.ZipEntry("../evil")); z.write(1); z.closeEntry() } }
        val g = DataGraph.inMemory(mapOf("convs.json" to "[]"))
        assertTrue(runCatching { g.migration.importBackup(ByteArrayInputStream(bad.toByteArray())) }.isFailure)
        assertTrue(g.store.exists("convs.json"))
    }
}
