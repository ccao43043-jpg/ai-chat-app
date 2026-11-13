package com.aichat.app.ui.common

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

data class EditorAction(val key: String, val text: String, val primary: Boolean = false)

/**
 * 全屏编辑器（app.js openEditor）：标题、提示、可选警示、动作按钮。返回键 / 取消：有改动时先确认。
 * onResult(key, text)；取消时不回调。
 */
@Composable
fun FullScreenEditor(
    title: String,
    initial: String,
    actions: List<EditorAction>,
    onResult: (String, String) -> Unit,
    onDismiss: () -> Unit,
    hint: String? = null,
    warn: Boolean = false,
    placeholder: String = "",
) {
    var text by rememberSaveable { mutableStateOf(initial) }
    var confirm by rememberSaveable { mutableStateOf(false) }
    val cancel = { if (text != initial) confirm = true else onDismiss() }
    Dialog(onDismissRequest = cancel, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.fillMaxWidth()) {
                    TextButton(onClick = cancel) { Text("取消") }
                    Text(title, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f).padding(top = 10.dp))
                }
                if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall,
                    color = if (warn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(text, { text = it }, modifier = Modifier.fillMaxWidth().weight(1f).testTag("editor-field"),
                    placeholder = { Text(placeholder) })
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, androidx.compose.ui.Alignment.End)) {
                    actions.forEach { a ->
                        if (a.primary) Button(onClick = { onResult(a.key, text) }, Modifier.testTag("editor-${a.key}")) { Text(a.text) }
                        else OutlinedButton(onClick = { onResult(a.key, text) }, Modifier.testTag("editor-${a.key}")) { Text(a.text) }
                    }
                }
            }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text("放弃修改？") },
        confirmButton = { TextButton(onClick = { confirm = false; onDismiss() }) { Text("放弃") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("继续编辑") } })
}

/** 通用确认框 */
@Composable
fun ConfirmDialog(title: String, body: String?, okText: String, onOk: () -> Unit, onDismiss: () -> Unit, danger: Boolean = false) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text(title) }, text = body?.let { { Text(it) } },
        confirmButton = { TextButton(onClick = { onDismiss(); onOk() }) { Text(okText, color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } })
}
