package com.aichat.app.domain.cost

import com.aichat.app.domain.model.Conversation
import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.Usage
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * `app.js recordUsage` 的 Kotlin 版：把一次请求的用量变成 `usage-stats.jsonl` 的一行。
 *
 * JS 对照（app.js `recordUsage` → `UsageStats.makeEntry` → usage-stats.js `makeEntry`）：
 * ```
 * const entry = UsageStats.makeEntry({
 *   usage: u, at, type: 'chat',
 *   model: opts.model || (c && c.model) || '',
 *   providerId: (p && (p.presetId || p.id)) || (c && c.providerId) || '',
 *   providerName: p && p.name, convId: c && c.id, convTitle: c && c.title, msgId: msg && msg.id,
 * });
 * ```
 * 这里只做「从实体里取字段 + 兜底」，字段拼装、默认值、去重键格式**全部**交给
 * [UsageStatsCore.makeEntry]。此前 `AppGraph.recordUsage` 手写过一遍同样的逻辑（OPT-1），
 * 两份实现迟早会漂移（`key` 的拼接、`id` 的随机段、`actualCost` 的空值处理）。
 */
object UsageEntry {

    /**
     * makeEntry 只读 usage 的 prompt / completion / cacheSupported / hit / miss / cost 六项
     * （其余字段由 makeEntry 自己算，见 usage-stats.js）。所以这里只投影这几项，
     * 不把 [Usage.extras] / [Usage.raw] 带进条目——它们不落盘。
     */
    private fun usageJson(u: Usage): JsonObject = buildJsonObject {
        put("prompt", u.prompt ?: 0L)
        put("completion", u.completion ?: 0L)
        u.cacheSupported?.let { put("cacheSupported", it) }
        u.hit?.let { put("hit", it) }
        u.miss?.let { put("miss", it) }
        // JS 的键名是 cost（不是 costUsd）；costUsd 只是内存里的字段名
        u.costUsd?.takeIf { it.isFinite() }?.let { put("cost", it) }
    }

    /**
     * 与 JS 一致：没有 prompt 就不入账（`if (!u || u.prompt == null) return;`）。
     * @param at 落盘时间戳；同时用作 id 的 base36 前缀，保证 id 与 at 属于同一时刻。
     */
    fun of(
        u: Usage,
        at: Long = System.currentTimeMillis(),
        type: String = "chat",
        model: String = "",
        providerId: String = "",
        providerName: String = "",
        convId: String = "",
        convTitle: String = "",
        msgId: String = "",
    ): JsonObject? {
        if (u.prompt == null) return null
        return UsageStatsCore.makeEntry(
            JsonObject(
                linkedMapOf(
                    "usage" to usageJson(u),
                    "at" to JsonPrimitive(at),
                    "type" to JsonPrimitive(type),
                    "model" to JsonPrimitive(model),
                    "providerId" to JsonPrimitive(providerId),
                    "providerName" to JsonPrimitive(providerName),
                    "convId" to JsonPrimitive(convId),
                    "convTitle" to JsonPrimitive(convTitle),
                    "msgId" to JsonPrimitive(msgId),
                )
            ),
            at,
        )
    }

    /** `app.js recordUsage` 的完整入参：对话 / 服务商 / 消息 的兜底规则集中在 [from]。 */
    fun from(
        conv: Conversation,
        p: ProviderConfig,
        model: String,
        msg: Message,
        u: Usage,
        at: Long = System.currentTimeMillis(),
    ): JsonObject? = of(
        u = u,
        at = at,
        type = "chat",
        model = model.ifEmpty { conv.model },
        providerId = p.presetId.ifEmpty { p.id },
        providerName = p.name,
        convId = conv.id,
        convTitle = conv.title,
        msgId = msg.id,
    )
}
