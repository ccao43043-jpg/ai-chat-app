package com.aichat.app.net

import com.aichat.app.domain.BuiltRequest
import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.cost.SearchClient
import com.aichat.app.domain.model.AppSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient
import java.io.IOException

/**
 * www/search.js（请求构造 / 结果解析 / 上下文注入 / 改写查询）+ app.js 的 searchCfg / searchReady / searchErrorText。
 * 纯函数部分 golden：search.*.jsonl。
 */
object SearchCore {
    data class Provider(val id: String, val name: String, val needsKey: Boolean, val keyHint: String, val site: String)
    val SEARCH_PROVIDERS = listOf(
        Provider("tavily", "Tavily", true, "tvly-…", "https://app.tavily.com"),
        Provider("bocha", "博查 Bocha", true, "sk-…", "https://open.bochaai.com"),
        Provider("brave", "Brave Search", true, "BSA…", "https://api-dashboard.search.brave.com"),
        Provider("searxng", "SearXNG（自建实例）", false, "", "https://docs.searxng.org"),
    )
    val DEFAULT_BASE = linkedMapOf("tavily" to "https://api.tavily.com", "bocha" to "https://api.bochaai.com", "brave" to "https://api.search.brave.com", "searxng" to "")

    /** 搜索配置（app.js searchCfg）：provider / hasKey / baseUrl / count；apiKey 永远为空（Key 由 AuthInjector 注入） */
    data class Cfg(val provider: String, val hasKey: Boolean = false, val baseUrl: String = "", val count: JsonElement? = null, val apiKey: String = "")

    fun cfgOf(settings: AppSettings): Cfg {
        val ss = settings.search
        val provider = Js.str(ss["provider"] ?: JsonPrimitive("tavily")).let { if (ss["provider"] == null) "tavily" else it }
        val hasKey = Js.truthy(((ss["hasKeys"] as? JsonObject) ?: JsonObject(emptyMap()))[provider])
        val url = ((ss["urls"] as? JsonObject) ?: JsonObject(emptyMap()))[provider]
        val count = ss["count"]?.takeIf { Js.truthy(it) } ?: JsonPrimitive(5)
        return Cfg(provider, hasKey, if (Js.truthy(url)) Js.str(url) else "", count)
    }
    fun info(id: String): Provider = SEARCH_PROVIDERS.firstOrNull { it.id == id } ?: SEARCH_PROVIDERS[0]
    private val HTTP_URL = Regex("^https?://.+")
    /** searchReady：需要 Key 的服务看 hasKey；SearXNG 看实例地址 */
    fun ready(c: Cfg): Boolean = if (info(c.provider).needsKey) c.hasKey else HTTP_URL.containsMatchIn(Js.trim(c.baseUrl))
    /** 鉴权 id：有 Key 时 search:<provider>，否则不带 Key（app.js webSearch 的 authed(…, hasKey ? … : '')） */
    fun keyId(c: Cfg): String? = if (c.hasKey) "search:" + c.provider else null

    fun clampCount(n: JsonElement?): Int {
        val v = parseIntJs(if (n == null) "undefined" else Js.str(n))
        return maxOf(1, minOf(10, v ?: 5))
    }
    /** parseInt(x, 10)：前导空白 + 可选符号 + 数字前缀；失败 null（NaN） */
    fun parseIntJs(s: String): Int? {
        val t = Js.trim(s)
        val m = Regex("^[+-]?\\d+").find(t) ?: return null
        return m.value.toBigInteger().coerceIn(Int.MIN_VALUE.toBigInteger(), Int.MAX_VALUE.toBigInteger()).toInt()
    }

    /** encodeURIComponent */
    fun encodeURIComponent(s: String): String {
        val sb = StringBuilder()
        val bytes = s.toByteArray(Charsets.UTF_8)
        for (b in bytes) {
            val c = b.toInt() and 0xff
            val ch = c.toChar()
            if (c < 0x80 && (ch in 'A'..'Z' || ch in 'a'..'z' || ch in '0'..'9' || ch in "-_.!~*'()")) sb.append(ch)
            else sb.append('%').append(String.format("%02X", c))
        }
        return sb.toString()
    }

    /** buildSearchRequest(cfg, query)；未知服务 / SearXNG 无地址抛 IllegalArgumentException（文案同 JS） */
    fun buildSearchRequest(cfg: Cfg, query: String?): BuiltRequest {
        val count = clampCount(cfg.count)
        val key = Js.trim(cfg.apiKey)
        val base = Js.trimSlash(cfg.baseUrl).ifEmpty { DEFAULT_BASE[cfg.provider] ?: "" }
        val q = Js.trim(query ?: "").let { sliceUtf16(it, 380) }
        return when (cfg.provider) {
            "tavily" -> BuiltRequest(base + "/search", "POST", linkedMapOf("Content-Type" to "application/json", "Authorization" to "Bearer $key"),
                Js.stringify(JsonObject(linkedMapOf("query" to JsonPrimitive(q), "max_results" to JsonPrimitive(count), "search_depth" to JsonPrimitive("basic"), "include_answer" to JsonPrimitive(false)))))
            "bocha" -> BuiltRequest(base + "/v1/web-search", "POST", linkedMapOf("Content-Type" to "application/json", "Authorization" to "Bearer $key"),
                Js.stringify(JsonObject(linkedMapOf("query" to JsonPrimitive(q), "freshness" to JsonPrimitive("noLimit"), "summary" to JsonPrimitive(true), "count" to JsonPrimitive(count)))))
            "brave" -> BuiltRequest(base + "/res/v1/web/search?q=" + encodeURIComponent(q) + "&count=" + count, "GET",
                linkedMapOf("Accept" to "application/json", "X-Subscription-Token" to key), "")
            "searxng" -> {
                if (base.isEmpty()) throw IllegalArgumentException("请先填写 SearXNG 实例地址")
                BuiltRequest(base + "/search?q=" + encodeURIComponent(q) + "&format=json", "GET",
                    LinkedHashMap<String, String>().apply { put("Accept", "application/json"); if (key.isNotEmpty()) put("Authorization", "Bearer $key") }, "")
            }
            else -> throw IllegalArgumentException("未知的搜索服务：" + cfg.provider)
        }
    }
    /** String.prototype.slice(0, n)（UTF-16 单元，可能切开代理对，同 JS） */
    fun sliceUtf16(s: String, n: Int): String = if (s.length <= n) s else s.substring(0, n)

    private val HOST = Regex("^https?://([^/?#]+)", RegexOption.IGNORE_CASE)
    fun hostOf(url: String?): String = HOST.find(url ?: "")?.groupValues?.get(1)?.replace(Regex("^www\\."), "") ?: ""
    private val TAG = Regex("<[^>]+>")
    private val WS = Regex("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")
    fun clean(s: JsonElement?): String = Js.trim((if (Js.truthy(s)) Js.str(s) else "").replace(TAG, "").replace(WS, " "))

    class SearchParseException(message: String, val syntax: Boolean = false) : Exception(message)

    /** parseSearchResponse → [{title,url,content,site,date}]；非 JSON 抛 SearchParseException(syntax=true)，博查错误码抛其 msg */
    fun parseSearchResponse(provider: String, text: String, count: JsonElement?): List<JsonObject> {
        val obj = try { Js.json.parseToJsonElement(text) } catch (e: Exception) { throw SearchParseException(e.message ?: "", true) }
        fun p(o: JsonElement?, k: String): JsonElement? = (o as? JsonObject)?.get(k)
        fun arr(e: JsonElement?): List<JsonElement> = when { e is JsonArray -> e; Js.truthy(e) -> throw SearchParseException("TypeError"); else -> emptyList() }
        /** JS 里 r 为 null/undefined 时读 r.title 抛 TypeError */
        fun <T> nn(r: JsonElement, f: () -> T): T = if (r is JsonNull) throw SearchParseException("TypeError") else f()
        fun or(a: JsonElement?, b: JsonElement?): JsonElement? = if (Js.truthy(a)) a else b
        data class R(val title: JsonElement?, val url: JsonElement?, val content: JsonElement?, val site: JsonElement?, val date: JsonElement?)
        if (obj is JsonNull && provider in setOf("tavily", "bocha", "brave", "searxng")) throw SearchParseException("TypeError")
        val list: List<R?> = when (provider) {
            "tavily" -> arr(or(p(obj, "results"), null)).map { r -> nn(r) { R(p(r, "title"), p(r, "url"), or(p(r, "content"), p(r, "raw_content")), null, p(r, "published_date")) } }
            "bocha" -> {
                val code = p(obj, "code")
                if (Js.truthy(code) && !(code is JsonPrimitive && !code.isString && Js.toNumber(code) == 200.0) && !Js.truthy(p(obj, "data")))
                    throw SearchParseException(or(or(p(obj, "msg"), p(obj, "message")), null)?.let { Js.str(it) } ?: ("博查返回错误码 " + Js.str(code)))
                val wp = or(or(p(p(obj, "data"), "webPages").takeIf { Js.truthy(p(obj, "data")) }, p(obj, "webPages")), JsonObject(emptyMap()))
                arr(or(p(wp, "value"), null)).map { r -> nn(r) { R(p(r, "name"), p(r, "url"), or(p(r, "summary"), p(r, "snippet")), p(r, "siteName"), or(p(r, "datePublished"), p(r, "dateLastCrawled"))) } }
            }
            "brave" -> arr(or(p(p(obj, "web"), "results").takeIf { Js.truthy(p(obj, "web")) }, null)).map { r ->
                nn(r) {
                    val parts = (listOf(p(r, "description") ?: JsonNull) + (or(p(r, "extra_snippets"), null).let { x -> if (x is JsonArray) x else if (x != null) listOf(x) else emptyList() })).filter { Js.truthy(it) }
                    R(p(r, "title"), p(r, "url"), JsonPrimitive(parts.joinToString(" ") { Js.str(it) }), null, or(p(r, "page_age"), p(r, "age")))
                }
            }
            "searxng" -> arr(or(p(obj, "results"), null)).map { r -> nn(r) { R(p(r, "title"), p(r, "url"), p(r, "content"), null, p(r, "publishedDate")) } }
            else -> emptyList()
        }
        val seen = HashSet<String>()
        val n = clampCount(if (Js.truthy(count)) count else JsonPrimitive(10))
        return list.filter { r ->
            r != null && Js.truthy(r.url) && Regex("^https?:", RegexOption.IGNORE_CASE).containsMatchIn(Js.str(r.url)) && seen.add(Js.str(r.url))
        }.take(n).map { r ->
            val url = Js.str(r!!.url)
            JsonObject(linkedMapOf("title" to JsonPrimitive(clean(r.title).ifEmpty { hostOf(url) }), "url" to r.url!!,
                "content" to JsonPrimitive(sliceUtf16(clean(r.content), 1200)), "site" to JsonPrimitive(clean(r.site).ifEmpty { hostOf(url) }),
                "date" to JsonPrimitive(if (Js.truthy(r.date)) sliceUtf16(Js.str(r.date), 10) else "")))
        }
    }

    /** buildSearchContext(results, question, {today, maxChars})：today 由调用方给（本地日期，TimeLine.localDateStr） */
    fun buildSearchContext(results: List<JsonObject>, question: String, today: String, maxChars: Int = 6000): String {
        var used = 0
        val blocks = ArrayList<String>()
        results.forEachIndexed { i, r ->
            var content = r["content"]?.takeIf { Js.truthy(it) }?.let { Js.str(it) } ?: ""
            val remain = maxChars - used
            if (remain <= 80) return@forEachIndexed
            if (content.length > remain) content = content.substring(0, remain) + "…"
            used += content.length
            blocks += "[" + (i + 1) + "] " + Js.str(r["title"]) + "\n链接：" + Js.str(r["url"]) + (if (Js.truthy(r["date"])) "\n日期：" + Js.str(r["date"]) else "") + "\n内容：" + content
        }
        return "以下是针对用户问题的联网搜索结果（今天是 $today）：\n\n" + blocks.joinToString("\n\n") +
            "\n\n请结合以上搜索结果回答用户的问题。要求：\n" +
            "1. 引用搜索结果中的信息时，在对应句子末尾用 [编号] 标注来源，例如 [1] 或 [2][3]；\n" +
            "2. 只引用与问题相关的结果，不要编造链接或编号；\n" +
            "3. 如果搜索结果不足以回答，请说明，并可结合自身知识作答（这部分不加编号）；\n" +
            "4. 不需要在末尾重复列出参考链接。\n\n用户问题：" + question
    }

    data class Turn(val role: String, val content: String?)
    fun buildRewritePrompt(question: String, history: List<Turn>?): String {
        val ctx = (history ?: emptyList()).takeLast(4).joinToString("\n") { m -> (if (m.role == "user") "用户：" else "助手：") + sliceUtf16(m.content ?: "", 300) }
        return "你是搜索词生成器。根据对话和用户最新问题，生成一个最适合在搜索引擎中检索的简短查询词（不超过 30 个字，保留关键实体、时间与地点）。只输出查询词本身，不要解释、不要引号。\n\n" +
            (if (ctx.isNotEmpty()) "最近对话：\n$ctx\n\n" else "") + "最新问题：" + question
    }
    private val RW_PREFIX = Regex("^(查询词|搜索词|query)[\\s\\u00a0\\u3000]*[:：][\\s\\u00a0\\u3000]*", RegexOption.IGNORE_CASE)
    private val RW_QUOTES = Regex("^[\"'“”「」]+|[\"'“”「」]+$")
    fun cleanRewrite(text: String?, fallback: String): String {
        var t = (text ?: "").split("\n").map { Js.trim(it) }.firstOrNull { it.isNotEmpty() } ?: ""
        t = Js.trim(t.replace(RW_PREFIX, "").replace(RW_QUOTES, ""))
        return if (t.isNotEmpty() && t.length <= 120) t else fallback
    }

    /** app.js searchErrorText(status, text) */
    fun searchErrorText(status: Int, text: String?): String {
        var msg = ""
        try {
            val o = Js.json.parseToJsonElement(text ?: "")
            fun p(e: JsonElement?, k: String): JsonElement? = (e as? JsonObject)?.get(k)
            fun or(a: JsonElement?, b: JsonElement?): JsonElement? = if (Js.truthy(a)) a else b
            if (o is JsonNull) throw IllegalStateException("null.detail")   // JS：null.detail → TypeError → catch 分支
            val d = or(or(p(o, "detail"), p(o, "error")), o)
            val m: JsonElement? = if (d is JsonPrimitive && d.isString) d else
                or(or(or(or(or(or(p(d, "error"), p(d, "message")), p(d, "msg")), if (Js.truthy(p(d, "detail"))) or(p(p(d, "detail"), "message"), p(p(d, "detail"), "error")) else p(d, "detail")), p(o, "message")), p(o, "msg")), JsonPrimitive(""))
            msg = if (m is JsonPrimitive && m.isString) m.content else Js.stringify(m)
        } catch (e: Exception) {
            msg = sliceUtf16(Js.trim((text ?: "").replace(TAG, " ").replace(WS, " ")), 160)
        }
        val hint = when (status) {
            401, 403 -> "API Key 无效或没有权限"; 429 -> "请求太频繁或额度已用完"; 432, 433, 402 -> "额度不足或超出套餐限制"; 0 -> "没有收到响应"; else -> ""
        }
        return "HTTP " + status + (if (hint.isNotEmpty()) "（$hint）" else "") + (if (msg.isNotEmpty()) "：" + sliceUtf16(msg, 200) else "")
    }
}

/**
 * 联网搜索客户端（app.js webSearch + rewriteQuery 的网络部分）。有 Key 时经 [AuthInjector] 用 search:<provider> 注入；
 * 无 Key（SearXNG）直接发出（同旧版 authed(req, '')）。
 */
class DefaultSearchClient(
    private val auth: AuthInjector,
    private val client: OkHttpClient = HttpClients.authed,
    private val today: () -> String = { com.aichat.app.engine.TimeLine.localDateStr(System.currentTimeMillis()) },
) : SearchClient {
    constructor(keys: KeyVault?) : this(AuthInjector(keys))

    /** webSearch：超时 25s；失败抛 IOException(searchErrorText / 解析错误文案) */
    suspend fun webSearch(cfg: SearchCore.Cfg, query: String): List<JsonObject> = withContext(Dispatchers.IO) {
        val req0 = try { SearchCore.buildSearchRequest(cfg, query) } catch (e: IllegalArgumentException) { throw IOException(e.message) }
        val req = SearchCore.keyId(cfg)?.let { auth.authorize(it, req0) } ?: req0
        val (status, text) = execute(req, 25_000)
        if (status >= 400 || status == 0) throw IOException(SearchCore.searchErrorText(status, text))
        try { SearchCore.parseSearchResponse(cfg.provider, text, cfg.count) }
        catch (e: SearchCore.SearchParseException) { throw IOException(if (e.syntax) "返回的不是 JSON（SearXNG 需在实例中开启 json 格式）" else e.message) }
    }

    internal suspend fun execute(req: BuiltRequest, timeoutMs: Long): Pair<Int, String> = withContext(Dispatchers.IO) {
        val call = client.newBuilder().callTimeout(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS).build().newCall(DefaultProviderClient.toOkHttp(req))
        kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]?.invokeOnCompletion { if (it != null) call.cancel() }
        try { call.execute().use { r -> r.code to (r.body?.string() ?: "") } }
        catch (e: java.io.InterruptedIOException) { if (call.isCanceled()) throw e; throw IOException("请求超时") }
    }

    override suspend fun search(query: String, settings: AppSettings): Result<List<JsonObject>> = runCatching {
        val cfg = SearchCore.cfgOf(settings)
        val list = webSearch(cfg, query)
        if (list.isEmpty()) throw IOException("没有搜索到相关结果")
        list
    }
    override fun buildSearchContext(results: List<JsonObject>, query: String): String = SearchCore.buildSearchContext(results, query, today())
}
