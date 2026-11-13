package com.aichat.app.ui.settings

import com.aichat.app.domain.model.AuthType
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType

/**
 * 服务商预设（providers.js PRESETS 的 UI 侧副本，只用于「添加服务商」和 fake 默认设置）。
 * 权威版本归工作流 B（net/ 的 Providers 移植）；B 提供后这里改为引用它。
 */
object ProviderPresets {
    data class Preset(val presetId: String, val name: String, val type: ProviderType, val baseUrl: String, val models: List<String>, val imageModel: String = "")

    val all = listOf(
        Preset("openai", "OpenAI", ProviderType.OPENAI, "https://api.openai.com/v1", listOf("gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"), "gpt-image-2.5-flare"),
        Preset("deepseek", "DeepSeek", ProviderType.OPENAI, "https://api.deepseek.com", listOf("deepseek-flash", "deepseek-v4-pro")),
        Preset("qwen", "阿里云百炼 · 千问（中国）", ProviderType.OPENAI, "https://dashscope.aliyuncs.com/compatible-mode/v1",
            listOf("qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash", "qwen-plus", "qwen-flash", "qwen-plus-character", "qwen3-coder-flash", "qwen3-vl-plus")),
        Preset("qwen-intl", "阿里云百炼 · 千问（国际）", ProviderType.OPENAI, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            listOf("qwen3.8-max", "qwen3.7-plus", "qwen3.8-flash", "qwen-plus", "qwen-flash", "qwen3-coder-flash", "qwen3-vl-plus")),
        Preset("moonshot", "Kimi (Moonshot)", ProviderType.OPENAI, "https://api.moonshot.cn/v1", listOf("kimi-k3", "kimi-k2.6", "kimi-k2.7-code")),
        Preset("zhipu", "智谱 GLM", ProviderType.OPENAI, "https://open.bigmodel.cn/api/paas/v4", listOf("glm-5.3", "glm-5.3-flash", "glm-4.7-flash"), "cogview-3-flash"),
        Preset("siliconflow", "硅基流动 SiliconFlow", ProviderType.OPENAI, "https://api.siliconflow.cn/v1",
            listOf("deepseek-ai/DeepSeek-V3.2", "Qwen/Qwen3.5-397B-A17B", "Qwen/Qwen3-32B"), "Kwai-Kolors/Kolors"),
        Preset("xiaomi", "小米 MiMo", ProviderType.OPENAI, "https://api.xiaomimimo.com/v1",
            listOf("mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.5-pro", "mimo-v2.5")),
        Preset("openrouter", "OpenRouter", ProviderType.OPENAI, "https://openrouter.ai/api/v1",
            listOf("openai/gpt-6-astra", "anthropic/claude-opus-5.5", "google/gemini-3.8-flash")),
        Preset("anthropic", "Anthropic Claude", ProviderType.ANTHROPIC, "https://api.anthropic.com",
            listOf("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1")),
        Preset("gemini", "Google Gemini", ProviderType.GEMINI, "https://generativelanguage.googleapis.com/v1beta",
            listOf("gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-3.5-flash-lite")),
        Preset("custom", "自定义（OpenAI 兼容）", ProviderType.OPENAI, "https://", emptyList()),
    )

    fun toProvider(p: Preset, id: String = p.presetId) =
        ProviderConfig(id = id, presetId = p.presetId, name = p.name, type = p.type, baseUrl = p.baseUrl, models = p.models, imageModel = p.imageModel)

    fun defaults(): List<ProviderConfig> = all.filter { it.presetId != "custom" }.map { toProvider(it) }

    fun authFor(type: ProviderType): AuthType = when (type) {
        ProviderType.OPENAI -> AuthType.BEARER
        ProviderType.ANTHROPIC -> AuthType.ANTHROPIC
        ProviderType.GEMINI -> AuthType.GEMINI
    }
}
