package com.aichat.app.net

/**
 * www/netretry.js：网络失败分类 + 指数退避（只在还没收到正文时重试；用户停止 / 4xx（除 408/409/425/429）不重试）。golden：netretry.jsonl。
 */
object NetRetry {
    const val MAX_RETRIES = 2
    val RETRY_STATUS = setOf(408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529)
    data class Kind(val kind: String, val retry: Boolean, val label: String)

    private val RE_TIMEOUT = Regex("timeout|timed out|超时", RegexOption.IGNORE_CASE)
    private val RE_ABORT = Regex("abort|cancel", RegexOption.IGNORE_CASE)
    private val RE_FATAL = Regex("context.{0,20}(length|window)|maximum context|too many tokens|insufficient.{0,10}(quota|balance)|余额不足", RegexOption.IGNORE_CASE)

    /** classify(status, raw, err)：status 用 Number(status)||0；err = 网络异常的 message（无则 null） */
    fun classify(status: Double, raw: String?, err: String?): Kind {
        val s = if (status.isNaN()) 0.0 else status
        val t = (raw ?: "") + " " + (err ?: "")
        if (s == 0.0) {
            if (RE_TIMEOUT.containsMatchIn(t)) return Kind("timeout", true, "请求超时")
            if (RE_ABORT.containsMatchIn(t)) return Kind("aborted", false, "已取消")
            return Kind("network", true, "网络连接失败")
        }
        val st = Js.numberToString(s)
        if (s == 429.0) return Kind("rate_limit", true, "请求过于频繁（429）")
        if (s == 401.0 || s == 403.0) return Kind("auth", false, "鉴权失败（$st）")
        if (RE_FATAL.containsMatchIn(t)) return Kind("fatal", false, "不可重试错误（$st）")
        if (s == Math.floor(s) && s.toInt() in RETRY_STATUS) return Kind(if (s >= 500) "server" else "transient", true, "服务端暂时不可用（$st）")
        if (s >= 400) return Kind("client", false, "请求错误（$st）")
        return Kind("ok", false, "")
    }
    fun classify(status: Int, raw: String?, err: String?): Kind = classify(status.toDouble(), raw, err)

    /** backoff(attempt, kind, rnd)：base·2^attempt（429 起步 2s，其余 0.8s），上限 15s，×(0.8+0.4·rnd) 后取整 */
    fun backoff(attempt: Double, kind: String?, rnd: Double = Math.random()): Long {
        val base = if (kind == "rate_limit") 2000.0 else 800.0
        val a = maxOf(0, Js.toInt32(attempt))
        return Js.round(minOf(15000.0, base * Math.pow(2.0, a.toDouble())) * (0.8 + 0.4 * rnd)).toLong()
    }
    fun backoff(attempt: Int, kind: String?, rnd: Double = Math.random()): Long = backoff(attempt.toDouble(), kind, rnd)

    fun shouldRetry(c: Kind?, attempt: Int, gotDelta: Boolean, stopped: Boolean): Boolean =
        c != null && c.retry && !gotDelta && !stopped && attempt < MAX_RETRIES
}
