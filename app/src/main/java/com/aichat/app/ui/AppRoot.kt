package com.aichat.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Face
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import com.aichat.app.ui.chat.ChatScreen
import com.aichat.app.ui.image.ImageScreen

/** 底部固定两个 Tab（需求 4）。顺序与文案不可改：聊天 / 生图。 */
enum class MainTab(val label: String, val icon: ImageVector) {
    Chat("聊天", Icons.Filled.Edit),
    Image("生图", Icons.Filled.Face),
}

@Composable
fun AppRoot() {
    var tab by rememberSaveable { mutableStateOfTab() }
    Scaffold(
        bottomBar = {
            NavigationBar {
                MainTab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t,
                        onClick = { tab = t },
                        icon = { Icon(t.icon, contentDescription = t.label) },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { inner ->
        Box(Modifier.padding(inner)) {
            when (tab) {
                MainTab.Chat -> ChatScreen()
                MainTab.Image -> ImageScreen()
            }
        }
    }
}

private fun mutableStateOfTab() = androidx.compose.runtime.mutableStateOf(MainTab.Chat)
