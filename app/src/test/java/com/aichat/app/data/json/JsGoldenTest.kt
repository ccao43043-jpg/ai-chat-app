package com.aichat.app.data.json

import com.aichat.app.data.secret.SecretKeyVault
import com.aichat.app.data.store.StoreJs
import com.aichat.app.golden.Golden
import org.junit.Assert.assertEquals
import org.junit.Test

/** Js 值模型与 V8 逐字一致（JSON.stringify / Number::toString / 整数键顺序），以及 secure.js 的纯函数 */
class JsGoldenTest {
    @Test fun stringifyMatchesV8() = Golden.cases("secure", "stringify").forEach { c ->
        assertEquals(c.label, c.out, Js.stringify(Js.parse(c.arg(0) as String)))
    }
    @Test fun prettyStringifyMatchesV8() = Golden.cases("secure", "stringifyPretty").forEach { c ->
        assertEquals(c.label, c.out, Js.stringify(Js.parse(c.arg(0) as String), 2))
    }
    @Test fun numberToStringMatchesV8() = Golden.cases("secure", "numToString").forEach { c ->
        assertEquals(c.label, c.out, Js.numToString(c.arg(0) as Double))
    }
    /** JS 返回 ''，Kotlin 返回 null 表示非法 */
    @Test fun originOfMatchesSecureJs() = Golden.cases("secure", "originOf").forEach { c ->
        assertEquals(c.label + " " + c.arg(0), c.out, SecretKeyVault.originOf(c.arg(0) as String) ?: "")
    }
    @Test fun parseJsonlMatches() = Golden.cases("secure", "parseJsonl").forEach { c ->
        Golden.assertGolden(c.out, StoreJs.parseJsonl(c.arg(0) as String), c.label)
    }
    @Test fun keyOrderAndAssign() {
        val o = JsObj(); o["b"] = 1; o["3"] = 1; o["a"] = 1; o["1"] = 1; o["b"] = 2
        assertEquals("""{"1":1,"3":1,"b":2,"a":1}""", Js.stringify(o))
        o.remove("b"); o["b"] = 3
        assertEquals(listOf("1", "3", "a", "b"), o.keys())
        assertEquals(5, Js.int32(5.9)); assertEquals(-5, Js.int32(-5.9)); assertEquals(0, Js.int32(Undef)); assertEquals(1, Js.int32(4294967297.0))
    }
}
