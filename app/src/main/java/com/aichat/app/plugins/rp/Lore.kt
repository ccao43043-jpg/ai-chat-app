package com.aichat.app.plugins.rp

import com.aichat.app.plugins.js.*

/** www/rpcache.js 的世界书文本格式（canonicalize / parseLoreAttrs / parseLore / loreToText）；charcard 与 rpcache 共用 */
object Lore {
    fun canonicalize(text: Any?): String {
        var s = if (text == null) "" else Js.str(text)
        if (s.startsWith("\uFEFF")) s = s.substring(1)
        s = Js.replace(Js.re("\\r\\n?", "g"), s, true, "\n")
        s = Js.replace(Js.re("[ \\t\\u00A0]+$", "gm"), s, true, "")
        s = Js.replace(Js.re("\\n{5,}", "g"), s, true, "\n\n\n")
        s = s.trimStart('\n').trimEnd('\n')
        return s
    }
    val LORE_DEFAULT_ATTRS: JObj get() = jobj("secondaryKeys" to ArrayList<Any?>(), "secondaryLogic" to "AND_ANY", "probability" to 100, "priority" to 100, "order" to 100,
        "scanDepth" to null, "caseSensitive" to false, "matchWholeWords" to false, "useRegex" to false, "sticky" to 0, "cooldown" to 0, "delay" to 0, "inclusionGroup" to "")
    private fun pi(v: String): Double = Js.parseInt(v).let { if (it.isNaN() || it == 0.0) 0.0 else it }   // parseInt(v,10) || 0
    fun parseLoreAttrs(raw: Any?): JObj {
        val a = LORE_DEFAULT_ATTRS
        Js.split(Js.re("[;；]"), if (Js.truthy(raw)) Js.str(raw) else "").map { Js.trim(it) }.filter { it.isNotEmpty() }.forEach { pair ->
            val eq = pair.indexOf('=')
            val k = Js.trim(if (eq < 0) pair else pair.substring(0, eq)).lowercase(java.util.Locale.ROOT)
            val v = Js.trim(if (eq < 0) "1" else pair.substring(eq + 1))
            when (k) {
                "priority", "prio" -> a["priority"] = pi(v)
                "order" -> a["order"] = pi(v)
                "prob", "probability" -> a["probability"] = maxOf(0.0, minOf(100.0, Js.parseFloat(v).let { if (it.isNaN()) 0.0 else it }))
                "depth", "scandepth" -> a["scanDepth"] = maxOf(1.0, Js.parseInt(v).let { if (it.isNaN() || it == 0.0) 1.0 else it })
                "sec", "secondary", "secondarykeys" -> a["secondaryKeys"] = Js.split(Js.re("[,，、]"), v).map { Js.trim(it) }.filter { it.isNotEmpty() }.toMutableList<Any?>()
                "seclogic", "logic" -> { val m = v.uppercase(java.util.Locale.ROOT); a["secondaryLogic"] = if (m in listOf("AND_ANY", "AND_ALL", "NOT_ANY", "NOT_ALL")) m else "AND_ANY" }
                "regex" -> a["useRegex"] = v != "0" && v != "false"
                "case", "casesensitive" -> a["caseSensitive"] = v != "0" && v != "false"
                "whole", "wholeword" -> a["matchWholeWords"] = v != "0" && v != "false"
                "sticky" -> a["sticky"] = maxOf(0.0, pi(v))
                "cooldown" -> a["cooldown"] = maxOf(0.0, pi(v))
                "delay" -> a["delay"] = maxOf(0.0, pi(v))
                "group", "inclusiongroup" -> a["inclusionGroup"] = v
            }
        }
        return a
    }
    fun parseLore(text: Any?): JArr {
        class E(val name: String, val keysRaw: String, val lines: MutableList<String> = ArrayList())
        val out = ArrayList<E>(); var cur: E? = null
        val head = Js.re("^##\\s*(.+?)\\s*(?:\\|\\s*(.*))?$")
        Js.replace(Js.re("\\r\\n?", "g"), if (Js.truthy(text)) Js.str(text) else "", true, "\n").split("\n").forEach { line ->
            val m = Js.match(head, line)
            if (m != null) { cur = E(Js.trim(m[1]!!), Js.trim(m[2] ?: "")); out += cur!! } else cur?.lines?.add(line)
        }
        val res: JArr = ArrayList()
        out.forEachIndexed { idx, e ->
            var keysPart = e.keysRaw; var attrsPart = ""
            val pipe = e.keysRaw.indexOf('|')
            if (pipe >= 0) { keysPart = Js.trim(e.keysRaw.substring(0, pipe)); attrsPart = Js.trim(e.keysRaw.substring(pipe + 1)) }
            val constant = keysPart == "*" || keysPart == ""
            val keys: JArr = if (constant) ArrayList() else Js.split(Js.re("[,，、]"), keysPart).map { Js.trim(it) }.filter { it.isNotEmpty() }.toMutableList()
            val content = canonicalize(e.lines.joinToString("\n"))
            val attrs = parseLoreAttrs(attrsPart)
            val o = jobj("id" to Js.sha256(e.name + "\u0000" + keysPart).substring(0, 12), "name" to e.name, "mode" to if (constant) "constant" else "trigger", "keys" to keys, "content" to content)
            o.putAll(attrs); o["order"] = if (attrs["order"].d() != 100.0) attrs["order"] else idx.toDouble()
            if (content.isNotEmpty()) res += o
        }
        return res
    }
    fun loreToText(list: List<Any?>?): String = (list ?: emptyList()).joinToString("\n\n") { e ->
        var head = "## " + Js.strOrEmptyUndef(e as Map<*, *>, "name") + " | " + (if (e["mode"] == "constant") "*" else (e["keys"] as? List<*> ?: emptyList<Any?>()).joinToString(", ") { Js.strOrEmpty(it) })
        val attrs = ArrayList<String>()
        if (e["priority"] != null && e["priority"] != 100.0) attrs += "priority=" + Js.str(e["priority"])
        if (e["order"] != null && e["order"] != 100.0) attrs += "order=" + Js.str(e["order"])
        if (e["probability"] != null && e["probability"] != 100.0) attrs += "prob=" + Js.str(e["probability"])
        if (e["scanDepth"] != null) attrs += "depth=" + Js.str(e["scanDepth"])
        val sk = e["secondaryKeys"] as? List<*>
        if (sk != null && sk.isNotEmpty()) { attrs += "sec=" + sk.joinToString(",") { Js.strOrEmpty(it) }; if (Js.truthy(e["secondaryLogic"]) && e["secondaryLogic"] != "AND_ANY") attrs += "secLogic=" + Js.str(e["secondaryLogic"]) }
        if (Js.truthy(e["useRegex"])) attrs += "regex=1"
        if (Js.truthy(e["caseSensitive"])) attrs += "case=1"
        if (Js.truthy(e["matchWholeWords"])) attrs += "whole=1"
        if (Js.truthy(e["sticky"])) attrs += "sticky=" + Js.str(e["sticky"])
        if (Js.truthy(e["cooldown"])) attrs += "cooldown=" + Js.str(e["cooldown"])
        if (Js.truthy(e["delay"])) attrs += "delay=" + Js.str(e["delay"])
        if (Js.truthy(e["inclusionGroup"])) attrs += "group=" + Js.str(e["inclusionGroup"])
        if (attrs.isNotEmpty()) head += " | " + attrs.joinToString(";")
        head + "\n" + Js.strOrEmptyUndef(e, "content")
    }
}
