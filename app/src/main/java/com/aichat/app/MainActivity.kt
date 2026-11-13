package com.aichat.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.aichat.app.ui.AppRoot
import com.aichat.app.ui.theme.AiChatTheme

/** 组件名保持 com.aichat.app.MainActivity，桌面图标/快捷方式覆盖安装后不失效 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val deps = (application as AiChatApp).graph.uiDeps()
        setContent { AiChatTheme { AppRoot(deps) } }
    }
}
