package com.aichat.app.net

import com.aichat.app.domain.cost.FloorPrices
import com.aichat.app.domain.model.ProviderType
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** M3 golden：模型列表 / 价格 / 最低价同步 / Router / planOpenRouterRoute / observeRoute / routePrices 分支（export-m3.js） */
class M3GoldenTest {
    private fun s(e: JsonElement?): String? = (e as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
    private fun obj(e: JsonElement?): JsonObject? = e as? JsonObject
    private fun objs(e: JsonElement?): List<JsonObject> = (e as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
    private fun d(e: JsonElement?): Double? = (e as? JsonPrimitive)?.takeIf { it !is JsonNull && !it.isString }?.doubleOrNull
    private fun nonNull(e: JsonElement?): JsonElement? = e?.takeIf { it !is JsonNull }

    @Test fun localeCompareMatchesIcu() {
        val cases = Golden.load("localeCompare.jsonl")
        val sortCase = cases.first { it.name == "sort" }
        val ids = (sortCase.input[0] as JsonArray).map { s(it)!! }
        assertEquals((sortCase.out as JsonArray).map { s(it) }, ids.sortedWith { a, b -> Js.localeCompare(a, b) })
        for (c in cases.filter { it.name == null }) {
            val a = s(c.input[0])!!; val b = s(c.input[1])!!
            assertEquals("'$a' vs '$b'", (c.out as JsonPrimitive).content.toDouble().toInt(), Js.localeCompare(a, b))
        }
    }

    @Test fun classifyModel() {
        for (c in Golden.load("classifyModel.jsonl"))
            assertEquals(Js.stringify(c.input), s(c.out), ModelCatalog.classifyModel(s(c.input[0]), obj(c.input[1])))
    }

    @Test fun buildModelsAndEndpointsRequests() {
        for (c in Golden.load("buildModelsRequest.jsonl")) {
            val r = ModelCatalog.buildModelsRequest(Golden.provider(c.input[0]))
            val o = c.out as JsonObject
            assertEquals(s(o["url"]), r.url); assertEquals(s(o["method"]), r.method)
            Golden.assertSemantic("headers", o["headers"], JsonObject(r.headers.mapValues { JsonPrimitive(it.value) }))
        }
        for (c in Golden.load("buildEndpointsRequest.jsonl")) {
            val r = ModelCatalog.buildEndpointsRequest(Golden.provider(c.input[0]), s(c.input[1]))
            assertEquals(s((c.out as JsonObject)["url"]), r.url)
            assertTrue(r.headers.isEmpty())
        }
    }

    @Test fun parseModelsResponseAndMeta() {
        for (c in Golden.load("parseModelsResponse.jsonl")) {
            val type = ProviderType.of(s(c.input[0])); val text = s(c.input[1])!!
            val got: JsonElement = try { JsonArray(ModelCatalog.parseModelsResponse(type, text).map { JsonPrimitive(it) }) }
                catch (e: Exception) { JsonObject(mapOf("error" to JsonPrimitive(true))) }
            Golden.assertExact("parseModelsResponse ${text.take(60)}", c.out, got)
            // 顺序也必须一致（localeCompare）
            if (c.out is JsonArray) assertEquals(Js.stringify(c.out), Js.stringify(got))
        }
        for (c in Golden.load("parseModelsMeta.jsonl"))
            Golden.assertExact("parseModelsMeta ${s(c.input[1])!!.take(60)}", c.out, ModelCatalog.parseModelsMeta(ProviderType.of(s(c.input[0])), s(c.input[1])!!))
    }

    @Test fun pricingFloorEndpoints() {
        for (c in Golden.load("pricingFromRaw.jsonl")) {
            val got = if (c.name == "effectiveTokenPricing") ModelCatalog.effectiveTokenPricing(c.input[0]) else ModelCatalog.parsePricing(c.input[0])
            Golden.assertExact("pricing ${Js.stringify(c.input)}", c.out, got ?: JsonNull)
            // 也逐字比 JSON.stringify（数字格式 1e-7 等）
            assertEquals(Js.stringify(c.out), Js.stringify(got ?: JsonNull))
        }
        for (c in Golden.load("floorPricingFromEndpoints.jsonl"))
            Golden.assertExact("floor ${Js.stringify(c.input).take(80)}", c.out, ModelCatalog.floorPricingFromEndpoints(nonNull(c.input[0])) ?: JsonNull)
        for (c in Golden.load("parseEndpointsResponse.jsonl"))
            Golden.assertExact("parseEndpoints", c.out, ModelCatalog.parseEndpointsResponse(s(c.input[0])))
        for (c in Golden.load("endpointLatencyMs.jsonl"))
            Golden.assertExact("latency ${Js.stringify(c.input)}", c.out, Js.number(ModelCatalog.endpointLatencyMs(c.input[0])))
        for (c in Golden.load("endpointRoutePrices.jsonl"))
            Golden.assertExact("routePrices", c.out, JsonArray(ModelCatalog.endpointRoutePrices(nonNull(c.input[0]))))
    }

    @Test fun floorPriceSync() {
        for (c in Golden.load("mergeFloorPrice.jsonl")) {
            val got = FloorPrices.mergeFloorPrice(obj(c.input[0]), s(c.input[1]), obj(c.input[2]), (c.input[3] as JsonPrimitive).longOrNull!!)
            Golden.assertExact("mergeFloorPrice ${Js.stringify(c.input)}", c.out, got)
        }
        for (c in Golden.load("syncUsagePricesFromEndpoints.jsonl")) {
            val got = FloorPrices.syncUsagePricesFromEndpoints(obj(c.input[0]), s(c.input[1]), nonNull(c.input[2]), (c.input[3] as JsonPrimitive).longOrNull!!)
            Golden.assertExact("syncUsage ${Js.stringify(c.input).take(120)}", c.out, got ?: JsonNull)
        }
        for (c in Golden.load("syncPricesFromProviderMeta.jsonl")) {
            val ps = (c.input[0] as JsonArray).map { Golden.provider(it) }
            val r = FloorPrices.syncPricesFromProviderMeta(ps, obj(c.input[1]), (c.input[2] as JsonPrimitive).longOrNull!!)
            Golden.assertExact("syncFromMeta", c.out, JsonObject(mapOf("prices" to r.prices, "changed" to JsonPrimitive(r.changed))))
        }
    }

    // ---------------- Router ----------------
    private fun obs(o: JsonObject) = Router.Observation(
        hitTokens = d(o["hitTokens"]), promptTokens = d(o["promptTokens"]),
        hit = (o["hit"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull,
        ok = (o["ok"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull,
        latencyMs = o["latencyMs"]?.let { Js.toNumber(it) })

    @Test fun routerFunctions() {
        val cases = Golden.load("router.fns.jsonl")
        assertTrue(cases.size >= 60)
        for (c in cases) {
            val a = c.input
            fun n(i: Int): Double = a.getOrNull(i)?.let { if (it is JsonNull) Double.NaN else Js.toNumber(it) } ?: Double.NaN
            val label = "${c.name} ${Js.stringify(a)}"
            when (c.name) {
                "hitQuantile" -> Golden.assertExact(label, c.out, Js.number(Router.hitQuantile(n(0), n(1), nonNull(a.getOrNull(2))?.let { Js.toNumber(it) })))
                "effectivePrice" -> Golden.assertExact(label, c.out, Js.number(Router.effectivePrice(a[0], a[1], Js.toNumber(a[2]).let { if (a[2] is JsonPrimitive && (a[2] as JsonPrimitive).isString) Js.toNumber(a[2]) else it })))
                "effectiveScore" -> Golden.assertExact(label, c.out, Js.number(Router.effectiveScore(
                    if (a[0] is JsonNull) Double.POSITIVE_INFINITY else n(0), Js.toNumber(a[1]), Router.Settings.of(obj(a[2])))))
                "applyCalibScale" -> {
                    val exp = (c.out as JsonArray).filter { it !is JsonNull }
                    Golden.assertExact(label, JsonArray(exp), JsonArray(Router.applyCalibScale(objs(a[0]), obj(a[1]), s(a[2]))))
                }
                "latencyOf" -> Golden.assertExact(label, c.out, Js.number(Router.latencyOf(obj(a[0]), obj(a[1])?.let { Router.UpstreamStats.fromJson(it) })))
                "evidenceWeight" -> {   // Math.log2 与 ln/ln2 可能差 1ulp：此项给相对 1e-12 容差
                    val o = obj(a[1])
                    val got = Router.evidenceWeight(n(0), o?.get("infoWeight")?.let { Js.truthy(it) } == true, o?.get("refTokens")?.let { Js.toNumber(it) })
                    assertEquals(label, d(c.out)!!, got, 1e-12 * maxOf(1.0, Math.abs(got)))
                }
                "switchCost" -> Golden.assertExact(label, c.out, Js.number(Router.switchCost(n(0), n(1), n(2), n(3), n(4))))
                "buildProviderField" -> Golden.assertExact(label, c.out,
                    Router.buildProviderField(s(a[0]), (obj(a[1])?.get("enabled") as? JsonPrimitive)?.content != "false"))
                "observeSeq" -> {
                    val seq = (a[0] as JsonArray).map { it as JsonObject }
                    val t0 = n(1); val step = n(2)
                    val st = Router.State()
                    seq.forEachIndexed { i, o -> Router.observe(st, "m", "s" + (i % 2), obs(o), t0 + i * step) }
                    Golden.assertExact(label, c.out, st.toJson())
                }
                "observeWithOpts" -> {
                    val T0 = 1767225600000.0
                    val st = Router.State()
                    Router.observe(st, "m", "a", Router.Observation(hitTokens = 300.0, promptTokens = 9000.0, infoWeight = true), T0)
                    Router.observe(st, "m", "a", Router.Observation(hitTokens = 300.0, promptTokens = 9000.0, latencyMs = 100.0, infoWeight = true, refTokens = 4000.0), T0 + 1, 0.5)
                    Router.observe(st, "m", "a", Router.Observation(latencyMs = 300.0), T0 + 2, 0.5)
                    Golden.assertSemantic(label, c.out, st.toJson())   // 含 log2，容差比较
                }
                "markFailRecordSwitch" -> {
                    val T0 = 1767225600000.0
                    val st = Router.State()
                    Router.markFail(st, "m", "x", T0); Router.markFail(st, "m", "x", T0 + 5)
                    Router.recordSwitch(st, "m", "x", "y", T0 + 9); Router.recordSwitch(st, "m", "y", "y", T0 + 99)
                    Golden.assertExact(label, c.out, st.toJson())
                }
                else -> error("未知 router 用例 ${c.name}")
            }
        }
    }

    @Test fun routerChooseUpstream() {
        val cases = Golden.load("router.chooseUpstream.jsonl")
        assertTrue(cases.size >= 600)
        for (c in cases) {
            val a = c.input
            val stats = obj(a[1])?.let { Router.ModelState.fromJson(it) }
            val got = Router.chooseUpstream(nonNull(a[0])?.let { objs(it) }, stats, s(a[2]), Js.toNumber(a[3]), Router.Settings.of(obj(a[4])))
            assertEquals(Js.stringify(a), s(c.out), got)
        }
    }

    @Test fun routerPanelView() {
        for (c in Golden.load("router.panelView.jsonl")) {
            val ms = obj(c.input[0])?.let { Router.ModelState.fromJson(it) }
            val pm = obj(c.input[1])?.mapValues { it.value as JsonObject }
            Golden.assertExact("panelView ${Js.stringify(c.input)}", c.out, Router.panelView(ms, pm))
        }
    }

    @Test fun routerReplaySeeded() {
        val cases = Golden.load("router.replay.jsonl")
        assertEquals(5, cases.size)
        for (c in cases) {
            val steps = (c.input[0] as JsonArray).map { e ->
                val o = e as JsonObject
                Router.Step(objs(o["prices"]), at = d(o["at"]), prefixTokens = d(o["prefixTokens"]), promptTokens = d(o["promptTokens"]),
                    hitTokens = d(o["hitTokens"]), hit = (o["hit"] as? JsonPrimitive)?.booleanOrNull, ok = (o["ok"] as? JsonPrimitive)?.booleanOrNull)
            }
            val opts = c.input[1] as JsonObject
            val r = Router.replay(steps, Router.Settings.of(opts), s(opts["model"]) ?: "m", d(opts["prefixTokens"]))
            Golden.assertExact("replay ${c.name}", c.out, r.toJson())
        }
    }

    @Test fun planAndObserveRoute() {
        for (c in Golden.load("planOpenRouterRoute.jsonl")) {
            val a = c.input
            val o = obj(a[4]) ?: JsonObject(emptyMap())
            val plan = OpenRouterRouting.plan(Golden.provider(a[0]), s(a[1]), nonNull(a[2]), obj(a[3])?.let { Router.State.fromJson(it) },
                cacheAffinity = (o["cacheAffinity"] as? JsonPrimitive)?.content != "false", orSort = s(o["orSort"]), calib = obj(o["calib"]),
                prefixTokens = o["prefixTokens"]?.let { Js.toNumber(it) } ?: 0.0, routerOpts = Router.Settings.of(obj(o["routerOpts"])))
            Golden.assertExact("plan ${Js.stringify(a).take(200)}", c.out, plan.toJson())
        }
        for (c in Golden.load("observeRoute.jsonl")) {
            val a = c.input
            val u = obj(a[3]) ?: JsonObject(emptyMap())
            val st = OpenRouterRouting.observeRoute(obj(a[0])?.let { Router.State.fromJson(it) }, s(a[1]), s(a[2]),
                Js.num(u["prompt"]), Js.num(u["hit"]), u["latencyMs"]?.let { Js.toNumber(it) }, d(a[4]), obj(a[5])?.get("latencyMs")?.let { Js.toNumber(it) })
            Golden.assertExact("observeRoute ${Js.stringify(a)}", c.out, st.toJson())
        }
    }

    @Test fun buildChatRequestRoutePricesBranch() {
        val builder = DefaultProviderClient(AuthInjector(null))
        val cases = Golden.load("buildChatRequest.route.jsonl")
        assertTrue(cases.size >= 13)
        for (c in cases) {
            val (p, model, msgs, sys, opts) = c.input
            var chosen: String? = null
            val route = Golden.route(opts) { chosen = it }
            val r = builder.buildChatRequest(Golden.provider(p), s(model)!!, Golden.messages(msgs), s(sys)!!, Golden.opts(opts), JsonObject(emptyMap()), route)
            val exp = c.out as JsonObject
            assertEquals("${c.name} url", s(exp["url"]), r.url)
            assertEquals("${c.name} body(bytes)", s(exp["body"]), r.body)
            assertEquals("${c.name} chosen", s(exp["chosen"]), chosen)
            Golden.assertExact("${c.name} routerState", exp["routerState"], route.routerState?.toJson() ?: JsonNull)
        }
    }

    @Test fun numberToStringAndAfford402() {
        for (c in Golden.load("numberToString.jsonl")) {
            val x = (c.input[0] as JsonPrimitive).content.toDouble()
            val exp = c.out as JsonArray
            assertEquals(s(exp[0]), Js.numberToString(x))
            assertEquals(s(exp[1]), Js.stringify(JsonObject(mapOf("v" to Js.number(x)))))
        }
        for (c in Golden.load("afford402.jsonl")) {
            val t = s(c.input[0])
            val o = c.out as JsonObject
            val n = ProviderRules.parseAffordTokens(t)
            assertEquals("afford $t", s(o["afford"]), n?.let { Js.numberToString(it) })
            val next = ProviderRules.downgradeMaxTokens(n)
            assertEquals(s(o["next"]), Js.numberToString(next))
            assertEquals(s(o["notice"]), DefaultProviderClient.downgradeNotice(next))
            assertEquals(s(o["body"]), Js.stringify(JsonObject(mapOf("max_tokens" to Js.number(next)))))
        }
    }
}
