package com.aichat.app.ui.common

import androidx.compose.runtime.staticCompositionLocalOf
import com.aichat.app.domain.ChatEngine
import com.aichat.app.domain.ChatRepository
import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.LibraryRepository
import com.aichat.app.domain.MigrationService
import com.aichat.app.domain.PluginRegistry
import com.aichat.app.domain.SettingsRepository

/**
 * UI 层（工作流 A）的全部依赖——只有契约接口，不碰 net/data 实现类（spec §3.3）。
 * 由 MainActivity 组装：AppGraph 有真实实现就用真实的，否则用 ui/common/fake 的内存实现。
 */
data class UiDeps(
    val chats: ChatRepository,
    val settings: SettingsRepository,
    val library: LibraryRepository,
    val keys: KeyVault,
    val engine: ChatEngine,
    val plugins: PluginRegistry,
    val migration: MigrationService?,
    /** true = 当前用的是 fake 实现（顶栏显示「演示数据」提示） */
    val isFake: Boolean = false,
)

val LocalUiDeps = staticCompositionLocalOf<UiDeps> { error("UiDeps 未提供") }
