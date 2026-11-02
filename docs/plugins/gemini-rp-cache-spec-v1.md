# Gemini RP 缓存优化插件：算法规格 v1.0

适用范围：内置插件 `gcache`（💎 Gemini 提示缓存（OpenRouter）），插件版本 1.1.0 起，App 0.8.5 起。
只对 **OpenRouter 服务商 + Gemini 模型** 的请求生效；其他服务商 / 模型的请求逐字节不变。与 `rpcache`（RP 缓存优化器）兼容：不重排其分层顺序、不取代其章节 / 摘要系统。

## 1. 隐式缓存优先
- Gemini 2.5+ 默认开启隐式缓存（前缀逐字节一致即命中，TTL 约 3–5 分钟），不需要任何额外写入成本。
- 显式 `cache_control` 断点有写入成本，只在「确认支持 且 收益 > 成本」时启用。
- 策略 `mode`：`auto`（默认，推荐）/ `off` / `prefix` / `history`。
  - `auto`：固定前缀估算 Token ≥ 门槛（Flash 系 1024，Pro 系 4096），且与上一轮 `static_hash` 相同（证明会被复用）时才打显式断点；否则只走隐式缓存。
  - **绝不为了凑门槛填充无意义文本。**
- OpenRouter 对 Gemini 只使用最后一个断点：打断点前清除其他插件加的断点。

## 2. Prompt 严格分层
| 层 | 类型 | 内容 | 常见标题 |
|---|---|---|---|
| A | 固定 | 协议（RP 协议锚点） | 【RP 协议】 |
| B | 固定 | 世界 | 【世界观】【世界背景】 |
| C | 固定 | 人物核心 | 【角色卡】【人物设定】 |
| D | 固定 | 玩法规则 | 【RP规则】【输出格式】【示例对白】【禁止事项】【写作风格】 |
| E | 动态 | 长期记忆 | 【长期记忆】【剧情摘要】 |
| F | 动态 | 近期剧情 | 【近期剧情】 |
| G | 动态 | 当前场景 / 临时状态 | 【当前场景】【当前状态】 |
| — | 动态 | 本轮输入 | 最后一条 user 消息 |

- A–D 必须字节级稳定：`static_hash = hash(static_prompt_version + 固定层文本)`；动态层变化不得改变 `static_hash`。
- 固定层文本（锚点、分层规则）变更时 bump `STATIC_PROMPT_VERSION`。
- 消息已由 rpcache 分层时只合并开头连续 system（顺序不变），不重排。
- `auto` 模式下，若单条 system 尾部有动态层，拆成两段 content：断点只覆盖固定层，动态层不写缓存。

## 3. 稳定 session_id
- OpenRouter 官方字段：请求体顶层 `session_id`（≤256 字符；也可用 `x-session-id` 头，body 优先）。设置后首个成功请求即开始 sticky routing，10 分钟无请求失效。
- 由对话 id 哈希生成 `aichat-xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx`：同一对话恒定，换对话即换，从不每轮随机。
- 不修改 `model` 与 `provider` 路由偏好（显式 `provider.order` 时 OpenRouter 以其为准）。

## 4. 记忆分层 L0–L3
- L0 核心事实（A/B/C 层逐行指纹）：永不自动压缩；每轮检查请求中是否仍完整保留，缺失即诊断「疑似误压缩」。
- L1 长期记忆 / L2 近期剧情 / L3 原始历史：由 rpcache 章节与摘要系统负责；压缩只记录原始历史指针（条数 + 指纹），原文保留在对话里。
- 检索：关键词 + 中文二元组重叠评分（0–1），轻量替代语义检索（未接向量库）。
- 存储：`Plugins.registry.convData(conv,'gcache').memory = { L0:[{layer,text,fp}], backups:[] }`。

## 5. 真实 usage
- 命中率 = 真实 `cached_tokens`（经 `providers.normalizeUsage` → `hit`）/ `prompt_tokens`。
- 服务商未返回缓存字段时记为「未知」（`known:false, pct:null`），不冒充 0%。
- 成本：Token 数取真实 usage，倍率按价目表估算（读 0.25x、写 1x 输入价），界面标注「按价目表估算」。

## 6. 诊断
- 滚动命中率（最近 8 次有缓存字段的请求）：≥70% 良好；40–70% 一般；<40% 触发诊断。
- 检查项：static_hash / 前缀哈希变化、模型切换、provider 偏好变化、session_id 缺失或变化、请求间隔 >5 分钟、固定前缀低于门槛、最近前缀 diff 位置。
- 面板展示结论；可选 toast（`diagToast`）在跌破 40% 时提示一次。

## 7. 玩家控制权（RP 协议锚点）
- 不替玩家说话、行动或做决定；NPC 的猜测不写成事实；人物核心性格与临时状态分离。
- 作为固定层 A 注入 system 开头；`rpGuardrails`：`auto`（默认，仅 RP 对话：rpcache 生效 / 有分层设定 / 识别到 ≥2 个分层标题）/ `on` / `off`。普通聊天不注入。

## 8–9. 模块化与 OpenRouter 适配器
见下方实现映射。适配器负责稳定 session_id、保留 model/provider 偏好、解析真实 usage。

## 10. 兼容性
- 非 OpenRouter+Gemini：`onBeforeRequest` 不设标记，`transformRequest` 不运行，请求逐字节不变。
- 旧设置 `off/prefix/history` 保留并按原行为执行（手动模式不受 auto 门槛限制）。

## 实现映射：对应 gcache.js 模块
| 规格 | gcache.js |
|---|---|
| 1 隐式优先 | `CachePolicyEngine.decide` / `minCacheTokens` / `estTokens`；`applyToRequest` |
| 2 分层指纹 | `PromptBuilder.analyzeLayers`（`static_hash`、`dynamic_hash`、`ordered`）、`STATIC_PROMPT_VERSION` |
| 3, 9 session / 路由 | `ProviderAdapters.openrouter` = `OpenRouterAdapter.sessionIdFor / applySession / routeOf / usage` |
| 4 记忆 | `MemoryManager.extractL0 / search / score / missingL0 / backupPointer`；插件 `memOf` |
| 5 真实 usage / 成本 | `usageInfo`（`known`）、`usageText`、`estimateCost`、`PRICE` |
| 6 诊断 | `rollingRate`、`diagnose`；`onAfterResponse`、`renderPanel` |
| 7 锚点 | `PromptBuilder.RP_ANCHOR`、`isRpConv`、配置 `rpGuardrails` |
| 10 测试 | `tests/gcache.test.js` |
