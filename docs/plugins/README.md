# 插件（v0.3.0 起；RP 缓存优化器 V3 见第 2.1 节）

AI Chat 从 v0.3.0 起提供一个 **内置插件框架**：插件可以在请求发出前改写上下文，在回复结束后读取 usage，并在界面上显示徽章和面板。
目前 **只支持随应用打包的内置插件**。应用不会下载或执行任何第三方代码。

| 文件 | 作用 |
|---|---|
| `app/src/main/assets/www/plugins.js` | 插件注册表与钩子调度（纯 JS，可在 Node 中测试） |
| `app/src/main/assets/www/rpcache.js` | DeepSeek RP 缓存优化器的 Context Builder 核心（纯函数） |
| `app/src/main/assets/www/rp-plugin.js` | 两个内置插件：DeepSeek RP 缓存优化器、Token 用量显示 |
| `app/src/main/assets/www/gcache.js` | 💎 Gemini 提示缓存（OpenRouter）插件 1.2.0：Hybrid-5 迟滞窗口 / 隐式优先 / 分层指纹 / 稳定 session_id / 诊断 |
| `docs/plugins/gemini-rp-cache-spec-v1.md` | Gemini RP 缓存算法规格 v1.0（gcache 以此为准） |
| `docs/plugins/gemini-hybrid5.md` | Hybrid-5：严格固定前缀 + Zip 迟滞窗口（20–40 轮，冻结摘要）与 rpcache 冲突策略 |
| `docs/plugins/deepseek-rp-cache-design-v1.md` | RP 插件的设计文档（当前版本，以此为准） |
| `docs/plugins/deepseek-rp-cache-design-v0.md` | 早期设计文档（仅供参考） |

---

## 1. 插件 API

```js
Plugins.registry.register({
  id: 'my-plugin',            // 必填，唯一
  name: '我的插件',            // 必填
  icon: '🧩', desc: '一句话说明', version: '1.0.0',
  defaultEnabled: false,      // 全局默认开关
  perConversation: false,     // true：全局开启后还需要在每个对话里单独开启
  hooks: {
    async onBeforeRequest(ctx, host) { /* 修改 ctx 或返回新 ctx */ },
    onResponseUsage(usage, ctx, host) {},
    onAfterResponse(result, ctx, host) {},   // result: { ok, usage, bot, status }
    messageBadges(msg, conv, host) { return [{ text, tone, title, action }]; },
    headerBadges(conv, host) { return [...]; },
    messageState(msg, conv, host) { return { dim, light, label }; },
  },
  renderSettings(box, host) {},   // 可选：插件页里的「设置」区域（全局）
  renderPanel(box, host, tab) {}, // 可选：「本对话面板」
  onBack() { return false; },     // 可选：面板内有子页面时拦截返回键，返回 true 表示已处理
});
```

### 开关规则

| 插件类型 | 在某个对话中生效的条件 |
|---|---|
| `perConversation: false` | 全局开启即对所有对话生效。可在单个对话中关闭：`conv.plugins[id].enabled === false` |
| `perConversation: true` | 全局开启，**并且** 对话中 `conv.plugins[id].enabled === true`；对话中**没有手动设置过**时，由插件的 `autoActive(conv, settings, host)` 自动判断（v0.5.0 起，手动开 / 关始终优先）。宿主用 `registry.setHost(host)` 提供服务商查询 |

数据存放位置：

- 全局状态与配置在 `settings.plugins[id]`，用 `registry.config(settings, id)` 读写。
- 对话数据在 `conv.plugins[id]`，用 `registry.convData(conv, id)` 读写。

### 请求上下文 `ctx`

```js
{
  conv, provider, model, settings,
  systemPrompt,            // 对话系统提示词（助手设定）
  messages: [{ role, content, images, _src }], // 已展开文件内容；只有最新一条用户消息带联网搜索结果；_src 指向存储中的原消息
  lastUser,                // 本轮用户消息（存储对象）
  opts: { stream, temperature, maxTokens },
  meta: {},                // 插件之间、请求前后传递数据
  setStatus(text),         // 在回复气泡里显示进度（如「正在生成章节摘要…」），传 null 清除
  setCancel(fn),           // 注册取消函数：用户点「停止」时调用
  plugins: ['id', ...],    // 本次生效的插件
}
```

钩子的调度规则：

- 按注册顺序依次调用。每个插件拿到的都是一份浅拷贝。
- 插件抛错时，它的修改会被丢弃，错误记入 `registry.errors`，其他插件和请求照常进行。
- 没有任何插件生效时，请求与旧版本 **逐字节相同**。

### 宿主 `host`

| 方法 | 说明 |
|---|---|
| `settings()`、`saveSettings()` | 读写全局设置 |
| `conv()`、`saveConv(conv)`、`refresh()` | 当前对话；保存（不改变排序）；刷新界面 |
| `store.get(name, def)`、`store.set(name, value)` | 本机 JSON 存储（`filesDir/store`） |
| `toast(text)`、`dialog({...})`、`esc(html)` | 提示、确认对话框、转义 |
| `openPanel(pluginId, tab)` | 打开插件的「本对话面板」 |
| `callModel(prompt, { model, maxTokens, setCancel })` | 用当前对话的服务商发一次 **非流式** 调用，返回文本 |
| `provider(conv)` | 对话所用的服务商（v0.4.0，插件据此判断适用性） |
| `requestItems(conv)` | 与发送时相同的消息展开（文件内容等，不含本轮联网搜索；v0.4.0，界面估算与实际发送对齐） |

### 新增一个内置插件

1. 新建 `www/xxx-plugin.js`，在里面调用 `Plugins.registry.register(...)`。
2. 在 `index.html` 中、`app.js` 之前引入这个文件。
3. 在 `tests/` 中补充单元测试。纯逻辑请写成可以 `require` 的模块，参考 `rpcache.js`。

### 流式 usage

- OpenAI 兼容的流式请求会带上 `stream_options: { include_usage: true }`。
  - 默认对 OpenAI、DeepSeek、通义千问、OpenRouter 开启（官方文档支持），以及任何 Base URL 包含 `api.deepseek.com` 的服务商。
  - 其他服务商可在「设置 → 服务商 → 流式请求返回用量」中手动打开。
- 不同服务商返回 usage 的位置不同：
  - **DeepSeek**：放在最后一个内容块上（`finish_reason` 非空的那一块）。
  - **OpenAI / 千问**：单独发一个 `choices: []` 的块。
  - 两种都能解析。
- `Providers.normalizeUsage()` 会把各家字段统一成 `{ prompt, completion, hit, miss, cacheSupported, source }`：

| 服务商 | 原始字段 |
|---|---|
| DeepSeek | `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| OpenAI | `prompt_tokens_details.cached_tokens` |
| Claude | `cache_read_input_tokens`，以及 `message_start` + `message_delta` 中的字段 |
| Gemini | `cachedContentTokenCount` |

---

## 2.1 RP 缓存优化器 V3：千问与自动策略（v0.5.0 起，以本节为准）

V3 不改变 V2 的分层结构，只回答三个问题：**对哪些对话启用**、**用哪种缓存**、**预算和摘要时机怎么定**。所有自动决定都可以手动覆盖。

### 2.1.1 服务商缓存能力识别（`RPCache.capability`）

| 识别条件 | 能力 | 默认启用 | 策略 |
|---|---|---|---|
| DeepSeek 预设 / 地址含 deepseek / 模型名含 deepseek | 隐式（自动前缀，硬盘缓存，通常数小时） | 是 | 与 v0.4.0 完全相同 |
| DashScope 地址（中国 / 国际 / `*.maas.aliyuncs.com`）+ 支持显式缓存的模型 | 显式 + 隐式 | 是 | 自动 `cache_control` 断点 |
| 其他千问：DashScope 上不支持显式的模型、OpenRouter / 硅基流动上模型名含 qwen / qwq | 隐式 | 是 | 只稳定前缀 |
| Claude / OpenAI / Gemini | 有缓存 | **否**（可强制启用，同 V2） | — |
| 其他 | 未知 / 无 | 否，请求逐字节不变 | — |

支持显式缓存的千问模型（[显式缓存文档](https://help.aliyun.com/zh/model-studio/explicit-cache-guide)，2026-10）：qwen3.8-max、qwen3.7-max、qwen3.7/3.6/3.5-plus、qwen3.8/3.7/3.6/3.5-flash、qwen-plus、qwen-flash、qwen3-coder-flash、qwen3-vl-plus、qwen-plus-character（含带日期的快照）。

### 2.1.2 千问显式缓存断点

官方规则：`cache_control: {type: "ephemeral"}` 加在消息内容（需改成数组形式）上；≥ 1024 Token 才会建缓存；有效期 5 分钟，命中后重置；每个请求最多 4 个断点；从断点往前最多回溯 20 个内容块寻找已有缓存；创建按输入价 125%，命中按 10%；同一请求里显式与隐式缓存互斥；Qwen3.5 起只支持消息级断点。

插件的放法（`placeMarkers`）：

1. **system 末尾**：固定设定 + 长期记忆 + 全部章节。只在章节变化时才变，摘要那一轮也能命中这一段。
2. **稳定历史末尾**（本轮输入之前最后一条历史）：下一轮时上一轮的断点就在新断点前 2 条消息处，在 20 块回溯范围内，所以每轮命中「上一轮为止的全部内容」，只新建两条消息的缓存。
3. 本轮输入 + 记忆增量 + 状态在最后一条用户消息里，不加断点。

前缀不足 1024 Token 时不加对应断点。总共最多 2 个，留出余量。

**显式还是隐式？**（`chooseStrategy`）显式命中便宜一半（10% 对 20%）且确定命中，但每段新内容要多付 25% 创建费，5 分钟不用就过期。插件看最近 10 次请求间隔的中位数：不超过 4 分钟（连续对话）用显式；超过 4 分钟改用隐式（不付创建费）。也可以在「预算设置 → 自动策略」里固定为显式或隐式。

### 2.1.3 自动启用（`autoActive`）

只对「默认启用」的服务商（DeepSeek / 千问）生效。插件全局设置里的「自动启用」有三档：

- **角色扮演类对话**（默认）：系统提示词含「扮演 / 角色扮演 / 人设 / 世界观 / 角色卡 / 跑团 / RP / NPC / 剧情…」，或模型名含 character，或本对话已经填过分层设定 / 有章节。
- **支持缓存的服务商上所有对话**。
- **关闭**（只手动）。

对话里手动开 / 关过就以手动为准。面板显示「自动」标签。

### 2.1.4 按模型自动推导预算（`autoBudget`）

上下文窗口优先用「从接口获取模型列表」返回的元数据（OpenRouter `context_length`、Anthropic `max_input_tokens`、Gemini `inputTokenLimit`，保存在服务商的 `modelMeta`），否则查内置表。千问很多模型按输入长度分档计价（例如 qwen3.7-plus 超过 256K 涨价、qwen-plus 超过 128K 涨价、qwen3.7-flash 超过 32K 涨价），所以：

- 上下文上限 = 窗口、价格第一档、200K 三者取最小，再 × 0.8（本地估算有误差，留余地）
- 输出预留 10%（4K–16K），安全余量 2%（1K–4K）
- 摘要阈值 30%，章节合计上限 12%（4K–24K）
- **DeepSeek 固定沿用 v0.4.0 默认值**（100K / 12K / 2K / 30K / 12K），行为不变

例如 qwen3.7-plus → 上限 160K、阈值 48K；qwen-plus → 102K；qwen-plus-character（32K 窗口）→ 26K。

覆盖方式：「预算按模型自动推导」开关。手动修改任一预算数值时会关掉自动，以当前推导值为初值。旧会话里改过的数值视为手动；没改过的视为自动。

### 2.1.5 自适应摘要时机（`adaptiveSummary`）

固定阈值和「超预算立即摘要」仍然有效。另外两种情况会**提前**摘要（可关闭「自适应摘要时机」）：

- **缓存已冷**：距上次请求超过缓存有效期（千问显式 5 分钟、隐式约 10 分钟、DeepSeek 按 3 小时估计）。本轮反正全部未命中，摘要后的重建不额外花钱。此时只要未摘要历史达到阈值 50% 就摘要（仍要求可摘要的旧对话 ≥ 3 轮、距上一章 ≥ 最小间隔的一半）。
- **几轮回本**：未摘要历史达到阈值 70% 时，用价格表估算：
  - 一次摘要的花费 = 摘要调用 + 缓存重建
  - 之后每轮少发送的历史 = 被摘要的那批 − 摘要长度，按「近期命中率 × 命中价 + (1 − 命中率) × 未命中价」计价

  前者除以后者 ≤ 12 轮就摘要。近期命中率低（缓存经常失效）时每轮多发历史更贵，会更早摘要，这就是命中率趋势的作用。

**章节合并时机**：缓存已冷时，章节合计达到上限的 60% 就随摘要一起合并（反正要重建），不必等到 100%。

### 2.1.6 价格

价格规则仍以用户规则优先。没有匹配的模型自动使用内置价格表（`BUILTIN_PRICES`），其中包含千问各模型。千问价格取自 [模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)（中国站第一档，2026-10-15 更新），按 1 美元 ≈ 7.2 元换算，计价规则如下：

- 隐式命中按输入价 20%，显式命中按 10%，显式创建按 125%
- 千问不分高峰时段（`peak: false`）
- 日志记录 `cache_mode` 与 `cache_write_tokens`，统计花费时按显式 / 隐式分别计价

### 2.1.7 千问请求细节

- 思考模式：服务商设置「思考模式」选择开 / 关后发送 `enable_thinking`（只对 DashScope 接口发送）。插件的摘要调用总是 `enable_thinking: false`。
- 流式用量：默认开启 `stream_options.include_usage`，从 `usage.prompt_tokens_details.cached_tokens` / `cache_creation_input_tokens` 统计命中。
- 看图：OpenAI 兼容的 `image_url` 消息（qwen3-vl-plus、qwen3.x-plus 等多模态模型）。
- 文档来源：[OpenAI 兼容](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)、[地域与地址](https://www.alibabacloud.com/help/en/model-studio/regions)、[模型列表](https://www.alibabacloud.com/help/en/model-studio/models)、[上下文缓存](https://help.aliyun.com/zh/model-studio/context-cache)、[显式缓存](https://help.aliyun.com/zh/model-studio/explicit-cache-guide)、[模型价格](https://help.aliyun.com/zh/model-studio/model-pricing)。

### 2.1.8 测试

`tests/qwen-auto.test.js` 覆盖以下内容：

- 千问预设、enable_thinking、usage 解析、显式断点序列化、模型元数据
- 能力识别、预算推导、策略选择、运行时冷却、内置价格与显式计价、预算覆盖
- 自适应摘要、合并时机
- 插件集成：自动启用边界、千问断点位置、间隔长时改隐式、DeepSeek 请求不变、OpenRouter 千问

`tests/ui-e2e.js` 新增「千问预设 + 自动策略」界面流程。

---

## 2. DeepSeek RP 缓存优化器 V2（v0.4.0 起；v0.5.0 的自动策略见第 2.1 节）

V2 在 V1 的基础上解决了几个「前缀被破坏 / 白花钱」的问题。下面先列 V2 的变化，V1 的完整实现说明保留在第 2V1 节（被 V2 改动的地方已标注）。

### 2.0.1 请求结构（V2）

```text
system:
  <对话系统提示词> [WORLD] [CHARACTER] … [STYLE]     L1 永久锚点
  [LONG_TERM_MEMORY]\n…                              L2 长期记忆（只放稳定事实）
  [CHAPTER_SUMMARY #001]\n…                          L3 冻结章节，按顺序全部发送，只追加
  [CHAPTER_SUMMARY #002]\n…
user / assistant / …                                 L4 最近完整对话：原顺序、原文
user:
  <本轮输入>                                          L6（放在最前面）
  \n\n[MEMORY_UPDATE]\n…                              记忆增量（为空时省略）
  \n\n[CURRENT_STATE]\n…                              L5 当前状态（为空时省略）
```

### 2.0.2 章节只追加（替代 V1 的「每次合并成一份」）

- V1：每次摘要都把「上一版 + 新一批」合并成新的一份，并 **替换** system 里的旧摘要 → 摘要那一轮只剩 L1 + L2 能命中。
- V2：每次只把 **新移出的旧对话** 写成新的一章，接在前面章节之后；之前的章节逐字不变 → 摘要那一轮能命中 L1 + L2 + 之前全部章节。章节提示词把之前的章节作为只读参考，要求不要复述。
- 章节合计超过「章节合计上限」（默认 12000 Token，可在预算设置里改）时，下一次摘要改为把 **全部章节（+ 本批旧对话）合并成一章**。合并会让 L3 之后的缓存重建一次，所以界面会提前提示，并显示预计额外花费。
- 章节可以单独编辑（旧内容进入这一章的历史版本，可恢复），可以「撤销最后一章」（被覆盖的消息重新以原文发送；撤销合并章会恢复被合并的原章节）。被合并 / 撤销的章节保存在只读存档里（最多 50 个）。
- 诊断：追加章节时 L3 为 **APPEND**（之前的章节指纹全部不变），编辑 / 撤销 / 合并为 CHANGED。
- **旧数据迁移**：v0.3.x 保存的单份合并摘要会在第一次读取时变成章节 #001（内容、覆盖范围逐字不变），下一章编号为 #002；旧快照列表 `summaries` 原样保留不删除。

### 2.0.3 摘要最小间隔与额外花费估算

- 新增「摘要最小间隔（轮）」（默认 10）：达到摘要阈值、但距上一章不足 N 轮时先不摘要，面板显示「摘要间隔未到」。**超出上下文预算时不受限制**（否则只能截断，代价更大）。
- `RPCache.summaryCost(plan, {model, prices, mode, peak})` 估算一次自动摘要的额外开销：摘要调用（输入全部按未命中计 + 输出）+ 缓存重建（新章节 + 剩余历史；合并时还包括原来命中的全部章节）。
  - 摘要前：面板「下次发送时会先自动追加章节…预计额外花费约 $x」。
  - 摘要后：提示条显示「额外花费约 $x」，日志记录 `summary_cost`，监控页「是否发生摘要」一栏显示估算。
  - 手动「立即追加章节 / 合并全部章节」前的确认框也显示估算。

### 2.0.4 记忆增量（长期记忆不再轻易破坏前缀）

- 新增块 `delta`「记忆增量」，发送时放在最后一条用户消息里（输入之后、状态之前），**不进入 system，也不进入历史**。修改它只影响最后一小段，前面的缓存不受影响。
- 长期记忆（L2）位于前缀靠前位置，修改会让之后的章节和历史全部重建。建议：L2 只放稳定事实，新近确认的事写进记忆增量。
- 「把记忆增量合并进长期记忆」：追加到 L2 末尾（L2 版本 +1）并清空增量。确认框会提示代价（`mergeDeltaCost`：章节 + 历史 Token 重建，及估算美元）。

### 2.0.5 本轮输入放在最前面（状态尾巴的取舍）

- V1 把 `[CURRENT_STATE]…[USER_INPUT]` 放在输入前面。这条消息进入历史后只保留输入原文，所以上一轮请求与本轮请求的公共前缀在「上一轮输入」**开头**就断开了。
- 考虑过的方案：把带状态的原样冻结进历史。这样公共前缀最长，但历史里会残留每一轮的旧状态（HP、时间、地点），模型容易把旧状态当成当前状态，而且每轮都多发一份旧状态，**不采用**。
- V2 方案：输入在前、增量和状态在后。公共前缀一直延伸到 **上一轮输入的末尾**，只损失上一轮的状态 / 增量尾巴（通常几十个 Token）；历史里不残留旧状态；状态仍然紧挨着模型开始生成的位置，标签明确。
- 状态和增量都为空时，最后一条用户消息就是输入原文（与 V1 相同）。

### 2.0.6 重新生成不再改写冻结原文

- V1：重新生成最后一条回复时，会用重新搜索的结果覆盖 `rpSent`。
- V2：默认 **沿用首次发送的原文**（含当时的联网 / 文件内容），请求与上一次逐字节相同，并提示「沿用这条消息首次发送的原文」。需要新的搜索结果时，在预算设置里打开「重新生成时刷新冻结的用户消息」。编辑消息仍然会清掉 `rpSent`（`app.js`）。

### 2.0.7 服务商适用性（默认只对 DeepSeek 生效）

- `RPCache.isApplicable(provider, model)`：DeepSeek 预设、Base URL 含 `deepseek`、或模型名含 `deepseek`（如 OpenRouter / 硅基流动上的 DeepSeek 模型）→ 适用。
- 不适用时：即使对话里开了插件，请求也 **逐字节不变**，不冻结用户消息、不记日志、不变灰消息；顶栏显示「🎭 RP · 不适用」，面板说明原因。设定和章节保留，切回 DeepSeek 后继续生效。
- 面板里可以打开「仍然在此服务商上启用」（`settings.force_enable`）：
  - **Claude**：自动加两个 `cache_control: {type: 'ephemeral'}` 断点：system，以及稳定历史的最后一条（最后一条用户消息之前）。Anthropic 最多允许 4 个，短于最小缓存长度时由服务端忽略。
  - OpenAI 等：照常重排（OpenAI 自动前缀缓存），不加额外字段。

### 2.0.8 Token 估算与校准、界面对齐

- 估算按字符类型分别计价（汉字 / 假名 / 谚文 / 全角 0.6，英文字母 0.3，数字 0.5，ASCII 标点 0.6，空白 0.1，emoji 等 1.5 / 码点）。
- 每次回复后用服务商返回的真实输入 Token 校准：`calib = 0.7 × 旧值 + 0.3 × (真实 / 估算)`，限制在 0.5–2.5，作用于预算、摘要阈值和界面显示。预算设置里可以看到系数并重置。
- 界面估算改用宿主的 `requestItems(conv)`（与发送时相同的文件展开和过滤规则），不再和实际发送的内容有偏差。

### 2.0.9 价格与高峰时段可配置

- 价格规则：每条规则有「模型关键词」（逗号分隔，模型名包含任意一个即匹配，越长越优先）和命中 / 未命中 / 输出价格，可以增删改。旧配置（没有关键词）沿用 V1 规则。
- 高峰时段：时段（如 `09:00-12:00,14:00-18:00`）、时区偏移（北京时间 8）、是否仅工作日、非高峰价格倍数（默认 0.5）。

### 2.0.10 测试

- `tests/rpcache-v2.test.js`：用模拟会话（不调用真实 API）逐字节比较相邻两轮请求体的公共前缀，覆盖多轮 + 状态变化、编辑、重新生成、只追加章节与合并、旧数据迁移、记忆增量、最小间隔、服务商适用性（OpenAI / Claude / Gemini 逐字节不变，Claude 强制启用时的 cache_control）、校准、价格 / 高峰配置、界面估算对齐。
- `tests/ui-e2e.js`：章节页、章节编辑与恢复、记忆增量与合并确认、价格规则等界面流程。截图可以用 `SHOTS_DIR=目录 npm run test:ui` 输出到别处。

---

## 2V1. DeepSeek RP 缓存优化器 V1（实现说明，历史；第 2 节中标注的部分已被 V2 取代）

设计文档：[deepseek-rp-cache-design-v1.md](deepseek-rp-cache-design-v1.md)。文档中的「本地代理」改为在应用内部的请求管线中完成：应用本身就是 RP 客户端，Context Builder 直接作用于它发出的请求。

> 能不动就不动，能追加就不重写，能摘要就不盲删，能把动态内容放后面就绝不放前面。

### 2.1 六层上下文与精确序列化

每次请求严格按以下顺序组装。同样的内容永远得到同样的字节，前缀里不放时间戳、id 或随机内容。

```text
system:
  <对话系统提示词 / 助手设定>          ┐
  [WORLD]\n…                          │
  [CHARACTER]\n…                      │ L1 永久锚点（固定顺序，空块跳过）
  [RP_RULES]\n…                       │   static_v001、static_v002…
  [OUTPUT_FORMAT]\n…                  │
  [FEW_SHOT]\n…                       │
  [PROHIBITIONS]\n…                   │
  [STYLE]\n…                          ┘
  [LONG_TERM_MEMORY]\n…                 L2 长期记忆（memory_v001…）
  [CHAPTER_SUMMARY #003]\n…             L3 当前生效的冻结章节摘要（只发送最新一份；V2：全部章节按顺序发送，只追加）
user / assistant / user / assistant …   L4 最近完整对话：原顺序、原文
user:
  [CURRENT_STATE]\n…\n\n[USER_INPUT]\n<本轮输入>   L5 + L6（状态为空时只有输入原文；V2：输入在前，见 2.0.5）
```

- 各部分之间用 `\n\n` 连接。
- **动态状态只出现在最后一条用户消息里**，不进入历史。上一轮的用户消息在下一轮以原文进入 L4（不带状态），所以历史只追加、不改写。
  - 第 N+1 轮请求的 `[system, 历史…]` 与第 N 轮完全相同，后面只多出「第 N 轮输入原文 + 第 N 轮回复 + 新的状态与输入」。单元测试和 UI 测试都逐字节验证了这一点。
- **冻结用户消息**：用户消息第一次发送时的内容（包括当时注入的联网搜索结果、文件全文）保存在 `message.rpSent` 中，之后每轮都按它原样发送，因此搜索结果不会在下一轮消失而改变历史。
  - 联网搜索和文件内容永远只放在用户消息里，不进入 system。
- **安全规范化**：块内容只做以下处理，不改写语义：
  - 去掉 BOM。
  - CRLF/CR 转为 LF。
  - 去掉行尾空白。
  - 4 个以上空行压缩为 2 个。
  - 去掉首尾空行。
- **版本化**：块内容经规范化后真正变化才会让版本 +1。只改空白不会升级版本。
  - 每块保留最近 30 个历史版本，可一键恢复。恢复也会生成新版本。
  - L1 任意一块（包括对话系统提示词）变化都会让 `static_vNNN` +1。
  - 插件 **从不自动修改** L1 或 L2，只在用户手动保存时修改。

### 2.2 Token 预算与自动章节摘要（第 9、16、17 节）

每个对话单独配置，默认值如下：

```yaml
token_budget: { max_context: 100000, output_reserve: 12000, safety_margin: 2000 }
summary:      { enabled: true, trigger_tokens: 30000, min_new_turns: 15, keep_recent_turns: 20 }
```

**发送前的流程**

1. 估算各层 tokens：中日韩字符按 0.6 计，其他字符按 0.3 计，图片每张按 1000 计。
2. 设「最旧一批」= 未摘要历史中，除最近 `keep_recent_turns` 轮之外的全部消息。满足以下任一条件时，先生成下一版章节摘要：
   - 未摘要历史 ≥ `trigger_tokens`，并且最旧一批至少有 `min_new_turns` 轮；
   - 总量超过 `max_context − output_reserve − safety_margin`。超预算时不检查 `min_new_turns`。
3. **生成摘要**：
   - 用同一服务商发一次非流式调用。模型默认与对话相同，可在设置中单独指定。
   - 回复气泡里会显示「正在生成章节摘要…」，可以点「停止」取消。
   - 提示词包含上一版摘要、长期记忆（只读参考）和最旧一批对话，要求按第 10 节的知识边界格式输出：`FACTS / CHARACTER_KNOWLEDGE / PLAYER_KNOWLEDGE / SECRET / UNRESOLVED / RELATIONSHIPS / OBJECTS / LOCATION`。
4. **保存为新快照** `Summary #00N`：
   - 新快照合并上一版内容，覆盖范围累积。请求中只发送最新的一份。
   - 被摘要的消息 **不会删除**：仍然显示在聊天里（变灰，并标注「已写入章节摘要 #00N，不再发送（原文保留）」），只是不再发送。
5. 重新计算 tokens 后发送。

**摘要失败时**（模型报错，或输出不符合格式，例如缺少 FACTS）：

- 会弹出提示，并记入日志的 `summary_error`，不会静默卡住。
- 本次照常发送。
- 如果仍然超预算，就执行下面的「分块截断」。

**分块截断（兜底）**：在摘要关闭或失败、且仍然超预算时使用。

- 一次性只保留最近 `keep_recent_turns` 轮。如果仍然超预算，再继续减少轮数。
- 截断起点固定不动，直到下一次超预算。
- 这样做是因为滑动窗口每轮丢掉最早的一条，会让整个前缀每轮都变，缓存就完全失效。
- 截断只影响发送的内容，本地消息不删除。

**摘要的生命周期**（第 36 节）：

- 快照只追加。
- 「编辑」和「回滚」都会生成新快照（`source: edit / rollback`），旧快照全部保留。
- 回滚时连同覆盖范围一起回滚，回滚后多出来的消息重新发送原文。
- 面板中的「立即生成章节摘要」可以手动触发。

### 2.3 指纹、诊断与监控（第 18–24、39 节）

**每次请求计算的指纹**（SHA-256，纯 JS 实现）：

- `static_hash`、`memory_hash`、`summary_hash`、`history_hash`、`state_hash`、`input_hash`、`full_prefix_hash`
- 外加 `history_count`

**与上一次请求逐层比较**：

- 结果为 `SAME`、`CHANGED` 或 `NEW`（首次请求）。
- History 层多一种结果 `APPEND`：把新历史的前 `history_count` 条重新算哈希，等于上一次的 `history_hash`，就判定为只追加。
  - 这样不需要保存任何 Prompt 原文。

**Reason**：用中文说明本次命中情况，例如：

- 正常动态更新
- 首次请求，缓存尚未建立
- 角色卡 / 世界观等永久锚点被修改
- 长期记忆已更新
- 历史达到摘要阈值，已生成章节摘要 #002
- 超出预算触发摘要
- 历史被修改（编辑、删除或重新生成了较早的消息）
- 距上次请求超过 N 小时，服务端缓存可能已清除
- 前缀未变，但服务端没有命中

**日志**保存在本机 `rplog_<对话id>.json`，最多 500 条。每条包含：

- `request_id`、`timestamp`、`model`
- `prompt_tokens`、`cache_hit_tokens`、`cache_miss_tokens`、`completion_tokens`、`hit_rate`
- 所有哈希、各层版本、各层 token 估算、逐层诊断、原因
- `summary_happened` / `summary_no`、`over_budget`、`trimmed`

**隐私**（第 40 节）：

- 默认 **不保存任何 Prompt 原文**。
- 只有在「预算设置 → 调试」中开启 `save_prompt` 后才会保存完整请求。开启时会提示：「日志可能包含角色卡、私密剧情、API 请求内容，请谨慎使用。」
- 日志从不上传。

**「缓存监控」页显示的内容**：

- 本次请求：命中率，以及 Static / Memory / Summary / History / State / Input 各层的诊断结果和 Reason。
- 是否发生摘要、是否超预算。
- Prompt、Hit、Miss、Completion tokens。
- 各层 Context token 估算条形图。
- 今日：请求数、Prompt、Hit、Miss、Hit Rate。
- 本会话：**平均 Miss Tokens / 请求**（重点显示）、平均命中率、按 token 计算的总命中率、最高 / 最低、连续命中次数、摘要次数、估算节省费用。
  - 价格按 DeepSeek 官方价，可在插件页修改；按北京时间区分高峰 / 非高峰，节假日未计入。
- 最近 20 次的图表与列表。

**异常检测**（第 23 节）：

- 基线是之前最多 5 次有统计的请求，不含首次冷启动请求。
- 触发条件：基线平均命中率 ≥ 50%，且本次低于「平均 − 30 个百分点」，并且低于「平均的 60%」。
- 触发后显示「⚠ Cache Hit Drop」，按哈希列出原因，例如「Summary Hash 变化：章节摘要被重新生成 / 修改」。如果本地上下文没有变化，则提示可能是服务端缓存过期。

**其他服务商**：分层和排序同样适用。监控会显示 OpenAI 的 `cached_tokens`、Claude 的 `cache_read_input_tokens`；没有这些字段时显示「不支持统计」。

### 2.4 设计文档逐项对照

| 文档条目 | 状态 | 说明 |
|---|---|---|
| OpenAI 兼容本地代理 127.0.0.1:8000（第 2、27 节） | **未做（可选项）** | 应用本身就是客户端，在请求管线内实现 Context Builder。给其他 App（如 Termux 里的 SillyTavern）用的本地代理没有做，见第 3 节 |
| DeepSeek 转发 / Streaming（第 28 节） | ✅ | 流式输出不变，同时通过 include_usage 记录用量 |
| 六层分层（第 4–14 节） | ✅ | L1 七个块加对话系统提示词；L2；L3；L4；L5；L6 |
| Context Builder 与 Token Budget（第 15–17 节） | ✅ | 参数见 2.2 |
| Frozen Summary Snapshot 与知识边界（第 7–10、36 节） | ✅ | 自动加手动，可查看、编辑、回滚 |
| 版本化与 Hash 指纹（第 18、19 节） | ✅ | |
| 指标记录（第 20、21 节） | ✅ | SQLite 改为本机 JSON |
| Dashboard（第 22、24、39 节） | ✅ | 放在每个对话的面板中 |
| 异常检测（第 23 节） | ✅ | |
| 安全（第 29、40 节） | ✅ | API Key 由用户在设置中填写，只存在本机，不写在代码里；默认不保存 Prompt |
| 不做的事（第 31 节） | ✅ 遵守 | 不自动改写角色卡或世界观，不自动调 Temperature，不自动路由 |
| V2 多会话（第 32 节） | ✅ | 每个对话是一个独立会话 |
| V2 自动记忆提取（第 33 节） | **未做** | 长期记忆只由用户手动编辑 |
| V3 智能调参（第 34 节） | **未做** | |

### 2.5 已知限制

- DeepSeek 的缓存是服务端「尽力而为」，插件只能让前缀更稳定，不能保证命中。
- 动态状态和本轮输入合并在最后一条消息中。下一轮时，这条消息会换成不带状态的原文，所以每轮的 miss 大约是「上一轮输入 + 上一轮回复 + 新状态 + 新输入」。这是不让旧状态留在历史里的代价。
- Token 数是本地估算，以服务商返回的 usage 为准。
- 自动摘要的质量取决于模型。摘要后请到「章节摘要」页检查角色有没有「知道了不该知道的事」，必要时编辑或回滚。

## 3. 本地代理（未做）

设计文档里的「在手机上开 127.0.0.1:8000，给其他 RP 客户端用」这一项，v0.3.0 没有实现，原因如下：

- 需要前台服务和通知权限。
- 需要在 Java 中重新实现 Context Builder，或者让 WebView 常驻后台。
- 需要做 SSE 透传和鉴权。

这部分风险较高，又无法在真机上验证，所以没有做，以免影响其他功能的稳定性。核心逻辑（`rpcache.js`）是纯函数，以后可以复用。
