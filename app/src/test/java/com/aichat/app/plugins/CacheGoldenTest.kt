package com.aichat.app.plugins

import com.aichat.app.plugins.cache.CacheCommonImpl
import com.aichat.app.plugins.cache.GCache
import com.aichat.app.plugins.cache.MmCache
import com.aichat.app.plugins.js.*
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Test

/** M2 golden：JS 语义基础 + cache-common + gcache + mmcache 纯函数，逐条对照 JS 输出 */
class CacheGoldenTest {
    companion object {
        @BeforeClass @JvmStatic fun fixDate() { GCache.localDate = { "2026-11-13" } }
        val counts = sortedMapOf<String, Int>()
        @Suppress("UNCHECKED_CAST") fun L(v: Any?): List<Any?> = (v as? List<Any?>) ?: emptyList()
        @Suppress("UNCHECKED_CAST") fun turns(v: Any?): List<List<Any?>> = L(v).map { L(it) }
        fun numIn(v: Any?): Double = when (v) { "NaN" -> Double.NaN; "Infinity" -> Double.POSITIVE_INFINITY; "-Infinity" -> Double.NEGATIVE_INFINITY; else -> v.d() }
        fun nul(v: Any?): Double? = v?.d()
    }

    private fun suite(dir: String, table: Map<String, (List<Any?>) -> Any?>) {
        val files = Golden.list(dir)
        assertEquals("$dir：golden 文件与 Kotlin 对照表不一致", files.toSet(), table.keys)
        var n = 0
        for (f in files) { val c = Golden.run("$dir/$f", table[f]!!); counts["$dir/$f"] = c; n += c }
        println("[golden] $dir：${files.size} 个函数，$n 条向量全部一致")
    }

    @Test fun jsSemantics() = suite("js", mapOf(
        "numToString" to { a -> Js.numToString(numIn(a[0])) },
        "round" to { a -> Js.round(a[0].d()) },
        "toFixed" to { a -> Js.toFixed(a[0].d(), a[1].i()) },
        "i32" to { a -> Js.i32(a[0]).toDouble() },
        "stringify" to { a -> Js.quote(a[0] as String) },
        "trim" to { a -> Js.trim(a[0] as String) },
        "sha256" to { a -> Js.sha256(a[0] as String) },
    ))

    @Test fun cacheCommon() = suite("cache-common", mapOf(
        "hash" to { a -> CacheCommonImpl.hash(a[0] as String) },
        "estTokens" to { a -> CacheCommonImpl.estTokens(a[0] as String) },
        "sessionIdFor" to { a -> CacheCommonImpl.sessionIdFor(a[0] as String, a[1] as String) },
        "lcpLen" to { a -> CacheCommonImpl.lcpLen(a[0] as String, a[1] as String) },
        "lcpRatio" to { a -> CacheCommonImpl.lcpRatio(a[0] as String, a[1] as String) },
        "firstDiff" to { a -> CacheCommonImpl.firstDiff(a[0] as String, a[1] as String) },
        "partsText" to { a -> CacheCommonImpl.partsText(a[0]) },
        "usageInfo" to { a -> CacheCommonImpl.usageInfo(a[0].o()) },
        "rollingRate" to { a -> CacheCommonImpl.rollingRate(L(a[0])) },
        "estimateCost" to { a -> CacheCommonImpl.estimateCost(a[0].o(), a[1].o()) },
        "isOpenRouterProvider" to { a -> CacheCommonImpl.isOpenRouterProvider(a[0].o()) },
    ))

    @Test fun gcache() = suite("gcache", mapOf(
        "isGeminiModel" to { a -> GCache.isGeminiModel(a[0]) },
        "minCacheTokens" to { a -> GCache.minCacheTokens(a[0]) },
        "isFlashLite" to { a -> GCache.isFlashLite(a[0]) },
        "resolveCacheAdapter" to { a -> GCache.resolveCacheAdapter(a[0], a[1]) },
        "isOpenRouterGemini" to { a -> GCache.isOpenRouterGemini(a[0], a[1]) },
        "adaptiveMinTokens" to { a -> GCache.adaptiveMinTokens(a[0], a[1]) },
        "flashLitePrefixNote" to { a -> GCache.flashLitePrefixNote(a[0], a[1]) },
        "analyzeLayers" to { a -> GCache.analyzeLayers(a[0]) },
        "layersFromSegments" to { a -> GCache.layersFromSegments(a[0], a[1]) },
        "decide" to { a -> GCache.decide(a[0].o()!!, a[1].o()!!) },
        "decideHistory" to { a -> GCache.decideHistory(a[0].o()!!, a[1].o()!!) },
        "sessionIdFor" to { a -> GCache.sessionIdFor(a[0]) },
        "normalizeDates" to { a -> GCache.normalizeDates(a[0]) },
        "splitTurns" to { a -> GCache.splitTurns(L(a[0])) },
        "summarizeTurnsFast" to { a -> GCache.summarizeTurnsFast(turns(a[0]), a[1].i()) },
        "summarizeTurnsSemantic" to { a -> GCache.summarizeTurnsSemantic(turns(a[0]), a[1].i()) },
        "extractHybridEvidence" to { a -> GCache.extractHybridEvidence(turns(a[0])) },
        "scoreHybridSummary" to { a -> GCache.scoreHybridSummary(a[0], turns(a[1])) },
        "hwApply" to { a -> GCache.hwApply(L(a[0]), a[1].o(), a[2], a[3], a[4]) },
        "applyToRequest" to { a -> GCache.applyToRequest(a[0].o()!!, a[1].o(), a[2].o()) },
        "applyToRequestHybrid" to { a -> val ex = a[2].o()!!; val r = GCache.applyToRequest(a[0].o()!!, a[1].o(), ex); jobj("r" to r, "state" to Js.clone(ex["hybrid"])) },
        "usageText" to { a -> GCache.usageText(a[0]) },
        "estimateCost" to { a -> GCache.estimateCost(a[0].o(), a[1].o()) },
        "keepaliveRecommend" to { a -> GCache.keepaliveRecommend(L(a[0]), a[1].d(), a[2].d(), a[3].d(), nul(a[4])) },
        "pingsForGap" to { a -> GCache.pingsForGap(a[0].d(), a[1].d(), a[2].d(), nul(a[3])) },
        "netForGap" to { a -> GCache.netForGap(a[0].d(), a[1].d(), a[2].d(), a[3].d(), nul(a[4])) },
        "attributeCacheHit" to { a -> GCache.attributeCacheHit(a[0]) },
        "expectedHit" to { a -> GCache.expectedHit(a[0], a[1], nul(a[2])) },
        "isRpConv" to { a -> GCache.isRpConv(a[0], a[1] == true) },
        "diagnose" to { a -> GCache.diagnose(a[0]) },
        "extractL0" to { a -> GCache.extractL0(a[0]) },
        "memSearch" to { a -> GCache.memSearch(L(a[0]), a[1], a[2]?.i()) },
        "missingL0" to { a -> GCache.missingL0(L(a[0]), a[1]) },
    ))

    @Test fun mmcache() = suite("mmcache", mapOf(
        "priceFor" to { a -> MmCache.priceFor(a[0]) },
        "isMiniMaxModel" to { a -> MmCache.isMiniMaxModel(a[0]) },
        "isOpenRouterMiniMax" to { a -> MmCache.isOpenRouterMiniMax(a[0], a[1]) },
        "sessionIdFor" to { a -> MmCache.sessionIdFor(a[0]) },
        "mergeLeadingSystem" to { a -> MmCache.mergeLeadingSystem(L(a[0])) },
        "prefixOf" to { a -> MmCache.prefixOf(a[0]) },
        "applyToRequest" to { a -> MmCache.applyToRequest(a[0].o()!!, a[1].o(), a[2].o()) },
        "diagnose" to { a -> MmCache.diagnose(a[0]) },
        "usageText" to { a -> MmCache.usageText(a[0]) },
    ))
}
