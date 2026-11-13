package com.aichat.app.plugins.knowledge

import com.aichat.app.plugins.js.*
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.ln

/**
 * www/retrieval-core.js 逐函数移植：grams / buildIndex / bm25f / mmr / pickByBudget。
 * 文档 / 候选沿用 JS 值模型（[JObj]），查询为保序 Map（JS Map 迭代序 = 插入序）。
 */
object RetrievalCore {
    class Index(
        val df: HashMap<String, Int>, val postings: HashMap<String, MutableList<Any?>>, val len: HashMap<String, HashMap<String, Int>>,
        val avgLen: HashMap<String, Double>, val tf: HashMap<String, HashMap<String, HashMap<String, Int>>>, val n: Int, val sig: String, val fields: List<String>,
    )

    fun lower(s: String): String = s.lowercase(Locale.ROOT)

    /** term 切分：中文 bigram（单字段落保留单字），英文 / 数字 [a-z0-9_]+ */
    fun grams(text: Any?, n: Int? = null): MutableList<String> {
        val out = ArrayList<String>(); val str = lower(if (Js.truthy(text)) Js.str(text) else "")
        val nn = n ?: 2
        var i = 0
        while (i < str.length) { if (isW(str[i])) { val st = i; while (i < str.length && isW(str[i])) i++; out += str.substring(st, i) } else i++ }
        i = 0
        while (i < str.length) {
            if (isHan(str[i])) {
                val st = i; while (i < str.length && isHan(str[i])) i++
                val seg = str.substring(st, i)
                if (seg.length == 1) out += seg
                else if (nn <= 1) { for (c in seg) out += c.toString() }
                else for (k in 0 until seg.length - (nn - 1)) out += seg.substring(k, k + nn)
            } else i++
        }
        return out
    }
    private fun isW(c: Char) = c in 'a'..'z' || c in '0'..'9' || c == '_'
    private fun isHan(c: Char) = c in '\u4e00'..'\u9fff'
    fun terms(text: Any?): MutableList<String> = grams(text)

    private fun fieldText(raw: Any?): Any? = if (raw is List<*>) raw.joinToString(" ") { if (it == null || it == Undefined) "" else Js.str(it) } else raw

    fun buildIndex(docs: List<JObj>?, fields: List<String>?, prev: Index? = null): Index {
        val fs = if (!fields.isNullOrEmpty()) fields else listOf("text")
        val ds = docs ?: emptyList()
        val sig = ds.joinToString("|") { Js.str(it["id"].let { v -> if (v == null && !it.containsKey("id")) Undefined else v }) + ":" + Js.str(Js.or(it["updatedAt"], 0.0)) } + "#" + fs.joinToString(",")
        if (prev != null && prev.sig == sig) return prev
        val idx = Index(HashMap(), HashMap(), HashMap(), HashMap(), HashMap(), ds.size, sig, fs)
        val sum = HashMap<String, Int>(); fs.forEach { sum[it] = 0 }
        for (d in ds) {
            val id = Js.str(d["id"]); val tf = HashMap<String, HashMap<String, Int>>(); val seen = LinkedHashSet<String>(); idx.len[id] = HashMap()
            for (f in fs) {
                val arr = grams(fieldText(d[f]))
                idx.len[id]!![f] = arr.size; sum[f] = sum[f]!! + arr.size; val m = HashMap<String, Int>(); tf[f] = m
                arr.forEach { t -> m[t] = (m[t] ?: 0) + 1; seen += t }
            }
            idx.tf[id] = tf
            seen.forEach { t -> idx.df[t] = (idx.df[t] ?: 0) + 1; idx.postings.getOrPut(t) { ArrayList() }.add(d["id"]) }
        }
        fs.forEach { f -> idx.avgLen[f] = if (ds.isNotEmpty()) (sum[f]!!.toDouble() / ds.size).let { if (it == 0.0 || it.isNaN()) 1.0 else it } else 1.0 }
        return idx
    }

    fun idf(idx: Index, t: String): Double { val df = idx.df[t] ?: 0; return ln(1 + (idx.n - df + 0.5) / (df + 0.5)) }

    /** 带权查询（JS Map；与 JS 普通对象区分开） */
    class Query : LinkedHashMap<String, Double>()
    fun buildQuery(query: Any?, weight: Double? = null): Query {
        if (query is Query) return query
        val q = Query(); val w = weight ?: 1.0
        grams(query).forEach { t -> q[t] = (q[t] ?: 0.0) + w }
        return q
    }
    fun addQuery(q: Query, text: Any?, weight: Double? = null): Query {
        val w = weight ?: 1.0; grams(text).forEach { t -> q[t] = (q[t] ?: 0.0) + w }; return q
    }

    fun bm25f(idx: Index, queryTerms: Any?, doc: JObj, weights: Map<String, Double>?, k1: Double? = null, b: Double? = null): Double {
        val K1 = k1 ?: 1.2; val B = b ?: 0.75; val W = weights ?: emptyMap()
        val fs = idx.fields
        val tf = idx.tf[Js.str(doc["id"])] ?: return 0.0
        val q = buildQuery(queryTerms)
        var s = 0.0
        for ((t, qw) in q) {
            if ((idx.df[t] ?: 0) == 0) continue
            val i = idf(idx, t)
            for (f in fs) {
                val wf = W[f] ?: 1.0
                if (wf == 0.0 || wf.isNaN()) continue
                val n = tf[f]?.get(t) ?: 0; if (n == 0) continue
                val L = idx.len[Js.str(doc["id"])]!![f]!! / (idx.avgLen[f].let { if (it == null || it == 0.0) 1.0 else it })
                s += qw * wf * i * (n * (K1 + 1)) / (n + K1 * (1 - B + B * L))
            }
        }
        return s
    }

    fun charGrams3(s: Any?): Set<String> {
        val t0 = lower(if (Js.truthy(s)) Js.str(s) else "")
        val t = buildString { for (c in t0) if (!Js.isWs(c)) append(c) }
        val g = HashSet<String>()
        for (i in 0 until t.length - 2) g += t.substring(i, i + 3)
        return g
    }
    fun jaccard3(a: Any?, b: Any?): Double {
        val A = charGrams3(a); val B = charGrams3(b)
        if (A.isEmpty() && B.isEmpty()) return 1.0
        if (A.isEmpty() || B.isEmpty()) return 0.0
        var inter = 0; A.forEach { if (it in B) inter++ }
        return inter.toDouble() / (A.size + B.size - inter)
    }

    fun mmr(cands: List<JObj>?, lambda: Double?, sim: ((JObj, JObj) -> Double)?, maxN: Int?): MutableList<JObj> {
        val lam = lambda ?: 0.7
        val simFn = sim ?: { a, b -> jaccard3(Js.or(a["text"], ""), Js.or(b["text"], "")) }
        val limit = maxN ?: (cands?.size ?: 0)
        val left = ArrayList(cands ?: emptyList()); val S = ArrayList<JObj>()
        while (left.isNotEmpty() && S.size < limit) {
            var best: JObj? = null; var bv = Double.NEGATIVE_INFINITY
            for (x in left) {
                val red = if (S.isNotEmpty()) S.maxOf { y -> simFn(x, y) } else 0.0
                val v = lam * Js.toNumber(Js.or(x["score"], 0.0)) - (1 - lam) * red
                if (v > bv) { bv = v; best = x }
            }
            if (best == null) break
            left.removeAt(left.indexOfFirst { it === best }); S += best
        }
        return S
    }

    fun pickByBudget(cands: List<JObj>?, tokenOf: ((JObj) -> Double)?, budget: Any?): MutableList<JObj> {
        var left = maxOf(0, Js.i32(budget)).toDouble()
        val out = ArrayList<JObj>()
        val tokFn = tokenOf ?: { c -> ceil(Js.str(Js.or(Js.or(c["text"], c["content"]), "")).length * 0.7) + 6 }
        for (c in cands ?: emptyList()) {
            val t = tokFn(c)
            if (t > left) continue
            left -= t
            out += Js.assign(c, mapOf("tokens" to t))
        }
        return out
    }
}
