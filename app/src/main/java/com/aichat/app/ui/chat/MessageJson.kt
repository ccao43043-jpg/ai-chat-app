package com.aichat.app.ui.chat

import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.Role
import com.aichat.app.domain.model.Usage
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Message ⇄ 旧版消息 JSON（只用于「版本快照 / 分支 tail」——versions.js 里快照本来就是原始 JSON）。
 * 未建模的键走 extras 原样往返。TODO(D)：D 的 data/codec 暴露 MessageCodec 后改用它（保证与落盘格式完全一致）。
 */
object MessageJson {
    private val MODELED = setOf("id", "role", "content", "createdAt", "images", "files", "reasoning", "usage", "error", "truncated",
        "finishReason", "routeSlug", "versions", "vi")

    fun encode(m: Message): JsonObject = JsonObject(fields(m) + buildMap {
        put("id", JsonPrimitive(m.id)); put("role", JsonPrimitive(m.role.wire))
        if (m.versions.isNotEmpty()) { put("versions", JsonArray(m.versions.map { it ?: JsonNull })); put("vi", JsonPrimitive(m.vi)) }
    })

    /** 版本相关字段（不含 id/role/versions/vi），即 versions.js snapshot() */
    fun fields(m: Message): Map<String, JsonElement> = buildMap {
        put("content", JsonPrimitive(m.content))
        if (m.createdAt > 0) put("createdAt", JsonPrimitive(m.createdAt))
        if (m.images.isNotEmpty()) put("images", JsonArray(m.images.map { JsonPrimitive(it) }))
        if (m.files.isNotEmpty()) put("files", JsonArray(m.files))
        m.reasoning?.let { put("reasoning", JsonPrimitive(it)) }
        m.usage?.let { put("usage", encodeUsage(it)) }
        m.error?.let { put("error", JsonPrimitive(it)) }
        if (m.truncated) put("truncated", JsonPrimitive(true))
        m.finishReason?.let { put("finishReason", JsonPrimitive(it)) }
        m.routeSlug?.let { put("routeSlug", JsonPrimitive(it)) }
        m.extras.forEach { (k, v) -> if (k !in MODELED) put(k, v) }
    }

    fun decode(o: JsonObject): Message = withFields(Message(id = str(o["id"]) ?: "", role = Role.of(str(o["role"])), content = ""), o).copy(
        versions = (o["versions"] as? JsonArray)?.map { it as? JsonObject } ?: emptyList(),
        vi = (o["vi"] as? JsonPrimitive)?.intOrNull ?: 0,
    )

    /** 用快照字段替换消息的版本字段（id/role/versions/vi 不动）= versions.js applySnap() */
    fun withFields(base: Message, o: JsonObject): Message = Message(
        id = base.id, role = base.role, versions = base.versions, vi = base.vi,
        content = str(o["content"]) ?: "",
        createdAt = (o["createdAt"] as? JsonPrimitive)?.longOrNull ?: 0,
        images = (o["images"] as? JsonArray)?.mapNotNull { str(it) } ?: emptyList(),
        files = (o["files"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList(),
        reasoning = str(o["reasoning"]),
        usage = (o["usage"] as? JsonObject)?.let(::decodeUsage),
        error = str(o["error"]),
        truncated = (o["truncated"] as? JsonPrimitive)?.booleanOrNull ?: false,
        finishReason = str(o["finishReason"]),
        routeSlug = str(o["routeSlug"]),
        extras = JsonObject(o.filterKeys { it !in MODELED && it != "tail" }),
    )

    fun encodeUsage(u: Usage) = JsonObject(buildMap {
        u.prompt?.let { put("prompt", JsonPrimitive(it)) }; u.completion?.let { put("completion", JsonPrimitive(it)) }
        u.hit?.let { put("hit", JsonPrimitive(it)) }; u.miss?.let { put("miss", JsonPrimitive(it)) }
        u.cacheWrite?.let { put("cacheWrite", JsonPrimitive(it)) }; u.cacheSupported?.let { put("cacheSupported", JsonPrimitive(it)) }
        u.source?.let { put("source", JsonPrimitive(it)) }; u.costUsd?.let { put("cost", JsonPrimitive(it)) }
    })
    fun decodeUsage(o: JsonObject) = Usage(
        prompt = num(o["prompt"]), completion = num(o["completion"]), hit = num(o["hit"]), miss = num(o["miss"]),
        cacheWrite = num(o["cacheWrite"]), cacheSupported = (o["cacheSupported"] as? JsonPrimitive)?.booleanOrNull,
        source = str(o["source"]), costUsd = (o["cost"] as? JsonPrimitive)?.doubleOrNull,
    )

    private fun str(e: JsonElement?) = (e as? JsonPrimitive)?.takeIf { it.isString }?.content
    private fun num(e: JsonElement?) = (e as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }

}
