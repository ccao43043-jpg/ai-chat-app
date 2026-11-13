package com.aichat.app.plugins.rp

import com.aichat.app.plugins.js.*
import java.io.ByteArrayOutputStream
import java.util.zip.Inflater

/**
 * www/charcard.js 移植：SillyTavern Character Card V2/V3（PNG tEXt / zTXt "chara"）导入导出，persona 与世界书文本映射。
 * 行为取 App（WebView）路径：base64 用 atob + TextDecoder、zTXt 用 window.fflate（Node 分支的 Buffer / zlib 不适用）。
 * persona / card 沿用 JS 值模型；personaToCard 的世界书解析同 App（rpcache 已加载 → RPCache.parseLore = [Lore.parseLore]）。
 */
object CharCard {
    const val SPEC = "chara_card_v2"; const val SPEC_VERSION = "2.0"
    private val CRC = IntArray(256) { n -> var c = n; repeat(8) { c = if (c and 1 != 0) (0xedb88320.toInt() xor (c ushr 1)) else (c ushr 1) }; c }
    fun crc32(b: ByteArray, from: Int = 0, to: Int = b.size): Int { var c = -1; for (i in from until to) c = CRC[(c xor b[i].toInt()) and 0xff] xor (c ushr 8); return c.inv() }
    private val SIG = byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10)
    private fun be32(n: Int) = byteArrayOf((n ushr 24).toByte(), (n ushr 16).toByte(), (n ushr 8).toByte(), n.toByte())
    private fun readBe32(b: ByteArray, i: Int): Long = ((b[i].toLong() and 0xff) shl 24) or ((b[i + 1].toLong() and 0xff) shl 16) or ((b[i + 2].toLong() and 0xff) shl 8) or (b[i + 3].toLong() and 0xff)

    /** TextDecoder('utf-8').decode / Buffer#toString('utf8')：WHATWG 解码（每个最大非法子序列 → 一个 U+FFFD），stripBom 时去掉开头 BOM */
    fun bytesToStr(b: ByteArray, from: Int = 0, to: Int = b.size, stripBom: Boolean = true): String {
        val sb = StringBuilder(to - from); var i = from
        while (i < to) {
            val c = b[i].toInt() and 0xff
            if (c < 0x80) { sb.append(c.toChar()); i++; continue }
            val need: Int; var lo = 0x80; var hi = 0xbf; var cp: Int
            when (c) {
                in 0xc2..0xdf -> { need = 1; cp = c and 0x1f }
                in 0xe0..0xef -> { need = 2; cp = c and 0x0f; if (c == 0xe0) lo = 0xa0; if (c == 0xed) hi = 0x9f }
                in 0xf0..0xf4 -> { need = 3; cp = c and 0x07; if (c == 0xf0) lo = 0x90; if (c == 0xf4) hi = 0x8f }
                else -> { sb.append('\uFFFD'); i++; continue }
            }
            var j = i + 1; var ok = true
            for (k in 0 until need) {
                if (j >= to) { ok = false; break }
                val x = b[j].toInt() and 0xff
                if (x < lo || x > hi) { ok = false; break }
                cp = (cp shl 6) or (x and 0x3f); lo = 0x80; hi = 0xbf; j++
            }
            if (!ok) { sb.append('\uFFFD'); i = j; continue }
            sb.appendCodePoint(cp); i = j
        }
        val s = sb.toString()
        return if (stripBom && s.startsWith("\uFEFF")) s.substring(1) else s
    }
    fun b64encode(str: String): String = java.util.Base64.getEncoder().encodeToString(Js.utf8(str))
    /** atob 抛出的 DOMException（InvalidCharacterError），文案同 Chromium WebView */
    class AtobError : JsError("Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.")
    /** fflate.unzlibSync 的解压错误（unexpected EOF / invalid block type …；文案随库版本而异） */
    class InflateError(msg: String) : JsError(msg)

    /** App（WebView）路径：atob(String(b64).replace(/\s+/g, '')) → 字节 → TextDecoder（WHATWG forgiving-base64，非法即抛 [AtobError]，去 BOM） */
    fun b64decode(b64: Any?): String {
        var t = Js.replace(Js.re("\\s+", "g"), Js.str(b64), true, "")
        if (t.length % 4 == 0) { if (t.endsWith("==")) t = t.dropLast(2) else if (t.endsWith("=")) t = t.dropLast(1) }
        if (t.length % 4 == 1) throw AtobError()
        val out = ByteArrayOutputStream(); var acc = 0; var n = 0
        for (c in t) {
            val v = when (c) { in 'A'..'Z' -> c - 'A'; in 'a'..'z' -> c - 'a' + 26; in '0'..'9' -> c - '0' + 52; '+' -> 62; '/' -> 63; else -> throw AtobError() }
            acc = (acc shl 6) or v; n++
            if (n == 4) { out.write(acc shr 16); out.write((acc shr 8) and 0xff); out.write(acc and 0xff); acc = 0; n = 0 }
        }
        if (n == 2) out.write((acc shr 4) and 0xff) else if (n == 3) { out.write((acc shr 10) and 0xff); out.write((acc shr 2) and 0xff) }
        return bytesToStr(out.toByteArray())
    }
    /** fflate.unzlibSync：校验 zlib 头（不支持预置字典），去掉头 2 字节与末尾 4 字节（不校验 Adler-32），raw inflate */
    fun unzlib(d: ByteArray, from: Int): ByteArray {
        val len = d.size - from
        val b0 = if (len > 0) d[from].toInt() and 0xff else -1; val b1 = if (len > 1) d[from + 1].toInt() and 0xff else -1
        if (b0 < 0 || (b0 and 15) != 8 || (b0 shr 4) > 7 || ((b0 shl 8) or (b1 and 0xff)) % 31 != 0 || b1 < 0) throw InflateError("invalid zlib data")
        if ((b1 shr 5) and 1 == 1) throw InflateError("invalid zlib data: need dictionary")
        val s = from + 2; val e = d.size - 4
        if (e <= s) return ByteArray(0)
        val inf = Inflater(true); inf.setInput(d, s, e - s)
        val o = ByteArrayOutputStream(); val buf = ByteArray(8192)
        try {
            while (!inf.finished()) { val k = inf.inflate(buf); if (k == 0 && (inf.needsInput() || inf.needsDictionary())) throw InflateError("unexpected EOF"); o.write(buf, 0, k) }
        } catch (x: java.util.zip.DataFormatException) { throw InflateError("invalid block type") } finally { inf.end() }
        return o.toByteArray()
    }
    fun isPng(b: ByteArray): Boolean = b.size >= 8 && (0 until 8).all { b[it] == SIG[it] }

    class Chunk(val type: String, val data: ByteArray, val offset: Int, val length: Long)
    fun listChunks(b: ByteArray): List<Chunk> {
        if (!isPng(b)) throw JsError("不是有效的 PNG 文件")
        val out = ArrayList<Chunk>(); var i = 8L
        while (i + 12 <= b.size) {
            val ii = i.toInt(); val len = readBe32(b, ii)
            val type = String(charArrayOf((b[ii + 4].toInt() and 0xff).toChar(), (b[ii + 5].toInt() and 0xff).toChar(), (b[ii + 6].toInt() and 0xff).toChar(), (b[ii + 7].toInt() and 0xff).toChar()))
            val s = minOf(ii + 8L, b.size.toLong()).toInt(); val e = minOf(ii + 8L + len, b.size.toLong()).toInt()
            out += Chunk(type, b.copyOfRange(s, maxOf(s, e)), ii, len)
            i += 12 + len
            if (type == "IEND") break
        }
        return out
    }
    fun extractCharaRaw(b: ByteArray): String? {
        for (ch in listChunks(b)) {
            if (ch.type != "tEXt" && ch.type != "zTXt") continue
            val d = ch.data; val nul = d.indexOf(0.toByte()); if (nul < 0) continue
            if (bytesToStr(d, 0, nul) != "chara") continue
            if (ch.type == "tEXt") return bytesToStr(d, nul + 1, d.size)
            val method = if (nul + 1 < d.size) d[nul + 1].toInt() and 0xff else -1
            if (method != 0) throw JsError("不支持的 zTXt 压缩方式")
            return bytesToStr(unzlib(d, nul + 2))
        }
        return null
    }

    fun parseCardObject(obj: Any?): JObj {
        if (obj !is Map<*, *> && obj !is List<*>) throw JsError("角色卡 JSON 无效")
        val spec = obj["spec"]
        if (spec == SPEC || spec == "chara_card_v3" || obj["data"] is Map<*, *> || obj["data"] is List<*>)
            return jobj("spec" to Js.or(spec, SPEC), "spec_version" to Js.or(obj["spec_version"], SPEC_VERSION), "data" to Js.or(obj["data"], JObj()))
        if (Js.truthy(obj["name"]) || Js.truthy(obj["description"]) || Js.truthy(obj["personality"])) return jobj("spec" to SPEC, "spec_version" to SPEC_VERSION, "data" to obj)
        throw JsError("无法识别的角色卡结构")
    }
    /** input：ByteArray（PNG / UTF-8 JSON）、String（JSON 或 base64）、或已解析的对象 */
    fun parseCard(input: Any?): JObj {
        if (input == null) throw JsError("空输入")
        if (input is Map<*, *> || input is List<*>) return parseCardObject(input)
        if (input is String) {
            val t = Js.trim(input)
            if (t.startsWith("{")) return parseCardObject(JsJson.parse(t))
            try { return parseCardObject(JsJson.parse(b64decode(t))) } catch (_: Exception) { throw JsError("无法解析角色卡文本") }
        }
        val bytes = input as? ByteArray ?: throw JsError("无法识别的角色卡文件")
        if (isPng(bytes)) {
            val raw = extractCharaRaw(bytes)
            if (!Js.truthy(raw)) throw JsError("PNG 中没有 tEXt/zTXt chara 块（不是 Character Card）")
            return parseCardObject(JsJson.parse(b64decode(raw)))
        }
        try { return parseCardObject(JsJson.parse(bytesToStr(bytes))) } catch (_: Exception) {}
        throw JsError("无法识别的角色卡文件")
    }

    private fun i32s(v: Any?) = Js.numToString(Js.i32(v).toDouble())
    private fun concatArr(v: Any?): List<Any?> = if (v is List<*>) v else if (v == null) emptyList() else listOf(v)
    fun bookToLoreText(book: Any?): String {
        if (!Js.truthy(book)) return ""
        val entries = if (book is List<*>) book else (Js.or(book["entries"], ArrayList<Any?>()) as? List<*> ?: emptyList<Any?>())
        val lines = ArrayList<String>()
        entries.forEachIndexed { i, e ->
            if (!Js.truthy(e) || e["enabled"] == false) return@forEachIndexed
            val dflt = "条目" + (i + 1)
            val name = Js.trim(Js.str(Js.or(Js.or(e["comment"], e["name"]), dflt))).ifEmpty { dflt }
            val content = Js.trim(Js.replace(Js.re("\\r\\n?", "g"), Js.str(Js.or(e["content"], "")), true, "\n"))
            if (content.isEmpty()) return@forEachIndexed
            val constant = Js.truthy(e["constant"]) || Js.truthy(e["forceConstant"])
            val keys = concatArr(Js.or(Js.or(e["key"], e["keys"]), ArrayList<Any?>())).map { Js.trim(Js.str(it)) }.filter { it.isNotEmpty() }
            val sec = concatArr(Js.or(Js.or(Js.or(e["keysecondary"], e["secondary_keys"]), e["secondaryKeys"]), ArrayList<Any?>())).map { Js.trim(Js.str(it)) }.filter { it.isNotEmpty() }
            val attrs = ArrayList<String>()
            if (e["priority"] != null) attrs += "priority=" + i32s(e["priority"])
            if (e["order"] != null) attrs += "order=" + i32s(e["order"])
            if (e["probability"] != null && e["probability"] != 100.0) attrs += "prob=" + Js.numToString(Js.toNumber(e["probability"]))
            if (e["scanDepth"] != null || e["scan_depth"] != null) attrs += "depth=" + i32s(if (e["scanDepth"] != null) e["scanDepth"] else e["scan_depth"])
            if (sec.isNotEmpty()) {
                attrs += "sec=" + sec.joinToString(",")
                val logic = if (e["selectiveLogic"] != null) e["selectiveLogic"] else Js.or(e["secondaryLogic"], e["secondary_logic"])
                val map = mapOf("0" to "AND_ANY", "1" to "NOT_ALL", "2" to "NOT_ANY", "3" to "AND_ALL", "AND_ANY" to "AND_ANY", "AND_ALL" to "AND_ALL", "NOT_ANY" to "NOT_ANY", "NOT_ALL" to "NOT_ALL")
                if (logic != null) map[Js.str(logic)]?.let { attrs += "secLogic=$it" }
            }
            if (Js.truthy(e["sticky"])) attrs += "sticky=" + i32s(e["sticky"])
            if (Js.truthy(e["cooldown"])) attrs += "cooldown=" + i32s(e["cooldown"])
            if (Js.truthy(e["delay"])) attrs += "delay=" + i32s(e["delay"])
            if (Js.truthy(e["useRegex"]) || Js.truthy(e["regex"])) attrs += "regex=1"
            if (Js.truthy(e["caseSensitive"])) attrs += "case=1"
            if (Js.truthy(e["matchWholeWords"]) || Js.truthy(e["wholeWord"])) attrs += "whole=1"
            var head = if (constant || (keys.isEmpty() && !Js.truthy(e["keys"]))) "## $name | *" else "## $name | " + keys.joinToString(", ")
            if (attrs.isNotEmpty()) head += " | " + attrs.joinToString(";")
            lines += head + "\n" + content
        }
        return lines.joinToString("\n\n")
    }

    fun loreEntriesToBook(entries: List<Any?>?, meta: Any?): JObj {
        val list = (entries ?: emptyList()).mapIndexedTo(ArrayList<Any?>()) { i, e ->
            val sk = e["secondaryKeys"] as? List<*>
            val out = jobj("keys" to if (e["mode"] == "constant") ArrayList<Any?>() else ((e["keys"] as? List<*>)?.toMutableList() ?: ArrayList()),
                "content" to Js.or(e["content"], ""), "extensions" to JObj(), "enabled" to true, "insertion_order" to if (e["order"] != null) e["order"] else i.toDouble(),
                "case_sensitive" to Js.truthy(e["caseSensitive"]), "name" to Js.or(e["name"], ""), "priority" to if (e["priority"] != null) e["priority"] else 100.0, "id" to i,
                "comment" to Js.or(e["name"], ""), "selective" to (sk != null && sk.isNotEmpty()), "secondary_keys" to (sk?.toMutableList() ?: ArrayList<Any?>()),
                "constant" to (e["mode"] == "constant"), "position" to "before_char", "probability" to if (e["probability"] != null) e["probability"] else 100.0)
            if (Js.truthy(e["secondaryLogic"])) out["selectiveLogic"] = mapOf("AND_ANY" to 0.0, "NOT_ALL" to 1.0, "NOT_ANY" to 2.0, "AND_ALL" to 3.0)[Js.str(e["secondaryLogic"])] ?: 0.0
            if (Js.truthy(e["useRegex"])) out["useRegex"] = true
            if (e["scanDepth"] != null) out["scanDepth"] = e["scanDepth"]
            if (Js.truthy(e["sticky"])) out["sticky"] = e["sticky"]
            if (Js.truthy(e["cooldown"])) out["cooldown"] = e["cooldown"]
            if (Js.truthy(e["delay"])) out["delay"] = e["delay"]
            out
        }
        val o = jobj("name" to Js.or(meta?.let { it["name"] }, ""), "entries" to list)
        @Suppress("UNCHECKED_CAST") (meta as? Map<String, Any?>)?.let { o.putAll(it) }
        return o
    }

    private fun tr(v: Any?) = Js.trim(Js.str(v))
    fun cardToPersona(card: Any?, opts: Any? = null): JObj {
        val c = Js.or(parseCardObject(card)["data"], JObj())
        val name = Js.trim(Js.str(Js.or(c["name"], "未命名角色"))).ifEmpty { "未命名角色" }
        val desc = Js.slice(Js.trim(Js.str(Js.or(Js.or(c["creator_notes"], c["description"]), ""))), 0, 120)
        val blocks = ArrayList<String>()
        listOf("description" to "【角色描述】", "personality" to "【性格】", "scenario" to "【场景】", "mes_example" to "【对话示例】", "system_prompt" to "【系统提示】", "post_history_instructions" to "【历史后指令】")
            .forEach { (k, t) -> if (Js.truthy(c[k])) blocks += t + "\n" + tr(c[k]) }
        var systemPrompt = blocks.filter { it.isNotEmpty() }.joinToString("\n\n")
        if (systemPrompt.isEmpty() && Js.truthy(c["first_mes"])) systemPrompt = "你将扮演「$name」。保持角色一致。"
        val loreText = bookToLoreText(c["character_book"])
        val emoji = Js.or(opts?.let { it["emoji"] }, "🎭")
        val ag = c["alternate_greetings"]
        return jobj("emoji" to emoji, "name" to name, "desc" to desc.ifEmpty { Js.slice(Js.trim(Js.str(Js.or(c["description"], ""))), 0, 80) },
            "systemPrompt" to systemPrompt.ifEmpty { "你将扮演「$name」。" }, "loreText" to loreText, "firstMes" to Js.trim(Js.str(Js.or(c["first_mes"], ""))),
            "alternateGreetings" to if (ag is List<*>) ag.mapTo(ArrayList<Any?>()) { Js.str(it) } else ArrayList<Any?>(), "mesExample" to Js.trim(Js.str(Js.or(c["mes_example"], ""))),
            "cardSpec" to SPEC, "cardRaw" to c, "temperature" to "", "builtin" to false)
    }

    fun personaToCard(persona: Any?, loreEntries: List<Any?>? = null): JObj {
        val p = persona ?: JObj(); val raw = Js.or(p["cardRaw"], JObj())
        val loreText = Js.or(p["loreText"], "")
        val entries: List<Any?>? = loreEntries ?: if (Js.truthy(loreText)) Lore.parseLore(loreText) else null
        val ext = JObj(); @Suppress("UNCHECKED_CAST") (Js.or(raw["extensions"], JObj()) as? Map<String, Any?>)?.let { ext.putAll(it) }; ext["aichat_system_prompt"] = Js.or(p["systemPrompt"], "")
        val data = jobj("name" to Js.or(Js.or(p["name"], raw["name"]), "未命名"), "description" to Js.or(Js.or(raw["description"], p["desc"]), ""), "personality" to Js.or(raw["personality"], ""),
            "scenario" to Js.or(raw["scenario"], ""), "first_mes" to Js.or(Js.or(p["firstMes"], raw["first_mes"]), ""), "mes_example" to Js.or(Js.or(p["mesExample"], raw["mes_example"]), ""),
            "creator_notes" to Js.or(Js.or(raw["creator_notes"], p["desc"]), ""), "system_prompt" to Js.or(raw["system_prompt"], ""), "post_history_instructions" to Js.or(raw["post_history_instructions"], ""),
            "alternate_greetings" to Js.or(Js.or(p["alternateGreetings"], raw["alternate_greetings"]), ArrayList<Any?>()), "tags" to Js.or(raw["tags"], ArrayList<Any?>()),
            "creator" to Js.or(raw["creator"], ""), "character_version" to Js.or(raw["character_version"], ""), "extensions" to ext,
            "character_book" to loreEntriesToBook(entries ?: emptyList(), jobj("name" to Js.str(Js.or(p["name"], "")) + " lore")))
        if (!Js.truthy(data["description"]) && Js.truthy(p["systemPrompt"])) data["description"] = p["systemPrompt"]
        if (!Js.truthy(data["system_prompt"]) && Js.truthy(p["systemPrompt"]) && data["description"] != p["systemPrompt"]) data["system_prompt"] = p["systemPrompt"]
        return jobj("spec" to SPEC, "spec_version" to SPEC_VERSION, "data" to data)
    }

    private fun makeChunk(type: String, data: ByteArray): ByteArray {
        val body = type.toByteArray(Charsets.ISO_8859_1) + data
        return be32(data.size) + body + be32(crc32(body))
    }
    fun minimalPng(): ByteArray {
        val hex = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
        return ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    }
    fun writeCardToPng(card: Any?, basePng: ByteArray? = null): ByteArray {
        val obj = if (Js.truthy(card["spec"])) card else jobj("spec" to SPEC, "spec_version" to SPEC_VERSION, "data" to card)
        val payload = b64encode(Js.stringify(obj)).toByteArray(Charsets.ISO_8859_1)
        val chara = makeChunk("tEXt", "chara".toByteArray(Charsets.ISO_8859_1) + byteArrayOf(0) + payload)
        val base = basePng ?: minimalPng()
        if (!isPng(base)) throw JsError("底图不是 PNG")
        val out = ByteArrayOutputStream(); out.write(SIG)
        for (ch in listChunks(base)) {
            if (ch.type == "tEXt" || ch.type == "zTXt") { val nul = ch.data.indexOf(0.toByte()); if ((if (nul >= 0) bytesToStr(ch.data, 0, nul) else "") == "chara") continue }
            if (ch.type == "IEND") continue
            val e = minOf(ch.offset + 12L + ch.length, base.size.toLong()).toInt(); out.write(base, ch.offset, e - ch.offset)
        }
        out.write(chara); out.write(makeChunk("IEND", ByteArray(0)))
        return out.toByteArray()
    }
}
