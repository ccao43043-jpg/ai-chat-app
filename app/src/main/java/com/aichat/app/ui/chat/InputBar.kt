package com.aichat.app.ui.chat

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
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
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.aichat.app.data.files.FileText
import com.aichat.app.ui.common.ImageLoader
import com.aichat.app.ui.common.PdfPages
import com.aichat.app.ui.common.RemoteImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** 输入框上方工具条（提示词库 / 模板 / 联网搜索）的回调；null 表示不显示 */
data class InputTools(
    val onPrompts: (() -> Unit)? = null,
    val onTemplates: (() -> Unit)? = null,
    val templateLabel: String? = null,
    val searchOn: Boolean = false,
    val onSearch: ((Boolean) -> Unit)? = null,
)

/** 输入区：多行文字 + 附件（相册图片 / 文件：PDF、Office、文本）+ 发送 / 停止 */
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
    files: List<JsonObject> = emptyList(),
    onFiles: (List<JsonObject>) -> Unit = {},
    tools: InputTools = InputTools(),
) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var attachMenu by remember { mutableStateOf(false) }
    var reading by remember { mutableStateOf(0) }
    // 回调里读最新值（launcher 回调在组合之外触发）
    val cur = remember { object { var images = images; var files = files } }
    cur.images = images; cur.files = files

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(MAX_IMAGES)) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val urls = uris.mapNotNull { ImageLoader.uriToDataUrl(ctx, it) }
            if (urls.size < uris.size) onToast("有 ${uris.size - urls.size} 张图片读取失败")
            onImages((cur.images + urls).take(MAX_IMAGES))
        }
    }
    val docPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            reading += uris.size
            for (u in uris) {
                try {
                    val r = readAttachment(ctx, u)
                    if (r.images.isNotEmpty()) onImages((cur.images + r.images).take(MAX_IMAGES))
                    r.file?.let { onFiles(cur.files + it) }
                    r.notice?.let(onToast)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    // 含 OutOfMemoryError / StackOverflowError（超大或畸形文件）：只提示，不崩溃
                    onToast("「${displayName(ctx, u) ?: "文件"}」读取失败：${if (e is OutOfMemoryError) "文件太大" else e.message ?: "未知错误"}")
                } finally { reading -= 1 }
            }
        }
    }
    Surface(tonalElevation = 2.dp, modifier = modifier.fillMaxWidth()) {
        Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
            if (tools.onPrompts != null || tools.onTemplates != null || tools.onSearch != null)
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    tools.onSearch?.let { f -> FilterChip(tools.searchOn, { f(!tools.searchOn) }, label = { Text("🌐 联网搜索", fontSize = 12.sp) },
                        modifier = Modifier.testTag("search-toggle")) }
                    tools.onPrompts?.let { FilterChip(false, it, label = { Text("⚡ 提示词", fontSize = 12.sp) }, modifier = Modifier.testTag("prompts-open")) }
                    tools.onTemplates?.let { FilterChip(tools.templateLabel != null, it, label = { Text(tools.templateLabel ?: "📋 模板", fontSize = 12.sp) },
                        modifier = Modifier.testTag("templates-open")) }
                }
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
            FileChips(files, onRemove = { i -> onFiles(files.filterIndexed { j, _ -> j != i }) })
            if (reading > 0) Text("正在读取文件…", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.Bottom) {
                Box {
                    IconButton(onClick = { attachMenu = true }, modifier = Modifier.testTag("attach")) { Icon(Icons.Filled.Add, "添加附件") }
                    DropdownMenu(attachMenu, { attachMenu = false }) {
                        DropdownMenuItem(text = { Text("从相册选择") }, modifier = Modifier.testTag("attach-image"), onClick = {
                            attachMenu = false; picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) })
                        DropdownMenuItem(text = { Text("选择文件（PDF / Word / PPT / Excel / 文本）") }, modifier = Modifier.testTag("attach-file"), onClick = {
                            attachMenu = false; docPicker.launch(arrayOf("*/*")) })
                    }
                }
                OutlinedTextField(text, onText, modifier = Modifier.weight(1f).testTag("input"), placeholder = { Text("给 AI 发消息…") },
                    maxLines = 6, shape = RoundedCornerShape(20.dp))
                if (streaming) FilledIconButton(onClick = onStop, modifier = Modifier.padding(start = 4.dp).testTag("stop"),
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = MaterialTheme.colorScheme.error)) {
                    Icon(Icons.Filled.Close, "停止")
                } else FilledIconButton(onClick = onSend, enabled = reading == 0 && (text.isNotBlank() || images.isNotEmpty() || files.isNotEmpty()),
                    modifier = Modifier.padding(start = 4.dp).testTag("send")) {
                    Icon(Icons.AutoMirrored.Filled.Send, "发送")
                }
            }
        }
    }
}

private const val MAX_IMAGES = 8
private const val MAX_FILE_BYTES = 40L * 1024 * 1024   // 同 app.js MAX_FILE_BYTES
private const val SCAN_PAGES = 4                        // 同 app.js renderPdfPages(min(pages, 4))

private class Attachment(val file: JsonObject?, val images: List<String>, val notice: String?)

private fun displayName(ctx: Context, u: Uri): String? = runCatching {
    ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
}.getOrNull() ?: u.lastPathSegment

private suspend fun readAttachment(ctx: Context, u: Uri): Attachment {
    val name = displayName(ctx, u) ?: "文件"
    val mime = ctx.contentResolver.getType(u)
    if (FileText.classifyFile(name, mime) == "image") {
        val url = ImageLoader.uriToDataUrl(ctx, u) ?: throw IllegalStateException("图片读取失败")
        return Attachment(null, listOf(url), null)
    }
    val bytes = withContext(Dispatchers.IO) {
        ctx.contentResolver.openInputStream(u)!!.use { ins ->
            val out = java.io.ByteArrayOutputStream(); val buf = ByteArray(64 * 1024); var total = 0L
            while (true) { val n = ins.read(buf); if (n < 0) break; total += n
                if (total > MAX_FILE_BYTES) throw IllegalArgumentException("文件超过 40 MB，无法读取"); out.write(buf, 0, n) }
            out.toByteArray()
        }
    }
    val ex = withContext(Dispatchers.Default) { FileText.extract(bytes, name, mime) }
    if (ex.scanned) {
        val imgs = runCatching { PdfPages.render(ctx, bytes, minOf(ex.pages ?: SCAN_PAGES, SCAN_PAGES)) }.getOrDefault(emptyList())
        val json = JsonObject(FileText.toFileJson(name, bytes.size.toLong(), ex) + ("imagePages" to JsonPrimitive(imgs.size)))
        return Attachment(json, imgs, if (imgs.isNotEmpty()) "「$name」是扫描版 PDF，已把前 ${imgs.size} 页转成图片附上，需要支持图片识别的模型"
            else "「$name」是扫描版 PDF，没有可提取的文字，请先用 OCR 转成文字版")
    }
    if (ex.text.isBlank()) throw IllegalArgumentException("没有提取到文字")
    val json = FileText.toFileJson(name, bytes.size.toLong(), ex)
    val trunc = (json["truncated"] as? JsonPrimitive)?.content == "true"
    return Attachment(json, emptyList(), if (trunc) "「$name」较长，只发送前 ${FileText.DEFAULT_FILE_MAX} 字" else null)
}
