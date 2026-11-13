package com.aichat.app.net

/**
 * 增量 SSE 行解析：喂任意切分的文本块，产出完整 event 的 data 串（多行 data 以 \n 连接）。
 * 与 providers.js createStreamParser 的分行规则一致：\r\n / \n 均可，空行结束事件，':' 开头为注释，"[DONE]" 原样交给上层。
 */
class SseLineParser {
    private val buf = StringBuilder()
    private val data = StringBuilder()
    private var hasData = false

    fun feed(chunk: String): List<String> {
        buf.append(chunk)
        val out = mutableListOf<String>()
        while (true) {
            val i = buf.indexOf("\n"); if (i < 0) break
            var line = buf.substring(0, i); buf.delete(0, i + 1)
            if (line.endsWith("\r")) line = line.dropLast(1)
            when {
                line.isEmpty() -> { if (hasData) out += data.toString(); data.setLength(0); hasData = false }
                line.startsWith(":") -> {}
                line.startsWith("data:") -> { if (hasData) data.append('\n'); data.append(line.removePrefix("data:").removePrefix(" ")); hasData = true }
                else -> {}
            }
        }
        return out
    }

    fun finish(): List<String> = feed("\n\n")
}
