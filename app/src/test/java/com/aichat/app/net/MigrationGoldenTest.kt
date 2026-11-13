package com.aichat.app.net

import com.aichat.app.domain.cost.UsageStatsCore
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** providerMigration 钩子（Providers.migrateSettings）+ UsageStats.normalize + PRESETS 与 JS 一致 */
class MigrationGoldenTest {
    @Test fun presetsMatchJs() {
        val o = Golden.load("presets.jsonl").single().out as JsonObject
        Golden.assertExact("PRESETS", o["PRESETS"], ProviderPresets.PRESETS)
        Golden.assertExact("OLD_DEFAULTS", o["OLD_DEFAULTS"], ProviderPresets.OLD_DEFAULTS)
        Golden.assertExact("RETIRED", o["RETIRED"], ProviderPresets.RETIRED)
        assertEquals((o["SETTINGS_VERSION"] as JsonPrimitive).content.toInt(), ProviderPresets.SETTINGS_VERSION)
    }

    @Test fun migrateSettingsMatchesJs() {
        val cases = Golden.load("migrateSettings.jsonl")
        assertTrue(cases.size >= 10)
        for (c in cases) {
            val (s, changed) = ProviderMigration.migrateSettings(c.input[0] as? JsonObject)
            val exp = c.out as JsonObject
            Golden.assertExact("migrateSettings ${Js.stringify(c.input[0]).take(120)}", exp["settings"], s)
            assertEquals((exp["changed"] as JsonPrimitive).content.toBoolean(), changed)
            // 键序也一致（settings.json 原样往返）
            assertEquals(Js.stringify(exp["settings"]), Js.stringify(s))
            // 钩子：无需迁移 → null；否则新 JSON；apiKey 原样不动
            val h = ProviderMigration.hook(c.input[0] as? JsonObject ?: JsonObject(emptyMap()))
            if (!changed) assertNull(h) else assertEquals(Js.stringify(s), Js.stringify(h))
        }
        val json = Js.json.parseToJsonElement("""{"providers":[{"id":"d","presetId":"deepseek","models":["deepseek-chat"],"apiKey":"sk-x"}]}""") as JsonObject
        val out = ProviderMigration.hook(json)!!
        assertTrue(Js.stringify(out).contains("\"apiKey\":\"sk-x\""))
        assertEquals("""{"providers":[{"id":"d","presetId":"deepseek","models":["deepseek-chat"],"apiKey":"sk-x"}]}""", Js.stringify(json))  // 入参不被修改
    }

    @Test fun usageStatsNormalizeMatchesJs() {
        for (c in Golden.load("usageStats.normalize.jsonl")) {
            val got = UsageStatsCore.normalize(c.input[0].takeIf { it !is JsonNull })
            Golden.assertExact("normalize ${Js.stringify(c.input)}", c.out, got)
            assertEquals(Js.stringify(c.out), Js.stringify(got))
        }
    }
}
