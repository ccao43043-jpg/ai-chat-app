package com.aichat.app.ui.chat

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aichat.app.data.files.FileText
import com.aichat.app.domain.Badge
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull
import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.Role
import com.aichat.app.ui.common.MarkdownText
import com.aichat.app.ui.common.RemoteImage

/** 单条消息的操作回调（全部可空：为 null 时不显示对应按钮） */
data class MessageActions(
    val onEdit: (() -> Unit)? = null,
    val onRegenerate: (() -> Unit)? = null,
    val onContinue: (() -> Unit)? = null,
    val onVersion: ((Int) -> Unit)? = null,
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun MessageItem(
    m: Message,
    streaming: Boolean,
    badges: List<Badge>,
    onToast: (String) -> Unit,
    onImage: (String) -> Unit,
    actions: MessageActions = MessageActions(),
    /** 有生成在进行（任一条）或插件冻结（messageState.dim）时禁用编辑 / 重新生成 / 切版本 */
    locked: Boolean = false,
    stateLabel: String? = null,
) {
    val clip = LocalClipboardManager.current
    val copy = { clip.setText(AnnotatedString(m.content)); onToast("已复制") }
    if (m.role == Role.USER) {
        Column(Modifier.fillMaxWidth().padding(start = 48.dp).alpha(if (stateLabel != null) 0.7f else 1f), horizontalAlignment = Alignment.End) {
            Images(m.images, onImage)
            FileChips(m.files)
            if (m.content.isNotEmpty()) Surface(
                color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(16.dp),
                modifier = Modifier.clip(RoundedCornerShape(16.dp)).combinedClickable(onClick = {}, onLongClick = copy).testTag("msg-user"),
            ) {
                Text(m.content, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp))
            }
            ActionRow(m, streaming = false, locked, stateLabel, copy, actions)
        }
        return
    }
    Column(Modifier.fillMaxWidth().alpha(if (stateLabel != null) 0.7f else 1f).testTag(if (streaming) "msg-streaming" else "msg-assistant"),
        verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (!m.reasoning.isNullOrEmpty()) Reasoning(m.reasoning, streaming && m.content.isEmpty())
        Images(m.images, onImage)
        if (m.content.isNotEmpty()) SelectionContainer { MarkdownText(m.content, onCopy = onToast) }
        else if (streaming && m.error == null) Row(verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text("  正在生成…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        m.error?.let { Text("⚠ $it", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
        if (!streaming) {
            ActionRow(m, streaming = false, locked, stateLabel, copy, actions)
            val info = listOfNotNull(if (m.truncated) "已中断" else null, m.usage?.let { u ->
                listOfNotNull(u.prompt?.let { "入 $it" }, u.completion?.let { "出 $it" }, u.hit?.takeIf { it > 0 }?.let { "命中 $it" })
                    .takeIf { it.isNotEmpty() }?.joinToString(" · ")
            })
            if (info.isNotEmpty()) Text(info.joinToString("  "), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
        }
        if (badges.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            badges.forEach { b -> AssistChip(onClick = { b.detail?.let(onToast) }, label = { Text(b.text, fontSize = 11.sp) }) }
        }
    }
}

/** 复制 / 编辑 / 重新生成 / 续写 + 版本切换 ‹ n/m › */
@Composable
private fun ActionRow(m: Message, streaming: Boolean, locked: Boolean, stateLabel: String?, copy: () -> Unit, a: MessageActions) {
    if (streaming) return
    val n = Versions.count(m); val k = Versions.index(m)
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("actions-${m.role.name.lowercase()}")) {
        if (n > 1 && a.onVersion != null) {
            TextButton(onClick = { a.onVersion.invoke(k - 1) }, enabled = !locked && k > 0, contentPadding = SmallPad,
                modifier = Modifier.testTag("ver-prev")) { Text("‹", fontSize = 16.sp) }
            Text("${k + 1}/$n", style = MaterialTheme.typography.labelMedium, modifier = Modifier.testTag("ver-label"))
            TextButton(onClick = { a.onVersion.invoke(k + 1) }, enabled = !locked && k < n - 1, contentPadding = SmallPad,
                modifier = Modifier.testTag("ver-next")) { Text("›", fontSize = 16.sp) }
        }
        if (m.content.isNotEmpty()) Act("复制", "copy", true, copy)
        a.onEdit?.let { Act("编辑", "edit", !locked, it) }
        a.onRegenerate?.let { Act("重新生成", "regen", !locked, it) }
        a.onContinue?.let { Act("续写", "continue", !locked, it) }
        stateLabel?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

private val SmallPad = PaddingValues(horizontal = 6.dp, vertical = 0.dp)

@Composable
private fun Act(label: String, tag: String, enabled: Boolean, onClick: () -> Unit) =
    TextButton(onClick = onClick, enabled = enabled, contentPadding = SmallPad, modifier = Modifier.testTag(tag)) { Text(label, fontSize = 12.sp) }

/** 附件文件卡片：名称 · 大小 · 类型（扫描版 PDF 标注） */
@Composable
fun FileChips(files: List<JsonObject>, onRemove: ((Int) -> Unit)? = null) {
    if (files.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(bottom = 4.dp)) {
        files.forEachIndexed { i, f ->
            val name = (f["name"] as? JsonPrimitive)?.content ?: "文件"
            val size = (f["size"] as? JsonPrimitive)?.longOrNull
            val kind = (f["kind"] as? JsonPrimitive)?.content.orEmpty()
            val scanned = (f["scanned"] as? JsonPrimitive)?.booleanOrNull == true
            val trunc = (f["truncated"] as? JsonPrimitive)?.booleanOrNull == true
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(10.dp), modifier = Modifier.testTag("file-chip")) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 10.dp, end = if (onRemove != null) 0.dp else 10.dp, top = 6.dp, bottom = 6.dp)) {
                    Column(Modifier.widthIn(max = 240.dp)) {
                        Text("📄 $name", style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(listOfNotNull(size?.let { FileText.formatSize(it) }, kind.uppercase().ifEmpty { null },
                            if (scanned) "扫描件·按图片发送" else null, if (trunc) "已截断" else null).joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (onRemove != null) TextButton(onClick = { onRemove(i) }, contentPadding = SmallPad) { Text("✕") }
                }
            }
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
