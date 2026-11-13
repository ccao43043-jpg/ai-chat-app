package com.aichat.app.data.convlog

import com.aichat.app.data.json.Js
import com.aichat.app.data.json.Js.arr
import com.aichat.app.data.json.Js.clone
import com.aichat.app.data.json.Js.equal
import com.aichat.app.data.json.Js.int32
import com.aichat.app.data.json.Js.isArr
import com.aichat.app.data.json.Js.nullish
import com.aichat.app.data.json.Js.or
import com.aichat.app.data.json.Js.prop
import com.aichat.app.data.json.Js.toStr
import com.aichat.app.data.json.Js.truthy
import com.aichat.app.data.json.JsObj
import com.aichat.app.data.json.Undef
import com.aichat.app.data.json.jsArr
import com.aichat.app.data.store.StoreJs
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.WeakHashMap
import java.util.zip.Deflater
import java.util.zip.Inflater

/**
 * www/conv-log.js（oplog-v1，f6bdd62）的逐函数移植。函数名、分支顺序、键顺序与 JS 保持一致，以便 golden 对照。
 * 所有值都是 [Js] 模型（JsObj / MutableList / Double / String / Boolean / null / Undef）。
 *
 * 已知且有意的差异（均不影响 replay 结果）：
 *  1. contentZ：JS 用 fflate.zlibSync(level 6)，这里用 java.util.zip.Deflater(6)；两边产物字节可能不同，但互相可解（都是标准 zlib）。
 *     「压缩后不短于原文就不压缩」的判断因此可能个别不同；比对时请先 unpackChapters。
 *  2. JS 在畸形数据上会抛 TypeError（如 snapshot.tombstones 缺 msg 键）；这里按「缺失 = 空对象」容错继续。
 *  3. 时间 / 随机数经 [now] / [random] 注入（ensureDev、writePointer），便于 golden 固定。
 */
class JsConvLog(
    private val now: () -> Long = System::currentTimeMillis,
    private val random: () -> Double = Math::random,
) {
    companion object {
        const val FORMAT = "oplog-v1"
        const val COMPACT_OPS = 200
        const val COMPACT_BYTES = 1024 * 1024
        const val DEVICE_FILE = "device-id.json"
        private val META_SKIP_OWN = setOf("messages", "chapters", "affect", "affectBy", "ledger", "worldRef", "worldLog", "worldPending",
            "format", "tombstones", "stamps", "clock", "kb", "order")
        /** META_SKIP 是对象字面量，`META_SKIP[k]` 对 Object.prototype 上的名字也为真 */
        private val PROTO = setOf("constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty", "__lookupGetter__", "__lookupSetter__",
            "isPrototypeOf", "propertyIsEnumerable", "toString", "valueOf", "__proto__", "toLocaleString")
        fun metaSkip(k: String) = k in META_SKIP_OWN || k in PROTO

        fun snapshotKey(id: String) = "conv_$id.snap.json"
        fun logKey(id: String) = "conv_$id.log.jsonl"
        fun legacyKey(id: String) = "conv_$id.json"
        fun filesOf(id: String): List<String> { val base = legacyKey(id); return listOf(base, "$base.bak", snapshotKey(id), snapshotKey(id) + ".bak", logKey(id)) }
        fun isConvJsonName(n: String) = Regex("^conv_[^./]+\\.json$").matches(n)
        fun isSnapName(n: String) = Regex("^conv_([^./]+)\\.snap\\.json$").matches(n)
        fun isLogName(n: String) = Regex("^conv_([^./]+)\\.log\\.jsonl$").matches(n)
        private val ID_RE = Regex("^conv_([^./]+)\\.(snap\\.json|log\\.jsonl|json)$")
        fun idFromName(n: String) = ID_RE.find(n)?.groupValues?.get(1) ?: ""

        // ---------------- 压缩（fflate zlibSync 兼容） ----------------
        fun compressStr(s: Any?): String? {
            if (nullish(s)) return null
            return try {
                val d = Deflater(6); d.setInput(toStr(s).toByteArray(Charsets.UTF_8)); d.finish()
                val out = ByteArrayOutputStream(); val buf = ByteArray(8192)
                while (!d.finished()) out.write(buf, 0, d.deflate(buf))
                d.end()
                Base64.getEncoder().encodeToString(out.toByteArray())
            } catch (e: Exception) { null }
        }
        fun decompressStr(z: Any?): String {
            if (!truthy(z)) return ""
            return try {
                val bytes = Base64.getMimeDecoder().decode(toStr(z))
                val inf = Inflater(); inf.setInput(bytes)
                val out = ByteArrayOutputStream(); val buf = ByteArray(8192)
                while (!inf.finished()) {
                    val n = inf.inflate(buf)
                    if (n == 0 && (inf.needsInput() || inf.needsDictionary())) { inf.end(); return "" }
                    out.write(buf, 0, n)
                }
                inf.end()
                String(out.toByteArray(), Charsets.UTF_8)
            } catch (e: Exception) { "" }
        }

        fun packChapters(chapters: Any?): MutableList<Any?> {
            val list = if (isArr(chapters)) arr(chapters) else ArrayList()
            if (list.size < 2) return list.mapTo(ArrayList()) { clone(it) }
            val last = list.size - 1
            return list.mapIndexedTo(ArrayList()) { i, ch ->
                val c0 = clone(ch); val c = if (truthy(c0)) c0 else JsObj()
                if (c !is JsObj) return@mapIndexedTo c
                val content = c["content"]
                if (i == last || content !is String || content.isEmpty()) return@mapIndexedTo c
                val z = compressStr(content)
                if (z == null || z.length >= content.length) return@mapIndexedTo c
                c["contentZ"] = z
                c["content"] = ""
                c
            }
        }
        fun unpackChapters(chapters: Any?): MutableList<Any?> =
            (if (isArr(chapters)) arr(chapters) else ArrayList()).mapTo(ArrayList()) { ch ->
                val c0 = clone(ch); val c = if (truthy(c0)) c0 else JsObj()
                if (c is JsObj) {
                    if (truthy(c["contentZ"]) && !truthy(c["content"])) c["content"] = decompressStr(c["contentZ"])
                    c.remove("contentZ")
                }
                c
            }

        // ---------------- 戳与冲突 ----------------
        fun stampCmp(a: Any?, b: Any?): Int {
            val la = int32(if (truthy(a)) prop(a, "lamport") else a); val lb = int32(if (truthy(b)) prop(b, "lamport") else b)
            if (la != lb) return if (la > lb) 1 else -1
            val da = toStr(or(if (truthy(a)) prop(a, "dev") else a, "")); val db = toStr(or(if (truthy(b)) prop(b, "dev") else b, ""))
            if (da != db) return if (da > db) 1 else -1
            return 0
        }
        fun stampOf(op: Any?): JsObj = JsObj("lamport" to int32(if (truthy(op)) prop(op, "lamport") else op).toDouble(),
            "dev" to toStr(or(if (truthy(op)) prop(op, "dev") else op, "")))
        fun wins(op: Any?, prev: Any?) = !truthy(prev) || stampCmp(stampOf(op), prev) >= 0
        fun isConflict(op: Any?, prevStamp: Any?, prevVal: Any?, nextVal: Any?): Boolean {
            if (!truthy(prevStamp) || equal(prevVal, nextVal)) return false
            if (Js.strictEq(stampOf(op)["dev"], prop(prevStamp, "dev"))) return false
            if (int32(prop(prevStamp, "lamport")) != int32(if (truthy(op)) prop(op, "lamport") else op)) return false
            return true
        }

        fun messageText(m: Any?): String {
            val c = if (truthy(m)) prop(m, "content") else m
            if (c is String) return c
            if (isArr(c)) return arr(c).joinToString(" ") { p -> toStr(or(if (truthy(p)) or(prop(p, "text"), or(prop(p, "content"), "")) else p, "")) }
            if (c is JsObj) return toStr(or(c["text"], or(c["content"], Js.stringify(c))))
            return toStr(or(c, ""))
        }

        fun extractChapters(conv: Any?): MutableList<Any?> {
            val st = Js.path(conv, "plugins", "rpcache", "state")
            if (truthy(st) && isArr(prop(st, "chapters"))) return arr(prop(st, "chapters"))
            if (isArr(prop(conv, "chapters"))) return arr(prop(conv, "chapters"))
            return ArrayList()
        }
        fun extractLedger(conv: Any?): MutableList<Any?> {
            if (isArr(prop(conv, "ledger"))) return arr(prop(conv, "ledger"))
            val mem = Js.path(conv, "plugins", "rpmemory")
            if (truthy(mem) && isArr(prop(mem, "ledger"))) return arr(prop(mem, "ledger"))
            val ms = prop(mem, "state")
            if (truthy(mem) && truthy(ms) && isArr(prop(ms, "ledger"))) return arr(prop(ms, "ledger"))
            return ArrayList()
        }
        fun extractMeta(conv: Any?): JsObj {
            val meta = JsObj()
            if (conv !is JsObj) return meta
            for (k in conv.keys()) if (!metaSkip(k)) meta[k] = clone(conv[k])
            val st = Js.path(meta, "plugins", "rpcache", "state")
            if (truthy(st) && isArr(prop(st, "chapters"))) {
                val s2 = Js.assign(JsObj(), st); s2.remove("chapters")
                val plugins = meta["plugins"]; val rp = prop(plugins, "rpcache")
                meta["plugins"] = Js.assign(JsObj(), plugins, JsObj("rpcache" to Js.assign(JsObj(), rp, JsObj("state" to s2))))
            }
            return meta
        }

        fun emptyState(id: Any?): JsObj = JsObj(
            "id" to id,
            "messages" to jsArr(), "chapters" to jsArr(), "affect" to null, "affectBy" to null, "ledger" to jsArr(),
            "worldRef" to null, "worldLog" to jsArr(), "worldPending" to null,
            "meta" to JsObj("id" to id, "title" to "新对话"),
            "tombstones" to JsObj("msg" to JsObj(), "chapter" to JsObj(), "ledger" to JsObj()),
            "stamps" to JsObj("msg" to JsObj(), "chapter" to JsObj(), "ledger" to JsObj(), "affect" to JsObj(), "worldRef" to JsObj(),
                "worldLog" to JsObj(), "meta" to JsObj(), "order" to null, "kb" to JsObj(), "affectBy" to JsObj()),
            "order" to jsArr(), "kb" to JsObj(), "clock" to 0.0,
        )

        // 容错访问：JS 里这些子对象恒存在；缺失时（畸形快照）按空对象处理并补上
        private fun sub(o: JsObj, k: String): JsObj { val v = o[k]; if (v is JsObj) return v; val n = JsObj(); o[k] = n; return n }
        private fun stamps(s: JsObj, k: String) = sub(sub(s, "stamps"), k)
        private fun tombs(s: JsObj, k: String) = sub(sub(s, "tombstones"), k)
        private fun list(s: JsObj, k: String): MutableList<Any?> { val v = s[k]; if (isArr(v)) return arr(v); val n = ArrayList<Any?>(); s[k] = n; return n }
        private fun chKey(c: Any?): String { val no = prop(c, "no"); return toStr(if (!nullish(no)) no else prop(c, "id")) }
        private fun ledKey(f: Any?): String = toStr(or(prop(f, "id"), or(prop(f, "key"),
            toStr(prop(f, "subject")) + "/" + toStr(prop(f, "attribute")) + "/" + toStr(or(prop(f, "quote"), "")))))
        private fun ledKeyDiff(f: Any?): String = toStr(or(prop(f, "id"), or(prop(f, "key"), Js.stringify(f) ?: Undef)))

        private fun idxOfMsg(state: JsObj, id: Any?) = list(state, "messages").indexOfFirst { truthy(it) && Js.strictEq(prop(it, "id"), id) }

        private fun applyConflict(target: Any?, field: String, prevVal: Any?, op: JsObj): JsObj {
            val rec = JsObj("content" to prevVal, "lamport" to int32(op["lamport"]).toDouble(), "dev" to toStr(or(op["dev"], "")), "field" to field)
            if (target is JsObj) {
                val l = target["_conflicts"]; val lst = if (isArr(l)) ArrayList(arr(l)) else ArrayList()
                lst.add(rec); target["_conflicts"] = lst; target["conflict"] = true
            }
            return rec
        }
        private fun concat(a: Any?, item: Any?): MutableList<Any?> {
            val base = or(a, null); val out = ArrayList<Any?>()
            if (isArr(base)) out.addAll(arr(base)) else if (base != null) out.add(base)
            out.add(item); return out
        }

        fun applyOp(state: JsObj, op: Any?): JsObj {
            if (!truthy(op) || !truthy(prop(op, "op"))) return state
            op as JsObj
            if (int32(op["lamport"]) > int32(state["clock"])) state["clock"] = int32(op["lamport"]).toDouble()
            val p = or(op["payload"], JsObj())
            val st = stampOf(op)
            when (op["op"]) {
                "msg.add" -> run {
                    val m = clone(p)
                    if (!truthy(m) || !truthy(prop(m, "id"))) return@run
                    m as JsObj
                    val id = m["id"]; val ik = toStr(id)
                    val tomb = tombs(state, "msg")[ik]
                    if (truthy(tomb) && stampCmp(tomb, st) > 0) return@run
                    val i = idxOfMsg(state, id)
                    val prevS = stamps(state, "msg")[ik]
                    val msgs = list(state, "messages")
                    if (i >= 0) {
                        if (!wins(op, prevS)) return@run
                        if (isConflict(op, prevS, msgs[i], m)) applyConflict(m, "message", clone(msgs[i]), op)
                        msgs[i] = m
                    } else {
                        msgs.add(m)
                        val order = list(state, "order"); if (!Js.includes(order, id)) order.add(id)
                    }
                    stamps(state, "msg")[ik] = st
                    tombs(state, "msg").remove(ik)
                }
                "msg.edit" -> run {
                    val id = prop(p, "id")
                    if (!truthy(id)) return@run
                    val ik = toStr(id)
                    val tomb = tombs(state, "msg")[ik]
                    if (truthy(tomb) && stampCmp(tomb, st) > 0) return@run
                    if (!wins(op, stamps(state, "msg")[ik])) return@run
                    val i = idxOfMsg(state, id)
                    val msgs = list(state, "messages")
                    if (i < 0) {
                        val neu = clone(p) as JsObj
                        if (!truthy(neu["id"])) neu["id"] = id
                        msgs.add(neu)
                        val order = list(state, "order"); if (!Js.includes(order, id)) order.add(id)
                    } else {
                        val prev = msgs[i]
                        val next = Js.assign(JsObj(), prev, clone(p))
                        if (isConflict(op, stamps(state, "msg")[ik], prev, next)) applyConflict(next, "message", clone(prev), op)
                        msgs[i] = next
                    }
                    stamps(state, "msg")[ik] = st
                }
                "msg.remove", "msg.delete" -> run {
                    val id = prop(p, "id")
                    if (!truthy(id)) return@run
                    val ik = toStr(id)
                    val cur = or(stamps(state, "msg")[ik], tombs(state, "msg")[ik])
                    if (truthy(cur) && stampCmp(cur, st) > 0) return@run
                    state["messages"] = list(state, "messages").filterTo(ArrayList()) { !Js.strictEq(prop(it, "id"), id) }
                    state["order"] = list(state, "order").filterTo(ArrayList()) { !Js.strictEq(it, id) }
                    tombs(state, "msg")[ik] = st
                    stamps(state, "msg")[ik] = st
                }
                "msg.reorder" -> run {
                    val ids = if (isArr(prop(p, "ids"))) ArrayList(arr(prop(p, "ids"))) else ArrayList()
                    if (!wins(op, sub(state, "stamps")["order"])) return@run
                    val map = JsObj()
                    list(state, "messages").forEach { m -> map[toStr(prop(m, "id"))] = m }
                    val seen = HashSet<Any>()
                    val next = ArrayList<Any?>()
                    val tm = tombs(state, "msg")
                    ids.forEach { id ->
                        val mm = map[toStr(id)]
                        if (truthy(mm) && !seen.contains(Js.svzKey(id)) && !truthy(tm[toStr(id)])) { next.add(mm); seen.add(Js.svzKey(id)) }
                    }
                    list(state, "messages").forEach { m ->
                        val mid = prop(m, "id")
                        if (!seen.contains(Js.svzKey(mid)) && !truthy(tm[toStr(mid)])) next.add(m)
                    }
                    state["messages"] = next
                    state["order"] = next.mapTo(ArrayList()) { prop(it, "id") }
                    sub(state, "stamps")["order"] = st
                }
                "chapter.commit" -> run {
                    val ch = clone(p)
                    val no = if (truthy(ch)) (if (!nullish(prop(ch, "no"))) prop(ch, "no") else prop(ch, "id")) else ch
                    if (nullish(no)) return@run
                    ch as JsObj
                    val key = toStr(no)
                    val tomb = tombs(state, "chapter")[key]
                    if (truthy(tomb) && stampCmp(tomb, st) > 0) return@run
                    val chs = list(state, "chapters")
                    val i = chs.indexOfFirst { chKey(it) == key }
                    if (i >= 0) {
                        if (!wins(op, stamps(state, "chapter")[key])) return@run
                        if (isConflict(op, stamps(state, "chapter")[key], chs[i], ch)) {
                            val loser = clone(chs[i]) as JsObj
                            loser["conflict"] = true
                            ch["conflict"] = true
                            ch["_conflicts"] = concat(ch["_conflicts"], loser)
                            chs.add(loser)
                        }
                        val j = chs.indexOfFirst { chKey(it) == key && !truthy(prop(it, "conflict")) }
                        if (j >= 0) chs[j] = ch else chs[i] = ch
                    } else {
                        chs.add(ch)
                    }
                    stamps(state, "chapter")[key] = st
                    tombs(state, "chapter").remove(key)
                }
                "chapter.edit" -> run {
                    val no = if (!nullish(prop(p, "no"))) prop(p, "no") else prop(p, "id")
                    if (nullish(no)) return@run
                    val key = toStr(no)
                    val tomb = tombs(state, "chapter")[key]
                    if (truthy(tomb) && stampCmp(tomb, st) > 0) return@run
                    if (!wins(op, stamps(state, "chapter")[key])) return@run
                    val chs = list(state, "chapters")
                    val i = chs.indexOfFirst { chKey(it) == key && !truthy(prop(it, "conflict")) }
                    if (i < 0) {
                        chs.add(clone(p))
                    } else {
                        val prev = chs[i]
                        val next = Js.assign(JsObj(), prev, clone(p))
                        if (isConflict(op, stamps(state, "chapter")[key], prev, next)) {
                            val loser = clone(prev) as JsObj
                            loser["conflict"] = true
                            next["conflict"] = true
                            next["_conflicts"] = concat(next["_conflicts"], loser)
                            chs.add(loser)
                        }
                        chs[i] = next
                    }
                    stamps(state, "chapter")[key] = st
                }
                "chapter.remove" -> run {
                    val no = if (!nullish(prop(p, "no"))) prop(p, "no") else prop(p, "id")
                    if (nullish(no)) return@run
                    val key = toStr(no)
                    val cur = or(stamps(state, "chapter")[key], tombs(state, "chapter")[key])
                    if (truthy(cur) && stampCmp(cur, st) > 0) return@run
                    state["chapters"] = list(state, "chapters").filterTo(ArrayList()) { chKey(it) != key }
                    tombs(state, "chapter")[key] = st
                    stamps(state, "chapter")[key] = st
                }
                "affect.set" -> run {
                    if (!wins(op, sub(state, "stamps")["affect"])) return@run
                    val prev = state["affect"]
                    val next = clone(if (truthy(p) && prop(p, "affect") !== Undef) prop(p, "affect") else p)
                    if (isConflict(op, sub(state, "stamps")["affect"], prev, next) && truthy(next) && next is JsObj) {
                        next["conflict"] = true
                        next["_conflicts"] = concat(next["_conflicts"], clone(prev))
                    }
                    state["affect"] = next
                    sub(state, "stamps")["affect"] = st
                }
                "affect.by" -> run {
                    val cid = toStr(or(prop(p, "id"), or(prop(p, "charId"), "")))
                    if (cid.isEmpty()) return@run
                    if (!wins(op, stamps(state, "affectBy")[cid])) return@run
                    if (!truthy(state["affectBy"])) state["affectBy"] = JsObj()
                    (state["affectBy"] as JsObj)[cid] = clone(or(prop(p, "state"), or(prop(p, "affect"), p)))
                    stamps(state, "affectBy")[cid] = st
                }
                "ledger.append" -> run {
                    val fact = clone(or(prop(p, "fact"), p))
                    if (!truthy(fact)) return@run
                    val key = ledKey(fact)
                    val prevS = stamps(state, "ledger")[key]
                    val led = list(state, "ledger")
                    val i = led.indexOfFirst { ledKey(it) == key }
                    if (i < 0) {
                        led.add(fact)
                        stamps(state, "ledger")[key] = st
                    } else if (wins(op, prevS)) {
                        if (isConflict(op, prevS, led[i], fact) && !equal(led[i], fact)) {
                            val loser = Js.assign(JsObj(), clone(led[i]), JsObj("conflict" to true))
                            val neu = Js.assign(JsObj(), fact, JsObj("conflict" to true))
                            led[i] = loser
                            led.add(neu)
                        } else {
                            led[i] = fact
                        }
                        stamps(state, "ledger")[key] = st
                    }
                }
                "worldRef.set" -> run {
                    if (!wins(op, sub(state, "stamps")["worldRef"])) return@run
                    state["worldRef"] = clone(if (prop(p, "worldRef") !== Undef) prop(p, "worldRef") else p)
                    sub(state, "stamps")["worldRef"] = st
                    if (prop(p, "worldPending") !== Undef) state["worldPending"] = clone(prop(p, "worldPending"))
                }
                "worldLog.append" -> run {
                    val entry = clone(or(prop(p, "entry"), p))
                    if (!truthy(entry)) return@run
                    val key = Js.stringify(entry)
                    val wl = if (truthy(state["worldLog"])) state["worldLog"] else ArrayList<Any?>()
                    val exists = (if (isArr(wl)) arr(wl) else ArrayList()).any { Js.stringify(it) == key }
                    if (!exists) state["worldLog"] = concat(wl, entry)
                }
                "meta.set" -> run {
                    val patch = clone(or(prop(p, "patch"), p))
                    if (!truthy(patch) || patch !is JsObj) return@run
                    if (!truthy(state["meta"])) state["meta"] = JsObj()
                    val meta = state["meta"] as JsObj
                    for (k in patch.keys()) {
                        if (metaSkip(k) || (k == "id" && !truthy(patch[k]))) continue
                        val ps = stamps(state, "meta")[k]
                        if (truthy(ps) && stampCmp(ps, st) > 0) continue
                        meta[k] = patch[k]
                        stamps(state, "meta")[k] = st
                    }
                }
                "kb.upsert" -> run {
                    val worldId = toStr(or(prop(p, "worldId"), ""))
                    val entry = clone(or(prop(p, "entry"), p))
                    if (worldId.isEmpty() || !truthy(entry) || !truthy(prop(entry, "id"))) return@run
                    entry as JsObj
                    val eid = toStr(entry["id"])
                    val k = "$worldId/$eid"
                    if (!wins(op, stamps(state, "kb")[k])) return@run
                    val kb = sub(state, "kb")
                    if (!truthy(kb[worldId])) kb[worldId] = JsObj()
                    val w = kb[worldId] as JsObj
                    val prev = w[eid]
                    if (truthy(prev) && isConflict(op, stamps(state, "kb")[k], prev, entry)) {
                        entry["conflict"] = true
                        entry["_conflicts"] = concat(entry["_conflicts"], Js.assign(JsObj(), prev, JsObj("conflict" to true)))
                    }
                    w[eid] = entry
                    stamps(state, "kb")[k] = st
                }
                else -> {}
            }
            return state
        }

        fun replay(snapshot: Any?, ops: List<Any?>?): JsObj {
            val state = stateFromSnapshot(snapshot)
            val upTo = int32(if (truthy(snapshot)) prop(snapshot, "upToLamport") else snapshot)
            (ops ?: emptyList()).forEach { op ->
                if (!truthy(op)) return@forEach
                if (int32(prop(op, "lamport")) <= upTo) return@forEach
                applyOp(state, op)
            }
            return state
        }

        fun stateFromSnapshot(snap: Any?): JsObj {
            if (!truthy(snap) || snap !is JsObj) return emptyState("")
            val id = or(snap["id"], or(Js.path(snap, "meta", "id"), ""))
            val state = emptyState(id)
            state["clock"] = (int32(snap["upToLamport"]).takeIf { it != 0 } ?: int32(snap["clock"])).toDouble()
            state["messages"] = clone(snap["messages"]).let { if (truthy(it) && isArr(it)) it else ArrayList<Any?>() }
            state["chapters"] = unpackChapters(or(snap["chapters"], ArrayList<Any?>()))
            state["affect"] = if (!nullish(snap["affect"])) clone(snap["affect"]) else null
            state["affectBy"] = if (truthy(snap["affectBy"])) clone(snap["affectBy"]) else null
            state["ledger"] = clone(snap["ledger"]).let { if (truthy(it) && isArr(it)) it else ArrayList<Any?>() }
            state["worldRef"] = if (truthy(snap["worldRef"])) clone(snap["worldRef"]) else null
            state["worldLog"] = clone(snap["worldLog"]).let { if (truthy(it) && isArr(it)) it else ArrayList<Any?>() }
            state["worldPending"] = if (!nullish(snap["worldPending"])) clone(snap["worldPending"]) else null
            val meta = Js.assign(JsObj(), extractMeta(JsObj("id" to id)), or(clone(snap["meta"]), JsObj()))
            meta["id"] = id
            state["meta"] = meta
            if (truthy(snap["tombstones"])) state["tombstones"] = clone(snap["tombstones"])
            if (truthy(snap["stamps"])) state["stamps"] = Js.assign(state["stamps"] as JsObj, clone(snap["stamps"]))
            state["order"] = if (isArr(snap["order"])) ArrayList(arr(snap["order"])) else list(state, "messages").mapTo(ArrayList()) { prop(it, "id") }
            if (truthy(snap["kb"])) state["kb"] = clone(snap["kb"])
            if (int32(snap["clock"]) > int32(state["clock"])) state["clock"] = int32(snap["clock"]).toDouble()
            return state
        }

        fun takeSnapshot(state: JsObj, packed: Boolean): JsObj {
            val chapters = if (packed) packChapters(state["chapters"]) else clone(state["chapters"])
            return JsObj(
                "format" to FORMAT,
                "upToLamport" to int32(state["clock"]).toDouble(),
                "messages" to clone(state["messages"]),
                "chapters" to chapters,
                "affect" to clone(state["affect"]),
                "ledger" to clone(state["ledger"]),
                "worldRef" to clone(state["worldRef"]),
                "affectBy" to clone(state["affectBy"]),
                "worldLog" to clone(state["worldLog"]),
                "worldPending" to clone(state["worldPending"]),
                "meta" to clone(state["meta"]),
                "id" to state["id"],
                "tombstones" to clone(state["tombstones"]),
                "stamps" to clone(state["stamps"]),
                "order" to ArrayList(if (isArr(state["order"])) arr(state["order"]) else ArrayList()),
                "kb" to clone(state["kb"]),
                "clock" to int32(state["clock"]).toDouble(),
            )
        }

        fun toConv(state: JsObj, legacy: Boolean = false): JsObj {
            val conv = Js.assign(JsObj("id" to state["id"]), or(clone(state["meta"]), JsObj()))
            conv["id"] = state["id"]
            conv["messages"] = clone(state["messages"]).let { if (truthy(it)) it else ArrayList<Any?>() }
            conv["worldRef"] = if (truthy(state["worldRef"])) clone(state["worldRef"]) else or(conv["worldRef"], Undef)
            if (truthy(state["worldLog"]) && arr(state["worldLog"]).isNotEmpty()) conv["worldLog"] = clone(state["worldLog"])
            if (truthy(state["worldPending"])) conv["worldPending"] = clone(state["worldPending"])
            if (!nullish(state["affect"])) conv["affect"] = clone(state["affect"])
            if (truthy(state["affectBy"])) conv["affectBy"] = clone(state["affectBy"])
            if (truthy(state["ledger"]) && arr(state["ledger"]).isNotEmpty()) conv["ledger"] = clone(state["ledger"])
            val chapters = unpackChapters(state["chapters"])
            if (chapters.isNotEmpty()) {
                if (!truthy(conv["plugins"])) conv["plugins"] = JsObj()
                val plugins = conv["plugins"] as JsObj
                if (!truthy(plugins["rpcache"])) plugins["rpcache"] = JsObj()
                val rp = plugins["rpcache"] as JsObj
                rp["state"] = Js.assign(JsObj(), or(rp["state"], JsObj()), JsObj("chapters" to chapters))
            }
            if (legacy) { conv.remove("format"); stripConflictMarks(conv) } else conv["format"] = FORMAT
            return conv
        }

        fun stripConflictMarks(node: Any?): Any? {
            if (node is MutableList<*>) { node.forEach { stripConflictMarks(it) }; return node }
            if (node !is JsObj) return node
            node.remove("_conflicts"); node.remove("conflict")
            for (k in node.keys()) { val v = node[k]; if (truthy(v) && (v is JsObj || v is MutableList<*>)) stripConflictMarks(v) }
            return node
        }

        fun isLegacyConv(obj: Any?) = obj is JsObj && truthy(obj["id"]) && !Js.strictEq(obj["format"], FORMAT)

        fun convToOps(conv: JsObj, dev: Any?): MutableList<Any?> {
            val ops = ArrayList<Any?>()
            var lamport = 0
            fun next(op: String, payload: Any?): JsObj { lamport += 1; return JsObj("lamport" to lamport.toDouble(), "dev" to dev, "op" to op, "payload" to payload) }
            val meta = extractMeta(conv)
            if (meta.size > 0) ops.add(next("meta.set", JsObj("patch" to meta)))
            val msgs = prop(conv, "messages").let { if (truthy(it) && isArr(it)) arr(it) else ArrayList() }
            msgs.forEach { m -> if (truthy(m) && truthy(prop(m, "id"))) ops.add(next("msg.add", clone(m))) }
            if (msgs.isNotEmpty()) ops.add(next("msg.reorder", JsObj("ids" to msgs.mapTo(ArrayList()) { prop(it, "id") })))
            extractChapters(conv).forEach { ch -> ops.add(next("chapter.commit", clone(ch))) }
            if (!nullish(conv["affect"])) ops.add(next("affect.set", JsObj("affect" to clone(conv["affect"]))))
            val by = conv["affectBy"]
            if (truthy(by) && by is JsObj) by.keys().forEach { cid -> ops.add(next("affect.by", JsObj("id" to cid, "state" to clone(by[cid])))) }
            extractLedger(conv).forEach { f -> ops.add(next("ledger.append", JsObj("fact" to clone(f)))) }
            if (truthy(conv["worldRef"])) ops.add(next("worldRef.set", JsObj("worldRef" to clone(conv["worldRef"]), "worldPending" to or(conv["worldPending"], null))))
            val wl = or(conv["worldLog"], ArrayList<Any?>())
            if (isArr(wl)) arr(wl).forEach { e -> ops.add(next("worldLog.append", JsObj("entry" to clone(e)))) }
            return ops
        }

        fun measureLog(ops: List<Any?>): Pair<Int, Int> {
            var bytes = 0
            ops.forEach { o -> bytes += (Js.stringify(o)?.length ?: 9) + 1 }
            return ops.size to bytes
        }

        fun stateToOps(state: JsObj): MutableList<Any?> {
            val ops = ArrayList<Any?>()
            fun pushOp(st: Any?, op: String, payload: Any?) {
                val stamp = or(st, JsObj("lamport" to 0.0, "dev" to ""))
                ops.add(JsObj("lamport" to int32(prop(stamp, "lamport")).toDouble(), "dev" to toStr(or(prop(stamp, "dev"), "")), "op" to op, "payload" to payload))
            }
            val meta = (or(state["meta"], JsObj()) as? JsObj) ?: JsObj()
            val metaKeys = meta.keys().filter { it != "id" && !metaSkip(it) }
            if (metaKeys.isNotEmpty()) {
                val patch = JsObj()
                var stamp: Any? = JsObj("lamport" to 0.0, "dev" to "")
                metaKeys.forEach { k ->
                    patch[k] = clone(meta[k])
                    val s = stamps(state, "meta")[k]
                    if (truthy(s) && stampCmp(s, stamp) > 0) stamp = s
                }
                pushOp(stamp, "meta.set", JsObj("patch" to patch))
            }
            list(state, "messages").forEach { m -> if (truthy(m) && truthy(prop(m, "id"))) pushOp(stamps(state, "msg")[toStr(prop(m, "id"))], "msg.add", clone(m)) }
            val order = list(state, "order")
            if (order.isNotEmpty()) pushOp(sub(state, "stamps")["order"], "msg.reorder", JsObj("ids" to ArrayList(order)))
            tombs(state, "msg").keys().forEach { id -> pushOp(tombs(state, "msg")[id], "msg.remove", JsObj("id" to id)) }
            list(state, "chapters").forEach { ch -> pushOp(stamps(state, "chapter")[chKey(ch)], "chapter.commit", clone(ch)) }
            tombs(state, "chapter").keys().forEach { key -> pushOp(tombs(state, "chapter")[key], "chapter.remove", JsObj("no" to key)) }
            if (!nullish(state["affect"])) pushOp(sub(state, "stamps")["affect"], "affect.set", JsObj("affect" to clone(state["affect"])))
            val by = state["affectBy"]
            if (truthy(by) && by is JsObj) by.keys().forEach { cid -> pushOp(stamps(state, "affectBy")[cid], "affect.by", JsObj("id" to cid, "state" to clone(by[cid]))) }
            list(state, "ledger").forEach { f -> pushOp(stamps(state, "ledger")[ledKeyDiff(f)], "ledger.append", JsObj("fact" to clone(f))) }
            if (truthy(state["worldRef"])) pushOp(sub(state, "stamps")["worldRef"], "worldRef.set",
                JsObj("worldRef" to clone(state["worldRef"]), "worldPending" to or(clone(state["worldPending"]), null)))
            list(state, "worldLog").forEach { e -> pushOp(JsObj("lamport" to int32(state["clock"]).toDouble(), "dev" to ""), "worldLog.append", JsObj("entry" to clone(e))) }
            val kb = sub(state, "kb")
            kb.keys().forEach { wid -> (kb[wid] as? JsObj)?.let { w -> w.keys().forEach { eid ->
                pushOp(stamps(state, "kb")["$wid/$eid"], "kb.upsert", JsObj("worldId" to wid, "entry" to clone(w[eid])))
            } } }
            return ops.sortedWith(opCmp).toMutableList()
        }
        val opCmp = Comparator<Any?> { a, b -> stampCmp(a, b).takeIf { it != 0 } ?: toStr(prop(a, "op")).compareTo(toStr(prop(b, "op"))).let { Integer.signum(it) } }

        fun diff(prev0: Any?, next0: Any?): MutableList<Any?> {
            val ops = ArrayList<Any?>()
            val prev: JsObj = (prev0 as? JsObj)?.takeIf { truthy(it) } ?: JsObj("messages" to jsArr(), "id" to (if (truthy(next0)) prop(next0, "id") else next0))
            val next: JsObj = (next0 as? JsObj) ?: JsObj("messages" to jsArr())
            val pMeta = extractMeta(prev); val nMeta = extractMeta(next)
            val patch = JsObj()
            val keys = LinkedHashSet<String>().apply { addAll(pMeta.keys()); addAll(nMeta.keys()) }
            keys.forEach { k ->
                if (k == "id") return@forEach
                if (!equal(pMeta[k], nMeta[k])) patch[k] = if (nMeta[k] === Undef) null else clone(nMeta[k])
            }
            if (patch.size > 0) ops.add(JsObj("op" to "meta.set", "payload" to JsObj("patch" to patch)))

            val pList = prop(prev, "messages").let { if (truthy(it) && isArr(it)) arr(it) else ArrayList() }
            val nList = prop(next, "messages").let { if (truthy(it) && isArr(it)) arr(it) else ArrayList() }
            val pMsg = JsObj(); pList.forEach { m -> if (truthy(m) && truthy(prop(m, "id"))) pMsg[toStr(prop(m, "id"))] = m }
            val nMsg = JsObj(); nList.forEach { m -> if (truthy(m) && truthy(prop(m, "id"))) nMsg[toStr(prop(m, "id"))] = m }
            pMsg.keys().forEach { id -> if (!truthy(nMsg[id])) ops.add(JsObj("op" to "msg.remove", "payload" to JsObj("id" to id))) }
            nList.forEach { m ->
                if (!truthy(m) || !truthy(prop(m, "id"))) return@forEach
                val pm = pMsg[toStr(prop(m, "id"))]
                if (!truthy(pm)) ops.add(JsObj("op" to "msg.add", "payload" to clone(m)))
                else if (!equal(pm, m)) ops.add(JsObj("op" to "msg.edit", "payload" to clone(m)))
            }
            val pIds = pList.filter { truthy(nMsg[toStr(prop(it, "id"))]) }.mapTo(ArrayList()) { prop(it, "id") }
            val nIds = nList.mapTo(ArrayList()) { prop(it, "id") }
            if (!equal(pIds, nIds.filterTo(ArrayList()) { truthy(pMsg[toStr(it)]) || truthy(nMsg[toStr(it)]) }) && nIds.isNotEmpty()) {
                val sameSet = pIds.size == nIds.size && pIds.all { Js.includes(nIds, it) }
                if (!equal(pIds, nIds) && (nIds.size > 1 || sameSet || pIds.isNotEmpty())) {
                    ops.add(JsObj("op" to "msg.reorder", "payload" to JsObj("ids" to nIds)))
                }
            }

            val pCh = extractChapters(prev); val nCh = extractChapters(next)
            val pChMap = JsObj(); pCh.forEach { c -> pChMap[chKey(c)] = c }
            val nChMap = JsObj(); nCh.forEach { c -> nChMap[chKey(c)] = c }
            pChMap.keys().forEach { k ->
                if (!truthy(nChMap[k])) { val c = pChMap[k]; ops.add(JsObj("op" to "chapter.remove", "payload" to JsObj("no" to (if (!nullish(prop(c, "no"))) prop(c, "no") else prop(c, "id"))))) }
            }
            nCh.forEach { c ->
                val k = chKey(c)
                if (!truthy(pChMap[k])) ops.add(JsObj("op" to "chapter.commit", "payload" to clone(c)))
                else if (!equal(pChMap[k], c)) ops.add(JsObj("op" to "chapter.edit", "payload" to clone(c)))
            }

            if (!equal(prev["affect"], next["affect"]) && (!nullish(next["affect"]) || !nullish(prev["affect"]))) {
                ops.add(JsObj("op" to "affect.set", "payload" to JsObj("affect" to (if (!nullish(next["affect"])) clone(next["affect"]) else null))))
            }
            val pBy = or(prev["affectBy"], JsObj()); val nBy = or(next["affectBy"], JsObj())
            if (nBy is JsObj) nBy.keys().forEach { cid ->
                if (!equal(prop(pBy, cid), nBy[cid])) ops.add(JsObj("op" to "affect.by", "payload" to JsObj("id" to cid, "state" to clone(nBy[cid]))))
            }

            val pLed = extractLedger(prev); val nLed = extractLedger(next)
            val pLedMap = JsObj(); pLed.forEach { f -> pLedMap[ledKeyDiff(f)] = f }
            nLed.forEach { f ->
                val k = ledKeyDiff(f)
                if (!equal(pLedMap[k], f)) ops.add(JsObj("op" to "ledger.append", "payload" to JsObj("fact" to clone(f))))
            }

            if (!equal(prev["worldRef"], next["worldRef"]) || !equal(prev["worldPending"], next["worldPending"])) {
                if (truthy(next["worldRef"]) || truthy(prev["worldRef"])) ops.add(JsObj("op" to "worldRef.set",
                    "payload" to JsObj("worldRef" to or(clone(next["worldRef"]), null), "worldPending" to or(clone(next["worldPending"]), null))))
            }
            val pLog = or(prev["worldLog"], ArrayList<Any?>()); val nLog = or(next["worldLog"], ArrayList<Any?>())
            val pSet = HashSet<String?>(); if (isArr(pLog)) arr(pLog).forEach { pSet.add(Js.stringify(it)) }
            if (isArr(nLog)) arr(nLog).forEach { e -> val k = Js.stringify(e); if (!pSet.contains(k)) ops.add(JsObj("op" to "worldLog.append", "payload" to JsObj("entry" to clone(e)))) }
            return ops
        }

        fun search(conv: JsObj, query: String): MutableList<Any?> {
            val q = query.trim().lowercase()
            val hits = ArrayList<Any?>()
            if (q.isEmpty()) return hits
            if (toStr(or(conv["title"], "")).lowercase().contains(q)) hits.add(JsObj("type" to "title", "id" to conv["id"]))
            prop(conv, "messages").let { if (isArr(it)) arr(it) else ArrayList() }.forEachIndexed { i, m ->
                if (messageText(m).lowercase().contains(q) || toStr(or(prop(m, "role"), "")).lowercase() == q) hits.add(JsObj("type" to "message", "id" to prop(m, "id"), "index" to i.toDouble()))
            }
            return hits
        }
    }

    // ================= 带 store 的部分（会话缓存按 store 对象区分，同 JS 的 WeakMap） =================
    class Session(val store: StoreJs, val id: String, val dev: Any?, var state: JsObj, var last: JsObj?, var logCount: Int, var logBytes: Int, var lastDirty: Boolean = false)
    private val sessionsByStore = WeakHashMap<StoreJs, HashMap<String, Session>>()
    private fun sessionMap(store: StoreJs) = sessionsByStore.getOrPut(store) { HashMap() }
    @Synchronized fun clearSessions() { sessionsByStore.values.forEach { it.clear() }; sessionsByStore.clear() }
    fun session(store: StoreJs, id: String): Session? = sessionMap(store)[id]

    fun ensureDev(store: StoreJs): Any? {
        var rec = store.get(DEVICE_FILE, null)
        if (rec is String) rec = JsObj("dev" to rec)
        if (!truthy(rec) || !truthy(prop(rec, "dev"))) {
            val rnd = java.lang.Long.toString((random() * 2176782336.0).toLong(), 36).padStart(6, '0').takeLast(6)
            rec = JsObj("dev" to "dev-" + java.lang.Long.toString(now(), 36) + rnd)
            try { store.set(DEVICE_FILE, rec) } catch (_: Exception) {}
        }
        return prop(rec, "dev")
    }

    fun readOps(store: StoreJs, id: String): MutableList<Any?> = (store.readJsonl(logKey(id)) ?: ArrayList()).filterTo(ArrayList()) { truthy(it) }

    fun hasOplog(store: StoreJs, id: String): Boolean {
        if (store.exists(snapshotKey(id)) || store.exists(logKey(id))) return true
        val snap = store.get(snapshotKey(id), null)
        return truthy(snap) && Js.strictEq(prop(snap, "format"), FORMAT)
    }

    fun writePointer(store: StoreJs, conv: JsObj) {
        val ptr = JsObj(
            "format" to FORMAT, "id" to conv["id"], "title" to or(conv["title"], "新对话"), "providerId" to or(conv["providerId"], ""),
            "model" to or(conv["model"], ""), "updatedAt" to or(conv["updatedAt"], now().toDouble()), "createdAt" to conv["createdAt"],
        )
        if (truthy(conv["personaName"])) { ptr["personaName"] = conv["personaName"]; ptr["personaEmoji"] = conv["personaEmoji"] }
        store.set(legacyKey(toStr(conv["id"])), ptr)
    }

    private fun blankSnap(id: Any?) = JsObj("format" to FORMAT, "upToLamport" to 0.0, "messages" to jsArr(), "chapters" to jsArr(), "affect" to null,
        "ledger" to jsArr(), "worldRef" to null, "id" to id, "meta" to JsObj("id" to id))

    fun migrateLegacy(store: StoreJs, conv: JsObj, dev: Any?): JsObj {
        val id = toStr(conv["id"])
        val ops = convToOps(conv, or(dev, ensureDev(store)))
        val snap = blankSnap(conv["id"])
        store.set(snapshotKey(id), snap)
        store.writeJsonl(logKey(id), ops)
        return JsObj("snapshot" to snap, "ops" to ops, "migrated" to true)
    }

    fun compactState(store: StoreJs, state: JsObj): Boolean {
        val snap = takeSnapshot(state, true)
        if (!store.set(snapshotKey(toStr(state["id"])), snap)) return false
        store.writeJsonl(logKey(toStr(state["id"])), emptyList())
        return true
    }

    private fun attachSession(store: StoreJs, id: String, state: JsObj, logCount: Int = 0, logBytes: Int = 0, dev: Any? = null): Session {
        val s = Session(store, id, if (truthy(dev)) dev else ensureDev(store), state, toConv(state), logCount, logBytes)
        sessionMap(store)[id] = s
        return s
    }

    class Loaded(val state: JsObj, val logCount: Int, val logBytes: Int, val from: String)

    fun loadState(store: StoreJs, id: String): Loaded? {
        if (hasOplog(store, id)) {
            val snap = store.get(snapshotKey(id), null).let { if (truthy(it)) it else blankSnap(id) }
            val ops = readOps(store, id)
            val state = replay(snap, ops)
            state["id"] = id
            val upTo = int32(prop(snap, "upToLamport"))
            val m = measureLog(ops.filter { truthy(it) && int32(prop(it, "lamport")) > upTo })
            return Loaded(state, m.first, m.second, "oplog")
        }
        val legacy = store.get(legacyKey(id), null)
        if (truthy(legacy) && Js.strictEq(prop(legacy, "format"), FORMAT) && !truthy(prop(legacy, "messages"))) {
            val state = emptyState(id)
            state["meta"] = Js.assign(state["meta"] as JsObj, extractMeta(legacy))
            return Loaded(state, 0, 0, "pointer")
        }
        if (isLegacyConv(legacy)) {
            val dev = ensureDev(store)
            migrateLegacy(store, legacy as JsObj, dev)
            val ops = readOps(store, id)
            val snap = store.get(snapshotKey(id), null)
            var state = replay(snap, ops)
            state["id"] = id
            compactState(store, state)
            val again = store.get(snapshotKey(id), null)
            state = stateFromSnapshot(again)
            return Loaded(state, 0, 0, "migrated")
        }
        return null
    }

    @Synchronized fun load(store: StoreJs, id: String): JsObj? {
        val r = loadState(store, id) ?: return null
        attachSession(store, id, r.state, r.logCount, r.logBytes)
        return toConv(r.state)
    }

    fun loadMeta(store: StoreJs, id: String): JsObj? {
        val snap = store.get(snapshotKey(id), null)
        if (truthy(snap)) {
            val meta = Js.assign(JsObj("id" to id), or(prop(snap, "meta"), JsObj()))
            if (truthy(prop(snap, "worldRef"))) meta["worldRef"] = prop(snap, "worldRef")
            return JsObj("id" to id, "title" to or(meta["title"], "未命名对话"), "providerId" to or(meta["providerId"], ""), "model" to or(meta["model"], ""),
                "updatedAt" to or(Js.toNumber(meta["updatedAt"]), 0.0), "personaName" to meta["personaName"], "personaEmoji" to meta["personaEmoji"])
        }
        val legacy = store.get(legacyKey(id), null)
        if (truthy(legacy) && truthy(prop(legacy, "id"))) {
            return JsObj("id" to prop(legacy, "id"), "title" to or(prop(legacy, "title"), "未命名对话"), "providerId" to or(prop(legacy, "providerId"), ""),
                "model" to or(prop(legacy, "model"), ""),
                "updatedAt" to or(Js.toNumber(prop(legacy, "updatedAt")), or(Js.toNumber(prop(legacy, "createdAt")), 0.0)),
                "personaName" to prop(legacy, "personaName"), "personaEmoji" to prop(legacy, "personaEmoji"))
        }
        return null
    }

    fun listConvIds(store: StoreJs): List<String> {
        val ids = LinkedHashSet<String>()
        store.list().forEach { n -> val id = idFromName(n); if (id.isNotEmpty()) ids.add(id) }
        return ids.toList()
    }

    @Synchronized fun removeFiles(store: StoreJs, id: String) {
        filesOf(id).forEach { n -> try { store.del(n) } catch (_: Exception) {} }
        sessionMap(store).remove(id)
    }

    private fun maybeCompact(s: Session) {
        if (s.logCount >= COMPACT_OPS || s.logBytes >= COMPACT_BYTES) {
            if (compactState(s.store, s.state)) { s.logCount = 0; s.logBytes = 0 }
        }
    }

    private fun sessionFor(store: StoreJs, id: String): Session = sessionMap(store)[id] ?: run {
        val r = loadState(store, id)
        if (r != null) attachSession(store, id, r.state, r.logCount, r.logBytes) else attachSession(store, id, emptyState(id))
    }

    /** push(store, id, {op, payload}, {lamport?, keepLamport?, dev?, compact?}) */
    @Synchronized fun push(store: StoreJs, id: String, op: String, payload: Any?, lamport: Int? = null, keepLamport: Boolean = false, dev: Any? = null, compact: Boolean = true): JsObj {
        val s = sessionFor(store, id)
        val clock = maxOf(int32(s.state["clock"]), lamport ?: 0) + (if (keepLamport) 0 else 1)
        val o = JsObj("lamport" to (if (keepLamport && lamport != null) lamport else clock).toDouble(), "dev" to (if (truthy(dev)) dev else s.dev), "op" to op, "payload" to payload)
        applyOp(s.state, o)
        store.append(logKey(id), o)
        s.logCount += 1; s.logBytes += (Js.stringify(o)?.length ?: 0) + 1
        if (compact) maybeCompact(s)
        s.lastDirty = true
        return o
    }

    @Synchronized fun importBatch(store: StoreJs, id: String, ops: List<Any?>, compact: Boolean = true): MutableList<Any?> {
        val s = sessionFor(store, id)
        val applied = ArrayList<Any?>()
        val seen = HashSet<String>()
        readOps(store, id).forEach { o -> seen.add(toStr(prop(o, "lamport")) + "\u0000" + toStr(prop(o, "dev")) + "\u0000" + toStr(prop(o, "op"))) }
        ops.sortedWith(opCmp).forEach { op ->
            if (!truthy(op) || !truthy(prop(op, "op"))) return@forEach
            val key = int32(prop(op, "lamport")).toString() + "\u0000" + toStr(or(prop(op, "dev"), "")) + "\u0000" + toStr(prop(op, "op"))
            if (!seen.add(key)) return@forEach
            applyOp(s.state, op)
            store.append(logKey(id), op)
            s.logCount += 1; s.logBytes += (Js.stringify(op)?.length ?: 0) + 1
            applied.add(op)
        }
        if (compact) maybeCompact(s)
        s.lastDirty = true
        return applied
    }

    fun exportBatch(store: StoreJs, id: String, sinceLamport: Int = 0): MutableList<Any?> {
        val since = sinceLamport
        if (!hasOplog(store, id)) return ArrayList()
        val snap = store.get(snapshotKey(id), null)
        val upTo = int32(prop(snap, "upToLamport"))
        val tail = readOps(store, id).filter { truthy(it) && int32(prop(it, "lamport")) > maxOf(since, if (since < upTo) upTo else since) }
        if (since < upTo && truthy(snap)) {
            val r = loadState(store, id)!!
            val catchup = stateToOps(r.state).filterTo(ArrayList()) { int32(prop(it, "lamport")) > since }
            val seen = catchup.mapTo(HashSet()) { int32(prop(it, "lamport")).toString() + "\u0000" + toStr(prop(it, "dev")) + "\u0000" + toStr(prop(it, "op")) }
            tail.forEach { o -> val k = int32(prop(o, "lamport")).toString() + "\u0000" + toStr(prop(o, "dev")) + "\u0000" + toStr(prop(o, "op")); if (seen.add(k)) catchup.add(o) }
            return catchup.sortedWith(opCmp).toMutableList()
        }
        return readOps(store, id).filterTo(ArrayList()) { truthy(it) && int32(prop(it, "lamport")) > since }
    }

    /** commit(store, conv)：diff(上次快照, conv) → 追加 op（整段重写 .log.jsonl，同 JS）→ 达阈值压缩 → 新会话写元数据指针 */
    @Synchronized fun commit(store: StoreJs, conv: JsObj): JsObj {
        if (!truthy(conv["id"])) return conv
        val id = toStr(conv["id"])
        var s = sessionMap(store)[id]
        if (s == null) {
            val r = loadState(store, id)
            if (r != null) s = attachSession(store, id, r.state, r.logCount, r.logBytes)
            else {
                val dev = ensureDev(store)
                store.set(snapshotKey(id), blankSnap(conv["id"]))
                store.writeJsonl(logKey(id), emptyList())
                writePointer(store, conv)
                s = attachSession(store, id, emptyState(conv["id"]), dev = dev)
                s.last = JsObj("id" to conv["id"], "messages" to jsArr())
            }
        }
        if (s.lastDirty || s.last == null) s.last = toConv(s.state)
        s.lastDirty = false
        val ops = diff(s.last, conv)
        if (ops.isNotEmpty()) {
            val existing = readOps(store, id)
            val applied = ArrayList<Any?>()
            ops.forEach { partial ->
                s.state["clock"] = (int32(s.state["clock"]) + 1).toDouble()
                val op = JsObj("lamport" to s.state["clock"], "dev" to s.dev, "op" to prop(partial, "op"), "payload" to prop(partial, "payload"))
                applyOp(s.state, op)
                applied.add(op)
            }
            store.writeJsonl(logKey(id), existing + applied)
            applied.forEach { op -> s.logCount += 1; s.logBytes += (Js.stringify(op)?.length ?: 0) + 1 }
        }
        maybeCompact(s)
        val last = toConv(s.state)
        s.last = last
        val existing = store.get(legacyKey(id), null)
        if (!truthy(existing) || Js.strictEq(prop(existing, "format"), FORMAT)) writePointer(store, last)
        return last
    }

    fun exportLegacy(store: StoreJs, id: String): JsObj? {
        val r = loadState(store, id)
        if (r == null) {
            val legacy = store.get(legacyKey(id), null)
            return if (truthy(legacy) && !Js.strictEq(prop(legacy, "format"), FORMAT)) Js.cloneObj(legacy) else null
        }
        return toConv(r.state, legacy = true)
    }
    fun exportLegacyJSON(store: StoreJs, id: String): String = exportLegacy(store, id)?.let { Js.stringify(it, 2) } ?: ""

    fun mergeStores(a: StoreJs, b: StoreJs, id: String): Pair<JsObj?, JsObj?> {
        val ea = exportBatch(a, id, 0); val eb = exportBatch(b, id, 0)
        importBatch(a, id, eb); importBatch(b, id, ea)
        return load(a, id) to load(b, id)
    }
}
