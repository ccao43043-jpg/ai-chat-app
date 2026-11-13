package com.aichat.app.ui.settings

/**
 * API Key 输入框语义（与旧版 app.js KEY_MASK 一致）：
 * 已存 Key 时输入框预填 [MASK]；保持不变 = 保留原 Key；清空 = 删除；输入新值 = 替换。
 */
object KeyMask {
    const val MASK = "••••••••（已保存）"

    sealed interface Action { data object Keep : Action; data object Delete : Action; data class Replace(val key: String) : Action }

    fun initialText(hasKey: Boolean) = if (hasKey) MASK else ""

    fun resolve(fieldText: String): Action {
        val v = fieldText.trim()
        return when {
            v == MASK -> Action.Keep
            v.isEmpty() -> Action.Delete
            else -> Action.Replace(v)
        }
    }

    /**
     * 用户在掩码上编辑时只保留「新输入的部分」：掩码不是真实 Key，不能和新字符拼在一起。
     * 末尾追加 / 中间插入 / 全选替换 → 取插入的文字；只删不加（退格）→ 清空（= 删除 Key）。
     */
    fun sanitizeEdit(old: String, new: String): String {
        if (old != MASK || new == MASK) return new
        var pre = 0
        while (pre < old.length && pre < new.length && old[pre] == new[pre]) pre++
        var suf = 0
        while (suf < old.length - pre && suf < new.length - pre && old[old.length - 1 - suf] == new[new.length - 1 - suf]) suf++
        return new.substring(pre, new.length - suf)
    }
}
