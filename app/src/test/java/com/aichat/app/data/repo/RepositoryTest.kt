package com.aichat.app.data.repo

import com.aichat.app.data.DataGraph
import com.aichat.app.data.json.Js
import com.aichat.app.data.secret.FakeKeyVault
import com.aichat.app.domain.model.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class RepositoryTest {
    private var t = 1700000000000L
    private fun graph(files: Map<String, String> = emptyMap(), keys: FakeKeyVault = FakeKeyVault()) = DataGraph.inMemory(files, keys) { t }

    @Test fun createSaveLoadAndIndex() = runBlocking {
        val g = graph()
        val c = g.chats.create("deepseek", "deepseek-chat")
        assertEquals(listOf(c.id), g.chats.index.value.map { it.id })
        t += 1000
        val msg = Message(id = "u1", role = Role.USER, content = "你好", createdAt = t)
        g.chats.save(c.copy(messages = listOf(msg), title = "第一句"))
        val back = g.chats.load(c.id)!!
        assertEquals("第一句", back.title); assertEquals("你好", back.messages.single().content); assertEquals(t, back.updatedAt)
        assertEquals("第一句", g.chats.index.value.single().title)
        // 指针文件 + 快照 + 日志
        assertTrue(g.store.exists("conv_${c.id}.snap.json")); assertTrue(g.store.exists("conv_${c.id}.log.jsonl"))
        assertEquals("oplog-v1", Js.prop(Js.parse(g.store.get("conv_${c.id}.json")!!), "format"))
    }

    @Test fun unchangedSaveAppendsNoOps() = runBlocking {
        val g = graph()
        val c = g.chats.create("p", "m")
        g.chats.save(c.copy(messages = listOf(Message("u1", Role.USER, "x", 1, extras = buildJsonObject { put("zz", 1); put("aa", 2) }))), touch = false)
        val log1 = g.store.get("conv_${c.id}.log.jsonl")!!
        g.chats.save(g.chats.load(c.id)!!, touch = false)
        assertEquals("重新保存未改动的对话不应追加 op", log1, g.store.get("conv_${c.id}.log.jsonl"))
    }

    @Test fun legacyConversationLoadsAndKeepsOriginalFile() = runBlocking {
        val legacy = """{"id":"old1","title":"旧对话","providerId":"p","model":"m","createdAt":1,"updatedAt":2,"messages":[{"id":"u","role":"user","content":"hi","createdAt":1}],"customKey":{"a":1}}"""
        val g = graph(mapOf("conv_old1.json" to legacy, "device-id.json" to """{"dev":"dev-x"}"""))
        assertEquals(listOf("old1"), g.chats.index.value.map { it.id })          // convs.json 缺失 → 重建
        assertTrue(g.store.exists("convs.json"))
        val c = g.chats.load("old1")!!
        assertEquals("hi", c.messages.single().content); assertEquals(buildJsonObject { put("a", 1) }, c.extras["customKey"])
        assertEquals(legacy, g.store.get("conv_old1.json"))                     // 原文件只读保留
        val exported = Js.parse(g.chats.exportJson("old1")) as com.aichat.app.data.json.JsObj
        assertEquals(com.aichat.app.data.json.Undef, exported["format"])
    }

    @Test fun deleteRemovesFilesAndRplog() = runBlocking {
        val g = graph()
        val c = g.chats.create("p", "m")
        g.store.set("rplog_${c.id}.jsonl", "{}\n")
        g.chats.delete(c.id)
        assertTrue(g.chats.index.value.isEmpty())
        assertFalse(g.store.list().any { it.contains(c.id) })
    }

    @Test fun exportImportAllRoundTrip() = runBlocking {
        val g = graph()
        val c = g.chats.create("p", "m"); g.chats.save(c.copy(messages = listOf(Message("u", Role.USER, "a", 1))))
        val all = g.chats.exportAllJson()
        val g2 = graph()
        val ids = g2.chats.importJson(all)
        assertEquals(1, ids.size); assertEquals("a", g2.chats.load(ids[0])!!.messages.single().content)
        assertEquals(1, g.chats.importJson(all).size)                           // id 冲突 → 换新 id
        assertEquals(2, g.chats.index.value.size)
    }

    @Test fun settingsRegisterProviderClearsKeyOnOriginChange() = runBlocking {
        val keys = FakeKeyVault()
        val g = graph(mapOf("settings.json" to """{"providers":[{"id":"p1","presetId":"deepseek","name":"D","type":"openai","baseUrl":"https://api.deepseek.com","models":[],"hasKey":true}],"autoCharMode":"ask"}"""), keys)
        assertEquals("autoChar v0.8.4 迁移在内存里生效", "auto", g.settings.settings.value.autoCharMode)
        assertFalse(g.settings.registerProvider("p1", "https://api.deepseek.com", AuthType.BEARER))
        keys.set("p1", "sk-1")
        assertEquals("sk-1", keys.keyFor("p1", "https://api.deepseek.com/chat/completions"))
        assertNull(keys.keyFor("p1", "https://evil.example/x"))
        assertTrue(g.settings.registerProvider("p1", "https://other.host/v1", AuthType.BEARER))
        assertFalse(keys.has("p1")); assertFalse(g.settings.settings.value.providers[0].hasKey)
        assertNull(keys.registration("nope"))
        g.settings.update { it.copy(removedPresets = listOf("qwen")) }
        assertEquals(JsonArray(listOf(JsonPrimitive("qwen"))), Js.parseJson(g.store.get("settings.json")!!).jsonObject["removedPresets"])
    }

    @Test fun libraryDefaultsAndMerge() = runBlocking {
        // 与 JS 相同：personas.json 缺失时先用全部默认；removedPersonas 只阻止「补回」
        assertTrue(graph(mapOf("settings.json" to """{"providers":[],"removedPersonas":["p-coder"]}""")).library.personas.value.any { it.id == "p-coder" })
        val g = graph(mapOf("settings.json" to """{"providers":[],"removedPersonas":["p-coder"]}""", "personas.json" to """[{"id":"mine","emoji":"","name":"m","desc":"","systemPrompt":""}]"""))
        assertEquals("mine", g.library.personas.value.first().id)
        assertTrue(g.library.personas.value.none { it.id == "p-coder" })
        assertTrue(g.library.personas.value.any { it.id == "p-translator" })
        assertTrue(g.library.templates.value.isNotEmpty()); assertTrue(g.library.worlds.value.isEmpty())
        g.library.saveWorlds(listOf(World("w", "🌍", "雨港", "", "", emptyMap(), emptyMap(), 1, emptyList(), 1, 2)))
        assertTrue(g.store.get("worlds.json")!!.contains("雨港"))
    }

    @Test fun usageLegacyMigrationAndDedupe() = runBlocking {
        val g = graph(mapOf("usage-stats.json" to """{"version":2,"log":[{"key":"a","t":1},{"key":"b","t":2}],"prices":{"m":{"hit":1}},"priceMode":"list"}"""))
        assertTrue(g.usage.migrateLegacy())
        assertTrue(g.store.exists("usage-stats.json.migrated")); assertFalse(g.store.exists("usage-stats.json"))
        g.usage.append(buildJsonObject { put("key", "a"); put("t", 3) })
        assertEquals(listOf("a", "b"), g.usage.readLog().map { it["key"]!!.jsonPrimitive.content })
        assertEquals("list", g.usage.meta()["priceMode"]!!.jsonPrimitive.content)
    }
}
