package com.aichat.app.data.repo

import com.aichat.app.data.codec.ABSENT_KEY

import com.aichat.app.data.codec.*
import com.aichat.app.data.convlog.ConvLogCodecImpl
import com.aichat.app.data.json.Js
import com.aichat.app.data.json.JsObj
import com.aichat.app.data.secret.KeyVaultAdmin
import com.aichat.app.data.store.FileStore
import com.aichat.app.data.store.StoreJs
import com.aichat.app.domain.*
import com.aichat.app.domain.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*

/** 读一个 JSON 文件为 kotlinx 元素（损坏时按 app.js Store.get 规则留底 + .bak 恢复） */
internal fun StoreJs.json(name: String): JsonElement? = get(name, null)?.let { Js.toJson(it) }?.takeIf { it !is JsonNull }
internal fun StoreJs.putJson(name: String, e: JsonElement): Boolean = rawSet(name, Js.stringify(Js.fromJson(e)) ?: "null")

/** JS uid()：Date.now().toString(36) + 6 位 base36 随机 */
fun jsUid(now: Long = System.currentTimeMillis(), rnd: Double = Math.random()): String =
    java.lang.Long.toString(now, 36) + java.lang.Long.toString((rnd * 2176782336.0).toLong(), 36).padStart(6, '0').takeLast(6)

// ============================================================ settings.json
class FileSettingsRepository(private val fs: FileStore, private val keys: KeyVaultAdmin) : SettingsRepository {
    private val store = StoreJs.of(fs)
    private val mutex = Mutex()
    private val state = MutableStateFlow(read())
    override val settings: StateFlow<AppSettings> = state.asStateFlow()

    /** 启动读取：同 app.js —— 有文件就解码（缺键 = 默认值），并在内存里做 v0.8.4 autoChar 迁移（不立即写盘，同 JS） */
    private fun read(): AppSettings {
        val o = store.json(SETTINGS) as? JsonObject ?: return SettingsCodec.default()
        return SettingsMigrations.autoCharV084(SettingsCodec.decode(o))
    }
    fun reload() { state.value = read() }

    override suspend fun update(transform: (AppSettings) -> AppSettings) = withContext(Dispatchers.IO) {
        mutex.withLock {
            val next = transform(state.value)
            store.putJson(SETTINGS, SettingsCodec.encode(next))
            state.value = next
        }
    }
    override suspend fun registerProvider(id: String, baseUrl: String, auth: AuthType): Boolean = withContext(Dispatchers.IO) {
        val r = keys.register(id, baseUrl, auth)
        if (r == "cleared") update { s -> s.copy(providers = s.providers.map { if (it.id == id) it.copy(hasKey = false) else it }) }
        r == "cleared"
    }
    companion object { const val SETTINGS = "settings.json" }
}

object SettingsMigrations {
    /** app.js 208：if (!autoCharV084) { if (!autoCharMode || autoCharMode === 'ask') autoCharMode = 'auto'; autoCharV084 = true } */
    fun autoCharV084(s: AppSettings): AppSettings =
        if (s.autoCharV084) s else s.copy(autoCharMode = if (s.autoCharMode.isEmpty() || s.autoCharMode == "ask") "auto" else s.autoCharMode, autoCharV084 = true)
}

// ============================================================ convs.json + conv_<id>.*
class FileChatRepository(
    private val fs: FileStore,
    val codec: ConvLogCodecImpl = ConvLogCodecImpl(),
    private val now: () -> Long = System::currentTimeMillis,
) : ChatRepository {
    private val store = StoreJs.of(fs)
    private val mutex = Mutex()
    private val idx = MutableStateFlow(loadIndex())
    override val index: StateFlow<List<ConversationMeta>> = idx.asStateFlow()

    /** app.js loadConvIndex：convs.json 不是数组时，用 listConvIds + loadMeta 重建（Secure.rebuildIndex）并写回 */
    private fun loadIndex(): List<ConversationMeta> {
        val raw = store.json(INDEX)
        if (raw is JsonArray) return ConvMetaCodec.decodeList(raw)
        val ids = codec.listConvIds(fs)
        if (ids.isEmpty()) return emptyList()
        val rebuilt = ids.mapNotNull { codec.loadMeta(fs, it) }.map(ConvMetaCodec::decode).filter { it.id.isNotEmpty() }
            .map { if (it.title.isEmpty()) it.copy(title = "未命名对话") else it }.sortedByDescending { it.updatedAt }
        store.putJson(INDEX, ConvMetaCodec.encodeList(rebuilt))
        return rebuilt
    }
    fun reload() { idx.value = loadIndex() }

    override suspend fun load(id: String): Conversation? = withContext(Dispatchers.IO) {
        mutex.withLock { codec.loadJs(fs, id)?.let { Js.toJsonObject(it) }?.let(ConversationCodec::decode) }
    }

    override suspend fun save(conv: Conversation, touch: Boolean) = withContext(Dispatchers.IO) {
        mutex.withLock { saveLocked(if (touch) conv.copy(updatedAt = now()) else conv) }
    }
    private fun saveLocked(c: Conversation) {
        var json: JsonElement = ConversationCodec.encode(c)
        // 键序与上次 load/commit 的结果对齐，避免 JSON.stringify 判等产生无意义的 msg.edit
        codec.engine.session(store, c.id)?.last?.let { json = KeyOrder.align(json, Js.toJson(it)) }
        codec.commitJs(fs, Js.fromJson(json) as JsObj)
        // app.js saveConv：索引项没变就不重写
        val meta = ConversationMeta(c.id, c.title, c.providerId, c.model, c.updatedAt, c.personaName?.takeIf { it.isNotEmpty() }, c.personaEmoji.takeIf { !c.personaName.isNullOrEmpty() })
        val cur = idx.value
        val i = cur.indexOfFirst { it.id == c.id }
        if (i >= 0 && cur[i] == meta) return
        val next = (if (i >= 0) cur.toMutableList().also { it[i] = meta } else listOf(meta) + cur).sortedByDescending { it.updatedAt }
        store.putJson(INDEX, ConvMetaCodec.encodeList(next))
        idx.value = next
    }

    override suspend fun create(providerId: String, model: String, title: String): Conversation {
        val t = now()
        val c = Conversation(id = jsUid(t), title = title, providerId = providerId, model = model, createdAt = t, updatedAt = t, messages = emptyList())
        save(c, touch = false)
        return c
    }

    override suspend fun delete(id: String) = withContext(Dispatchers.IO) {
        mutex.withLock {
            codec.removeFiles(fs, id)
            fs.delete("rplog_$id.json"); fs.delete("rplog_$id.jsonl")
            val next = idx.value.filter { it.id != id }
            store.putJson(INDEX, ConvMetaCodec.encodeList(next)); idx.value = next
        }
    }

    override suspend fun exportJson(id: String): String = withContext(Dispatchers.IO) { mutex.withLock { codec.engine.exportLegacyJSON(store, id) } }
    override suspend fun exportAllJson(): String = withContext(Dispatchers.IO) {
        mutex.withLock {
            val list = idx.value.mapNotNull { codec.exportLegacyJs(fs, it.id) }
            if (list.isEmpty()) "" else Js.stringify(list.toMutableList<Any?>(), 2)!!
        }
    }

    /** 导入旧格式 JSON（单个对象或数组，即 exportConvLegacy / exportAllLegacy 的输出）。id 已存在时换新 id。 */
    override suspend fun importJson(json: String): List<String> = withContext(Dispatchers.IO) {
        val root = Js.parse(json)
        val items = when (root) { is JsObj -> listOf(root); is List<*> -> root.filterIsInstance<JsObj>(); else -> emptyList() }
        mutex.withLock {
            items.mapNotNull { o ->
                if (!Js.isArr(o["messages"])) return@mapNotNull null
                o.remove("format")
                var id = Js.toStr(Js.or(o["id"], ""))
                if (id.isEmpty() || idx.value.any { it.id == id } || fs.exists("conv_$id.json") || fs.exists("conv_$id.snap.json")) id = jsUid(now())
                o["id"] = id
                saveLocked(ConversationCodec.decode(Js.toJsonObject(o)!!))
                id
            }
        }
    }
    companion object { const val INDEX = "convs.json" }
}

// ============================================================ personas / prompts / templates / worlds
class FileLibraryRepository(
    private val fs: FileStore,
    private val builtins: Builtins = Builtins.load(),
    private val removed: () -> AppSettings = { SettingsCodec.default() },
) : LibraryRepository {
    private val store = StoreJs.of(fs)
    private val mutex = Mutex()
    private val _personas = MutableStateFlow(emptyList<Persona>())
    private val _prompts = MutableStateFlow(emptyList<PromptSnippet>())
    private val _templates = MutableStateFlow(emptyList<PromptTemplate>())
    private val _worlds = MutableStateFlow(emptyList<World>())
    override val personas = _personas.asStateFlow()
    override val prompts = _prompts.asStateFlow()
    override val templates = _templates.asStateFlow()
    override val worlds = _worlds.asStateFlow()
    init { reload() }

    /** 同 app.js 启动：缺文件用默认值；personas/templates 合并内置（用户删掉的不补回） */
    fun reload() {
        val s = removed()
        _personas.value = builtins.mergePersonas(PersonaCodec.decodeList(store.json(PERSONAS) ?: builtins.personas), s.removedPersonas)
        _prompts.value = PromptCodec.decodeList(store.json(PROMPTS) ?: builtins.prompts)
        _templates.value = builtins.mergeTemplates(TemplateCodec.decodeList(store.json(TEMPLATES) ?: builtins.templates), s.removedTemplates)
        _worlds.value = WorldCodec.decodeList(store.json(WORLDS) ?: JsonArray(emptyList()))
    }
    private suspend fun <E> save(name: String, list: List<E>, c: Codec<E>, flow: MutableStateFlow<List<E>>) = withContext(Dispatchers.IO) {
        mutex.withLock { store.putJson(name, c.encodeList(list)); flow.value = list }
    }
    override suspend fun savePersonas(list: List<Persona>) = save(PERSONAS, list, PersonaCodec, _personas)
    override suspend fun savePrompts(list: List<PromptSnippet>) = save(PROMPTS, list, PromptCodec, _prompts)
    override suspend fun saveTemplates(list: List<PromptTemplate>) = save(TEMPLATES, list, TemplateCodec, _templates)
    override suspend fun saveWorlds(list: List<World>) = save(WORLDS, list, WorldCodec, _worlds)
    companion object { const val PERSONAS = "personas.json"; const val PROMPTS = "prompts.json"; const val TEMPLATES = "templates.json"; const val WORLDS = "worlds.json" }
}

/**
 * 内置助手 / 提示词 / 模板（由 `node tests/golden-export/run.mjs library` 从 personas.js / templates.js 导出到
 * `app/src/main/resources/aichat/builtins.json`，与 JS 逐字一致），以及 mergeBuiltins 的移植。
 */
class Builtins(val personas: JsonArray, val prompts: JsonArray, val templates: JsonArray,
               private val oldTemplateContent: JsonObject, private val retired: JsonObject) {
    /** Personas.mergeBuiltins：已有项 normalizePersona（基本字段同 JS），缺失且未被删除的内置助手追加到末尾。
     *  有意差异：JS normalize 会丢掉未知字段，这里保留在 extras（超集，JS 读到也无害） */
    fun mergePersonas(list: List<Persona>, removedIds: List<String>): List<Persona> {
        val out = list.map(::normalizePersona).toMutableList()
        PersonaCodec.decodeList(personas).forEach { b -> if (out.none { it.id == b.id } && b.id !in removedIds) out += b.copy(builtin = true) }
        return out
    }
    /** personas.js normalizePersona 的基本字段部分 */
    fun normalizePersona(p: Persona): Persona {
        val base = setOf(ABSENT_KEY, "id", "emoji", "name", "desc", "systemPrompt", "providerId", "model", "temperature", "builtin")
        val emoji = p.emoji.ifEmpty { "🤖" }.trim().let { it.substring(0, minOf(4, it.length)) }.ifEmpty { "🤖" }
        return p.copy(id = p.id.ifEmpty { "p-" + jsUid() }, emoji = emoji, name = p.name.trim().ifEmpty { "未命名助手" }, desc = p.desc.trim(),
            model = p.model.trim(), temperature = p.temperature?.takeIf { !it.isNaN() }?.coerceIn(0.0, 2.0),
            extras = JsonObject(p.extras.filterKeys { it !in base }))
    }
    /** Templates.mergeBuiltins：未改过的旧内置升级为新版内容；退役的未改旧内置删除、改过的转为自定义；缺失的内置补回 */
    fun mergeTemplates(list: List<PromptTemplate>, removedIds: List<String>): List<PromptTemplate> {
        val bs = TemplateCodec.decodeList(templates)
        fun olds(id: String) = (oldTemplateContent[id] as? JsonArray)?.mapNotNull { Fields.strOf(it) } ?: emptyList()
        var out = list.map { t ->
            if (t.content !in olds(t.id)) return@map t
            val b = bs.firstOrNull { it.id == t.id } ?: return@map t
            t.copy(content = b.content, name = b.name, emoji = b.emoji, tags = b.tags, skill = b.skill, pinned = t.pinned || b.pinned)
        }
        out = out.filter { t -> retired[t.id] == null || t.content !in olds(t.id) }
            .map { t -> if (retired[t.id] != null && t.builtin) t.copy(builtin = false) else t }
        val res = out.toMutableList()
        bs.forEach { b -> if (b.id !in removedIds && res.none { it.id == b.id }) res += b }
        return res
    }
    companion object {
        fun load(): Builtins {
            val text = Builtins::class.java.classLoader?.getResourceAsStream("aichat/builtins.json")?.use { it.readBytes().toString(Charsets.UTF_8) }
            val o = text?.let { Js.parseJson(it) as? JsonObject } ?: EmptyJson
            fun a(k: String) = (o[k] as? JsonArray) ?: JsonArray(emptyList())
            return Builtins(a("personas"), a("prompts"), a("templates"), (o["oldTemplateContent"] as? JsonObject) ?: EmptyJson, (o["retiredTemplates"] as? JsonObject) ?: EmptyJson)
        }
    }
}

// ============================================================ usage-stats.jsonl + meta
/**
 * 用量日志（app.js loadUsageStats / saveUsageStats）。语义（normalize、LOG_LIMIT、价目合并）归 B 的 UsageStats；
 * 这里只负责文件：追加一行、读全量（按 key 去重）、整体重写（压缩），以及旧 usage-stats.json → jsonl 迁移。
 */
class FileUsageRepository(private val fs: FileStore) : UsageRepository {
    private val store = StoreJs.of(fs)
    private val mutex = Mutex()
    override suspend fun append(record: JsonObject) = withContext(Dispatchers.IO) { mutex.withLock { store.append(LOG, Js.fromJson(record)); Unit } }
    override suspend fun meta(): JsonObject = withContext(Dispatchers.IO) { (store.json(META) as? JsonObject) ?: EmptyJson }
    override suspend fun saveMeta(meta: JsonObject) = withContext(Dispatchers.IO) { mutex.withLock { store.putJson(META, meta); Unit } }
    /** 读日志：按 key 去重（保留首个），同 app.js 278–281 */
    suspend fun readLog(): List<JsonObject> = withContext(Dispatchers.IO) {
        val seen = HashSet<String>()
        (store.readJsonl(LOG) ?: emptyList()).mapNotNull { e ->
            val k = Js.prop(e, "key"); if (!Js.truthy(k) || !seen.add(Js.toStr(k))) null else Js.toJsonObject(e)
        }
    }
    suspend fun rewriteLog(items: List<JsonObject>) = withContext(Dispatchers.IO) { mutex.withLock { store.writeJsonl(LOG, items.map { Js.fromJson(it) }); Unit } }
    /** 旧版整文件 usage-stats.json → usage-stats.jsonl + meta，旧文件改名 .migrated（不做 normalize，原样搬运） */
    fun migrateLegacy(): Boolean {
        if (fs.exists(META)) return false
        val old = store.get(LEGACY, null) as? JsObj ?: return false
        val log = (old["log"] as? List<*>)?.toList() ?: emptyList()
        val meta = JsObj("version" to old["version"], "backfilled" to old["backfilled"], "prices" to old["prices"], "priceMode" to old["priceMode"],
            "calib" to Js.or(old["calib"], JsObj()))
        if (store.writeJsonl(LOG, log) && store.set(META, meta)) { store.rename(LEGACY, "$LEGACY.migrated"); return true }
        return false
    }
    companion object { const val LOG = "usage-stats.jsonl"; const val META = "usage-stats-meta.json"; const val LEGACY = "usage-stats.json" }
}

// ============================================================ 小文件仓库（B/C 用）
/** 单个 JSON 文档（router-affinity.json、balance-cache.json、rp-memory.json…）：原样读写，不建模 */
class JsonDocStore(private val fs: FileStore, val name: String) {
    private val store = StoreJs.of(fs)
    fun load(): JsonObject = (store.json(name) as? JsonObject) ?: EmptyJson
    fun save(doc: JsonObject): Boolean = store.putJson(name, doc)
}

/** knowledge_world_<worldId>.json（C 的 KnowledgeService 经它读写；normalizeDoc 归 C） */
class KnowledgeStore(private val fs: FileStore) {
    private val store = StoreJs.of(fs)
    fun fileName(worldId: String) = "knowledge_world_$worldId.json"
    fun load(worldId: String): JsonObject? = store.json(fileName(worldId)) as? JsonObject
    fun save(worldId: String, doc: JsonObject): Boolean = store.putJson(fileName(worldId), doc)
    fun delete(worldId: String) = fs.delete(fileName(worldId))
    fun worldIds(): List<String> = fs.list().mapNotNull { Regex("^knowledge_world_(.+)\\.json$").find(it)?.groupValues?.get(1) }
}

/** rplog_<id>.jsonl（旧版 rplog_<id>.json）：rpcache 每轮日志（C） */
class RpLogStore(private val fs: FileStore) {
    private val store = StoreJs.of(fs)
    fun append(convId: String, entry: JsonObject) = store.append("rplog_$convId.jsonl", Js.fromJson(entry))
    fun read(convId: String): List<JsonObject> {
        val legacy = (store.json("rplog_$convId.json") as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
        return legacy + (store.readJsonl("rplog_$convId.jsonl") ?: emptyList()).mapNotNull { Js.toJsonObject(it) }
    }
    fun rewrite(convId: String, items: List<JsonObject>) = store.writeJsonl("rplog_$convId.jsonl", items.map { Js.fromJson(it) })
}
