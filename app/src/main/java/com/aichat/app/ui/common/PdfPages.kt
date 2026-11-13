package com.aichat.app.ui.common

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File

/** 扫描版 PDF：用系统 PdfRenderer（API 21+，无需第三方库）把前几页渲染成 JPEG data URL，作为图片发给模型（同旧版 imagePages） */
object PdfPages {
    suspend fun render(ctx: Context, bytes: ByteArray, maxPages: Int = 6, maxDim: Int = 1600): List<String> = withContext(Dispatchers.IO) {
        val f = File.createTempFile("scan", ".pdf", ctx.cacheDir)
        try {
            f.writeBytes(bytes)
            ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY).use { pfd ->
                PdfRenderer(pfd).use { r ->
                    (0 until minOf(maxPages, r.pageCount)).map { i ->
                        r.openPage(i).use { page ->
                            val scale = maxDim.toFloat() / maxOf(page.width, page.height)
                            val bmp = Bitmap.createBitmap((page.width * scale).toInt().coerceAtLeast(1), (page.height * scale).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)
                            bmp.eraseColor(Color.WHITE)
                            page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            val bos = ByteArrayOutputStream(); bmp.compress(Bitmap.CompressFormat.JPEG, 80, bos); bmp.recycle()
                            "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
                        }
                    }
                }
            }
        } finally { f.delete() }
    }
}
