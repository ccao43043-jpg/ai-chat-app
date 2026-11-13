package com.aichat.app.plugins.knowledge

import com.aichat.app.plugins.js.*
import kotlin.math.ceil

/**
 * www/knowledge.js 逐函数移植（按世界隔离的本地资料库：CRUD、BM25F 检索、注入选型、导入导出）。
 * 时间 / uid 可注入（[clock]、[uid]），golden 测试里固定。
 */
object Knowledge {
    var clock: () -> Double = { System.currentTimeMillis().toDouble() }
    var uid: () -> String = { java.lang.Long.toString(System.currentTimeMillis(), 36) + java.lang.Long.toString((Math.random() * 2176782336.0).toLong(), 36).padStart(6, '0').take(6) }

    /** 读写抽象（store.get(key, null) / store.set(key, value)） */
    interface Store { fun get(key: String): Any?; fun set(key: String, value: Any?) }

    val DEFAULT_CATEGORY_DEFS: List<JObj> = listOf(
        jobj("id" to "housing", "name" to "住宅布局", "order" to 0), jobj("id" to "inventory", "name" to "物品/衣服/车辆", "order" to 1),
        jobj("id" to "actions", "name" to "做过的事", "order" to 2), jobj("id" to "locations", "name" to "地点", "order" to 3), jobj("id" to "other", "name" to "其他", "order" to 4),
    )
    val KB_WEIGHTS = mapOf("title" to 4.0, "keywords" to 3.0, "tags" to 2.0, "content" to 1.0)
    val KB_FIELDS = listOf("title", "keywords", "tags", "content")

    private fun s(v: Any?) = if (v == null) "" else Js.str(v)                       // String(v == null ? '' : v)
    private fun so(v: Any?) = if (Js.truthy(v)) Js.str(v) else ""                   // String(v || '')
    private fun isDefId(id: String) = DEFAULT_CATEGORY_DEFS.any { it["id"] == id }
    private fun defOf(id: String) = DEFAULT_CATEGORY_DEFS.firstOrNull { it["id"] == id }
    private fun crlf(v: String) = v.replace("\r\n", "\n")
    private fun stripBom(v: String) = if (v.startsWith("\uFEFF")) v.substring(1) else v
    private fun trimEndWs(v: String) = Js.trimEnd(v)                                 // .replace(/\s*$/, '')

    fun storeKey(worldId: Any?) = "knowledge_world_" + Js.trim(so(worldId)) + ".json"
    fun emptyCategories(): JArr = DEFAULT_CATEGORY_DEFS.mapTo(ArrayList()) { d -> jobj("id" to d["id"], "name" to d["name"], "order" to d["order"], "entries" to ArrayList<Any?>()) }

    fun normalizeKeywords(raw: Any?): JArr = when (raw) {
        is List<*> -> raw.map { Js.trim(s(it)) }.filter { it.isNotEmpty() }.toMutableList()
        is String -> Js.split(Js.re("[,，、\\s]+"), raw).map { Js.trim(it) }.filter { it.isNotEmpty() }.toMutableList()
        else -> ArrayList()
    }
    fun normalizeTags(raw: Any?): JArr = if (raw !is List<*>) ArrayList() else raw.map { Js.trim(s(it)) }.filter { it.isNotEmpty() }.toMutableList()

    fun normalizeEntry(e0: Any?, now: Any? = null): JObj {
        val e = e0 ?: JObj()
        return jobj(
            "id" to Js.or(e["id"], "e-" + uid()),
            "title" to Js.trim(s(e["title"])),
            "content" to crlf(s(e["content"])),
            "keywords" to normalizeKeywords(e["keywords"]),
            "tags" to normalizeTags(e["tags"]),
            "pinned" to Js.truthy(e["pinned"]),
            "updatedAt" to Js.or(e["updatedAt"], 0.0),
            "createdAt" to Js.or(e["createdAt"], 0.0),
        )
    }

    fun normalizeCategory(c0: Any?, idx: Any?): JObj {
        val c = c0 ?: JObj()
        val entries: JArr = (c["entries"] as? List<*>)?.mapTo(ArrayList()) { normalizeEntry(it) } ?: ArrayList()
        val ord = c["order"]
        return jobj(
            "id" to Js.trim(Js.str(Js.or(c["id"], "cat-" + uid()))).ifEmpty { "cat-" + uid() },
            "name" to Js.trim(s(c["name"])).ifEmpty { "未命名分类" },
            "order" to if (ord is Double && ord.isFinite()) ord else Js.i32(idx).toDouble(),
            "entries" to entries,
        )
    }

    fun emptyDoc(worldId: Any?): JObj = jobj("worldId" to so(worldId), "updatedAt" to 0.0, "categories" to emptyCategories())

    private val catCmp = Comparator<Any?> { a, b ->
        val d = a["order"].d() - b["order"].d()
        if (d != 0.0 && !d.isNaN()) (if (d < 0) -1 else 1) else JsCollate.compare(a["name"] as String, b["name"] as String, "zh")
    }

    fun normalizeDoc(raw: Any?, worldId: Any?): JObj {
        val wid = Js.trim(so(Js.or(raw?.let { it["worldId"] }, Js.or(worldId, ""))))
        if (wid.isEmpty()) return emptyDoc("")
        if (raw !is Map<*, *> && raw !is List<*>) return emptyDoc(wid)
        var cats: JArr = (raw["categories"] as? List<*>)?.mapIndexedTo(ArrayList()) { i, c -> normalizeCategory(c, i.toDouble()) } ?: ArrayList()
        if (cats.isEmpty()) cats = emptyCategories()
        cats.sortWith(catCmp)
        cats.forEachIndexed { i, c -> (c as JObj)["order"] = i.toDouble() }
        return jobj("worldId" to wid, "updatedAt" to Js.or(raw["updatedAt"], 0.0), "categories" to cats)
    }

    fun touch(doc: JObj, now: Any?): JObj { doc["updatedAt"] = Js.or(now, clock()); return doc }
    @Suppress("UNCHECKED_CAST") fun cloneDoc(doc: JObj): JObj = Js.parse(Js.stringify(doc)) as JObj
    private fun cats(doc: Any?): List<JObj> = (doc["categories"] as? List<*>)?.map { it as JObj } ?: emptyList()
    private fun entries(cat: Any?): JArr = (cat["entries"] as? JArr) ?: ArrayList()

    fun findCategory(doc: Any?, categoryId: Any?): JObj? = cats(doc).firstOrNull { it["id"] == categoryId }
    fun findEntry(doc: Any?, categoryId: Any?, entryId: Any?): JObj? {
        val cat = findCategory(doc, categoryId) ?: return null
        val entry = entries(cat).firstOrNull { it["id"] == entryId } ?: return null
        return jobj("category" to cat, "entry" to entry)
    }

    fun sortEntries(list: List<Any?>?): JArr = (list ?: emptyList()).toMutableList().also { l ->
        l.sortWith { a, b ->
            val pa = Js.truthy(a["pinned"]); val pb = Js.truthy(b["pinned"])
            if (pb != pa) return@sortWith if (pb) 1 else -1
            val d = Js.toNumber(Js.or(b["updatedAt"], 0.0)) - Js.toNumber(Js.or(a["updatedAt"], 0.0))
            if (d != 0.0 && !d.isNaN()) (if (d < 0) -1 else 1) else JsCollate.compare(Js.str(a["title"].orUndef(a, "title")), Js.str(b["title"].orUndef(b, "title")), "zh")
        }
    }
    private fun Any?.orUndef(o: Any?, k: String): Any? = if (this == null && (o as? Map<*, *>)?.containsKey(k) != true) Undefined else this

    fun load(store: Store?, worldId: Any?): JObj {
        val wid = Js.trim(so(worldId)); if (wid.isEmpty()) return emptyDoc("")
        val raw = store?.get(storeKey(wid)); if (!Js.truthy(raw)) return emptyDoc(wid)
        return normalizeDoc(raw, wid)
    }
    fun save(store: Store?, doc: JObj?): JObj {
        if (store == null) throw JsError("store 不可用")
        val n = normalizeDoc(doc, doc?.get("worldId"))
        if (!Js.truthy(n["worldId"])) throw JsError("缺少 worldId")
        store.set(storeKey(n["worldId"]), n); return n
    }
    fun ensure(store: Store, worldId: Any?, now: Any? = null): JObj {
        val wid = Js.trim(so(worldId)); if (wid.isEmpty()) throw JsError("缺少 worldId")
        val raw = store.get(storeKey(wid)); if (Js.truthy(raw)) return normalizeDoc(raw, wid)
        return save(store, touch(emptyDoc(wid), Js.or(now, clock())))
    }

    private fun base(doc: JObj) = cloneDoc(normalizeDoc(doc, doc["worldId"]))
    @Suppress("UNCHECKED_CAST") private fun catList(d: JObj) = d["categories"] as JArr

    fun addCategory(doc: JObj, patch: Any?, now: Any? = null): JObj {
        val d = base(doc); val t = Js.or(now, clock()); val n = catList(d).size.toDouble()
        val p = Js.assign(patch as? Map<String, Any?>, mapOf("id" to Js.or(patch?.let { it["id"] }, "cat-" + uid()), "order" to n, "entries" to ArrayList<Any?>()))
        val cat = normalizeCategory(p, n)
        if (cats(d).any { it["id"] == cat["id"] }) throw JsError("分类 id 已存在：" + Js.str(cat["id"]))
        catList(d).add(cat); return touch(d, t)
    }
    fun updateCategory(doc: JObj, categoryId: Any?, patch: Any?, now: Any? = null): JObj {
        val d = base(doc); val cat = findCategory(d, categoryId) ?: throw JsError("分类不存在：" + Js.str(categoryId))
        if (patch != null && patch["name"] != null) cat["name"] = Js.trim(Js.str(patch["name"])).ifEmpty { cat["name"] as String }
        val o = patch?.let { it["order"] }; if (o is Double && o.isFinite()) cat["order"] = o
        catList(d).sortWith(catCmp); catList(d).forEachIndexed { i, c -> (c as JObj)["order"] = i.toDouble() }
        return touch(d, Js.or(now, clock()))
    }
    fun removeCategory(doc: JObj, categoryId: Any?, now: Any? = null): JObj {
        val d = base(doc); val before = catList(d).size
        d["categories"] = catList(d).filterTo(ArrayList()) { it["id"] != categoryId }
        if (catList(d).size == before) throw JsError("分类不存在：" + Js.str(categoryId))
        catList(d).forEachIndexed { i, c -> (c as JObj)["order"] = i.toDouble() }
        return touch(d, Js.or(now, clock()))
    }
    fun reorderCategories(doc: JObj, orderedIds: List<Any?>?, now: Any? = null): JObj {
        val d = base(doc); val map = LinkedHashMap<Any?, JObj>(); cats(d).forEach { map[it["id"]] = it }
        val out: JArr = ArrayList()
        (orderedIds ?: emptyList()).forEach { id -> map.remove(id)?.let { out.add(it) } }
        cats(d).forEach { c -> if (map.containsKey(c["id"])) out.add(c) }
        out.forEachIndexed { i, c -> (c as JObj)["order"] = i.toDouble() }
        d["categories"] = out; return touch(d, Js.or(now, clock()))
    }

    fun addEntry(doc: JObj, categoryId: Any?, patch: Any?, now: Any? = null): JObj {
        val d = base(doc); val cat = findCategory(d, categoryId) ?: throw JsError("分类不存在：" + Js.str(categoryId))
        val t = Js.or(now, clock())
        @Suppress("UNCHECKED_CAST")
        val entry = normalizeEntry(Js.assign(patch as? Map<String, Any?>, mapOf("id" to Js.or(patch?.let { it["id"] }, "e-" + uid()), "createdAt" to Js.or(patch?.let { it["createdAt"] }, t), "updatedAt" to t)), t)
        if (entries(cat).any { it["id"] == entry["id"] }) throw JsError("条目 id 已存在：" + Js.str(entry["id"]))
        entries(cat).add(entry); return touch(d, t)
    }
    fun updateEntry(doc: JObj, categoryId: Any?, entryId: Any?, patch: Any?, now: Any? = null): JObj {
        val d = base(doc); val hit = findEntry(d, categoryId, entryId) ?: throw JsError("条目不存在：" + Js.str(entryId))
        val t = Js.or(now, clock()); val e = hit["entry"] as JObj
        if (patch != null) {
            if (patch["title"] != null) e["title"] = Js.trim(Js.str(patch["title"]))
            if (patch["content"] != null) e["content"] = crlf(Js.str(patch["content"]))
            if (patch["keywords"] != null) e["keywords"] = normalizeKeywords(patch["keywords"])
            if (patch["tags"] != null) e["tags"] = normalizeTags(patch["tags"])
            val p = patch["pinned"]; if (p is Boolean) e["pinned"] = p
        }
        e["updatedAt"] = t
        if (!Js.truthy(e["createdAt"])) e["createdAt"] = t
        return touch(d, t)
    }
    fun removeEntry(doc: JObj, categoryId: Any?, entryId: Any?, now: Any? = null): JObj {
        val d = base(doc); val cat = findCategory(d, categoryId) ?: throw JsError("分类不存在：" + Js.str(categoryId))
        val before = entries(cat).size
        cat["entries"] = entries(cat).filterTo(ArrayList()) { it["id"] != entryId }
        if (entries(cat).size == before) throw JsError("条目不存在：" + Js.str(entryId))
        return touch(d, Js.or(now, clock()))
    }
    fun setPinned(doc: JObj, categoryId: Any?, entryId: Any?, pinned: Any?, now: Any? = null) = updateEntry(doc, categoryId, entryId, jobj("pinned" to Js.truthy(pinned)), now)

    fun tokenize(q: Any?): List<String> = Js.split(Js.re("[\\s,，、;；|/]+"), RetrievalCore.lower(so(q))).map { Js.trim(it) }.filter { it.isNotEmpty() }

    private fun joinArr(v: Any?) = (v as? List<*>)?.joinToString(" ") { if (it == null) "" else Js.str(it) } ?: ""
    private fun entryHaystack(e: Any?) = RetrievalCore.lower(listOf(so(e["title"]), so(e["content"]), joinArr(Js.or(e["keywords"], ArrayList<Any?>())), joinArr(Js.or(e["tags"], ArrayList<Any?>()))).joinToString("\n"))

    private fun limitOf(opt: Any?) = Js.or(opt?.let { it["limit"] }, 50.0)
    private fun <T> sliceLimit(l: List<T>, limit: Any?): List<T> { val n = Js.toNumber(limit); return if (n.isNaN()) emptyList() else Js.slice(l, 0, if (n.isInfinite()) (if (n > 0) l.size else 0) else n.toInt()) }

    fun searchLegacy(doc: Any?, query: Any?, opt: Any?): List<JObj> {
        val d = normalizeDoc(doc, doc?.let { it["worldId"] }); val tokens = tokenize(query); val out = ArrayList<JObj>()
        for (cat in cats(d)) for (entry0 in entries(cat)) {
            val entry = entry0 as JObj; val hay = entryHaystack(entry); var score = 0.0
            if (tokens.isNotEmpty()) {
                var ok = true
                for (tok in tokens) {
                    if (!hay.contains(tok)) ok = false
                    else {
                        val kwHit = (entry["keywords"] as? List<*> ?: emptyList<Any?>()).any { RetrievalCore.lower(Js.str(it)).contains(tok) }
                        val titleHit = RetrievalCore.lower(so(entry["title"])).contains(tok)
                        score += if (kwHit) 5.0 else if (titleHit) 3.0 else 1.0
                    }
                }
                if (!ok) continue
            } else score = if (Js.truthy(entry["pinned"])) 1.0 else 0.0
            if (Js.truthy(entry["pinned"])) score += 10
            out += jobj("categoryId" to cat["id"], "categoryName" to cat["name"], "entry" to entry, "score" to score)
        }
        out.sortWith { a, b -> cmpNum(b["score"].d() - a["score"].d()).let { if (it != 0) it else cmpNum(Js.toNumber(Js.or(b["entry"]["updatedAt"], 0.0)) - Js.toNumber(Js.or(a["entry"]["updatedAt"], 0.0))) } }
        return sliceLimit(out, limitOf(opt))
    }
    private fun cmpNum(d: Double) = if (d < 0) -1 else if (d > 0) 1 else 0

    fun flattenEntries(doc: Any?): List<JObj> {
        val d = normalizeDoc(doc, doc?.let { it["worldId"] }); val out = ArrayList<JObj>()
        for (cat in cats(d)) for (entry in entries(cat)) out += jobj(
            "id" to entry["id"], "title" to Js.or(entry["title"], ""), "keywords" to Js.or(entry["keywords"], ArrayList<Any?>()), "tags" to Js.or(entry["tags"], ArrayList<Any?>()),
            "content" to Js.or(entry["content"], ""), "pinned" to Js.truthy(entry["pinned"]), "updatedAt" to Js.or(entry["updatedAt"], 0.0),
            "categoryId" to cat["id"], "categoryName" to cat["name"], "categoryOrder" to Js.i32(cat["order"]).toDouble(), "entry" to entry)
        return out
    }

    private var kbIndex: RetrievalCore.Index? = null
    fun resetIndexCache() { kbIndex = null }
    fun getIndexCache() = kbIndex

    fun searchBM25(doc: Any?, query: Any?, opt: Any?): List<JObj> {
        val limit = limitOf(opt); val docs = flattenEntries(doc)
        if (docs.isEmpty()) return emptyList()
        val idx = RetrievalCore.buildIndex(docs, KB_FIELDS, kbIndex); kbIndex = idx
        val q = RetrievalCore.buildQuery(Js.or(query, ""))
        val ex = opt?.let { it["expand"] }
        if (Js.truthy(ex)) {
            if (Js.truthy(ex["context"])) RetrievalCore.addQuery(q, ex["context"], 0.3)
            if (Js.truthy(ex["scene"])) RetrievalCore.addQuery(q, ex["scene"], 0.3)
            if (Js.truthy(ex["l1"])) RetrievalCore.addQuery(q, ex["l1"], 0.2)
        }
        val scored = docs.map { d ->
            var sc = RetrievalCore.bm25f(idx, q, d, KB_WEIGHTS)
            if (Js.truthy(d["pinned"])) sc += 1e6
            jobj("categoryId" to d["categoryId"], "categoryName" to d["categoryName"], "entry" to d["entry"], "score" to sc, "_doc" to d)
        }.filter { it["score"].d() > 0 || Js.truthy(it["entry"]["pinned"]) }.toMutableList()
        scored.sortWith { a, b ->
            var c = cmpNum(b["score"].d() - a["score"].d())
            if (c == 0) c = cmpNum(a["_doc"]["categoryOrder"].d() - b["_doc"]["categoryOrder"].d())
            if (c == 0) c = cmpNum(Js.toNumber(Js.or(b["entry"]["updatedAt"], 0.0)) - Js.toNumber(Js.or(a["entry"]["updatedAt"], 0.0)))
            c
        }
        return sliceLimit(scored, limit).map { jobj("categoryId" to it["categoryId"], "categoryName" to it["categoryName"], "entry" to it["entry"], "score" to it["score"]) }
    }

    fun search(doc: Any?, query: Any?, opt: Any?): List<JObj> =
        if (Js.or(opt?.let { it["mode"] }, "bm25") == "legacy") searchLegacy(doc, query, opt) else searchBM25(doc, query, opt)

    fun selectForInject(doc: Any?, query: Any?, opt: Any?): JObj {
        val o = opt ?: JObj()
        var budget = if (o["budget"] != null) Js.i32(o["budget"]) else 400
        val maxB = if (o["maxBudget"] != null) Js.i32(o["maxBudget"]) else 1200
        if (budget > maxB) budget = maxB
        if (budget < 0) budget = 0
        @Suppress("UNCHECKED_CAST")
        val raw = search(doc, query, Js.assign(o as? Map<String, Any?>, mapOf("limit" to 20.0, "mode" to "bm25")))
        val dropped: JArr = ArrayList()
        val already = (o["alreadyTexts"] as? List<*> ?: emptyList<Any?>()).map { Js.str(it) }
        val cands = ArrayList<JObj>()
        val d = normalizeDoc(doc, doc?.let { it["worldId"] })
        val pinned = ArrayList<JObj>()
        for (cat in cats(d)) for (e in entries(cat)) if (Js.truthy(e["pinned"])) pinned += jobj("categoryId" to cat["id"], "categoryName" to cat["name"], "entry" to e, "score" to 1e6)
        val seen = HashSet<String>()
        fun keyOf(id: Any?) = Js.stringify(id)
        fun consider(h: JObj?) {
            if (h == null || !Js.truthy(h["entry"]) || keyOf(h["entry"]["id"]) in seen) return
            val text = so(h["entry"]["title"]) + "\n" + so(h["entry"]["content"])
            for (a in already) if (RetrievalCore.jaccard3(text, a) > 0.6) { dropped.add(jobj("id" to h["entry"]["id"], "reason" to "dup")); return }
            for (c in cands) {
                val ct = so(c["entry"]["title"]) + "\n" + so(c["entry"]["content"])
                if (RetrievalCore.jaccard3(text, ct) > 0.6) { dropped.add(jobj("id" to h["entry"]["id"], "reason" to "dup")); return }
            }
            seen += keyOf(h["entry"]["id"])
            cands += jobj("id" to h["entry"]["id"], "score" to Js.or(h["score"], 0.0), "text" to text, "categoryId" to h["categoryId"], "categoryName" to h["categoryName"], "entry" to h["entry"])
        }
        pinned.forEach { consider(it) }
        raw.forEach { h ->
            if (h["score"].d() <= 0 && !Js.truthy(h["entry"]["pinned"])) { dropped.add(jobj("id" to h["entry"]["id"], "reason" to "lowscore")); return@forEach }
            consider(h)
        }
        val maxS = maxOf(1e-9, cands.maxOfOrNull { it["score"].d() } ?: Double.NEGATIVE_INFINITY)
        cands.forEach { c -> c["score"] = c["score"].d() / maxS }
        var ranked: List<JObj> = cands
        if (cands.isNotEmpty()) ranked = RetrievalCore.mmr(cands, if (o["lambda"] != null) o["lambda"].d() else 0.7, null, cands.size)
        val tokenOf = { c: JObj -> ceil(so(c["entry"]["content"]).length * 0.7) + ceil(so(c["entry"]["title"]).length * 0.5) + 8 }
        val picked = RetrievalCore.pickByBudget(ranked, tokenOf, budget.toDouble())
        val pickIds = picked.map { keyOf(Js.or(it["id"], it["entry"]?.let { e -> e["id"] })) }.toSet()
        ranked.forEach { c -> if (keyOf(c["id"]) !in pickIds) dropped.add(jobj("id" to c["id"], "reason" to "budget")) }
        picked.sortWith { a, b ->
            val ca = cats(d).firstOrNull { it["id"] == a["categoryId"] }; val cb = cats(d).firstOrNull { it["id"] == b["categoryId"] }
            val c = cmpNum(Js.toNumber(Js.or(ca?.get("order"), 0.0)) - Js.toNumber(Js.or(cb?.get("order"), 0.0)))
            if (c != 0) c else JsCollate.compare(so(a["entry"]["title"]), so(b["entry"]["title"]))
        }
        val hits = picked.map { c -> jobj("entry" to c["entry"], "categoryId" to c["categoryId"], "categoryName" to c["categoryName"], "score" to c["score"], "tokens" to (c["tokens"] ?: tokenOf(c))) }
        val tokens = hits.sumOf { Js.toNumber(Js.or(it["tokens"], 0.0)) }
        return jobj("hits" to hits.toMutableList<Any?>(), "trace" to jobj("hitIds" to hits.mapTo(ArrayList()) { it["entry"]["id"] }, "tokens" to tokens, "dropped" to dropped, "budget" to budget.toDouble()))
    }

    fun renderInjection(hits: List<Any?>?): String {
        if (hits.isNullOrEmpty()) return ""
        val lines = hits.map { h ->
            val tag = so(Js.or(Js.or(h["categoryName"], h["categoryId"]), "资料"))
            val title = so(h["entry"]?.let { it["title"] }); val body = so(h["entry"]?.let { it["content"] })
            "- [$tag] $title" + (if (body.isNotEmpty()) "：$body" else "")
        }
        return "[LOCAL_KNOWLEDGE]（本地资料库 · 仅供参考，不要逐字复述）\n" + lines.joinToString("\n")
    }

    fun spliceIntoUserContent(content: Any?, inj: Any?): Any? {
        if (!Js.truthy(inj)) return content
        val injS = Js.str(inj); val s = so(content)
        val stateAt = s.indexOf("[CURRENT_STATE]")
        if (stateAt >= 0) return trimEndWs(s.substring(0, stateAt)) + "\n\n" + injS + "\n\n" + s.substring(stateAt)
        val memAt = s.indexOf("[MEMORY_UPDATE]")
        if (memAt >= 0) {
            val after = s.indexOf("\n[", memAt + 1)
            if (after < 0) return trimEndWs(s) + "\n\n" + injS
            return trimEndWs(s.substring(0, after)) + "\n\n" + injS + s.substring(after)
        }
        return (if (s.isNotEmpty()) s + "\n\n" else "") + injS
    }

    fun listEntries(doc: Any?, categoryId: Any?): JArr {
        val d = normalizeDoc(doc, doc?.let { it["worldId"] })
        if (Js.truthy(categoryId)) { val cat = findCategory(d, categoryId); return if (cat != null) sortEntries(entries(cat)) else ArrayList() }
        val all = ArrayList<Any?>()
        for (cat in cats(d)) for (e in entries(cat)) { val o = jobj("categoryId" to cat["id"], "categoryName" to cat["name"]); o.putAll(e as JObj); all += o }
        return sortEntries(all)
    }

    fun slugifyCatId(name: Any?): String {
        var t = RetrievalCore.lower(Js.trim(so(name)))
        t = Js.replace(Js.re("\\s+", "g"), t, true, "-")
        t = Js.replace(Js.re("[^a-z0-9\\u4e00-\\u9fff_-]+", "g"), t, true, "")
        t = Js.slice(t, 0, 48)
        return t.ifEmpty { "cat-" + uid() }
    }

    fun parseBoolish(v: Any?): Boolean {
        if (v is Boolean) return v
        if (v is Double) return Js.truthy(v)
        val t = RetrievalCore.lower(Js.trim(s(v)))
        if (t.isEmpty()) return false
        return t == "1" || t == "true" || t == "yes" || t == "y" || t == "是" || t == "真"
    }

    private fun tryParse(t: String): Pair<Boolean, Any?> = try { true to JsJson.parse(t) } catch (_: JsSyntaxError) { false to null }
    private fun splitLines(v: String) = Js.split(Js.re("\\r?\\n"), v)

    fun detectImportFormat(text: Any?): String {
        val sx = Js.trim(stripBom(so(text)))
        if (sx.isEmpty()) return "empty"
        if (sx[0] == '{') {
            val (ok, o) = tryParse(sx)
            if (ok && o is Map<*, *>) {
                if (o["categories"] is List<*>) return "json"
                if (o["title"] != null || o["content"] != null || o["categoryId"] != null || o["category"] != null) return "ndjson"
            }
        }
        if (sx[0] == '[') {
            val (ok, a) = tryParse(sx)
            if (ok && a is List<*>) {
                if (a.isNotEmpty() && a[0] is Map<*, *> && a[0]["entries"] is List<*>) return "json"
                return "ndjson"
            }
        }
        val lines = splitLines(sx).map { Js.trim(it) }.filter { it.isNotEmpty() && !it.startsWith("#") }
        if (lines.isNotEmpty()) {
            val sample = lines.take(30); var ok = 0
            sample.forEach { line -> val (p, o) = tryParse(line); if (p && o is Map<*, *>) ok++ }
            if (ok > 0 && ok >= ceil(sample.size * 0.7)) return "ndjson"
        }
        if (Js.test(Js.re("^#{1,3}\\s+\\S", "m"), sx)) return "markdown"
        return "unknown"
    }

    fun entryFromRaw(raw0: Any?): JObj {
        val raw = raw0 ?: JObj()
        val catId = Js.trim(so(Js.or(raw["categoryId"], raw["category_id"])))
        val catName = Js.trim(so(Js.or(raw["categoryName"], raw["category_name"])))
        val categoryHint = catId.ifEmpty { if (raw["category"] != null) Js.trim(Js.str(raw["category"])) else "" }
        val tags = raw["tags"].let { if (it is String) normalizeKeywords(it) else it }
        val entry = normalizeEntry(jobj("id" to raw["id"], "title" to raw["title"], "content" to raw["content"], "keywords" to raw["keywords"], "tags" to tags,
            "pinned" to (if (raw["pinned"] != null) parseBoolish(raw["pinned"]) else false), "createdAt" to raw["createdAt"], "updatedAt" to raw["updatedAt"]))
        return jobj("categoryId" to catId, "categoryName" to catName, "categoryHint" to categoryHint, "entry" to entry)
    }

    private fun normCats(l: List<*>): JArr = l.mapIndexedTo(ArrayList()) { i, c -> normalizeCategory(c, i.toDouble()) }

    fun parseJsonImport(text: Any?): JObj {
        val sx = Js.trim(stripBom(so(text)))
        val o = JsJson.parse(sx)
        if (o is List<*>) {
            if (o.isNotEmpty() && o[0] != null && Js.truthy(o[0]) && o[0]["entries"] is List<*>) return jobj("format" to "json", "worldId" to "", "categories" to normCats(o), "entries" to ArrayList<Any?>())
            return jobj("format" to "ndjson", "worldId" to "", "categories" to ArrayList<Any?>(), "entries" to o.mapTo(ArrayList()) { entryFromRaw(it) })
        }
        if (o !is Map<*, *>) throw JsError("JSON 根节点必须是对象或数组")
        val cs = o["categories"]
        if (cs is List<*>) return jobj("format" to "json", "worldId" to Js.trim(so(o["worldId"])), "categories" to normCats(cs), "entries" to ArrayList<Any?>(), "updatedAt" to Js.or(o["updatedAt"], 0.0))
        return jobj("format" to "ndjson", "worldId" to "", "categories" to ArrayList<Any?>(), "entries" to arrayListOf<Any?>(entryFromRaw(o)))
    }

    fun parseNdjsonImport(text: Any?): JObj {
        val sx = Js.trim(stripBom(so(text)))
        if (sx.isNotEmpty() && sx[0] == '[') {
            val a = JsJson.parse(sx)
            if (a !is List<*>) throw JsError("NDJSON 数组根节点无效")
            return jobj("format" to "ndjson", "worldId" to "", "categories" to ArrayList<Any?>(), "entries" to a.mapTo(ArrayList()) { entryFromRaw(it) })
        }
        if (sx.isNotEmpty() && sx[0] == '{' && !sx.contains('\n')) {
            val (ok, o) = tryParse(sx)
            if (ok) {
                if (o != null && o["categories"] is List<*>) return parseJsonImport(sx)
                return jobj("format" to "ndjson", "worldId" to "", "categories" to ArrayList<Any?>(), "entries" to arrayListOf<Any?>(entryFromRaw(o)))
            }
        }
        val out: JArr = ArrayList()
        splitLines(stripBom(so(text))).forEachIndexed { i, line ->
            val t = Js.trim(line)
            if (t.isEmpty() || t.startsWith("//") || t.startsWith("#")) return@forEachIndexed
            val msg: String = try {
                val o = JsJson.parse(t)
                if (o is Map<*, *>) { out.add(entryFromRaw(o)); return@forEachIndexed }
                "非对象"
            } catch (e: JsSyntaxError) { "<JSON>" }
            throw JsError("NDJSON 第 " + (i + 1) + " 行解析失败：" + msg)
        }
        if (out.isEmpty()) throw JsError("NDJSON 没有有效条目")
        return jobj("format" to "ndjson", "worldId" to "", "categories" to ArrayList<Any?>(), "entries" to out)
    }

    fun parseMarkdownImport(text: Any?): JObj {
        val sx = crlf(stripBom(so(text)))
        if (Js.trim(sx).isEmpty()) throw JsError("Markdown 为空")
        val lines = sx.split("\n")
        var curCatId = ""; var curCatName = ""; var curTitle = ""
        var curMeta = jobj("keywords" to ArrayList<Any?>(), "tags" to ArrayList<Any?>(), "pinned" to false, "id" to "")
        var body = ArrayList<String>()
        val out: JArr = ArrayList(); val categoriesMeta = ArrayList<JObj>()
        fun resetMeta() { curMeta = jobj("keywords" to ArrayList<Any?>(), "tags" to ArrayList<Any?>(), "pinned" to false, "id" to "") }
        fun flushEntry() {
            if (curTitle.isEmpty() && !body.any { Js.trim(it).isNotEmpty() }) { curTitle = ""; resetMeta(); body = ArrayList(); return }
            var content = body.joinToString("\n")
            content = content.trimStart('\n').trimEnd('\n')
            out.add(entryFromRaw(jobj("id" to Js.or(curMeta["id"], Undefined).let { if (it === Undefined) null else it }, "categoryId" to curCatId, "categoryName" to curCatName,
                "category" to curCatId.ifEmpty { curCatName }, "title" to curTitle, "content" to content, "keywords" to curMeta["keywords"], "tags" to curMeta["tags"], "pinned" to curMeta["pinned"])))
            curTitle = ""; resetMeta(); body = ArrayList()
        }
        fun parseCatHeader(rest: String): Pair<String, String> {
            val t = Js.trim(rest)
            Js.match(Js.re("^([A-Za-z][\\w-]*)\\s+(.+)$"), t)?.let { return it[1]!! to Js.trim(it[2]!!) }
            if (Js.test(Js.re("^[A-Za-z][\\w-]*$"), t)) return t to (defOf(t)?.get("name") as? String ?: t)
            return "" to t
        }
        for (line in lines) {
            val h2 = Js.match(Js.re("^##\\s+(.+)$"), line)
            val h3 = Js.match(Js.re("^###\\s+(.+)$"), line)
            if (h2 != null) {
                flushEntry()
                val (cid, cname) = parseCatHeader(h2[1]!!)
                curCatId = cid.ifEmpty { slugifyCatId(cname) }
                curCatName = cname.ifEmpty { cid }
                if (categoriesMeta.none { it["id"] == curCatId }) categoriesMeta += jobj("id" to curCatId, "name" to curCatName)
                continue
            }
            if (h3 != null) { flushEntry(); curTitle = Js.trim(h3[1]!!); resetMeta(); body = ArrayList(); continue }
            if (curTitle.isNotEmpty()) {
                val meta = Js.match(Js.re("^(keywords|tags|pinned|id)\\s*[:：]\\s*(.*)$", "i"), line)
                if (meta != null && !body.any { Js.trim(it).isNotEmpty() }) {
                    val key = RetrievalCore.lower(meta[1]!!); val v = Js.trim(meta[2]!!)
                    when (key) { "keywords" -> curMeta["keywords"] = normalizeKeywords(v); "tags" -> curMeta["tags"] = normalizeKeywords(v); "pinned" -> curMeta["pinned"] = parseBoolish(v); "id" -> curMeta["id"] = v }
                    continue
                }
                body += line
            }
        }
        flushEntry()
        if (out.isEmpty()) throw JsError("Markdown 没有解析到条目（需要 ### 标题）")
        return jobj("format" to "markdown", "worldId" to "", "categories" to categoriesMeta.mapIndexedTo(ArrayList()) { i, c -> normalizeCategory(jobj("id" to c["id"], "name" to c["name"], "order" to i, "entries" to ArrayList<Any?>()), i.toDouble()) }, "entries" to out)
    }

    fun parseImport(text: Any?, opt: Any? = null): JObj {
        val format = Js.str(Js.or(opt?.let { it["format"] }, Undefined).let { if (it === Undefined) detectImportFormat(text) else it })
        return when (format) {
            "empty" -> throw JsError("内容为空")
            "unknown" -> throw JsError("无法识别格式（支持原生 JSON / NDJSON / 紧凑 Markdown）")
            "json" -> parseJsonImport(text); "ndjson" -> parseNdjsonImport(text); "markdown" -> parseMarkdownImport(text)
            else -> throw JsError("不支持的格式：$format")
        }
    }

    fun ensureCategory(doc: JObj, categoryId: Any?, categoryName: Any?, now: Any?): JObj {
        var id = Js.trim(so(categoryId)); var name = Js.trim(so(categoryName))
        if (id.isEmpty() && name.isNotEmpty()) { cats(doc).firstOrNull { it["name"] == name }?.let { return it }; id = slugifyCatId(name) }
        if (id.isEmpty()) id = "other"
        findCategory(doc, id)?.let { cat ->
            if (name.isNotEmpty() && cat["name"] != name && !isDefId(id)) { if (!Js.truthy(cat["name"]) || cat["name"] == id) cat["name"] = name }
            return cat
        }
        if (name.isEmpty() && id != "other" && !isDefId(id)) findCategory(doc, "other")?.let { return it }
        if (name.isEmpty()) name = (defOf(id)?.get("name") as? String) ?: id
        val next = addCategory(doc, jobj("id" to id, "name" to name), now)
        doc["categories"] = next["categories"]; doc["updatedAt"] = next["updatedAt"]
        return findCategory(doc, id)!!
    }

    private fun findEntryAnywhere(doc: JObj, entryId: Any?): Pair<JObj, JObj>? {
        if (!Js.truthy(entryId)) return null
        for (cat in cats(doc)) { val e = entries(cat).firstOrNull { it["id"] == entryId }; if (e != null) return cat to (e as JObj) }
        return null
    }

    fun mergeDoc(baseDoc: Any?, parsed: Any?, opt: Any? = null): JObj {
        val mode = if (opt?.let { it["mode"] } == "replace") "replace" else "merge"
        val now = Js.or(opt?.let { it["now"] }, clock())
        val worldId = Js.trim(so(Js.or(Js.or(opt?.let { it["worldId"] }, baseDoc?.let { it["worldId"] }), parsed?.let { it["worldId"] })))
        val doc = cloneDoc(normalizeDoc(baseDoc ?: emptyDoc(worldId), worldId))
        if (!Js.truthy(doc["worldId"]) && worldId.isNotEmpty()) doc["worldId"] = worldId
        var added = 0; var updated = 0; var categoriesCreated = 0
        val pCats = parsed?.let { it["categories"] } as? List<*>
        val pEntries = parsed?.let { it["entries"] } as? List<*>
        if (mode == "replace") {
            cats(doc).forEach { it["entries"] = ArrayList<Any?>() }
            if (pCats != null && pCats.isNotEmpty() && !(pEntries != null && pEntries.isNotEmpty())) {
                val incoming = normCats(pCats)
                val map = LinkedHashMap<Any?, JObj>(); emptyCategories().forEach { map[(it as JObj)["id"]] = it }
                for (c0 in incoming) {
                    val c = c0 as JObj; val prev = map[c["id"]]
                    if (prev != null) {
                        val m = Js.assign(prev, c); m["entries"] = entries(c).mapTo(ArrayList()) { e ->
                            val n = normalizeEntry(e, now); if (!Js.truthy(e["createdAt"])) n["createdAt"] = now; if (!Js.truthy(e["updatedAt"])) n["updatedAt"] = now; n }
                        map[c["id"]] = m
                    } else map[c["id"]] = c
                }
                val list: JArr = ArrayList(map.values); list.sortWith(catCmp); list.forEachIndexed { i, c -> (c as JObj)["order"] = i.toDouble() }
                doc["categories"] = list
                added = cats(doc).sumOf { entries(it).size }
                return jobj("doc" to touch(doc, now), "added" to added, "updated" to 0, "categoriesCreated" to 0, "mode" to mode, "format" to parsed?.let { it["format"] })
            }
        }
        (pCats ?: emptyList<Any?>()).forEach { c -> val before = cats(doc).size; ensureCategory(doc, c["id"], c["name"], now); if (cats(doc).size > before) categoriesCreated++ }
        val flat = ArrayList<Any?>()
        (pCats ?: emptyList<Any?>()).forEach { c -> entries(c).forEach { e -> flat += jobj("categoryId" to c["id"], "categoryName" to c["name"], "categoryHint" to c["id"], "entry" to normalizeEntry(e, now)) } }
        (pEntries ?: emptyList<Any?>()).forEach { flat += it }
        for (row in flat) {
            val e = (row["entry"] as? JObj) ?: normalizeEntry(row, now)
            var hintId = Js.trim(so(row["categoryId"])); var hintName = Js.trim(so(row["categoryName"]))
            if (hintId.isEmpty() && Js.truthy(row["categoryHint"])) {
                val h = Js.trim(Js.str(row["categoryHint"]))
                if (findCategory(doc, h) != null || isDefId(h) || Js.test(Js.re("^[A-Za-z][\\w-]*$"), h)) hintId = h else hintName = hintName.ifEmpty { h }
            }
            val beforeCats = cats(doc).size
            val cat = ensureCategory(doc, hintId, hintName, now)
            if (cats(doc).size > beforeCats) categoriesCreated++
            if (Js.truthy(e["id"])) {
                val hit = findEntryAnywhere(doc, e["id"])
                if (hit != null) {
                    val (hc, he) = hit
                    if (hc["id"] != cat["id"]) {
                        hc["entries"] = entries(hc).filterTo(ArrayList()) { it["id"] != e["id"] }
                        val merged = Js.assign(he, e); merged["id"] = e["id"]; merged["createdAt"] = Js.or(Js.or(he["createdAt"], e["createdAt"]), now); merged["updatedAt"] = now
                        entries(cat).add(normalizeEntry(merged, now))
                    } else {
                        he["title"] = e["title"]; he["content"] = e["content"]; he["keywords"] = e["keywords"]; he["tags"] = e["tags"]; he["pinned"] = e["pinned"]; he["updatedAt"] = now
                        if (!Js.truthy(he["createdAt"])) he["createdAt"] = Js.or(e["createdAt"], now)
                    }
                    updated++; continue
                }
            }
            val ne = Js.assign(e); ne["id"] = Js.or(e["id"], "e-" + uid()); ne["createdAt"] = Js.or(e["createdAt"], now); ne["updatedAt"] = now
            val newE = normalizeEntry(ne, now)
            if (entries(cat).any { it["id"] == newE["id"] }) newE["id"] = "e-" + uid()
            entries(cat).add(newE); added++
        }
        return jobj("doc" to touch(doc, now), "added" to added, "updated" to updated, "categoriesCreated" to categoriesCreated, "mode" to mode, "format" to parsed?.let { it["format"] })
    }

    private fun exportEntry(e: Any?) = jobj("id" to e["id"], "title" to e["title"], "content" to e["content"], "keywords" to Js.or(e["keywords"], ArrayList<Any?>()), "tags" to Js.or(e["tags"], ArrayList<Any?>()),
        "pinned" to Js.truthy(e["pinned"]), "createdAt" to Js.or(e["createdAt"], 0.0), "updatedAt" to Js.or(e["updatedAt"], 0.0))

    fun exportJSON(doc: Any?, pretty: Any? = null): String {
        val d = normalizeDoc(doc, doc?.let { it["worldId"] })
        val out = jobj("worldId" to d["worldId"], "updatedAt" to d["updatedAt"], "categories" to cats(d).mapTo(ArrayList()) { c ->
            jobj("id" to c["id"], "name" to c["name"], "order" to c["order"], "entries" to entries(c).mapTo(ArrayList()) { exportEntry(it) }) })
        return if (pretty == false) Js.stringify(out) else JsJson.stringify(out, 2)
    }
    fun exportNdjson(doc: Any?): String {
        val d = normalizeDoc(doc, doc?.let { it["worldId"] }); val lines = ArrayList<String>()
        for (c in cats(d)) for (e in entries(c)) {
            val row = jobj("categoryId" to c["id"], "title" to e["title"], "content" to e["content"])
            if ((e["keywords"] as? List<*>)?.isNotEmpty() == true) row["keywords"] = e["keywords"]
            if ((e["tags"] as? List<*>)?.isNotEmpty() == true) row["tags"] = e["tags"]
            if (Js.truthy(e["pinned"])) row["pinned"] = true
            if (Js.truthy(e["id"])) row["id"] = e["id"]
            lines += Js.stringify(row)
        }
        return lines.joinToString("\n") + (if (lines.isNotEmpty()) "\n" else "")
    }
    fun exportMarkdown(doc: Any?): String {
        val d = normalizeDoc(doc, doc?.let { it["worldId"] }); val parts = ArrayList<String>()
        for (c in cats(d)) {
            if (entries(c).isEmpty()) continue
            parts += "## " + Js.str(c["id"]) + " " + Js.str(c["name"]); parts += ""
            for (e in entries(c)) {
                parts += "### " + so(Js.or(e["title"], "未命名"))
                (e["keywords"] as? List<*>)?.takeIf { it.isNotEmpty() }?.let { parts += "keywords: " + it.joinToString(", ") { x -> if (x == null) "" else Js.str(x) } }
                (e["tags"] as? List<*>)?.takeIf { it.isNotEmpty() }?.let { parts += "tags: " + it.joinToString(", ") { x -> if (x == null) "" else Js.str(x) } }
                if (Js.truthy(e["pinned"])) parts += "pinned: true"
                if (Js.truthy(e["id"])) parts += "id: " + Js.str(e["id"])
                parts += ""; parts += so(e["content"]); parts += ""
            }
        }
        return parts.joinToString("\n").trimEnd('\n').let { if (it.length < parts.joinToString("\n").length) it + "\n" else it }
    }
}
