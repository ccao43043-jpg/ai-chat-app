package com.aichat.app.domain

import com.aichat.app.domain.model.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.JsonObject

// ============ 数据层契约（C 提供；A/B/D 消费） ============

/** 对话仓库。实现必须读写旧格式：conv_<id>.snap.json + conv_<id>.log.jsonl（oplog-v1），兼容旧 conv_<id>.json。 */
interface ChatRepository {
    val index: StateFlow<List<ConversationMeta>>          // convs.json，按 updatedAt 降序
    suspend fun load(id: String): Conversation?
    /** 提交整份对话：内部 diff → 追加 op（lamport+1, dev=device-id.json），达阈值压缩快照；同步更新 convs.json。 */
    suspend fun save(conv: Conversation, touch: Boolean = true)
    suspend fun create(providerId: String, model: String, title: String = "新对话"): Conversation
    suspend fun delete(id: String)                         // 同时删 rplog_<id>.json(l)
    suspend fun exportJson(id: String): String             // 与旧版 exportConvLegacy 同格式
    suspend fun exportAllJson(): String
    suspend fun importJson(json: String): List<String>     // 返回导入的会话 id
}

interface SettingsRepository {
    val settings: StateFlow<AppSettings>
    suspend fun update(transform: (AppSettings) -> AppSettings)
    /** 与 secure.js / SecretStore.registerProvider 同语义：baseUrl 源变化时删除已存 Key，返回 true 表示已清除 */
    suspend fun registerProvider(id: String, baseUrl: String, auth: AuthType): Boolean
}

interface LibraryRepository {               // personas/prompts/templates/worlds.json
    val personas: StateFlow<List<Persona>>
    val prompts: StateFlow<List<PromptSnippet>>
    val templates: StateFlow<List<PromptTemplate>>
    val worlds: StateFlow<List<World>>
    suspend fun savePersonas(list: List<Persona>)
    suspend fun savePrompts(list: List<PromptSnippet>)
    suspend fun saveTemplates(list: List<PromptTemplate>)
    suspend fun saveWorlds(list: List<World>)
}

/** API Key 保管（包装 SecretStore；名字规则 provider_key:<id> / search_key:<id>）。明文只交给 net 层注入请求头。 */
interface KeyVault {
    fun has(providerId: String): Boolean
    fun set(providerId: String, key: String): Boolean      // 空串 = 删除
    fun delete(providerId: String)
    /** 仅 net.AuthInjector 可调用；返回 null 表示无 Key 或源不匹配（bound origin ≠ 当前 baseUrl origin） */
    fun keyFor(providerId: String, requestUrl: String): String?
    fun authType(providerId: String): AuthType
    /** v1 契约变更 #5：SecretStore 登记信息（r:<id> = baseUrl\nauthType）。null = 未登记：
     *  ProviderClient 必须直接失败并报旧版文案「服务商未登记」，绝不在无 Key 的情况下发出请求。 */
    fun registration(providerId: String): ProviderRegistration?
}

/** KeyVault.registration 的返回：登记的 baseUrl、其源（secure.js originOf，非法时为 null）与认证方式 */
data class ProviderRegistration(val baseUrl: String, val origin: String?, val authType: AuthType)

interface UsageRepository {                 // usage-stats.jsonl + usage-stats-meta.json + balance-cache.json
    suspend fun append(record: JsonObject)
    suspend fun meta(): JsonObject
    suspend fun saveMeta(meta: JsonObject)
}

// ============ 网络 / 领域契约（B 提供；A 消费） ============

/** 流式事件：createStreamParser(type) 的 Kotlin 版输出 */
sealed interface StreamEvent {
    /** v1 契约变更 #c：ChatEngine 事件流的第一个事件；两条消息此时已建好（用户消息已落盘，助手消息为空占位） */
    data class Started(val userMsgId: String?, val assistantMsgId: String) : StreamEvent
    data class Status(val httpStatus: Int) : StreamEvent
    data class Delta(val text: String) : StreamEvent
    data class Reasoning(val text: String) : StreamEvent
    data class UsageUpdate(val usage: Usage) : StreamEvent       // 已 mergeUsage
    data class Finish(val reason: String?) : StreamEvent
    data class RouteChosen(val slug: String) : StreamEvent        // OpenRouter 实际上游（用于 observeRoute）
    data class Error(val httpStatus: Int, val message: String, val raw: String) : StreamEvent
    /** v1 契约变更 #4：给用户看的提示（如 402「额度不足，已将最大输出降至 N 并重试」），不影响正文 */
    data class Notice(val text: String) : StreamEvent
}

data class ChatOptions(
    val stream: Boolean = true,
    val temperature: Double? = null,
    val maxTokens: Int? = null,
    val thinking: Boolean? = null,
    val jsonMode: Boolean = false,
    val convId: String? = null,           // OpenRouter session_id = orSessionIdFor(convId,'or')
    val cacheControl: Boolean = false,
    val cacheSystemSplit: Int = 0,
    val providerOrder: List<String> = emptyList(),
    val routeSlug: String? = null,
    // ---- v1 契约变更 #2：与 providers.js buildChatRequest 的 opts 一一对应 ----
    /** opts.cacheSystem：false = 不给 system 打 cache_control（JS 默认 undefined ≙ true） */
    val cacheSystem: Boolean? = null,
    /** opts.cacheAffinity：false = 本次不做 OpenRouter 上游钉住（与 provider.cacheAffinity 同时为非 false 才钉） */
    val cacheAffinity: Boolean? = null,
    /** opts.orSort：balanced | price | throughput；null 时回退 provider.orSort */
    val orSort: String? = null,
    /** opts.orGemini / opts.orMiniMax：为 true 时 OpenRouter 请求体**不得**写 session_id（缓存由 gcache/mmcache 插件接管） */
    val orGemini: Boolean = false,
    val orMiniMax: Boolean = false,
    /** opts.routePrices：Router.chooseUpstream 的候选上游价目（endpointRoutePrices 的输出，元素原样 JsonObject） */
    val routePrices: List<JsonObject> = emptyList(),
)

/** 发给模型的消息（由 PluginRegistry 组装；srcId = 来源 Message.id，插件内部用） */
data class WireMessage(val role: Role, val content: String, val images: List<String> = emptyList(), val cacheMark: Boolean = false, val srcId: String? = null)

data class BuiltRequest(val url: String, val method: String, val headers: Map<String, String>, val body: String)

interface ProviderClient {
    /** 纯函数：与 Providers.buildChatRequest 输出 JSON 语义等价（golden 测试比对）。不含认证头。 */
    fun buildChatRequest(provider: ProviderConfig, model: String, messages: List<WireMessage>, systemPrompt: String, opts: ChatOptions,
                         bodyPatch: JsonObject = EmptyJson): BuiltRequest
    /** 发请求并流式解析；冷流，取消协程 = 断开连接。内部处理 OpenRouter 402 按 afford 降 max_tokens 重试一次。 */
    fun stream(provider: ProviderConfig, request: BuiltRequest): Flow<StreamEvent>
    suspend fun listModels(provider: ProviderConfig): Pair<List<String>, JsonObject>   // ids + modelMeta
    suspend fun openRouterEndpoints(provider: ProviderConfig, modelId: String): JsonObject
}

data class ImageRequest(val provider: ProviderConfig, val model: String, val prompt: String, val size: String = "1024x1024", val refImages: List<String> = emptyList())
interface ImageClient {
    fun canGenerate(provider: ProviderConfig?, modelOverride: String?): Result<String>   // 成功 = 生效模型名
    suspend fun generate(req: ImageRequest): Result<List<String>>                        // URL 或 data URL
}

/** router.js 的 Kotlin 版（状态 = router-affinity.json） */
interface ModelRouter {
    fun chooseUpstream(model: String, routePrices: List<JsonObject>, prefixTokens: Long, nowMs: Long): String?
    fun observe(model: String, slug: String, usage: Usage, latencyMs: Long?, ok: Boolean, nowMs: Long)
    fun panelView(model: String): JsonObject
    fun state(): JsonObject
}

/** 发往模型前的可变上下文（plugins.js runBeforeRequest 的 ctx/work 等价物）。插件按注册顺序依次返回新 ctx。 */
data class RequestContext(
    val conv: Conversation,
    val provider: ProviderConfig,
    val model: String,
    val systemPrompt: String,
    val messages: List<WireMessage>,      // 已过滤 error/imageGen/pending；最后一条 = 本轮用户消息（含搜索/文件注入）
    val opts: ChatOptions,
    val settings: AppSettings,
    val lastUserId: String?,
    /** 额外请求体字段，由插件写入并被 ProviderClient 合并进 body（gcache: cachedContent/session_id；mmcache: session_id 等）。
     *  v1 契约变更 #3：合并语义 = RFC 7386 JSON Merge Patch（对象递归合并；值为 null 表示删除该键；数组/标量整体替换）。 */
    val bodyPatch: JsonObject = EmptyJson,
    val meta: JsonObject = EmptyJson,
    val activePlugins: List<String> = emptyList(),
)

/** 回合结果（runAfterResponse 的 result） */
data class TurnResult(val ok: Boolean, val httpStatus: Int, val usage: Usage?, val assistant: Message)

/** action（契约变更 #i）：点击徽章时要打开的面板 id（如 "rpcache.diag"），null = 不可点 */
data class Badge(val plugin: String, val text: String, val tone: String = "info", val detail: String? = null, val action: String? = null)

/**
 * 契约变更 #g：请求体构造之后的改写钩子（gcache/mmcache 需要读 B 已构造好的请求体再合并 system、加 cache_control、替换历史、写 session_id）。
 * ChatEngine 顺序：runBeforeRequest → buildChatRequest(+bodyPatch，构造前补丁) → **PluginRegistry.transformRequest** → 发送。
 */
interface RequestTransformer {
    fun transformRequest(req: BuiltRequest, ctx: RequestContext): BuiltRequest
}

/** 契约变更 #i：插件宿主能力。notify = 给用户的轻提示（toast），由 ChatEngine 转成 StreamEvent.Notice 发给 UI */
interface PluginContext {
    fun notify(text: String)
}
/** dim=true：已冻结进章节，不可切版本/编辑；light=true：较浅的变暗（rp-plugin 445「超出预算暂不发送」，app.js 1381 用 .dim-light，约 .7 不透明度）。
 *  契约变更 #p：light 是插件 messageState 的计算结果，JS 不落盘 */
data class MessageState(val dim: Boolean = false, val label: String? = null, val light: Boolean = false)

/**
 * 插件契约（逐一对应 www/plugins.js 的 hooks）。注册顺序固定 = 旧版脚本加载顺序：
 *   knowledge → rpcache → usage → gcache → mmcache → affect
 * 配置：settings.plugins[id]（全局，含 enabled）+ conv.extras.plugins[id]（对话级 enabled / 插件私有状态）。
 * 激活规则：全局开启 且（对话级显式开启 或 未设置时 autoActive(conv) 为真）。
 * 任何 hook 抛异常：记录到 PluginRegistry.errors（同 plugin+hook+message 合并计数，最多 50 条），不影响主流程。
 */
interface ChatPlugin {
    val id: String
    val name: String
    val defaultEnabled: Boolean
    val perConversation: Boolean
    fun autoActive(conv: Conversation, settings: AppSettings): Boolean = false
    suspend fun onBeforeRequest(ctx: RequestContext, status: (String?) -> Unit): RequestContext = ctx
    fun onResponseUsage(usage: Usage, ctx: RequestContext) {}
    /** 可返回更新后的对话（章节、affect、ledger、插件状态写入 conv.extras.plugins / rpState） */
    fun onAfterResponse(result: TurnResult, ctx: RequestContext): Conversation? = null
    fun messageBadges(msg: Message, conv: Conversation): List<Badge> = emptyList()
    fun headerBadges(conv: Conversation): List<Badge> = emptyList()
    fun messageState(msg: Message, conv: Conversation): MessageState? = null
    /** 契约变更 #g：构造后改写（按注册顺序依次调用，默认原样返回） */
    fun transformRequest(req: BuiltRequest, ctx: RequestContext): BuiltRequest = req
}

interface PluginRegistry : RequestTransformer {
    /** 按注册顺序调用各激活插件的 ChatPlugin.transformRequest */
    override fun transformRequest(req: BuiltRequest, ctx: RequestContext): BuiltRequest = req
    /** ChatEngine 每轮发送前绑定宿主上下文；插件 notify 的文字经它变成 StreamEvent.Notice */
    fun attach(context: PluginContext) {}
    val plugins: List<ChatPlugin>
    fun isActive(id: String, settings: AppSettings, conv: Conversation?): Boolean
    suspend fun runBeforeRequest(ctx: RequestContext, status: (String?) -> Unit): RequestContext
    fun runAfterResponse(ctx: RequestContext, result: TurnResult): Conversation
    fun messageBadges(msg: Message, settings: AppSettings, conv: Conversation): List<Badge>
    fun headerBadges(settings: AppSettings, conv: Conversation): List<Badge>
    fun messageState(msg: Message, settings: AppSettings, conv: Conversation): MessageState
    val errors: StateFlow<List<JsonObject>>
}

/*
 * 契约变更 #h：插件在 RequestContext.meta 里置的 "orGemini" / "orMiniMax"（布尔）由 ChatEngine 复制到
 * ChatOptions.orGemini / orMiniMax，再交给 buildChatRequest（为真时不写 session_id，避免与插件写的冲突）。
 */
/** 会话引擎（A 的 ViewModel 唯一依赖入口，B 实现）：联网搜索 → PluginRegistry.runBeforeRequest → injectNowLine → ProviderClient.stream
 *  → (402 降级重试) → runAfterResponse → UsageRepository.record → ModelRouter.observe → ChatRepository.save */
/*
 * v1 契约变更 #b（与 app.js send/regenerate 一致）：
 *  1. send：先把用户消息写进对话并 ChatRepository.save（流式开始前落盘）；
 *  2. 流开始时创建助手消息（空正文）并发 Started(userMsgId, assistantMsgId)；流式中只更新内存；
 *  3. 正常结束：写入正文/reasoning/usage/finishReason/routeSlug 后 save；
 *  4. 取消（stop 或协程取消）：保留已收到正文，truncated=true，save；
 *  5. 出错：错误文案写进助手消息的 error 字段（与 JS 相同；已收到的正文保留），save，并发 StreamEvent.Error。
 */
interface ChatEngine {
    /**
     * 契约变更 #m：files = 文档附件（已抽取文字），引擎写进用户消息 files[]（AttachmentCodec.encode，与 app.js 一致），
     * 并按 JS toRequestMsg 把文字拼进发给模型的内容——UI 不再自己把文件文字并进 userText。
     */
    fun send(convId: String, userText: String, images: List<String>, files: List<FileAttachment> = emptyList()): Flow<StreamEvent>
    fun regenerate(convId: String, assistantMsgId: String): Flow<StreamEvent>
    fun continueGeneration(convId: String, assistantMsgId: String): Flow<StreamEvent>
    fun stop(convId: String)
}

// ============ 迁移契约（C 提供；D 在 App 启动时调用） ============

data class MigrationReport(val fromVersionCode: Int, val conversations: Int, val keys: Int, val corruptFiles: List<String>,
                           val backupPath: String?, val warnings: List<String>)

interface MigrationService {
    /** 是否需要（store/.native-migrated 不存在且 store/ 下有旧数据） */
    suspend fun needed(): Boolean
    /** 只读校验 + 备份；不改写任何旧文件（就地读取，无需搬运） */
    suspend fun run(): MigrationReport
    /** 导出整个 store/ 为 zip（不含密钥）到 SAF Uri，作为降级/卸载前的兜底 */
    suspend fun exportBackup(target: android.net.Uri): Result<Long>
    suspend fun importBackup(source: android.net.Uri): Result<Int>
}
