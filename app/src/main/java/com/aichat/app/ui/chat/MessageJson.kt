package com.aichat.app.ui.chat

import com.aichat.app.data.codec.MessageCodec
import com.aichat.app.domain.model.Message
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * Message ⇄ 旧版消息 JSON（版本快照 / 分支 tail 用；versions.js 里快照本来就是原始 JSON）。
 * 编解码委托给 D 的 [MessageCodec]（与落盘格式逐字一致，usage 的 cost_details 等未建模字段走 raw/extras 无损）。
 */
object MessageJson {
    private val NOT_SNAPSHOT = setOf("id", "role", "versions", "vi")

    fun encode(m: Message): JsonObject = MessageCodec.encode(m)

    /** 版本相关字段（不含 id/role/versions/vi），即 versions.js snapshot() */
    fun fields(m: Message): Map<String, JsonElement> = MessageCodec.encode(m.copy(versions = emptyList(), vi = 0)).filterKeys { it !in NOT_SNAPSHOT }

    fun decode(o: JsonObject): Message = MessageCodec.decode(o)

    /** 用快照字段替换消息的版本字段（id/role/versions/vi 不动）= versions.js applySnap() */
    fun withFields(base: Message, o: JsonObject): Message {
        val src = o.filterKeys { it !in NOT_SNAPSHOT && it != "tail" } + mapOf("id" to JsonPrimitive(base.id), "role" to JsonPrimitive(base.role.wire))
        return MessageCodec.decode(JsonObject(src)).copy(versions = base.versions, vi = base.vi)
    }
}
