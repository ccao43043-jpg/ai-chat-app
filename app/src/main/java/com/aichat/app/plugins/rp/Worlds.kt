package com.aichat.app.plugins.rp

import com.aichat.app.plugins.js.*

/**
 * www/worlds.js 移植：世界模板（L1 设定库）、模板 → 对话同步（三路合并 / 漂移检测 / 审计回滚）、「从全文填入」与分节全文导出。
 * RPCache 参数对应 JS 的 RPCache 依赖（null ≡ JS 未传，按原文抛错）；Templates 对应 root.Templates（[templates] 为全局回退）。
 */
object Worlds {
    /** 内置沉浸式模板的最小接口（templates.js 的 defaultTemplates / applyToConv） */
    interface TemplatesApi { fun defaultTemplates(): List<Any?>?; fun applyToConv(conv: JObj, tpl: Any?): Any? }
    @Volatile var templates: TemplatesApi? = null
    @Volatile var clock: () -> Double = { System.currentTimeMillis().toDouble() }
    /** Date.now().toString(36) + Math.random().toString(36).slice(2, 8) */
    @Volatile var uid: () -> String = { java.lang.Long.toString(System.currentTimeMillis(), 36) + java.lang.Long.toString((Math.random() * 2176782336.0).toLong(), 36) }

    val BLOCK_IDS = listOf("world", "character", "rules", "format", "fewshot", "prohibit", "style")
    val BLOCK_META: Map<String, JObj> = linkedMapOf(
        "world" to jobj("title" to "世界观", "hint" to "世界背景、地点、势力、魔法/科技规则。几乎不改。", "placeholder" to "例：星际联邦与边缘殖民星并存；超光速航行受跃迁门限制…"),
        "character" to jobj("title" to "角色卡", "hint" to "角色身份、性格、说话方式、人物关系。可写必须遵守的情感/语气（如：必须温柔回应、必须称呼对方为…）。", "placeholder" to "例：林晚，28 岁，私家侦探。口吻克制带干幽默。必须：对搭档保持信任与关心；吃醋时用玩笑掩饰。"),
        "rules" to jobj("title" to "RP 规则", "hint" to "例如：NPC 不能读取玩家内心；NPC 只知道自己应该知道的信息；不替玩家决定行动。", "placeholder" to "例：不替玩家做决定；NPC 不知玩家内心独白；第三人称叙述…"),
        "format" to jobj("title" to "输出格式", "hint" to "回复格式、长度、人称、是否带动作描写等。", "placeholder" to "例：第三人称；动作放 *星号*；对白用中文引号；每轮 200–400 字…"),
        "fewshot" to jobj("title" to "示例对白", "hint" to "几段示例对话（Few-shot），展示期望文风。可写高兴/吃醋/紧张等情感对白样例。", "placeholder" to "例：\n用户：今天好累。\n角色：*把热茶推过去* 「先喝一口。我听着。」\n（吃醋）「……那家店人很多吗？你看起来挺开心。」"),
        "prohibit" to jobj("title" to "禁止事项", "hint" to "绝对不能出现的内容或行为。可写禁止的情感/互动（如：禁止无故冷淡、禁止突然分手、禁止 Orth 崩坏）。", "placeholder" to "例：禁止 Orth；禁止无铺垫的重大人设崩坏；禁止突然冷暴力或无故消失…"),
        "style" to jobj("title" to "写作风格", "hint" to "固定写作风格、语气、节奏。", "placeholder" to "例：偏文学短句；氛围感强；少形容词堆砌…"))

    private fun isObj(v: Any?) = v is Map<*, *> || v is List<*>
    @Suppress("UNCHECKED_CAST") private fun m(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>
    private fun i32(v: Any?) = Js.i32(v).toDouble()
    private fun L(v: Any?): List<Any?> = (v as? List<Any?>) ?: emptyList()

    fun canonBlock(text: Any?): String = Lore.canonicalize(text)
    fun hashBlock(text: Any?): String {
        val s = canonBlock(text); var h1 = 0x811c9dc5.toInt(); var h2 = 0x01000193
        for (c in s) { h1 = (h1 xor c.code) * 16777619; h2 = (h2 xor c.code) * 0x01000193 }
        fun hx(h: Int) = java.lang.Long.toHexString(h.toLong() and 0xffffffffL).padStart(8, '0')
        return hx(h1) + hx(h2)
    }
    fun blockHashMap(blocks: Any?): JObj { val src = if (Js.truthy(blocks) && isObj(blocks)) blocks else JObj(); val o = JObj(); BLOCK_IDS.forEach { o[it] = hashBlock(Js.or(src[it], "")) }; return o }
    fun normalizeChangelog(raw: Any?): JArr {
        if (raw !is List<*>) return ArrayList()
        return raw.map { e -> jobj("version" to i32(if (Js.truthy(e)) e["version"] else e), "at" to Js.or(if (Js.truthy(e)) e["at"] else e, 0.0), "note" to Js.str(Js.or(if (Js.truthy(e)) e["note"] else e, ""))) }
            .filterTo(ArrayList<Any?>()) { it["version"].d() > 0 }
    }
    fun emptyBlocks(): JObj { val o = JObj(); BLOCK_IDS.forEach { o[it] = "" }; return o }
    fun normalizeBlocks(raw: Any?): JObj { val src = if (Js.truthy(raw) && isObj(raw)) raw else JObj(); val o = emptyBlocks(); BLOCK_IDS.forEach { o[it] = canonBlock(src[it] ?: "") }; return o }
    fun normalizeWorld(w0: Any?): JObj {
        val w = w0 ?: JObj()
        val blocks = normalizeBlocks(w["blocks"]); val blockHash = blockHashMap(blocks)
        var version = i32(w["version"]); if (version < 1) version = 1.0
        var changelog = normalizeChangelog(w["changelog"])
        if (changelog.isEmpty()) changelog = jarr(jobj("version" to version, "at" to Js.or(Js.or(w["updatedAt"], w["createdAt"]), 0.0), "note" to "创建"))
        return jobj("id" to Js.or(w["id"], "w-" + uid()),
            "emoji" to Js.slice(Js.trim(Js.str(Js.or(w["emoji"], "🌍"))), 0, 4).ifEmpty { "🌍" },
            "name" to Js.trim(Js.str(Js.or(w["name"], ""))).ifEmpty { "未命名世界" },
            "desc" to Js.trim(Js.str(Js.or(w["desc"], ""))),
            "greeting" to Js.trim(Js.str(Js.or(w["greeting"], "")).replace("\r\n", "\n")),
            "blocks" to blocks, "blockHash" to blockHash, "version" to version, "changelog" to changelog,
            "updatedAt" to Js.or(w["updatedAt"], 0.0), "createdAt" to Js.or(w["createdAt"], 0.0))
    }
    fun defaultWorlds(): JArr = ArrayList()
    fun blocksChanged(a: Any?, b: Any?): Boolean {
        val ha = Js.or(if (Js.truthy(a)) a["blockHash"] else a, null) ?: blockHashMap(if (Js.truthy(a)) a["blocks"] else a)
        val hb = Js.or(if (Js.truthy(b)) b["blockHash"] else b, null) ?: blockHashMap(if (Js.truthy(b)) b["blocks"] else b)
        return BLOCK_IDS.any { ha[it] != hb[it] }
    }
    fun upsert(list: List<Any?>?, item: Any?, note: Any?): JArr {
        val n = normalizeWorld(item); val now = clock()
        if (!Js.truthy(n["createdAt"])) n["createdAt"] = now
        n["updatedAt"] = now
        val src = list ?: emptyList()
        val i = src.indexOfFirst { it["id"] == n["id"] }
        val out = src.toMutableList()
        if (i >= 0) {
            val prev = normalizeWorld(src[i])
            if (blocksChanged(prev, n)) {
                n["version"] = Js.or(prev["version"], 1.0).d() + 1
                n["changelog"] = (L(Js.or(prev["changelog"], ArrayList<Any?>())) + listOf(jobj("version" to n["version"], "at" to now, "note" to Js.or(note, "更新设定")))).toMutableList()
            } else {
                n["version"] = Js.or(prev["version"], 1.0)
                n["changelog"] = if (L(prev["changelog"]).isNotEmpty()) prev["changelog"] else n["changelog"]
                n["blockHash"] = prev["blockHash"]
            }
            out[i] = Js.assign(m(src[i]), n, jobj("createdAt" to Js.or(src[i]["createdAt"], n["createdAt"])))
        } else {
            n["version"] = 1.0
            n["changelog"] = jarr(jobj("version" to 1, "at" to now, "note" to Js.or(note, "创建")))
            out += n
        }
        return out
    }
    fun duplicate(list: List<Any?>?, id: Any?): List<Any?> {
        val src = (list ?: emptyList()).firstOrNull { it["id"] == id } ?: return list ?: ArrayList()
        val copy = normalizeWorld(Js.assign(m(Js.clone(src)), jobj("id" to "w-" + uid(), "name" to Js.strOrEmptyUndef(src as Map<*, *>, "name") + "（副本）", "createdAt" to 0, "updatedAt" to 0,
            "version" to 1, "changelog" to ArrayList<Any?>())))
        val i = list!!.indexOfFirst { it === src }
        val out = list.toMutableList(); out.add(i + 1, copy)
        return out
    }
    fun remove(list: List<Any?>?, id: Any?): JArr = (list ?: emptyList()).filterTo(ArrayList()) { it["id"] != id }

    const val WORLD_START_TEMPLATE_ID = "t-rp-immersive"
    fun immersiveFields(api: TemplatesApi? = null): JObj {
        val T = api ?: templates ?: return JObj()
        val tpl = (T.defaultTemplates() ?: emptyList()).firstOrNull { Js.truthy(it) && it["id"] == WORLD_START_TEMPLATE_ID } ?: return JObj()
        return m(T.applyToConv(JObj(), tpl))?.let { JObj(it) } ?: JObj()
    }
    fun conversationFromWorld(world: Any?, providers: List<Any?>?, fallback: Any?, api: TemplatesApi? = null): JObj {
        val w = normalizeWorld(world); val fb = fallback ?: JObj()
        val prov = if (Js.truthy(fb["providerId"])) (providers ?: emptyList()).firstOrNull { it["id"] == fb["providerId"] } else null
        val providerId = if (prov != null) prov["id"] else Js.or(fb["providerId"], "")
        val model = Js.or(Js.or(fb["model"], if (prov != null) L(Js.or(prov["models"], ArrayList<Any?>())).firstOrNull() else null), "")
        return Js.assign(jobj("providerId" to providerId, "model" to model, "worldId" to w["id"], "worldName" to w["name"], "worldEmoji" to w["emoji"],
            "title" to Js.trim(Js.str(w["emoji"]) + " " + Js.str(w["name"]))), immersiveFields(api))
    }
    fun applyWorldToState(state: JObj, world: Any?, at: Any?, setBlock: ((JObj, String, Any?, Any?) -> JObj)?): JObj {
        if (setBlock == null) throw JsError("需要 setBlock")
        val w = normalizeWorld(world); var st = state; var any = false
        BLOCK_IDS.forEach { id -> val r = setBlock(st, id, Js.or(w["blocks"][id], ""), at); st = r["state"] as JObj; if (Js.truthy(r["changed"])) any = true }
        return jobj("state" to st, "changed" to any)
    }
    fun applyWorldToConversation(conv: Any?, world: Any?, rp: RpState?, at: Any?): JObj {
        if (!Js.truthy(conv) || rp == null) throw JsError("需要 conv 与 RPCache")
        val w = normalizeWorld(world); val t = Js.or(at, clock())
        val plugins = JObj(m(Js.or(conv["plugins"], JObj())) ?: emptyMap()); val data = JObj(m(Js.or(plugins["rpcache"], JObj())) ?: emptyMap())
        data["enabled"] = true
        val st = if (Js.truthy(data["state"])) rp.normalizeState(data["state"]) else rp.newState()
        val applied = applyWorldToState(st, w, t) { s, id, c, a -> rp.setBlock(s, id, c, a) }
        data["state"] = applied["state"]
        data["state"] = rp.syncBase(data["state"] as JObj, Js.or(conv["systemPrompt"], ""))
        plugins["rpcache"] = data
        return jobj("conv" to Js.assign(m(conv), jobj("worldId" to w["id"], "worldName" to w["name"], "worldEmoji" to w["emoji"], "worldRef" to makeWorldRef(w, t), "worldPending" to JObj(), "plugins" to plugins)),
            "changed" to applied["changed"])
    }
    fun makeWorldRef(world: Any?, at: Any?): JObj {
        val w = normalizeWorld(world)
        return jobj("id" to w["id"], "version" to w["version"], "blockHash" to JObj(m(w["blockHash"])!!), "syncedAt" to Js.or(at, clock()))
    }
    fun normalizeWorldRef(ref: Any?): JObj? {
        if (!Js.truthy(ref) || !isObj(ref)) return null
        val bh = JObj(); val src = if (Js.truthy(ref["blockHash"]) && isObj(ref["blockHash"])) ref["blockHash"] else JObj()
        BLOCK_IDS.forEach { id -> val v = src[id]; if (v != null && v != "") bh[id] = Js.str(v) }
        return jobj("id" to Js.str(Js.or(ref["id"], "")), "version" to i32(ref["version"]), "blockHash" to bh, "syncedAt" to Js.or(ref["syncedAt"], 0.0))
    }
    fun getConvBlocks(conv: Any?, rp: RpState?): JObj {
        val out = emptyBlocks()
        val st = conv["plugins"]["rpcache"]["state"]
        if (!Js.truthy(st) || rp == null) return out
        BLOCK_IDS.forEach { id -> val b = rp.getBlock(st, id); out[id] = if (b != null && b["content"] != null) Js.str(b["content"]) else "" }
        return out
    }
    fun normalizePending(raw: Any?): JObj {
        val out = JObj()
        if (!Js.truthy(raw) || !isObj(raw)) return out
        BLOCK_IDS.forEach { id -> val v = raw[id]; if (v != null && Js.str(v).isNotEmpty()) out[id] = canonBlock(v) }
        return out
    }
    fun merge3(base: Any?, current: Any?, theirs: Any?): JObj {
        val b = canonBlock(base); val c = canonBlock(current); val t = canonBlock(theirs)
        if (c == b) return jobj("content" to t, "action" to "takeTheirs")
        if (c == t) return jobj("content" to c, "action" to "unchanged")
        if (b == t) return jobj("content" to c, "action" to "keepCurrent")
        return jobj("content" to c, "action" to "conflict", "_pending" to t)
    }
    fun classifyBlock(id: String, current: Any?, theirs: Any?, worldRef: Any?): JObj {
        val c = canonBlock(current); val t = canonBlock(theirs)
        val ref = normalizeWorldRef(worldRef)
        val refHash = ref?.get("blockHash")?.get(id)
        if (refHash == null) {
            if (c == t) return jobj("id" to id, "action" to "unchanged", "content" to c, "drifted" to false, "locallyEdited" to false)
            return jobj("id" to id, "action" to "conflict", "content" to c, "_pending" to t, "drifted" to true, "locallyEdited" to true)
        }
        val curHash = hashBlock(c); val theirsHash = hashBlock(t)
        val ceb = curHash == refHash; val cet = curHash == theirsHash; val bet = refHash == theirsHash
        if (cet) return jobj("id" to id, "action" to "unchanged", "content" to c, "drifted" to !bet, "locallyEdited" to !ceb)
        if (ceb) return jobj("id" to id, "action" to "takeTheirs", "content" to t, "drifted" to !bet, "locallyEdited" to false)
        if (bet) return jobj("id" to id, "action" to "keepCurrent", "content" to c, "drifted" to false, "locallyEdited" to true)
        return jobj("id" to id, "action" to "conflict", "content" to c, "_pending" to t, "drifted" to true, "locallyEdited" to true)
    }
    fun detectDrift(conv: Any?, world: Any?, currentBlocks: Any?): JObj {
        val w = normalizeWorld(world)
        val blocks = Js.or(Js.or(currentBlocks, conv["_blocks"]), null) ?: emptyBlocks()
        val ref = normalizeWorldRef(conv["worldRef"])
        val classified = BLOCK_IDS.mapTo(ArrayList<Any?>()) { classifyBlock(it, blocks[it], w["blocks"][it], ref) }
        val ids = classified.filter { Js.truthy(it["drifted"]) }.mapTo(ArrayList<Any?>()) { it["id"] }
        val drift = JObj(); ids.forEach { drift[it as String] = true }
        // stale：ids.length > 0 || !ref || ref.version !== w.version || (ref.id && ref.id !== w.id) —— 末项可能得到 ''
        val stale: Any? = if (ids.isNotEmpty() || ref == null || ref["version"] != w["version"]) true else if (!Js.truthy(ref["id"])) ref["id"] else ref["id"] != w["id"]
        return jobj("drift" to drift, "ids" to ids, "classified" to classified, "world" to w, "ref" to ref, "stale" to stale)
    }
    fun blockTitle(id: Any?): Any? = Js.or(BLOCK_META[Js.str(id)]?.get("title"), id)
    fun formatDriftMessage(report: Any?, world: Any?): String {
        val w = Js.or(Js.or(world, report["world"]), JObj())
        val ver = Js.i32(w["version"])
        val list = L(report["classified"])
        val fresh = list.filter { it["action"] == "takeTheirs" }
        val kept = list.filter { it["action"] == "conflict" || (Js.truthy(it["locallyEdited"]) && Js.truthy(it["drifted"])) }
        val bits = ArrayList<String>()
        if (fresh.isNotEmpty()) bits += fresh.joinToString("、") { Js.str(blockTitle(it["id"])) } + " " + fresh.size + " 块有新内容"
        if (kept.isNotEmpty()) bits += kept.joinToString("、") { Js.str(blockTitle(it["id"])) } + (if (kept.size == 1) "块" else "") + "你本地改过，将保留"
        if (bits.isEmpty() && L(report["ids"]).isNotEmpty()) bits += L(report["ids"]).joinToString("、") { Js.str(blockTitle(it)) } + " 有变更"
        return "模板已更新到 v$ver" + if (bits.isNotEmpty()) "：" + bits.joinToString("；") else ""
    }
    fun snapshotBlocks(blocks: Any?, ids: List<Any?>?): JObj { val src = blocks ?: JObj(); val o = JObj(); (ids ?: BLOCK_IDS).forEach { o[it as String] = canonBlock(Js.or(src[it], "")) }; return o }

    fun planSync(conv: Any?, world: Any?, currentBlocks: Any?, mode: Any?): JObj {
        val w = normalizeWorld(world)
        val blocks = Js.or(currentBlocks, null) ?: emptyBlocks()
        val report = detectDrift(Js.assign(m(conv), jobj("worldRef" to conv["worldRef"])), w, blocks)
        val md = Js.or(mode, "merge")
        val nextBlocks = JObj(m(blocks) ?: emptyMap())
        val pending = normalizePending(conv["worldPending"])
        val changed = ArrayList<Any?>()
        if (md == "skip") return jobj("mode" to "skip", "world" to w, "report" to report, "nextBlocks" to nextBlocks, "pending" to pending, "changed" to changed,
            "message" to formatDriftMessage(report, w), "worldRef" to if (Js.truthy(conv["worldRef"])) normalizeWorldRef(conv["worldRef"]) else null, "skipVersion" to w["version"])
        L(report["classified"]).forEach { row ->
            val id = row["id"] as String
            if (md == "overwrite") {
                if (canonBlock(Js.or(blocks[id], "")) != canonBlock(Js.or(w["blocks"][id], ""))) changed += id
                nextBlocks[id] = Js.or(w["blocks"][id], ""); pending.remove(id); return@forEach
            }
            when (row["action"]) {
                "takeTheirs" -> { nextBlocks[id] = row["content"]; pending.remove(id); changed += id }
                "conflict" -> { nextBlocks[id] = row["content"]; pending[id] = row["_pending"] }
                else -> { nextBlocks[id] = row["content"]; if (row["action"] != "unchanged") pending.remove(id) }
            }
        }
        val o = jobj("mode" to md, "world" to w, "report" to report, "nextBlocks" to nextBlocks, "pending" to pending, "changed" to changed,
            "message" to formatDriftMessage(report, w), "worldRef" to makeWorldRef(w, 0.0))
        o["skipVersion"] = Undefined
        return o
    }
    private fun applyBlockMap(conv: Any?, blocks: Any?, rp: RpState, at: Any?, ids: List<Any?>?): JObj {
        val plugins = JObj(m(Js.or(conv["plugins"], JObj())) ?: emptyMap()); val data = JObj(m(Js.or(plugins["rpcache"], JObj())) ?: emptyMap())
        data["enabled"] = true
        var st = if (Js.truthy(data["state"])) rp.normalizeState(data["state"]) else rp.newState()
        var any = false
        (ids ?: BLOCK_IDS).forEach { id -> val r = rp.setBlock(st, id as String, Js.or(blocks[id], ""), at); st = r["state"] as JObj; if (Js.truthy(r["changed"])) any = true }
        st = rp.syncBase(st, Js.or(conv["systemPrompt"], ""))
        data["state"] = st; plugins["rpcache"] = data
        return jobj("plugins" to plugins, "changed" to any, "state" to st)
    }
    fun applySyncToConversation(conv: Any?, world: Any?, rp: RpState?, opts0: Any?): JObj {
        if (!Js.truthy(conv) || rp == null) throw JsError("需要 conv 与 RPCache")
        val opts = opts0 ?: JObj()
        val mode = Js.or(opts["mode"], "merge"); val t = Js.or(opts["at"], clock())
        val w = normalizeWorld(world)
        val current = getConvBlocks(conv, rp)
        val plan = planSync(conv, w, current, mode)
        val beforeRef = normalizeWorldRef(conv["worldRef"]); val beforePending = normalizePending(conv["worldPending"])
        val log0 = L(Js.or(conv["worldLog"], ArrayList<Any?>()))
        if (mode == "skip") {
            val log = jobj("at" to t, "from" to (beforeRef?.get("version") ?: 0.0), "to" to w["version"], "blocks" to ArrayList<Any?>(), "mode" to "skip",
                "before" to jobj("worldRef" to beforeRef, "blocks" to snapshotBlocks(current, emptyList()), "pending" to beforePending),
                "after" to jobj("worldRef" to beforeRef, "blocks" to snapshotBlocks(current, emptyList()), "pending" to beforePending))
            return jobj("conv" to Js.assign(m(conv), jobj("worldId" to w["id"], "worldName" to w["name"], "worldEmoji" to w["emoji"], "worldSkipVersion" to w["version"], "worldLog" to (log0 + listOf(log)).toMutableList())),
                "plan" to plan, "changed" to false)
        }
        val chg = L(plan["changed"])
        val ids = if (mode == "overwrite") BLOCK_IDS else chg + Js.keys(plan["pending"] as Map<*, *>)
        val uniqueIds = BLOCK_IDS.filter { it in ids || it in chg }
        val applied = applyBlockMap(conv, plan["nextBlocks"], rp, t, if (mode == "overwrite") BLOCK_IDS else uniqueIds)
        val nextRef = makeWorldRef(w, t)
        val log = jobj("at" to t, "from" to (beforeRef?.get("version") ?: 0.0), "to" to w["version"], "blocks" to (if (mode == "overwrite") BLOCK_IDS else chg).toMutableList<Any?>(), "mode" to mode,
            "before" to jobj("worldRef" to beforeRef, "blocks" to snapshotBlocks(current, BLOCK_IDS), "pending" to beforePending, "skipVersion" to Js.or(conv["worldSkipVersion"], 0.0)),
            "after" to jobj("worldRef" to nextRef, "blocks" to snapshotBlocks(plan["nextBlocks"], BLOCK_IDS), "pending" to plan["pending"]))
        return jobj("conv" to Js.assign(m(conv), jobj("worldId" to w["id"], "worldName" to w["name"], "worldEmoji" to w["emoji"], "worldRef" to nextRef, "worldPending" to plan["pending"],
            "worldSkipVersion" to 0, "worldLog" to (log0 + listOf(log)).toMutableList(), "plugins" to applied["plugins"])),
            "plan" to plan, "changed" to (Js.truthy(applied["changed"]) || chg.isNotEmpty()))
    }
    fun applyPendingBlock(conv: Any?, blockId: String, rp: RpState?, at: Any?): JObj {
        if (!Js.truthy(conv) || rp == null) throw JsError("需要 conv 与 RPCache")
        val pending = normalizePending(conv["worldPending"])
        if (!Js.truthy(pending[blockId])) return jobj("conv" to conv, "changed" to false)
        val t = Js.or(at, clock())
        val current = getConvBlocks(conv, rp)
        val next = Js.assign(current, jobj(blockId to pending[blockId]))
        val rest = JObj(pending); rest.remove(blockId)
        val applied = applyBlockMap(conv, next, rp, t, listOf(blockId))
        val ref = normalizeWorldRef(conv["worldRef"]) ?: jobj("id" to Js.or(conv["worldId"], ""), "version" to 0, "blockHash" to JObj(), "syncedAt" to t)
        val nextRef = Js.assign(ref, jobj("blockHash" to Js.assign(m(ref["blockHash"]), jobj(blockId to hashBlock(next[blockId]))), "syncedAt" to t))
        val log = jobj("at" to t, "from" to ref["version"], "to" to ref["version"], "blocks" to jarr(blockId), "mode" to "pending",
            "before" to jobj("worldRef" to ref, "blocks" to snapshotBlocks(current, listOf(blockId)), "pending" to pending),
            "after" to jobj("worldRef" to nextRef, "blocks" to snapshotBlocks(next, listOf(blockId)), "pending" to rest))
        return jobj("conv" to Js.assign(m(conv), jobj("worldRef" to nextRef, "worldPending" to rest, "worldLog" to (L(Js.or(conv["worldLog"], ArrayList<Any?>())) + listOf(log)).toMutableList(), "plugins" to applied["plugins"])),
            "changed" to true)
    }
    fun rollbackWorldLog(conv: Any?, rp: RpState?, opts: Any?): JObj {
        if (!Js.truthy(conv) || rp == null) throw JsError("需要 conv 与 RPCache")
        val log = L(conv["worldLog"])
        if (log.isEmpty()) return jobj("conv" to conv, "changed" to false, "reason" to "empty")
        val idx = if (opts["index"] != null) opts["index"].d() else (log.size - 1).toDouble()
        if (idx < 0 || idx >= log.size) return jobj("conv" to conv, "changed" to false, "reason" to "index")
        val entry = log[idx.toInt()]
        val t = Js.or(opts["at"], clock())
        val current = getConvBlocks(conv, rp)
        val before = Js.or(entry["before"], JObj())
        val bb = m(Js.or(before["blocks"], JObj())) ?: emptyMap()
        val restore = Js.assign(current, bb)
        val ids = Js.keys(bb)
        val applied = applyBlockMap(conv, restore, rp, t, if (ids.isNotEmpty()) ids else BLOCK_IDS)
        return jobj("conv" to Js.assign(m(conv), jobj("worldRef" to Js.or(before["worldRef"], null), "worldPending" to normalizePending(before["pending"]),
            "worldSkipVersion" to Js.or(before["skipVersion"], 0.0), "worldLog" to log.subList(0, idx.toInt()).toMutableList(), "plugins" to applied["plugins"])),
            "changed" to true, "entry" to entry)
    }
    fun shouldShowDrift(conv: Any?, world: Any?, currentBlocks: Any?): JObj {
        val report = detectDrift(conv, world, currentBlocks)
        val pending = normalizePending(conv["worldPending"])
        val hasPending = pending.isNotEmpty()
        if (L(report["ids"]).isEmpty() && !hasPending) return Js.assign(jobj("show" to false, "pending" to pending), report)
        val skip = conv["worldSkipVersion"]; val ver = report["world"]["version"]
        if (Js.truthy(skip) && skip == ver && !hasPending) return Js.assign(jobj("show" to false, "skipped" to true, "pending" to pending), report)
        return Js.assign(jobj("show" to true, "pending" to pending), report)
    }
    fun greetingMessage(world: Any?, conv: Any?, now: Any?, idFn: (() -> Any?)?): JObj? {
        val g = normalizeWorld(world)["greeting"] as String
        if (g.isEmpty() || !Js.truthy(conv) || (Js.truthy(conv["messages"]) && L(conv["messages"]).isNotEmpty())) return null
        return jobj("id" to (idFn?.invoke() ?: ("m-" + uid())), "role" to "assistant", "content" to g, "model" to conv["model"], "createdAt" to Js.or(now, clock()))
    }
    fun filledBlockCount(world: Any?): Int { val b = normalizeWorld(world)["blocks"]; return BLOCK_IDS.count { Js.trim(Js.str(Js.or(b[it], ""))).isNotEmpty() } }

    // ---------- 一键粘贴完整设定 → 各块；当前世界 → 分节全文 ----------
    val SECTION_TITLES = linkedMapOf("world" to "世界观", "character" to "角色卡", "rules" to "RP规则", "format" to "输出格式", "fewshot" to "示例对白", "prohibit" to "禁止事项", "style" to "写作风格")
    private const val KEEP_MARK = "\u2063"
    private val KNOWN_HEAD = Js.re("^(世界观|世界背景|背景设定|世界设定|角色卡|角色设定|人物设定|角色|RP ?规则|规则|扮演规则|输出格式|回复格式|格式|示例对白|示例对话|对白示例|禁止事项|禁止|写作风格|文风|风格|开场白|开场|开场旁白|精修说明|说明|备注)$", "i")
    private val SUB_A = Js.re("^\\s*(?:#+\\s*)?(?:\\*\\*)?【([^】]{1,12})】")
    private val SUB_B = Js.re("^\\s{0,3}#{1,3}\\s+([^\\n]{1,12})\\s*$")
    fun protectSubheads(text: Any?): String = (if (Js.truthy(text)) Js.str(text) else "").split("\n").joinToString("\n") { line ->
        val mm = Js.match(SUB_A, line) ?: Js.match(SUB_B, line)
        if (mm != null && !Js.test(KNOWN_HEAD, Js.trim(mm[1]!!))) KEEP_MARK + line else line
    }
    fun unprotect(s: Any?): String = (if (Js.truthy(s)) Js.str(s) else "").split(KEEP_MARK).joinToString("")
    private val NAME_FALLBACK = Js.re("(?:姓名|名字|角色名)\\s*[：:]\\s*([^\\n，,（(、；;/|]{1,20})")
    /** parsers：useRp = JS 能拿到 RPCache.parseSections；useAutoChar = 能拿到 AutoChar（App 中两者都在） */
    fun parseWorldSections(text: Any?, useRp: Boolean = true, useAutoChar: Boolean = true): JObj? {
        if (!useRp) return null
        var t = if (Js.truthy(text)) Js.str(text) else ""
        if (Js.trim(t).isEmpty()) return null
        if (useAutoChar) t = AutoChar.normalize(t)
        val raw = RpState.parseSections(protectSubheads(t)) ?: return null
        val fields = JObj()
        for (k in Js.keys(raw)) { val v = canonBlock(unprotect(raw[k])); if (v.isNotEmpty()) fields[k] = v }
        val blocks = JObj(); BLOCK_IDS.forEach { if (Js.truthy(fields[it])) blocks[it] = fields[it] }
        if (blocks.size < 2) return null
        val name = if (useAutoChar) AutoChar.charName(fields) else {
            val mm = Js.match(NAME_FALLBACK, Js.replace(Js.re("\\*\\*|__", "g"), Js.str(Js.or(fields["character"], "")), true, ""))
            if (mm != null) Js.replace(Js.re("[。.\\s]+$"), Js.trim(mm[1]!!), false, "") else ""
        }
        return jobj("blocks" to blocks, "greeting" to Js.or(fields["opening"], ""), "name" to name, "fields" to fields)
    }
    private fun isBlank(v: Any?) = Js.trim(if (v == null) "" else Js.str(v)).isEmpty()
    fun applySectionsToWorld(world: Any?, parsed: Any?, opts: Any?): JObj {
        val overwrite = Js.truthy(opts["overwrite"])
        val src = if (Js.truthy(world) && isObj(world)) m(world) ?: emptyMap() else emptyMap()
        val out = Js.assign(src, jobj("blocks" to JObj(m(Js.or(src["blocks"], JObj())) ?: emptyMap())))
        val ob = out["blocks"] as JObj
        val filled = ArrayList<Any?>(); val skipped = ArrayList<Any?>()
        var gF = false; var nF = false; var gS = false; var nS = false
        fun res() = jobj("world" to out, "filled" to filled, "skipped" to skipped, "greetingFilled" to gF, "nameFilled" to nF, "greetingSkipped" to gS, "nameSkipped" to nS)
        if (!Js.truthy(parsed) || !Js.truthy(parsed["blocks"])) return res()
        BLOCK_IDS.forEach { id ->
            val v = parsed["blocks"][id]
            if (isBlank(v)) return@forEach
            if (!overwrite && !isBlank(ob[id])) { if (canonBlock(ob[id]) != canonBlock(v)) skipped += id; return@forEach }
            if (canonBlock(ob[id]) == canonBlock(v)) return@forEach
            ob[id] = v; filled += id
        }
        if (!isBlank(parsed["greeting"])) {
            if (!overwrite && !isBlank(out["greeting"])) { if (Js.trim(Js.str(out["greeting"])) != Js.trim(Js.str(parsed["greeting"]))) gS = true }
            else if (Js.trim(Js.str(Js.or(out["greeting"], ""))) != Js.trim(Js.str(parsed["greeting"]))) { out["greeting"] = parsed["greeting"]; gF = true }
        }
        if (!isBlank(parsed["name"])) {
            if (!overwrite && !isBlank(out["name"])) { if (Js.trim(Js.str(out["name"])) != Js.trim(Js.str(parsed["name"]))) nS = true }
            else if (Js.trim(Js.str(Js.or(out["name"], ""))) != Js.trim(Js.str(parsed["name"]))) { out["name"] = parsed["name"]; nF = true }
        }
        return res()
    }
    fun formatWorldSections(world: Any?): String {
        val w = if (Js.truthy(world) && isObj(world)) world else JObj()
        val b = Js.or(w["blocks"], JObj())
        val parts = ArrayList<String>()
        BLOCK_IDS.forEach { id -> val v = canonBlock(b[id]); if (Js.trim(v).isNotEmpty()) parts += "【" + SECTION_TITLES[id] + "】\n" + v }
        val g = canonBlock(w["greeting"]); if (Js.trim(g).isNotEmpty()) parts += "【开场白】\n$g"
        return parts.joinToString("\n\n")
    }
    fun sectionTitle(id: Any?): Any? = if (id == "opening") "开场白" else Js.or(SECTION_TITLES[Js.str(id)], id)
}
