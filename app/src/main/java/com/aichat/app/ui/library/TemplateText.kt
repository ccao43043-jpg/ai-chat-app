package com.aichat.app.ui.library

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** templates.js 的变量部分：{{变量名}} / {{变量名|默认值}}；{{time}}/{{date}}/{{时间}}/{{日期}} 自动替换 */
object TemplateText {
    private val AUTO_NAMES = setOf("time", "date", "时间", "日期")
    private val VAR_RE = Regex("\\{\\{\\s*([^{}\\n]{1,30}?)\\s*\\}\\}")
    private val LINE_RE = Regex("^\\s*(?:-\\s*)?(?:(?:【[^】]{1,12}】|[^{}\\n：:]{1,16}[：:])\\s*)?\\{\\{\\s*([^{}|\\n]{1,40}?)\\s*\\}\\}\\s*$")
    private val HEAD_RE = Regex("^【[^】]+】\\s*$")

    private fun varName(n: String) = n.split('|')[0].trim()

    fun variables(content: String): List<String> {
        val out = ArrayList<String>()
        VAR_RE.findAll(content).forEach { m -> val n = varName(m.groupValues[1]); if (n !in out && n !in AUTO_NAMES) out += n }
        return out
    }

    fun autoMacros(now: Date = Date()): Map<String, String> {
        val time = SimpleDateFormat("HH:mm", Locale.ROOT).format(now)
        val date = SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(now)
        return mapOf("time" to time, "时间" to time, "date" to date, "日期" to date)
    }

    /** 替换变量；没填的保留原样。dropEmpty（内置模板）：整行只有一个没填的变量时删掉该行，删空的【分段】标题也删 */
    fun fill(content: String, values: Map<String, String>, dropEmpty: Boolean = false, now: Date = Date()): String {
        val auto = autoMacros(now)
        fun has(n: String) = values[n]?.isNotBlank() == true
        var src = content
        if (dropEmpty) {
            val lines = src.split('\n').filter { l -> val m = LINE_RE.find(l); !(m != null && !has(m.groupValues[1]) && m.groupValues[1] !in auto) }
            src = lines.filterIndexed { i, l ->
                if (!HEAD_RE.matches(l)) true
                else {
                    var keep = false
                    for (j in i + 1 until lines.size) { if (HEAD_RE.matches(lines[j])) break; if (lines[j].isNotBlank()) { keep = true; break } }
                    keep
                }
            }.joinToString("\n").replace(Regex("\n{3,}"), "\n\n").trim()
        }
        return VAR_RE.replace(src) { m ->
            val raw = m.groupValues[1]; val n = varName(raw)
            val def = if ('|' in raw) raw.substring(raw.indexOf('|') + 1).trim() else null
            when {
                has(n) -> values[n]!!.trim()
                n in auto -> auto[n]!!
                def != null -> def
                else -> m.value
            }
        }
    }

    fun pushRecent(recent: List<String>, id: String, max: Int = 5) = (listOf(id) + recent.filter { it != id }).take(max)
}
