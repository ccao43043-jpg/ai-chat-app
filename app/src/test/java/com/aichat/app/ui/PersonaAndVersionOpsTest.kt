package com.aichat.app.ui

import com.aichat.app.domain.model.Message
import com.aichat.app.domain.model.Persona
import com.aichat.app.domain.model.Role
import com.aichat.app.ui.chat.Versions
import com.aichat.app.ui.library.PersonaOps
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PersonaAndVersionOpsTest {
    private fun ps(id: String, name: String, ex: Map<String, String> = emptyMap()) =
        Persona(id, "🤖", name, "", "sp", "", "", null, false, JsonObject(ex.mapValues { JsonPrimitive(it.value) }))

    @Test fun normalizeClampsAndDefaults() {
        val n = PersonaOps.normalize(Persona("", " ", "  ", " d ", "x", "", " m ", 5.0, false))
        assertTrue(n.id.startsWith("p-")); assertEquals("🤖", n.emoji); assertEquals("未命名助手", n.name)
        assertEquals("d", n.desc); assertEquals("m", n.model); assertEquals(2.0, n.temperature!!, 0.0)
    }

    @Test fun upsertKeepsCardExtrasAndDuplicateInsertsAfter() {
        val list = listOf(ps("a", "A", mapOf("loreText" to "L")), ps("b", "B"))
        val up = PersonaOps.upsert(list, ps("a", "A2"))
        assertEquals("A2", up[0].name); assertEquals(JsonPrimitive("L"), up[0].extras["loreText"])
        val dup = PersonaOps.duplicate(up, "a")
        assertEquals(3, dup.size); assertEquals("A2（副本）", dup[1].name); assertFalse(dup[1].builtin)
        assertEquals(JsonPrimitive("L"), dup[1].extras["loreText"])
    }

    @Test fun removeVersionAndKeepOnly() {
        var p = listOf(Message("u", Role.USER, "q", 1), Message("a", Role.ASSISTANT, "v1", 2))
        p = Versions.addVersion(p, 1).let { it.toMutableList().also { l -> l[1] = l[1].copy(content = "v2") } }
        p = Versions.addVersion(p, 1).let { it.toMutableList().also { l -> l[1] = l[1].copy(content = "v3") } }
        assertEquals(3, Versions.count(p[1])); assertEquals("v1", Versions.versionContent(p[1], 0))
        // 删当前（第 3 个）→ 切到第 2 个
        val r = Versions.removeVersion(p, 1, 2)
        assertEquals("v2", r[1].content); assertEquals(2, Versions.count(r[1])); assertEquals(1, r[1].vi)
        // 再删第 1 个 → 只剩 1 个，versions 去掉
        val r2 = Versions.removeVersion(r, 1, 0)
        assertEquals("v2", r2[1].content); assertTrue(r2[1].versions.isEmpty())
        assertTrue(Versions.keepOnly(p, 1)[1].versions.isEmpty()); assertEquals("v3", Versions.keepOnly(p, 1)[1].content)
    }
}
