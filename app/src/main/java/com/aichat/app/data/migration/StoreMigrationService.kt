package com.aichat.app.data.migration

import com.aichat.app.data.backup.BackupService
import com.aichat.app.data.convlog.JsConvLog
import com.aichat.app.data.json.Js
import com.aichat.app.data.json.JsObj
import com.aichat.app.data.repo.FileUsageRepository
import com.aichat.app.data.repo.SettingsMigrations
import com.aichat.app.data.codec.SettingsCodec
import com.aichat.app.data.secret.KeyVaultAdmin
import com.aichat.app.data.store.FileStore
import com.aichat.app.data.store.MemFileStore
import com.aichat.app.data.store.StoreJs
import com.aichat.app.domain.MigrationReport
import com.aichat.app.domain.MigrationService
import com.aichat.app.domain.model.AuthType
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.io.InputStream
import java.io.OutputStream

/**
 * 首次启动迁移（spec §2.1）。原地沿用 store/，不搬家。顺序：
 *  a) 整库 zip 备份到 backupDir/pre-native-<ts>.zip（不含 Key）
 *  b) 只读体检：每个 .json/.jsonl 解析一遍（损坏的按旧规则改名 .corrupt-<ts> 并用 .bak 恢复）；每个对话在**内存副本**上
 *     跑 ConvLog.load（真实 store 不因体检而被改写）
 *  c) settings.json：明文 apiKey 移入 KeyVault（Secure.stripSecrets）、v0.8.4 autoChar、[providerMigration]（B 的
 *     Providers.migrateSettings 移植，未接线时跳过并记警告）；usage-stats.json → jsonl
 *  d) Key 体检：每个 hasKey 的服务商试解密一次，失败的记「需要重新填写」
 *  e) 写 .native-migrated {fromVersionCode, at, report}
 * 任何异常都不抛出（不阻塞启动），记进 report.warnings；原文件不动。
 */
class StoreMigrationService(
    private val fs: FileStore,
    private val keys: KeyVaultAdmin,
    private val backupDir: File,
    private val uriIo: UriIo? = null,
    private val providerMigration: ((JsonObject) -> JsonObject?)? = null,
    private val fromVersionCode: () -> Int = { 0 },
    private val now: () -> Long = System::currentTimeMillis,
    /** 导入完成后让各仓库重读磁盘（DataGraph 设置） */
    var afterImport: () -> Unit = {},
) : MigrationService {
    companion object {
        const val MARKER = ".native-migrated"
        private val IGNORE = Regex("(\\.tmp|\\.bak|\\.migrated|\\.corrupt-\\d+)$")
    }
    /** SAF 适配（Android 侧用 ContentResolver 实现；JVM 测试传 null 并直接用流接口） */
    interface UriIo { fun openOut(uri: android.net.Uri): OutputStream?; fun openIn(uri: android.net.Uri): InputStream? }

    private val store = StoreJs.of(fs)
    private val backup = BackupService(fs, now)
    @Volatile var lastReport: MigrationReport? = null; private set

    override suspend fun needed(): Boolean = withContext(Dispatchers.IO) {
        !fs.exists(MARKER) && fs.list().any { !IGNORE.containsMatchIn(it) && it != MARKER }
    }

    override suspend fun run(): MigrationReport = withContext(Dispatchers.IO) { runBlockingSafe() }

    fun runBlockingSafe(): MigrationReport {
        val warnings = ArrayList<String>(); val corrupt = ArrayList<String>()
        var backupPath: String? = null; var convs = 0; var keyCount = 0
        fun step(name: String, f: () -> Unit) = try { f() } catch (e: Throwable) { warnings += "$name 失败：${e.javaClass.simpleName}: ${e.message}" }

        step("整库备份") { val f = File(backupDir, "pre-native-${now()}.zip"); backup.exportZip(f); backupPath = f.path }
        step("文件体检") {
            // 不清空 issues：仓库在 DataGraph 构造时已先读过一遍，那时发现的损坏也要进报告（原文件留底为 .corrupt-<ts>，同样进了备份 zip）
            fs.list().filter { !IGNORE.containsMatchIn(it) && it != MARKER }.sorted().forEach { n ->
                if (n.endsWith(".jsonl")) { val raw = fs.get(n) ?: return@forEach
                    val bad = raw.split('\n').count { l -> l.isNotBlank() && Js.parseOrNull(l.trim()) == null && l.trim() != "null" }
                    if (bad > 0) warnings += "$n 有 $bad 行无法解析（读取时跳过，与旧版相同）" }
                else if (n.endsWith(".json")) store.get(n, null)
            }
            store.issues.toList().distinctBy { it.first }.forEach { (name, restored, c) -> corrupt += name; warnings += "$name 已损坏，留底为 $c" + (if (restored == "bak") "，已从 .bak 恢复" else "，没有可用的 .bak") }
        }
        step("对话体检") {
            val copy = MemFileStore(fs.list().filter { it.startsWith("conv_") || it == JsConvLog.DEVICE_FILE }.associateWith { fs.get(it) ?: "" })
            val engine = JsConvLog(now)
            val cs = StoreJs(copy)
            engine.listConvIds(cs).forEach { id ->
                try { if (engine.load(cs, id) != null) convs++ else warnings += "对话 $id 无法读取" }
                catch (e: Throwable) { warnings += "对话 $id 回放失败：${e.message}" }
            }
        }
        step("设置迁移") { migrateSettings(warnings) }
        step("用量迁移") { if (FileUsageRepository(fs).migrateLegacy()) warnings += "usage-stats.json 已转为 usage-stats.jsonl（原文件改名 .migrated）" }
        step("Key 体检") {
            val s = (store.get("settings.json", null) as? JsObj)?.let { Js.toJsonObject(it) }?.let(SettingsCodec::decode)
            s?.providers?.forEach { p ->
                if (!keys.has(p.id)) { if (p.hasKey) warnings += "服务商「${p.name}」标记有 Key 但安全存储里没有，需要重新填写"; return@forEach }
                if (keys.canDecrypt(p.id)) keyCount++ else warnings += "服务商「${p.name}」的 Key 无法解密，需要重新填写"
            }
        }
        val report = MigrationReport(fromVersionCode(), convs, keyCount, corrupt, backupPath, warnings)
        lastReport = report
        try {
            store.set(MARKER, JsObj("fromVersionCode" to report.fromVersionCode.toDouble(), "at" to now().toDouble(), "report" to JsObj(
                "conversations" to convs.toDouble(), "keys" to keyCount.toDouble(), "corruptFiles" to corrupt.toMutableList<Any?>(),
                "backupPath" to backupPath, "warnings" to warnings.toMutableList<Any?>())))
        } catch (e: Throwable) { /* 不阻塞启动；下次启动会再试 */ }
        return report
    }

    /** Secure.stripSecrets + v0.8.4 autoChar + Providers.migrateSettings（可选）。只在有改动时写回 settings.json */
    private fun migrateSettings(warnings: MutableList<String>) {
        val raw = store.get("settings.json", null) as? JsObj ?: return
        var changed = false
        // stripSecrets：旧版明文 provider.apiKey / search.keys → 安全存储
        (raw["providers"] as? List<*>)?.forEach { p ->
            if (p !is JsObj || !p.has("apiKey")) return@forEach
            val v = (if (Js.nullish(p["apiKey"])) "" else Js.toStr(p["apiKey"])).trim()
            val id = Js.toStr(p["id"])
            if (v.isNotEmpty()) {
                val auth = when (Js.toStr(p["type"])) { "anthropic" -> AuthType.ANTHROPIC; "gemini" -> AuthType.GEMINI; else -> AuthType.BEARER }
                keys.register(id, Js.toStr(Js.or(p["baseUrl"], "")), auth)
                if (keys.set(id, v)) p["hasKey"] = true else warnings += "服务商 $id 的明文 Key 写入安全存储失败"
            }
            p.remove("apiKey"); changed = true
        }
        val ss = raw["search"]
        if (ss is JsObj && ss["keys"] is JsObj) {
            val hk = Js.assign(JsObj(), Js.or(ss["hasKeys"], JsObj()))
            val ks = ss["keys"] as JsObj
            ks.keys().forEach { id ->
                val v = (if (Js.nullish(ks[id])) "" else Js.toStr(ks[id])).trim()
                if (v.isNotEmpty()) {
                    keys.register("search:$id", "", if (id == "brave") AuthType.BRAVE else AuthType.BEARER)
                    if (keys.set("search:$id", v)) hk[id] = true
                }
            }
            ss["hasKeys"] = hk; ss.remove("keys"); changed = true
        }
        var json = Js.toJsonObject(raw)!!
        val s0 = SettingsCodec.decode(json)
        val s1 = SettingsMigrations.autoCharV084(s0)
        if (s1 != s0) { json = SettingsCodec.encode(s1); changed = true }
        if (providerMigration != null) providerMigration.invoke(json)?.let { if (it != json) { json = it; changed = true } }
        else if (s1.settingsVersion < 2) warnings += "settings.json 是 v${s1.settingsVersion}，服务商默认值迁移（Providers.migrateSettings）待 B 接线后执行"
        if (changed) store.rawSet("settings.json", Js.stringify(Js.fromJson(json))!!)
    }

    // ---------------- 整库导出 / 导入 ----------------
    fun exportBackup(out: OutputStream): Int = backup.exportZip(out)
    /** 导入前自动备份当前数据到 backupDir/pre-import-<ts>.zip；zip 校验失败时不动现有数据 */
    fun importBackup(input: InputStream): Int {
        val files = backup.readZip(input)
        backup.exportZip(File(backupDir, "pre-import-${now()}.zip"))
        val n = backup.restore(files)
        afterImport()
        return n
    }
    override suspend fun exportBackup(target: android.net.Uri): Result<Long> = withContext(Dispatchers.IO) {
        runCatching { val io = uriIo ?: error("SAF 未接线"); (io.openOut(target) ?: error("无法打开目标文件")).use { exportBackup(it).toLong() } }
    }
    override suspend fun importBackup(source: android.net.Uri): Result<Int> = withContext(Dispatchers.IO) {
        runCatching { val io = uriIo ?: error("SAF 未接线"); (io.openIn(source) ?: error("无法打开备份文件")).use { importBackup(it) } }
    }
}
