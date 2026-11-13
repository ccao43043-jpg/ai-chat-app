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
import kotlinx.coroutines.launch
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
        assertEquals(0, m.vi)
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
        assertFalse(m1.truncated)
    }

    @Test fun filesGoToEngineAsAttachments() = runBlocking {
        val (c, repo) = make()
        val f = JsonObject(mapOf("name" to JsonPrimitive("a.txt"), "size" to JsonPrimitive(5), "kind" to JsonPrimitive("text"),
            "text" to JsonPrimitive("文件内容"), "total" to JsonPrimitive(4), "truncated" to JsonPrimitive(false)))
        c.sendAndWait("总结一下", listOf(f))
        val conv = repo.load(c.state.value.convId!!)!!
        assertEquals("总结一下", conv.messages[0].content)
        assertEquals(listOf(f), conv.messages[0].files)
        assertEquals("总结一下", conv.title)
        // 契约 #m：文件交给引擎（files 参数），请求时由引擎展开（B 的 ChatEngineTest 覆盖）；UI 不再把文件文字并进正文
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
        assertEquals("t-1", conv.templateId)   // 契约 #o：类型化字段
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
        assertTrue(repo.load(c.state.value.convId!!)!!.messages[1].versions.isEmpty())
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

    // ---------------- M4 ----------------

    /** 引擎照 JS 对齐后：单版本失败的最后一条回复重试 = 删旧建新，Started 带新 assistantMsgId */
    @Test fun failedSingleVersionRegenerateFollowsNewIdFromStarted() = runBlocking {
        val (c, repo) = make(delayMs = 5)
        c.sendAndWait("问")
        val base = c.state.value.conv!!
        val conv = repo.create(base.providerId, base.model, "失败的对话")
        val user = base.messages[0].copy(id = "u-fail")
        val bad = com.aichat.app.domain.model.Message("a-fail", Role.ASSISTANT, "", 1L, error = "HTTP 500：演示错误")
        repo.save(conv.copy(messages = listOf(user, bad)))
        c.select(conv.id); until("载入失败对话") { c.state.value.conv?.messages?.lastOrNull()?.error != null }

        val seenOldWhileStreaming = java.util.concurrent.atomic.AtomicBoolean(false)
        val liveIds = java.util.Collections.synchronizedSet(mutableSetOf<String>())
        val watch = CoroutineScope(Dispatchers.Default + Job().also { jobs += it }).launch {
            c.state.collect { st -> st.streaming?.let { s ->
                liveIds.add(s.liveId)
                if (s.liveId != "a-fail" && st.messages.any { it.id == "a-fail" }) seenOldWhileStreaming.set(true)
            } }
        }
        assertEquals(com.aichat.app.ui.chat.Plan.Done, c.planRegenerate("a-fail"))
        until { c.state.value.isStreaming }
        until("收到 Started 的新 id") { c.state.value.streaming?.liveId?.let { it != "a-fail" } ?: true }
        val mid = c.state.value
        if (mid.isStreaming) {
            assertEquals(listOf("u-fail", mid.streaming!!.liveId), mid.messages.map { it.id })
            assertNull("旧消息的字段不能带进新消息", mid.messages.last().error)
        }
        c.idle(); watch.cancel()
        val saved = repo.load(conv.id)!!.messages
        assertEquals(2, saved.size)
        assertNotEquals("a-fail", saved[1].id)
        assertTrue(saved[1].content.isNotEmpty()); assertNull(saved[1].error)
        assertTrue(saved[1].id in liveIds)
        assertFalse("流式中不应再显示被删掉的旧消息", seenOldWhileStreaming.get())
        assertEquals(saved, c.state.value.messages)
    }

    /** 流式吞吐：Delta 按 FLUSH_MS 合并成一次状态更新；流期间已存在的条目（stable）引用不变 */
    @Test fun deltasAreCoalescedAndStableListIsStable() = runBlocking {
        val (c, _) = make(delayMs = 1)
        c.sendAndWait("热身")
        val texts = java.util.Collections.synchronizedList(mutableListOf<String>())
        val bases = java.util.Collections.synchronizedSet(java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Any, Boolean>()))
        val watch = CoroutineScope(Dispatchers.Default + Job().also { jobs += it }).launch {
            c.state.collect { st -> st.streaming?.let { s -> if (texts.lastOrNull() != s.text) texts += s.text; if (s.liveId != ChatUiState.STREAMING_ID) bases.add(s.base) } }
        }
        val t0 = System.currentTimeMillis()
        assertTrue(c.send("写一段长一点的", emptyList()))
        until { c.state.value.isStreaming }; c.idle(); watch.cancel()
        val elapsed = System.currentTimeMillis() - t0
        val final = c.state.value.conv!!.messages.last().content
        assertTrue(final.isNotEmpty())
        assertTrue("文本更新 ${texts.size} 次，用时 ${elapsed}ms", texts.size <= elapsed / ChatController.FLUSH_MS + 4)
        assertEquals("整个流期间 base 是同一个列表实例", 1, bases.size)
    }

    /** 进程被杀后恢复：用 SavedStateHandle 记住的对话 id 打开同一对话；id 已不存在时退回最近对话 */
    @Test fun restoresConversationAfterProcessDeath() = runBlocking {
        val deps = FakeDeps.create(DataGraph.inMemory(), engineDelayMs = 1)
        val scope = CoroutineScope(Dispatchers.Default + Job().also { jobs += it })
        val saved = java.util.concurrent.atomic.AtomicReference<String?>(null)
        val c1 = ChatController(deps, scope, onConvIdChange = { saved.set(it) })
        c1.sendAndWait("第一个")
        val firstId = c1.state.value.convId!!
        c1.newConversation(); c1.sendAndWait("第二个")
        assertNotEquals(firstId, c1.state.value.convId)
        c1.select(firstId); until { saved.get() == firstId }

        val c2 = ChatController(deps, scope, restoredConvId = saved.get())
        until("恢复到同一对话") { c2.state.value.conv?.id == firstId }
        val c3 = ChatController(deps, scope, restoredConvId = "gone")
        until("不存在则打开最近") { c3.state.value.conv != null }
        assertNotEquals("gone", c3.state.value.convId)
    }
}
