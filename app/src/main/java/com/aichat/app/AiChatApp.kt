package com.aichat.app

import android.app.Application
import android.net.Uri
import com.aichat.app.data.DataGraph
import com.aichat.app.data.fake.EmptyPluginRegistry
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
import kotlinx.serialization.json.put
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
        providerMigration = com.aichat.app.net.ProviderMigration.hook,   // B：Providers.migrateSettings（首启迁移里跑）
        fromVersionCode = { 0 }, // 旧版本号覆盖安装后已不可得；0 = 未知（报告里以 store 内容为准）
    )

    // ---- 数据（D） ----
    val store get() = data.store
    val chats: ChatRepository get() = data.chats
    val settings: SettingsRepository get() = data.settings
    val library: LibraryRepository get() = data.library
    val keys: KeyVault get() = secretVault
    val usage: UsageRepository get() = data.usage
    /** C 的 CharCardCodec 插槽（合并 C 时在这里赋值）；未接入为 null */
    var charCard: com.aichat.app.domain.rp.CharCardCodec?
        get() = data.charCard
        set(v) { data.charCard = v }
    val migration: MigrationService get() = data.migration
    val convLog get() = data.convLog
    val knowledgeStore get() = data.knowledge
    val rpLogStore get() = data.rpLog
    val routerStateStore get() = data.routerState
    val balanceCacheStore get() = data.balanceCache
    val rpMemoryStore get() = data.rpMemory

    // ---- 引擎 / 插件（I1：B 的真实引擎；C 合并前插件为空注册表） ----
    var plugins: PluginRegistry = EmptyPluginRegistry
    val providerClient = com.aichat.app.net.DefaultProviderClient(secretVault)
    /** OpenRouter 缓存亲和路由（app.js routerState，持久化在 router-affinity.json） */
    val affinityRouter = com.aichat.app.net.AffinityRouter(initial = data.routerState.load(), save = { data.routerState.save(it) })
    var engine: ChatEngine = com.aichat.app.engine.DefaultChatEngine(
        chats = data.chats, settingsRepo = data.settings, client = providerClient, plugins = EmptyPluginRegistry,
        router = affinityRouter, onUsage = { conv, provider, model, msg, usage -> recordUsage(conv, provider, model, msg, usage) },
    )

    /** app.js recordUsage + UsageStats.makeEntry（usage-stats.js 32–51）：追加一行到 usage-stats.jsonl；meta 不存在时先写 */
    private suspend fun recordUsage(conv: com.aichat.app.domain.model.Conversation, p: com.aichat.app.domain.model.ProviderConfig,
                                    model: String, msg: com.aichat.app.domain.model.Message, u: com.aichat.app.domain.model.Usage) {
        val prompt = u.prompt ?: return
        val completion = u.completion ?: 0
        val cache = u.cacheSupported == true
        val hit = if (cache) (u.hit ?: 0) else 0
        val miss = if (cache) (u.miss ?: maxOf(0, prompt - hit)) else prompt
        val at = System.currentTimeMillis()
        val rnd = (1..6).map { "0123456789abcdefghijklmnopqrstuvwxyz"[(Math.random() * 36).toInt()] }.joinToString("")
        val entry = kotlinx.serialization.json.buildJsonObject {
            put("id", "u_" + java.lang.Long.toString(at, 36) + "_" + rnd); put("at", at); put("type", "chat")
            put("prompt", prompt); put("completion", completion); put("hit", hit); put("miss", miss); put("cache", cache)
            put("model", model.ifEmpty { conv.model }); put("providerId", p.presetId.ifEmpty { p.id }); put("providerName", p.name)
            put("convId", conv.id); put("convTitle", conv.title); put("msgId", msg.id)
            put("key", "l:$at:${msg.id}:$prompt:$completion:chat")
            u.costUsd?.takeIf { it.isFinite() }?.let { put("actualCost", it) } ?: put("actualCost", kotlinx.serialization.json.JsonNull)
        }
        if (data.usage.meta().isEmpty()) data.usage.saveMeta(com.aichat.app.domain.cost.UsageStatsCore.metaOf(com.aichat.app.domain.cost.UsageStatsCore.emptyState()))
        data.usage.append(entry)
    }

    /** A 的 UI 依赖（真实实现） */
    fun uiDeps() = com.aichat.app.ui.common.UiDeps(chats = chats, settings = settings, library = library, keys = keys,
        engine = engine, plugins = plugins, migration = migration, isFake = false, charCard = charCard)

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
