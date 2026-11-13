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

    private fun make(delayMs: Long = 2): Pair<ChatController, ChatRepository> {
        val deps = FakeDeps.create(DataGraph.inMemory(), engineDelayMs = delayMs)
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
        assertNull(c.regenerateNeedsConfirm(aid))
        c.regenerate(aid); until { c.state.value.isStreaming }; c.idle()
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
        assertNotNull(c.regenerateNeedsConfirm(a1))
        c.regenerate(a1); until { c.state.value.isStreaming }; c.idle()
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
}
