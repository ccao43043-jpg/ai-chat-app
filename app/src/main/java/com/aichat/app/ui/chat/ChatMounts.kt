package com.aichat.app.ui.chat

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aichat.app.domain.model.AppSettings
import com.aichat.app.domain.model.Conversation

/**
 * 聊天页挂载点（给 B / C）：
 *  - [usage]：顶栏费用 / 用量浮层（B 的 ui/usage 注册；参数 = 当前对话、设置）。未注册时用 [DefaultUsageChip]（只汇总本对话 token）。
 *  - [headerExtras]：顶栏下方一行（C 的 RP 状态条 / headerBadges 等）。
 */
object ChatMounts {
    var usage: (@Composable (Conversation?, AppSettings) -> Unit)? = null
    var headerExtras: (@Composable (Conversation?, AppSettings) -> Unit)? = null
}

@Composable
fun DefaultUsageChip(conv: Conversation?, settings: AppSettings) {
    if (conv == null || !settings.showTopCost) return
    val us = conv.messages.mapNotNull { it.usage }
    if (us.isEmpty()) return
    val inT = us.sumOf { it.prompt ?: 0 }; val outT = us.sumOf { it.completion ?: 0 }; val hit = us.sumOf { it.hit ?: 0 }
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, modifier = Modifier.testTag("usage-chip")) { Text(compact(inT + outT), fontSize = 12.sp) }
        DropdownMenu(open, { open = false }) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text("本对话用量", style = MaterialTheme.typography.labelLarge)
                Text("输入 $inT · 输出 $outT", style = MaterialTheme.typography.bodySmall)
                if (hit > 0) Text("缓存命中 $hit（${hit * 100 / maxOf(1, inT)}%）", style = MaterialTheme.typography.bodySmall)
                Text("费用与详细统计待用量模块接入", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

private fun compact(n: Long) = when { n >= 1_000_000 -> String.format("%.1fM", n / 1e6); n >= 1000 -> String.format("%.1fk", n / 1e3); else -> "$n" }
