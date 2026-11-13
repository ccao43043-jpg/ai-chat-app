package com.aichat.app.data.secret

import com.aichat.app.SecretStore
import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.model.AuthType
import java.net.URI
import java.util.Locale

/**
 * 直接复用旧 SecretStore（SharedPreferences "aichat_secrets" + AndroidKeyStore 别名 "aichat_secrets_v1"，AES-256-GCM）。
 * 同包名 + 同签名覆盖安装后，Keystore 条目与 prefs 都还在，无需迁移、明文不落地。
 * 键名：s:provider_key:<id> / o:provider_key:<id>（绑定源）/ r:<id>（baseUrl\nauthType）；搜索用 search:<id>。
 */
class SecretKeyVault(private val store: SecretStore) : KeyVault {
    private fun name(id: String) = if (id.startsWith("search:")) "search_key:" + id.removePrefix("search:") else "provider_key:$id"

    override fun has(providerId: String) = store.has(name(providerId))
    override fun set(providerId: String, key: String): Boolean {
        val n = name(providerId)
        if (key.isEmpty()) { store.remove(n); return true }
        if (!store.put(n, key)) return false
        store.reg(providerId)?.let { r -> originOf(r[0])?.let { store.setOrigin(n, it) } }
        return true
    }
    override fun delete(providerId: String) = store.remove(name(providerId))
    override fun keyFor(providerId: String, requestUrl: String): String? {
        val r = store.reg(providerId) ?: return null
        val allowed = originOf(r[0]) ?: return null
        if (allowed != originOf(requestUrl)) return null          // 与 NativeBridge.requestForProvider 同规则
        val bound = store.origin(name(providerId))
        return if (bound == null || bound == allowed) store.get(name(providerId)) else null
    }
    override fun authType(providerId: String) = AuthType.of(store.reg(providerId)?.getOrNull(1))

    companion object {
        /** 与 NativeBridge.originOf / secure.js originOf 一致 */
        fun originOf(u: String?): String? = try {
            val x = URI(u!!.trim())
            val scheme = x.scheme?.lowercase(Locale.ROOT); val host = x.host
            if (scheme == null || host == null || x.rawUserInfo != null || (scheme != "http" && scheme != "https")) null
            else {
                var port = x.port
                if ((scheme == "http" && port == 80) || (scheme == "https" && port == 443)) port = -1
                scheme + "://" + host.lowercase(Locale.ROOT) + (if (port > 0) ":$port" else "")
            }
        } catch (e: Exception) { null }
    }
}
