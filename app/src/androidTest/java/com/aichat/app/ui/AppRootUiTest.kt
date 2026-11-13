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
 * A 的 Compose UI 验收测试（spec §5 A·验收）：Tab 切换保留状态、发送 / 停止。
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
        rule.onNodeWithTag("copy").performClick()
    }
}

private fun androidx.compose.ui.test.junit4.AndroidComposeTestRule<*, *>.onAllNodesWithTagExists(tag: String) =
    onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
