# 插件（v0.3.0）

AI Chat 从 v0.3.0 起提供一个 **内置插件框架**：插件可以在请求发出前改写上下文，在回复结束后读取 usage，并在界面上显示徽章和面板。
目前 **只支持随应用打包的内置插件**。应用不会下载或执行任何第三方代码。

| 文件 | 作用 |
|---|---|
| `app/src/main/assets/www/plugins.js` | 插件注册表与钩子调度（纯 JS，可在 Node 中测试） |
| `app/src/main/assets/www/rpcache.js` | DeepSeek RP 缓存优化器的 Context Builder 核心（纯函数） |
| `app/src/main/assets/www/rp-plugin.js` | 两个内置插件：DeepSeek RP 缓存优化器、Token 用量显示 |
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
| `perConversation: true` | 全局开启，**并且** 对话中 `conv.plugins[id].enabled === true` |

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

## 2. DeepSeek RP 缓存优化器 V1（实现说明）

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
  [CHAPTER_SUMMARY #003]\n…             L3 当前生效的冻结章节摘要（只发送最新一份）
user / assistant / user / assistant …   L4 最近完整对话：原顺序、原文
user:
  [CURRENT_STATE]\n…\n\n[USER_INPUT]\n<本轮输入>   L5 + L6（状态为空时只有输入原文）
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
