package com.aichat.app.ui.settings

import androidx.compose.runtime.Composable

/**
 * 设置页目的地。A 实现 Main/General/Providers/DataBackup；其余是给 B / C / 后续里程碑的挂载点：
 * 通过 [SettingsMounts] 注册 Composable，未注册时显示「待实现」占位。
 */
enum class SettingsDestination(val title: String, val owner: String) {
    Main("设置", "A"),
    General("对话默认参数", "A"),
    Providers("服务商", "A"),
    DataBackup("数据与备份", "A"),
    Search("联网搜索", "A"),
    Plugins("插件", "A"),
    Prompts("提示词库", "A"),
    Templates("提示词模板", "A"),
    Personas("助手库", "A·M3"),
    Usage("用量统计", "B"),
    Balance("余额", "B"),
    Worlds("世界模板", "C"),
    Knowledge("知识库", "C"),
    RpPanels("RP 缓存 / 好感面板", "C"),
}

/** 挂载点注册表：key = 目的地，value = 页面内容（onBack 由壳提供；页面自己可以再拦截返回键） */
typealias SettingsPage = @Composable (onBack: () -> Unit) -> Unit

object SettingsMounts {
    private val pages = HashMap<SettingsDestination, SettingsPage>()
    fun register(dest: SettingsDestination, page: SettingsPage) { pages[dest] = page }
    fun get(dest: SettingsDestination): SettingsPage? = pages[dest]
}
