package com.aichat.app.data

import com.aichat.app.data.convlog.ConvLogCodecImpl
import com.aichat.app.data.convlog.JsConvLog
import com.aichat.app.data.migration.StoreMigrationService
import com.aichat.app.data.repo.*
import com.aichat.app.data.secret.FakeKeyVault
import com.aichat.app.data.secret.KeyVaultAdmin
import com.aichat.app.data.store.FileStore
import com.aichat.app.data.store.MemFileStore
import kotlinx.serialization.json.JsonObject
import java.io.File

/**
 * 数据层组装（纯 JVM，可在单测里直接 new）。AppGraph 用真实 FileStore + SecretKeyVault 组装；
 * 其它工作流的测试 / 预览用 [DataGraph.inMemory]（MemFileStore + FakeKeyVault），行为与真机一致。
 */
class DataGraph(
    val store: FileStore,
    val keys: KeyVaultAdmin,
    backupDir: File,
    uriIo: StoreMigrationService.UriIo? = null,
    providerMigration: ((JsonObject) -> JsonObject?)? = null,
    fromVersionCode: () -> Int = { 0 },
    now: () -> Long = System::currentTimeMillis,
) {
    val convLog = ConvLogCodecImpl(JsConvLog(now))
    val settings = FileSettingsRepository(store, keys)
    val chats = FileChatRepository(store, convLog, now)
    val library = FileLibraryRepository(store, Builtins.load()) { settings.settings.value }
    val usage = FileUsageRepository(store)
    val knowledge = KnowledgeStore(store)
    val rpLog = RpLogStore(store)
    val routerState = JsonDocStore(store, "router-affinity.json")
    val balanceCache = JsonDocStore(store, "balance-cache.json")
    val rpMemory = JsonDocStore(store, "rp-memory.json")
    val migration = StoreMigrationService(store, keys, backupDir, uriIo, providerMigration, fromVersionCode, now).also { m ->
        m.afterImport = { reloadAll() }
    }

    /** 导入备份 / 迁移改写设置后，让所有仓库重读磁盘 */
    fun reloadAll() {
        convLog.engine.clearSessions()
        settings.reload(); chats.reload(); library.reload()
    }

    companion object {
        fun inMemory(initial: Map<String, String> = emptyMap(), keys: KeyVaultAdmin = FakeKeyVault(), now: () -> Long = System::currentTimeMillis): DataGraph =
            DataGraph(MemFileStore(initial), keys, File(System.getProperty("java.io.tmpdir"), "aichat-mem-backup-" + System.nanoTime()), now = now)
    }
}
