package com.aichat.app.data.fake

import com.aichat.app.domain.*
import com.aichat.app.domain.model.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.serialization.json.JsonObject

/** B 的 ChatEngine 接线前的占位：任何发送都立即返回 Error（UI 可据此显示「引擎未接线」） */
object UnwiredChatEngine : ChatEngine {
    private fun err() = flowOf<StreamEvent>(StreamEvent.Error(0, "聊天引擎未接线（等待 B 的 ChatEngine）", ""))
    override fun send(convId: String, userText: String, images: List<String>, files: List<com.aichat.app.domain.model.FileAttachment>): Flow<StreamEvent> = err()
    override fun regenerate(convId: String, assistantMsgId: String) = err()
    override fun continueGeneration(convId: String, assistantMsgId: String) = err()
    override fun stop(convId: String) {}
}

/** C 的 PluginRegistry 接线前的占位：没有插件，原样放行 */
object EmptyPluginRegistry : PluginRegistry {
    override val plugins: List<ChatPlugin> = emptyList()
    override fun isActive(id: String, settings: AppSettings, conv: Conversation?) = false
    override suspend fun runBeforeRequest(ctx: RequestContext, status: (String?) -> Unit) = ctx
    override fun runAfterResponse(ctx: RequestContext, result: TurnResult) = ctx.conv
    override fun messageBadges(msg: Message, settings: AppSettings, conv: Conversation) = emptyList<Badge>()
    override fun headerBadges(settings: AppSettings, conv: Conversation) = emptyList<Badge>()
    override fun messageState(msg: Message, settings: AppSettings, conv: Conversation) = MessageState()
    override val errors: StateFlow<List<JsonObject>> = MutableStateFlow(emptyList())
}
