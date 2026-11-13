package com.aichat.app.ui

import com.aichat.app.domain.model.Role
import com.aichat.app.ui.chat.ChatController
import com.aichat.app.ui.chat.ChatUiState
import com.aichat.app.ui.common.UiDeps
import com.aichat.app.ui.common.fake.FakeChatEngine
import com.aichat.app.ui.common.fake.FakeChatRepository
import com.aichat.app.ui.common.fake.FakeKeyVault
import com.aichat.app.ui.common.fake.FakeLibraryRepository
import com.aichat.app.ui.common.fake.FakeMigrationService
import com.aichat.app.ui.common.fake.FakePluginRegistry
import com.aichat.app.ui.common.fake.FakeSettingsRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import org.junit.After
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class ChatControllerTest {
    private val jobs = mutableListOf<Job>()
    @After fun tearDown() { jobs.forEach { it.cancel() } }

    private fun TestScope.make(): Pair<ChatController, FakeChatRepository> {
        val repo = FakeChatRepository { testScheduler.currentTime }
        val keys = FakeKeyVault()
        val deps = UiDeps(repo, FakeSettingsRepository().also { it.keys = keys }, FakeLibraryRepository(), keys,
            FakeChatEngine(repo, chunkDelayMs = 10) { testScheduler.currentTime }, FakePluginRegistry(), FakeMigrationService(), isFake = true)
        // 不用 backgroundScope：advanceUntilIdle 不推进后台任务。测试结束时取消 job。
        val scope = CoroutineScope(StandardTestDispatcher(testScheduler) + Job().also { jobs += it })
        return ChatController(deps, scope) { testScheduler.currentTime } to repo
    }

    @Test fun sendStreamsThenPersists() = runTest {
        val (c, repo) = make()
        assertTrue(c.send("你好", emptyList()))
        runCurrent(); advanceTimeBy(100); runCurrent()
        val mid = c.state.value
        assertTrue(mid.isStreaming)
        assertEquals(listOf(Role.USER, Role.ASSISTANT), mid.messages.map { it.role })
        assertEquals(ChatUiState.STREAMING_ID, mid.messages.last().id)
        assertTrue(mid.messages.last().content.isNotEmpty())
        assertFalse("流式中不能再发", c.send("再来", emptyList()))
        advanceUntilIdle()
        val end = c.state.value
        assertFalse(end.isStreaming)
        val conv = repo.load(end.convId!!)!!
        assertEquals(2, conv.messages.size)
        assertEquals("你好", conv.title)
        assertFalse(conv.messages[1].truncated)
        assertEquals(conv.messages, end.messages)
        assertEquals(1, repo.index.value.size)
    }

    @Test fun stopKeepsPartialTextAndMarksTruncated() = runTest {
        val (c, repo) = make()
        c.send("写长文", emptyList())
        runCurrent(); advanceTimeBy(80); runCurrent()
        val partial = c.state.value.streaming!!.text
        assertTrue(partial.isNotEmpty())
        c.stop(); advanceUntilIdle()
        val conv = repo.load(c.state.value.convId!!)!!
        val bot = conv.messages.last()
        assertEquals(Role.ASSISTANT, bot.role)
        assertTrue(bot.truncated)
        assertEquals(partial, bot.content)
        assertNull(c.state.value.streaming)
    }

    @Test fun newConversationReusesEmptyAndSelectsLatestOnStart() = runTest {
        val (c, repo) = make()
        c.send("一", emptyList()); advanceUntilIdle()
        val first = c.state.value.convId!!
        c.newConversation()
        assertNull(c.state.value.convId)
        c.send("二", emptyList()); advanceUntilIdle()
        assertEquals(2, repo.index.value.size)
        assertTrue(repo.index.value.first().id != first)
        c.rename(first, "改名"); advanceUntilIdle()
        assertEquals("改名", repo.load(first)!!.title)
        val cur = c.state.value.convId!!
        c.delete(cur); advanceUntilIdle()
        assertEquals(1, repo.index.value.size)
        assertEquals(first, c.state.value.convId)
    }

    @Test fun setModelUpdatesConversationAndSettings() = runTest {
        val (c, repo) = make()
        c.send("hi", emptyList()); advanceUntilIdle()
        c.setModel("deepseek", "deepseek-v4-pro"); advanceUntilIdle()
        val conv = repo.load(c.state.value.convId!!)!!
        assertEquals("deepseek" to "deepseek-v4-pro", conv.providerId to conv.model)
        assertEquals("deepseek" to "deepseek-v4-pro", c.currentTarget()!!.let { it.first.id to it.second })
        assertEquals("deepseek", c.settings.value.lastProviderId)
    }

    @Test fun emptyInputIgnored() = runTest {
        val (c, _) = make()
        assertFalse(c.send("   ", emptyList()))
        assertTrue(c.send("", listOf("data:image/jpeg;base64,AAAA")))
        advanceUntilIdle()
        assertNotNull(c.state.value.conv)
        assertEquals(listOf("data:image/jpeg;base64,AAAA"), c.state.value.conv!!.messages.first().images)
    }
}
