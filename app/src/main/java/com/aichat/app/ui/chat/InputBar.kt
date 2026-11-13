package com.aichat.app.ui.chat

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.aichat.app.ui.common.ImageLoader
import com.aichat.app.ui.common.RemoteImage
import kotlinx.coroutines.launch

/** 输入区：多行文字 + 附图（相册多选，压成 JPEG data URL）+ 发送 / 停止 */
@Composable
fun InputBar(
    text: String,
    onText: (String) -> Unit,
    images: List<String>,
    onImages: (List<String>) -> Unit,
    streaming: Boolean,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onToast: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(8)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val urls = uris.mapNotNull { ImageLoader.uriToDataUrl(ctx, it) }
            if (urls.size < uris.size) onToast("有 ${uris.size - urls.size} 张图片读取失败")
            onImages((images + urls).take(8))
        }
    }
    Surface(tonalElevation = 2.dp, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            if (images.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()).padding(bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                images.forEachIndexed { i, src ->
                    Box {
                        RemoteImage(src, Modifier.size(64.dp).clip(RoundedCornerShape(8.dp)))
                        Box(Modifier.align(Alignment.TopEnd).size(20.dp).clip(CircleShape)
                            .clickable { onImages(images.filterIndexed { j, _ -> j != i }) }) {
                            Surface(color = MaterialTheme.colorScheme.inverseSurface, shape = CircleShape) {
                                Icon(Icons.Filled.Close, "移除图片", tint = MaterialTheme.colorScheme.inverseOnSurface, modifier = Modifier.size(20.dp).padding(3.dp))
                            }
                        }
                    }
                }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                IconButton(onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                    modifier = Modifier.testTag("attach")) { Icon(Icons.Filled.Add, "添加图片") }
                OutlinedTextField(text, onText, modifier = Modifier.weight(1f).testTag("input"), placeholder = { Text("给 AI 发消息…") },
                    maxLines = 6, shape = RoundedCornerShape(20.dp))
                if (streaming) FilledIconButton(onClick = onStop, modifier = Modifier.padding(start = 4.dp).testTag("stop"),
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.error)) {
                    Icon(Icons.Filled.Close, "停止")
                } else FilledIconButton(onClick = onSend, enabled = text.isNotBlank() || images.isNotEmpty(),
                    modifier = Modifier.padding(start = 4.dp).testTag("send")) {
                    Icon(Icons.AutoMirrored.Filled.Send, "发送")
                }
            }
        }
    }
}
