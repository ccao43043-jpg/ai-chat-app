package com.aichat.app.plugins.rp

import com.aichat.app.plugins.js.*

/**
 * www/rpcache.js 的会话状态核心（BLOCK_DEFS / DEFAULT_SETTINGS / newState / normalizeState / setBlock / syncBase …）
 * 与分段文本解析（parseSections / findSectionMessage）。状态沿用 JS 值模型（JObj）。
 */
object RpState {
    private fun def(id: String, tag: String, title: String, layer: String, type: String, prio: String, hint: String) =
        jobj("layer" to layer, "type" to type, "cache_priority" to prio, "id" to id, "tag" to tag, "title" to title, "hint" to hint)
    val BLOCK_DEFS: List<JObj> = listOf(
        def("world", "WORLD", "世界观", "L1", "static", "high", "世界背景、地点、势力、魔法/科技规则。几乎不改。"),
        def("character", "CHARACTER", "角色卡", "L1", "static", "high", "角色身份、性格、说话方式、人物基础资料与人物关系基础。"),
        def("rules", "RP_RULES", "RP 规则", "L1", "static", "high", "例如：NPC 不能读取玩家内心；NPC 只知道自己应该知道的信息；不替玩家决定行动。"),
        def("format", "OUTPUT_FORMAT", "输出格式", "L1", "static", "high", "回复格式、长度、人称、是否带动作描写等。"),
        def("fewshot", "FEW_SHOT", "示例对白", "L1", "static", "high", "几段示例对话（Few-shot），展示期望的文风与格式。"),
        def("prohibit", "PROHIBITIONS", "禁止事项", "L1", "static", "high", "绝对不能出现的内容或行为。"),
        def("style", "STYLE", "写作风格", "L1", "static", "high", "固定写作风格、语气、节奏。"),
        jobj("id" to "memory", "tag" to "LONG_TERM_MEMORY", "title" to "长期记忆", "layer" to "L2", "type" to "memory", "cache_priority" to "medium",
            "hint" to "已确认的重要事实、人物关系、重大事件、长期目标、关键道具、已揭开的秘密、未解决的剧情线。只在发生重要事件时手动更新。"),
        jobj("id" to "delta", "tag" to "MEMORY_UPDATE", "title" to "记忆增量", "layer" to "L4+", "type" to "delta", "cache_priority" to "low",
            "hint" to "新近确认、还没合并进长期记忆的事实。放在对话历史之后（最后一条用户消息里），随时修改都不会破坏前面的缓存；攒多了再「合并进长期记忆」。"),
        jobj("id" to "state", "tag" to "CURRENT_STATE", "title" to "当前动态状态", "layer" to "L5", "type" to "dynamic", "cache_priority" to "low",
            "hint" to "HP / MP / 金钱 / 时间 / 地点 / 好感度 / 天气 / 任务 / 装备 / 增益效果。放在最后一条用户消息末尾，随时修改都不会破坏历史缓存。"),
    )
    val DEFAULT_SETTINGS: JObj get() = jobj(
        "max_context" to 100000, "output_reserve" to 12000, "safety_margin" to 2000,
        "summary" to jobj("enabled" to true, "trigger_tokens" to 30000, "min_new_turns" to 15, "keep_recent_turns" to 20, "min_interval_turns" to 10, "chapter_cap_tokens" to 12000),
        "summary_model" to "", "save_prompt" to false, "force_enable" to false, "refresh_on_regen" to false, "auto_budget" to true, "auto_summary" to true, "cache_mode" to "auto",
        "budget_mode" to "lagrangian", "lagrange_layers" to jarr("memory", "summary"), "min_history_ratio" to 0.35,
        "lore" to jobj("scanDepth" to 2, "recursionDepth" to 0, "budgetPct" to 0.25, "constantBudgetPct" to 0.15, "rebuildOnEdit" to false))
    const val HISTORY_LIMIT = 30

    private fun i32(v: Any?) = Js.i32(v).toDouble()
    fun newState(): JObj = jobj(
        "blocks" to BLOCK_DEFS.mapTo(ArrayList<Any?>()) { jobj("id" to it["id"], "version" to 0, "content" to "", "history" to ArrayList<Any?>(), "updatedAt" to 0) },
        "staticVersion" to 0, "baseHash" to null, "chapters" to ArrayList<Any?>(), "chapterSeq" to 0, "archive" to ArrayList<Any?>(), "lastSummaryRound" to 0, "calib" to 1,
        "window" to jobj("startId" to null, "startOrdinal" to 0), "settings" to DEFAULT_SETTINGS, "seq" to 0, "loreState" to jobj("turn" to 0, "entries" to JObj()))

    fun migrateSummaries(summaries: Any?): JArr? {
        if (summaries !is List<*> || summaries.isEmpty()) return null
        val act = summaries.last()
        if (!Js.truthy(act) || !Js.truthy(act["content"])) return null
        val content = Lore.canonicalize(act["content"])
        return jarr(jobj("no" to 1, "content" to content, "hash" to Js.sha256(content), "coveredIds" to ((act["coveredIds"] as? List<*>)?.toMutableList() ?: ArrayList<Any?>()),
            "at" to Js.or(act["at"], 0.0), "source" to "migrated", "rounds" to i32(act["rounds"]), "atRound" to 0, "history" to ArrayList<Any?>(), "migratedFrom" to i32(act["no"])))
    }
    private fun isObj(v: Any?) = v is Map<*, *> || v is List<*>
    @Suppress("UNCHECKED_CAST") private fun m(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>
    fun normalizeLoreState(ls: Any?): JObj {
        if (!Js.truthy(ls) || !isObj(ls)) return jobj("turn" to 0, "entries" to JObj())
        val entries = JObj()
        val src = if (Js.truthy(ls["entries"]) && isObj(ls["entries"])) m(ls["entries"]) ?: emptyMap() else emptyMap()
        for ((id, e0) in Js.orderedEntries(src)) {
            val e = Js.or(e0, JObj())
            entries[id] = jobj("stickyUntil" to i32(e["stickyUntil"]), "cooldownUntil" to i32(e["cooldownUntil"]), "lastAnchorId" to Js.or(e["lastAnchorId"], null))
        }
        return jobj("turn" to i32(ls["turn"]), "entries" to entries)
    }
    fun budgetIsDefault(s: Any?): Boolean {
        val d = DEFAULT_SETTINGS; val a = Js.or(s["summary"], JObj()); val b = d["summary"]
        fun eq(x: Any?, y: Any?) = x is Double && y is Double && x == y
        return eq(s["max_context"], d["max_context"]) && eq(s["output_reserve"], d["output_reserve"]) && eq(s["safety_margin"], d["safety_margin"]) &&
            eq(a["trigger_tokens"], b["trigger_tokens"]) && eq(a["chapter_cap_tokens"], b["chapter_cap_tokens"])
    }
    fun normalizeState(st: Any?): JObj {
        val base = newState()
        if (!Js.truthy(st) || !isObj(st)) return base
        val blocks = BLOCK_DEFS.mapTo(ArrayList<Any?>()) { d ->
            val b = (st["blocks"] as? List<*>)?.firstOrNull { x -> Js.truthy(x) && x["id"] == d["id"] } ?: JObj()
            val o = jobj("id" to d["id"], "version" to i32(b["version"]), "content" to Js.str(Js.or(b["content"], "")), "history" to (if (b["history"] is List<*>) b["history"] else ArrayList<Any?>()),
                "updatedAt" to Js.or(b["updatedAt"], 0.0))
            o["restoredFrom"] = (b as? Map<*, *>)?.let { if (it.containsKey("restoredFrom")) it["restoredFrom"] else Undefined } ?: Undefined   // JS: restoredFrom: b.restoredFrom（undefined 时 JSON 省略）
            o
        }
        val ss = Js.or(st["settings"], JObj())
        val D = DEFAULT_SETTINGS
        val settings = Js.assign(D, m(ss), jobj(
            "summary" to Js.assign(m(D["summary"]), m(Js.or(ss["summary"], JObj()))),
            "lore" to Js.assign(m(D["lore"]), m(Js.or(ss["lore"], JObj()))),
            "lagrange_layers" to if (ss["lagrange_layers"] is List<*>) (ss["lagrange_layers"] as List<*>).toMutableList() else (D["lagrange_layers"] as List<*>).toMutableList(),
            "budget_mode" to if (ss["budget_mode"] == "greedy" || ss["budget_mode"] == "lagrangian") ss["budget_mode"] else D["budget_mode"],
            "min_history_ratio" to if (ss["min_history_ratio"] != null && Js.toNumber(ss["min_history_ratio"]).isFinite()) maxOf(0.0, minOf(1.0, Js.toNumber(ss["min_history_ratio"]))) else D["min_history_ratio"]))
        if (ss["max_context"] != null && ss["auto_budget"] == null) settings["auto_budget"] = budgetIsDefault(settings)
        var chapters = st["chapters"] as? List<Any?>
        var chapterSeq = i32(st["chapterSeq"])
        if (chapters == null) { chapters = migrateSummaries(st["summaries"]) ?: ArrayList(); chapterSeq = maxOf(chapterSeq, chapters.size.toDouble()) }
        val c = st["calib"]; val calib = if (c is Double && c >= 0.5 && c <= 2.5) c else 1.0
        return Js.assign(m(st), jobj("blocks" to blocks, "settings" to settings, "staticVersion" to i32(st["staticVersion"]), "baseHash" to st["baseHash"],
            "summaries" to (if (st["summaries"] is List<*>) st["summaries"] else ArrayList<Any?>()), "chapters" to chapters,
            "chapterSeq" to maxOf(chapterSeq, chapters.fold(0.0) { n, ch -> maxOf(n, i32(ch["no"])) }),
            "archive" to (if (st["archive"] is List<*>) st["archive"] else ArrayList<Any?>()), "lastSummaryRound" to i32(st["lastSummaryRound"]), "calib" to calib,
            "window" to Js.assign(jobj("startId" to null, "startOrdinal" to 0), m(Js.or(st["window"], JObj()))), "seq" to i32(st["seq"]),
            "loreState" to normalizeLoreState(st["loreState"])))
    }
    fun getBlock(st: Any?, id: String): JObj? = (st["blocks"] as? List<*>)?.firstOrNull { it["id"] == id } as? JObj
    fun defOf(id: String) = BLOCK_DEFS.firstOrNull { it["id"] == id }

    class BlockResult(val block: JObj, val changed: Boolean)
    fun updateBlock(block: JObj, content: Any?, at: Any?): BlockResult {
        val c = Lore.canonicalize(content)
        if (c == block["content"]) return BlockResult(block, false)
        val history = ((block["history"] as? List<*>) ?: emptyList<Any?>()).toMutableList()
        val ver = block["version"].d()
        if (ver > 0) history += jobj("version" to block["version"], "content" to block["content"], "hash" to Js.sha256(Js.str(block["content"])), "at" to Js.or(Js.or(block["updatedAt"], at), 0.0))
        while (history.size > HISTORY_LIMIT) history.removeAt(0)
        val nb = Js.assign(block, jobj("content" to c, "version" to ver + 1, "history" to history, "updatedAt" to Js.or(at, 0.0)))
        nb.remove("restoredFrom")
        return BlockResult(nb, true)
    }
    fun restoreBlock(block: JObj, version: Any?, at: Any?): BlockResult {
        val h = (block["history"] as List<*>).firstOrNull { it["version"] == version } ?: throw JsError("找不到版本 v" + Js.str(version))
        val r = updateBlock(block, h["content"], at)
        if (r.changed) r.block["restoredFrom"] = version
        return r
    }
    /** → {state, changed} */
    fun setBlock(st: JObj, id: String, content: Any?, at: Any?, restoreVersion: Any? = null): JObj {
        val blocks0 = st["blocks"] as List<*>
        val i = blocks0.indexOfFirst { it["id"] == id }
        if (i < 0) throw JsError("未知的块：$id")
        val r = if (restoreVersion != null) restoreBlock(blocks0[i] as JObj, restoreVersion, at) else updateBlock(blocks0[i] as JObj, content, at)
        if (!r.changed) return jobj("state" to st, "changed" to false)
        val blocks = blocks0.toMutableList(); blocks[i] = r.block
        val out = Js.assign(st, jobj("blocks" to blocks))
        if (defOf(id)!!["layer"] == "L1") out["staticVersion"] = i32(st["staticVersion"]) + 1
        return jobj("state" to out, "changed" to true)
    }
    fun syncBase(st: JObj, baseSystem: Any?): JObj {
        val cb = Lore.canonicalize(baseSystem); val h = Js.sha256(cb)
        if (st["baseHash"] == h) return st
        return Js.assign(st, jobj("baseHash" to h, "staticVersion" to if (st["baseHash"] == null) maxOf(i32(st["staticVersion"]), if (cb.isNotEmpty()) 1.0 else 0.0) else i32(st["staticVersion"]) + 1))
    }
    fun explicitBaseUpdate(state: Any?, baseSystem: Any?, cause: Any?, at: Any?): JObj {
        val st = normalizeState(state); val s2 = syncBase(st, baseSystem)
        if (s2 === st) return jobj("state" to st, "changed" to false)
        return jobj("state" to Js.assign(s2, jobj("pendingStaticCause" to Js.assign(jobj("at" to Js.or(at, 0.0)), m(Js.or(cause, jobj("kind" to "manual")))))), "changed" to true)
    }
    fun markHistoryCause(state: Any?, cause: Any?, at: Any?): JObj =
        Js.assign(normalizeState(state), jobj("pendingHistoryCause" to Js.assign(jobj("at" to Js.or(at, 0.0)), m(Js.or(cause, jobj("kind" to "version"))))))

    // ---------- 分段文本 ----------
    private val SECTION_ALIASES = linkedMapOf(
        "world" to Js.re("^(世界观|世界背景|背景设定|世界设定)$"), "character" to Js.re("^(角色卡|角色设定|人物设定|角色)$"), "rules" to Js.re("^(RP ?规则|规则|扮演规则)$", "i"),
        "format" to Js.re("^(输出格式|回复格式|格式)$"), "fewshot" to Js.re("^(示例对白|示例对话|对白示例)$"), "prohibit" to Js.re("^(禁止事项|禁止)$"),
        "style" to Js.re("^(写作风格|文风|风格)$"), "opening" to Js.re("^(开场白|开场|开场旁白)$"))
    private val SECTION_SKIP = Js.re("^(精修说明|说明|备注)$")
    private val SEC_A = Js.re("^\\s*(?:#+\\s*)?(?:\\*\\*)?【([^】]{1,12})】(?:\\*\\*)?\\s*(.*)$")
    private val SEC_B = Js.re("^\\s{0,3}#{1,3}\\s+([^\\n]{1,12})\\s*$")
    fun parseSections(text: Any?): JObj? {
        val out = JObj(); var cur: String? = null
        (if (Js.truthy(text)) Js.str(text) else "").split("\n").forEach { line ->
            val mm = Js.match(SEC_A, line) ?: Js.match(SEC_B, line)
            if (mm != null) {
                val name = Js.trim(mm[1]!!)
                if (Js.test(SECTION_SKIP, name)) { cur = null; return@forEach }
                cur = SECTION_ALIASES.entries.firstOrNull { Js.test(it.value, name) }?.key
                cur?.let { k -> out[k] = (if (Js.truthy(out[k])) Js.str(out[k]) + "\n" else "") + (mm.getOrNull(2) ?: "") }
                return@forEach
            }
            cur?.let { k -> out[k] = Js.str(out[k]) + "\n" + line }
        }
        for (k in out.keys.toList()) { val v = Lore.canonicalize(out[k]); if (v.isEmpty()) out.remove(k) else out[k] = v }
        return if (out.keys.count { it != "opening" } >= 2) out else null
    }
    fun findSectionMessage(messages: List<Any?>?, limit: Int?): JObj? {
        val list = (messages ?: emptyList()).filter { Js.truthy(it) && it["role"] == "assistant" && !Js.truthy(it["error"]) && Js.truthy(it["content"]) }
        var i = list.size - 1; var seen = 0; val lim = if (limit == null || limit == 0) 8 else limit
        while (i >= 0 && seen < lim) { val f = parseSections(list[i]["content"]); if (f != null) return jobj("msg" to list[i], "fields" to f); i--; seen++ }
        return null
    }
}
