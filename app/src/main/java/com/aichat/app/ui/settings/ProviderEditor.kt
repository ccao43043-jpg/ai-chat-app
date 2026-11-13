package com.aichat.app.ui.settings

import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.SettingsRepository
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType

/** 服务商编辑页的草稿（文本框原样内容） */
data class ProviderDraft(
    val name: String,
    val type: ProviderType,
    val baseUrl: String,
    val modelsText: String,
    val imageModel: String,
    val keyText: String,
) {
    companion object {
        fun of(p: ProviderConfig, hasKey: Boolean) =
            ProviderDraft(p.name, p.type, p.baseUrl, p.models.filter { it.isNotBlank() }.joinToString("\n"), p.imageModel, KeyMask.initialText(hasKey))
    }
}

/** 保存 / 删除逻辑（与 app.js #pe-save / #pe-delete 同语义；纯逻辑，可单测） */
class ProviderEditor(private val settings: SettingsRepository, private val keys: KeyVault) {
    sealed interface Result { data class Ok(val message: String, val provider: ProviderConfig) : Result; data class Invalid(val message: String) : Result }

    fun parseModels(text: String): List<String> = text.split('\n', ',', '，').map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    suspend fun save(base: ProviderConfig, d: ProviderDraft): Result {
        val url = d.baseUrl.trim()
        if (!Regex("^https?://.+").matches(url)) return Result.Invalid("Base URL 需以 http:// 或 https:// 开头")
        val models = parseModels(d.modelsText)
        if (models.isEmpty()) return Result.Invalid("请至少添加一个模型")
        var p = base.copy(name = d.name.trim().ifEmpty { "未命名" }, type = d.type, baseUrl = url, models = models, imageModel = d.imageModel.trim())
        // 先登记 Base URL（主机变化时数据层会清掉旧 Key），再写 Key —— 顺序与旧版一致，Key 才会绑定到新源
        val cleared = settings.registerProvider(p.id, url, ProviderPresets.authFor(d.type))
        val action = KeyMask.resolve(d.keyText)
        when (action) {
            KeyMask.Action.Keep -> Unit
            KeyMask.Action.Delete -> keys.delete(p.id)
            is KeyMask.Action.Replace -> if (!keys.set(p.id, action.key)) return Result.Invalid("API Key 保存失败")
        }
        p = p.copy(hasKey = keys.has(p.id))
        settings.update { s ->
            val i = s.providers.indexOfFirst { it.id == p.id }
            s.copy(providers = if (i >= 0) s.providers.toMutableList().also { it[i] = p } else s.providers + p)
        }
        return Result.Ok(if (cleared && action == KeyMask.Action.Keep) "Base URL 主机已变更，旧 API Key 已清除，请重新填写" else "已保存", p)
    }

    /** 删除服务商及其 Key。旧版的 settings.removedPresets（防止预设被重新合并回来）由 SettingsRepository 负责记录 */
    /** app.js 3787：删除预设服务商时记入 settings.removedPresets（顶层键，D 的 schema），启动补预设时不再补回 */
    suspend fun delete(p: ProviderConfig) {
        keys.delete(p.id)
        settings.update { s ->
            val rm = if (p.presetId.isNotEmpty() && p.presetId != "custom" && p.presetId !in s.removedPresets) s.removedPresets + p.presetId else s.removedPresets
            s.copy(providers = s.providers.filterNot { it.id == p.id }, removedPresets = rm)
        }
    }

    /** 新建：预设 id 未被占用时直接用 presetId（与旧版 presetToProvider 一致），否则加后缀 */
    fun newFromPreset(preset: ProviderPresets.Preset, existingIds: Set<String>, nowMs: Long = System.currentTimeMillis()): ProviderConfig {
        val id = if (preset.presetId != "custom" && preset.presetId !in existingIds) preset.presetId
        else preset.presetId + "-" + nowMs.toString(36)
        return ProviderPresets.toProvider(preset, id)
    }
}
