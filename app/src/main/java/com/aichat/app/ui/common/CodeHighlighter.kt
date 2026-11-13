package com.aichat.app.ui.common

/**
 * 极简代码高亮（纯 Kotlin，可单测）：关键字 / 字符串 / 注释 / 数字 / 注解。
 * 不追求语法精确（旧版用 highlight.js 自动识别）；按语言族选择注释符号和关键字表，未知语言用通用表。
 */
enum class TokKind { Keyword, Str, Comment, Number, Annotation, Plain }
data class CodeToken(val start: Int, val end: Int, val kind: TokKind)

object CodeHighlighter {
    private val C_LIKE = setOf(
        "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "data", "def", "default",
        "defer", "delete", "do", "else", "enum", "export", "extends", "extern", "false", "final", "finally", "fn", "for",
        "fun", "func", "function", "go", "goto", "if", "impl", "implements", "import", "in", "inline", "interface", "is",
        "let", "match", "mod", "module", "mut", "namespace", "new", "nil", "null", "object", "open", "operator", "override",
        "package", "private", "protected", "pub", "public", "return", "sealed", "self", "static", "struct", "super",
        "switch", "this", "throw", "throws", "trait", "true", "try", "type", "typeof", "undefined", "union", "unsafe",
        "use", "using", "val", "var", "void", "volatile", "when", "where", "while", "yield", "int", "long", "float",
        "double", "char", "bool", "boolean", "string", "String", "Int", "Long", "Unit", "Boolean", "suspend", "lateinit",
        "companion", "internal", "instanceof", "of", "from", "with", "chan", "select", "range", "map",
    )
    private val PY = setOf(
        "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except",
        "False", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "None", "nonlocal", "not",
        "or", "pass", "raise", "return", "True", "try", "while", "with", "yield", "self", "print",
    )
    private val SH = setOf("if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "case", "esac", "function",
        "return", "export", "local", "echo", "cd", "sudo", "set", "unset", "source", "exit")
    private val SQL = setOf("select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table",
        "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "and",
        "or", "not", "null", "as", "distinct", "union", "primary", "key", "index", "is", "in", "like", "count", "sum")

    private enum class Fam { C, PY, SH, SQL, DATA }

    private fun family(lang: String): Fam = when (lang.lowercase()) {
        "py", "python", "python3" -> Fam.PY
        "sh", "bash", "zsh", "shell", "console", "yaml", "yml", "toml", "ini", "conf", "dockerfile", "makefile", "ruby", "rb", "r" -> Fam.SH
        "sql", "mysql", "postgres", "sqlite", "psql" -> Fam.SQL
        "json", "jsonc" -> Fam.DATA
        else -> Fam.C
    }

    fun tokenize(code: String, lang: String): List<CodeToken> {
        val fam = family(lang)
        val kw = when (fam) { Fam.PY -> PY; Fam.SH -> SH; Fam.SQL -> SQL; Fam.DATA -> setOf("true", "false", "null"); Fam.C -> C_LIKE }
        val hashComment = fam == Fam.PY || fam == Fam.SH
        val out = ArrayList<CodeToken>()
        var i = 0; val n = code.length
        while (i < n) {
            val c = code[i]
            // 注释
            if (fam != Fam.DATA && !hashComment && c == '/' && i + 1 < n && code[i + 1] == '/' ||
                hashComment && c == '#' || fam == Fam.SQL && c == '-' && i + 1 < n && code[i + 1] == '-') {
                val e = code.indexOf('\n', i).let { if (it < 0) n else it }
                out += CodeToken(i, e, TokKind.Comment); i = e; continue
            }
            if (fam != Fam.PY && fam != Fam.SH && c == '/' && i + 1 < n && code[i + 1] == '*') {
                val e = code.indexOf("*/", i + 2).let { if (it < 0) n else it + 2 }
                out += CodeToken(i, e, TokKind.Comment); i = e; continue
            }
            // 字符串（含 Python 三引号）
            if (c == '"' || c == '\'' || c == '`') {
                if (fam == Fam.PY && code.startsWith("$c$c$c", i)) {
                    val e = code.indexOf("$c$c$c", i + 3).let { if (it < 0) n else it + 3 }
                    out += CodeToken(i, e, TokKind.Str); i = e; continue
                }
                var j = i + 1
                while (j < n && code[j] != c) { if (code[j] == '\\') j++; if (c != '`' && j < n && code[j] == '\n') break; j++ }
                val e = (j + 1).coerceAtMost(n)
                out += CodeToken(i, e, TokKind.Str); i = e; continue
            }
            if (c.isDigit() && (i == 0 || !(code[i - 1].isLetterOrDigit() || code[i - 1] == '_'))) {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '.' || code[j] == '_')) j++
                out += CodeToken(i, j, TokKind.Number); i = j; continue
            }
            if (c == '@' && fam != Fam.DATA && i + 1 < n && code[i + 1].isLetter()) {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || code[j] == '.')) j++
                out += CodeToken(i, j, TokKind.Annotation); i = j; continue
            }
            if (c.isLetter() || c == '_' || c == '$') {
                var j = i + 1
                while (j < n && (code[j].isLetterOrDigit() || code[j] == '_' || code[j] == '$')) j++
                val w = code.substring(i, j)
                if (w in kw || fam == Fam.SQL && w.lowercase() in kw) out += CodeToken(i, j, TokKind.Keyword)
                i = j; continue
            }
            i++
        }
        return out
    }
}
