package com.aichat.app.domain.cost

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * usage-stats.js 的 VERSION / LOG_LIMIT / DEFAULT_PRICES / emptyState / normalize（以及 app.js usageMetaOf）。
 * D 的 FileUsageRepository 只管文件；读出 meta + log 后经 [normalize] 得到与 JS usageState 同形的状态。
 */
object UsageStatsCore {
    const val VERSION = 1
    const val LOG_LIMIT = 5000
    /** CostCore.USAGE_DEFAULT_PRICES：DEFAULT_PRICES + default 兜底（键序同 JS） */
    val DEFAULT_PRICES: JsonObject = com.aichat.app.net.Js.parse(
        """{"deepseek-flash":{"hit":0.006,"miss":0.3,"out":1.2,"match":"deepseek"},"deepseek-v4-pro":{"hit":0.044,"miss":1.32,"out":3.96,"match":"deepseek-v4-pro,deepseek-pro"},"default":{"hit":0,"miss":0.5,"out":1.5}}"""
    ) as JsonObject
    private val PRICE_MODES = setOf("auto", "peak", "offpeak")

    fun emptyState(): JsonObject = JsonObject(linkedMapOf(
        "version" to JsonPrimitive(VERSION), "backfilled" to JsonPrimitive(false), "log" to JsonArray(emptyList()),
        "prices" to DEFAULT_PRICES, "priceMode" to JsonPrimitive("auto"), "calib" to JsonObject(emptyMap())))

    /** Object.assign 对字符串源会按下标展开（"ab" → {0:"a",1:"b"}）；数字 / 布尔 / null 无效果 */
    private fun assignSource(e: JsonElement?): Map<String, JsonElement> = when {
        e is JsonObject -> e
        e is JsonArray -> e.withIndex().associate { (i, v) -> i.toString() to v }
        e is JsonPrimitive && e.isString -> e.content.withIndex().associate { (i, c) -> i.toString() to JsonPrimitive(c.toString()) }
        else -> emptyMap()
    }

    /** normalize(raw)：补齐默认字段、prices 叠加默认价目、log 非数组 → []、priceMode 非法 → auto、calib 非对象 → {}、version = 1 */
    fun normalize(raw: JsonElement?): JsonObject {
        val s = LinkedHashMap<String, JsonElement>(emptyState())
        val src = if (raw == null || raw is JsonNull || (raw is JsonPrimitive && !com.aichat.app.net.Js.truthy(raw))) emptyMap() else assignSource(raw)
        s.putAll(src)
        val pr = s["prices"]
        s["prices"] = com.aichat.app.net.Js.jsObject(LinkedHashMap<String, JsonElement>(DEFAULT_PRICES).apply {
            if (com.aichat.app.net.Js.truthy(pr)) putAll(assignSource(pr))
        })
        if (s["log"] !is JsonArray) s["log"] = JsonArray(emptyList())
        val pm = s["priceMode"]
        if (!(pm is JsonPrimitive && pm.isString && pm.content in PRICE_MODES)) s["priceMode"] = JsonPrimitive("auto")
        val c = s["calib"]
        if (!(c is JsonObject || c is JsonArray)) s["calib"] = JsonObject(emptyMap())
        s["version"] = JsonPrimitive(VERSION)
        return com.aichat.app.net.Js.jsObject(s)
    }

    /** app.js usageMetaOf：{ version, backfilled, prices, priceMode, calib } */
    fun metaOf(st: JsonObject): JsonObject = JsonObject(linkedMapOf(
        "version" to (st["version"] ?: JsonNull), "backfilled" to (st["backfilled"] ?: JsonNull), "prices" to (st["prices"] ?: JsonNull),
        "priceMode" to (st["priceMode"] ?: JsonNull), "calib" to (st["calib"]?.takeIf { com.aichat.app.net.Js.truthy(it) } ?: JsonObject(emptyMap()))))

    // ================= M4：makeEntry / record / 统计（usage-stats.js 逐函数） =================
    val TYPE_CN: Map<String, String> = linkedMapOf("chat" to "对话", "image" to "图片", "summary" to "摘要")
    private val J = com.aichat.app.net.Js
    private fun str(e: JsonElement?): String = J.str(e)
    private fun orElse(e: JsonElement?, d: JsonElement): JsonElement = if (J.truthy(e)) e!! else d
    /** JS 的 Math.random().toString(36).slice(2, 8) 近似：6 位 base36 */
    val randomId6: () -> String = { (1..6).map { "0123456789abcdefghijklmnopqrstuvwxyz"[(Math.random() * 36).toInt()] }.joinToString("") }

    /** makeEntry(o)：o = { usage, at, type, model, providerId, providerName, convId, convTitle, msgId, key, id, actualCost } */
    fun makeEntry(o: JsonObject, now: Long = System.currentTimeMillis(), rnd6: () -> String = randomId6): JsonObject {
        val u = (o["usage"]?.takeIf { J.truthy(it) } as? JsonObject) ?: JsonObject(emptyMap())
        val prompt = J.i32(u["prompt"]); val completion = J.i32(u["completion"])
        val cache = J.truthy(u["cacheSupported"])
        val hit = if (cache) J.i32(u["hit"]) else 0
        val miss = if (cache) (if (u["miss"] != null && u["miss"] !is JsonNull) J.i32(u["miss"]) else maxOf(0, prompt - hit)) else prompt
        val at: JsonElement = orElse(o["at"], JsonPrimitive(now))
        val type = orElse(o["type"], JsonPrimitive("chat"))
        val msgId = orElse(o["msgId"], JsonPrimitive(""))
        val key = orElse(o["key"], JsonPrimitive("l:" + str(at) + ":" + str(msgId) + ":" + prompt + ":" + completion + ":" + str(type)))
        val uc = u["cost"]; val oc = o["actualCost"]
        val actualCost: JsonElement = if (J.num(uc) != null) uc!! else if (J.num(oc) != null) oc!! else JsonNull
        val atL = J.toNumber(at)
        val id = orElse(o["id"], JsonPrimitive("u_" + (if (atL.isFinite()) java.lang.Long.toString(atL.toLong(), 36) else "NaN") + "_" + rnd6()))
        return JsonObject(linkedMapOf(
            "id" to id, "at" to at, "type" to type, "prompt" to JsonPrimitive(prompt), "completion" to JsonPrimitive(completion),
            "hit" to JsonPrimitive(hit), "miss" to JsonPrimitive(miss), "cache" to JsonPrimitive(cache),
            "model" to orElse(o["model"], JsonPrimitive("")), "providerId" to orElse(o["providerId"], JsonPrimitive("")),
            "providerName" to orElse(o["providerName"], JsonPrimitive("")), "convId" to orElse(o["convId"], JsonPrimitive("")),
            "convTitle" to orElse(o["convTitle"], JsonPrimitive("")), "msgId" to msgId, "key" to key, "actualCost" to actualCost))
    }

    private fun logOf(s: JsonObject): List<JsonElement> = (s["log"] as? JsonArray) ?: emptyList()
    private fun with(s: JsonObject, vararg kv: Pair<String, JsonElement>): JsonObject =
        J.jsObject(LinkedHashMap<String, JsonElement>(s).apply { kv.forEach { (k, v) -> put(k, v) } })

    /** record：按 key 去重追加，超出 LOG_LIMIT 删最旧（不改入参） */
    fun record(state: JsonElement?, entry: JsonObject?): JsonObject {
        val s = normalize(state)
        if (entry == null || entry["prompt"] == null || entry["prompt"] is JsonNull) return s
        val k = entry["key"]
        if (logOf(s).any { e -> strictEq((e as? JsonObject)?.get("key"), k) }) return s
        val log = ArrayList(logOf(s)); log += entry
        while (log.size > LOG_LIMIT) log.removeAt(0)
        return with(s, "log" to JsonArray(log))
    }
    private fun strictEq(a: JsonElement?, b: JsonElement?): Boolean {
        if (a == null || b == null) return a == null && b == null
        if (a is JsonNull || b is JsonNull) return a is JsonNull && b is JsonNull
        if (a is JsonPrimitive && b is JsonPrimitive) {
            if (a.isString != b.isString) return false
            if (a.isString) return a.content == b.content
            val x = J.toNumber(a); val y = J.toNumber(b)
            return if (a.content == "true" || a.content == "false" || b.content == "true" || b.content == "false") a.content == b.content else x == y
        }
        return a === b
    }

    fun clear(state: JsonElement?): JsonObject = with(normalize(state), "log" to JsonArray(emptyList()), "backfilled" to JsonPrimitive(true))

    fun costOf(e: JsonObject?, prices: JsonObject?, mode: String?, peak: JsonObject?, calib: JsonObject?): Double? =
        CostCoreJs.costOfEntry(e, prices ?: DEFAULT_PRICES, mode, peak, calib)

    /** reconcileEntry：真实 actualCost 对账（用未校准价估算，避免反馈环），写回 calib */
    fun reconcileEntry(state: JsonElement?, entry: JsonObject?, mode: String? = null, peak: JsonObject? = null): JsonObject {
        val s = normalize(state)
        val ac = entry?.get("actualCost")
        if (entry == null || ac == null || ac is JsonNull || !(J.toNumber(ac) > 0)) return s
        val m = mode?.takeIf { it.isNotEmpty() } ?: str(s["priceMode"])
        val est = costOf(entry, s["prices"] as? JsonObject, m, peak, null) ?: return s
        if (!(est > 0)) return s
        val at = entry["at"]
        val now = if (J.truthy(at)) J.toNumber(at).toLong() else System.currentTimeMillis()
        val calib = CostCoreJs.reconcile(s["calib"] as? JsonObject, entry["model"]?.takeIf { it !is JsonNull }?.let { str(it) }, est, J.toNumber(ac), now)
        return with(s, "calib" to calib)
    }

    private fun p2(n: Int) = n.toString().padStart(2, '0')
    /** dayKey：本地日历日（zone），或 tzOffsetMin 偏移后的 UTC 日 */
    fun dayKey(at: Long, tzOffsetMin: Int? = null, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
        val z = if (tzOffsetMin != null) java.time.ZoneOffset.UTC else zone.toZoneId()
        val t = if (tzOffsetMin != null) at + tzOffsetMin * 60000L else at
        val d = java.time.Instant.ofEpochMilli(t).atZone(z)
        return d.year.toString() + "-" + p2(d.monthValue) + "-" + p2(d.dayOfMonth)
    }
    fun monthKey(at: Long, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): String {
        val d = java.time.Instant.ofEpochMilli(at).atZone(zone.toZoneId())
        return d.year.toString() + "-" + p2(d.monthValue)
    }

    data class Range(val from: Long, val to: Long) {
        fun toJson() = JsonObject(linkedMapOf("from" to JsonPrimitive(from), "to" to JsonPrimitive(to)))
    }
    /** rangeOf(preset, now, custom)：含两端当天；today | 7d | 30d | custom | 其他 = all */
    fun rangeOf(preset: String?, now: Long = System.currentTimeMillis(), custom: Range? = null, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): Range {
        val z = zone.toZoneId()
        fun sod(t: Long) = java.time.Instant.ofEpochMilli(t).atZone(z).toLocalDate().atStartOfDay(z).toInstant().toEpochMilli()
        fun eod(t: Long) = java.time.Instant.ofEpochMilli(t).atZone(z).toLocalDate().atTime(23, 59, 59, 999_000_000).atZone(z).toInstant().toEpochMilli()
        return when {
            preset == "today" -> Range(sod(now), eod(now))
            preset == "7d" -> Range(sod(now - 6 * 86_400_000L), eod(now))
            preset == "30d" -> Range(sod(now - 29 * 86_400_000L), eod(now))
            preset == "custom" && custom != null -> Range(sod(custom.from), eod(custom.to))
            else -> Range(0, eod(now))
        }
    }

    fun filterLog(log: List<JsonObject>?, range: Range?): List<JsonObject> {
        val l = log ?: emptyList()
        if (range == null) return l.toList()
        return l.filter { e -> val a = J.toNumber(e["at"] ?: return@filter false); a >= range.from && a <= range.to }
    }

    /** sumList：{ prompt, completion, total, hit, miss, requests, cachedReqs } */
    fun sumList(list: List<JsonObject>?): JsonObject {
        var prompt = 0.0; var completion = 0.0; var hit = 0.0; var miss = 0.0; var requests = 0; var cachedReqs = 0
        (list ?: emptyList()).forEach { e ->
            prompt += J.i32(e["prompt"]); completion += J.i32(e["completion"]); hit += J.i32(e["hit"]); miss += J.i32(e["miss"]); requests++
            if (J.truthy(e["cache"])) cachedReqs++
        }
        return JsonObject(linkedMapOf("prompt" to J.number(prompt), "completion" to J.number(completion), "total" to J.number(prompt + completion),
            "hit" to J.number(hit), "miss" to J.number(miss), "requests" to JsonPrimitive(requests), "cachedReqs" to JsonPrimitive(cachedReqs)))
    }

    data class Group(val key: String, val sum: JsonObject, val items: List<JsonObject>) {
        val total: Double get() = J.toNumber(sum["total"])
        fun toJson(itemJson: (JsonObject) -> JsonElement = { it }) =
            JsonObject(LinkedHashMap<String, JsonElement>().apply { put("key", JsonPrimitive(key)); putAll(sum); put("items", JsonArray(items.map(itemJson))) })
    }
    /** groupBy(list, keyFn)：空键归「（未知）」，按 total 降序（稳定） */
    fun groupBy(list: List<JsonObject>?, keyFn: (JsonObject) -> String?): List<Group> {
        val map = LinkedHashMap<String, MutableList<JsonObject>>()
        (list ?: emptyList()).forEach { e -> val k = keyFn(e)?.takeIf { it.isNotEmpty() } ?: "（未知）"; map.getOrPut(k) { ArrayList() }.add(e) }
        return map.entries.map { (k, items) -> Group(k, sumList(items), items) }.sortedByDescending { it.total }
    }

    /** byDay(list, days, now)：最近 days 天（默认 30），每天 { key, label, ...sumList } */
    fun byDay(list: List<JsonObject>?, days: Int?, now: Long = System.currentTimeMillis(), zone: java.util.TimeZone = java.util.TimeZone.getDefault()): List<JsonObject> {
        val n = days?.takeIf { it != 0 } ?: 30
        val keyed = (list ?: emptyList()).map { e -> (e["at"]?.let { J.toNumber(it) }?.takeIf { it.isFinite() }?.let { dayKey(it.toLong(), null, zone) }) to e }
        val out = ArrayList<JsonObject>()
        for (i in n - 1 downTo 0) {
            val k = dayKey(now - i * 86_400_000L, null, zone)
            val items = keyed.filter { it.first == k }.map { it.second }
            out += JsonObject(LinkedHashMap<String, JsonElement>().apply { put("key", JsonPrimitive(k)); put("label", JsonPrimitive(k.substring(5))); putAll(sumList(items)) })
        }
        return out
    }

    /** estimateCost：{ cost, priced, total, actualSum, actualN }（NaN / Infinity 不计入） */
    fun estimateCost(list: List<JsonObject>?, prices: JsonObject?, mode: String?, peak: JsonObject?, calib: JsonObject?): JsonObject {
        var cost = 0.0; var priced = 0; var actualSum = 0.0; var actualN = 0
        val l = list ?: emptyList()
        l.forEach { e ->
            val c = costOf(e, prices, mode, peak, calib)
            if (c != null && c.isFinite()) { cost += c; priced++ }
            val a = J.num(e["actualCost"]); if (a != null && a > 0) { actualSum += a; actualN++ }
        }
        return JsonObject(linkedMapOf("cost" to J.number(cost), "priced" to JsonPrimitive(priced), "total" to JsonPrimitive(l.size),
            "actualSum" to J.number(actualSum), "actualN" to JsonPrimitive(actualN)))
    }

    private val MODEL_SUFFIX = Regex("[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]·[^\n\r\u2028\u2029]*$")
    /** collectFromMessages：从消息（含版本分支 tail）收集带 usage 的条目，key = bf:… 去重 */
    fun collectFromMessages(msgs: List<JsonElement>?, meta: JsonObject?, keysSeen: MutableSet<String> = HashSet(), out: MutableList<JsonObject> = ArrayList(),
                            now: Long = System.currentTimeMillis(), rnd6: () -> String = randomId6): MutableList<JsonObject> {
        val mt = meta ?: JsonObject(emptyMap())
        (msgs ?: emptyList()).forEach { me ->
            val m = me as? JsonObject ?: return@forEach
            val u = m["usage"]?.takeIf { J.truthy(it) } as? JsonObject
            if (u != null && u["prompt"] != null && u["prompt"] !is JsonNull && !J.truthy(m["pending"]) && !J.truthy(m["error"])) {
                val type = if (J.truthy(m["imageGen"])) "image" else "chat"
                val created = m["createdAt"]?.takeIf { J.truthy(it) } ?: JsonPrimitive(0)
                val compl = if (J.truthy(u["completion"])) J.i32(u["completion"]) else 0
                val key = "bf:" + (m["id"]?.takeIf { J.truthy(it) }?.let { str(it) } ?: "") + ":" + str(created) + ":" + J.i32(u["prompt"]) + ":" + compl + ":" + type
                if (keysSeen.add(key)) {
                    val model = str(orElse(m["model"], orElse(mt["model"], JsonPrimitive("")))).replace(MODEL_SUFFIX, "")
                    out += makeEntry(JsonObject(linkedMapOf(
                        "usage" to u, "at" to orElse(m["createdAt"], orElse(mt["updatedAt"], JsonPrimitive(now))), "type" to JsonPrimitive(type),
                        "model" to JsonPrimitive(model), "providerId" to orElse(mt["providerId"], JsonPrimitive("")), "providerName" to orElse(mt["providerName"], JsonPrimitive("")),
                        "convId" to orElse(mt["convId"], JsonPrimitive("")), "convTitle" to orElse(mt["convTitle"], JsonPrimitive("")),
                        "msgId" to orElse(m["id"], JsonPrimitive("")), "key" to JsonPrimitive(key))), now, rnd6)
                }
            }
            val vs = m["versions"] as? JsonArray
            vs?.forEach { snap ->
                if (!J.truthy(snap)) return@forEach
                val so = snap as? JsonObject ?: JsonObject(emptyMap())
                val fake = LinkedHashMap<String, JsonElement>()
                m["id"]?.let { fake["id"] = it }; m["role"]?.let { fake["role"] = it }
                fake.putAll(so); fake.remove("tail")
                collectFromMessages(listOf(JsonObject(fake)), mt, keysSeen, out, now, rnd6)
                val tail = so["tail"] as? JsonArray
                if (tail != null && tail.isNotEmpty()) collectFromMessages(tail, mt, keysSeen, out, now, rnd6)
            }
        }
        return out
    }

    /** backfill(state, convs)：一次性扫描所有对话；convs 元素 { id, title, providerId, providerName, model, updatedAt, messages } */
    fun backfill(state: JsonElement?, convs: List<JsonObject>?, now: Long = System.currentTimeMillis(), rnd6: () -> String = randomId6): JsonObject {
        val s = normalize(state)
        if (J.truthy(s["backfilled"])) return s
        val keysSeen = HashSet<String>(logOf(s).map { str((it as? JsonObject)?.get("key")) })
        val added = ArrayList<JsonObject>()
        (convs ?: emptyList()).forEach { c ->
            val meta = LinkedHashMap<String, JsonElement>()
            c["id"]?.let { meta["convId"] = it }; c["title"]?.let { meta["convTitle"] = it }; c["providerId"]?.let { meta["providerId"] = it }
            c["providerName"]?.let { meta["providerName"] = it }; c["model"]?.let { meta["model"] = it }; c["updatedAt"]?.let { meta["updatedAt"] = it }
            collectFromMessages(c["messages"] as? JsonArray, JsonObject(meta), keysSeen, added, now, rnd6)
        }
        val sorted = added.sortedWith { a, b -> J.toNumber(a["at"]).compareTo(J.toNumber(b["at"])) }
        val log = ArrayList(logOf(s)); log.addAll(sorted)
        while (log.size > LOG_LIMIT) log.removeAt(0)
        return with(s, "log" to JsonArray(log), "backfilled" to JsonPrimitive(true))
    }

    /** buckets：{ daily: {YYYY-MM-DD: sum}, monthly: {YYYY-MM: sum} } */
    fun buckets(list: List<JsonObject>?, zone: java.util.TimeZone = java.util.TimeZone.getDefault()): JsonObject {
        val daily = LinkedHashMap<String, MutableList<JsonObject>>(); val monthly = LinkedHashMap<String, MutableList<JsonObject>>()
        (list ?: emptyList()).forEach { e ->
            val at = J.toNumber(e["at"]).toLong()
            daily.getOrPut(dayKey(at, null, zone)) { ArrayList() }.add(e); monthly.getOrPut(monthKey(at, zone)) { ArrayList() }.add(e)
        }
        return JsonObject(linkedMapOf("daily" to J.jsObject(daily.mapValues { sumList(it.value) }), "monthly" to J.jsObject(monthly.mapValues { sumList(it.value) })))
    }

    private val ISO = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC)
    /** toCSV：表头 + 每行（全部加引号；只有对话标题里的 " 转义，同 JS） */
    fun toCSV(list: List<JsonObject>?): String {
        val header = listOf("时间", "类型", "模型", "服务商", "对话", "输入", "输出", "缓存命中", "未命中", "有缓存字段")
        val rows = (list ?: emptyList()).map { e ->
            val type = e["type"]
            listOf(ISO.format(java.time.Instant.ofEpochMilli(J.toNumber(e["at"]).toLong())),
                (type?.takeIf { it is JsonPrimitive && it.isString }?.let { TYPE_CN[(it as JsonPrimitive).content] }) ?: str(type),
                str(e["model"]), str(orElse(e["providerName"], e["providerId"] ?: JsonNull).let { if (it is JsonNull && e["providerId"] == null) null else it }),
                str(orElse(e["convTitle"], JsonPrimitive(""))).replace("\"", "\"\""),
                str(e["prompt"]), str(e["completion"]), str(e["hit"]), str(e["miss"]), if (J.truthy(e["cache"])) "是" else "否")
        }
        return (listOf(header) + rows).joinToString("\n") { r -> r.joinToString(",") { "\"" + it + "\"" } }
    }
}

/** 契约 UsageStats（CostContracts.kt）的实现：委托 [UsageStatsCore]。 */
class DefaultUsageStats(private val zone: java.util.TimeZone = java.util.TimeZone.getDefault()) : UsageStats {
    /** 契约多了 prices 参数（JS makeEntry 不用价目）：忽略 */
    override fun makeEntry(usage: com.aichat.app.domain.model.Usage, type: String, convId: String?, providerId: String, model: String, msgId: String?,
                           atMs: Long, prices: JsonObject): JsonObject = UsageStatsCore.makeEntry(JsonObject(LinkedHashMap<String, JsonElement>().apply {
        put("usage", CostCoreJs.usageJson(usage) ?: JsonObject(emptyMap())); put("at", JsonPrimitive(atMs)); put("type", JsonPrimitive(type))
        put("model", JsonPrimitive(model)); put("providerId", JsonPrimitive(providerId)); convId?.let { put("convId", JsonPrimitive(it)) }; msgId?.let { put("msgId", JsonPrimitive(it)) }
    }), atMs)
    /** 契约是 [fromMs, toMs]；JS byDay 是「截至 now 的最近 N 天」：N = 覆盖的自然日数 */
    override fun byDay(log: List<JsonObject>, fromMs: Long, toMs: Long): List<JsonObject> {
        val z = zone.toZoneId()
        val d0 = java.time.Instant.ofEpochMilli(fromMs).atZone(z).toLocalDate(); val d1 = java.time.Instant.ofEpochMilli(toMs).atZone(z).toLocalDate()
        val days = (java.time.temporal.ChronoUnit.DAYS.between(d0, d1) + 1).toInt().coerceAtLeast(1)
        return UsageStatsCore.byDay(log, days, toMs, zone)
    }
    /** 契约按字段名分组；JS groupBy 用 keyFn（服务商列用 providerName || providerId） */
    override fun groupBy(log: List<JsonObject>, key: String): Map<String, JsonObject> =
        UsageStatsCore.groupBy(log) { e -> if (key == "provider") com.aichat.app.net.Js.str(e["providerName"]?.takeIf { com.aichat.app.net.Js.truthy(it) } ?: e["providerId"] ?: kotlinx.serialization.json.JsonPrimitive(""))
            else e[key]?.takeIf { com.aichat.app.net.Js.truthy(it) }?.let { com.aichat.app.net.Js.str(it) } }
            .associate { it.key to it.toJson() }
    override fun toCsv(log: List<JsonObject>): String = UsageStatsCore.toCSV(log)
}
