package com.aichat.app.data.diag

import com.aichat.app.data.DataGraph
import com.aichat.app.data.codec.*
import com.aichat.app.data.json.Js
import com.aichat.app.data.secret.KeyVaultAdmin
import kotlinx.serialization.json.*

/**
 * 仓库视角的整库快照（不含任何 Key 明文）：用于模拟器覆盖安装回归（与 JS 读同一 store 的结果对照）、
 * 备份导出→导入后的等价校验，以及以后的「诊断信息」导出。
 */
object StoreDump {
    suspend fun dump(g: DataGraph, withKeys: Boolean = true): JsonObject = buildJsonObject {
        val index = g.chats.index.value
        put("index", ConvMetaCodec.encodeList(index))
        put("convs", buildJsonObject { index.forEach { m -> g.chats.load(m.id)?.let { put(m.id, ConversationCodec.encode(it)) } } })
        put("settings", SettingsCodec.encode(g.settings.settings.value))
        put("personas", PersonaCodec.encodeList(g.library.personas.value))
        put("prompts", PromptCodec.encodeList(g.library.prompts.value))
        put("templates", TemplateCodec.encodeList(g.library.templates.value))
        put("worlds", WorldCodec.encodeList(g.library.worlds.value))
        put("knowledge", buildJsonObject { g.knowledge.worldIds().sorted().forEach { id -> g.knowledge.load(id)?.let { put(id, it) } } })
        val log = g.usage.readLog()
        put("usage", buildJsonObject { put("count", log.size); put("keys", JsonArray(log.map { it["key"] ?: JsonNull })); put("meta", g.usage.meta()) })
        put("rplog", buildJsonObject { index.forEach { m -> g.rpLog.read(m.id).takeIf { it.isNotEmpty() }?.let { put(m.id, it.size) } } })
        if (withKeys) put("keys", keyStatus(g.keys, g.settings.settings.value.providers.map { it.id to it.baseUrl } +
            ((g.settings.settings.value.search["hasKeys"] as? JsonObject)?.keys ?: emptySet()).map { "search:$it" to "" }))
    }

    /** 每个 id：是否存了 Key、能否解密、登记的源、对登记 baseUrl 能否取到 Key（只给布尔/长度，不输出明文） */
    fun keyStatus(keys: KeyVaultAdmin, ids: List<Pair<String, String>>): JsonObject = buildJsonObject {
        ids.forEach { (id, base) ->
            put(id, buildJsonObject {
                put("has", keys.has(id)); put("canDecrypt", keys.canDecrypt(id))
                keys.registration(id)?.let { r -> put("origin", r.origin ?: ""); put("auth", r.authType.name) }
                if (base.isNotEmpty()) put("keyForBase", (keys.keyFor(id, base.trimEnd('/') + "/chat/completions")?.length ?: -1) > 0)
            })
        }
    }

    fun stringify(o: JsonObject): String = Js.stringify(Js.fromJson(o), 1)!!
}
