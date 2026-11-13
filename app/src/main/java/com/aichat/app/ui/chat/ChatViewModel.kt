package com.aichat.app.ui.chat

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.aichat.app.ui.common.UiDeps

/** Activity 级 ViewModel：切 Tab / 开关设置页时聊天状态（含进行中的流）不丢 */
class ChatViewModel(deps: UiDeps) : ViewModel() {
    val controller = ChatController(deps, viewModelScope)

    class Factory(private val deps: UiDeps) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T = ChatViewModel(deps) as T
    }
}
