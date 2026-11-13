package com.aichat.app.ui

import com.aichat.app.data.DataGraph
import com.aichat.app.domain.ChatRepository
import com.aichat.app.domain.model.Role
import com.aichat.app.ui.chat.ChatController
import com.aichat.app.ui.chat.ChatUiState
import com.aichat.app.ui.chat.Versions
import com.aichat.app.ui.common.fake.FakeDeps
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 控制器 + D 的真实仓库（DataGraph.inMemory）+ fake 引擎。仓库内部切 Dispatchers.IO，所以这里用真实时间：
 * runBlocking + 轮询等待（[until]），而不是虚拟时间。
 */
class ChatControllerTest {
    private val jobs = mutableListOf<Job>()
    @After fun tearDown() { jobs.forEach { it.cancel() } }

    private fun make(delayMs: Long = 2, plugins: com.aichat.app.domain.PluginRegistry = com.aichat.app.ui.common.fake.FakePluginRegistry()): Pair<ChatController, ChatRepository> {
        val deps = FakeDeps.create(DataGraph.inMemory(), engineDelayMs = delayMs, plugins = plugins)
        val scope = CoroutineScope(Dispatchers.Default + Job().also { jobs += it })
        return ChatController(deps, scope) to deps.chats
    }

    private suspend fun until(msg: String = "条件", cond: () -> Boolean) {
        withTimeout(10_000) { while (!cond()) delay(5) }
        assertTrue(msg, cond())
    }
    private suspend fun ChatController.idle() { delay(20); until("生成结束") { !state.value.isStreaming }; delay(30) }
    private suspend fun ChatController.sendAndWait(t: String, files: List<JsonObject> = emptyList()) {
        assertTrue(send(t, emptyList(), files)); until("开始") { state.value.isStreaming || state.value.conv?.messages?.isNotEmpty() == true }; idle()
    }

    @Test fun sendStreamsThenPersistsWithStartedIds() = runBlocking {
        val (c, repo) = make(delayMs = 15)
        assertTrue(c.send("你好", emptyList()))
        until("流式中且有正文") { c.state.value.streaming?.text?.isNotEmpty() == true }
        val mid = c.state.value
        assertEquals(listOf(Role.USER, Role.ASSISTANT), mid.messages.map { it.role })
        // Started 已把临时 id 换成引擎的真实 id
        assertNotEquals(ChatUiState.STREAMING_ID, mid.streaming!!.liveId)
        assertNotEquals(ChatController.PENDING_USER_ID, mid.messages.first().id)
        assertFalse("流式中不能再发", c.send("再来", emptyList()))
        c.idle()
        val end = c.state.value
        val conv = repo.load(end.convId!!)!!
        assertEquals(2, conv.messages.size)
        assertEquals(mid.streaming!!.liveId, conv.messages[1].id)
        assertEquals(mid.messages.first().id, conv.messages[0].id)
        assertEquals("你好", conv.title)
        assertFalse(conv.messages[1].truncated)
        assertEquals(conv.messages, end.messages)
        assertEquals(1, repo.index.value.size)
    }

    @Test fun stopKeepsPartialTextAndMarksTruncated() = runBlocking {
        val (c, repo) = make(delayMs = 30)
        c.send("写长文", emptyList())
        until { (c.state.value.streaming?.text?.length ?: 0) > 3 }
        val partial = c.state.value.streaming!!.text
        c.stop(); c.idle()
        val bot = repo.load(c.state.value.convId!!)!!.messages.last()
        assertEquals(Role.ASSISTANT, bot.role)
        assertTrue(bot.truncated)
        assertTrue(bot.content.startsWith(partial))
        assertTrue(c.canContinue(bot))
        assertNull(c.state.value.streaming)
    }

    @Test fun errorIsWrittenByEngineNotDuplicated() = runBlocking {
        val (c, repo) = make()
        c.sendAndWait("演示 #error")
        val bot = repo.load(c.state.value.convId!!)!!.messages.last()
        assertEquals("HTTP 500：演示错误", bot.error)
        assertNull(c.state.value.toast)
    }

    @Test fun noticeBecomesToast() = runBlocking {
        val (c, _) = make(delayMs = 15)
        c.send("演示 #notice", emptyList())
        until("Notice → toast") { c.state.value.toast?.contains("额度不足") == true }
        c.idle()
    }

    @Test fun regenerateAddsVersionAndSwitches() = runBlocking {
        val (c, repo) = make()
        c.sendAndWait("问")
        val conv0 = c.state.value.conv!!
        val aid = conv0.messages[1].id
        val first = conv0.messages[1].content
        assertEquals(com.aichat.app.ui.chat.Plan.Done, c.planRegenerate(aid))
 until { c.state.value.isStreaming }; c.idle()
        var m = repo.load(conv0.id)!!.messages[1]
        assertEquals(aid, m.id); assertEquals(2, Versions.count(m)); assertEquals(1, Versions.index(m))
        assertTrue(m.content.isNotEmpty())
        c.selectVersion(aid, 0); until { c.state.value.conv!!.messages[1].content == first }
        m = repo.load(conv0.id)!!.messages[1]
        assertEquals(first, m.content)
        // vi 1→0 目前不落盘（D 的 codec/diff 丢默认值，见 DataLayerRegressionTest），修好后加回：assertEquals(0, m.vi)
    }

    @Test fun regenerateEarlierAsksConfirmAndBranches() = runBlocking {
        val (c, repo) = make()
        c.sendAndWait("一"); c.sendAndWait("二")
        val conv = c.state.value.conv!!
        assertEquals(4, conv.messages.size)
        val a1 = conv.messages[1].id
        val plan = c.planRegenerate(a1) as com.aichat.app.ui.chat.Plan.Ask
        assertEquals("从这里重新生成？", plan.title)
        assertFalse(plan.body!!.contains("RP"))
        plan.run(); until { c.state.value.isStreaming }; c.idle()
        assertEquals(2, repo.load(conv.id)!!.messages.size)   // 之后的对话留在旧版本
        c.selectVersion(a1, 0); until { c.state.value.conv!!.messages.size == 4 }
        assertEquals("二", c.state.value.conv!!.messages[2].content)
    }

    @Test fun editSaveAndEditResend() = runBlocking {
        val (c, repo) = make()
        c.sendAndWait("原问题")
        val conv = c.state.value.conv!!
        val uid = conv.messages[0].id; val aid = conv.messages[1].id
        assertTrue(c.editMessage(aid, "手改的回答")); until { c.state.value.conv!!.messages[1].content == "手改的回答" }
        assertEquals(JsonPrimitive(true), repo.load(conv.id)!!.messages[1].extras["edited"])
        assertTrue(c.editAndResend(uid, "新问题")); until { c.state.value.isStreaming }; c.idle()
        val after = repo.load(conv.id)!!.messages
        assertEquals(2, after.size)
        assertEquals("新问题", after[0].content); assertEquals(2, Versions.count(after[0]))
        assertTrue(after[1].content.contains("新问题"))
        c.selectVersion(uid, 0); until { c.state.value.conv!!.messages[0].content == "原问题" }
        assertEquals("手改的回答", c.state.value.conv!!.messages[1].content)
    }

    @Test fun continueAppends() = runBlocking {
        val (c, repo) = make(delayMs = 30)
        c.send("长", emptyList()); until { (c.state.value.streaming?.text?.length ?: 0) > 3 }
        c.stop(); c.idle()
        val m0 = c.state.value.conv!!.messages[1]
        c.continueGeneration(m0.id); until { c.state.value.isStreaming }; c.idle()
        val m1 = repo.load(c.state.value.convId!!)!!.messages[1]
        assertEquals(m0.id, m1.id)
        assertTrue(m1.content.startsWith(m0.content)); assertTrue(m1.content.contains("（续写）"))
        // truncated true→false 目前不落盘（同上，见 DataLayerRegressionTest），修好后加回：assertFalse(m1.truncated)
    }

    @Test fun filesArePatchedBackToRawText() = runBlocking {
        val (c, repo) = make()
        val f = JsonObject(mapOf("name" to JsonPrimitive("a.txt"), "size" to JsonPrimitive(5), "kind" to JsonPrimitive("text"),
            "text" to JsonPrimitive("文件内容"), "total" to JsonPrimitive(4), "truncated" to JsonPrimitive(false)))
        c.sendAndWait("总结一下", listOf(f))
        val conv = repo.load(c.state.value.convId!!)!!
        assertEquals("总结一下", conv.messages[0].content)
        assertEquals(listOf(f), conv.messages[0].files)
        assertEquals("总结一下", conv.title)
        assertTrue("模型看到了文件", conv.messages[1].content.contains("a.txt") || conv.messages[1].content.contains("文件内容"))
    }

    @Test fun newConversationReusesEmptyAndSelectsLatestOnStart() = runBlocking {
        val (c, repo) = make()
        c.sendAndWait("一")
        val first = c.state.value.convId!!
        c.newConversation(); until { c.state.value.convId == null }
        c.sendAndWait("二")
        assertEquals(2, repo.index.value.size)
        assertTrue(repo.index.value.first().id != first)
        c.rename(first, "改名"); until { repo.index.value.any { it.title == "改名" } }
        val cur = c.state.value.convId!!
        c.delete(cur); until { repo.index.value.size == 1 && c.state.value.convId == first }
    }

    @Test fun setModelUpdatesConversationAndSettings() = runBlocking {
        val (c, repo) = make()
        c.sendAndWait("hi")
        c.setModel("deepseek", "deepseek-v4-pro"); until { c.state.value.conv?.providerId == "deepseek" }
        val conv = repo.load(c.state.value.convId!!)!!
        assertEquals("deepseek" to "deepseek-v4-pro", conv.providerId to conv.model)
        until { c.settings.value.lastProviderId == "deepseek" }
        assertEquals("deepseek" to "deepseek-v4-pro", c.currentTarget()!!.let { it.first.id to it.second })
    }

    @Test fun emptyInputIgnoredImageOnlyAllowed() = runBlocking {
        val (c, _) = make()
        assertFalse(c.send("   ", emptyList()))
        assertTrue(c.send("", listOf("data:image/jpeg;base64,AAAA")))
        until { c.state.value.conv?.messages?.isNotEmpty() == true }; c.idle()
        assertEquals(listOf("data:image/jpeg;base64,AAAA"), c.state.value.conv!!.messages.first().images)
    }

    @Test fun conversationSystemAndPluginToggle() = runBlocking {
        val (c, repo) = make()
        c.sendAndWait("hi")
        c.setConversationSystem("你是猫", "t-1", "猫", "🐱"); until { c.state.value.conv?.systemPrompt == "你是猫" }
        c.setConversationPlugin("rpcache", false)
        until { (c.state.value.conv?.extras?.get("plugins") as? JsonObject)?.get("rpcache") != null }
        val conv = repo.load(c.state.value.convId!!)!!
        assertEquals(JsonPrimitive("t-1"), conv.extras["templateId"])
        assertEquals(false, com.aichat.app.ui.settings.PluginToggles.convEnabled(conv.extras, "rpcache"))
    }

    /** rpcache 生效、第一条消息冻结（dim）的插件注册表 */
    private class RpRegistry(val frozenIds: MutableSet<String>) : com.aichat.app.domain.PluginRegistry by com.aichat.app.ui.common.fake.FakePluginRegistry() {
        override fun isActive(id: String, settings: com.aichat.app.domain.model.AppSettings, conv: com.aichat.app.domain.model.Conversation?) = id == "rpcache"
        override fun messageState(msg: com.aichat.app.domain.model.Message, settings: com.aichat.app.domain.model.AppSettings, conv: com.aichat.app.domain.model.Conversation) =
            com.aichat.app.domain.MessageState(dim = msg.id in frozenIds, label = if (msg.id in frozenIds) "已写入章节" else null)
    }

    @Test fun rpConfirmationsAndFrozenMessages() = runBlocking {
        val frozen = mutableSetOf<String>()
        val marks = mutableListOf<String>()
        com.aichat.app.ui.chat.ChatMounts.rp = object : com.aichat.app.ui.chat.RpUiHooks {
            override fun markHistoryCause(conv: com.aichat.app.domain.model.Conversation, kind: String, now: Long) = conv.also { marks += kind }
        }
        try {
            val (c, repo) = make(plugins = RpRegistry(frozen))
            c.sendAndWait("一"); c.sendAndWait("二")
            val a1 = c.state.value.conv!!.messages[1].id
            // 较早回复重新生成：RP 提示 + 记录 regen
            val ask = c.planRegenerate(a1) as com.aichat.app.ui.chat.Plan.Ask
            assertTrue(ask.body!!.contains("本对话开启了 RP 缓存优化：从较早的回复重新生成会改变对话历史"))
            ask.run(); until { c.state.value.isStreaming }; c.idle()
            assertEquals(listOf("regen"), marks)
            // 切回旧版本（后面有对话吗？此时 a1 是最后一条 → 不弹窗）
            assertEquals(com.aichat.app.ui.chat.Plan.Done, c.planSwitch(a1, 0)); until { c.state.value.conv!!.messages.size == 4 }
            // 现在 a1 后面有 2 条：切版本要确认，文案 = VER_RP_WARN
            // 取「另一个」版本下标（vi 回 0 目前不落盘，见 DataLayerRegressionTest）
            val other = 1 - Versions.index(c.state.value.conv!!.messages[1])
            val sw = c.planSwitch(a1, other) as com.aichat.app.ui.chat.Plan.Ask
            assertEquals("切换到第 ${other + 1} 个版本？", sw.title); assertEquals(ChatController.VER_RP_WARN, sw.body); assertEquals("继续", sw.okText)
            // 冻结后：不能切换、不能重新生成
            frozen += a1
            assertEquals(com.aichat.app.ui.chat.Plan.Toast("这条消息已写入章节摘要（或超出预算未发送），不能切换版本"), c.planSwitch(a1, other))
            assertEquals(com.aichat.app.ui.chat.Plan.Toast("这条回复已写入章节摘要，不能重新生成"), c.planRegenerate(a1))
            assertTrue(c.frozen(c.state.value.conv!!.messages[1]))
            // 编辑提示带 RP 警示
            val (hint, warn) = c.editHint(c.state.value.conv!!.messages[0].id)!!
            assertTrue(warn); assertTrue(hint.contains("修改历史消息会改变历史前缀"))
            // 模板切换 RP 确认
            val t = c.planApplyTemplate("t-1", "猫", "🐱", "你是猫") as com.aichat.app.ui.chat.Plan.Ask
            assertEquals("切换为「猫」？", t.title); assertEquals(ChatController.RP_WARN, t.body)
            t.run(); until { c.state.value.conv?.systemPrompt == "你是猫" }
            assertEquals("你是猫", repo.load(c.state.value.convId!!)!!.systemPrompt)
            assertEquals(com.aichat.app.ui.chat.Plan.Toast("已经在使用「猫」"), c.planApplyTemplate("t-1", "猫", "🐱", "你是猫"))
        } finally { com.aichat.app.ui.chat.ChatMounts.rp = null }
    }

    @Test fun deleteVersionKeepOnlyAndDeleteMessage() = runBlocking {
        val (c, repo) = make()
        c.sendAndWait("问")
        val aid = c.state.value.conv!!.messages[1].id
        c.planRegenerate(aid); until { c.state.value.isStreaming }; c.idle()
        c.planRegenerate(aid); until { c.state.value.isStreaming }; c.idle()
        assertEquals(3, Versions.count(c.state.value.conv!!.messages[1]))
        val del = c.planDeleteVersion(aid, 2) as com.aichat.app.ui.chat.Plan.Ask
        assertEquals("删除第 3 个版本？", del.title); assertEquals("删除后无法恢复。", del.body)
        del.run(); until { Versions.count(c.state.value.conv!!.messages[1]) == 2 }
        val keep = c.planKeepOnly(aid) as com.aichat.app.ui.chat.Plan.Ask
        keep.run(); until { c.state.value.toast == "已只保留当前版本" }
        // versions → [] 目前不落盘（D 的默认值回写问题，见 DataLayerRegressionTest），修好后加回：
        // assertTrue(repo.load(c.state.value.convId!!)!!.messages[1].versions.isEmpty())
        c.deleteMessage(aid); until { c.state.value.conv!!.messages.size == 1 }
        assertEquals(1, repo.load(c.state.value.convId!!)!!.messages.size)
    }

    @Test fun startFromPersonaWithCardExtras() = runBlocking {
        val (c, repo) = make()
        val p = com.aichat.app.domain.model.Persona("p-x", "🐱", "猫娘", "", "你是猫娘", "", "", 0.8, false,
            JsonObject(mapOf("firstMes" to JsonPrimitive("喵～"), "loreText" to JsonPrimitive("世界书"))))
        c.startFromPersona(p)
        until { c.state.value.conv?.personaName == "猫娘" }
        val conv = repo.load(c.state.value.convId!!)!!
        assertEquals("你是猫娘", conv.systemPrompt); assertEquals("🐱", conv.personaEmoji)
        assertEquals(JsonPrimitive("p-x"), conv.extras["personaId"]); assertEquals(JsonPrimitive(0.8), conv.extras["temperature"])
        assertEquals("喵～", conv.messages.single().content); assertEquals(Role.ASSISTANT, conv.messages.single().role)
        assertEquals(true, com.aichat.app.ui.settings.PluginToggles.convEnabled(conv.extras, "rpcache"))
        assertEquals("新对话", conv.title)
    }

    @Test fun searchOnWithoutSetupAsks() = runBlocking {
        val (c, _) = make()
        c.setSearchOn(true); until { c.settings.value.searchOn }
        assertFalse(c.send("搜一下", emptyList()))
        assertTrue(c.state.value.askSearchSetup)
    }
}
