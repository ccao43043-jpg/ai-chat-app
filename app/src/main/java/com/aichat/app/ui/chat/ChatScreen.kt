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
import com.aichat.app.ui.common.ImageViewer
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
            onOpenSettings = { scope.launch { drawer.close() }; onOpenSettings(SettingsDestination.Main) })
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
                        IconButton(onClick = { controller.newConversation() }, Modifier.testTag("new-conv")) { Icon(Icons.Filled.Add, "新对话") }
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "更多") }
                            DropdownMenu(menu, { menu = false }) {
                                DropdownMenuItem(text = { Text("设置") }, onClick = { menu = false; onOpenSettings(SettingsDestination.Main) })
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
                                val badges = if (conv != null && m.id != ChatUiState.STREAMING_ID) deps.plugins.messageBadges(m, settings, conv) else emptyList()
                                MessageItem(m, streaming = m.id == ChatUiState.STREAMING_ID, badges = badges,
                                    onToast = controller::toast, onImage = { viewing = it })
                            }
                        }
                    }
                }
                InputBar(input, { input = it }, st.draftImages, controller::setDraftImages, st.isStreaming,
                    onSend = { if (controller.send(input, st.draftImages)) { input = ""; controller.setDraftImages(emptyList()) } },
                    onStop = controller::stop, onToast = controller::toast, modifier = Modifier.imePadding())
            }
        }
    }

    if (picker) ModelPicker(settings.providers, target?.first?.id, target?.second,
        onPick = { p, m -> controller.setModel(p, m); picker = false },
        onManage = { picker = false; onOpenSettings(SettingsDestination.Providers) },
        onDismiss = { picker = false })
    viewing?.let { ImageViewer(it) { viewing = null } }
}
