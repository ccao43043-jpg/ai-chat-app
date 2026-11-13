package com.aichat.app.net

import com.aichat.app.domain.ChatOptions
import com.aichat.app.domain.WireMessage
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.domain.model.ProviderType
import com.aichat.app.domain.model.Role
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import org.junit.Assert.fail

/** 读取 Node 导出的 golden（app/src/test/resources/net-golden/<file>.jsonl，每行 {"in":[…],"out":…}） */
object Golden {
    data class Case(val name: String?, val input: JsonArray, val out: JsonElement)

    fun load(file: String): List<Case> {
        val text = Golden::class.java.getResource("/net-golden/$file")?.readText(Charsets.UTF_8)
            ?: error("golden 不存在：$file（先跑 node app/src/test/resources/net-golden/export-m1.js）")
        return text.lines().filter { it.isNotBlank() }.map { line ->
            val o = Js.json.parseToJsonElement(line) as JsonObject
            Case((o["name"] as? JsonPrimitive)?.content, o["in"] as JsonArray, o["out"] ?: JsonNull)
        }
    }

    /** JSON 语义比较：对象键序无关；数字相对误差 ≤1e-9；字符串逐字 */
    fun semanticEquals(a: JsonElement?, b: JsonElement?): Boolean {
        val x = a ?: JsonNull; val y = b ?: JsonNull
        if (x is JsonNull || y is JsonNull) return x is JsonNull && y is JsonNull
        if (x is JsonObject && y is JsonObject) return x.keys == y.keys && x.keys.all { semanticEquals(x[it], y[it]) }
        if (x is JsonArray && y is JsonArray) return x.size == y.size && x.indices.all { semanticEquals(x[it], y[it]) }
        if (x is JsonPrimitive && y is JsonPrimitive) {
            if (x.isString || y.isString) return x.isString == y.isString && x.content == y.content
            val bx = x.booleanOrNull; val by = y.booleanOrNull
            if (bx != null || by != null) return bx == by
            val dx = x.doubleOrNull ?: return false; val dy = y.doubleOrNull ?: return false
            if (dx == dy) return true
            return Math.abs(dx - dy) <= 1e-9 * maxOf(Math.abs(dx), Math.abs(dy))
        }
        return false
    }
    fun assertSemantic(label: String, expected: JsonElement?, actual: JsonElement?) {
        if (!semanticEquals(expected, actual)) fail("$label\n  expected: ${Js.stringify(expected)}\n  actual:   ${Js.stringify(actual)}")
    }

    private fun str(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
    private fun bool(e: JsonElement?): Boolean? = (e as? JsonPrimitive)?.takeIf { it !is JsonNull }?.booleanOrNull

    /** settings.json providers[] 元素 → ProviderConfig（测试用的最小解码；正式 Codec 归 D） */
    fun provider(e: JsonElement?): ProviderConfig {
        val o = e as JsonObject
        return ProviderConfig(
            id = str(o["id"]) ?: "", presetId = str(o["presetId"]) ?: "", name = str(o["name"]) ?: "",
            type = ProviderType.of(str(o["type"])), baseUrl = str(o["baseUrl"]) ?: "",
            models = (o["models"] as? JsonArray)?.mapNotNull { str(it) } ?: emptyList(),
            imageModel = str(o["imageModel"]) ?: "", thinking = str(o["thinking"]), streamUsage = bool(o["streamUsage"]),
            cacheAffinity = bool(o["cacheAffinity"]), orSort = str(o["orSort"]),
            modelMeta = o["modelMeta"] as? JsonObject ?: JsonObject(emptyMap()),
        )
    }
    fun messages(e: JsonElement?): List<WireMessage> = (e as JsonArray).map { m ->
        val o = m as JsonObject
        WireMessage(role = Role.of(str(o["role"])), content = str(o["content"]) ?: "",
            images = (o["images"] as? JsonArray)?.mapNotNull { str(it) } ?: emptyList(),
            cacheMark = bool(o["_cache"]) == true)
    }
    fun opts(e: JsonElement?): ChatOptions {
        val o = e as? JsonObject ?: JsonObject(emptyMap())
        return ChatOptions(
            stream = bool(o["stream"]) != false,
            temperature = (o["temperature"] as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.doubleOrNull,
            maxTokens = (o["maxTokens"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.intOrNull,
            thinking = bool(o["thinking"]),
            jsonMode = bool(o["jsonMode"]) == true,
            convId = str(o["convId"]),
            cacheControl = bool(o["cacheControl"]) == true,
            cacheSystemSplit = (o["cacheSystemSplit"] as? JsonPrimitive)?.intOrNull ?: 0,
            providerOrder = (o["providerOrder"] as? JsonArray)?.mapNotNull { str(it) } ?: emptyList(),
            routeSlug = str(o["routeSlug"]),
            cacheSystem = bool(o["cacheSystem"]), cacheAffinity = bool(o["cacheAffinity"]), orSort = str(o["orSort"]),
            orGemini = Js.truthy(o["orGemini"]), orMiniMax = Js.truthy(o["orMiniMax"]),
            routePrices = (o["routePrices"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList(),
        )
    }
    /** JS opts 里路由状态相关字段 → RouteInputs（onRouteChosen 由调用方给） */
    fun route(e: JsonElement?, onChosen: ((String) -> Unit)? = null): RouteInputs {
        val o = e as? JsonObject ?: JsonObject(emptyMap())
        return RouteInputs(
            routerState = (o["routerState"] as? JsonObject)?.let { Router.State.fromJson(it) },
            routerModel = str(o["routerModel"]),
            routerModelState = (o["routerModelState"] as? JsonObject)?.let { Router.ModelState.fromJson(it) },
            routeCurrent = str(o["routeCurrent"]),
            prefixTokens = o["prefixTokens"]?.let { Js.toNumber(it) }?.takeIf { it == it } ?: 0.0,
            routerOpts = Router.Settings.of(o["routerOpts"] as? JsonObject),
            onRouteChosen = onChosen,
        )
    }
    /** 精确比较（数字 double 必须 ==，不给容差；用于 Router 数值） */
    fun exactEquals(a: JsonElement?, b: JsonElement?): Boolean {
        val x = a ?: JsonNull; val y = b ?: JsonNull
        if (x is JsonNull || y is JsonNull) return x is JsonNull && y is JsonNull
        if (x is JsonObject && y is JsonObject) return x.keys == y.keys && x.keys.all { exactEquals(x[it], y[it]) }
        if (x is JsonArray && y is JsonArray) return x.size == y.size && x.indices.all { exactEquals(x[it], y[it]) }
        if (x is JsonPrimitive && y is JsonPrimitive) {
            if (x.isString || y.isString) return x.isString == y.isString && x.content == y.content
            val bx = x.booleanOrNull; val by = y.booleanOrNull
            if (bx != null || by != null) return bx == by
            return x.doubleOrNull != null && x.doubleOrNull == y.doubleOrNull
        }
        return false
    }
    fun assertExact(label: String, expected: JsonElement?, actual: JsonElement?) {
        if (!exactEquals(expected, actual)) fail("$label\n  expected: ${Js.stringify(expected)}\n  actual:   ${Js.stringify(actual)}")
    }
}
