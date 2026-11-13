package com.aichat.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AssistChip
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aichat.app.domain.Badge
import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.Role
import com.aichat.app.ui.common.MarkdownText
import com.aichat.app.ui.common.RemoteImage

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageItem(
    m: Message,
    streaming: Boolean,
    badges: List<Badge>,
    onToast: (String) -> Unit,
    onImage: (String) -> Unit,
) {
    val clip = LocalClipboardManager.current
    val copy = { clip.setText(AnnotatedString(m.content)); onToast("已复制") }
    if (m.role == Role.USER) {
        Column(Modifier.fillMaxWidth().padding(start = 48.dp), horizontalAlignment = Alignment.End) {
            Images(m.images, onImage)
            if (m.content.isNotEmpty()) Surface(
                color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(16.dp),
                modifier = Modifier.clip(RoundedCornerShape(16.dp)).combinedClickable(onClick = {}, onLongClick = copy).testTag("msg-user"),
            ) {
                Text(m.content, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
        }
        return
    }
    Column(Modifier.fillMaxWidth().testTag(if (streaming) "msg-streaming" else "msg-assistant"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!m.reasoning.isNullOrEmpty()) Reasoning(m.reasoning, streaming && m.content.isEmpty())
        Images(m.images, onImage)
        if (m.content.isNotEmpty()) SelectionContainer { MarkdownText(m.content, onCopy = onToast) }
        else if (streaming && m.error == null) Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text("  正在生成…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        m.error?.let { Text("⚠ $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        if (!streaming) Row(verticalAlignment = Alignment.CenterVertically) {
            if (m.content.isNotEmpty()) TextButton(onClick = copy, modifier = Modifier.testTag("copy")) { Text("复制", fontSize = 12.sp) }
            if (m.truncated) Text("已中断", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            m.usage?.let { u ->
                val parts = listOfNotNull(u.prompt?.let { "入 $it" }, u.completion?.let { "出 $it" }, u.hit?.takeIf { it > 0 }?.let { "命中 $it" })
                if (parts.isNotEmpty()) Text("  " + parts.joinToString(" · "), style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (badges.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            badges.forEach { b -> AssistChip(onClick = { b.detail?.let(onToast) }, label = { Text(b.text, fontSize = 11.sp) }) }
        }
    }
}

@Composable
private fun Reasoning(text: String, live: Boolean) {
    var open by rememberSaveable { mutableStateOf(false) }
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.clickable { open = !open }.padding(10.dp)) {
            Text((if (live) "思考中…" else "思考过程") + if (open) " ▲" else " ▼", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            AnimatedVisibility(open || live) {
                Text(if (live && !open) text.takeLast(200) else text, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

@Composable
private fun Images(images: List<String>, onImage: (String) -> Unit) {
    if (images.isEmpty()) return
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 4.dp)) {
        images.take(4).forEach { src ->
            RemoteImage(src, Modifier.size(96.dp).clip(RoundedCornerShape(8.dp)).clickable { onImage(src) }.widthIn(max = 96.dp))
        }
        if (images.size > 4) Text("+${images.size - 4}", modifier = Modifier.align(Alignment.CenterVertically))
    }
}
