package com.aichat.app.ui.chat

import com.aichat.app.domain.model.Message
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject

/**
 * 回复版本 / 对话分支（versions.js 的 Kotlin 移植，不可变实现）。
 * conv.messages 永远是「当前路径」。某条消息有多个版本时：versions = [快照|null…]，vi = 当前下标，versions[vi] = null；
 * 其他版本的快照 = 该版本的字段 + tail（该版本之后的消息分支，JSON 数组）。
 */
object Versions {
    fun count(m: Message) = if (m.versions.size > 1) m.versions.size else 1
    fun index(m: Message) = if (count(m) > 1) m.vi.coerceIn(0, m.versions.size - 1) else 0

    fun snapshot(m: Message) = JsonObject(MessageJson.fields(m))

    /** 把当前版本（含其后的消息）存回快照 */
    private fun stash(msgs: List<Message>, i: Int): Message {
        val m = msgs[i]
        val vs = if (m.versions.isEmpty()) listOf<JsonObject?>(null) else m.versions
        val vi = if (m.versions.isEmpty()) 0 else index(m)
        val snap = JsonObject(MessageJson.fields(m) + ("tail" to JsonArray(msgs.drop(i + 1).map(MessageJson::encode))))
        return m.copy(versions = vs.toMutableList().also { it[vi] = snap }, vi = vi)
    }

    /** 在第 i 条消息上新增一个版本（重新生成 / 编辑并重发）；返回新路径（到第 i 条为止） */
    fun addVersion(msgs: List<Message>, i: Int, init: JsonObject = JsonObject(emptyMap())): List<Message> {
        val s = stash(msgs, i)
        val vs = s.versions + null
        val m = MessageJson.withFields(s, init).copy(versions = vs, vi = vs.size - 1)
        return msgs.take(i) + m
    }

    /** 切换第 i 条消息到第 k 个版本，返回新路径 */
    fun select(msgs: List<Message>, i: Int, k: Int): List<Message> {
        val m0 = msgs[i]
        val n = count(m0)
        if (n < 2 || k < 0 || k >= n || k == index(m0)) return msgs
        val s = stash(msgs, i)
        val target = s.versions[k] ?: JsonObject(emptyMap())
        val m = MessageJson.withFields(s, target).copy(versions = s.versions.toMutableList().also { it[k] = null }, vi = k)
        val tail = (target["tail"] as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(MessageJson::decode) }.orEmpty()
        return msgs.take(i) + m + tail
    }

    /** 当前版本之外的某个版本之后有多少条消息 */
    fun tailLength(msgs: List<Message>, i: Int, k: Int): Int {
        val m = msgs[i]
        if (k == index(m)) return msgs.size - i - 1
        return (m.versions.getOrNull(k)?.get("tail") as? JsonArray)?.size ?: 0
    }

    /** 用空快照替换当前版本字段（失败/空回复原位重试用，= applySnap(m, {})） */
    fun clearFields(m: Message) = MessageJson.withFields(m, JsonObject(emptyMap()))
}
