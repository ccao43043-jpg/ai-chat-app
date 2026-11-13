package com.aichat.app.ui

import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.Role
import com.aichat.app.domain.model.Usage
import com.aichat.app.ui.chat.MessageJson
import com.aichat.app.ui.chat.Versions
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class VersionsTest {
    private fun u(id: String, t: String) = Message(id, Role.USER, t, 1)
    private fun a(id: String, t: String) = Message(id, Role.ASSISTANT, t, 2, usage = Usage(prompt = 3, completion = 4))

    @Test fun regenerateLastKeepsOldVersion() {
        val msgs = listOf(u("u1", "问"), a("a1", "答一"))
        var p = Versions.addVersion(msgs, 1)
        assertEquals(2, p.size); assertEquals("", p[1].content); assertEquals(2, Versions.count(p[1])); assertEquals(1, p[1].vi)
        assertNull(p[1].versions[1])
        p = p.toMutableList().also { it[1] = it[1].copy(content = "答二") }
        val back = Versions.select(p, 1, 0)
        assertEquals("答一", back[1].content); assertEquals(3L to 4L, back[1].usage!!.prompt to back[1].usage!!.completion)
        assertEquals(0, back[1].vi); assertNull(back[1].versions[0])
        assertEquals("答二", Versions.select(back, 1, 1)[1].content)
    }

    @Test fun editEarlierUserMessageBranchesTail() {
        val msgs = listOf(u("u1", "原问题"), a("a1", "原回答"), u("u2", "追问"), a("a2", "追答"))
        val p = Versions.addVersion(msgs, 0, JsonObject(mapOf("content" to JsonPrimitive("新问题"))))
        assertEquals(listOf("新问题"), p.map { it.content })
        assertEquals(3, Versions.tailLength(p, 0, 0))
        val p2 = p + a("b1", "新回答")
        val old = Versions.select(p2, 0, 0)
        assertEquals(listOf("原问题", "原回答", "追问", "追答"), old.map { it.content })
        assertEquals(listOf("u1", "a1", "u2", "a2"), old.map { it.id })
        val again = Versions.select(old, 0, 1)
        assertEquals(listOf("新问题", "新回答"), again.map { it.content })
    }

    @Test fun messageJsonRoundTripKeepsExtras() {
        val m = Message("x", Role.ASSISTANT, "c", 5, images = listOf("data:a"), reasoning = "r", truncated = true, finishReason = "length",
            extras = JsonObject(mapOf("pluginStatus" to JsonPrimitive("s"), "sources" to JsonPrimitive(1))))
        assertEquals(m, MessageJson.decode(MessageJson.encode(m)))
    }
}
