package com.aichat.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.aichat.app.domain.KeyVault
import com.aichat.app.domain.SettingsRepository
import com.aichat.app.domain.model.AppSettings
import com.aichat.app.domain.model.AuthType
import com.aichat.app.ui.common.LocalUiDeps
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/** 联网搜索设置（app.js renderSearchSettings / readSearchSettings 同语义）。settings.search = {provider, hasKeys, urls, count, rewrite} */
object SearchConfig {
    data class Provider(val id: String, val name: String, val needsKey: Boolean, val keyHint: String, val defaultBase: String, val hint: String)
    val PROVIDERS = listOf(
        Provider("tavily", "Tavily", true, "tvly-…", "https://api.tavily.com", "在 app.tavily.com 注册后获取 API Key（每月有免费额度）。"),
        Provider("bocha", "博查 Bocha", true, "sk-…", "https://api.bochaai.com", "在 open.bochaai.com 微信扫码登录，于「API KEY 管理」中创建 Key。国内直连，中文结果好。"),
        Provider("brave", "Brave Search", true, "BSA…", "https://api.search.brave.com", "在 api-dashboard.search.brave.com 订阅 Search API 后获取 Token。"),
        Provider("searxng", "SearXNG（自建实例）", false, "", "", "填写自建 SearXNG 实例地址，并在实例 settings.yml 的 search.formats 中加入 json。无需 Key。"),
    )
    fun info(id: String?) = PROVIDERS.firstOrNull { it.id == id } ?: PROVIDERS[0]
    fun auth(id: String) = if (id == "brave") AuthType.BRAVE else AuthType.BEARER
    fun keyId(id: String) = "search:$id"

    fun provider(s: AppSettings) = (s.search["provider"] as? JsonPrimitive)?.content ?: "tavily"
    fun urls(s: AppSettings) = (s.search["urls"] as? JsonObject)?.mapValues { (it.value as? JsonPrimitive)?.content ?: "" }.orEmpty()
    fun count(s: AppSettings) = (s.search["count"] as? JsonPrimitive)?.intOrNull ?: 5
    fun rewrite(s: AppSettings) = (s.search["rewrite"] as? JsonPrimitive)?.booleanOrNull ?: false
    fun base(s: AppSettings, id: String) = urls(s)[id]?.takeIf { it.isNotEmpty() } ?: info(id).defaultBase

    /** searchReady：searxng 需要地址；其余需要 Key */
    fun ready(s: AppSettings, keys: KeyVault): Boolean { val p = provider(s); return if (p == "searxng") base(s, p).isNotEmpty() else keys.has(keyId(p)) }

    private fun put(o: JsonObject, k: String, v: JsonElement) = JsonObject(o + (k to v))

    /** 保存某个搜索服务的配置；返回提示文案 */
    suspend fun save(settings: SettingsRepository, keys: KeyVault, pid: String, url: String, keyText: String, count: Int, rewrite: Boolean): String {
        val u = url.trim().trimEnd('/')
        val s0 = settings.settings.value
        val urls = JsonObject(urls(s0).mapValues { JsonPrimitive(it.value) } + (pid to JsonPrimitive(u)))
        val base = u.ifEmpty { info(pid).defaultBase }
        val cleared = settings.registerProvider(keyId(pid), base, auth(pid))
        var msg = "已保存"
        when (val a = KeyMask.resolve(keyText)) {
            KeyMask.Action.Keep -> if (cleared) msg = "接口地址的主机已变更，旧 Key 已清除，请重新填写"
            KeyMask.Action.Delete -> keys.delete(keyId(pid))
            is KeyMask.Action.Replace -> if (!keys.set(keyId(pid), a.key)) msg = "Key 保存失败"
        }
        val hk = ((s0.search["hasKeys"] as? JsonObject) ?: JsonObject(emptyMap())) + (pid to JsonPrimitive(keys.has(keyId(pid))))
        settings.update { s ->
            var o = s.search
            o = put(o, "provider", JsonPrimitive(pid)); o = put(o, "urls", urls); o = put(o, "hasKeys", JsonObject(hk))
            o = put(o, "count", JsonPrimitive(count.coerceIn(1, 10))); o = put(o, "rewrite", JsonPrimitive(rewrite))
            s.copy(search = o)
        }
        return msg
    }
}

@Composable
fun SearchSettingsScreen(onBack: () -> Unit, toast: (String) -> Unit) {
    val deps = LocalUiDeps.current
    val s by deps.settings.settings.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var pid by rememberSaveable { mutableStateOf(SearchConfig.provider(s)) }
    val info = SearchConfig.info(pid)
    var url by rememberSaveable(pid) { mutableStateOf(SearchConfig.urls(s)[pid].orEmpty()) }
    var key by rememberSaveable(pid) { mutableStateOf(KeyMask.initialText(deps.keys.has(SearchConfig.keyId(pid)))) }
    var count by rememberSaveable { mutableStateOf(SearchConfig.count(s).toString()) }
    var rewrite by rememberSaveable { mutableStateOf(SearchConfig.rewrite(s)) }
    var show by remember { mutableStateOf(false) }

    SettingsPageScaffold("联网搜索", onBack, actions = {
        TextButton(onClick = {
            if (pid == "searxng" && url.isBlank()) { toast("请先填写实例地址"); return@TextButton }
            scope.launch { toast(SearchConfig.save(deps.settings, deps.keys, pid, url, key, count.toIntOrNull() ?: 5, rewrite))
                key = KeyMask.initialText(deps.keys.has(SearchConfig.keyId(pid))) }
        }, Modifier.testTag("search-save")) { Text("保存") }
    }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("发送时联网搜索", Modifier.weight(1f))
                Switch(s.searchOn, { on -> scope.launch { deps.settings.update { it.copy(searchOn = on) } } }, Modifier.testTag("search-on"))
            }
            Text("搜索服务", style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                SearchConfig.PROVIDERS.forEach { p -> FilterChip(pid == p.id, { pid = p.id }, label = { Text(p.name.substringBefore('（')) }) }
            }
            Text(info.hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (info.needsKey) OutlinedTextField(key, { key = KeyMask.sanitizeEdit(key, it) }, label = { Text("API Key") }, singleLine = true,
                placeholder = { Text(info.keyHint) }, modifier = Modifier.fillMaxWidth().testTag("search-key"),
                visualTransformation = if (show || key == KeyMask.MASK) VisualTransformation.None else PasswordVisualTransformation(),
                trailingIcon = { TextButton(onClick = { show = !show }) { Text(if (show) "隐藏" else "显示") } })
            OutlinedTextField(url, { url = it }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                label = { Text(if (pid == "searxng") "实例地址（必填）" else "接口地址（可选，留空使用官方地址）") },
                placeholder = { Text(if (pid == "searxng") "https://searx.example.com" else info.defaultBase) })
            OutlinedTextField(count, { count = it.filter(Char::isDigit).take(2) }, label = { Text("结果条数（1–10）") }, singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), modifier = Modifier.fillMaxWidth())
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("查询改写"); Text("先让模型把问题改写成搜索关键词（多一次请求）", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(rewrite, { rewrite = it })
            }
        }
    }
}
