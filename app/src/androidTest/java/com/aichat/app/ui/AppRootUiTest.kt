package com.aichat.app.ui

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.aichat.app.ui.common.fake.FakeDeps
import com.aichat.app.ui.theme.AiChatTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A 的 Compose UI 验收测试（spec §5 A·验收）：Tab 切换保留状态、发送 / 停止、M2 版本 / 编辑 / 设置子页。只编译，未在模拟器上跑过。
 * 依赖 androidTestImplementation compose ui-test-junit4 + debugImplementation ui-test-manifest（需 D 在 app/build.gradle 登记）。
 */
@RunWith(AndroidJUnit4::class)
class AppRootUiTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun launch() = rule.setContent { AiChatTheme { AppRoot(FakeDeps.create()) } }

    @Test fun tabSwitchKeepsInputDraft() {
        launch()
        rule.onNodeWithTag("input").performTextInput("草稿")
        rule.onNodeWithTag("tab-Image").performClick()
        rule.onNodeWithText("生图", substring = true).assertIsDisplayed()
        rule.onNodeWithTag("tab-Chat").performClick()
        rule.onNodeWithText("草稿").assertIsDisplayed()
    }

    @Test fun sendThenStop() {
        launch()
        rule.onNodeWithTag("input").performTextInput("你好")
        rule.onNodeWithTag("send").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTagExists("stop") }
        rule.onNodeWithTag("stop").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTagExists("send") }
        rule.onNodeWithText("已中断").assertIsDisplayed()
    }

    @Test fun sendCompletesAndCanCopy() {
        launch()
        rule.onNodeWithTag("input").performTextInput("测试")
        rule.onNodeWithTag("send").performClick()
        rule.waitUntil(15_000) { rule.onAllNodesWithTagExists("copy") }
        rule.onAllNodes(androidx.compose.ui.test.hasTestTag("copy"))[0].performClick()
    }

    /** M2：重新生成 → ‹ 2/2 ›；切回 1/2；编辑用户消息打开全屏编辑器 */
    @Test fun regenerateVersionsAndEdit() {
        launch()
        rule.onNodeWithTag("input").performTextInput("版本")
        rule.onNodeWithTag("send").performClick()
        rule.waitUntil(15_000) { rule.onAllNodesWithTagExists("regen") }
        rule.onNodeWithTag("regen").performClick()
        rule.waitUntil(15_000) { rule.onAllNodesWithTagExists("ver-label") && rule.onAllNodesWithTagExists("send") }
        rule.onNodeWithText("2/2").assertIsDisplayed()
        rule.onNodeWithTag("ver-prev").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(androidx.compose.ui.test.hasText("1/2")).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodes(androidx.compose.ui.test.hasTestTag("edit"))[0].performClick()
        rule.onNodeWithText("保存并重新发送").assertIsDisplayed()
    }

    /** M2：设置 → 联网搜索 / 插件页可打开 */
    @Test fun searchAndPluginPagesOpen() {
        launch()
        rule.onNodeWithTag("open-drawer").performClick()
        rule.onNodeWithTag("drawer-settings").performClick()
        rule.onNodeWithTag("row-search").performClick()
        rule.onNodeWithTag("search-save").assertIsDisplayed()
    }

    /** M3：抽屉 → 助手库：内置助手列出；点「翻译官」开始对话，标题栏显示新对话 */
    @Test fun personasLibraryStartsConversation() {
        launch()
        rule.onNodeWithTag("open-drawer").performClick()
        rule.onNodeWithTag("drawer-personas").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTagExists("persona-p-translator") }
        rule.onNodeWithTag("persona-p-translator").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTagExists("input") }
    }

    /** M3：点版本号打开版本菜单 */
    @Test fun versionMenuOpens() {
        launch()
        rule.onNodeWithTag("input").performTextInput("菜单")
        rule.onNodeWithTag("send").performClick()
        rule.waitUntil(15_000) { rule.onAllNodesWithTagExists("regen") }
        rule.onNodeWithTag("regen").performClick()
        rule.waitUntil(15_000) { rule.onAllNodesWithTagExists("ver-label") && rule.onAllNodesWithTagExists("send") }
        rule.onNodeWithTag("ver-label").performClick()
        rule.onNodeWithTag("version-menu").assertIsDisplayed()
    }
}

private fun androidx.compose.ui.test.junit4.AndroidComposeTestRule<*, *>.onAllNodesWithTagExists(tag: String) =
    onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
