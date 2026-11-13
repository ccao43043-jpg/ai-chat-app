package com.aichat.app

import android.app.Application
import android.net.Uri
import com.aichat.app.data.DataGraph
import com.aichat.app.data.fake.EmptyPluginRegistry
import com.aichat.app.data.fake.UnwiredChatEngine
import com.aichat.app.data.migration.StoreMigrationService
import com.aichat.app.data.secret.SecretKeyVault
import com.aichat.app.data.store.JsonFileStore
import com.aichat.app.domain.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.File

/** 手写 DI 根（D 所有）。各工作流把实现挂在这里；不引入 Hilt，减少构建内存与 KSP。 */
class AiChatApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        graph.startMigration()
    }
}

/**
 * 整合者裁定 #a：AppGraph 暴露 chats / settings / library / keys / engine / plugins / migration，以及 B/C 需要的小仓库。
 * engine、plugins 在 B/C 合并前是占位实现（[UnwiredChatEngine] / [EmptyPluginRegistry]），合并时由 D 在这里替换为真实实现。
 */
class AppGraph(app: Application) {
    val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** 旧版 NativeBridge 的 dataDir：filesDir/store —— 原地沿用，不搬家 */
    private val fileStore = JsonFileStore(File(app.filesDir, "store"))
    private val secretVault = SecretKeyVault(SecretStore(app))
    val data = DataGraph(
        store = fileStore, keys = secretVault, backupDir = File(app.filesDir, "backup"),
        uriIo = object : StoreMigrationService.UriIo {
            override fun openOut(uri: Uri) = app.contentResolver.openOutputStream(uri, "wt")
            override fun openIn(uri: Uri) = app.contentResolver.openInputStream(uri)
        },
        fromVersionCode = { 0 }, // 旧版本号覆盖安装后已不可得；0 = 未知（报告里以 store 内容为准）
    )

    // ---- 数据（D） ----
    val store get() = data.store
    val chats: ChatRepository get() = data.chats
    val settings: SettingsRepository get() = data.settings
    val library: LibraryRepository get() = data.library
    val keys: KeyVault get() = secretVault
    val usage: UsageRepository get() = data.usage
    val migration: MigrationService get() = data.migration
    val convLog get() = data.convLog
    val knowledgeStore get() = data.knowledge
    val rpLogStore get() = data.rpLog
    val routerStateStore get() = data.routerState
    val balanceCacheStore get() = data.balanceCache
    val rpMemoryStore get() = data.rpMemory

    // ---- 引擎 / 插件（B / C 合并时替换） ----
    var engine: ChatEngine = UnwiredChatEngine
    var plugins: PluginRegistry = EmptyPluginRegistry

    // ---- 首次启动迁移：后台执行，不阻塞启动；报告给设置 →「数据与备份」 ----
    private val _migrationReport = MutableStateFlow<MigrationReport?>(null)
    val migrationReport: StateFlow<MigrationReport?> = _migrationReport

    fun startMigration() {
        appScope.launch {
            try {
                if (data.migration.needed()) {
                    _migrationReport.value = data.migration.run()
                    data.reloadAll()
                }
            } catch (e: Throwable) {
                _migrationReport.value = MigrationReport(0, 0, 0, emptyList(), null, listOf("迁移异常：${e.message}"))
            }
        }
    }
}
