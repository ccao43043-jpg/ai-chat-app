package com.aichat.app.net

import com.aichat.app.data.secret.SecretKeyVault
import com.aichat.app.domain.BuiltRequest
import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.model.AuthType

/**
 * 认证注入（NativeBridge.requestForProvider 的等价物；spec §3.3 第 5 条）：
 * - 服务商必须已登记（[KeyVault.registration]，契约 #5），未登记直接拒绝「服务商未登记」，绝不发出；
 * - 已登记但没有 Key：照旧不带 Key 发出（同旧版 NativeBridge，整合者确认保持现状）；
 * - 请求地址的源必须等于登记的 baseUrl 源，否则拒绝；
 * - 调用方传入的认证头（authorization / x-api-key / x-goog-api-key / x-subscription-token）一律丢弃；
 * - Key 只从 [KeyVault.keyFor] 取（源绑定不一致时为 null → 不带 Key 发出，同旧版）；
 * - 带 Key 的请求由调用方以 followRedirects=false 的 client 发出（见 [HttpClients.authed]）。
 */
class AuthInjector(private val keys: KeyVault?) {
    class Rejected(message: String) : Exception(message)

    /** @param keyId provider id，或搜索用的 "search:<id>" */
    fun authorize(keyId: String, req: BuiltRequest): BuiltRequest {
        val reg = keys?.registration(keyId) ?: throw Rejected("服务商未登记")
        val allowed = reg.origin
        val target = SecretKeyVault.originOf(req.url)
        if (allowed == null || allowed != target) throw Rejected("请求地址与服务商 Base URL 不一致，已拒绝")
        val clean = LinkedHashMap<String, String>()
        for ((k, v) in req.headers) if (k.lowercase() !in AUTH_HEADERS) clean[k] = v
        val key = keys?.keyFor(keyId, req.url)
        if (!key.isNullOrEmpty()) when (keys!!.authType(keyId)) {
            AuthType.ANTHROPIC -> clean["x-api-key"] = key
            AuthType.GEMINI -> clean["x-goog-api-key"] = key
            AuthType.BRAVE -> clean["X-Subscription-Token"] = key
            AuthType.BEARER -> clean["Authorization"] = "Bearer $key"
        }
        return req.copy(headers = clean)
    }

    companion object {
        val AUTH_HEADERS = setOf("authorization", "x-api-key", "x-goog-api-key", "x-subscription-token")
    }
}
