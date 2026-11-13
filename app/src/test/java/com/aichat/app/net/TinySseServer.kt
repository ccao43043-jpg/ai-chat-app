package com.aichat.app.net

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * 测试用最小 HTTP/1.1 服务器（build.gradle 归 D，未引入 mockwebserver；这里用 ServerSocket 手写，
 * 好处是可以按任意字节边界分片、可以挂起、可以观察到客户端断开）。
 */
class TinySseServer : AutoCloseable {
    data class Recorded(val method: String, val path: String, val headers: Map<String, String>, val body: String)
    fun interface Handler { fun handle(req: Recorded, out: Exchange) }
    class Exchange(private val os: OutputStream) {
        fun head(status: Int, contentType: String = "text/event-stream", extra: Map<String, String> = emptyMap()) {
            val sb = StringBuilder("HTTP/1.1 $status X\r\nContent-Type: $contentType\r\nConnection: close\r\n")
            extra.forEach { (k, v) -> sb.append(k).append(": ").append(v).append("\r\n") }
            os.write(sb.append("\r\n").toString().toByteArray()); os.flush()
        }
        fun raw(bytes: ByteArray) { os.write(bytes); os.flush() }
        fun text(s: String) = raw(s.toByteArray(Charsets.UTF_8))
    }

    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    val baseUrl = "http://127.0.0.1:${server.localPort}"
    val requests = LinkedBlockingQueue<Recorded>()
    val handlers = LinkedBlockingQueue<Handler>()
    val clientClosed = CountDownLatch(1)
    private val sockets = CopyOnWriteArrayList<Socket>()

    init {
        thread(isDaemon = true) {
            while (!server.isClosed) {
                val s = try { server.accept() } catch (e: Exception) { break }
                sockets += s
                thread(isDaemon = true) { serve(s) }
            }
        }
    }

    private fun serve(s: Socket) {
        try {
            val ins = BufferedInputStream(s.getInputStream())
            val head = ByteArrayOutputStream()
            var last4 = 0
            while (true) {
                val b = ins.read(); if (b < 0) return
                head.write(b); last4 = (last4 shl 8) or b
                if (last4 == 0x0d0a0d0a) break
            }
            val lines = head.toString(Charsets.UTF_8.name()).split("\r\n").filter { it.isNotEmpty() }
            val (method, path) = lines[0].split(" ").let { it[0] to it[1] }
            val headers = lines.drop(1).associate { l -> l.substringBefore(":").trim().lowercase() to l.substringAfter(":").trim() }
            val len = headers["content-length"]?.toInt() ?: 0
            val body = ByteArray(len); var off = 0
            while (off < len) { val n = ins.read(body, off, len - off); if (n < 0) break; off += n }
            val rec = Recorded(method, path, headers, String(body, Charsets.UTF_8))
            requests += rec
            val h = handlers.poll(5, TimeUnit.SECONDS) ?: Handler { _, ex -> ex.head(500, "text/plain"); ex.text("no handler") }
            h.handle(rec, Exchange(s.getOutputStream()))
        } catch (e: Exception) {
            clientClosed.countDown()
        } finally {
            try { s.close() } catch (_: Exception) {}
        }
    }

    override fun close() { server.close(); sockets.forEach { try { it.close() } catch (_: Exception) {} } }
}
