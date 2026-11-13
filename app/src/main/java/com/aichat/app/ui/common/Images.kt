package com.aichat.app.ui.common

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** 消息图片：data URL 或 http(s) URL → Bitmap（带内存缓存）。不经过 net 层：这里只拉公开图片，不带任何认证头。 */
object ImageLoader {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }

    suspend fun load(src: String, maxDim: Int = 2048): Bitmap? = cache.get(src) ?: withContext(Dispatchers.IO) {
        runCatching {
            val bytes = if (src.startsWith("data:")) Base64.decode(src.substringAfter(","), Base64.DEFAULT)
            else (URL(src).openConnection() as HttpURLConnection).run {
                connectTimeout = 15000; readTimeout = 30000; instanceFollowRedirects = true
                try { inputStream.use { it.readBytes() } } finally { disconnect() }
            }
            decodeScaled(bytes, maxDim)
        }.getOrNull()?.also { cache.put(src, it) }
    }

    fun decodeScaled(bytes: ByteArray, maxDim: Int): Bitmap? {
        val o = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, o)
        var sample = 1
        while (o.outWidth / (sample * 2) >= maxDim || o.outHeight / (sample * 2) >= maxDim) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    /** 相册选图 → 压缩成 JPEG data URL（最长边 1600，与旧版附图体积相当） */
    suspend fun uriToDataUrl(ctx: Context, uri: Uri, maxDim: Int = 1600): String? = withContext(Dispatchers.IO) {
        runCatching {
            val bytes = ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }
            val bmp = decodeScaled(bytes, maxDim) ?: return@runCatching null
            val scale = minOf(1f, maxDim.toFloat() / maxOf(bmp.width, bmp.height))
            val out = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (bmp.width * scale).toInt(), (bmp.height * scale).toInt(), true) else bmp
            val bos = ByteArrayOutputStream()
            out.compress(Bitmap.CompressFormat.JPEG, 85, bos)
            "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
        }.getOrNull()
    }
}

@Composable
fun RemoteImage(src: String, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop, maxDim: Int = 1024) {
    val bmp: ImageBitmap? by produceState<ImageBitmap?>(null, src) { value = ImageLoader.load(src, maxDim)?.asImageBitmap() }
    Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        val b = bmp
        if (b != null) Image(b, contentDescription = null, contentScale = contentScale, modifier = Modifier.fillMaxSize())
        else Text("…", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** 全屏看图：双指缩放 / 拖动，点「关闭」或返回键退出 */
@Composable
fun ImageViewer(src: String, onDismiss: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by remember { mutableFloatStateOf(1f) }
        var offset by remember { mutableStateOf(Offset.Zero) }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            RemoteImage(src, Modifier.fillMaxSize().pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ ->
                    scale = (scale * zoom).coerceIn(1f, 6f)
                    offset = if (scale == 1f) Offset.Zero else offset + pan
                }
            }.graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y),
                contentScale = ContentScale.Fit, maxDim = 2048)
            TextButton(onClick = onDismiss, modifier = Modifier.align(Alignment.TopEnd).padding(16.dp)) { Text("关闭", color = Color.White) }
        }
    }
}
