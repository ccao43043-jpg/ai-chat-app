package com.aichat.app.domain.cost

import com.aichat.app.domain.BuiltRequest
import com.aichat.app.domain.model.ProviderConfig
import com.aichat.app.net.AuthInjector
import com.aichat.app.net.DefaultProviderClient
import com.aichat.app.net.HttpClients
import com.aichat.app.net.Js
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.OkHttpClient

/** www/balance.js：余额请求构造 + 响应解析（结果对象键序同 JS）。golden：balance.jsonl */
object BalanceCore {
    val CONSOLE: Map<String, String> = linkedMapOf(
        "deepseek" to "https://platform.deepseek.com/usage", "openai" to "https://platform.openai.com/settings/organization/billing",
        "qwen" to "https://dashscope.console.aliyun.com/", "moonshot" to "https://platform.moonshot.cn/console/account",
        "zhipu" to "https://open.bigmodel.cn/usercenter/apikeys", "siliconflow" to "https://cloud.siliconflow.cn/account/ak",
        "openrouter" to "https://openrouter.ai/settings/credits", "anthropic" to "https://console.anthropic.com/settings/plans",
        "gemini" to "https://aistudio.google.com/apikey", "xiaomi" to "https://platform.xiaomimimo.com/", "custom" to "")
    val SUPPORTED = setOf("deepseek", "siliconflow", "moonshot", "openrouter")
    private const val UNSUPPORTED_HINT = "此服务商未提供可用的余额查询接口，请到官网控制台查看。"

    data class Support(val supported: Boolean, val consoleUrl: String, val hint: String) {
        fun toJson() = JsonObject(linkedMapOf("supported" to JsonPrimitive(supported), "consoleUrl" to JsonPrimitive(consoleUrl), "hint" to JsonPrimitive(hint)))
    }
    fun supportInfo(presetId: String?): Support {
        val id = presetId?.takeIf { it.isNotEmpty() } ?: "custom"
        val ok = id in SUPPORTED
        return Support(ok, CONSOLE[id] ?: "", if (ok) "" else UNSUPPORTED_HINT)
    }
    private fun trimSlash(u: String?) = (u ?: "").replace(Regex("/+$"), "")
    fun deepseekRoot(base: String?): String {
        val t = trimSlash(base)
        if (Regex("api\\.deepseek\\.com", RegexOption.IGNORE_CASE).containsMatchIn(t)) return "https://api.deepseek.com"
        return t.replace(Regex("/v1$", RegexOption.IGNORE_CASE), "").ifEmpty { "https://api.deepseek.com" }
    }

    /** buildBalanceRequest：无 Key 返回 null；Authorization 头占位（发送时由 AuthInjector 换成真实 Key，同旧版 NativeBridge） */
    fun buildBalanceRequest(presetId: String?, baseUrl: String?, hasKey: Boolean, apiKey: String? = null): BuiltRequest? {
        if (!(hasKey || Js.trim(apiKey ?: "").isNotEmpty())) return null
        val key = Js.trim(apiKey ?: "")
        val auth = linkedMapOf("Authorization" to "Bearer $key", "Accept" to "application/json")
        return when (presetId ?: "") {
            "deepseek" -> BuiltRequest(deepseekRoot(baseUrl) + "/user/balance", "GET", auth, "")
            "siliconflow" -> BuiltRequest(trimSlash(baseUrl) + "/user/info", "GET", auth, "")
            "moonshot" -> BuiltRequest(trimSlash(baseUrl) + "/users/me/balance", "GET", auth, "")
            "openrouter" -> BuiltRequest(trimSlash(baseUrl) + "/key", "GET", auth, "")
            else -> null
        }
    }
    fun buildBalanceRequest(p: ProviderConfig): BuiltRequest? = buildBalanceRequest(p.presetId, p.baseUrl, p.hasKey)

    /** money(n, currency) */
    fun money(n: JsonElement?, currency: String?): String {
        if (n == null || n is JsonNull || (n is JsonPrimitive && n.isString && n.content.isEmpty())) return "—"
        val x = if (n is JsonPrimitive && !n.isString && n.booleanOrNullSafe() == null) Js.toNumber(n) else Js.parseFloat(Js.str(n))
        if (x.isNaN()) return Js.str(n)
        val cur = currency ?: ""
        val s = if (Math.abs(x) >= 100) Js.toFixed(x, 2) else if (Math.abs(x) >= 1) Js.toFixed(x, 2) else Js.toFixed(x, 4)
        if (cur == "CNY" || cur == "¥") return "¥$s"
        if (cur == "USD" || cur == "$") return "$$s"
        return (if (cur.isNotEmpty()) "$cur " else "") + s
    }
    private fun JsonPrimitive.booleanOrNullSafe(): Boolean? = if (isString) null else when (content) { "true" -> true; "false" -> false; else -> null }

    fun errOf(status: Int, text: String?): String {
        if (status == 401 || status == 403) return "API Key 无效或无权限（HTTP $status）"
        if (status == 404) return "接口不存在（HTTP 404）"
        if (status == 429) return "请求过于频繁（HTTP 429）"
        if (status == 0) return "网络错误，请检查连接"
        var msg = ""
        try {
            val o = Js.parse(text?.ifEmpty { null } ?: "{}")
            if (o is JsonNull) throw IllegalStateException()
            fun p(e: JsonElement?, k: String) = (e as? JsonObject)?.get(k)
            fun or(a: JsonElement?, b: JsonElement?) = if (Js.truthy(a)) a else b
            val err = p(o, "error")
            val m = or(or(if (Js.truthy(err)) or(p(err, "message"), err) else err, p(o, "message")), p(o, "msg")) ?: JsonPrimitive("")
            msg = if (m is JsonObject || m is JsonArray) Js.stringify(m) else if (Js.truthy(m)) Js.str(m) else ""
        } catch (e: Exception) { msg = (text ?: "").let { if (it.length > 80) it.substring(0, 80) else it } }
        return (if (msg.isNotEmpty()) (if (msg.length > 120) msg.substring(0, 120) else msg) + " · " else "") + "HTTP " + status
    }

    private fun item(label: String, text: String) = JsonObject(linkedMapOf("label" to JsonPrimitive(label), "text" to JsonPrimitive(text)))
    private fun fail(error: String, consoleUrl: String, unsupported: Boolean? = null) = JsonObject(LinkedHashMap<String, JsonElement>().apply {
        put("ok", JsonPrimitive(false)); unsupported?.let { put("unsupported", JsonPrimitive(it)) }; put("error", JsonPrimitive(error))
        put("primary", JsonNull); put("details", JsonArray(emptyList())); put("consoleUrl", JsonPrimitive(consoleUrl))
    })
    private fun ok(primary: JsonObject, details: List<JsonObject>, currency: String, consoleUrl: String) = JsonObject(linkedMapOf(
        "ok" to JsonPrimitive(true), "primary" to primary, "details" to JsonArray(details), "currency" to JsonPrimitive(currency), "consoleUrl" to JsonPrimitive(consoleUrl)))

    /** parseBalanceResponse(presetId, status, text) → { ok, unsupported?, error?, primary, details, currency?, consoleUrl } */
    fun parseBalanceResponse(presetId: String?, status: Int, text: String?): JsonObject {
        val info = supportInfo(presetId)
        if (!info.supported) return fail(info.hint, info.consoleUrl, true)
        if (status < 200 || status >= 300) return fail(errOf(status, text), info.consoleUrl, false)
        val o = try { Js.parse(text?.ifEmpty { null } ?: "{}") } catch (e: Exception) { return fail("响应不是合法 JSON", info.consoleUrl) }
        return try {
            when (presetId) {
                "deepseek" -> parseDeepSeek(o, info); "siliconflow" -> parseSiliconFlow(o, info)
                "moonshot" -> parseMoonshot(o, info); "openrouter" -> parseOpenRouter(o, info)
                else -> fail(info.hint, info.consoleUrl, true)
            }
        } catch (e: Exception) { fail("解析失败：" + (e.message ?: e.toString()), info.consoleUrl) }
    }
    private fun p(e: JsonElement?, k: String): JsonElement? = if (e is JsonNull) throw IllegalStateException("Cannot read properties of null (reading '$k')") else (e as? JsonObject)?.get(k)
    private fun or(a: JsonElement?, b: JsonElement?) = if (Js.truthy(a)) a else b
    private fun nul(e: JsonElement?) = e == null || e is JsonNull
    private fun curOf(e: JsonElement?): String? = if (nul(e)) null else Js.str(e)

    private fun parseDeepSeek(o: JsonElement, info: Support): JsonObject {
        val list = (or(p(o, "balance_infos"), null) as? JsonArray) ?: JsonArray(emptyList())
        if (list.isEmpty()) return fail("未返回余额信息", info.consoleUrl)
        val b = list[0]
        val cur = or(p(b, "currency"), null)?.let { Js.str(it) } ?: "CNY"
        val details = ArrayList<JsonObject>()
        list.forEach { x -> details += item((or(p(x, "currency"), null)?.let { Js.str(it) } ?: "") + " 余额", money(p(x, "total_balance"), curOf(p(x, "currency")))) }
        list.forEach { x ->
            if (!nul(p(x, "granted_balance"))) details += item((or(p(x, "currency"), null)?.let { Js.str(it) } ?: "") + " 赠送", money(p(x, "granted_balance"), curOf(p(x, "currency"))))
            if (!nul(p(x, "topped_up_balance"))) details += item((or(p(x, "currency"), null)?.let { Js.str(it) } ?: "") + " 充值", money(p(x, "topped_up_balance"), curOf(p(x, "currency"))))
        }
        val av = p(o, "is_available")
        if (av is JsonPrimitive && !av.isString && (av.content == "true" || av.content == "false")) details += item("可用状态", if (av.content == "true") "充足" else "不足")
        return ok(item("总余额", money(p(b, "total_balance"), cur)), details, cur, info.consoleUrl)
    }
    private fun parseSiliconFlow(o: JsonElement, info: Support): JsonObject {
        val d = or(p(o, "data"), o)
        val total = if (!nul(p(d, "totalBalance"))) p(d, "totalBalance") else p(d, "balance")
        if (nul(total)) return fail("未返回余额字段", info.consoleUrl)
        val details = arrayListOf(item("总余额", money(total, "CNY")))
        val bal = p(d, "balance")
        if (!nul(bal) && !strictEq(bal, total)) details += item("余额", money(bal, "CNY"))
        if (!nul(p(d, "chargeBalance"))) details += item("充值余额", money(p(d, "chargeBalance"), "CNY"))
        if (Js.truthy(p(d, "status"))) details += item("账户状态", Js.str(p(d, "status")))
        return ok(item("总余额", money(total, "CNY")), details, "CNY", info.consoleUrl)
    }
    private fun strictEq(a: JsonElement?, b: JsonElement?): Boolean {
        if (a !is JsonPrimitive || b !is JsonPrimitive) return a === b
        if (a.isString != b.isString) return false
        return if (a.isString) a.content == b.content else Js.toNumber(a) == Js.toNumber(b)
    }
    private fun parseMoonshot(o: JsonElement, info: Support): JsonObject {
        val d = or(p(o, "data"), o)
        if (nul(p(d, "available_balance"))) return fail("未返回 available_balance", info.consoleUrl)
        val cur = "CNY"
        val details = listOf(item("可用余额", money(p(d, "available_balance"), cur)), item("代金券", money(p(d, "voucher_balance"), cur)), item("现金", money(p(d, "cash_balance"), cur)))
        return ok(item("可用余额", money(p(d, "available_balance"), cur)), details, cur, info.consoleUrl)
    }
    private fun parseOpenRouter(o: JsonElement, info: Support): JsonObject {
        val d = or(p(o, "data"), o)
        val details = ArrayList<JsonObject>()
        var primary: JsonObject? = null
        if (!nul(p(d, "limit_remaining")) || !nul(p(d, "limit"))) {
            primary = item("Key 剩余额度", money(p(d, "limit_remaining"), "USD"))
            details += item("Key 额度上限", if (nul(p(d, "limit"))) "无限制" else money(p(d, "limit"), "USD"))
            details += item("Key 剩余", money(p(d, "limit_remaining"), "USD"))
        }
        if (!nul(p(d, "usage"))) details += item("本 Key 已用", money(p(d, "usage"), "USD"))
        if (!nul(p(d, "usage_daily"))) details += item("今日用量", money(p(d, "usage_daily"), "USD"))
        if (!nul(p(d, "usage_monthly"))) details += item("本月用量", money(p(d, "usage_monthly"), "USD"))
        if (!nul(p(d, "is_free_tier"))) details += item("免费档", if (Js.truthy(p(d, "is_free_tier"))) "是" else "否")
        if (primary == null && !nul(p(d, "usage"))) primary = item("本 Key 已用", money(p(d, "usage"), "USD"))
        if (primary == null) return fail("未返回额度字段", info.consoleUrl)
        details += item("说明", "账户总余额需管理密钥访问 /credits；此处为当前 Key 的额度与用量")
        return ok(primary, details, "USD", info.consoleUrl)
    }
}

/**
 * 余额查询（app.js refreshBalances）：不支持的服务商直接返回 unsupported；结果写 balance-cache.json 形状 { [providerId]: { at, result } }。
 * 缓存读写由调用方给（D 的 JsonDocStore("balance-cache.json")），这里不碰文件。
 */
class DefaultBalanceClient(
    private val auth: AuthInjector,
    private val client: OkHttpClient = HttpClients.authed,
    private val now: () -> Long = System::currentTimeMillis,
) : BalanceClient {
    companion object { const val STALE_MS = 30 * 60 * 1000L }

    /** 单个服务商：返回 { at, result }（balance-cache.json 的值） */
    override suspend fun fetch(provider: ProviderConfig): Result<JsonObject> = Result.success(entry(provider))

    suspend fun entry(p: ProviderConfig): JsonObject {
        val info = BalanceCore.supportInfo(p.presetId)
        fun wrap(result: JsonObject) = JsonObject(linkedMapOf("at" to JsonPrimitive(now()), "result" to result))
        if (!info.supported) return wrap(JsonObject(linkedMapOf("ok" to JsonPrimitive(false), "unsupported" to JsonPrimitive(true),
            "error" to JsonPrimitive(info.hint), "consoleUrl" to JsonPrimitive(info.consoleUrl))))
        val req = BalanceCore.buildBalanceRequest(p) ?: return wrap(JsonObject(linkedMapOf("ok" to JsonPrimitive(false),
            "error" to JsonPrimitive("无法构造请求"), "consoleUrl" to JsonPrimitive(info.consoleUrl))))
        return try {
            val (status, text) = withContext(Dispatchers.IO) {
                val call = client.newCall(DefaultProviderClient.toOkHttp(auth.authorize(p.id, req)))
                kotlinx.coroutines.currentCoroutineContext()[kotlinx.coroutines.Job]?.invokeOnCompletion { if (it != null) call.cancel() }
                call.execute().use { r -> r.code to (r.body?.string() ?: "") }
            }
            wrap(BalanceCore.parseBalanceResponse(p.presetId, status, text))
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: Exception) {
            wrap(JsonObject(linkedMapOf("ok" to JsonPrimitive(false), "error" to JsonPrimitive("网络错误：" + (e.message ?: e.toString())), "consoleUrl" to JsonPrimitive(info.consoleUrl))))
        }
    }

    /** refreshBalances(ids)：并发查询后合并进缓存（不在 targets 里的条目原样保留），返回新缓存 */
    suspend fun refresh(targets: List<ProviderConfig>, cache: JsonObject): JsonObject = coroutineScope {
        val results = targets.map { p -> async { p.id to entry(p) } }.awaitAll()
        JsonObject(LinkedHashMap<String, JsonElement>(cache).apply { results.forEach { (id, e) -> put(id, e) } })
    }
    /** openBalance 的自动刷新：从未查询或超过 30 分钟 */
    fun stale(targets: List<ProviderConfig>, cache: JsonObject): List<ProviderConfig> = targets.filter { p ->
        val c = cache[p.id] as? JsonObject
        val at = Js.num(c?.get("at"))
        c == null || at == null || at == 0.0 || now() - at > STALE_MS
    }
}
