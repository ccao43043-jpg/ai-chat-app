package com.aichat.app.ui.settings

import com.aichat.app.domain.model.AuthType
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType

/**
 * 服务商预设的 UI 视图（「添加服务商」和 fake 默认设置用）。
 * 数据来自工作流 B 的 [com.aichat.app.net.ProviderPresets]（providers.js PRESETS 原样导出，golden 校验），这里只做类型转换。
 */
object ProviderPresets {
    data class Preset(val presetId: String, val name: String, val type: ProviderType, val baseUrl: String, val models: List<String>, val imageModel: String = "")

    val all: List<Preset> by lazy {
        com.aichat.app.net.ProviderPresets.PRESETS.map { e ->
            val o = e as kotlinx.serialization.json.JsonObject
            fun s(k: String) = (o[k] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: ""
            Preset(s("presetId"), s("name"), ProviderType.entries.firstOrNull { it.name.equals(s("type"), true) } ?: ProviderType.OPENAI, s("baseUrl"),
                ((o["models"] as? kotlinx.serialization.json.JsonArray) ?: kotlinx.serialization.json.JsonArray(emptyList()))
                    .mapNotNull { (it as? kotlinx.serialization.json.JsonPrimitive)?.content?.takeIf { m -> m.isNotEmpty() } },
                s("imageModel"))
        }
    }

    fun toProvider(p: Preset, id: String = p.presetId) =
        ProviderConfig(id = id, presetId = p.presetId, name = p.name, type = p.type, baseUrl = p.baseUrl, models = p.models, imageModel = p.imageModel)

    fun defaults(): List<ProviderConfig> = all.filter { it.presetId != "custom" }.map { toProvider(it) }

    fun authFor(type: ProviderType): AuthType = when (type) {
        ProviderType.OPENAI -> AuthType.BEARER
        ProviderType.ANTHROPIC -> AuthType.ANTHROPIC
        ProviderType.GEMINI -> AuthType.GEMINI
    }
}
