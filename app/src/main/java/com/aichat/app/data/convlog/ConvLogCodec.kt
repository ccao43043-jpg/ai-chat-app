package com.aichat.app.data.convlog

import com.aichat.app.data.store.FileStore
import kotlinx.serialization.json.JsonObject

/**
 * conv-log.js（oplog-v1）的 Kotlin 版契约（C 实现，golden 测试对 JS 逐条比对）。
 * 文件：conv_<id>.json（旧全文 或 {format:"oplog-v1",…} 元数据指针）、conv_<id>.snap.json（快照）、conv_<id>.log.jsonl（追加 op）。
 * op 行：{"lamport":N,"dev":"<device-id>","op":"msg.add|msg.edit|msg.remove|msg.delete|msg.reorder|chapter.commit|chapter.edit|
 *        chapter.remove|affect.set|affect.by|ledger.append|worldRef.set|worldLog.append|meta.set|kb.upsert","payload":{…}}
 * 冲突：按 (lamport, dev) 比较，后写覆盖；被覆盖值进 _conflicts。章节 contentZ = base64(zlib(content))（fflate 兼容，java.util.zip.Inflater 可解）。
 * 压缩：日志 ≥200 op 或 ≥1 MiB 时写新快照并清空日志（COMPACT_OPS / COMPACT_BYTES）。
 */
interface ConvLogCodec {
    fun listConvIds(store: FileStore): List<String>
    /** 返回与 ConvLog.load(store,id) 的 toConv(state) 同构的 JSON（golden 比对单位） */
    fun load(store: FileStore, id: String): JsonObject?
    fun loadMeta(store: FileStore, id: String): JsonObject?
    /** diff(prev,next) → 追加 op；必要时压缩。prev 来自内存会话缓存，缺失时从磁盘 load */
    fun commit(store: FileStore, conv: JsonObject)
    fun removeFiles(store: FileStore, id: String)
    fun deviceId(store: FileStore): String            // device-id.json
}
