# AI Chat 原生重写规格（v1.0.0 · Kotlin + Jetpack Compose）

> 基线：`origin/main` f6bdd62（v0.28.7，versionCode 89）· 分支 `feat/native-v1` · 工作树 `/workspace/ai-chat-native`
> **用户决定（最终）：一步到位全原生。v1.0.0 不保留任何内置网页入口，所有功能都用 Kotlin/Compose 重写。**
> 旧前端 `app/src/main/assets/www/` 留在仓库里，只作为**参考实现和 golden 对照的数据源**，已在 Gradle 里排除，不打进 APK（`sourceSets.main.assets.srcDirs = []`）。
> 进度快照（2026-11-14）：[NATIVE_REWRITE_STATUS.md](./NATIVE_REWRITE_STATUS.md)

---

## 0. 结论速览

| 项 | 结论 |
|---|---|
| 覆盖安装 | applicationId `com.aichat.app` 不变；启动组件仍是 `com.aichat.app.MainActivity`；versionCode **100**（> g胖 v0.29.0 的 90）；证书 SHA-256 `6054f9df0a648b7e693e2bc792b41db5b2abc83550445a51f38ecfebe9d7a360`。骨架 APK 已用 apksigner 验证，证书一致 |
| 签名密钥 | 盒子上：`/home/box/.android/debug.keystore`（alias `androiddebugkey`，标准 debug 口令，不写进文档）。`*.keystore` / `*.jks` / `keystore.properties` 已在 `.gitignore`，不进 git |
| 旧数据可达性 | **可直接就地读取，不需要隐藏 WebView 导出，也不需要读 Chromium leveldb。** 安卓上 JS 的所有持久化都经过 `AndroidBridge.storeGet/storeSet/storeAppend`，落在 `filesDir/store/<name>`；localStorage 只在没有原生桥的桌面/浏览器调试时用（app.js `Store`，第 48–94 行）。API Key 在 SharedPreferences `aichat_secrets` 里，用 AndroidKeyStore 别名 `aichat_secrets_v1`（AES-256-GCM）加密；同 UID 覆盖安装后，Keystore 条目和 prefs 都还在，原样复用 `SecretStore.java` 即可解密 |
| 最大风险 | ① conv op-log（oplog-v1）读写兼容；② 发版后无法降级（versionCode 100 → 89/90 会被拒，卸载会清数据），所以**导出备份是必做功能**；③ rpcache/gcache 等数值逻辑的跨语言一致性，靠 golden 对照测试兜住 |
| 骨架 | 已能 `./gradlew assembleDebug` 编译，底部两个 Tab「聊天 / 生图」；领域实体、全部层间接口、FileStore/KeyVault/SSE 的真实实现，以及 3 个 JVM 单测（通过） |
| 工期 | 全原生 25–40 人日（g胖 估算），4 条线并行，按 M1–M4 里程碑推进 |

---

## 1. 现状盘点

### 1.1 代码规模（f6bdd62）
- 自研 JS 34 个文件，约 18.6k 行：app.js 5054、rpcache 1996、conv-log 1072、rp-plugin 1073、knowledge 1010、providers 976、gcache 929、affect 875、rpmemory 730、worlds 723、knowledge-plugin 691、charcard 376、router 329、cost-core 278、usage-stats 253、render-diff 245、files 202、mmcache 193、balance 188、templates 172、retrieval-core 149、imagegen 147、plugins 152、secure 125、search 122、autochar 121、personas 108、versions 95、vscroll 77、cache-common 63、timeutil 41、ui-status 40、netretry 36。
- Java 约 665 行：MainActivity（WebView 壳）、NativeBridge（HTTP 流式 + store + 剪贴板 + 存图）、SecretStore（Keystore 加密）。
- Node 测试：70 个文件，543 项；本分支上 540 通过。失败的 3 项：两项是预期内的版本号检查（`version-sync`、`v017-6`，因为 versionName 已改成 1.0.0-dev，由 D 在 M4 改写）；`boot-smoke` 需要 puppeteer-core，这个工作树没装 node_modules。
- 所有 JS 模块都是 UMD 写法（`module.exports`），**可以在 Node 里直接 require**，这是 golden 对照测试的基础（§6）。

### 1.2 功能清单 → 原生归属与里程碑
按用户决定，**全部是 v1.0.0 必做**；里程碑只表示完成顺序。M1＝能日常聊天，M2＝服务商/缓存行为对齐，M3＝RP 功能对齐，M4＝发版候选。

| # | 功能 | JS 来源 | 线 | 里程碑 |
|---|---|---|---|---|
| F1 | 12 个预设服务商（openai、deepseek、qwen、qwen-intl、moonshot、zhipu、siliconflow、xiaomi、openrouter、anthropic、gemini、custom），3 种请求格式：openai 兼容 / anthropic（cache_control 锚点）/ gemini（`:streamGenerateContent?alt=sse`） | providers.js | B | M1（openai 兼容）/ M2（其余） |
| F2 | SSE 流式解析、reasoning_content、usage 合并（`normalizeUsage`/`mergeUsage`）、非流式、错误解析 | providers.js | B | M1 |
| F3 | 本地 Key：Keystore 加密；按 baseUrl 源绑定，换主机自动清 Key；认证头由原生注入（bearer / x-api-key / x-goog-api-key / X-Subscription-Token）；带 Key 的请求不跟随重定向 | SecretStore + NativeBridge + secure.js | D（KeyVault）/ B（AuthInjector） | M1 |
| F4 | 模型列表拉取、modelMeta（ctx/out/modality/价格）、模型分类、OpenRouter endpoints 最低价同步 | providers.js | B | M2 |
| F5 | OpenRouter：v0.28.7 稳定 `session_id`（`orSessionIdFor(convId,'or')`，FNV-1a×4）、上游钉住 `provider.order`、`orSort`（balanced/price/throughput）、402「can only afford N」按 80% 降 max_tokens 重试一次、`resolveMaxTokens` | providers.js + app.js 2271 | B | M2 |
| F6 | 路由：Beta 后验命中率、有效价、滞回、熔断、延迟 EWMA、空闲粘滞（stickyIdleMs=60min, idleSwitchMargin=0.5）、`router-affinity.json` | router.js | B | M2 |
| F7 | 费用：cost-core（价目、峰谷、EWMA 校准 reconcile、distortedModels）、用量统计页、顶部费用 / 用量浮层（usage popover）、CSV/JSON 导出、余额页（deepseek/siliconflow/moonshot/openrouter） | cost-core / usage-stats / balance | B | M2 |
| F8 | 联网搜索（tavily/bocha/brave/searxng）+ 查询改写 | search.js | B | M2 |
| F9 | 生图页：OpenAI 兼容 `/images/generations`；OpenRouter `/images`（resolution/aspect_ratio + input_references ≤16）；flux 档位；siliconflow image_size；参考图；历史 10 条；保存到相册；聊天里「据此生图」 | imagegen.js + providers.js | B | M1（基础）/ M2（全部） |
| F10 | 对话：列表抽屉、新建/删除/重命名、置顶时间排序、索引损坏时重建 | app.js 786+ | A + D | M1 |
| F11 | 消息渲染：Markdown + 代码高亮、增量渲染、虚拟滚动、图片查看、复制 | app.js / render-diff / vscroll | A | M1 |
| F12 | 编辑消息（全屏编辑器）、重新生成、续写（truncated）、停止、回复版本切换（versions/vi）、对话分支 | app.js 1661–2066 / versions.js | A | M1（编辑/重生成/停止）/ M3（RP 冻结提示） |
| F13 | 附件：图片、文件文本抽取（PDF 用 pdf.js、Word/PPT/Excel、文本类） | files.js | A | M2 |
| F14 | 设置：服务商编辑、系统提示词、温度、max tokens、流式开关、搜索设置、插件开关、外观 | app.js 2803+ | A | M1（核心）/ M2 |
| F15 | 助手库（personas）+ 角色卡 PNG/JSON 导入导出（Character Card V2/V3） | personas / charcard | A（UI）+ C（codec） | M3 |
| F16 | 提示词库（prompts）、提示词模板（templates，含 builtin 合并 / 退役） | personas / templates | A | M2 |
| F17 | 世界模板：7 个 block、版本 + changelog、blockHash、漂移检测、三方合并、同步计划；**从全文填入**（parseWorldSections/applySectionsToWorld）+ 复制全文 | worlds.js | C | M3 |
| F18 | AutoChar：首条消息自动生成角色卡（auto/ask/off） | autochar.js | C | M3 |
| F19 | 知识库：knowledge_world_*.json、BM25F + MMR 检索、按预算注入、导入（多格式）/导出（JSON/NDJSON/MD） | knowledge / retrieval-core / knowledge-plugin | C | M3 |
| F20 | rpcache（DeepSeek/千问 L1–L6 分层、章节冻结与压缩、记忆 rpmemory+ledger、价格/峰谷、自适应摘要、诊断面板） | rpcache / rp-plugin / rpmemory | C | M2（请求拼接）/ M3（章节/记忆/面板） |
| F21 | gcache（Gemini 显式缓存；最小前缀 Pro 4096 / Flash-Lite 2048 / 其他 1024 token；KeepAlive；诊断） | gcache.js | C | M2 |
| F22 | mmcache（MiniMax cache_control、session_id） | mmcache.js | C | M2 |
| F23 | affect：观测融合 + 卡尔曼 + CUSUM 关系五档（K_UP 0.15 / K_DN -0.15 / H 0.45 / D 4） | affect.js | C | M3 |
| F24 | 插件管线 + 徽章（header/message badges、messageState 冻结） | plugins.js | C（registry）/ A（展示） | M2 |
| F25 | 导出/导入：单对话 / 全部对话 JSON（与 exportConvLegacy 同格式）、模板导入、知识库导入导出 | app.js 821 / 4217 | D（数据）/ A（UI） | M2 |
| F26 | **整库备份 / 恢复（必做，新增）**：store/ 打成 zip 存到 SAF；不含 Key | — | D | M1 |
| F27 | 返回键语义（先关浮层/抽屉，再退出） | app.js 4368 | A | M1 |
| F28 | `injectNowLine`（当前时间行）、timeutil | app.js / timeutil | B | M1 |

已不需要的：WebView 缓存清理、`window.onAndroidBack`、JS↔原生 HTTP 桥、`console` 转发。

---

## 2. 持久化数据盘点（全部在 `filesDir/store/`，即 `/data/data/com.aichat.app/files/store/`）

写入语义（NativeBridge.storeSet，原生必须完全一致，已在 `JsonFileStore` 实现）：文件名把 `[^A-Za-z0-9_.-]` 替换成 `_`；先写 `name.tmp` 并 fsync，旧文件改名为 `name.bak`（`.jsonl` 和 `.bak` 除外），再把 tmp 改名为正式文件。`storeAppend` 是追加写。读到损坏的 JSON 时：先把坏文件改名为 `name.corrupt-<ts>` 留底，再尝试用 `.bak` 恢复（`Secure.corruptName`）。

| 文件 | 形状（要点） | 读写方 |
|---|---|---|
| `settings.json` | `defaultSettings()` 合并后的对象：`providers[]`（id, presetId, name, type, baseUrl, models[], imageModel/videoModel/embeddingModel/speechModel/transcriptionModel, hasKey, thinking, streamUsage, cacheAffinity, orSort, modelMeta{}）、systemPrompt、stream、temperature（`''` = 未设）、maxTokens（`''`/数字）、imageSize、imageGenProviderId、imageGenModel、lastProviderId、lastModel、settingsVersion（当前 2，`Providers.migrateSettings`）、search{provider,hasKeys,urls,count,rewrite}、searchOn、removedPersonas/removedTemplates、recentTemplates/Worlds/Personas、drawerCollapsed、showTopCost、deferHighlight、settingsTab、autoCharMode、autoCharV084、**plugins{rpcache,gcache,mmcache,knowledge,affect,usage: {enabled,…私有配置/价格}}** | D（仓库）；C 解读 plugins |
| `convs.json` | `[{id,title,providerId,model,updatedAt,personaName?,personaEmoji?}]`，按 updatedAt 降序；缺失或损坏时用 `ConvLog.listConvIds` + `loadMeta` 重建 | D |
| `conv_<id>.json` | 旧格式全文 `{id,title,providerId,model,createdAt,updatedAt,messages[],systemPrompt?,temperature?,personaName?,plugins{},chapters?,affect?,affectBy?,ledger?,worldRef?,worldLog?,worldPending?,kb?,…}`；或者 oplog-v1 元数据指针 `{format:"oplog-v1",…}` | D（ConvLogCodec） |
| `conv_<id>.snap.json` | 快照 `{upToLamport, meta{…}, messages, order, chapters（content 可能是 contentZ = base64(zlib)）, affect, affectBy, ledger, worldRef, worldLog, worldPending, kb, tombstones, stamps, clock}` | D |
| `conv_<id>.log.jsonl` | 每行一个 op：`{lamport,dev,op,payload}`；op 共 15 种：msg.add/edit/remove/delete/reorder、chapter.commit/edit/remove、affect.set、affect.by、ledger.append、worldRef.set、worldLog.append、meta.set、kb.upsert。按 (lamport, dev) 后写覆盖，被覆盖的值进 `_conflicts`。日志 ≥200 op 或 ≥1 MiB 时压缩成快照 | D |
| `device-id.json` | 本机 dev id（op 的 dev 字段） | D |
| `rplog_<id>.jsonl`（旧版 `rplog_<id>.json`） | rpcache 每轮请求日志 `makeLogEntry` | C |
| `rp-memory.json` | rpmemory 全局状态 | C |
| `knowledge_world_<worldId>.json` | 知识库文档 `{categories[], entries[]…}`（normalizeDoc） | C |
| `personas.json` / `prompts.json` / `templates.json` / `worlds.json` | 各 normalize* 形状（见 `domain/model/Models.kt`）；builtin 用 mergeBuiltins 合并，用户删掉的记在 settings.removed* | D（仓库）/ C（worlds 语义） |
| `usage-stats.jsonl` + `usage-stats-meta.json` | 用量日志（LOG_LIMIT 压缩）+ meta{prices, priceMode, calib…}；旧的 `usage-stats.json` 迁移后改名为 `.migrated` | D（仓库）/ B（语义） |
| `router-affinity.json` | `{ [model]: { current, upstreams{slug:{a,b,lat,fail,…}}, switches… } }` | B |
| `balance-cache.json` | `{ [providerId]: { at, result } }` | B |
| `*.bak` / `*.corrupt-*` / `*.migrated` | 原样保留，不清理 | — |

**Key**：SharedPreferences `aichat_secrets`。`s:provider_key:<id>` / `s:search_key:<id>` 为 `base64(iv):base64(ct)`；`o:<name>` 是绑定的源；`r:<id>` 和 `r:search:<id>` 是 `baseUrl\nauthType`。AndroidKeyStore 别名 `aichat_secrets_v1`。**明文永远不进入实体、日志或备份。**

其余 SharedPreferences：`aichat_webview`（cache_ver，可忽略）。WebView 自己的 `app_webview/`（localStorage/IndexedDB）**安卓上没有业务数据**，不用读；v1 也不删除，留着无害。

### 2.1 迁移设计（MigrationService，D 所有）
1. **不搬家，原地沿用**：原生仓库直接读写 `filesDir/store/` 下的同名文件和同一种格式。这样迁移本身就是「零拷贝」，旧数据和新写入的数据格式一致。
2. 首次启动时，如果 `store/.native-migrated` 不存在，并且 `store/` 里有旧文件：
   a) **先备份**：把整个 `store/` 打成 zip 写到 `filesDir/backup/pre-native-<ts>.zip`（不含 Key），再提示用户另存到 SAF；
   b) 只读体检：每个 JSON 都解析一遍，`ConvLogCodec.load` 每个对话都 replay 一遍，统计损坏文件（损坏的按旧规则改名 `.corrupt-*`、用 `.bak` 恢复）；
   c) `settings.json`：跑 `migrateSettings`（settingsVersion → 2）和 autoCharV084；`usage-stats.json` 转成 jsonl；
   d) 检查 Key：对每个 provider 调 `KeyVault.has`，再试解密一次（不输出明文），失败的标记为「需要重新填写」；
   e) 写入 `.native-migrated`（`{fromVersionCode, at, report}`）。
3. 失败时不阻塞启动：报告显示在设置 →「数据与备份」，原文件不动。
4. **导出备份（必做）**：设置 →「数据与备份」→ 导出整库 zip / 导入 zip（导入前先自动备份当前数据）。同时保留旧版的单对话 / 全部对话 JSON 导出。**升级须知**：v1 装上以后就不能再覆盖安装 0.x 版；回退的唯一路径是导出 zip → 卸载 → 装旧版 → 导入（旧版的导入路径由 D 在 M4 验证并写进 Release 说明）。

---

## 3. 架构

### 3.1 模块与包（单个 `:app` 模块）
单模块：盒子上可用内存约 5G，多模块会增加 Gradle 配置和内存开销。包边界就是所有权边界，靠 review 守住。

```
com.aichat.app
├─ MainActivity.kt / AiChatApp.kt(AppGraph 手写 DI)     D（A 可改 MainActivity 的 setContent）
├─ SecretStore.java                                      D（加密格式冻结，禁止修改）
├─ ui/  AppRoot.kt(底部 Tab) theme/                     A
│   ├─ chat/  conversation/  settings/  library/(personas,prompts,templates)  common/(markdown,editor)   A
│   ├─ image/  usage/(浮层、用量页、余额页)              B
│   └─ rp/ (世界编辑器+从全文填入、知识库管理、rpcache/gcache/mmcache/affect 面板、AutoChar 对话框)   C
├─ domain/
│   ├─ model/Models.kt              实体（D 所有，改动需要 A/B/C 都 review）
│   ├─ Contracts.kt                 层间接口（D 所有，同上）
│   ├─ cost/                        B
│   └─ rp/                          C
├─ net/   OkHttp、SSE、ProviderClient 实现、ImageClient、Router、Search、Balance、AuthInjector    B
├─ engine/ ChatEngine 实现（发送管线）                  B
├─ plugins/ PluginRegistry 及 6 个插件实现              C
└─ data/  store/ secret/ convlog/ codec/ repo/ migration/ backup/    D
```

### 3.2 版本（已验证可在 AGP 8.5.2 / Gradle 8.7 / compileSdk 34 上编译）
- AGP 8.5.2，Gradle wrapper 8.7，JDK 17（`JAVA_HOME=/home/box/jdk17`），compileSdk/targetSdk 34，minSdk 24
- Kotlin 2.0.21 + `org.jetbrains.kotlin.plugin.compose` 2.0.21 + `plugin.serialization` 2.0.21
- Compose BOM 2024.09.03（material3、material-icons-core），activity-compose 1.9.2，lifecycle 2.8.6，core-ktx 1.13.1
- kotlinx-coroutines 1.8.1，kotlinx-serialization-json 1.7.3，OkHttp 4.12.0
- **不引入 Room / Hilt / KSP**：存储格式必须保持旧的 JSON 文件；KSP 会增加构建内存。需要额外的库（例如 Markdown 渲染、PDF 文本抽取）时，先在 spec PR 里登记，避免两条线各自引入
- 新依赖不得要求 compileSdk 35；需要时由 D 统一升级

### 3.3 层间契约（代码在 `domain/Contracts.kt`、`domain/model/Models.kt`、`domain/rp/`、`domain/cost/`、`data/convlog/`）
- 数据（D 提供）：`ChatRepository`、`SettingsRepository`、`LibraryRepository`、`KeyVault`、`UsageRepository`、`MigrationService`、`ConvLogCodec`、`FileStore`
- 网络和引擎（B 提供）：`ProviderClient`（`buildChatRequest` 纯函数 + `stream(): Flow<StreamEvent>`）、`ImageClient`、`ModelRouter`、`ChatEngine`、`CostCore`、`UsageStats`、`SearchClient`、`BalanceClient`
- 插件和 RP（C 提供）：`ChatPlugin` / `PluginRegistry`（hook 与 plugins.js 一一对应，注册顺序固定为 knowledge → rpcache → usage → gcache → mmcache → affect）、`RpCachePlugin`/`GCachePlugin`/`MmCachePlugin`/`KnowledgePlugin`/`AffectPlugin`、`CacheCommon`、`RetrievalCore`、`KnowledgeService`、`WorldService`、`AutoCharService`、`CharCardCodec`
- UI（A）只依赖：仓库的 StateFlow + `ChatEngine` + `PluginRegistry` 的徽章 / 状态查询，**不直接调用 net 或 data 的实现类**

硬性约定：
1. **无损往返**：实体都带 `extras: JsonObject`，未建模的键原样保留。写回只能经过 `data/codec` 的 Codec，禁止用「只含已建模字段」的对象覆盖旧文件。D 的测试：每个真实旧文件 decode → encode 后，与原文件 JSON 语义相等。
2. **请求体等价**：`buildChatRequest` 的输出，与 JS `Providers.buildChatRequest` 对同一输入的输出，做 JSON 语义比较必须相等；`messages[*].content` 和 `system` 的字符串必须逐字相等（缓存前缀是否稳定就取决于这一点）。
3. **线程**：仓库和网络都是 suspend / Flow，跑在 IO 上；FileStore 内部有锁；ChatEngine 对同一对话串行执行。
4. **取消**：取消协程 = 断开 OkHttp call，效果等同于旧版 `cancel(id)`；已收到的正文保留，并设 `truncated=true`。
5. **认证**：只有 `net.AuthInjector` 可以调 `KeyVault.keyFor(providerId, url)`；请求地址的源和登记的 baseUrl 源不一致时直接拒绝；调用方传进来的认证头一律丢掉；带 Key 的请求 `followRedirects=false`。

### 3.4 契约变更记录（整合者裁定，2026-11-13，native/D 落地；A/B/C 请 rebase）
| # | 变更 | 位置 |
|---|---|---|
| 1 | `Usage` 新增 `upstreamCost: Double?`、`cacheSaved: Double?`、`raw: JsonObject?`（服务商原始 usage JSON） | `domain/model/Models.kt` |
| 2 | `ChatOptions` 新增 `cacheSystem: Boolean?`、`cacheAffinity: Boolean?`、`orSort: String?`、`orGemini`、`orMiniMax`（Boolean，默认 false）、`routePrices: List<JsonObject>`，与 `providers.js` 的 opts 同义。**orGemini 或 orMiniMax 为真时，OpenRouter 请求体不得写 `session_id`** | `domain/Contracts.kt` |
| 3 | `RequestContext.bodyPatch` 合并语义 = **RFC 7386 JSON Merge Patch**：对象递归合并；值为 `null` 表示删除该键；数组与标量整体替换。ProviderClient 负责应用（`buildChatRequest(..., bodyPatch)`） | `domain/Contracts.kt` |
| 4 | `StreamEvent.Notice(text)`：用户可见提示（如 402「额度不足，已将最大输出降至 N 并重试」） | `domain/Contracts.kt` |
| 5 | `KeyVault.registration(providerId): ProviderRegistration?`（baseUrl、origin、authType）。未登记时 ProviderClient 必须失败并报旧版文案「服务商未登记」，绝不无 Key 发出 | `domain/Contracts.kt`、`data/secret/SecretKeyVault.kt` |
| 6 | 测试 HTTP 服务器继续用 B 手写的 `TinySseServer`，**不引入 mockwebserver** | — |
| 7 | golden 目录：B 的向量暂留 `app/src/test/resources/net-golden/`（导出脚本同目录），D 的框架在 `tests/golden-export/` + `app/src/test/resources/golden/`，后续由 D 统一 | §6 |
| a | `AppGraph` 暴露 `chats` / `settings` / `library` / `keys` / `engine` / `plugins` / `migration`，另有 `usage`、`convLog`、`knowledgeStore`、`rpLogStore`、`routerStateStore`、`balanceCacheStore`、`rpMemoryStore`、`migrationReport`。`engine`/`plugins` 合并前是占位（`UnwiredChatEngine` / `EmptyPluginRegistry`）。纯 JVM 组装在 `data/DataGraph`（测试用 `DataGraph.inMemory()`） | `AiChatApp.kt`、`data/DataGraph.kt` |
| b | `ChatEngine.send` 语义同 JS：流式前先存用户消息；流开始建助手消息；结束时存；取消时 `truncated=true` 存；出错把文案写进助手消息 `error` 字段再存 | `domain/Contracts.kt`（注释） |
| c | `StreamEvent.Started(userMsgId, assistantMsgId)` 为事件流第一个事件 | `domain/Contracts.kt` |
| d | `AppSettings` / `ProviderConfig` 结构归 D。所有键与 JS settings.json 同名同位置；新增建模字段 `removedPresets`、`removedPersonas`、`removedTemplates`、`autoCharMode`、`autoCharV084`（顶层键）。未建模键经 Codec 原样往返（extras + 影子规则，见 `data/codec/Codecs.kt`）。`PromptSnippet` / `PromptTemplate` 补 `extras`（默认空，源码兼容） | `domain/model/Models.kt` |
| e | `app/build.gradle` 加 `androidTestImplementation` ui-test-junit4 / androidx.test.ext:junit / androidx.test:runner，`debugImplementation` ui-test-manifest | `app/build.gradle` |
| f | `.gitignore` 加 `.kotlin/` | `.gitignore` |
| g | `RequestTransformer.transformRequest(req, ctx)`：`PluginRegistry` 实现（默认原样），`ChatPlugin.transformRequest` 默认原样。ChatEngine 在 `buildChatRequest` 之后、发送之前调用；`bodyPatch` 仍用于构造前补丁 | `domain/Contracts.kt` |
| h | 插件写的 `ctx.meta["orGemini"]` / `ctx.meta["orMiniMax"]` 由 ChatEngine 复制进 `ChatOptions.orGemini` / `orMiniMax` | `domain/Contracts.kt`（注释） |
| i | `Badge.action: String?`（点击打开的面板 id）；`PluginContext.notify(text)`，`PluginRegistry.attach(context)`，ChatEngine 把 notify 转成 `StreamEvent.Notice` | `domain/Contracts.kt` |
| j | C 的 golden 放 `tests/golden-export/` + `app/src/test/resources/golden/` 为正式布局；B 的 `net-golden/` 之后由 D 迁入 | §6 |
| k | 缓存适配器配置与 JS 同键同位置：JS 放在 provider 对象上（如 `cacheAdapter`），原生读 `ProviderConfig.extras`，Codec 保证往返 | `data/codec/Codecs.kt`（测试 `CodecRoundTripTest`） |
| m | `ChatEngine.send(convId, userText, images, files: List<FileAttachment> = emptyList())`；`FileAttachment` 键名同 app.js `user.files[]`（name/size/kind/text/total/truncated/pages?/scanned?/imagePages?），`AttachmentCodec` 互转。引擎负责写 files[] 并拼进请求，UI 不再把文件文字并进正文 | `domain/Contracts.kt`、`domain/model/Models.kt` |
| n | `AppSettings.recentTemplates` / `recentWorlds` / `recentPersonas`（app.js 199 顶层键）。JS 没有 `removedPrompts`，不加 | `domain/model/Models.kt` |
| o | 对话模板：`Conversation.templateId` / `templateName` / `templateEmoji`（顶层键，清除 = 三个都置 null，编码时删键）。每对话插件开关与数据不建模：`conv.extras["plugins"][id] = { enabled?: Boolean, … }`，enabled 缺失 = 跟随全局 `settings.plugins[id].enabled` | 同上 |
| p | `MessageState.light: Boolean = false`（与 `dim` 同时为 true = 浅淡化，rp-plugin.js 445 `{dim:true, light:true}` → app.js `.dim-light`）。运行时计算，不落盘 | `domain/Contracts.kt` |
| q | `DataGraph.charCard` / `AppGraph.charCard: CharCardCodec?`（可空插槽，默认 null；C 实现后在 AiChatApp 里赋值） | `data/DataGraph.kt`、`AiChatApp.kt` |
| — | 接线备忘（AppGraph，D 负责）：C 的 worlds 开聊需要全局内置模板（JS `Templates`）——C 留了模板接口与全局挂载点，接线时由 D 用 `LibraryRepository.templates`（含 builtins.json 内置模板、按 removedTemplates 合并）实现并挂上；C 保持 RpContracts 不变、自带适配层 | — |
| r | 行为修正（无签名变化）：`MigrationService` 的 Key 体检现在也检查 `settings.search.hasKeys` 里的搜索 Key（`search:<id>`），缺失同样给一条警告、计入 `report.keys` | `data/migration/StoreMigrationService.kt` |


### 3.5 行为对齐政策与有意差异（契约变更 #l）
**v1.0.0 = 与 JS v0.28.7 行为对齐（parity）。** 任何有意偏离都必须登记在下表，并附测试或理由；没登记的差异一律按 bug 处理。

| # | 有意差异 | 原因 | 所在 |
|---|---|---|---|
| D1 | OpenRouter 402「can only afford N」重试时，只把已构造请求体里的 `max_tokens` 改成 80%（最低 256），不重新走 runBeforeRequest / buildChatRequest | JS 整体重建会让插件统计（rpcache/gcache/usage）重复计数一次 | B `net/` |
| D2 | conv-log 章节 `contentZ`：Kotlin 用 java.util.zip.Deflater(6)，JS 用 fflate；字节可能不同，互相可解；「压缩后不短于原文就不压」的判定因此个别不同 | 平台无 fflate；replay 结果不受影响（golden 双向验证） | D `data/convlog/JsConvLog.kt` |
| D4 | `Personas.mergeBuiltins` 的 normalize：基本字段与 JS 一致，角色卡字段（loreText/firstMes/mesExample/alternateGreetings/cardSpec/cardRaw）为假 / 空数组时丢弃（同 JS，M3 回归发现后修正）；其余未知字段保留在 extras（JS 会丢） | 无损约定（§3.3-1）；JS 读到多余字段无害 | D `data/repo/Repositories.kt` |
| D5 | 保存对话时，上次状态里有值、这次缺失的**消息顶层键**显式写 `null`（truncated/error/finishReason/vi…） | conv-log `msg.edit` 是 Object.assign 合并，缺键不删；JS 里 `delete m.truncated` 后重启会复活（JS 潜在 bug），原生 Codec 省略默认值也会撞上。JS 读这些键都是真假判断 / `vi\|0`，null 与缺键等价 | D `FileChatRepository.save` |
| D6 | 字符串排序：JS `localeCompare` 在 Kotlin 侧用 `String.compareTo`（码点序）。conv-log 的 op 名排序两者结果相同（全是小写 ASCII + 同位 `.`，已核对 13 个 op 名），不影响回放；**用户可见**的是 knowledge.js 的分类名 / 条目标题 `localeCompare(…, 'zh')`（拼音序）与 providers.js 模型 id 排序——这些若在原生 UI 里重做，应使用 `java.text.Collator.getInstance(Locale.CHINESE)`，不要用码点序 | ICU 与码点序在中文、大小写上不同 | A/C（UI 排序）；D 无落盘排序 |
| D3 | conv-log 在 JS 会抛 TypeError 的畸形数据上（如快照缺 tombstones.msg；C：RP 对话状态缺 `blocks` 时读设定块，JS 抛错、Kotlin 返回空块），Kotlin 按「缺失 = 空对象」继续 | 不让坏数据阻塞启动；正常数据行为一致 | D 同上 |
| D7 | 错误文案：角色卡非法 base64（atob）与 zTXt 解压失败（fflate inflate，不校验 Adler-32）的报错**原文**不要求与 JS 逐字一致，只要求同一位置报错；golden 里归一化为 `<atob>` / `<inflate>` | 原文随 WebView 引擎和 fflate 版本变化 | C `domain/rp` 角色卡解析 |

**v1 之后再议（不在 v1.0.0 做）**：① 续写时【续写】后缀从 system 末尾移到追加的 user 消息（保住缓存前缀，属于行为变更）；② OpenRouter `provider.order` 钉住上游与 session_id 粘滞的冲突诊断（mmcache 诊断降级或缓存插件生效时不钉住）。

---

## 4. JS 算法：移植到 Kotlin，还是嵌入 JS 引擎？
**结论：全部移植到 Kotlin**（这也是用户的决定），用 golden 对照测试保证一致性，**不嵌入 JS 引擎**。
- 理由一：用户要求 v1.0.0 一步到位纯原生，不留网页入口。
- 理由二：`androidx.javascriptengine` 要求 API 26+ 并且设备 WebView 支持 isolate（`isSupported()`）；而 minSdk 是 24，还得再写一套隐藏 WebView 回退。这样就成了两套运行时，调试和性能都更差，在聊天热路径上还要多一次 IPC。
- 理由三：被移植的模块本来就是纯函数 UMD，输入输出都是 JSON，不依赖 DOM（rpcache、gcache、router、cost-core、retrieval-core、affect、worlds、conv-log 都已在 Node 里单测），适合逐函数翻译，并逐函数生成对照向量。
- 风险控制：数值逻辑（EWMA、Beta 后验、卡尔曼 / CUSUM、BM25F、MMR、价格 / 峰谷）按 §6 的 golden 向量逐项比对，相对误差 ≤1e-9；字符串拼接（rpcache 的 L1–L6、gcache 的前缀、世界全文）必须逐字相等。

---

## 5. 工作流拆分（4 条线并行）

各线都在 `feat/native-v1` 上拉子分支（`feat/native-a-*`、`-b-*`、`-c-*`、`-d-*`），由 D 合并。合并前须满足：`./gradlew assembleDebug testDebugUnitTest` 通过，且没有改动别的线所有的文件。改动 `domain/model` 或 `domain/Contracts.kt` 时，要在 PR 描述里 @ 所有线。

### A：骨架 + 底部 Tab + 聊天 UI + 对话列表 + 设置 UI（建议：BErt）
- **拥有文件**：`ui/AppRoot.kt`、`ui/theme/`、`ui/chat/`、`ui/conversation/`、`ui/settings/`、`ui/library/`、`ui/common/`（Markdown、代码高亮、全屏编辑器、图片查看）；文件文本抽取 `data/files/`（files.js 的移植，PDF/Office/文本）
- **消费**：`ChatRepository.index/load`、`ChatEngine.send/regenerate/continueGeneration/stop`、`SettingsRepository`、`LibraryRepository`、`KeyVault.has/set/delete`（只在服务商编辑页用）、`PluginRegistry.messageBadges/headerBadges/messageState`、`MigrationService.exportBackup/importBackup`（设置页入口）
- **提供**：导航壳；`ui/rp/*` 和 `ui/image/*`、`ui/usage/*` 的挂载点（`SettingsDestinations` 枚举 + 聊天顶栏菜单回调）
- **里程碑**
  - M1：底部「聊天 / 生图」Tab，切换时保留状态；对话抽屉（列表、新建、删除、重命名）；消息列表（Markdown、流式增量、停止、复制）；输入区（文字 + 图片）；服务商 / 模型快速切换；设置的服务商编辑（Key 掩码 `••••••••（已保存）` 语义：不改 = 保留、清空 = 删除）；返回键语义；「数据与备份」入口
  - M2：编辑消息、重新生成、续写、版本切换 ‹ n/m ›、分支；文件附件和抽取；提示词库 / 模板库；搜索开关和搜索设置；插件开关页；用量浮层挂载点
  - M3：助手库 + 角色卡导入导出（调用 C 的 CharCardCodec）；RP 冻结消息的禁用状态和确认框（VER_RP_WARN 文案）；徽章展示
  - M4：深浅色、大字体、横屏、键盘遮挡、长对话（≥2000 条）滚动性能
- **验收**：Compose UI 测试（`createAndroidComposeRule`）覆盖 Tab 切换、发送 / 停止、编辑、版本切换；在模拟器上导入 v0.28 真实数据后，对话列表和消息与旧版截图一致（`docs/*.png` 是旧版对照图）

### B：网络 / 服务商 / 流式 / 路由 / 费用 + 生图页（建议：g胖，openrouter 负责审查 OpenRouter 相关部分）
- **拥有文件**：`net/`、`engine/`、`domain/cost/`、`ui/image/`、`ui/usage/`（用量页、余额页、费用浮层）
- **移植来源**：providers.js、router.js、cost-core.js、usage-stats.js、balance.js、search.js、imagegen.js、netretry.js、timeutil.js，以及 app.js 1887–2400 的发送管线
- **消费**：`KeyVault.keyFor/authType`（只在 AuthInjector 里用）、`SettingsRepository`、`ChatRepository.save`、`UsageRepository`、`PluginRegistry.runBeforeRequest/runAfterResponse`、`FileStore`（router-affinity.json、balance-cache.json，经 D 提供的小仓库）
- **提供**：`ProviderClient`、`ImageClient`、`ModelRouter`、`ChatEngine`、`CostCore`、`UsageStats`、`SearchClient`、`BalanceClient`、`StreamEvent`
- **ChatEngine 管线顺序**（照搬 app.js）：取 lastUser → 联网搜索（含改写）→ 组装 RequestContext（过滤 error/imageGen/pending；`resolveMaxTokens`）→ `runBeforeRequest` → `injectNowLine` →（续写时追加 assistant 正文 +「请从上次中断处继续…」）→ `buildChatRequest(+bodyPatch)` → OpenRouter 规划（`planOpenRouterRoute`）→ stream → 402 且未收到任何 delta → 按 `parseAffordTokens` 的 80% 降级重试一次 → `runAfterResponse` → 记录用量 → `observeRoute` → 保存
- **里程碑**
  - M1：OkHttp + SSE（`net/Sse.kt` 已有）；openai 兼容流式 + usage；AuthInjector；ChatEngine 的基础管线（插件先空跑）；生图基础（OpenAI 兼容）
  - M2：anthropic（cache_control 锚点 `claudeCacheAnchors`）、gemini；模型列表和 meta；OpenRouter session_id / 钉住 / orSort / 402；Router 全部功能；CostCore / UsageStats / 余额 / 搜索；生图全部（OpenRouter `/images`、flux 档位、siliconflow、参考图、历史、存相册、聊天里「据此生图」）
  - M3：用量页、CSV 导出、价格刷新按钮、校准视图
  - M4：弱网、断流、超时（读超时 600s，同旧版）、取消时不泄漏连接
- **验收**：golden 对照覆盖 `buildChatRequest`（三种格式 × 是否带图 × 是否 cacheControl × OpenRouter 钉住 / sort / session）、`createStreamParser`（用录制的真实 SSE 分片，喂入时随机切分）、`normalizeUsage`/`mergeUsage`、`buildImageRequest`/`parseImageResponse`、router 的 `chooseUpstream`/`observe`/`replay`（含空闲粘滞）、cost-core 的 `costOf`/`reconcile`；MockWebServer 集成测试 402 重试和取消

### C：缓存插件 rpcache/gcache/mmcache + 知识库 + affect + 世界 / AutoChar 领域逻辑（建议：新开一个 Bot，或由 openrouter 兼任 gcache/mmcache）
- **拥有文件**：`plugins/`（PluginRegistry + 6 个插件，含 usage 插件）、`domain/rp/`、`ui/rp/`
- **移植来源**：plugins.js、rpcache.js、rp-plugin.js、rpmemory.js、plugins/cache/{cache-common,gcache,mmcache}.js、knowledge.js、knowledge-plugin.js、retrieval-core.js、affect.js、worlds.js、autochar.js、charcard.js
- **消费**：`RequestContext`/`TurnResult`、`CostCore`（rpcache 的价格 / 峰谷）、`FileStore`（rplog_*、rp-memory.json、knowledge_world_*，经 D 提供的仓库）、`LibraryRepository.worlds`、`ChatRepository`（conv.extras.plugins / rpState）
- **提供**：`PluginRegistry` 及各插件、`CacheCommon`、`RetrievalCore`、`KnowledgeService`、`WorldService`、`AutoCharService`、`CharCardCodec`，以及 RP 相关界面
- **里程碑**
  - M1：PluginRegistry 空实现，hook 顺序和错误收集就位；CacheCommon（hash/sessionIdFor 与 JS 逐字一致）
  - M2：rpcache 的请求拼接（L1–L6，章节只追加、记忆增量放尾部）；gcache（前缀阈值、cachedContent、KeepAlive、诊断）；mmcache；usage 插件；徽章
  - M3：rpcache 的章节摘要和冻结、rpmemory + ledger、诊断 / 预算面板；知识库（BM25F + MMR、导入导出、管理界面）；affect（KF + CUSUM、状态面板）；世界模板编辑器（7 个 block、版本、漂移 / 同步、**从全文填入**、复制全文、开场白）；AutoChar；角色卡 codec
  - M4：用 v0.24 / v0.28 的真实 RP 对话回放，命中率曲线与旧版一致
- **验收**：每个插件的 `onBeforeRequest` 对同一 ctx 的输出，与 JS 的 golden 结果比对：system / messages 逐字相等，bodyPatch 语义相等；affect / retrieval / router 的数值误差 ≤1e-9；`parseWorldSections` 用旧版测试 `tests/worlds.test.js`、`world-merge.test.js` 的全部用例

### D：数据层 / op-log / 迁移 / 备份 + 整合 / golden 测试 / 签名 / 发版（主 Bot）
- **拥有文件**：`AiChatApp.kt`（AppGraph）、`SecretStore.java`、`data/**`（store、secret、convlog、codec、repo、migration、backup）、`domain/model/`、`domain/Contracts.kt`、`app/build.gradle`、`build.gradle`、`gradle.properties`、`tests/golden-export/`（Node 侧导出脚本）、`app/src/test/resources/golden/`、`docs/NATIVE_REWRITE_SPEC.md`、CHANGELOG、README
- **提供**：所有仓库接口、`ConvLogCodec`、`MigrationService`、备份；DI 组装；golden 测试框架；发版
- **里程碑**
  - M1：Codec（无损往返）+ Settings / Library / Chat 仓库；ConvLogCodec 的 load（快照 + 日志 replay + 旧 json + contentZ 解压）和 commit（diff → 追加 op、压缩）；迁移的体检和备份；整库备份 / 恢复；能出 M1 的 debug APK
  - M2：golden 导出脚本覆盖 B/C 的全部纯函数；CI 命令 `./gradlew testDebugUnitTest` 加上 `node tests/golden-export/run.mjs --check`；Usage 仓库（jsonl 压缩）
  - M3：模拟器回归（API30 + API34）：先装 v0.24.x 和 v0.28.7 旧版 APK（盒子上 `/workspace/ai-chat-v0.2x.x-debug.apk`），造数据或导入真实数据，再覆盖安装原生版，检查对话 / 设置 / Key / 世界 / 知识库全部可用，以及新写入后旧数据仍能 replay
  - M4：版本 1.0.0（versionCode 100）；release 构建签名（keystore.properties 只放在盒子本地，指向 `/home/box/.android/debug.keystore`）；apksigner 核对证书 SHA-256；Release 说明写上「不可降级 + 先导出备份」；**发布 GitHub Release 需要用户确认后再执行**
- **验收**：真实旧数据的 decode → encode 往返不丢字段；ConvLogCodec 对同一份 store 的 load 结果与 JS `ConvLog.load` 结果 JSON 相等，并且 Kotlin commit 写出的文件能被 JS 正确 replay（双向）；覆盖安装后 Key 能直接用（不用重新填写）

---

## 6. 跨语言 golden 对照测试（D 搭框架，B/C 补用例）
1. **Node 侧导出器** `tests/golden-export/*.mjs`：直接 `require('../../app/src/main/assets/www/xxx.js')`，对一组输入（固定的、来自旧测试的、随机生成的，随机种子固定）调用 JS 函数，写成 `app/src/test/resources/golden/<module>/<fn>.jsonl`，每行 `{"in":[…],"out":…}`。
2. **Kotlin 侧**：`GoldenTest` 基类逐行读取，调用对应的 Kotlin 实现，比对规则是数字相对误差 ≤1e-9、字符串逐字相等、对象按 JSON 语义比较（键顺序无关）。
3. 必须覆盖：providers（buildChatRequest / createStreamParser / normalizeUsage / buildImageRequest / orSessionIdFor / resolveMaxTokens / parseAffordTokens / planOpenRouterRoute / observeRoute）、router（全部 api）、cost-core、usage-stats、cache-common、gcache.applyToRequest、mmcache.applyToRequest、rpcache 的 buildContext 及章节 / 摘要相关函数、rpmemory、retrieval-core（bm25f / mmr / pickByBudget）、knowledge（search / selectForInject / renderInjection / parseImport）、affect（KF / CUSUM 全序列）、worlds（parseWorldSections / applySectionsToWorld / formatWorldSections / merge3 / detectDrift / planSync）、autochar、charcard、conv-log（load / commit / replay / compact）、versions、secure.originOf。
4. 时间、随机数、uid 都要注入（Clock / IdGen 参数），导出时固定下来。
5. 保留旧版 70 个 Node 测试作为 JS 参考实现的回归（`npm test`）；`version-sync` 和 `v017-6` 由 D 在 M4 改为检查原生版本号。

---

## 7. 构建与环境
```bash
cd /workspace/ai-chat-native
cp /workspace/ai-chat-world-paste-0287/local.properties .   # sdk.dir=/home/box/Android/Sdk（已复制，已 gitignore）
export JAVA_HOME=/home/box/jdk17
./gradlew --no-daemon assembleDebug testDebugUnitTest      # 内存约 5G，请用 --no-daemon，一次只跑一个 Gradle
```
- gradle.properties：`org.gradle.jvmargs=-Xmx2048m`，`kotlin.daemon.jvmargs=-Xmx1024m`
- 骨架首次构建（含依赖下载）约 70 秒；APK 约 10 MB，不含 www 资源
- 模拟器有 API30 / API34；同一时间最多开一个模拟器 + 一个 Gradle 进程

## 8. 风险登记
| 风险 | 对策 |
|---|---|
| op-log 读写不兼容，导致丢消息 | 双向 golden 测试 + 真实数据回归；commit 前先 load 校验；首次启动前自动整库备份 |
| 不能降级 | 整库备份 / 恢复是 M1 必做；Release 说明加警示；回退流程在 M4 实测 |
| 缓存命中率回退（前缀不一致） | 逐字 golden 对照；M4 真实对话回放，比对命中率 |
| 扩展字段丢失 | 实体都带 extras + Codec 往返测试 |
| 与 g胖 的 v0.29.0 版本号撞车 | 原生版固定 versionCode 100；0.29.x 线可以继续用 90–99 |
| 内存紧张 | 单模块、不用 KSP、--no-daemon、构建串行 |
