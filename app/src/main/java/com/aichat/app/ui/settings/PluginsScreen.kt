package com.aichat.app.ui.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.aichat.app.domain.ChatPlugin
import com.aichat.app.domain.model.AppSettings
import com.aichat.app.ui.common.LocalUiDeps
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** 插件开关（plugins.js isEnabled：settings.plugins[id].enabled，未设时用 defaultEnabled） */
object PluginToggles {
    fun enabled(s: AppSettings, p: ChatPlugin): Boolean =
        ((s.plugins[p.id] as? JsonObject)?.get("enabled") as? JsonPrimitive)?.booleanOrNull ?: p.defaultEnabled

    /** 只改 enabled，保留插件私有配置 / 价格等其他键 */
    fun withEnabled(s: AppSettings, id: String, on: Boolean): AppSettings {
        val cur = (s.plugins[id] as? JsonObject) ?: JsonObject(emptyMap())
        return s.copy(plugins = JsonObject(s.plugins + (id to JsonObject(cur + ("enabled" to JsonPrimitive(on))))))
    }

    /** 对话级开关：conv.extras.plugins[id].enabled（spec §3.3 ChatPlugin 注释）；null = 未设置（按 autoActive） */
    fun convEnabled(extras: JsonObject, id: String): Boolean? =
        (((extras["plugins"] as? JsonObject)?.get(id) as? JsonObject)?.get("enabled") as? JsonPrimitive)?.booleanOrNull

    fun withConvEnabled(extras: JsonObject, id: String, on: Boolean): JsonObject {
        val all = (extras["plugins"] as? JsonObject) ?: JsonObject(emptyMap())
        val cur = (all[id] as? JsonObject) ?: JsonObject(emptyMap())
        return JsonObject(extras + ("plugins" to JsonObject(all + (id to JsonObject(cur + ("enabled" to JsonPrimitive(on)))))))
    }
}

/** 插件面板挂载点（C 注册各插件的配置 / 诊断面板；点插件名打开） */
object PluginPanels {
    private val pages = HashMap<String, SettingsPage>()
    fun register(id: String, page: SettingsPage) { pages[id] = page }
    fun get(id: String) = pages[id]
}

@Composable
fun PluginsScreen(onBack: () -> Unit, openPanel: (String) -> Unit) {
    val deps = LocalUiDeps.current
    val s by deps.settings.settings.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val errors by deps.plugins.errors.collectAsStateWithLifecycle()
    SettingsPageScaffold("插件", onBack) {
        if (deps.plugins.plugins.isEmpty()) Text("插件尚未接入（工作流 C）", Modifier.padding(20.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        deps.plugins.plugins.forEach { p ->
            Row(Modifier.clickable(enabled = PluginPanels.get(p.id) != null) { openPanel(p.id) }.padding(horizontal = 20.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(p.name, style = MaterialTheme.typography.bodyLarge)
                    Text(listOfNotNull(if (p.perConversation) "可按对话开关" else null, if (PluginPanels.get(p.id) != null) "点击查看面板" else null)
                        .joinToString(" · "), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(PluginToggles.enabled(s, p), { on -> scope.launch { deps.settings.update { PluginToggles.withEnabled(it, p.id, on) } } },
                    Modifier.testTag("plugin-${p.id}"))
            }
        }
        if (errors.isNotEmpty()) {
            Text("最近的插件错误（${errors.size}）", style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(20.dp, 12.dp, 20.dp, 4.dp))
            errors.takeLast(10).forEach { e -> Text(e.toString().take(200), style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 2.dp)) }
        }
    }
}
