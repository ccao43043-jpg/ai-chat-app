package com.aichat.app.ui.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.aichat.app.domain.model.ProviderConfig

/** 服务商 / 模型快速切换（底部弹层；返回键关闭） */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelPicker(
    providers: List<ProviderConfig>,
    currentProvider: String?,
    currentModel: String?,
    onPick: (String, String) -> Unit,
    onManage: () -> Unit,
    onDismiss: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("model-picker")) {
        LazyColumn(Modifier.fillMaxWidth().navigationBarsPadding()) {
            providers.filter { p -> p.models.any { it.isNotBlank() } }.forEach { p ->
                item(key = "h-" + p.id) {
                    Text(p.name + if (p.hasKey) "" else "（未填 Key）", style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 20.dp, top = 12.dp, bottom = 4.dp))
                }
                items(p.models.filter { it.isNotBlank() }.distinct(), key = { p.id + "/" + it }) { m ->
                    val sel = p.id == currentProvider && m == currentModel
                    Text((if (sel) "✓ " else "    ") + m, fontWeight = if (sel) FontWeight.SemiBold else null,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.fillMaxWidth().clickable { onPick(p.id, m) }.padding(horizontal = 20.dp, vertical = 10.dp))
                }
            }
            item {
                TextButton(onClick = onManage, modifier = Modifier.padding(12.dp)) { Text("管理服务商…") }
            }
        }
    }
}
