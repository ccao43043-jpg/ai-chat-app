package com.aichat.app.data.convlog

import com.aichat.app.data.json.Js
import com.aichat.app.data.json.JsObj
import com.aichat.app.data.store.FileStore
import com.aichat.app.data.store.StoreJs
import kotlinx.serialization.json.JsonObject

/**
 * [ConvLogCodec] 的实现：薄包装 [JsConvLog]（conv-log.js 的逐行移植）。kotlinx JsonObject ↔ Js 值在边界转换；
 * 数字按 JS Number::toString 输出（JsonUnquotedLiteral），键顺序保持 JS 对象顺序。
 */
class ConvLogCodecImpl(val engine: JsConvLog = JsConvLog()) : ConvLogCodec {
    private fun s(store: FileStore) = StoreJs.of(store)

    override fun listConvIds(store: FileStore): List<String> = engine.listConvIds(s(store))
    override fun load(store: FileStore, id: String): JsonObject? = engine.load(s(store), id)?.let { Js.toJsonObject(it) }
    override fun loadMeta(store: FileStore, id: String): JsonObject? = engine.loadMeta(s(store), id)?.let { Js.toJsonObject(it) }
    override fun commit(store: FileStore, conv: JsonObject) { engine.commit(s(store), Js.fromJson(conv) as JsObj) }
    override fun removeFiles(store: FileStore, id: String) = engine.removeFiles(s(store), id)
    override fun deviceId(store: FileStore): String = Js.toStr(engine.ensureDev(s(store)))

    /** Js 值层面的入口（仓库内部用，省去 JsonElement 往返） */
    fun loadJs(store: FileStore, id: String): JsObj? = engine.load(s(store), id)
    fun commitJs(store: FileStore, conv: JsObj): JsObj = engine.commit(s(store), conv)
    fun exportLegacyJs(store: FileStore, id: String): JsObj? = engine.exportLegacy(s(store), id)
}
