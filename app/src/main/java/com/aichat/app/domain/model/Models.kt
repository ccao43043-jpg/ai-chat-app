package com.aichat.app.domain.model

import kotlinx.serialization.json.JsonObject

/*
 * 领域实体（工作流 C 所有；A/B 只读使用）。
 *
 * 无损往返约定（硬性）：旧 JSON 里有大量本表未建模的字段（插件状态、RP 章节、affect、ledger、
 * knowledgeTrace…）。每个实体都带 [extras]：解码时把「未建模的键」原样放进去，编码时再合并回去，
 * 键的相对顺序尽量保持。任何写回 filesDir/store 的路径都必须经过 data.codec 的 Codec，
 * 不得用「只含已建模字段」的对象覆盖旧文件。
 */
val EmptyJson = JsonObject(emptyMap())

/** 请求格式：与 providers.js PRESETS[].type 一致 */
enum class ProviderType(val wire: String) { OPENAI("openai"), ANTHROPIC("anthropic"), GEMINI("gemini");
    companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } ?: OPENAI }
}

/** 认证注入方式：与 SecretStore 登记的 authType 一致（bearer / anthropic / gemini / brave） */
enum class AuthType(val wire: String) { BEARER("bearer"), ANTHROPIC("anthropic"), GEMINI("gemini"), BRAVE("brave");
    companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } ?: BEARER }
}

/** settings.json → providers[]（presetToProvider + 用户编辑字段） */
data class ProviderConfig(
    val id: String,
    val presetId: String,                 // openai/deepseek/qwen/qwen-intl/moonshot/zhipu/siliconflow/xiaomi/openrouter/anthropic/gemini/custom
    val name: String,
    val type: ProviderType,
    val baseUrl: String,
    val models: List<String>,
    val imageModel: String = "",
    val videoModel: String = "",
    val embeddingModel: String = "",
    val speechModel: String = "",
    val transcriptionModel: String = "",
    val hasKey: Boolean = false,          // 只表示 SecretStore 里有 provider_key:<id>；明文永不进实体
    val thinking: String? = null,         // "on" | "off" | null
    val streamUsage: Boolean? = null,
    val cacheAffinity: Boolean? = null,
    val orSort: String? = null,           // balanced | price | throughput
    val modelMeta: JsonObject = EmptyJson,// { modelId: { ctx, out, modality, price, priceFloor, _endpoints… } }
    val extras: JsonObject = EmptyJson,
)

/** settings.json（defaultSettings() 的已建模子集；plugins 等整体放 extras/plugins） */
data class AppSettings(
    val providers: List<ProviderConfig>,
    val systemPrompt: String = "",
    val stream: Boolean = true,
    val temperature: Double? = null,      // JS 里 '' 表示未设
    val maxTokens: Int? = null,
    val imageSize: String = "1024x1024",
    val imageGenProviderId: String = "",
    val imageGenModel: String = "",
    val lastProviderId: String = "",
    val lastModel: String = "",
    val settingsVersion: Int = 2,
    val searchOn: Boolean = false,
    val search: JsonObject = EmptyJson,   // { provider, hasKeys, urls, count, rewrite }
    val plugins: JsonObject = EmptyJson,  // { rpcache:{…}, gcache:{…}, mmcache:{…}, knowledge:{…} } 由 C 的 ChatPlugin 解释
    val showTopCost: Boolean = true,
    val extras: JsonObject = EmptyJson,
)

/** convs.json 元素 */
data class ConversationMeta(
    val id: String,
    val title: String,
    val providerId: String,
    val model: String,
    val updatedAt: Long,
    val personaName: String? = null,
    val personaEmoji: String? = null,
)

enum class Role(val wire: String) { USER("user"), ASSISTANT("assistant"), SYSTEM("system");
    companion object { fun of(s: String?) = entries.firstOrNull { it.wire == s } ?: USER }
}

/** 统一 usage：providers.js normalizeUsage 的输出 */
data class Usage(
    val prompt: Long? = null,
    val completion: Long? = null,
    val hit: Long? = null,
    val miss: Long? = null,
    val cacheWrite: Long? = null,
    val cacheSupported: Boolean? = null,
    val source: String? = null,
    val costUsd: Double? = null,
)

/**
 * 消息。版本：m.versions = [快照|null…]，m.vi = 当前下标；当前版本数据就在消息本身，versions[vi] 为 null（versions.js）。
 * images：data URL 或 http URL 字符串；files：[{id,name,size,kind,text…}] 原样 JsonObject。
 */
data class Message(
    val id: String,
    val role: Role,
    val content: String,
    val createdAt: Long = 0,
    val images: List<String> = emptyList(),
    val files: List<JsonObject> = emptyList(),
    val reasoning: String? = null,
    val usage: Usage? = null,
    val error: String? = null,
    val truncated: Boolean = false,
    val finishReason: String? = null,
    val routeSlug: String? = null,
    val versions: List<JsonObject?> = emptyList(),
    val vi: Int = 0,
    val extras: JsonObject = EmptyJson,   // pluginStatus/routeView/sources/knowledgeTrace/_conflicts…
)

/** 完整对话（ConvLog.load 的输出 / conv_<id>.json 旧格式） */
data class Conversation(
    val id: String,
    val title: String,
    val providerId: String,
    val model: String,
    val createdAt: Long,
    val updatedAt: Long,
    val messages: List<Message>,
    val personaName: String? = null,
    val personaEmoji: String? = null,
    val systemPrompt: String? = null,
    /** chapters/affect/affectBy/ledger/worldRef/worldLog/worldPending/kb 等 RP 状态，原样保留 */
    val rpState: JsonObject = EmptyJson,
    val extras: JsonObject = EmptyJson,
)

data class Persona(val id: String, val emoji: String, val name: String, val desc: String, val systemPrompt: String,
                   val providerId: String, val model: String, val temperature: Double?, val builtin: Boolean,
                   val extras: JsonObject = EmptyJson)
data class PromptSnippet(val id: String, val title: String, val content: String, val builtin: Boolean)
data class PromptTemplate(val id: String, val name: String, val emoji: String, val content: String, val tags: List<String>,
                          val pinned: Boolean, val builtin: Boolean, val skill: Boolean)

/** worlds.json 元素；blocks 的键集合 = worlds.js BLOCK_IDS */
data class World(
    val id: String, val emoji: String, val name: String, val desc: String, val greeting: String,
    val blocks: Map<String, JsonObject>, val blockHash: Map<String, String>, val version: Int,
    val changelog: List<JsonObject>, val createdAt: Long, val updatedAt: Long, val extras: JsonObject = EmptyJson,
) { companion object { val BLOCK_IDS = listOf("world", "character", "rules", "format", "fewshot", "prohibit", "style") } }

/** 生图历史（imagegen.js HISTORY_LIMIT=10） */
data class ImageJob(val id: String, val providerId: String, val model: String, val prompt: String, val size: String,
                    val refImages: List<String>, val results: List<String>, val error: String?, val createdAt: Long, val elapsedMs: Long?)
