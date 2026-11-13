package com.aichat.app.plugins.usage

import com.aichat.app.domain.Badge
import com.aichat.app.domain.ChatPlugin
import com.aichat.app.domain.model.*
import com.aichat.app.plugins.js.Js

/** www/rp-plugin.js 末尾的 usage 插件（Token 用量徽章；默认关闭） */
class UsagePlugin : ChatPlugin {
    override val id = "usage"
    override val name = "Token 用量显示"
    override val defaultEnabled = false
    override val perConversation = false
    override fun messageBadges(msg: Message, conv: Conversation): List<Badge> {
        val u = msg.usage
        if (msg.role != Role.ASSISTANT || u?.prompt == null) return emptyList()
        val c = (u.completion ?: 0L).toDouble()
        return listOf(Badge(id, "输入 " + fmtN(u.prompt.toDouble()) + " · 输出 " + fmtN(c), "info", "输入 " + Js.numToString(u.prompt.toDouble()) + " Token / 输出 " + Js.numToString(c) + " Token"))
    }
    companion object {
        /** rp-plugin.js fmtN */
        fun fmtN(n: Double?): String = when {
            n == null -> "—"
            n >= 1e8 -> Js.toFixed(n / 1e8, 2) + "亿"
            n >= 1e4 -> Js.replace(Js.re("\\.?0+$"), Js.toFixed(n / 1e4, if (n >= 1e5) 1 else 2), false, "") + "万"
            else -> Js.numToString(Js.round(n))
        }
    }
}
