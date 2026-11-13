package com.aichat.app.data.codec

import com.aichat.app.data.json.Js
import com.aichat.app.domain.model.ProviderType
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** 硬性约定 1：decode → encode 与原文件 JSON 语义相等；改字段后只改那一处 */
class CodecRoundTripTest {
    private fun obj(s: String) = Js.parseJson(s).jsonObject
    private fun assertSem(exp: JsonElement, act: JsonElement) = assertTrue("期望 $exp\n实际 $act", sem(exp, act))

    private val SETTINGS = """{"providers":[{"id":"or1","presetId":"openrouter","name":"OpenRouter","type":"openai","baseUrl":"https://openrouter.ai/api/v1",
      "models":["deepseek/deepseek-chat"],"imageModel":"","videoModel":"","embeddingModel":"","speechModel":"","transcriptionModel":"","hasKey":true,
      "thinking":true,"cacheAffinity":false,"orSort":"price","cacheAdapter":"mmcache","modelMeta":{"x":{"ctx":128000,"price":{"in":0.27}}},"futureFlag":{"a":[1,2]}}],
      "systemPrompt":"","stream":true,"temperature":"","maxTokens":"","imageSize":"1024x1024","imageGenProviderId":"","imageGenModel":"","lastProviderId":"or1",
      "lastModel":"m","settingsVersion":2,"search":{"provider":"tavily","hasKeys":{},"urls":{},"count":5,"rewrite":false},"searchOn":false,"removedPersonas":[],
      "removedPresets":["qwen"],"recentTemplates":["t1"],"recentWorlds":[],"recentPersonas":[],"drawerCollapsed":{"recent":false,"more":false},"showTopCost":true,
      "deferHighlight":true,"settingsTab":"providers","autoCharMode":"auto","autoCharV084":true,"plugins":{"rpcache":{"enabled":true,"prices":{"m":{"hit":0.1}}}},
      "defaultTemplateId":"t-x"}"""

    @Test fun settingsRoundTripIsLossless() {
        val o = obj(SETTINGS)
        val s = SettingsCodec.decode(o)
        assertSem(o, SettingsCodec.encode(s))
        assertEquals(listOf("qwen"), s.removedPresets)
        assertNull(s.temperature); assertNull(s.maxTokens)
        val p = s.providers[0]
        assertEquals(ProviderType.OPENAI, p.type); assertEquals("price", p.orSort); assertEquals(false, p.cacheAffinity)
        assertEquals(JsonPrimitive("mmcache"), p.extras["cacheAdapter"])   // 契约变更 #k：缓存适配器配置在 provider 对象上，原样往返
        assertNull("thinking:true 不是字符串 → 建模值 null，原值作影子", p.thinking)
    }

    @Test fun settingsEditTouchesOnlyThatField() {
        val o = obj(SETTINGS)
        val s = SettingsCodec.decode(o)
        val e = SettingsCodec.encode(s.copy(temperature = 0.7, removedPresets = listOf("qwen", "zhipu")))
        assertEquals(JsonPrimitive(0.7), e["temperature"]); assertEquals("\"\"", e["maxTokens"].toString())
        assertEquals(2, e["removedPresets"]!!.jsonArray.size)
        val back = SettingsCodec.encode(SettingsCodec.decode(e).copy(temperature = null))
        assertEquals(JsonPrimitive(""), back["temperature"])     // null 写回 JS 习惯的 ''
        val p2 = SettingsCodec.encode(s.copy(providers = listOf(s.providers[0].copy(thinking = "on"))))["providers"]!!.jsonArray[0].jsonObject
        assertEquals(JsonPrimitive("on"), p2["thinking"]); assertEquals(JsonPrimitive("mmcache"), p2["cacheAdapter"])
    }

    @Test fun legacySettingsWithoutVersionDecodeAsV1() {
        val s = SettingsCodec.decode(obj("""{"providers":[]}"""))
        assertEquals(1, s.settingsVersion)
        assertSem(obj("""{"providers":[]}"""), SettingsCodec.encode(s))          // 缺键原样缺
        assertEquals(JsonPrimitive(2), SettingsCodec.encode(s.copy(settingsVersion = 2))["settingsVersion"])
    }

    @Test fun conversationAndMessagesRoundTrip() {
        val o = obj("""{"id":"c1","title":"雨港","providerId":"deepseek","model":"m","createdAt":1,"updatedAt":2,"systemPrompt":"sys","temperature":0.5,
          "personaName":"侦探","personaEmoji":"🕵️","format":"oplog-v1","plugins":{"rpcache":{"state":{"chapters":[{"no":1,"content":"x"}]}}},
          "affect":{"mood":"calm"},"ledger":[{"id":"f1"}],"worldRef":{"id":"w"},"worldLog":[{"at":1}],"kb":{},
          "messages":[{"id":"u1","role":"user","content":"你好","createdAt":1,"images":["data:x"],"files":[{"id":"f","name":"a.pdf","text":"t"}]},
            {"id":"a1","role":"assistant","content":"hi","createdAt":2,"usage":{"prompt":10,"completion":5,"hit":8,"miss":2,"cost":0.000123,"raw":{"x":1},"cacheSupported":true,"source":"deepseek"},
             "versions":[{"content":"old"},null],"vi":1,"truncated":true,"reasoning":"r","pluginStatus":{"rpcache":{"hit":0.8}},"_conflicts":[{"content":"z"}]},
            {"id":"a2","role":"assistant","content":[{"type":"text","text":"array content"}],"createdAt":"3"}]}""")
        val c = ConversationCodec.decode(o)
        assertSem(o, ConversationCodec.encode(c))
        assertEquals(setOf("affect", "ledger", "worldRef", "worldLog", "kb"), c.rpState.keys)
        val u = c.messages[1].usage!!
        assertEquals(8L, u.hit); assertEquals(0.000123, u.costUsd!!, 0.0); assertNull(u.raw); assertTrue("未建模键进 extras", u.extras.containsKey("raw"))
        // 改正文：只有 content 变
        val e = ConversationCodec.encode(c.copy(messages = c.messages.mapIndexed { i, m -> if (i == 0) m.copy(content = "改") else m }))
        assertEquals(JsonPrimitive("改"), e["messages"]!!.jsonArray[0].jsonObject["content"])
        assertSem(o["messages"]!!.jsonArray[1], e["messages"]!!.jsonArray[1])
        // usage 改字段：raw 里的未建模键保留
        val u2 = MessageCodec.encode(c.messages[1].copy(usage = u.copy(hit = 9)))["usage"]!!.jsonObject
        assertEquals("9", u2["hit"].toString()); assertEquals(obj("""{"x":1}"""), u2["raw"])
    }

    @Test fun templateFieldsAndPluginToggles() {
        val o = obj("""{"id":"c","title":"t","providerId":"p","model":"m","createdAt":1,"updatedAt":2,"messages":[],"systemPrompt":"s",
          "templateId":"t-x","templateName":"翻译","templateEmoji":"🌐","plugins":{"rpcache":{"enabled":true,"state":{}},"gcache":{"enabled":false}}}""")
        val c = ConversationCodec.decode(o)
        assertEquals("t-x", c.templateId); assertEquals("🌐", c.templateEmoji)
        assertEquals(false, c.extras["plugins"]!!.jsonObject["gcache"]!!.jsonObject["enabled"]!!.jsonPrimitive.boolean)
        assertSem(o, ConversationCodec.encode(c))
        val cleared = ConversationCodec.encode(c.copy(templateId = null, templateName = null, templateEmoji = null))
        assertFalse(cleared.containsKey("templateId") || cleared.containsKey("templateName") || cleared.containsKey("templateEmoji"))
        val s = SettingsCodec.decode(obj("""{"providers":[],"recentTemplates":["a","b"],"recentWorlds":[],"recentPersonas":["p"]}"""))
        assertEquals(listOf("a", "b"), s.recentTemplates); assertEquals(listOf("p"), s.recentPersonas)
        assertEquals(JsonArray(listOf(JsonPrimitive("t"), JsonPrimitive("a"))), SettingsCodec.encode(s.copy(recentTemplates = listOf("t", "a")))["recentTemplates"])
        val f = obj("""{"name":"a.pdf","size":1234,"kind":"pdf","text":"x","total":10,"truncated":false,"pages":3}""")
        assertSem(f, AttachmentCodec.encode(AttachmentCodec.decode(f)))
        val sc = AttachmentCodec.encode(com.aichat.app.domain.model.FileAttachment("s.pdf", 9, "pdf", "", 0, scanned = true, imagePages = 4))
        assertEquals(obj("""{"name":"s.pdf","size":9,"kind":"pdf","text":"","total":0,"truncated":false,"scanned":true,"imagePages":4}"""), sc)
    }

    @Test fun libraryEntitiesRoundTrip() {
        val p = obj("""{"id":"p1","emoji":"🤖","name":"n","desc":"","systemPrompt":"s","providerId":"","model":"","temperature":"","builtin":false,"firstMes":"hi","cardRaw":{"spec":"v2"}}""")
        assertSem(p, PersonaCodec.encode(PersonaCodec.decode(p)))
        val t = obj("""{"id":"t","name":"n","emoji":"","content":"c","tags":["a"],"pinned":false,"builtin":true,"skill":false,"x":1}""")
        assertSem(t, TemplateCodec.encode(TemplateCodec.decode(t)))
        val q = obj("""{"id":"q","title":"t","content":"c","builtin":true}""")
        assertSem(q, PromptCodec.encode(PromptCodec.decode(q)))
        val w = obj("""{"id":"w","emoji":"🌍","name":"雨港","desc":"","greeting":"g","blocks":{"world":{"text":"a","enabled":true},"character":{"text":""}},
          "blockHash":{"world":"abc"},"version":3,"changelog":[{"version":3,"at":1,"note":"n"}],"updatedAt":5,"createdAt":1,"openingVariants":["x"]}""")
        assertSem(w, WorldCodec.encode(WorldCodec.decode(w)))
        val m = obj("""{"id":"c","title":"t","providerId":"p","model":"m","updatedAt":5,"personaName":"P","personaEmoji":"e"}""")
        assertSem(m, ConvMetaCodec.encode(ConvMetaCodec.decode(m)))
    }

    @Test fun keyOrderAlignFollowsPrevious() {
        val prev = obj("""{"id":"c","messages":[{"id":"a","role":"user","content":"x","createdAt":1}],"title":"t"}""")
        val next = obj("""{"title":"t2","id":"c","messages":[{"content":"y","createdAt":1,"id":"a","role":"user"},{"id":"b"}]}""")
        val al = KeyOrder.align(next, prev).jsonObject
        assertEquals(listOf("id", "messages", "title"), al.keys.toList())
        assertEquals(listOf("id", "role", "content", "createdAt"), al["messages"]!!.jsonArray[0].jsonObject.keys.toList())
    }

    /** 契约 #s：msg.usage 的 cost 键（JS 名）、未建模键无损；Usage.raw（服务商原始 usage）不落盘 */
    @Test fun usageCostKeyExtrasAndRawNotPersisted() {
        val stored = Js.toJsonObject(Js.parse("""{"prompt":10,"completion":2,"hit":8,"miss":2,"cacheSupported":true,"source":"deepseek","cost":0.0012,"futureKey":{"a":1}}"""))!!
        val u = UsageStoreCodec.decode(stored)
        assertEquals(0.0012, u.costUsd!!, 0.0)
        assertEquals(Js.stringify(Js.sortKeys(Js.fromJson(stored))), Js.stringify(Js.sortKeys(Js.fromJson(UsageStoreCodec.encode(u)))))
        val fromProvider = com.aichat.app.domain.model.Usage(prompt = 10, completion = 2, costUsd = 0.5,
            raw = Js.toJsonObject(Js.parse("""{"prompt_tokens":10,"completion_tokens":2,"cost":0.5}""")))
        val enc = UsageStoreCodec.encode(fromProvider)
        assertEquals(listOf("prompt", "completion", "cost"), enc.keys.toList())
    }
}
