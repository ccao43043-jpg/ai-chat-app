package com.aichat.app.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val Accent = Color(0xFF5B4CF0)   // 与旧版 colorAccent 一致

@Composable
fun AiChatTheme(content: @Composable () -> Unit) {
    val scheme = if (isSystemInDarkTheme()) darkColorScheme(primary = Accent) else lightColorScheme(primary = Accent)
    MaterialTheme(colorScheme = scheme, content = content)
}
