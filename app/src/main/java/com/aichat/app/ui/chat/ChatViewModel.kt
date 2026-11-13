package com.aichat.app.ui.chat

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.CreationExtras
import com.aichat.app.ui.common.UiDeps

/**
 * Activity 级 ViewModel：切 Tab / 开关设置页 / 旋转屏幕时聊天状态（含进行中的流）不丢；
 * 进程被系统杀掉后，靠 SavedStateHandle 记住的对话 id 重新打开同一个对话（输入框草稿由 rememberSaveable 恢复）。
 */
class ChatViewModel(deps: UiDeps, handle: SavedStateHandle) : ViewModel() {
    val controller = ChatController(deps, viewModelScope, restoredConvId = handle.get<String>(KEY_CONV),
        onConvIdChange = { handle[KEY_CONV] = it })

    class Factory(private val deps: UiDeps) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T =
            ChatViewModel(deps, extras.createSavedStateHandle()) as T
    }

    private companion object { const val KEY_CONV = "chat.convId" }
}
