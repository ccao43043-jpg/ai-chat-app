package com.aichat.app.ui.chat

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
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
import com.aichat.app.ui.common.ConfirmDialog
import com.aichat.app.ui.common.EditorAction
import com.aichat.app.ui.common.FullScreenEditor
import com.aichat.app.ui.common.ImageViewer
import com.aichat.app.ui.library.PromptSheet
import com.aichat.app.ui.library.TemplateSheet
import com.aichat.app.ui.common.LocalUiDeps
import com.aichat.app.ui.conversation.ConversationDrawer
import com.aichat.app.ui.settings.SettingsDestination
import kotlinx.coroutines.launch

/**
 * 聊天页：顶栏（抽屉 / 标题 + 模型切换 / 更多）、消息列表（reverseLayout，流式时贴底）、输入区。
 * 返回键：看图 > 弹层/对话框（各自处理）> 抽屉 > 交给上层。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    controller: ChatController,
    onOpenSettings: (SettingsDestination) -> Unit,
    /** 顶栏「更多」菜单的挂载点：B/C 可以在这里追加项（用量、RP 面板等） */
    extraMenu: List<Pair<String, () -> Unit>> = emptyList(),
) {
    val deps = LocalUiDeps.current
    val st by controller.state.collectAsStateWithLifecycle()
    val index by controller.index.collectAsStateWithLifecycle()
    val settings by controller.settings.collectAsStateWithLifecycle()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var input by rememberSaveable { mutableStateOf("") }
    var picker by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf<String?>(null) }
    var editing by rememberSaveable { mutableStateOf<String?>(null) }
    var confirmRegen by remember { mutableStateOf<Pair<String, String>?>(null) }
    var sheet by rememberSaveable { mutableStateOf(0) }          // 1 = 提示词库，2 = 模板
    var convPlugins by remember { mutableStateOf(false) }
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var exportId by remember { mutableStateOf<String?>(null) }
    val exporter = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("application/json")) { uri ->
        val id = exportId; exportId = null
        if (uri == null || id == null) return@rememberLauncherForActivityResult
        scope.launch {
            val r = runCatching {
                val json = controller.exportJson(id)
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
                    ctx.contentResolver.openOutputStream(uri)!!.use { it.write(json.toByteArray()) }
                }
            }
            controller.toast(if (r.isSuccess) "已导出对话" else "导出失败：${r.exceptionOrNull()?.message}")
        }
    }
    val exportConv: (String) -> Unit = { id ->
        exportId = id
        exporter.launch(controller.titleOf(id).replace(Regex("[\\\\/:*?\"<>|\\s]+"), "_").take(40) + ".json")
    }
    val listState = rememberLazyListState()

    LaunchedEffect(st.toast) { st.toast?.let { snack.showSnackbar(it); controller.consumeToast() } }
    BackHandler(enabled = drawer.isOpen) { scope.launch { drawer.close() } }

    val target = controller.currentTarget(settings)
    val messages = st.messages
    val conv = st.conv

    // 新消息 / 切对话时回到底部
    LaunchedEffect(st.convId, messages.size) { if (messages.isNotEmpty()) listState.scrollToItem(0) }

    ModalNavigationDrawer(drawerState = drawer, drawerContent = {
        ConversationDrawer(index, st.convId,
            onSelect = { controller.select(it); scope.launch { drawer.close() } },
            onNew = { controller.newConversation(); scope.launch { drawer.close() } },
            onRename = controller::rename,
            onDelete = controller::delete,
            onOpenSettings = { scope.launch { drawer.close() }; onOpenSettings(SettingsDestination.Main) },
            onExport = exportConv)
    }) {
        Scaffold(
            contentWindowInsets = WindowInsets(0),
            snackbarHost = { SnackbarHost(snack) },
            topBar = {
                CenterAlignedTopAppBar(
                    navigationIcon = { IconButton(onClick = { scope.launch { drawer.open() } }, Modifier.testTag("open-drawer")) { Icon(Icons.Filled.Menu, "对话列表") } },
                    title = {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(conv?.title ?: "新对话", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium)
                            TextButton(onClick = { picker = true }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 0.dp),
                                modifier = Modifier.testTag("model-switch")) {
                                Text(target?.let { "${it.first.name} · ${it.second}" } ?: "选择模型", maxLines = 1, overflow = TextOverflow.Ellipsis,
                                    style = MaterialTheme.typography.labelMedium)
                                Icon(Icons.Filled.ArrowDropDown, null)
                            }
                        }
                    },
                    actions = {
                        ChatMounts.usage?.invoke(conv, settings) ?: DefaultUsageChip(conv, settings)
                        IconButton(onClick = { controller.newConversation() }, Modifier.testTag("new-conv")) { Icon(Icons.Filled.Add, "新对话") }
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "更多") }
                            DropdownMenu(menu, { menu = false }) {
                                DropdownMenuItem(text = { Text("设置") }, onClick = { menu = false; onOpenSettings(SettingsDestination.Main) })
                                if (conv != null) DropdownMenuItem(text = { Text("导出本对话") }, onClick = { menu = false; exportConv(conv.id) })
                                if (conv != null) DropdownMenuItem(text = { Text("本对话插件") }, onClick = { menu = false; convPlugins = true })
                                DropdownMenuItem(text = { Text("数据与备份") }, onClick = { menu = false; onOpenSettings(SettingsDestination.DataBackup) })
                                extraMenu.forEach { (label, act) -> DropdownMenuItem(text = { Text(label) }, onClick = { menu = false; act() }) }
                            }
                        }
                    },
                )
            },
        ) { pad ->
            Column(Modifier.padding(pad).fillMaxSize()) {
                if (deps.isFake) Text("演示模式：数据层 / 网络层尚未接入，回复由 fake 引擎生成，不会保存",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp))
                Box(Modifier.weight(1f)) {
                    if (messages.isEmpty()) {
                        Text("有什么可以帮你？", style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.align(Alignment.Center))
                    } else {
                        val rev = remember(messages) { messages.asReversed() }
                        LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize().testTag("messages"),
                            contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(14.dp, Alignment.Bottom)) {
                            items(rev, key = { it.id }, contentType = { it.role }) { m ->
                                val live = st.streaming?.liveId == m.id || m.id == ChatController.PENDING_USER_ID
                                val ms = if (conv != null && !live) deps.plugins.messageState(m, settings, conv) else null
                                val badges = if (conv != null && !live) deps.plugins.messageBadges(m, settings, conv) else emptyList()
                                val isUser = m.role == com.aichat.app.domain.model.Role.USER
                                MessageItem(m, streaming = live && !isUser, badges = badges,
                                    onToast = controller::toast, onImage = { viewing = it },
                                    locked = st.isStreaming || ms?.dim == true, stateLabel = ms?.label,
                                    actions = MessageActions(
                                        onEdit = { editing = m.id },
                                        onRegenerate = if (isUser) null else ({
                                            val ask = controller.regenerateNeedsConfirm(m.id)
                                            if (ask == null) controller.regenerate(m.id) else confirmRegen = m.id to ask
                                        }),
                                        onContinue = if (!isUser && controller.canContinue(m)) ({ controller.continueGeneration(m.id) }) else null,
                                        onVersion = { k -> controller.selectVersion(m.id, k) },
                                    ))
                            }
                        }
                    }
                }
                ChatMounts.headerExtras?.invoke(conv, settings)
                val tplName = (conv?.extras?.get("templateName") as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf { it.isNotEmpty() }
                val tplEmoji = (conv?.extras?.get("templateEmoji") as? kotlinx.serialization.json.JsonPrimitive)?.content.orEmpty()
                InputBar(input, { input = it }, st.draftImages, controller::setDraftImages, st.isStreaming,
                    onSend = { if (controller.send(input, st.draftImages, st.draftFiles)) { input = ""; controller.setDraftImages(emptyList()); controller.setDraftFiles(emptyList()) } },
                    onStop = controller::stop, onToast = controller::toast, modifier = Modifier.imePadding(),
                    files = st.draftFiles, onFiles = controller::setDraftFiles,
                    tools = InputTools(onPrompts = { sheet = 1 }, onTemplates = { sheet = 2 },
                        templateLabel = tplName?.let { (tplEmoji.ifEmpty { "📋" }) + " " + it },
                        searchOn = settings.searchOn, onSearch = controller::setSearchOn))
            }
        }
    }

    editing?.let { id ->
        val m = conv?.messages?.firstOrNull { it.id == id }
        if (m == null) editing = null else {
            val user = m.role == com.aichat.app.domain.model.Role.USER
            val after = conv.messages.size - 1 - conv.messages.indexOf(m)
            FullScreenEditor(
                title = if (user) "编辑消息" else "编辑回复",
                initial = m.content,
                actions = if (user) listOf(EditorAction("save", "保存"), EditorAction("resend", "保存并重新发送", primary = true))
                    else listOf(EditorAction("save", "保存", primary = true)),
                hint = if (user && after > 0) "「保存并重新发送」会开一个新版本，之后的 $after 条对话留在旧版本里，可用 ‹ › 切回。" else null,
                onResult = { key, text ->
                    val ok = if (key == "resend") controller.editAndResend(id, text) else controller.editMessage(id, text)
                    if (ok) editing = null
                },
                onDismiss = { editing = null })
        }
    }
    confirmRegen?.let { (id, body) ->
        ConfirmDialog("重新生成这条回复？", body, "重新生成", onOk = { confirmRegen = null; controller.regenerate(id) }, onDismiss = { confirmRegen = null })
    }
    if (sheet == 1) PromptSheet(onPick = { t -> input = if (input.isEmpty()) t else input + (if (input.endsWith("\n")) "" else "\n") + t; sheet = 0 },
        onManage = { sheet = 0; onOpenSettings(SettingsDestination.Prompts) }, onDismiss = { sheet = 0 })
    if (sheet == 2) TemplateSheet(
        currentTemplateId = (conv?.extras?.get("templateId") as? kotlinx.serialization.json.JsonPrimitive)?.content,
        hasSystem = !conv?.systemPrompt.isNullOrEmpty(),
        onApply = { t, text -> controller.setConversationSystem(text, t?.id, t?.name, t?.emoji); sheet = 0
            controller.toast(if (t == null) "已清空系统提示词" else "已套用模板「${t.name}」") },
        onManage = { sheet = 0; onOpenSettings(SettingsDestination.Templates) }, onDismiss = { sheet = 0 })
    if (convPlugins) {
        val perConv = deps.plugins.plugins.filter { it.perConversation }
        androidx.compose.material3.AlertDialog(onDismissRequest = { convPlugins = false }, title = { Text("本对话插件") },
            text = { Column {
                if (perConv.isEmpty()) Text("没有可按对话开关的插件")
                perConv.forEach { p ->
                    val on = conv?.let { com.aichat.app.ui.settings.PluginToggles.convEnabled(it.extras, p.id) }
                        ?: (conv != null && deps.plugins.isActive(p.id, settings, conv))
                    androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(p.name, Modifier.weight(1f))
                        androidx.compose.material3.Switch(on, { controller.setConversationPlugin(p.id, it) }, enabled = conv != null)
                    }
                }
            } },
            confirmButton = { TextButton(onClick = { convPlugins = false }) { Text("完成") } })
    }

    if (picker) ModelPicker(settings.providers, target?.first?.id, target?.second,
        onPick = { p, m -> controller.setModel(p, m); picker = false },
        onManage = { picker = false; onOpenSettings(SettingsDestination.Providers) },
        onDismiss = { picker = false })
    viewing?.let { ImageViewer(it) { viewing = null } }
}
