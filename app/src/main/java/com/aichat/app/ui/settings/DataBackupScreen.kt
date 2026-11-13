package com.aichat.app.ui.settings

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.aichat.app.ui.common.LocalUiDeps
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 设置 →「数据与备份」：整库 zip 导出 / 导入（D 的 MigrationService，走 SAF），以及旧版同格式的全部对话 JSON 导出。
 */
@Composable
fun DataBackupScreen(onBack: () -> Unit, toast: (String) -> Unit) {
    val deps = LocalUiDeps.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var pendingImport by remember { mutableStateOf<android.net.Uri?>(null) }
    val stamp = { SimpleDateFormat("yyyyMMdd-HHmm", Locale.ROOT).format(Date()) }
    val mig = deps.migration

    val exportZip = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/zip")) { uri ->
        if (uri == null || mig == null) return@rememberLauncherForActivityResult
        busy = true
        scope.launch {
            mig.exportBackup(uri).fold({ toast("已导出整库备份（${it / 1024} KB）") }, { toast("导出失败：${it.message}") })
            busy = false
        }
    }
    val importZip = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> if (uri != null) pendingImport = uri }
    val exportJson = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        busy = true
        scope.launch {
            val r = runCatching {
                val json = deps.chats.exportAllJson()
                withContext(Dispatchers.IO) { ctx.contentResolver.openOutputStream(uri)!!.use { it.write(json.toByteArray()) } }
            }
            toast(if (r.isSuccess) "已导出全部对话" else "导出失败：${r.exceptionOrNull()?.message}")
            busy = false
        }
    }

    SettingsPageScaffold("数据与备份", onBack) {
        Text("升级须知：原生版 v1 装上后不能再覆盖安装 0.x 旧版。想回退，只能先在这里导出整库 zip → 卸载 → 装旧版 → 导入。备份不含 API Key。",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(20.dp))
        SettingsRow("导出整库备份（zip）", if (mig == null) "数据层未接入" else "对话、设置、世界、知识库、用量；不含 Key", "backup-export") {
            if (!busy && mig != null) exportZip.launch("aichat-backup-${stamp()}.zip") else if (mig == null) toast("数据层尚未接入")
        }
        SettingsRow("从备份恢复（zip）", "恢复前会先自动备份当前数据", "backup-import") {
            if (!busy && mig != null) importZip.launch(arrayOf("application/zip", "application/octet-stream")) else if (mig == null) toast("数据层尚未接入")
        }
        SettingsRow("导出全部对话（JSON）", "与旧版「导出全部对话」同格式", "export-all-json") {
            if (!busy) exportJson.launch("aichat-conversations-${stamp()}.json")
        }
        if (busy) Text("处理中…", modifier = Modifier.padding(20.dp))
    }

    pendingImport?.let { uri ->
        AlertDialog(onDismissRequest = { pendingImport = null }, title = { Text("从备份恢复？") },
            text = { Text("将用备份内容替换当前全部数据（恢复前会自动备份当前数据）。API Key 不在备份里，保持不变。") },
            confirmButton = { TextButton(onClick = {
                pendingImport = null; busy = true
                scope.launch {
                    mig!!.importBackup(uri).fold({ toast("已恢复 $it 个文件，重启应用后生效") }, { toast("恢复失败：${it.message}") })
                    busy = false
                }
            }) { Text("恢复", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { pendingImport = null }) { Text("取消") } })
    }
}
