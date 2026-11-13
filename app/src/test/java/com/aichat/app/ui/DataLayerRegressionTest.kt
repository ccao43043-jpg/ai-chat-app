package com.aichat.app.ui

import com.aichat.app.data.DataGraph
import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.Role
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Ignore
import org.junit.Test

/**
 * A 发现的数据层问题复现（归 D 修）：字段从非默认值改回默认值（已确认 truncated true→false、vi 1→0；error→null 未单独验证）后 save，
 * load 回来仍是旧值——MessageCodec 编码时省略默认值，conv-log diff 把「键缺失」当成「没变」。
 * 影响：版本切回第 1 个时 ‹1/2› 显示错误；续写成功后「已中断」标记不消失。已由 D f76fd4f / 334e023 修复（D5：缺失键显式写 null）。
 */
class DataLayerRegressionTest {
    @Test fun revertToDefaultPersists() = runBlocking {
        val d = DataGraph.inMemory()
        val c = d.chats.create("p", "m")
        val m = Message("m1", Role.ASSISTANT, "hi", 1, truncated = true, error = "e", vi = 1, versions = listOf(null, null))
        d.chats.save(c.copy(messages = listOf(m)))
        d.chats.save(c.copy(messages = listOf(m.copy(truncated = false, error = null, vi = 0))))
        val back = d.chats.load(c.id)!!.messages[0]
        assertFalse(back.truncated); assertEquals(0, back.vi); assertEquals(null, back.error)
    }

    /** 「只保留当前版本」：versions 从 [..] 变成 []（同类问题，A-M3 发现） */
    @Test fun clearingVersionsPersists() = runBlocking {
        val d = DataGraph.inMemory()
        val c = d.chats.create("p", "m")
        val m = Message("m1", Role.ASSISTANT, "hi", 1, vi = 1, versions = listOf(kotlinx.serialization.json.JsonObject(emptyMap()), null))
        d.chats.save(c.copy(messages = listOf(m)))
        d.chats.save(c.copy(messages = listOf(m.copy(versions = emptyList(), vi = 0))))
        org.junit.Assert.assertTrue(d.chats.load(c.id)!!.messages[0].versions.isEmpty())
    }
}
