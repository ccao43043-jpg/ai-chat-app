package com.aichat.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import com.aichat.app.ui.AppRoot
import com.aichat.app.ui.common.fake.FakeDeps
import com.aichat.app.ui.theme.AiChatTheme

/** 组件名保持 com.aichat.app.MainActivity，桌面图标/快捷方式覆盖安装后不失效 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // TODO(D)：AppGraph 提供真实仓库 / 引擎后，改为 (application as AiChatApp).graph.uiDeps()
        val deps = uiDeps
        setContent { AiChatTheme { AppRoot(deps) } }
    }

    private companion object {
        /** 进程级单例：fake 数据在 Activity 重建后仍在（真实实现由 AppGraph 持有） */
        val uiDeps by lazy { FakeDeps.create() }
    }
}
