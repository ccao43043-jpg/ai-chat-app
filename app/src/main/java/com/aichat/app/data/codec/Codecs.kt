package com.aichat.app.data.codec

import com.aichat.app.data.json.Js
import com.aichat.app.domain.model.*
import kotlinx.serialization.json.*

/*
 * store 文件 ⇄ 领域实体的无损 Codec（D 所有；spec §3.3 硬性约定 1）。
 *
 * 规则（对所有实体一致）：
 *  - 未建模的键 → entity.extras，编码时原样写回。
 *  - 已建模字段：编码时「值等于默认值就省略」，因此「缺键」与「默认值」互相还原。
 *  - 影子（shadow）：若某个已建模键的原始值经 decode→encode 后不能还原（类型不符，如 temperature:''、thinking:true、
 *    数字写成字符串等），原始值以同名键存进 extras。编码时：只要实体里该字段仍等于 decode(影子)，就写回影子原值；
 *    一旦调用方改了这个字段，就写新值、丢弃影子。
 *  - 缺键记号：若原对象缺某个「必写」键（encode 默认值仍会写出，如 strReq / temperature:''），键名记进
 *    extras[[ABSENT_KEY]]（字符串数组，Writer 永不写出）；字段值未改时编码继续省略该键。
 * 于是：encode(decode(x)) 与 x JSON 语义相等（键顺序不保证；需要保序时用 [KeyOrder.align]）。
 */
internal fun sem(a: JsonElement?, b: JsonElement?): Boolean =
    if (a == null || b == null) a == b else Js.semanticEqual(Js.fromJson(a), Js.fromJson(b))

/** 一个已建模字段：dec 必须对任意输入（含 null = 缺键）给出值；enc 返回 null 表示省略该键 */
class F<V>(val key: String, val dec: (JsonElement?) -> V, val enc: (V) -> JsonElement?)

/** extras 内部键：原对象缺失、但编码会写出默认值的已建模键（不写入文件） */
const val ABSENT_KEY = "\u0000absent"

class Reader(private val o: JsonObject) {
    private val modeled = LinkedHashSet<String>()
    private val shadows = LinkedHashMap<String, JsonElement>()
    private val absent = ArrayList<String>()
    fun <V> read(f: F<V>): V {
        modeled += f.key
        val raw = o[f.key]
        val v = f.dec(raw)
        if (raw != null && !sem(f.enc(v), raw)) shadows[f.key] = raw
        if (raw == null && f.enc(v) != null) absent += f.key
        return v
    }
    /** extras = 原始对象去掉已建模键 + 影子（按原始键顺序）+ 缺键记号 */
    fun extras(): JsonObject = JsonObject(LinkedHashMap<String, JsonElement>().also { m ->
        o.forEach { (k, v) -> if ((k !in modeled || k in shadows) && k != ABSENT_KEY) m[k] = v }
        if (absent.isNotEmpty()) m[ABSENT_KEY] = JsonArray(absent.map { JsonPrimitive(it) })
    })
}

class Writer(private val extras: JsonObject) {
    private val out = LinkedHashMap<String, JsonElement>()
    private val modeled = HashSet<String>()
    private val absent = (extras[ABSENT_KEY] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.content }?.toSet() ?: emptySet()
    fun <V> put(f: F<V>, v: V) {
        modeled += f.key
        val sh = extras[f.key]
        if (sh != null && f.dec(sh) == v) { out[f.key] = sh; return }
        if (f.key in absent && f.dec(null) == v) return
        f.enc(v)?.let { out[f.key] = it }
    }
    fun build(): JsonObject {
        extras.forEach { (k, v) -> if (k !in modeled && k != ABSENT_KEY) out[k] = v }
        return JsonObject(out)
    }
}

/** 字段工厂 */
object Fields {
    private fun prim(e: JsonElement?) = e as? JsonPrimitive
    fun strOf(e: JsonElement?): String? = prim(e)?.takeIf { it.isString }?.content
    fun numOf(e: JsonElement?): Double? = prim(e)?.takeIf { !it.isString && it !is JsonNull }?.content?.toDoubleOrNull()
    fun boolOf(e: JsonElement?): Boolean? = prim(e)?.takeIf { !it.isString }?.booleanOrNull
    fun num(d: Double): JsonElement = Js.toJson(d)

    fun str(k: String, def: String = "") = F(k, { strOf(it) ?: def }, { v: String -> if (v == def) null else JsonPrimitive(v) })
    /** 必写字符串（id 等） */
    fun strReq(k: String) = F(k, { strOf(it) ?: "" }, { v: String -> JsonPrimitive(v) })
    fun strOrNull(k: String) = F(k, { strOf(it) }, { v: String? -> v?.let { JsonPrimitive(it) } })
    fun bool(k: String, def: Boolean) = F(k, { boolOf(it) ?: def }, { v: Boolean -> if (v == def) null else JsonPrimitive(v) })
    fun boolOrNull(k: String) = F(k, { boolOf(it) }, { v: Boolean? -> v?.let { JsonPrimitive(it) } })
    fun long(k: String, def: Long = 0) = F(k, { numOf(it)?.toLong() ?: def }, { v: Long -> if (v == def) null else num(v.toDouble()) })
    fun int(k: String, def: Int = 0) = F(k, { numOf(it)?.toInt() ?: def }, { v: Int -> if (v == def) null else num(v.toDouble()) })
    fun intReq(k: String, def: Int) = F(k, { numOf(it)?.toInt() ?: def }, { v: Int -> num(v.toDouble()) })
    fun intOrNull(k: String) = F(k, { numOf(it)?.toInt() }, { v: Int? -> v?.let { num(it.toDouble()) } })
    fun doubleOrNull(k: String) = F(k, { numOf(it) }, { v: Double? -> v?.let { num(it) } })
    fun obj(k: String) = F(k, { (it as? JsonObject) ?: EmptyJson }, { v: JsonObject -> if (v.isEmpty()) null else v })
    fun strList(k: String) = F(k, { e -> (e as? JsonArray)?.mapNotNull { strOf(it) } ?: emptyList() },
        { v: List<String> -> if (v.isEmpty()) null else JsonArray(v.map { JsonPrimitive(it) }) })
    fun objList(k: String) = F(k, { e -> (e as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList() },
        { v: List<JsonObject> -> if (v.isEmpty()) null else JsonArray(v) })
    fun nullableObjList(k: String) = F(k, { e -> (e as? JsonArray)?.map { it as? JsonObject } ?: emptyList() },
        { v: List<JsonObject?> -> if (v.isEmpty()) null else JsonArray(v.map { it ?: JsonNull }) })
    fun <E> list(k: String, c: Codec<E>) = F(k, { e -> (e as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(c::decode) } ?: emptyList() },
        { v: List<E> -> if (v.isEmpty()) null else JsonArray(v.map(c::encode)) })
    /** JS 里 '' 表示未设的数字（temperature / maxTokens） */
    fun blankableDouble(k: String) = F(k, { numOf(it) }, { v: Double? -> if (v == null) JsonPrimitive("") else num(v) })
    fun blankableInt(k: String) = F(k, { numOf(it)?.toInt() }, { v: Int? -> if (v == null) JsonPrimitive("") else num(v.toDouble()) })
}

interface Codec<E> {
    fun decode(o: JsonObject): E
    fun encode(e: E): JsonObject
    fun decodeList(a: JsonElement?): List<E> = (a as? JsonArray)?.mapNotNull { (it as? JsonObject)?.let(::decode) } ?: emptyList()
    fun encodeList(l: List<E>): JsonArray = JsonArray(l.map(::encode))
}

// ---------------------------------------------------------------- settings.json
object ProviderCodec : Codec<ProviderConfig> {
    private val id = Fields.strReq("id"); private val presetId = Fields.strReq("presetId"); private val name = Fields.strReq("name")
    private val type = F("type", { ProviderType.of(Fields.strOf(it)) }, { v: ProviderType -> JsonPrimitive(v.wire) })
    private val baseUrl = Fields.strReq("baseUrl"); private val models = F("models", Fields.strList("models").dec, { v: List<String> -> JsonArray(v.map { JsonPrimitive(it) }) })
    private val imageModel = Fields.str("imageModel"); private val videoModel = Fields.str("videoModel"); private val embeddingModel = Fields.str("embeddingModel")
    private val speechModel = Fields.str("speechModel"); private val transcriptionModel = Fields.str("transcriptionModel")
    private val hasKey = Fields.bool("hasKey", false); private val thinking = Fields.strOrNull("thinking")
    private val streamUsage = Fields.boolOrNull("streamUsage"); private val cacheAffinity = Fields.boolOrNull("cacheAffinity")
    private val orSort = Fields.strOrNull("orSort"); private val modelMeta = Fields.obj("modelMeta")
    override fun decode(o: JsonObject): ProviderConfig { val r = Reader(o)
        return ProviderConfig(r.read(id), r.read(presetId), r.read(name), r.read(type), r.read(baseUrl), r.read(models), r.read(imageModel), r.read(videoModel),
            r.read(embeddingModel), r.read(speechModel), r.read(transcriptionModel), r.read(hasKey), r.read(thinking), r.read(streamUsage), r.read(cacheAffinity),
            r.read(orSort), r.read(modelMeta), r.extras()) }
    override fun encode(e: ProviderConfig): JsonObject = Writer(e.extras).apply {
        put(id, e.id); put(presetId, e.presetId); put(name, e.name); put(type, e.type); put(baseUrl, e.baseUrl); put(models, e.models)
        put(imageModel, e.imageModel); put(videoModel, e.videoModel); put(embeddingModel, e.embeddingModel); put(speechModel, e.speechModel)
        put(transcriptionModel, e.transcriptionModel); put(hasKey, e.hasKey); put(thinking, e.thinking); put(streamUsage, e.streamUsage)
        put(cacheAffinity, e.cacheAffinity); put(orSort, e.orSort); put(modelMeta, e.modelMeta) }.build()
}

object SettingsCodec : Codec<AppSettings> {
    private val providers = Fields.list("providers", ProviderCodec)
    private val systemPrompt = Fields.str("systemPrompt"); private val stream = Fields.bool("stream", true)
    private val temperature = Fields.blankableDouble("temperature"); private val maxTokens = Fields.blankableInt("maxTokens")
    private val imageSize = Fields.str("imageSize", "1024x1024"); private val imageGenProviderId = Fields.str("imageGenProviderId"); private val imageGenModel = Fields.str("imageGenModel")
    private val lastProviderId = Fields.str("lastProviderId"); private val lastModel = Fields.str("lastModel")
    /** 缺 settingsVersion 的旧文件按 1 处理（app.js：Object.assign(defaults, {settingsVersion:1}, stored)） */
    private val settingsVersion = Fields.intReq("settingsVersion", 1)
    private val searchOn = Fields.bool("searchOn", false); private val search = Fields.obj("search"); private val plugins = Fields.obj("plugins")
    private val showTopCost = Fields.bool("showTopCost", true)
    private val removedPresets = Fields.strList("removedPresets"); private val removedPersonas = Fields.strList("removedPersonas")
    private val removedTemplates = Fields.strList("removedTemplates")
    private val recentTemplates = Fields.strList("recentTemplates"); private val recentWorlds = Fields.strList("recentWorlds"); private val recentPersonas = Fields.strList("recentPersonas")
    /** 缺省按 JS 语义：autoCharMode 缺失时 v0.8.4 迁移会设为 auto；这里解码缺失为 ""，由 SettingsMigrator 处理 */
    private val autoCharMode = Fields.str("autoCharMode", ""); private val autoCharV084 = Fields.bool("autoCharV084", false)
    override fun decode(o: JsonObject): AppSettings { val r = Reader(o)
        return AppSettings(r.read(providers), r.read(systemPrompt), r.read(stream), r.read(temperature), r.read(maxTokens), r.read(imageSize), r.read(imageGenProviderId),
            r.read(imageGenModel), r.read(lastProviderId), r.read(lastModel), r.read(settingsVersion), r.read(searchOn), r.read(search), r.read(plugins), r.read(showTopCost),
            r.read(removedPresets), r.read(removedPersonas), r.read(removedTemplates), r.read(recentTemplates), r.read(recentWorlds), r.read(recentPersonas), r.read(autoCharMode), r.read(autoCharV084), r.extras()) }
    override fun encode(e: AppSettings): JsonObject = Writer(e.extras).apply {
        put(providers, e.providers); put(systemPrompt, e.systemPrompt); put(stream, e.stream); put(temperature, e.temperature); put(maxTokens, e.maxTokens)
        put(imageSize, e.imageSize); put(imageGenProviderId, e.imageGenProviderId); put(imageGenModel, e.imageGenModel); put(lastProviderId, e.lastProviderId)
        put(lastModel, e.lastModel); put(settingsVersion, e.settingsVersion); put(searchOn, e.searchOn); put(search, e.search); put(plugins, e.plugins)
        put(showTopCost, e.showTopCost); put(removedPresets, e.removedPresets); put(removedPersonas, e.removedPersonas)
        put(removedTemplates, e.removedTemplates); put(recentTemplates, e.recentTemplates); put(recentWorlds, e.recentWorlds); put(recentPersonas, e.recentPersonas); put(autoCharMode, e.autoCharMode); put(autoCharV084, e.autoCharV084) }.build()
    fun default(): AppSettings = AppSettings(providers = emptyList())
}

// ---------------------------------------------------------------- convs.json
object ConvMetaCodec : Codec<ConversationMeta> {
    private val id = Fields.strReq("id"); private val title = Fields.strReq("title"); private val providerId = Fields.strReq("providerId"); private val model = Fields.strReq("model")
    private val updatedAt = F("updatedAt", { Fields.numOf(it)?.toLong() ?: 0L }, { v: Long -> Fields.num(v.toDouble()) })
    private val personaName = Fields.strOrNull("personaName"); private val personaEmoji = Fields.strOrNull("personaEmoji")
    /** convs.json 元素没有 extras 字段；未建模键在编码时丢失（与 app.js saveConv 每次重建 meta 一致） */
    override fun decode(o: JsonObject): ConversationMeta { val r = Reader(o)
        return ConversationMeta(r.read(id), r.read(title), r.read(providerId), r.read(model), r.read(updatedAt), r.read(personaName), r.read(personaEmoji)) }
    override fun encode(e: ConversationMeta): JsonObject = Writer(EmptyJson).apply {
        put(id, e.id); put(title, e.title); put(providerId, e.providerId); put(model, e.model); put(updatedAt, e.updatedAt)
        if (e.personaName != null && e.personaName.isNotEmpty()) { put(personaName, e.personaName); put(personaEmoji, e.personaEmoji) } }.build()
}

// ---------------------------------------------------------------- 消息 / 对话
/** Message.usage 的存储 Codec：raw = 存储里的整个 usage 对象（含未建模键），编码时若建模字段未变则原样写回 raw */
/**
 * 落盘的 msg.usage = providers.js normalizeUsage 的输出（键：prompt/completion/hit/miss/cacheSupported/source/cacheWrite/cost/upstreamCost/cacheSaved）。
 * JS 的键是 `cost`（Kotlin 字段名 costUsd）。[Usage.raw]（服务商原始 usage）不落盘；未建模的键进 [Usage.extras] 原样写回。
 */
object UsageStoreCodec {
    private val KEYS = listOf("prompt", "completion", "hit", "miss", "cacheSupported", "source", "cacheWrite", "cost", "upstreamCost", "cacheSaved")
    fun decode(o: JsonObject): Usage {
        fun l(k: String) = Fields.numOf(o[k])?.toLong()
        fun d(k: String) = Fields.numOf(o[k])
        return Usage(l("prompt"), l("completion"), l("hit"), l("miss"), l("cacheWrite"), Fields.boolOf(o["cacheSupported"]), Fields.strOf(o["source"]),
            d("cost"), d("upstreamCost"), d("cacheSaved"), raw = null, extras = JsonObject(o.filterKeys { it !in KEYS }))
    }
    fun encode(u: Usage): JsonObject {
        val m = LinkedHashMap<String, JsonElement>()
        u.prompt?.let { m["prompt"] = Fields.num(it.toDouble()) }; u.completion?.let { m["completion"] = Fields.num(it.toDouble()) }
        u.hit?.let { m["hit"] = Fields.num(it.toDouble()) }; u.miss?.let { m["miss"] = Fields.num(it.toDouble()) }
        u.cacheSupported?.let { m["cacheSupported"] = JsonPrimitive(it) }; u.source?.let { m["source"] = JsonPrimitive(it) }
        u.cacheWrite?.let { m["cacheWrite"] = Fields.num(it.toDouble()) }; u.costUsd?.let { m["cost"] = Fields.num(it) }
        u.upstreamCost?.let { m["upstreamCost"] = Fields.num(it) }; u.cacheSaved?.let { m["cacheSaved"] = Fields.num(it) }
        u.extras.forEach { (k, v) -> if (k !in m) m[k] = v }
        return JsonObject(m)
    }
}

object MessageCodec : Codec<Message> {
    private val id = Fields.strReq("id")
    private val role = F("role", { Role.of(Fields.strOf(it)) }, { v: Role -> JsonPrimitive(v.wire) })
    private val content = Fields.strReq("content"); private val createdAt = Fields.long("createdAt")
    private val images = Fields.strList("images"); private val files = Fields.objList("files"); private val reasoning = Fields.strOrNull("reasoning")
    private val usage = F("usage", { (it as? JsonObject)?.let(UsageStoreCodec::decode) }, { v: Usage? -> v?.let(UsageStoreCodec::encode) })
    private val error = Fields.strOrNull("error"); private val truncated = Fields.bool("truncated", false); private val finishReason = Fields.strOrNull("finishReason")
    private val routeSlug = Fields.strOrNull("routeSlug"); private val versions = Fields.nullableObjList("versions"); private val vi = Fields.int("vi")
    override fun decode(o: JsonObject): Message { val r = Reader(o)
        return Message(r.read(id), r.read(role), r.read(content), r.read(createdAt), r.read(images), r.read(files), r.read(reasoning), r.read(usage), r.read(error),
            r.read(truncated), r.read(finishReason), r.read(routeSlug), r.read(versions), r.read(vi), r.extras()) }
    override fun encode(e: Message): JsonObject = Writer(e.extras).apply {
        put(id, e.id); put(role, e.role); put(content, e.content); put(createdAt, e.createdAt); put(images, e.images); put(files, e.files)
        put(reasoning, e.reasoning); put(usage, e.usage); put(error, e.error); put(truncated, e.truncated); put(finishReason, e.finishReason)
        put(routeSlug, e.routeSlug); put(versions, e.versions); put(vi, e.vi) }.build()
}

/**
 * 对话（ConvLog.load 的输出 / 旧 conv_<id>.json）。rpState 收纳 RP 状态键（[RP_KEYS]），其余未建模键（plugins、format、temperature、
 * personaId、worldRef 以外的扩展……）进 extras。章节在 extras.plugins.rpcache.state.chapters（与 JS 相同位置）。
 */
object ConversationCodec : Codec<Conversation> {
    val RP_KEYS = listOf("chapters", "affect", "affectBy", "ledger", "worldRef", "worldLog", "worldPending", "kb")
    private val id = Fields.strReq("id"); private val title = Fields.str("title"); private val providerId = Fields.str("providerId"); private val model = Fields.str("model")
    private val createdAt = Fields.long("createdAt"); private val updatedAt = Fields.long("updatedAt")
    private val messages = F("messages", Fields.list("messages", MessageCodec).dec, { v: List<Message> -> JsonArray(v.map(MessageCodec::encode)) })
    private val personaName = Fields.strOrNull("personaName"); private val personaEmoji = Fields.strOrNull("personaEmoji"); private val systemPrompt = Fields.strOrNull("systemPrompt")
    private val templateId = Fields.strOrNull("templateId"); private val templateName = Fields.strOrNull("templateName"); private val templateEmoji = Fields.strOrNull("templateEmoji")
    override fun decode(o: JsonObject): Conversation {
        val rest = JsonObject(o.filterKeys { it !in RP_KEYS }); val rp = JsonObject(o.filterKeys { it in RP_KEYS })
        val r = Reader(rest)
        return Conversation(r.read(id), r.read(title), r.read(providerId), r.read(model), r.read(createdAt), r.read(updatedAt), r.read(messages),
            r.read(personaName), r.read(personaEmoji), r.read(systemPrompt), r.read(templateId), r.read(templateName), r.read(templateEmoji), rp, r.extras())
    }
    override fun encode(e: Conversation): JsonObject {
        val base = Writer(e.extras).apply {
            put(id, e.id); put(title, e.title); put(providerId, e.providerId); put(model, e.model); put(createdAt, e.createdAt); put(updatedAt, e.updatedAt)
            put(messages, e.messages); put(personaName, e.personaName); put(personaEmoji, e.personaEmoji); put(systemPrompt, e.systemPrompt)
            put(templateId, e.templateId); put(templateName, e.templateName); put(templateEmoji, e.templateEmoji) }.build()
        return JsonObject(LinkedHashMap(base).apply { e.rpState.forEach { (k, v) -> put(k, v) } })
    }
}

// ---------------------------------------------------------------- personas / prompts / templates / worlds
object PersonaCodec : Codec<Persona> {
    private val id = Fields.strReq("id"); private val emoji = Fields.strReq("emoji"); private val name = Fields.strReq("name"); private val desc = Fields.strReq("desc")
    private val systemPrompt = Fields.strReq("systemPrompt"); private val providerId = Fields.strReq("providerId"); private val model = Fields.strReq("model")
    private val temperature = Fields.blankableDouble("temperature"); private val builtin = F("builtin", { Fields.boolOf(it) ?: false }, { v: Boolean -> JsonPrimitive(v) })
    override fun decode(o: JsonObject): Persona { val r = Reader(o)
        return Persona(r.read(id), r.read(emoji), r.read(name), r.read(desc), r.read(systemPrompt), r.read(providerId), r.read(model), r.read(temperature), r.read(builtin), r.extras()) }
    override fun encode(e: Persona): JsonObject = Writer(e.extras).apply {
        put(id, e.id); put(emoji, e.emoji); put(name, e.name); put(desc, e.desc); put(systemPrompt, e.systemPrompt); put(providerId, e.providerId)
        put(model, e.model); put(temperature, e.temperature); put(builtin, e.builtin) }.build()
}
object PromptCodec : Codec<PromptSnippet> {
    private val id = Fields.strReq("id"); private val title = Fields.strReq("title"); private val content = Fields.strReq("content")
    private val builtin = F("builtin", { Fields.boolOf(it) ?: false }, { v: Boolean -> JsonPrimitive(v) })
    override fun decode(o: JsonObject): PromptSnippet { val r = Reader(o); return PromptSnippet(r.read(id), r.read(title), r.read(content), r.read(builtin), r.extras()) }
    override fun encode(e: PromptSnippet): JsonObject = Writer(e.extras).apply { put(id, e.id); put(title, e.title); put(content, e.content); put(builtin, e.builtin) }.build()
}
object TemplateCodec : Codec<PromptTemplate> {
    private val id = Fields.strReq("id"); private val name = Fields.strReq("name"); private val emoji = Fields.strReq("emoji"); private val content = Fields.strReq("content")
    private val tags = F("tags", Fields.strList("tags").dec, { v: List<String> -> JsonArray(v.map { JsonPrimitive(it) }) })
    private fun b(k: String) = F(k, { Fields.boolOf(it) ?: false }, { v: Boolean -> JsonPrimitive(v) })
    private val pinned = b("pinned"); private val builtin = b("builtin"); private val skill = b("skill")
    override fun decode(o: JsonObject): PromptTemplate { val r = Reader(o)
        return PromptTemplate(r.read(id), r.read(name), r.read(emoji), r.read(content), r.read(tags), r.read(pinned), r.read(builtin), r.read(skill), r.extras()) }
    override fun encode(e: PromptTemplate): JsonObject = Writer(e.extras).apply {
        put(id, e.id); put(name, e.name); put(emoji, e.emoji); put(content, e.content); put(tags, e.tags); put(pinned, e.pinned); put(builtin, e.builtin); put(skill, e.skill) }.build()
}
object WorldCodec : Codec<World> {
    private val id = Fields.strReq("id"); private val emoji = Fields.strReq("emoji"); private val name = Fields.strReq("name"); private val desc = Fields.strReq("desc")
    private val greeting = Fields.strReq("greeting")
    private val blocks = F("blocks", { e -> (e as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonObject)?.let { k to it } }?.toMap(LinkedHashMap()) ?: emptyMap<String, JsonObject>() },
        { v: Map<String, JsonObject> -> JsonObject(v) })
    private val blockHash = F("blockHash", { e -> (e as? JsonObject)?.mapNotNull { (k, v) -> Fields.strOf(v)?.let { k to it } }?.toMap(LinkedHashMap()) ?: emptyMap<String, String>() },
        { v: Map<String, String> -> JsonObject(v.mapValues { JsonPrimitive(it.value) }) })
    private val version = Fields.intReq("version", 1)
    private val changelog = F("changelog", Fields.objList("changelog").dec, { v: List<JsonObject> -> JsonArray(v) })
    private val updatedAt = F("updatedAt", { Fields.numOf(it)?.toLong() ?: 0L }, { v: Long -> Fields.num(v.toDouble()) })
    private val createdAt = F("createdAt", { Fields.numOf(it)?.toLong() ?: 0L }, { v: Long -> Fields.num(v.toDouble()) })
    override fun decode(o: JsonObject): World { val r = Reader(o)
        return World(r.read(id), r.read(emoji), r.read(name), r.read(desc), r.read(greeting), r.read(blocks), r.read(blockHash), r.read(version), r.read(changelog),
            r.read(createdAt), r.read(updatedAt), r.extras()) }
    override fun encode(e: World): JsonObject = Writer(e.extras).apply {
        put(id, e.id); put(emoji, e.emoji); put(name, e.name); put(desc, e.desc); put(greeting, e.greeting); put(blocks, e.blocks); put(blockHash, e.blockHash)
        put(version, e.version); put(changelog, e.changelog); put(updatedAt, e.updatedAt); put(createdAt, e.createdAt) }.build()
}

/** 键顺序对齐：把 next 的对象键按 prev 的顺序排（prev 没有的键排后）；数组元素按 id 或下标配对。
 *  ChatRepository 提交前用它，避免 conv-log 的 JSON.stringify 判等因键序不同而产生无意义的 msg.edit。 */
object KeyOrder {
    fun align(next: JsonElement, prev: JsonElement?): JsonElement = when {
        next is JsonObject && prev is JsonObject -> {
            val m = LinkedHashMap<String, JsonElement>()
            prev.keys.forEach { k -> next[k]?.let { m[k] = align(it, prev[k]) } }
            next.forEach { (k, v) -> if (k !in m) m[k] = v }
            JsonObject(m)
        }
        next is JsonArray && prev is JsonArray -> {
            val byId = prev.mapNotNull { e -> ((e as? JsonObject)?.get("id") as? JsonPrimitive)?.content?.let { it to e } }.toMap()
            JsonArray(next.mapIndexed { i, e ->
                val pid = ((e as? JsonObject)?.get("id") as? JsonPrimitive)?.content
                align(e, if (pid != null) byId[pid] else prev.getOrNull(i))
            })
        }
        else -> next
    }
}

/** FileAttachment ⇄ JS user.files[] 元素（app.js send：pages/scanned/imagePages 为假值时不写键） */
object AttachmentCodec {
    fun encode(a: FileAttachment): JsonObject = buildJsonObject {
        put("name", a.name); put("size", Fields.num(a.size.toDouble())); put("kind", a.kind); put("text", a.text)
        put("total", Fields.num(a.total.toDouble())); put("truncated", a.truncated)
        a.pages?.takeIf { it != 0 }?.let { put("pages", it) }
        if (a.scanned) put("scanned", true)
        a.imagePages?.takeIf { it != 0 }?.let { put("imagePages", it) }
    }
    fun decode(o: JsonObject): FileAttachment = FileAttachment(
        Fields.strOf(o["name"]) ?: "", Fields.numOf(o["size"])?.toLong() ?: 0, Fields.strOf(o["kind"]) ?: "text", Fields.strOf(o["text"]) ?: "",
        Fields.numOf(o["total"])?.toLong() ?: 0, Fields.boolOf(o["truncated"]) ?: false, Fields.numOf(o["pages"])?.toInt(),
        Fields.boolOf(o["scanned"]) ?: false, Fields.numOf(o["imagePages"])?.toInt())
}
