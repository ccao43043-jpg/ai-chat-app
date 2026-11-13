package com.aichat.app.ui.library

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.aichat.app.domain.model.PromptSnippet
import com.aichat.app.domain.model.PromptTemplate
import com.aichat.app.ui.common.ConfirmDialog
import com.aichat.app.ui.common.LocalUiDeps
import com.aichat.app.ui.settings.SettingsPageScaffold
import com.aichat.app.ui.settings.SettingsRow
import kotlinx.coroutines.launch

/*
 * 提示词库（⚡ 插入输入框）与提示词模板（替换本对话系统提示词）。
 * 读写只经 LibraryRepository；内置项合并由仓库负责；删除内置模板时由 UI 记入 settings.removedTemplates（同 app.js 4201）。
 */

internal fun newId(prefix: String) = prefix + System.currentTimeMillis().toString(36) + (Math.random() * 1e6).toLong().toString(36)

/** personas.js normalizePrompt */
fun normalizePrompt(id: String?, title: String, content: String, builtin: Boolean) =
    PromptSnippet(id ?: newId("q-"), title.trim().ifEmpty { content.trim().take(16) }.ifEmpty { "未命名" }, content, builtin)

/** templates.js normalizeTemplate */
fun normalizeTemplate(t: PromptTemplate): PromptTemplate = t.copy(
    name = t.name.trim().ifEmpty { t.content.trim().take(12) }.ifEmpty { "未命名模板" },
    emoji = t.emoji.trim().let { e -> if (e.codePointCount(0, e.length) > 4) e.substring(0, e.offsetByCodePoints(0, 4)) else e },
    tags = t.tags.map { it.trim() }.filter { it.isNotEmpty() }.distinct().take(8),
)

@Composable
fun PromptsScreen(onBack: () -> Unit, toast: (String) -> Unit) {
    val deps = LocalUiDeps.current
    val list by deps.library.prompts.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<PromptSnippet?>(null) }
    var deleting by remember { mutableStateOf<PromptSnippet?>(null) }
    editing?.let { p ->
        var title by rememberSaveable(p.id) { mutableStateOf(p.title) }
        var content by rememberSaveable(p.id) { mutableStateOf(p.content) }
        BackHandler { editing = null }
        SettingsPageScaffold(if (list.any { it.id == p.id }) "编辑提示词" else "新建提示词", { editing = null }, actions = {
            TextButton(onClick = {
                if (content.isBlank()) { toast("内容不能为空"); return@TextButton }
                val q = normalizePrompt(p.id, title, content, p.builtin).copy(extras = p.extras)
                scope.launch {
                    deps.library.savePrompts(if (list.any { it.id == q.id }) list.map { if (it.id == q.id) q else it } else list + q)
                    toast("已保存"); editing = null
                }
            }, Modifier.testTag("prompt-save")) { Text("保存") }
        }) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(title, { title = it }, label = { Text("标题") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(content, { content = it }, label = { Text("插入到输入框的文字") }, minLines = 5, modifier = Modifier.fillMaxWidth())
            }
        }
        return
    }
    SettingsPageScaffold("提示词库", onBack, actions = {
        TextButton(onClick = { editing = PromptSnippet(newId("q-"), "", "", false) }, Modifier.testTag("prompt-add")) { Text("新建") }
    }) {
        if (list.isEmpty()) Text("还没有提示词。点「新建」添加常用的一段话，聊天时点 ⚡ 插入。", Modifier.padding(20.dp),
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        list.forEach { p ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    SettingsRow(p.title + if (p.builtin) "（内置）" else "", p.content.replace('\n', ' ').take(60)) { editing = p }
                }
                TextButton(onClick = { deleting = p }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
    deleting?.let { p ->
        ConfirmDialog("删除提示词？", "「${p.title}」", "删除", danger = true, onDismiss = { deleting = null },
            onOk = { scope.launch { deps.library.savePrompts(list.filterNot { it.id == p.id }) } })
    }
}

@Composable
fun TemplatesScreen(onBack: () -> Unit, toast: (String) -> Unit) {
    val deps = LocalUiDeps.current
    val list by deps.library.templates.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<PromptTemplate?>(null) }
    var deleting by remember { mutableStateOf<PromptTemplate?>(null) }
    editing?.let { t ->
        var name by rememberSaveable(t.id) { mutableStateOf(t.name) }
        var emoji by rememberSaveable(t.id) { mutableStateOf(t.emoji) }
        var tags by rememberSaveable(t.id) { mutableStateOf(t.tags.joinToString("，")) }
        var content by rememberSaveable(t.id) { mutableStateOf(t.content) }
        var pinned by rememberSaveable(t.id) { mutableStateOf(t.pinned) }
        BackHandler { editing = null }
        SettingsPageScaffold(if (list.any { it.id == t.id }) "编辑模板" else "新建模板", { editing = null }, actions = {
            TextButton(onClick = {
                if (content.isBlank()) { toast("系统提示词不能为空"); return@TextButton }
                val nt = normalizeTemplate(t.copy(name = name, emoji = emoji, content = content, pinned = pinned,
                    tags = tags.split(Regex("[,，、\\s]+"))))
                scope.launch {
                    deps.library.saveTemplates(if (list.any { it.id == nt.id }) list.map { if (it.id == nt.id) nt else it } else list + nt)
                    toast("已保存"); editing = null
                }
            }, Modifier.testTag("template-save")) { Text("保存") }
        }) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(emoji, { emoji = it }, label = { Text("图标") }, singleLine = true, modifier = Modifier.weight(0.3f))
                    OutlinedTextField(name, { name = it }, label = { Text("名称") }, singleLine = true, modifier = Modifier.weight(0.7f))
                }
                OutlinedTextField(tags, { tags = it }, label = { Text("标签（逗号分隔）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(content, { content = it }, label = { Text("系统提示词") }, minLines = 6, modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("可以用 {{变量名}} 或 {{变量名|默认值}} 插入变量，套用时提示填写；{{date}} {{time}} 自动替换。") })
                Row(verticalAlignment = Alignment.CenterVertically) { Text("置顶", Modifier.weight(1f)); Switch(pinned, { pinned = it }) }
            }
        }
        return
    }
    SettingsPageScaffold("提示词模板", onBack, actions = {
        TextButton(onClick = { editing = PromptTemplate(newId("t-"), "", "", "", emptyList(), false, false, false) }, Modifier.testTag("template-add")) { Text("新建") }
    }) {
        Text("模板 = 替换「本对话」的系统提示词；⚡ 提示词库 = 把文字插入输入框。", Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        sortTemplates(list).forEach { t ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    SettingsRow((t.emoji.ifEmpty { "📝" }) + " " + t.name + (if (t.pinned) " 📌" else "") + (if (t.builtin) "（内置）" else ""),
                        (t.tags.joinToString(" · ").let { if (it.isEmpty()) "" else "$it · " }) + t.content.replace('\n', ' ').take(50)) { editing = t }
                }
                TextButton(onClick = { deleting = t }) { Text("删除", color = MaterialTheme.colorScheme.error) }
            }
        }
    }
    deleting?.let { t ->
        ConfirmDialog("删除模板？", "「${t.name}」", "删除", danger = true, onDismiss = { deleting = null },
            onOk = { scope.launch {
                deps.library.saveTemplates(list.filterNot { it.id == t.id })
                // app.js 4201：删掉内置模板记入 settings.removedTemplates，mergeBuiltins 不再补回
                if (t.builtin) deps.settings.update { s -> if (t.id in s.removedTemplates) s else s.copy(removedTemplates = s.removedTemplates + t.id) }
            } })
    }
}

fun sortTemplates(list: List<PromptTemplate>) = list.sortedWith(compareByDescending<PromptTemplate> { it.pinned })

/** 聊天里 ⚡ 弹层：选一条插入输入框 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PromptSheet(onPick: (String) -> Unit, onManage: () -> Unit, onDismiss: () -> Unit) {
    val deps = LocalUiDeps.current
    val list by deps.library.prompts.collectAsStateWithLifecycle()
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("prompt-sheet")) {
        LazyColumn(Modifier.navigationBarsPadding()) {
            item { Text("⚡ 提示词库", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(20.dp, 4.dp)) }
            if (list.isEmpty()) item { Text("还没有提示词", Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(list, key = { it.id }) { p ->
                Column(Modifier.fillMaxWidth().clickable { onPick(p.content) }.padding(horizontal = 20.dp, vertical = 10.dp)) {
                    Text(p.title, style = MaterialTheme.typography.bodyLarge)
                    Text(p.content, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            item { TextButton(onClick = onManage, modifier = Modifier.padding(12.dp)) { Text("管理提示词…") } }
        }
    }
}

/** 模板弹层：套用 / 清空本对话系统提示词；有变量时先填变量 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TemplateSheet(currentTemplateId: String?, hasSystem: Boolean, onApply: (PromptTemplate?, String) -> Unit, onManage: () -> Unit, onDismiss: () -> Unit) {
    val deps = LocalUiDeps.current
    val list by deps.library.templates.collectAsStateWithLifecycle()
    var filling by remember { mutableStateOf<PromptTemplate?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("template-sheet")) {
        LazyColumn(Modifier.navigationBarsPadding()) {
            item { Text("提示词模板（本对话的系统提示词）", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(20.dp, 4.dp)) }
            items(sortTemplates(list), key = { it.id }) { t ->
                Text((if (t.id == currentTemplateId) "✓ " else "") + t.emoji.ifEmpty { "📝" } + " " + t.name,
                    modifier = Modifier.fillMaxWidth().clickable {
                        if (TemplateText.variables(t.content).isEmpty()) onApply(t, TemplateText.fill(t.content, emptyMap(), t.builtin)) else filling = t
                    }.padding(horizontal = 20.dp, vertical = 12.dp))
            }
            item {
                HorizontalDivider()
                Row {
                    if (hasSystem) TextButton(onClick = { onApply(null, "") }, Modifier.padding(8.dp)) { Text("清空系统提示词") }
                    TextButton(onClick = onManage, Modifier.padding(8.dp)) { Text("管理模板…") }
                }
            }
        }
    }
    filling?.let { t ->
        val vars = remember(t.id) { TemplateText.variables(t.content) }
        val values = remember(t.id) { mutableStateMapOf<String, String>() }
        AlertDialog(onDismissRequest = { filling = null }, title = { Text("填写「${t.name}」的变量") }, text = {
            Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("没填的变量会保留原样，之后可在系统提示词里再改。", style = MaterialTheme.typography.bodySmall)
                vars.forEach { v -> OutlinedTextField(values[v] ?: "", { values[v] = it }, label = { Text(v) }, singleLine = true) }
            }
        }, confirmButton = { TextButton(onClick = { onApply(t, TemplateText.fill(t.content, values.toMap(), t.builtin)); filling = null }) { Text("套用") } },
            dismissButton = { TextButton(onClick = { filling = null }) { Text("取消") } })
    }
}
