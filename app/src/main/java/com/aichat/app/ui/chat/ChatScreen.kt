package com.aichat.app.ui.chat

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

/** 占位（工作流 A）：对话列表抽屉 + 消息列表 + 输入区 + 版本切换 + 编辑 + 用量浮层，依赖 ChatRepository / ChatEngine。 */
@Composable
fun ChatScreen() {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("聊天", style = MaterialTheme.typography.headlineMedium)
        Text("原生 v1.0.0 骨架 · 待工作流 A 实现", style = MaterialTheme.typography.bodyMedium)
    }
}
