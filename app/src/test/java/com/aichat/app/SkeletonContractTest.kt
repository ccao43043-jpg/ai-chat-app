package com.aichat.app

import com.aichat.app.data.secret.SecretKeyVault
import com.aichat.app.data.store.JsonFileStore
import com.aichat.app.net.SseLineParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class SkeletonContractTest {
    @Test fun sseSplitsAcrossChunks() {
        val p = SseLineParser()
        assertEquals(emptyList<String>(), p.feed("data: {\"a\""))
        assertEquals(listOf("{\"a\":1}"), p.feed(":1}\r\n\r\n: ping\n\n"))
        assertEquals(listOf("[DONE]"), p.feed("data: [DONE]\n") + p.finish())
    }

    @Test fun originMatchesLegacyRules() {
        assertEquals("https://openrouter.ai", SecretKeyVault.originOf("https://OpenRouter.ai:443/api/v1"))
        assertEquals("http://10.0.2.2:8080", SecretKeyVault.originOf("http://10.0.2.2:8080/v1"))
        assertNull(SecretKeyVault.originOf("https://user@host/x"))
        assertNull(SecretKeyVault.originOf("file:///x"))
    }

    @Test fun fileStoreKeepsBakAndSanitizes() {
        val dir = Files.createTempDirectory("store").toFile()
        val s = JsonFileStore(dir)
        assertTrue(s.set("settings.json", "{\"v\":1}"))
        assertTrue(s.set("settings.json", "{\"v\":2}"))
        assertEquals("{\"v\":1}", s.get("settings.json.bak"))
        assertTrue(s.append("a.jsonl", "1\n")); assertTrue(s.append("a.jsonl", "2\n"))
        assertEquals("1\n2\n", s.get("a.jsonl"))
        assertTrue(s.set("conv_a/b.json", "x")); assertTrue(s.exists("conv_a_b.json"))
        assertFalse(s.list().any { it.endsWith(".tmp") })
    }
}
