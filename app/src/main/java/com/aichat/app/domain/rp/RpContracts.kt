package com.aichat.app.domain.rp

import com.aichat.app.domain.ChatPlugin
import com.aichat.app.domain.model.*
import kotlinx.serialization.json.JsonObject

/*
 * 工作流 C：RP / 缓存 / 知识 / 情绪 / 世界 / 角色卡 领域逻辑。全部为纯 Kotlin（不依赖 Android），放 JVM 单测里与 JS golden 比对。
 * 每个接口注明对应的 JS 源，函数语义 = 同名 JS 函数；数值比对容差 1e-9（相对），字符串必须逐字相等。
 */

/** www/rpcache.js + rp-plugin.js + rpmemory.js（DeepSeek / 千问 RP 缓存优化器 V3，L1–L6 分层） */
interface RpCachePlugin : ChatPlugin   // id = "rpcache"
/** www/plugins/cache/gcache.js（Gemini 显式缓存；最小前缀 Pro 4096 / Flash-Lite 2048 / 其他 1024 Token） */
interface GCachePlugin : ChatPlugin    // id = "gcache"
/** www/plugins/cache/mmcache.js（MiniMax；MIN_TOKENS / STICKY_SEC / session_id = sessionIdFor(convId,'mmcache')） */
interface MmCachePlugin : ChatPlugin   // id = "mmcache"
/** www/knowledge-plugin.js（世界知识库注入） */
interface KnowledgePlugin : ChatPlugin // id = "knowledge"
/** www/affect.js（情绪/关系：观测融合 + 卡尔曼 + CUSUM 五档，K_UP=0.15 K_DN=-0.15 H=0.45 D=4） */
interface AffectPlugin : ChatPlugin    // id = "affect"

/** www/plugins/cache/cache-common.js */
interface CacheCommon {
    fun hash(s: String): String                                   // FNV-1a 32 位 hex
    fun sessionIdFor(convId: String, ns: String): String          // FNV-1a×4 → UUID 形状（'or' 与 providers.js orSessionIdFor 一致）
    fun estTokens(s: String): Int
    fun lcpLen(a: String, b: String): Int
    fun lcpRatio(a: String, b: String): Double
}

/** www/retrieval-core.js：BM25F + 3-gram Jaccard MMR */
interface RetrievalCore {
    fun terms(text: String): List<String>
    fun buildIndex(docs: List<JsonObject>, fieldWeights: Map<String, Double>): Any
    fun bm25f(index: Any, query: List<String>): List<Pair<String, Double>>
    fun mmr(cands: List<Pair<String, Double>>, texts: Map<String, String>, lambda: Double, k: Int): List<String>
    fun pickByBudget(ids: List<String>, tokens: Map<String, Int>, budget: Int): List<String>
}

/** www/knowledge.js：knowledge_world_<worldId>.json 的文档模型、检索、导入导出 */
interface KnowledgeService {
    suspend fun load(worldId: String): JsonObject                 // normalizeDoc 后
    suspend fun save(worldId: String, doc: JsonObject)
    fun search(doc: JsonObject, query: String, limit: Int): List<JsonObject>   // = searchBM25
    fun selectForInject(doc: JsonObject, conv: Conversation, userText: String, budgetTokens: Int): List<JsonObject>
    fun renderInjection(entries: List<JsonObject>): String
    fun parseImport(text: String, fileName: String): JsonObject   // detectImportFormat + parseImport
    fun exportJson(doc: JsonObject): String
    fun exportMarkdown(doc: JsonObject): String
}

/** www/worlds.js：世界模板、block 哈希、漂移检测/三方合并、从全文填入（parseWorldSections / applySectionsToWorld / formatWorldSections） */
interface WorldService {
    fun normalize(raw: JsonObject): World
    fun hashBlock(block: JsonObject): String
    fun makeWorldRef(world: World): JsonObject
    fun detectDrift(conv: Conversation, world: World): JsonObject?
    fun planSync(conv: Conversation, world: World): JsonObject
    fun applySyncToConversation(conv: Conversation, world: World, plan: JsonObject): Conversation
    fun conversationFromWorld(world: World, provider: ProviderConfig, model: String): Conversation
    /** 从全文填入：把粘贴的整段设定按章节标题切成各 block */
    fun parseWorldSections(fullText: String): Map<String, String>
    fun applySectionsToWorld(world: World, sections: Map<String, String>): World
    /** 复制全文 */
    fun formatWorldSections(world: World): String
}

/** www/autochar.js：首条消息自动生成角色卡（settings.autoCharMode: auto | ask | off） */
interface AutoCharService {
    fun shouldOffer(conv: Conversation, settings: AppSettings): Boolean
    fun buildPrompt(userText: String): String
    fun parse(modelOutput: String): JsonObject?
    fun toPromptAppend(card: JsonObject): String
}

/** www/charcard.js：SillyTavern Character Card V2/V3（PNG tEXt "chara"/"ccv3" 块 + JSON） */
interface CharCardCodec {
    fun parseCard(bytes: ByteArray, fileName: String): Result<JsonObject>
    fun cardToPersona(card: JsonObject): Persona
    fun personaToCard(p: Persona): JsonObject
    fun writeCardToPng(card: JsonObject, png: ByteArray?): ByteArray
}
