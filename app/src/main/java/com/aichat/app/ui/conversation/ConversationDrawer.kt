package com.aichat.app.ui.conversation

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalDrawerSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.aichat.app.domain.model.ConversationMeta
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** 对话抽屉：列表（convs.json 顺序 = updatedAt 降序）、新建、重命名、删除 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ConversationDrawer(
    index: List<ConversationMeta>,
    currentId: String?,
    onSelect: (String) -> Unit,
    onNew: () -> Unit,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
    onOpenSettings: () -> Unit,
    onExport: ((String) -> Unit)? = null,
) {
    var renaming by remember { mutableStateOf<ConversationMeta?>(null) }
    var deleting by remember { mutableStateOf<ConversationMeta?>(null) }
    ModalDrawerSheet(Modifier.testTag("drawer")) {
        Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("对话", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = onNew, modifier = Modifier.testTag("drawer-new")) {
                Icon(Icons.Filled.Add, null); Text("新对话")
            }
        }
        HorizontalDivider()
        if (index.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text("还没有对话", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        } else {
            LazyColumn(Modifier.weight(1f)) {
                items(index, key = { it.id }) { m ->
                    ConvRow(m, m.id == currentId, onClick = { onSelect(m.id) }, onRename = { renaming = m }, onDelete = { deleting = m },
                        onExport = onExport?.let { f -> { f(m.id) } })
                }
            }
        }
        HorizontalDivider()
        TextButton(onClick = onOpenSettings, modifier = Modifier.padding(8.dp)) {
            Icon(Icons.Filled.Settings, null); Text("  设置")
        }
    }

    renaming?.let { m ->
        var t by rememberSaveable(m.id) { mutableStateOf(m.title) }
        AlertDialog(onDismissRequest = { renaming = null }, title = { Text("重命名对话") },
            text = { OutlinedTextField(t, { t = it }, singleLine = true, modifier = Modifier.testTag("rename-field")) },
            confirmButton = { TextButton(onClick = { onRename(m.id, t); renaming = null }, enabled = t.isNotBlank()) { Text("确定") } },
            dismissButton = { TextButton(onClick = { renaming = null }) { Text("取消") } })
    }
    deleting?.let { m ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("删除对话？") },
            text = { Text("将删除「${m.title}」，不可恢复。") },
            confirmButton = { TextButton(onClick = { onDelete(m.id); deleting = null }) { Text("删除", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } })
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConvRow(m: ConversationMeta, selected: Boolean, onClick: () -> Unit, onRename: () -> Unit, onDelete: () -> Unit, onExport: (() -> Unit)? = null) {
    var menu by remember { mutableStateOf(false) }
    Surface(
        color = if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent,
        shape = RoundedCornerShape(12.dp),
        modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)
            .combinedClickable(onClick = onClick, onLongClick = { menu = true }).testTag("conv-${m.id}"),
    ) {
        Row(Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text((m.personaEmoji?.let { "$it " } ?: "") + m.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyLarge)
                Text(listOf(m.model, formatTime(m.updatedAt)).filter { it.isNotEmpty() }.joinToString(" · "), maxLines = 1,
                    overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, "更多") }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem(text = { Text("重命名") }, onClick = { menu = false; onRename() })
                    if (onExport != null) DropdownMenuItem(text = { Text("导出") }, onClick = { menu = false; onExport() })
                    DropdownMenuItem(text = { Text("删除", color = MaterialTheme.colorScheme.error) }, onClick = { menu = false; onDelete() })
                }
            }
        }
    }
}

/** 今天显示 HH:mm，今年显示 M/d，否则 yyyy/M/d */
fun formatTime(ms: Long, nowMs: Long = System.currentTimeMillis()): String {
    if (ms <= 0) return ""
    val d = Date(ms); val n = Date(nowMs)
    val day = SimpleDateFormat("yyyyMMdd", Locale.ROOT)
    val year = SimpleDateFormat("yyyy", Locale.ROOT)
    return when {
        day.format(d) == day.format(n) -> SimpleDateFormat("HH:mm", Locale.ROOT).format(d)
        year.format(d) == year.format(n) -> SimpleDateFormat("M/d", Locale.ROOT).format(d)
        else -> SimpleDateFormat("yyyy/M/d", Locale.ROOT).format(d)
    }
}
