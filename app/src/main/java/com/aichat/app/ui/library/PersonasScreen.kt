package com.aichat.app.ui.library

import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.aichat.app.domain.model.Persona
import com.aichat.app.ui.common.ConfirmDialog
import com.aichat.app.ui.common.LocalUiDeps
import com.aichat.app.ui.settings.SettingsPageScaffold
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** personas.js 的列表操作（normalize / upsert / duplicate），纯函数，可单测 */
object PersonaOps {
    /** app.js EMOJIS */
    val EMOJIS = listOf("🤖", "🧠", "✨", "📚", "🧑‍💻", "🎨", "📈", "⚖️", "🩺", "🍳", "✈️", "🎵", "🧾", "💡", "🐱", "🦊")

    /** personas.js normalizePersona（emoji 取前 4 个 UTF-16 单元，同 JS slice；温度夹到 0–2；扩展字段在 extras 原样保留） */
    fun normalize(p: Persona): Persona {
        val e = p.emoji.ifEmpty { "🤖" }.trim().let { it.substring(0, minOf(4, it.length)) }.ifEmpty { "🤖" }
        return p.copy(id = p.id.ifEmpty { newId("p-") }, emoji = e, name = p.name.trim().ifEmpty { "未命名助手" }, desc = p.desc.trim(),
            model = p.model.trim(), temperature = p.temperature?.takeIf { !it.isNaN() }?.coerceIn(0.0, 2.0))
    }

    /** personas.js upsert：已有则合并（保留表单没编辑的扩展字段），否则追加 */
    fun upsert(list: List<Persona>, item: Persona): List<Persona> {
        val n = normalize(item)
        val i = list.indexOfFirst { it.id == n.id }
        return if (i >= 0) list.toMutableList().also { it[i] = n.copy(extras = JsonObject(list[i].extras + n.extras)) } else list + n
    }

    /** personas.js duplicate：插在原项后面，名字加「（副本）」，不再是内置 */
    fun duplicate(list: List<Persona>, id: String): List<Persona> {
        val i = list.indexOfFirst { it.id == id }; if (i < 0) return list
        val src = list[i]
        val copy = normalize(src.copy(id = newId("p-"), name = src.name + "（副本）", builtin = false))
        return list.toMutableList().also { it.add(i + 1, copy) }
    }

    fun str(p: Persona, k: String) = (p.extras[k] as? JsonPrimitive)?.content.orEmpty()
}

/** 助手库（app.js 3309–3520）：开始对话、编辑、导出角色卡 PNG、复制、删除；新建 = 空白 / 导入角色卡 PNG·JSON */
@Composable
fun PersonasScreen(onBack: () -> Unit, toast: (String) -> Unit, onStart: (Persona) -> Unit) {
    val deps = LocalUiDeps.current
    val ctx = LocalContext.current
    val list by deps.library.personas.collectAsStateWithLifecycle()
    val prompts by deps.library.prompts.collectAsStateWithLifecycle()
    val settings by deps.settings.settings.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<Persona?>(null) }
    var deleting by remember { mutableStateOf<Persona?>(null) }
    var addMenu by remember { mutableStateOf(false) }
    var exporting by remember { mutableStateOf<Persona?>(null) }
    val codec = deps.charCard
    val noCodec = "角色卡功能尚未接入（等待工作流 C 的 CharCardCodec）"

    val importer = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        if (codec == null) { toast(noCodec); return@rememberLauncherForActivityResult }
        scope.launch {
            val r = runCatching {
                val (bytes, name) = withContext(Dispatchers.IO) {
                    val b = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
                    b to (uri.lastPathSegment ?: "card")
                }
                val card = codec.parseCard(bytes, name).getOrThrow()
                val mapped = codec.cardToPersona(card)
                PersonaOps.normalize(mapped.copy(builtin = false))
            }
            r.fold({ item ->
                deps.library.savePersonas(PersonaOps.upsert(deps.library.personas.value, item))
                toast("已导入角色卡「${item.name}」" + if (PersonaOps.str(item, "loreText").isNotEmpty()) "（含世界书）" else "")
                editing = deps.library.personas.value.firstOrNull { it.id == item.id }
            }, { toast("导入失败：${it.message ?: it}") })
        }
    }
    val exporter = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("image/png")) { uri ->
        val p = exporting; exporting = null
        if (uri == null || p == null) return@rememberLauncherForActivityResult
        if (codec == null) { toast(noCodec); return@rememberLauncherForActivityResult }
        scope.launch {
            val r = runCatching {
                val png = codec.writeCardToPng(codec.personaToCard(p), null)
                withContext(Dispatchers.IO) { ctx.contentResolver.openOutputStream(uri)!!.use { it.write(png) } }
            }
            toast(if (r.isSuccess) "已导出「${p.name}」角色卡 PNG" else "导出失败：${r.exceptionOrNull()?.message}")
        }
    }

    editing?.let { p ->
        PersonaEditor(p, isNew = list.none { it.id == p.id }, onClose = { editing = null }, toast = toast,
            onDelete = { editing = null; deleting = it })
        return
    }

    SettingsPageScaffold("助手库", onBack, actions = {
        Box {
            TextButton(onClick = { addMenu = true }, Modifier.testTag("persona-add")) { Text("新建") }
            DropdownMenu(addMenu, { addMenu = false }) {
                DropdownMenuItem(text = { Text("空白助手") }, onClick = { addMenu = false
                    editing = Persona("", "🤖", "", "", "", "", "", null, false).let { PersonaOps.normalize(it) } })
                DropdownMenuItem(text = { Text("导入角色卡 PNG / JSON") }, modifier = Modifier.testTag("persona-import"), onClick = {
                    addMenu = false
                    if (codec == null) toast(noCodec) else importer.launch(arrayOf("image/png", "application/json", "application/octet-stream"))
                })
            }
        }
    }) {
        Text("${list.size} 助手 · ${prompts.size} 提示词", style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 6.dp))
        list.forEach { ps ->
            var more by remember(ps.id) { mutableStateOf(false) }
            val prov = settings.providers.firstOrNull { ps.providerId.isNotEmpty() && it.id == ps.providerId }
            Row(Modifier.fillMaxWidth().clickable { onStart(ps) }.padding(start = 20.dp, top = 10.dp, bottom = 10.dp).testTag("persona-${ps.id}"),
                verticalAlignment = Alignment.CenterVertically) {
                Text(ps.emoji, style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(end = 12.dp))
                Column(Modifier.weight(1f)) {
                    Text(ps.name, style = MaterialTheme.typography.bodyLarge)
                    Text(ps.desc.ifEmpty { ps.systemPrompt.take(40) }, style = MaterialTheme.typography.bodySmall, maxLines = 1,
                        overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val tags = listOfNotNull(prov?.let { ps.model.ifEmpty { it.name } }, ps.temperature?.let { "温度 ${fmt(it)}" }, if (ps.builtin) "内置" else null)
                    if (tags.isNotEmpty()) Text(tags.joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
                Box {
                    IconButton(onClick = { more = true }) { Icon(Icons.Filled.MoreVert, "更多") }
                    DropdownMenu(more, { more = false }) {
                        DropdownMenuItem(text = { Text("开始对话") }, onClick = { more = false; onStart(ps) })
                        DropdownMenuItem(text = { Text("编辑") }, onClick = { more = false; editing = ps })
                        DropdownMenuItem(text = { Text("导出角色卡 PNG") }, onClick = {
                            more = false
                            if (codec == null) toast(noCodec) else { exporting = ps; exporter.launch((ps.name.ifEmpty { "character" }) + ".png") }
                        })
                        DropdownMenuItem(text = { Text("复制一份") }, onClick = {
                            more = false; scope.launch { deps.library.savePersonas(PersonaOps.duplicate(list, ps.id)); toast("已复制") }
                        })
                        DropdownMenuItem(text = { Text("删除", color = MaterialTheme.colorScheme.error) }, onClick = { more = false; deleting = ps })
                    }
                }
            }
        }
    }
    deleting?.let { ps ->
        ConfirmDialog("删除助手？", "「${ps.name}」将被删除，已有的对话不受影响。", "删除", danger = true, onDismiss = { deleting = null }, onOk = {
            deleting = null
            scope.launch {
                deps.library.savePersonas(deps.library.personas.value.filterNot { it.id == ps.id })
                // app.js deletePersona：删掉内置助手记入 settings.removedPersonas
                if (ps.builtin) deps.settings.update { s -> if (ps.id in s.removedPersonas) s else s.copy(removedPersonas = s.removedPersonas + ps.id) }
                toast("已删除")
            }
        })
    }
}

private fun fmt(d: Double) = if (d == Math.floor(d)) d.toLong().toString() else d.toString()

/** 助手编辑（app.js openPersonaEdit / ps-save） */
@Composable
private fun PersonaEditor(p: Persona, isNew: Boolean, onClose: () -> Unit, toast: (String) -> Unit, onDelete: (Persona) -> Unit) {
    val deps = LocalUiDeps.current
    val settings by deps.settings.settings.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var emoji by rememberSaveable(p.id) { mutableStateOf(p.emoji) }
    var name by rememberSaveable(p.id) { mutableStateOf(if (isNew) "" else p.name) }
    var desc by rememberSaveable(p.id) { mutableStateOf(p.desc) }
    var prompt by rememberSaveable(p.id) { mutableStateOf(p.systemPrompt) }
    var providerId by rememberSaveable(p.id) { mutableStateOf(p.providerId) }
    var model by rememberSaveable(p.id) { mutableStateOf(p.model) }
    var temp by rememberSaveable(p.id) { mutableStateOf(p.temperature?.let(::fmt) ?: "") }
    var provMenu by remember { mutableStateOf(false) }
    BackHandler { onClose() }
    val provs = settings.providers.filter { it.hasKey || it.id == p.providerId }
    val prov = settings.providers.firstOrNull { providerId.isNotEmpty() && it.id == providerId }
    SettingsPageScaffold(if (isNew) "新建助手" else "编辑助手", onClose, actions = {
        TextButton(onClick = {
            if (name.isBlank()) { toast("请填写助手名称"); return@TextButton }
            if (prompt.isBlank()) { toast("请填写系统提示词"); return@TextButton }
            val t = temp.trim()
            val tv = if (t.isEmpty()) null else t.toDoubleOrNull()
            val item = p.copy(emoji = emoji.trim().ifEmpty { "🤖" }, name = name.trim(), desc = desc.trim(), systemPrompt = prompt,
                providerId = providerId, model = model.trim(), temperature = tv)
            scope.launch { deps.library.savePersonas(PersonaOps.upsert(deps.library.personas.value, item)); toast("已保存"); onClose() }
        }, Modifier.testTag("persona-save")) { Text("保存") }
    }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                PersonaOps.EMOJIS.forEach { em -> FilterChip(emoji == em, { emoji = em }, label = { Text(em) }) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(emoji, { emoji = it }, label = { Text("图标") }, singleLine = true, modifier = Modifier.weight(0.3f))
                OutlinedTextField(name, { name = it }, label = { Text("名称") }, singleLine = true, modifier = Modifier.weight(0.7f).testTag("persona-name"))
            }
            OutlinedTextField(desc, { desc = it }, label = { Text("简介") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(prompt, { prompt = it }, label = { Text("系统提示词") }, minLines = 6, modifier = Modifier.fillMaxWidth().testTag("persona-prompt"))
            Box {
                TextButton(onClick = { provMenu = true }) {
                    Text("服务商：" + (prov?.let { it.name + if (it.hasKey) "" else "（未配置）" } ?: "跟随当前对话"))
                }
                DropdownMenu(provMenu, { provMenu = false }) {
                    DropdownMenuItem(text = { Text("跟随当前对话") }, onClick = { provMenu = false; providerId = ""; model = "" })
                    provs.forEach { pv -> DropdownMenuItem(text = { Text(pv.name + if (pv.hasKey) "" else "（未配置）") },
                        onClick = { provMenu = false; providerId = pv.id; model = "" }) }
                }
            }
            if (prov != null) {
                OutlinedTextField(model, { model = it }, label = { Text("模型（留空用服务商第一个）") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    prov.models.filter { it.isNotBlank() }.forEach { m -> FilterChip(model == m, { model = m }, label = { Text(m) }) }
                }
            }
            OutlinedTextField(temp, { temp = it }, label = { Text("温度（0–2，留空 = 默认）") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), modifier = Modifier.fillMaxWidth())
            val lore = PersonaOps.str(p, "loreText"); val first = PersonaOps.str(p, "firstMes")
            if (lore.isNotEmpty() || first.isNotEmpty()) Text(listOfNotNull(if (lore.isNotEmpty()) "含世界书（${lore.length} 字）" else null,
                if (first.isNotEmpty()) "含开场白" else null).joinToString(" · ") + "，开始对话时自动载入",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!isNew) TextButton(onClick = { onDelete(p) }) { Text("删除助手", color = MaterialTheme.colorScheme.error) }
        }
    }
}
