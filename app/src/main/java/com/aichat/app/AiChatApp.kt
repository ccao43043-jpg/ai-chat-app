package com.aichat.app

import android.app.Application
import com.aichat.app.data.secret.SecretKeyVault
import com.aichat.app.data.store.FileStore
import com.aichat.app.data.store.JsonFileStore
import com.aichat.app.domain.KeyVault
import java.io.File

/** 手写 DI 根（D 所有）。各工作流把实现挂在这里；不引入 Hilt，减少构建内存与 KSP。 */
class AiChatApp : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
    }
}

class AppGraph(app: Application) {
    /** 旧版 NativeBridge 的 dataDir：filesDir/store —— 原地沿用，不搬家 */
    val store: FileStore = JsonFileStore(File(app.filesDir, "store"))
    val keys: KeyVault = SecretKeyVault(SecretStore(app))
    // TODO(D): chatRepository / settingsRepository / libraryRepository / usageRepository / migrationService
    // TODO(B): providerClient / imageClient / modelRouter / chatEngine / costCore / searchClient / balanceClient
    // TODO(C): pluginRegistry（knowledge → rpcache → usage → gcache → mmcache → affect）/ worldService / autoChar / charCard
}
