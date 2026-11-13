package com.aichat.app.ui

import com.aichat.app.domain.model.ProviderType
import com.aichat.app.ui.common.fake.FakeKeyVault
import com.aichat.app.ui.common.fake.FakeSettingsRepository
import com.aichat.app.ui.settings.KeyMask
import com.aichat.app.ui.settings.ProviderDraft
import com.aichat.app.ui.settings.ProviderEditor
import com.aichat.app.ui.settings.ProviderPresets
import com.aichat.app.ui.settings.parseMaxTokens
import com.aichat.app.ui.settings.parseTemperature
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsLogicTest {
    private fun setup(): Triple<FakeSettingsRepository, FakeKeyVault, ProviderEditor> {
        val keys = FakeKeyVault(); val s = FakeSettingsRepository().also { it.keys = keys }
        return Triple(s, keys, ProviderEditor(s, keys))
    }

    @Test fun keyMaskSemantics() {
        assertEquals(KeyMask.Action.Keep, KeyMask.resolve(KeyMask.MASK))
        assertEquals(KeyMask.Action.Delete, KeyMask.resolve("  "))
        assertEquals(KeyMask.Action.Replace("sk-1"), KeyMask.resolve(" sk-1 "))
        assertEquals("", KeyMask.initialText(false)); assertEquals(KeyMask.MASK, KeyMask.initialText(true))
        // 在掩码后面打字 → 只留新输入；退格一下 → 清空（= 删除）
        assertEquals("a", KeyMask.sanitizeEdit(KeyMask.MASK, KeyMask.MASK + "a"))
        assertEquals("", KeyMask.sanitizeEdit(KeyMask.MASK, KeyMask.MASK.dropLast(1)))
        assertEquals("sk-new", KeyMask.sanitizeEdit(KeyMask.MASK, "sk-new"))
        assertEquals("abc", KeyMask.sanitizeEdit("ab", "abc"))
        assertEquals("x", KeyMask.sanitizeEdit(KeyMask.MASK, KeyMask.MASK.substring(0, 3) + "x" + KeyMask.MASK.substring(3)))
    }

    @Test fun saveKeepReplaceDelete() = runTest {
        val (s, keys, ed) = setup()
        val p = s.settings.value.providers.first { it.id == "deepseek" }
        // 输入新 Key
        val r1 = ed.save(p, ProviderDraft.of(p, false).copy(keyText = "sk-1")) as ProviderEditor.Result.Ok
        assertTrue(keys.has("deepseek")); assertTrue(r1.provider.hasKey); assertEquals("已保存", r1.message)
        // 不动掩码 → 保留
        val d2 = ProviderDraft.of(r1.provider, true)
        assertEquals(KeyMask.MASK, d2.keyText)
        ed.save(r1.provider, d2.copy(name = "DS")); assertTrue(keys.has("deepseek"))
        assertEquals("DS", s.settings.value.providers.first { it.id == "deepseek" }.name)
        // 换主机 + 保留掩码 → 数据层清 Key，提示重新填写
        val r3 = ed.save(r1.provider, d2.copy(baseUrl = "https://other.example.com/v1")) as ProviderEditor.Result.Ok
        assertFalse(keys.has("deepseek")); assertTrue(r3.message.contains("旧 API Key 已清除"))
        // 清空 → 删除
        ed.save(r3.provider, ProviderDraft.of(r3.provider, false).copy(keyText = "sk-2"))
        ed.save(r3.provider, ProviderDraft.of(r3.provider, true).copy(keyText = ""))
        assertFalse(keys.has("deepseek")); assertFalse(s.settings.value.providers.first { it.id == "deepseek" }.hasKey)
    }

    @Test fun validation() = runTest {
        val (s, _, ed) = setup()
        val p = s.settings.value.providers.first()
        assertTrue(ed.save(p, ProviderDraft.of(p, false).copy(baseUrl = "ftp://x")) is ProviderEditor.Result.Invalid)
        assertTrue(ed.save(p, ProviderDraft.of(p, false).copy(modelsText = " \n ,")) is ProviderEditor.Result.Invalid)
        assertEquals(listOf("a", "b", "c"), ed.parseModels("a\nb, c，a"))
    }

    @Test fun addAndDeleteProvider() = runTest {
        val (s, keys, ed) = setup()
        val custom = ed.newFromPreset(ProviderPresets.all.first { it.presetId == "custom" }, s.settings.value.providers.map { it.id }.toSet(), 1000)
        assertTrue(custom.id.startsWith("custom-"))
        val dup = ed.newFromPreset(ProviderPresets.all.first { it.presetId == "openai" }, setOf("openai"), 1000)
        assertEquals("openai-rs", dup.id)
        ed.save(custom, ProviderDraft("本地", ProviderType.OPENAI, "http://10.0.2.2:8080/v1", "m1", "", "k"))
        assertTrue(s.settings.value.providers.any { it.id == custom.id && it.hasKey })
        val openai = s.settings.value.providers.first { it.id == "openai" }
        ed.delete(openai)
        assertFalse(s.settings.value.providers.any { it.id == "openai" })
        assertEquals(listOf("openai"), s.removedPresets); assertTrue(s.settings.value.extras.isEmpty())
        assertFalse(keys.has("openai"))
    }

    @Test fun numberFields() {
        assertNull(parseTemperature(" ").getOrThrow()); assertEquals(0.7, parseTemperature("0.7").getOrThrow()!!, 0.0)
        assertTrue(parseTemperature("3").isFailure); assertTrue(parseTemperature("x").isFailure)
        assertNull(parseMaxTokens("").getOrThrow()); assertEquals(4096, parseMaxTokens("4096").getOrThrow())
        assertTrue(parseMaxTokens("0").isFailure)
    }
}
