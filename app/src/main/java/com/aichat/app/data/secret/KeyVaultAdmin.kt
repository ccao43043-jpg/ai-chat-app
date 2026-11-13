package com.aichat.app.data.secret

import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.ProviderRegistration
import com.aichat.app.domain.model.AuthType

/**
 * D 内部用的 KeyVault 扩展（不进 domain 契约）：登记服务商、试解密。
 * SettingsRepository.registerProvider 与 MigrationService 的 Key 体检经它调用。
 */
interface KeyVaultAdmin : KeyVault {
    /** 同 NativeBridge.registerProvider：返回 "ok" | "cleared"（源变了、已删旧 Key）| "error" */
    fun register(id: String, baseUrl: String, auth: AuthType): String
    /** 试解密一次（不输出明文）。无 Key 返回 false */
    fun canDecrypt(providerId: String): Boolean
}

/** 内存版 KeyVault（测试 / 预览 / 其它工作流的假实现）。规则与 SecretKeyVault 相同（源绑定、未登记返回 null）。 */
class FakeKeyVault : KeyVaultAdmin {
    private val keys = HashMap<String, String>()
    private val bound = HashMap<String, String?>()
    private val regs = HashMap<String, Pair<String, AuthType>>()
    /** 测试钩子：模拟 Keystore 条目丢失（解密失败） */
    val undecryptable = HashSet<String>()

    @Synchronized override fun has(providerId: String) = keys.containsKey(providerId)
    @Synchronized override fun set(providerId: String, key: String): Boolean {
        if (key.isEmpty()) { delete(providerId); return true }
        keys[providerId] = key; bound[providerId] = regs[providerId]?.let { SecretKeyVault.originOf(it.first) }; return true
    }
    @Synchronized override fun delete(providerId: String) { keys.remove(providerId); bound.remove(providerId) }
    @Synchronized override fun keyFor(providerId: String, requestUrl: String): String? {
        val r = regs[providerId] ?: return null
        val allowed = SecretKeyVault.originOf(r.first) ?: return null
        if (allowed != SecretKeyVault.originOf(requestUrl)) return null
        val b = bound[providerId]
        return if (b == null || b == allowed) keys[providerId]?.takeIf { providerId !in undecryptable } else null
    }
    @Synchronized override fun authType(providerId: String) = regs[providerId]?.second ?: AuthType.BEARER
    @Synchronized override fun registration(providerId: String) = regs[providerId]?.let { ProviderRegistration(it.first, SecretKeyVault.originOf(it.first), it.second) }
    @Synchronized override fun register(id: String, baseUrl: String, auth: AuthType): String {
        if (id.isEmpty()) return "error"
        regs[id] = baseUrl to auth
        val b = bound[id]; val now = SecretKeyVault.originOf(baseUrl)
        if (keys.containsKey(id) && b != null && b != now) { delete(id); return "cleared" }
        return "ok"
    }
    @Synchronized override fun canDecrypt(providerId: String) = keys.containsKey(providerId) && providerId !in undecryptable
}
