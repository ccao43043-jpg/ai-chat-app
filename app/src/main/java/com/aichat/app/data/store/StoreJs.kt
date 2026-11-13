package com.aichat.app.data.store

import com.aichat.app.data.json.Js
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * app.js 里 `Store` 对象（经 AndroidBridge）的逐行移植，供移植过来的 JS 逻辑（ConvLog 等）调用。
 *  - get：解析失败时把坏文件改名为 `name.corrupt-<ts>`（Secure.corruptName），再尝试用 `name.bak` 恢复并写回
 *  - set：JSON.stringify 后整文件写（FileStore.set 负责 .tmp/.bak）
 *  - append：一行 JSON + '\n'
 *  - readJsonl / writeJsonl：Secure.parseJsonl（逐行 trim、跳过坏行）/ Secure.toJsonl
 */
class StoreJs(val fs: FileStore, private val now: () -> Long = System::currentTimeMillis) {
    /** 读取时发现的损坏文件（{name, restored, corrupt}），迁移报告用 */
    val issues: MutableList<Triple<String, String, String>> = java.util.Collections.synchronizedList(ArrayList())

    fun raw(name: String): String? = fs.get(name)
    fun rawSet(name: String, s: String): Boolean = fs.set(name, s)
    fun exists(name: String): Boolean = fs.exists(name)
    fun del(name: String) = fs.delete(name)
    fun list(): List<String> = fs.list()
    fun rename(from: String, to: String) = fs.rename(from, to)

    /** 返回 Js 值；不存在返回 [def]；损坏时按旧规则留底 + .bak 恢复 */
    fun get(name: String, def: Any? = null): Any? {
        val v = try { raw(name) } catch (e: Exception) { return def } ?: return def
        return try { Js.parse(v) } catch (e: Js.ParseError) {
            val corrupt = name + ".corrupt-" + now()
            try { rename(name, corrupt) } catch (_: Exception) {}
            var restored = ""; var value = def
            try {
                val b = raw("$name.bak")
                if (b != null) { value = Js.parse(b); restored = "bak"; rawSet(name, b) }
            } catch (_: Exception) { value = def; restored = "" }
            issues.add(Triple(name, restored, corrupt))
            value
        }
    }
    fun set(name: String, v: Any?): Boolean = rawSet(name, Js.stringify(v) ?: "undefined")
    fun append(name: String, v: Any?): Boolean = fs.append(name, (Js.stringify(v) ?: "undefined") + "\n")
    fun readJsonl(name: String): MutableList<Any?>? { val v = raw(name) ?: return null; return parseJsonl(v) }
    fun writeJsonl(name: String, items: List<Any?>): Boolean = rawSet(name, toJsonl(items))

    companion object {
        fun parseJsonl(text: String): MutableList<Any?> {
            val out = ArrayList<Any?>()
            text.split('\n').forEach { l0 ->
                val l = l0.trim(); if (l.isEmpty()) return@forEach
                try { out.add(Js.parse(l)) } catch (_: Js.ParseError) { }
            }
            return out
        }
        fun toJsonl(items: List<Any?>): String = items.joinToString("\n") { Js.stringify(it) ?: "null" } + (if (items.isNotEmpty()) "\n" else "")

        private val adapters = java.util.WeakHashMap<FileStore, StoreJs>()
        /** 同一个 FileStore 复用同一个适配器（ConvLog 的会话缓存按 store 对象区分） */
        @Synchronized fun of(fs: FileStore): StoreJs = adapters.getOrPut(fs) { StoreJs(fs) }
    }
}

/** 内存 FileStore（测试 / 预览 / 其它工作流的假实现）。语义与 JsonFileStore 一致（含 .bak）。 */
class MemFileStore(initial: Map<String, String> = emptyMap()) : FileStore {
    val files = ConcurrentHashMap<String, String>(initial)
    private fun n(name: String) = name.replace(Regex("[^A-Za-z0-9_.-]"), "_")
    override val dir: File get() = File("/dev/null/mem-store")
    override fun get(name: String): String? = files[n(name)]
    @Synchronized override fun set(name: String, value: String): Boolean {
        val k = n(name)
        val jsonl = k.endsWith(".jsonl") || k.endsWith(".bak")
        files[k]?.let { if (!jsonl) files["$k.bak"] = it }
        files[k] = value; return true
    }
    @Synchronized override fun append(name: String, text: String): Boolean { val k = n(name); files[k] = (files[k] ?: "") + text; return true }
    @Synchronized override fun delete(name: String) { val k = n(name); files.remove(k); files.remove("$k.bak") }
    override fun exists(name: String) = files.containsKey(n(name))
    @Synchronized override fun rename(from: String, to: String): Boolean { val v = files.remove(n(from)) ?: return false; files[n(to)] = v; return true }
    override fun list(): List<String> = files.keys.filterNot { it.endsWith(".tmp") }.sorted()
}
