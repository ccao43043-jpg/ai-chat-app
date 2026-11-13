package com.aichat.app.plugins.rp

import com.aichat.app.plugins.js.*

/** www/autochar.js 移植：RP 模板首条消息 → 自动生成角色卡（提示词、输出容错解析、系统提示词残留变量清理）。依赖 [RpState.parseSections]。 */
object AutoChar {
    val RP_TEMPLATE_IDS = listOf("t-rp-immersive", "t-rp-narrator", "t-rp-longform")
    private val SKIP_IDS = listOf("t-rp-cardgen")
    private fun s(v: Any?) = if (Js.truthy(v)) Js.str(v) else ""
    private val RP_TAG = Js.re("角色扮演|RP", "i")

    fun isRpTemplate(conv: Any?, templates: List<Any?>?): Boolean {
        val id = conv["templateId"]
        if (!Js.truthy(id) || id in SKIP_IDS) return false
        if (id in RP_TEMPLATE_IDS) return true
        val t = (templates ?: emptyList()).firstOrNull { it["id"] == id }
        return Js.truthy(t) && !Js.truthy(t["skill"]) && ((Js.or(t["tags"], ArrayList<Any?>()) as? List<*>) ?: emptyList<Any?>()).any { Js.test(RP_TAG, Js.str(it)) }
    }
    private val H1 = Js.re("^\\s*-\\s*设定：\\s*[^\\s{]", "m")
    private val H2 = Js.re("【角色卡】\\s*\\n\\s*[^\\s【]")
    private val H3 = Js.re("【主要角色】\\s*\\n([^\\n]+)")
    private val H3b = Js.re("[：:]\\s*[^\\s{]")
    private val COLON = Js.re("[：:]")
    private val H4 = Js.re("主要角色[：:]\\s*([^\\n]+)")
    private val H4b = Js.re("——\\s*[^\\s{]")
    private val H5 = Js.re("【(?:角色设定|人物设定|人设)】\\s*\\n([^\\n【]+)")
    private val BRACES = Js.re("\\{\\{")
    fun hasCharacter(conv: Any?): Boolean {
        val st = conv["plugins"]["rpcache"]["state"]
        if (Js.truthy(st) && ((Js.or(st["blocks"], ArrayList<Any?>()) as? List<*>) ?: emptyList<Any?>()).any { b -> Js.truthy(b) && b["id"] == "character" && Js.trim(s(b["content"])).isNotEmpty() }) return true
        if (Js.truthy(conv) && Js.truthy(conv["autoChar"]) && conv["autoChar"]["status"] == "done") return true
        val sp = s(conv["systemPrompt"])
        fun filled(v: String?) = !v.isNullOrEmpty() && !Js.test(BRACES, v) && Js.trim(v).length >= 2
        if (Js.test(H1, sp)) return true
        if (Js.test(H2, sp)) return true
        Js.match(H3, sp)?.let { m -> if (Js.test(H3b, m[1]!!) && filled(Js.split(COLON, m[1]!!).drop(1).joinToString(":"))) return true }
        Js.match(H4, sp)?.let { m -> if (Js.test(H4b, m[1]!!)) return true }
        Js.match(H5, sp)?.let { m -> if (filled(m[1])) return true }
        return false
    }
    fun mode(settings: Any?): String {
        if (!Js.truthy(settings)) return "auto"
        if (settings["autoCharGen"] == false) return "off"
        val m = settings["autoCharMode"]
        return if (m == "ask" || m == "auto" || m == "off") m as String else "auto"
    }
    fun shouldOffer(conv: Any?, templates: List<Any?>?, settings: Any?): Boolean {
        if (!Js.truthy(conv) || mode(settings) == "off") return false
        if (Js.truthy(conv["autoChar"]) && Js.truthy(conv["autoChar"]["asked"])) return false
        val msgs = (Js.or(conv["messages"], ArrayList<Any?>()) as? List<*>) ?: emptyList<Any?>()
        val us = msgs.filter { it["role"] == "user" && !Js.truthy(it["error"]) && !Js.truthy(it["imageGen"]) }
        if (us.size != 1 || Js.trim(s(us[0]["content"])).isEmpty()) return false
        if (msgs.any { it["role"] == "assistant" && !Js.truthy(it["error"]) && Js.trim(s(it["content"])).isNotEmpty() }) return false
        return isRpTemplate(conv, templates) && !hasCharacter(conv)
    }
    fun fromUserText(text: Any?): JObj? { val f = parse(text); return if (f != null && Js.truthy(f["character"])) f else null }
    const val FORMAT = "【世界观】\n【角色卡】\n【RP规则】\n【输出格式】\n【示例对白】\n【禁止事项】\n【写作风格】\n【开场白】"
    fun buildPrompt(firstText: Any?, systemPrompt: Any?, skillContent: Any?): String {
        val rules = if (Js.truthy(skillContent) && Js.trim(Js.str(skillContent)).isNotEmpty()) Js.trim(Js.str(skillContent))
            else "你是角色卡生成器。把用户的想法整理成可直接角色扮演的完整设定，信息不足时合理补全，角色卡写具体可扮演的细节（姓名、年龄性别、外貌、身份、背景经历、性格优缺点、说话方式、喜好禁忌、秘密、人物关系、与用户的关系、目标动机）。"
        val story = "\n6. 一次到位：【世界观】除了时代、地点、势力与规则，还要写「- 主线剧情：」（核心冲突、阶段走向、伏笔）和「- 当前局势：」（故事从哪里开始）；【角色卡】写主角之外再列出 2–4 个重要配角 / NPC（姓名、身份、与主角关系、动机）；【RP规则】写明用户扮演的身份；所有内容写成成品，不留任何 {{变量}}、「待定」或需要用户填写的空位。"
        return rules + "\n\n---\n下面是一场角色扮演的设定上下文，请据此直接输出完整 8 段设定。\n硬性要求：\n1. 每段以单独一行的【标题】开头，标题字面与下列完全一致，按顺序输出，不要加序号、不要用 Markdown 标题或代码块；\n2. 段内用「- 」列表；【角色卡】第一行写「- 姓名：xxx」；\n3. 用户首条消息里已经给出的名字、身份、关系、场景必须原样保留，只补全缺失部分，不要改写用户的设定；\n4. 【开场白】写一段符合当前 RP 模板文风、以角色口吻展开的开场；\n5. 不要寒暄、不要解释、不要提问，直接从【世界观】开始输出。" + story + "\n" + FORMAT +
            (if (Js.truthy(systemPrompt)) "\n\n【当前 RP 模板（系统提示词，供参考，保持一致）】\n" + Js.slice(Js.str(systemPrompt), 0, 6000) else "") +
            "\n\n【用户首条消息】\n" + Js.slice(s(firstText), 0, 6000)
    }
    private const val HEAD_WORDS = "世界观|世界背景|背景设定|世界设定|角色卡|角色设定|人物设定|RP ?规则|扮演规则|规则|输出格式|回复格式|示例对白|示例对话|对白示例|禁止事项|写作风格|文风|开场白|开场"
    private val PLOT_HEAD = Js.re("^\\s{0,3}(?:#{1,4}\\s*)?(?:\\*\\*)?\\s*[【\\[［]\\s*(?:主线)?(?:剧情|剧情大纲|故事大纲|主线|故事线)\\s*[】\\]］]\\s*(?:\\*\\*)?\\s*$")
    private val HEAD = Js.re("^\\s{0,3}(?:#{1,4}\\s*)?(?:(?:\\d{1,2}|[一二三四五六七八九十]{1,2})\\s*[.、)）．]\\s*)?(?:\\*\\*|__)?\\s*[【\\[［〔]?\\s*($HEAD_WORDS)\\s*[】\\]］〕]?\\s*(?:\\*\\*|__)?\\s*(?:[：:]\\s*(?:\\*\\*)?)?\\s*(.*)$", "i")
    private val MARKED = Js.re("[【\\[［〔#]|\\*\\*|__|^\\s*(?:\\d|[一二三四五六七八九十])")
    fun normalize(raw: Any?): String {
        var t = Js.replace(Js.re("<think(?:ing)?>[\\s\\S]*?<\\/think(?:ing)?>", "gi"), s(raw), true, "")
        t = Js.replace(Js.re("^[\\s\\S]*?<\\/think>", "i"), t, false, "")
        t = Js.replace(Js.re("\\r\\n?", "g"), t, true, "\n")
        t = Js.replace(Js.re("^\\s*```[a-z0-9]*\\s*$", "gim"), t, true, "")
        t = t.split("\n").joinToString("\n") { if (Js.test(PLOT_HEAD, it)) "【世界观】\n- 主线剧情：" else it }
        return Js.trim(t.split("\n").joinToString("\n") { line ->
            val m = Js.match(HEAD, line) ?: return@joinToString line
            val rest = Js.replace(Js.re("^\\*\\*\\s*"), m[2] ?: "", false, "")
            val marked = Js.test(MARKED, line.substring(0, line.indexOf(m[1]!!) + 1))
            if (!marked && rest.isNotEmpty()) return@joinToString line
            "【" + Js.replace(Js.re("\\s+", "g"), m[1]!!, true, " ") + "】" + (if (rest.isNotEmpty()) " $rest" else "")
        })
    }
    private val ONLY_CHAR = Js.re("【(?:角色卡|角色设定|人物设定)】([\\s\\S]*?)(?=\\n\\s*【|$)")
    fun parse(raw: Any?): JObj? {
        val t = normalize(raw)
        var f = RpState.parseSections(t)
        if (f == null) {
            val m = Js.match(ONLY_CHAR, t)
            if (m != null && Js.trim(m[1]!!).length >= 20) f = jobj("character" to Js.trim(m[1]!!))
        }
        if (f == null || !Js.truthy(f["character"])) {
            val plain = Js.trim(Js.replace(Js.re("^【[^】]*】.*$", "gm"), t, true, ""))
            if (!t.contains("【") && plain.length >= 40 && Js.test(Js.re("(姓名|名字)[：:]"), plain) && Js.test(Js.re("(性格|外貌|身份|背景)"), plain)) return jobj("character" to plain)
            return null
        }
        return f
    }
    val TITLES = linkedMapOf("world" to "世界观", "character" to "角色卡", "rules" to "RP规则", "format" to "输出格式", "fewshot" to "示例对白", "prohibit" to "禁止事项", "style" to "写作风格")
    fun toPromptAppend(fields: Any?): String =
        "\n\n=== 自动生成的角色卡 ===\n" + TITLES.keys.filter { Js.truthy(fields[it]) }.joinToString("\n\n") { "【" + TITLES[it] + "】\n" + Js.str(fields[it]) }
    private val NAME = Js.re("(?:姓名|名字|角色名|名称)\\s*[：:]\\s*([^\\n，,（(、；;/|]{1,20})")
    fun charName(fields: Any?): String {
        val c = Js.replace(Js.re("\\*\\*|__", "g"), s(if (Js.truthy(fields)) fields["character"] else fields), true, "")
        val m = Js.match(NAME, c) ?: return ""
        return Js.replace(Js.re("[。.\\s]+$"), Js.trim(m[1]!!), false, "")
    }
    private val VAR_LINE = Js.re("^\\s*(?:-\\s*)?(?:[^{}\\n：:]{1,16}[：:]\\s*)?\\{\\{[^{}]*\\}\\}\\s*$")
    private val IS_HEAD = Js.re("^【[^】]+】\\s*$")
    fun fillLeftovers(sp: Any?, fields: Any?): String {
        val name = charName(fields)
        var t = s(sp)
        if (name.isNotEmpty()) t = Js.replace(Js.re("\\{\\{\\s*(?:角色名|角色|char)\\s*\\}\\}", "gi"), t, true, name)
        t = Js.replace(Js.re("\\{\\{\\s*(?:用户名|用户|user)\\s*\\}\\}", "gi"), t, true, "你")
        t = t.split("\n").filter { !Js.test(VAR_LINE, it) }.joinToString("\n")
        t = Js.replace(Js.re("\\{\\{\\s*[^{}|]+\\|([^{}]+)\\}\\}", "g"), t, true, "$1")
        t = Js.replace(Js.re("\\{\\{[^{}]*\\}\\}", "g"), t, true, "")
        val lines = t.split("\n")
        t = lines.filterIndexed { i, l ->
            if (!Js.test(IS_HEAD, l)) return@filterIndexed true
            for (j in i + 1 until lines.size) { if (Js.test(IS_HEAD, lines[j])) return@filterIndexed false; if (Js.trim(lines[j]).isNotEmpty()) return@filterIndexed true }
            false
        }.joinToString("\n")
        return Js.replace(Js.re("\\n{3,}", "g"), t, true, "\n\n")
    }
}
