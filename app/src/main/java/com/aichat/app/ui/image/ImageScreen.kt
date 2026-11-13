package com.aichat.app.ui.image

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

/** 占位（工作流 B）：服务商/模型选择、尺寸、参考图、生成、历史（10 条）、保存到相册；依赖 ImageClient。 */
@Composable
fun ImageScreen() {
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text("生图", style = MaterialTheme.typography.headlineMedium)
        Text("原生 v1.0.0 骨架 · 待工作流 B 实现", style = MaterialTheme.typography.bodyMedium)
    }
}
