package com.aichat.app.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.aichat.app.AiChatApp
import com.aichat.app.data.diag.StoreDump
import com.aichat.app.data.json.Js
import com.aichat.app.data.secret.FakeKeyVault
import com.aichat.app.data.store.JsonFileStore
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * M3 模拟器覆盖安装回归（在真实迁移后的 App 进程里跑）：
 *   adb shell am instrument -w -e class com.aichat.app.data.DeviceRegressionTest com.aichat.app.test/androidx.test.runner.AndroidJUnitRunner
 * 产物写到 filesDir/regression/（run-as 拉取）：dump-before.json / dump-restored.json / dump-after-import.json / export.zip。
 * 不含任何 Key 明文。没有旧数据（全新安装）时只校验导出导入等价。
 */
@RunWith(AndroidJUnit4::class)
class DeviceRegressionTest {
    private fun canon(o: JsonElement) = Js.stringify(Js.sortKeys(Js.fromJson(o)))!!

    @Test fun migratedStoreIsCompleteAndBackupRoundTrips() = runBlocking {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as AiChatApp
        val g = app.graph.data
        val out = File(app.filesDir, "regression").apply { mkdirs() }
        val marker = File(g.store.dir, ".native-migrated")
        val t0 = System.currentTimeMillis()
        while (!marker.exists() && System.currentTimeMillis() - t0 < 30_000 && g.store.list().any { it.startsWith("conv_") }) Thread.sleep(200)
        g.reloadAll()

        val before = StoreDump.dump(g)
        File(out, "dump-before.json").writeText(StoreDump.stringify(before))
        if (marker.exists()) {
            val rep = Js.toJsonObject(Js.parse(marker.readText()))!!["report"]!!.jsonObject
            File(out, "marker.json").writeText(marker.readText())
            assertEquals("corruptFiles", JsonArray(emptyList()), rep["corruptFiles"])
            assertEquals("迁移报告的对话数 = 索引条数", g.chats.index.value.size, rep["conversations"]!!.jsonPrimitive.int)
            assertTrue("备份 zip 存在", File(rep["backupPath"]!!.jsonPrimitive.content).exists())
            assertEquals("迁移无警告：${rep["warnings"]}", 0, rep["warnings"]!!.jsonArray.size)
        }
        // 所有对话都能回放出来
        assertEquals(g.chats.index.value.size, before["convs"]!!.jsonObject.size)
        // 所有标记有 Key 的都能解密、且对登记的 baseUrl 取得到
        before["keys"]!!.jsonObject.forEach { (id, st) ->
            val o = st.jsonObject
            if (o["has"]!!.jsonPrimitive.boolean) {
                assertTrue("$id canDecrypt", o["canDecrypt"]!!.jsonPrimitive.boolean)
                o["keyForBase"]?.let { assertTrue("$id keyFor(baseUrl)", it.jsonPrimitive.boolean) }
            }
        }

        // 导出 → 导入到全新 store（FakeKeyVault）：除 Key 外仓库内容完全一致
        val zip = ByteArrayOutputStream().also { g.migration.exportBackup(it) }.toByteArray()
        File(out, "export.zip").writeBytes(zip)
        val dir = File(app.cacheDir, "restore-" + System.currentTimeMillis())
        val g2 = DataGraph(JsonFileStore(dir), FakeKeyVault(), File(app.cacheDir, "restore-bk"))
        g2.migration.importBackup(ByteArrayInputStream(zip))
        val restored = StoreDump.dump(g2, withKeys = false)
        File(out, "dump-restored.json").writeText(StoreDump.stringify(restored))
        val noKeys = JsonObject(before - "keys")
        assertEquals("导出→导入到新 store 后仓库内容一致", canon(noKeys), canon(restored))
        dir.deleteRecursively()

        // 导出 → 导回本机（整库替换，Key 不动）：仓库内容与 Key 状态都一致
        g.migration.importBackup(ByteArrayInputStream(zip))
        val after = StoreDump.dump(g)
        File(out, "dump-after-import.json").writeText(StoreDump.stringify(after))
        assertEquals("导出→导回本机后一致", canon(before), canon(after))
    }
}
