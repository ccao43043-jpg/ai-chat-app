package com.aichat.app.data.secret

import com.aichat.app.SecretStore
import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.ProviderRegistration
import com.aichat.app.domain.model.AuthType
import java.net.URI
import java.util.Locale

/**
 * 直接复用旧 SecretStore（SharedPreferences "aichat_secrets" + AndroidKeyStore 别名 "aichat_secrets_v1"，AES-256-GCM）。
 * 同包名 + 同签名覆盖安装后，Keystore 条目与 prefs 都还在，无需迁移、明文不落地。
 * 键名：s:provider_key:<id> / o:provider_key:<id>（绑定源）/ r:<id>（baseUrl\nauthType）；搜索用 search:<id>。
 */
class SecretKeyVault(private val store: SecretStore) : KeyVaultAdmin {
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
    /** 与 NativeBridge.registerProvider 逐行一致 */
    override fun register(id: String, baseUrl: String, auth: AuthType): String {
        if (id.isEmpty()) return "error"
        store.putReg(id, baseUrl, auth.wire)
        val n = name(id)
        val bound = store.origin(n); val now = originOf(baseUrl)
        if (store.has(n) && bound != null && bound != now) { store.remove(n); return "cleared" }
        return "ok"
    }
    override fun canDecrypt(providerId: String): Boolean = store.has(name(providerId)) && store.get(name(providerId)) != null
    override fun registration(providerId: String): ProviderRegistration? {
        val r = store.reg(providerId) ?: return null
        val base = r.getOrNull(0) ?: return null
        return ProviderRegistration(base, originOf(base), AuthType.of(r.getOrNull(1)))
    }

    companion object {
        /** 与 NativeBridge.originOf / secure.js originOf 一致 */
        /** secure.js originOf 逐行移植（正则，不用 URI：两端要对同一输入给出同一结果）；非法返回 null（JS 为 ''） */
        fun originOf(u: String?): String? {
            val m = ORIGIN_RE.find((u ?: "").trim()) ?: return null
            val scheme = m.groupValues[1].lowercase(Locale.ROOT)
            val pm = PORT_RE.matchEntire(m.groupValues[2].lowercase(Locale.ROOT))!!
            val host = pm.groupValues[1]; var port = pm.groupValues[2]
            if (host.isEmpty() || HOST_BAD.containsMatchIn(host)) return null
            if ((scheme == "https" && port == "443") || (scheme == "http" && port == "80")) port = ""
            return scheme + "://" + host + (if (port.isNotEmpty()) ":$port" else "")
        }
        private val ORIGIN_RE = Regex("""^(https?)://([^/?#@\\\s]+)(?=[/?#]|$)""", RegexOption.IGNORE_CASE)
        private val PORT_RE = Regex("""^(.*?)(?::(\d+))?$""", RegexOption.DOT_MATCHES_ALL)
        private val HOST_BAD = Regex("""[^a-z0-9.\-\[\]:]""")
    }
}
