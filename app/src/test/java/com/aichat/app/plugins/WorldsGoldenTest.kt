package com.aichat.app.plugins

import com.aichat.app.plugins.js.*
import com.aichat.app.plugins.rp.AutoChar
import com.aichat.app.plugins.rp.RpState
import com.aichat.app.plugins.rp.Worlds
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Test

/** M3-4 / M3-5 golden：rpcache 状态核心 + 分段解析（rpstate）、autochar.js、worlds.js（exporters/c/m3-domain.mjs） */
class WorldsGoldenTest {
    companion object {
        const val NOW = 1763000000000.0
        @BeforeClass @JvmStatic fun fix() {
            Worlds.clock = { NOW }
            Worlds.uid = { java.lang.Long.toString(NOW.toLong(), 36) + "i" }
        }
        @Suppress("UNCHECKED_CAST") fun L(v: Any?): List<Any?> = (v as? List<Any?>) ?: emptyList()
        val safe = DomainGoldenTest::safe
        val FAKE_T = object : Worlds.TemplatesApi {
            override fun defaultTemplates() = listOf<Any?>(jobj("id" to "t-general", "name" to "G"), jobj("id" to "t-rp-immersive", "name" to "沉浸式 RP", "content" to "系统 {{date}}"))
            override fun applyToConv(conv: JObj, tpl: Any?) = Js.assign(conv, jobj("templateId" to tpl["id"], "templateName" to tpl["name"], "systemPrompt" to tpl["content"]))
        }
    }
    private fun suite(dir: String, table: Map<String, (List<Any?>) -> Any?>) {
        val files = Golden.list(dir)
        assertEquals("$dir：golden 文件与 Kotlin 对照表不一致", files.toSet(), table.keys)
        var n = 0
        for (f in files) n += Golden.run("$dir/$f", table[f]!!)
        println("[golden] $dir：${files.size} 个函数，$n 条向量全部一致")
    }

    @Test fun rpstate() = suite("rpstate", mapOf(
        "newState" to { _ -> RpState.newState() },
        "normalizeState" to { a -> RpState.normalizeState(a[0]) },
        "migrateSummaries" to { a -> RpState.migrateSummaries(a[0]) },
        "markHistoryCause" to { a -> RpState.markHistoryCause(a[0], a[1], a[2]) },
        "parseSections" to { a -> RpState.parseSections(a[0]) },
        "findSectionMessage" to { a -> RpState.findSectionMessage(L(a[0]), a[1]?.d()?.toInt()) },
        "stateChain" to { a ->
            var st = RpState.normalizeState(a[0])
            for (op0 in L(a[1])) {
                val op = L(op0)
                try {
                    when (op[0]) {
                        "set" -> st = RpState.setBlock(st, op[1] as String, op[2], op[3])["state"] as JObj
                        "restore" -> st = RpState.setBlock(st, op[1] as String, null, op[3], op[4])["state"] as JObj
                        "base" -> st = RpState.syncBase(st, op[2])
                        else -> st = RpState.explicitBaseUpdate(st, op[2], op[3], op[4])["state"] as JObj
                    }
                    if (op.size > 5 || (op[0] != "restore" && op[0] != "explicit" && op.size > 4)) error("期望抛错：$op")
                } catch (e: JsError) {
                    val exp = op.last()["throws"]; assertEquals(exp, e.message)
                }
            }
            st
        },
    ))

    @Test fun autochar() = suite("autochar", mapOf(
        "normalize" to { a -> AutoChar.normalize(a[0]) },
        "parse" to { a -> AutoChar.parse(a[0]) },
        "fromUserText" to { a -> AutoChar.fromUserText(a[0]) },
        "charName" to { a -> AutoChar.charName(a[0]) },
        "toPromptAppend" to { a -> AutoChar.toPromptAppend(a[0]) },
        "fillLeftovers" to { a -> AutoChar.fillLeftovers(a[0], a[1]) },
        "buildPrompt" to { a -> AutoChar.buildPrompt(a[0], a[1], a[2]) },
        "shouldOffer" to { a -> AutoChar.shouldOffer(a[0], L(a[1]), a[2]) },
        "hasCharacter" to { a -> AutoChar.hasCharacter(a[0]) },
        "isRpTemplate" to { a -> AutoChar.isRpTemplate(a[0], L(a[1])) },
        "mode" to { a -> AutoChar.mode(a[0]) },
    ))

    private fun conv(c: Any?): JObj = c as JObj
    @Test fun worlds() = suite("worlds", mapOf(
        "normalizeWorld" to { a -> Worlds.normalizeWorld(a[0]) },
        "filledBlockCount" to { a -> Worlds.filledBlockCount(a[0]) },
        "formatWorldSections" to { a -> Worlds.formatWorldSections(a[0]) },
        "hashBlock" to { a -> Worlds.hashBlock(a[0]) },
        "blocksChanged" to { a -> Worlds.blocksChanged(a[0], a[1]) },
        "listChain" to { a ->
            var list: List<Any?> = ArrayList()
            for (op0 in L(a[0])) { val op = L(op0); list = when (op[0]) { "upsert" -> Worlds.upsert(list, op[1], op[2]); "dup" -> Worlds.duplicate(list, op[1]); else -> Worlds.remove(list, op[1]) } }
            list
        },
        "conversationFromWorld" to { a -> Worlds.conversationFromWorld(a[0], L(a[1]), a[2], if (a[3] == true) FAKE_T else null) },
        "detectDrift" to { a -> Worlds.detectDrift(a[0], a[1], if (a[0]["plugins"] != null) Worlds.getConvBlocks(a[0], RpState) else a[2]) },
        "shouldShowDrift" to { a -> Worlds.shouldShowDrift(a[0], a[1], Worlds.getConvBlocks(a[0], RpState)) },
        "formatDriftMessage" to { a -> Worlds.formatDriftMessage(a[0], a[1]) },
        "syncChain" to { a ->
            val ops = L(a[0]); val ap = L(ops[0])
            var c = Worlds.applyWorldToConversation(ap[1], ap[2], RpState, ap[3])["conv"] as JObj
            var w: Any? = ap[2]
            for (s0 in L(L(ops[1])[1])) {
                val s = L(s0)
                when (s[0]) {
                    "local" -> {
                        val rc = c["plugins"]["rpcache"]
                        val st = RpState.setBlock(RpState.normalizeState(rc["state"]), s[1] as String, s[2], s[3])["state"]
                        c = Js.assign(c, jobj("plugins" to Js.assign(c["plugins"] as JObj, jobj("rpcache" to Js.assign(rc as JObj, jobj("state" to st))))))
                    }
                    "world" -> w = s[1]
                    "sync" -> c = Worlds.applySyncToConversation(c, w, RpState, jobj("mode" to s[1], "at" to s[2]))["conv"] as JObj
                    "pending" -> c = Worlds.applyPendingBlock(c, s[1] as String, RpState, s[2])["conv"] as JObj
                    else -> c = Worlds.rollbackWorldLog(c, RpState, jobj("index" to s[1], "at" to s[2]))["conv"] as JObj
                }
            }
            c
        },
        "merge3" to { a -> Worlds.merge3(a[0], a[1], a[2]) },
        "normalizeWorldRef" to { a -> Worlds.normalizeWorldRef(a[0]) },
        "normalizePending" to { a -> Worlds.normalizePending(a[0]) },
        "sectionTitle" to { a -> Worlds.sectionTitle(a[0]) },
        "blockTitle" to { a -> Worlds.blockTitle(a[0]) },
        "planSync" to { a -> Worlds.planSync(a[0], a[1], a[2], a[3]) },
        "greetingMessage" to { a -> Worlds.greetingMessage(a[0], a[1], a[2], if (a[3] == true) ({ "m-fixed" }) else null) },
        "errors" to { _ -> listOf(
            safe { Worlds.applyWorldToConversation(null, JObj(), RpState, null) }, safe { Worlds.applySyncToConversation(JObj(), JObj(), null, null) },
            safe { Worlds.applyPendingBlock(null, "world", RpState, null) }, safe { Worlds.rollbackWorldLog(JObj(), null, null) },
            safe { Worlds.applyWorldToState(JObj(), JObj(), 0.0, null) }, Worlds.rollbackWorldLog(jobj("worldLog" to ArrayList<Any?>()), RpState, null),
            Worlds.applyPendingBlock(jobj("worldPending" to JObj()), "world", RpState, 1.0)) },
        "parseWorldSections" to { a -> Worlds.parseWorldSections(a[0], true, a[1] == true) },
        "applySectionsToWorld" to { a -> Worlds.applySectionsToWorld(a[0], a[1], a[2]) },
    ))
}
