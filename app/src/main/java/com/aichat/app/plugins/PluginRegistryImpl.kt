package com.aichat.app.plugins

import com.aichat.app.domain.*
import com.aichat.app.domain.model.*
import com.aichat.app.plugins.js.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.*

/** 插件宿主（对应 app.js 的 pluginHost 中插件用到的部分）；notify = 旧版 host.toast，经 [PluginRegistry.attach] 绑定的 [PluginContext] 转给 ChatEngine */
interface PluginHost : PluginContext {
    fun now(): Long
    /** reg.convData(conv, id)：对话级插件数据的可变镜像（= conv.plugins[id]），runAfterResponse 时写回 conv.extras.plugins */
    fun convData(conv: Conversation, id: String): JObj
    /** reg.config(settings, id)：settings.plugins[id] 的 JS 值副本 */
    fun config(settings: AppSettings, id: String): JObj
    fun isActive(id: String, settings: AppSettings, conv: Conversation?): Boolean
}

/**
 * www/plugins.js createRegistry() 的移植。注册顺序固定 = 旧版脚本加载顺序（index.html）：
 *   knowledge → rpcache → usage → gcache → mmcache → affect（→ rpmemory，旧版最后加载）
 * 未移植完的插件不注册（缺席即「不生效」，请求逐字节不变）。
 */
class PluginRegistryImpl(
    private val clock: () -> Long = { System.currentTimeMillis() },
) : PluginRegistry, PluginHost {
    @Volatile private var context: PluginContext? = null
    /** 契约变更 #i：ChatEngine 每轮发送前绑定；插件 notify 的文字经它变成 StreamEvent.Notice */
    override fun attach(context: PluginContext) { this.context = context }
    private val list = mutableListOf<ChatPlugin>()
    override val plugins: List<ChatPlugin> get() = list.toList()
    private val _errors = MutableStateFlow<List<JsonObject>>(emptyList())
    override val errors: StateFlow<List<JsonObject>> = _errors

    /** 对话级插件数据镜像：convId → conv.plugins（JS 值） */
    private val convPlugins = HashMap<String, JObj>()

    fun register(p: ChatPlugin): ChatPlugin {
        require(p.id.isNotEmpty() && p.name.isNotEmpty()) { "插件必须有 id 和 name" }
        require(list.none { it.id == p.id }) { "插件 id 重复：" + p.id }
        list += p; return p
    }
    fun get(id: String): ChatPlugin? = list.firstOrNull { it.id == id }

    private fun pushErr(plugin: String, hook: String, message: String) = synchronized(this) {
        val cur = _errors.value.toMutableList()
        val last = cur.lastOrNull()
        if (last != null && last["plugin"]?.jsonPrimitive?.content == plugin && last["hook"]?.jsonPrimitive?.content == hook && last["message"]?.jsonPrimitive?.content == message) {
            val c = (last["count"]?.jsonPrimitive?.intOrNull ?: 1) + 1
            cur[cur.size - 1] = JsonObject(last + ("count" to JsonPrimitive(c)))
        } else {
            cur += buildJsonObject { put("plugin", plugin); put("hook", hook); put("message", message) }
            if (cur.size > ERR_MAX) repeat(cur.size - ERR_MAX) { cur.removeAt(0) }
        }
        _errors.value = cur
    }
    private inline fun <T> safe(p: ChatPlugin, hook: String, fn: () -> T): T? = try { fn() } catch (e: Throwable) { pushErr(p.id, hook, e.message ?: e.toString()); null }

    fun isGloballyEnabled(id: String, settings: AppSettings): Boolean {
        val p = get(id) ?: return false
        val st = settings.plugins[id] as? JsonObject
        val en = (st?.get("enabled") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        return en ?: p.defaultEnabled
    }
    private fun convPluginState(conv: Conversation?, id: String): JsonObject? = ((conv?.extras?.get("plugins") as? JsonObject)?.get(id)) as? JsonObject
    override fun isActive(id: String, settings: AppSettings, conv: Conversation?): Boolean {
        val p = get(id)
        if (p == null || !isGloballyEnabled(id, settings)) return false
        val cs = convPluginState(conv, id)
        val en = (cs?.get("enabled") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        if (p.perConversation) {
            if (en != null) return en
            return conv != null && (safe(p, "autoActive") { p.autoActive(conv, settings) } ?: false)
        }
        return en != false
    }
    fun isAutoActive(id: String, settings: AppSettings, conv: Conversation?): Boolean {
        val en = (convPluginState(conv, id)?.get("enabled") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        return en == null && isActive(id, settings, conv)
    }
    fun active(settings: AppSettings, conv: Conversation?): List<ChatPlugin> = list.filter { isActive(it.id, settings, conv) }

    override suspend fun runBeforeRequest(ctx: RequestContext, status: (String?) -> Unit): RequestContext {
        convPlugins[ctx.conv.id] = (Js.fromJson(ctx.conv.extras["plugins"]) as? JObj) ?: JObj()
        val act = active(ctx.settings, ctx.conv)
        var cur = ctx.copy(activePlugins = act.map { it.id })
        for (p in act) {
            cur = try { p.onBeforeRequest(cur, status) } catch (e: Throwable) { pushErr(p.id, "onBeforeRequest", e.message ?: e.toString()); continue }
        }
        return cur
    }

    /**
     * 契约变更 #g：按注册顺序调用各插件的 ChatPlugin.transformRequest（默认原样返回）。
     * 旧版 app.js 只对 gcache / mmcache 调用，且由插件自己在 onBeforeRequest 写入的 opts.orGemini / orMiniMax 把关（这里同样由插件读 ctx.meta 自行把关）；
     * 出错时保留上一步请求（旧版 console.warn，不计入插件错误列表）。
     */
    override fun transformRequest(req: BuiltRequest, ctx: RequestContext): BuiltRequest {
        var r = req
        for (p in list) r = try { p.transformRequest(r, ctx) } catch (e: Throwable) { r }
        return r
    }

    override fun runAfterResponse(ctx: RequestContext, result: TurnResult): Conversation {
        var conv = ctx.conv
        var res = result
        for (p in active(ctx.settings, ctx.conv)) {
            val c2 = ctx.copy(conv = conv)
            if (res.usage != null) safe(p, "onResponseUsage") { p.onResponseUsage(res.usage!!, c2) }
            safe(p, "onAfterResponse") { p.onAfterResponse(res, c2) }?.let { conv = it; res = res.copy(assistant = it.messages.firstOrNull { m -> m.id == res.assistant.id } ?: res.assistant) }
        }
        return writeBackPlugins(conv)
    }
    /** 把可变镜像写回 conv.extras.plugins（键序保持） */
    fun writeBackPlugins(conv: Conversation): Conversation {
        val mirror = convPlugins[conv.id] ?: return conv
        val ext = LinkedHashMap(conv.extras); ext["plugins"] = Js.toJson(mirror)
        return conv.copy(extras = JsonObject(ext))
    }

    override fun messageBadges(msg: Message, settings: AppSettings, conv: Conversation): List<Badge> =
        active(settings, conv).flatMap { p -> (safe(p, "messageBadges") { p.messageBadges(msg, conv) } ?: emptyList()).map { if (it.plugin.isEmpty()) it.copy(plugin = p.id) else it } }
    override fun headerBadges(settings: AppSettings, conv: Conversation): List<Badge> =
        active(settings, conv).flatMap { p -> (safe(p, "headerBadges") { p.headerBadges(conv) } ?: emptyList()).map { if (it.plugin.isEmpty()) it.copy(plugin = p.id) else it } }
    override fun messageState(msg: Message, settings: AppSettings, conv: Conversation): MessageState {
        var st: MessageState? = null
        active(settings, conv).forEach { p -> safe(p, "messageState") { p.messageState(msg, conv) }?.let { r -> st = MessageState(dim = (st?.dim ?: false) || r.dim, label = r.label ?: st?.label) } }
        return st ?: MessageState()
    }

    // ── PluginHost ──
    override fun now(): Long = clock()
    override fun notify(text: String) { context?.notify(text) }
    override fun convData(conv: Conversation, id: String): JObj {
        val m = convPlugins.getOrPut(conv.id) { (Js.fromJson(conv.extras["plugins"]) as? JObj) ?: JObj() }
        return (m[id] as? JObj) ?: JObj().also { m[id] = it }
    }
    override fun config(settings: AppSettings, id: String): JObj = (Js.fromJson(settings.plugins[id]) as? JObj) ?: JObj()

    companion object {
        const val ERR_MAX = 50
        /** 固定注册顺序（Contracts.kt 注释 + index.html 脚本顺序） */
        val ORDER = listOf("knowledge", "rpcache", "usage", "gcache", "mmcache", "affect")

        /** 默认组装：按 ORDER 注册已实现的插件 */
        fun createDefault(clock: () -> Long = { System.currentTimeMillis() }): PluginRegistryImpl {
            val reg = PluginRegistryImpl(clock)
            val impls: Map<String, (PluginHost) -> ChatPlugin> = mapOf(
                "usage" to { _ -> com.aichat.app.plugins.usage.UsagePlugin() },
                "gcache" to { h -> com.aichat.app.plugins.cache.GCachePluginImpl(h) },
                "mmcache" to { h -> com.aichat.app.plugins.cache.MmCachePluginImpl(h) },
            )
            ORDER.forEach { id -> impls[id]?.let { reg.register(it(reg)) } }
            return reg
        }

        /** ProviderConfig → providers.js 的 provider 对象（插件只读 type / presetId / baseUrl / cacheAdapter 等） */
        fun providerJs(p: ProviderConfig): JObj {
            val o = jobj("id" to p.id, "presetId" to p.presetId, "name" to p.name, "type" to p.type.wire, "baseUrl" to p.baseUrl)
            (Js.fromJson(p.extras) as? JObj)?.forEach { (k, v) -> if (!o.containsKey(k)) o[k] = v }
            return o
        }
    }
}
