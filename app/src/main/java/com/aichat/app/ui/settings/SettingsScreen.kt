package com.aichat.app.ui.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.aichat.app.ui.common.LocalUiDeps
import kotlinx.coroutines.launch

/**
 * 设置壳：自带一个小返回栈。返回键 / 左上角返回 = 弹栈；栈空 = 关闭设置（回到聊天）。
 * 子页面可以自己用 BackHandler 先拦截（例如服务商编辑页的「放弃修改？」）。
 */
@Composable
fun SettingsScreen(start: SettingsDestination, onClose: () -> Unit, onStartPersona: ((com.aichat.app.domain.model.Persona) -> Unit)? = null) {
    // 栈元素：SettingsDestination.name 或 "panel:<pluginId>"（插件面板挂载点）
    val stack = remember(start) { mutableStateListOf(start.name) }
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val toast: (String) -> Unit = { m -> scope.launch { snack.showSnackbar(m) } }
    val back: () -> Unit = { if (stack.size > 1) stack.removeAt(stack.size - 1) else onClose() }
    BackHandler(onBack = back)
    val top = stack.last()
    val panel = top.removePrefix("panel:").takeIf { top.startsWith("panel:") }
    val dest = if (panel != null) SettingsDestination.Plugins else SettingsDestination.valueOf(top)
    val mounted = SettingsMounts.get(dest)
    Box(Modifier.fillMaxSize().testTag("settings")) {
        when {
            panel != null -> PluginPanels.get(panel)?.invoke(back) ?: SettingsPageScaffold(panel, back) { Text("该插件没有面板", Modifier.padding(20.dp)) }
            mounted != null -> mounted(back)
            dest == SettingsDestination.Main -> SettingsMain(onBack = back, open = { stack.add(it.name) })
            dest == SettingsDestination.Search -> SearchSettingsScreen(onBack = back, toast = toast)
            dest == SettingsDestination.Plugins -> PluginsScreen(onBack = back, openPanel = { stack.add("panel:$it") })
            dest == SettingsDestination.Prompts -> com.aichat.app.ui.library.PromptsScreen(onBack = back, toast = toast)
            dest == SettingsDestination.Templates -> com.aichat.app.ui.library.TemplatesScreen(onBack = back, toast = toast)
            dest == SettingsDestination.Personas -> com.aichat.app.ui.library.PersonasScreen(onBack = back, toast = toast,
                onStart = { p -> onStartPersona?.invoke(p); onClose() })
            dest == SettingsDestination.General -> GeneralSettings(onBack = back, toast = toast)
            dest == SettingsDestination.Providers -> ProvidersScreen(onBack = back, toast = toast)
            dest == SettingsDestination.DataBackup -> DataBackupScreen(onBack = back, toast = toast)
            else -> SettingsPageScaffold(dest.title, back) {
                Text("「${dest.title}」将在后续里程碑实现（负责：${dest.owner}）", modifier = Modifier.padding(20.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        SnackbarHost(snack, Modifier.align(Alignment.BottomCenter).imePadding())
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsPageScaffold(title: String, onBack: () -> Unit, actions: @Composable () -> Unit = {}, content: @Composable () -> Unit) {
    Scaffold(topBar = {
        TopAppBar(title = { Text(title) },
            navigationIcon = { IconButton(onClick = onBack, Modifier.testTag("settings-back")) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") } },
            actions = { actions() })
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize().imePadding().verticalScroll(rememberScrollState())) { content() }
    }
}

@Composable
fun SettingsRow(title: String, subtitle: String? = null, tag: String? = null, onClick: () -> Unit) {
    Column(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 20.dp, vertical = 14.dp)
        .let { if (tag != null) it.testTag(tag) else it }) {
        Text(title, style = MaterialTheme.typography.bodyLarge)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SettingsMain(onBack: () -> Unit, open: (SettingsDestination) -> Unit) {
    val deps = LocalUiDeps.current
    val s by deps.settings.settings.collectAsStateWithLifecycle()
    SettingsPageScaffold("设置", onBack) {
        SettingsRow("服务商", "${s.providers.size} 个 · 已填 Key ${s.providers.count { it.hasKey }} 个", "row-providers") { open(SettingsDestination.Providers) }
        SettingsRow("对话默认参数", "系统提示词、温度、最大输出、流式", "row-general") { open(SettingsDestination.General) }
        SettingsRow("数据与备份", "导出 / 导入整库 zip、导出全部对话 JSON", "row-backup") { open(SettingsDestination.DataBackup) }
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        SettingsRow("联网搜索", if (s.searchOn) "已开启" else "已关闭", "row-search") { open(SettingsDestination.Search) }
        SettingsRow("插件", "RP 缓存、Gemini/MiniMax 缓存、资料库、好感度、用量", "row-plugins") { open(SettingsDestination.Plugins) }
        SettingsRow("提示词库", "⚡ 常用文字，一键插入输入框", "row-prompts") { open(SettingsDestination.Prompts) }
        SettingsRow("提示词模板", "切换本对话的系统提示词", "row-templates") { open(SettingsDestination.Templates) }
        HorizontalDivider(Modifier.padding(vertical = 4.dp))
        SettingsRow("助手库", "常用助手、角色卡 PNG / JSON 导入导出", "row-personas") { open(SettingsDestination.Personas) }
        listOf(SettingsDestination.Worlds, SettingsDestination.Knowledge, SettingsDestination.Usage, SettingsDestination.Balance)
            .forEach { d -> SettingsRow(d.title, if (SettingsMounts.get(d) == null) "待实现" else null) { open(d) } }
    }
}

/** 解析温度：空 = 未设（JS ''），否则 0–2 */
fun parseTemperature(s: String): Result<Double?> {
    val t = s.trim(); if (t.isEmpty()) return Result.success(null)
    val v = t.toDoubleOrNull() ?: return Result.failure(IllegalArgumentException("温度需为数字"))
    return if (v in 0.0..2.0) Result.success(v) else Result.failure(IllegalArgumentException("温度范围 0–2"))
}
/** 解析最大输出：空 = 未设，否则正整数 */
fun parseMaxTokens(s: String): Result<Int?> {
    val t = s.trim(); if (t.isEmpty()) return Result.success(null)
    val v = t.toIntOrNull() ?: return Result.failure(IllegalArgumentException("最大输出需为整数"))
    return if (v > 0) Result.success(v) else Result.failure(IllegalArgumentException("最大输出需大于 0"))
}

@Composable
private fun GeneralSettings(onBack: () -> Unit, toast: (String) -> Unit) {
    val deps = LocalUiDeps.current
    val s by deps.settings.settings.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var sys by rememberSaveable { mutableStateOf(s.systemPrompt) }
    var temp by rememberSaveable { mutableStateOf(s.temperature?.toString().orEmpty()) }
    var maxT by rememberSaveable { mutableStateOf(s.maxTokens?.toString().orEmpty()) }
    var stream by rememberSaveable { mutableStateOf(s.stream) }
    val save = {
        val t = parseTemperature(temp); val m = parseMaxTokens(maxT)
        val err = t.exceptionOrNull() ?: m.exceptionOrNull()
        if (err != null) toast(err.message ?: "输入有误")
        else scope.launch {
            deps.settings.update { it.copy(systemPrompt = sys, temperature = t.getOrNull(), maxTokens = m.getOrNull(), stream = stream) }
            toast("已保存")
        }
    }
    SettingsPageScaffold("对话默认参数", onBack, actions = { TextButton(onClick = { save() }, Modifier.testTag("general-save")) { Text("保存") } }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedTextField(sys, { sys = it }, label = { Text("默认系统提示词") }, minLines = 3, maxLines = 10, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(temp, { temp = it }, label = { Text("温度（留空 = 服务商默认）") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            OutlinedTextField(maxT, { maxT = it }, label = { Text("最大输出 tokens（留空 = 自动）") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("流式输出", modifier = Modifier.weight(1f)); Switch(stream, { stream = it })
            }
        }
    }
}
