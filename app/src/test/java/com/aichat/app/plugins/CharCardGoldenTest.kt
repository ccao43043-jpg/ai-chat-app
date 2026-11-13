package com.aichat.app.plugins

import com.aichat.app.plugins.js.*
import com.aichat.app.plugins.rp.CharCard
import com.aichat.app.plugins.rp.Lore
import org.junit.Assert.assertEquals
import org.junit.Test

/** M3-3 golden：charcard.js + rpcache.js 世界书文本（exporters/c/m3-domain.mjs 的 charcard 段） */
class CharCardGoldenTest {
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it.toInt() and 0xff) }
    private fun unhex(h: Any?): ByteArray { val s = h as String; return ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() } }
    /** 导出端 normErr：atob → <atob>，fflate 解压错误 → <inflate> */
    private fun safe(f: () -> Any?): Any? = try { f() } catch (e: CharCard.AtobError) { jobj("throws" to "<atob>") } catch (e: CharCard.InflateError) { jobj("throws" to "<inflate>") }
        catch (e: JsSyntaxError) { jobj("throws" to "<JSON>") } catch (e: JsError) { jobj("throws" to e.message) }
    @Suppress("UNCHECKED_CAST") private fun L(v: Any?) = v as List<Any?>?

    @Test fun charcard() {
        val table: Map<String, (List<Any?>) -> Any?> = mapOf(
            "parseLore" to { a -> Lore.parseLore(a[0]) },
            "loreToText" to { a -> Lore.loreToText(L(a[0])) },
            "parseCardObject" to { a -> safe { CharCard.parseCardObject(a[0]) } },
            "bookToLoreText" to { a -> CharCard.bookToLoreText(a[0]) },
            "cardToPersona" to { a -> safe { CharCard.cardToPersona(a[0], a[1]) } },
            "personaToCard" to { a -> CharCard.personaToCard(a[0], L(a[1])) },
            "loreEntriesToBook" to { a -> CharCard.loreEntriesToBook(L(a[0]), a[1]) },
            "writeCardToPng" to { a -> safe { hex(CharCard.writeCardToPng(a[0], a[1]?.let { unhex(it) })) } },
            "parseCard" to { a -> safe { CharCard.parseCard(if (a[0] == "hex") unhex(a[1]) else a[1]) } },
            "isPng" to { a -> CharCard.isPng(unhex(a[0])) },
            "listChunks" to { a -> safe { CharCard.listChunks(unhex(a[0])).map { jobj("type" to it.type, "data" to hex(it.data), "offset" to it.offset, "length" to it.length.toDouble()) } } },
            "extractCharaRaw" to { a -> safe { CharCard.extractCharaRaw(unhex(a[0])) } },
            "b64encode" to { a -> CharCard.b64encode(a[0] as String) },
            "b64decode" to { a -> safe { CharCard.b64decode(a[0]) } },
        )
        val files = Golden.list("charcard")
        assertEquals(files.toSet(), table.keys)
        var n = 0
        for (f in files) n += Golden.run("charcard/$f", table[f]!!)
        println("[golden] charcard：${files.size} 个函数，$n 条向量全部一致")
    }
}
