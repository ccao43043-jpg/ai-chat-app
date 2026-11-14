package com.aichat.app.domain.cost

import com.aichat.app.domain.model.Conversation
import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType
import com.aichat.app.domain.model.Role
import com.aichat.app.domain.model.Usage
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 契约：usage-stats.jsonl 的每一行 = JS `usage-stats.js makeEntry` 的产物。
 * 这些断言锁的是「字段从哪来」（app.js recordUsage 的兜底规则），不是 makeEntry 内部算法。
 */
class UsageEntryTest {

    private val at = 1_700_000_000_000L

    private fun conv() = Conversation(
        id = "c1", title = "雨港夜话", providerId = "or", model = "conv-model",
        createdAt = 0L, updatedAt = 0L, messages = emptyList(),
    )

    private fun provider(presetId: String = "openrouter", id: String = "p1") = ProviderConfig(
        id = id, presetId = presetId, name = "OpenRouter",
        type = ProviderType.OPENAI, baseUrl = "", models = emptyList(),
    )

    @Test
    fun noPromptMeansNoEntry() {
        assertNull(UsageEntry.of(Usage(prompt = null, completion = 10L), at = at, msgId = "a1"))
    }

    @Test
    fun fieldsAndDedupKeyMatchJs() {
        val e = UsageEntry.of(
            Usage(prompt = 1000L, completion = 200L, cacheSupported = true, hit = 800L, miss = 200L, costUsd = 0.0123),
            at = at, model = "m", providerId = "openrouter", providerName = "OpenRouter",
            convId = "c1", convTitle = "雨港夜话", msgId = "a1",
        )
        assertNotNull(e)
        val o = e!!

        // 键集合：少一个 → 旧版读到 undefined；多一个 → 旧版读不懂但会原样写回
        assertEquals(
            setOf(
                "id", "at", "type", "prompt", "completion", "hit", "miss", "cache",
                "model", "providerId", "providerName", "convId", "convTitle", "msgId",
                "key", "actualCost",
            ),
            o.keys,
        )
        assertEquals("id", o.keys.first())

        // 去重键：l:<at>:<msgId>:<prompt>:<completion>:<type>（usage-stats.js makeEntry 缺省值）
        assertEquals("l:1700000000000:a1:1000:200:chat", o["key"]!!.jsonPrimitive.content)
        assertTrue(
            "id 形如 u_<base36(at)>_<6 位随机>，实际=${o["id"]!!.jsonPrimitive.content}",
            Regex("^u_[0-9a-z]+_[0-9a-z]{6}$").matches(o["id"]!!.jsonPrimitive.content),
        )

        assertEquals("1700000000000", o["at"]!!.jsonPrimitive.content)
        assertEquals("chat", o["type"]!!.jsonPrimitive.content)
        assertEquals("1000", o["prompt"]!!.jsonPrimitive.content)
        assertEquals("200", o["completion"]!!.jsonPrimitive.content)
        assertEquals("800", o["hit"]!!.jsonPrimitive.content)
        assertEquals("200", o["miss"]!!.jsonPrimitive.content)
        assertEquals("true", o["cache"]!!.jsonPrimitive.content)
        assertEquals("m", o["model"]!!.jsonPrimitive.content)
        assertEquals("openrouter", o["providerId"]!!.jsonPrimitive.content)
        assertEquals("OpenRouter", o["providerName"]!!.jsonPrimitive.content)
        assertEquals("c1", o["convId"]!!.jsonPrimitive.content)
        assertEquals("雨港夜话", o["convTitle"]!!.jsonPrimitive.content)
        assertEquals("a1", o["msgId"]!!.jsonPrimitive.content)
        assertEquals(0.0123, o["actualCost"]!!.jsonPrimitive.content.toDouble(), 0.0)
    }

    @Test
    fun missingCostIsJsonNull() {
        val o = UsageEntry.of(Usage(prompt = 50L, completion = 7L), at = at, msgId = "m1")!!
        assertEquals(JsonNull, o["actualCost"])
        // costUsd 不写进 usage 子对象，避免和 JS 的 cost 键名混着传两遍
        assertEquals("l:1700000000000:m1:50:7:chat", o["key"]!!.jsonPrimitive.content)
    }

    @Test
    fun fromFallsBackLikeRecordUsage() {
        val o = UsageEntry.from(
            conv = conv(), p = provider(), model = "", msg = Message(id = "a1", role = Role.ASSISTANT, content = "hi"),
            u = Usage(prompt = 5L, completion = 6L), at = at,
        )!!

        // model 为空 → 取 conv.model（app.js: opts.model || c.model）
        assertEquals("conv-model", o["model"]!!.jsonPrimitive.content)
        // presetId 为空 → 取 id（app.js: p.presetId || p.id）
        val o2 = UsageEntry.from(
            conv = conv(), p = provider(presetId = "", id = "custom-1"), model = "x",
            msg = Message(id = "a2", role = Role.ASSISTANT, content = ""),
            u = Usage(prompt = 1L), at = at,
        )!!
        assertEquals("custom-1", o2["providerId"]!!.jsonPrimitive.content)
        assertEquals("x", o2["model"]!!.jsonPrimitive.content)
    }
}
