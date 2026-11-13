package com.aichat.app.ui

import com.aichat.app.ui.library.TemplateText
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Calendar

class TemplateTextTest {
    private val now = Calendar.getInstance().apply { set(2026, 0, 5, 9, 7, 0) }.time

    @Test fun variablesDedupAndSkipMacros() {
        assertEquals(listOf("角色名", "风格"), TemplateText.variables("{{角色名}} {{风格|简洁}} {{date}} {{角色名}} {{time}}"))
    }

    @Test fun fillDefaultsAndMacros() {
        val out = TemplateText.fill("你是{{角色名}}，风格{{风格|简洁}}。今天{{date}} {{time}}", mapOf("角色名" to "小明"), now = now)
        assertEquals("你是小明，风格简洁。今天2026-01-05 09:07", out)
    }

    @Test fun unfilledKeptUnlessDropEmpty() {
        assertEquals("A {{x}}", TemplateText.fill("A {{x}}", emptyMap(), now = now))
    }

    @Test fun pushRecent() {
        assertEquals(listOf("b", "a", "c"), TemplateText.pushRecent(listOf("a", "b", "c"), "b"))
        assertEquals(5, TemplateText.pushRecent(listOf("1", "2", "3", "4", "5"), "6").size)
    }
}
