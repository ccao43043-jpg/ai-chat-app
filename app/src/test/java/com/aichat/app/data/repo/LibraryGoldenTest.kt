package com.aichat.app.data.repo

import com.aichat.app.data.codec.PersonaCodec
import com.aichat.app.data.codec.TemplateCodec
import com.aichat.app.data.json.Js
import com.aichat.app.golden.Golden
import kotlinx.serialization.json.JsonArray
import org.junit.Assert.assertTrue
import org.junit.Test

/** Templates.mergeBuiltins / Personas.mergeBuiltins 与 JS 一致；builtins.json 与 JS 内置数据一致（--check 守护） */
class LibraryGoldenTest {
    private val b = Builtins.load()
    @Test fun builtinsLoaded() { assertTrue(b.personas.size >= 8); assertTrue(b.templates.size >= 10) }
    @Test fun mergeTemplates() = Golden.cases("library", "mergeTemplates").forEach { c ->
        val list = TemplateCodec.decodeList(Js.toJson(c.arg(0)) as JsonArray)
        @Suppress("UNCHECKED_CAST") val removed = (c.arg(1) as List<Any?>).map { it as String }
        Golden.assertGolden(c.out, Js.fromJson(TemplateCodec.encodeList(b.mergeTemplates(list, removed))), c.label)
    }
    @Test fun mergePersonas() = Golden.cases("library", "mergePersonas").forEach { c ->
        val list = PersonaCodec.decodeList(Js.toJson(c.arg(0)) as JsonArray)
        @Suppress("UNCHECKED_CAST") val removed = (c.arg(1) as List<Any?>).map { it as String }
        Golden.assertGolden(c.out, Js.fromJson(PersonaCodec.encodeList(b.mergePersonas(list, removed))), c.label)
    }
}
