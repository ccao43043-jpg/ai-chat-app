# AI Chat（Android）

一个**无后端**的多服务商 AI 聊天 Android 应用：你自己填写各家 API Key，Key 只保存在手机本地，请求由手机原生网络层直接发往服务商（无 CORS 问题，不经过任何中转服务器）。

<p>
<img src="docs/icon-512.png" width="96">
</p>
<p>
<img src="docs/light-edit-message.png" width="200">
<img src="docs/dark-edit-message-kb.png" width="200">
<img src="docs/light-templates.png" width="200">
<img src="docs/dark-template-manage.png" width="200">
<img src="docs/light-template-vars.png" width="200">
<img src="docs/dark-template-rp-warn.png" width="200">
</p>
<p>
<img src="docs/light-rp-monitor.png" width="200">
<img src="docs/dark-rp-budget.png" width="200">
<img src="docs/light-rp-blocks.png" width="200">
<img src="docs/dark-rp-summary.png" width="200">
<img src="docs/dark-plugins.png" width="200">
</p>
<p>
<img src="docs/light-search.png" width="200">
<img src="docs/light-file-chat.png" width="200">
<img src="docs/light-personas.png" width="200">
<img src="docs/dark-search.png" width="200">
</p>
<p>
<img src="docs/light-chat.png" width="200">
<img src="docs/dark-file-chat.png" width="200">
<img src="docs/dark-personas.png" width="200">
<img src="docs/light-prompts.png" width="200">
</p>

## Windows 桌面版

在 [Releases](https://github.com/ccao43043-jpg/ai-chat-app/releases) 下载：

- `AI-Chat-Windows-Setup.exe`：安装版（可选安装目录，创建桌面 / 开始菜单快捷方式）
- `AI-Chat-Windows-Portable.exe`：便携版，单文件，双击即用

桌面版与 Android 版使用**同一套网页代码**（`app/src/main/assets/www`），原生桥 `AndroidBridge` 由 Electron 实现：请求从本机直接发往服务商（无 CORS、支持流式），API Key、对话、设置只保存在 `%APPDATA%\AI Chat\store\`。宽窗口时侧边栏常驻；Enter 发送、Shift+Enter 换行、Esc 返回，可拖拽 / 粘贴文件。源码与打包说明见 [desktop/README.md](desktop/README.md)。

exe 未做代码签名，首次运行时 Windows SmartScreen 可能提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」即可。

<img src="docs/windows-preview.png" width="640">

## 功能

**v0.7.4：首条消息自动填充 RP 设定**

- RP 缓存优化器（插件 3.1.0）：对话**第一轮回复成功后**，后台额外调用一次当前模型，从首条消息（角色背景 / 人物设定 / 故事背景）里提取设定，自动填进分层设定的 **世界观 / 角色卡 / RP 规则 / 输出格式 / 写作风格 / 禁止事项 / 长期记忆 / 当前状态**，提示「已根据首条消息填充 RP 设定」
- 只填**空白块**，已手动填写的内容绝不覆盖；提取失败或返回无法解析时只提示，不影响聊天；每个对话只自动提取一次
- 「分层设定」页顶部显示提取状态，可随时点「从首条消息提取」手动再来一次（仍只填空白块）
- 开关：插件设置 →「首条消息自动提取设定」（全局）；对话面板 → 预算设置 →「设定提取」（本对话）。摘要模型设置也用于提取调用
- 角色卡 / 世界观编辑页新增「插入对话系统提示词 / 助手设定」「插入首条消息原文」，方便把助手（personas）人设整理进 RP 分层设定
- 首条消息里写了角色扮演 / 世界观等关键词时，也会被识别为 RP 对话自动启用插件
- 版本号同步至 Android `0.7.4`（versionCode 26）与桌面 / npm `0.7.4`

**v0.6.3：API 设置按分类选择模型**

- 设置 → 服务商 → 编辑页新增「模型分类」：文本模型（聊天，第一个为默认）、图片生成、视频生成、嵌入向量、语音合成（TTS）、语音转写（STT）
- 「从接口获取模型列表」按 文本 / 图片 / 视频 / 嵌入 / 音频 分组（优先用 OpenRouter 等返回的 modality，否则按名称推测），非文本分类点一下即填入对应字段
- 从接口获取后可看到价格（OpenRouter 等返回 pricing 的服务商）：获取列表、文本模型标签与图片/视频等字段下显示 输入/输出 美元/百万Token 或 美元/张
- 旧配置自动补齐新字段（空），不改动已有文本模型与图片模型；视频 / 嵌入 / 语音暂为预留配置
- 版本号同步至 Android `0.6.3`（versionCode 16）与桌面 / npm `0.6.3`

**v0.6.2：生图生成进度反馈**
- 独立生图页在生成中显示不确定进度条、阶段文案（请求已发送 / 生成中 / 等待结果 / 正在接收）与已用秒数；生成按钮禁用，可用「停止」取消（NativeBridge.cancel）
- 聊天「图片模式」助手消息 pending 时显示「正在生成图片…」及同步阶段文案，不再静默等待
- 版本号同步至 Android `0.6.2`（versionCode 15）与桌面 / npm `0.6.2`

**v0.6.1：生图页独立选择服务商 / 模型**
- 侧边栏「生图」页可单独选择 OpenAI 兼容服务商与图片模型（`settings.imageGenProviderId` / `imageGenModel`），与聊天顶栏当前模型互不影响；选择会持久化
- 聊天消息「据此生图」使用生图页所选服务商 / 模型；输入框「图片模式」仍用当前对话服务商（避免误换聊天模型）
- 版本号同步至 Android `0.6.1`（versionCode 14）与桌面 / npm `0.6.1`

**v0.6.0：独立生图页 + 聊天「据此生图」**
- 侧边栏「功能」新增 **生图**：独立页面填写提示词、选择尺寸，调用当前服务商的 OpenAI 兼容 `/images/generations`（需配置 `imageModel`），结果可预览、保存到相册，或插入当前对话
- 聊天消息操作栏新增 **据此生图**：根据最近若干轮对话文字预填提示词，打开生图页后可编辑再生成
- 输入框原有「图片模式」与重新生成图片逻辑保持不变；本地 Comfy 生图留作后续
- 版本号同步至 Android `0.6.0`（versionCode 13）与桌面 / npm `0.6.0`

**v0.5.0：千问（阿里云百炼）+ RP 缓存优化器自动化**
- **千问预设**：「阿里云百炼 · 千问（中国）」`https://dashscope.aliyuncs.com/compatible-mode/v1` 与「千问（国际）」`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`（也识别业务空间专属域名 `*.maas.aliyuncs.com`）。预设模型 qwen3.8-max、qwen3.7-plus、qwen3.8-flash、qwen-plus、qwen-flash、qwen-plus-character（角色扮演）、qwen3-coder-flash、qwen3-vl-plus（看图）
- **思考模式**：服务商设置里可选 `enable_thinking` 开 / 关 / 默认；思考内容（`reasoning_content`）显示在回复上方。插件的摘要调用自动关闭思考
- **缓存统计**：默认开启 `stream_options.include_usage`，解析 `prompt_tokens_details.cached_tokens` 与显式缓存的 `cache_creation_input_tokens`
- **RP 优化器支持千问**：DashScope 接口或模型名含 qwen / qwq（包括 OpenRouter、硅基流动上的千问模型）都会识别。支持显式缓存的模型自动在「system 末尾（设定 + 记忆 + 章节）」和「稳定历史末尾」加 `cache_control` 断点（≥ 1024 Token 才加，最多 4 个）；DeepSeek 的请求结构不变
- **更自动**：RP 类对话在 DeepSeek / 千问上自动启用（手动开 / 关始终优先，可改为「所有对话」或「只手动」）；按模型上下文窗口与价格档自动推导预算；自适应摘要时机（缓存过期时趁重建摘要、按「几轮回本」提前摘要）；缓存冷却时顺便合并章节；请求间隔常超过 4 分钟时千问自动改用隐式缓存；新模型自动匹配内置价格表（含千问各模型，人民币按 7.2 换算美元）
- 设计说明见 [docs/plugins/README.md](docs/plugins/README.md) 第 2.1 节（V3 自动策略）

**v0.4.0：DeepSeek RP 缓存优化器 V2**
- **章节只追加**：每次自动摘要只把新移出的旧对话写成新的一章，接在之前的章节后面一起发送；之前的章节逐字不变，摘要那一轮也能命中「固定设定 + 长期记忆 + 之前全部章节」。章节合计超过上限（默认 12000 Token，可调）时才合并一次，并提前提示额外花费。旧版的单份摘要自动迁移为章节 #001
- **默认只对 DeepSeek 生效**：其他服务商的对话即使开了插件也不改写请求（逐字节不变），顶栏显示「不适用」；可以在面板里强制启用，Claude 会自动加 `cache_control` 缓存断点
- **记忆增量**：新近确认的事实写进「记忆增量」（放在对话历史之后），修改不破坏前面的缓存；攒多了再一键合并进长期记忆（合并前提示代价）
- **摘要最小间隔**（默认 10 轮）与 **额外花费估算**：摘要前后都显示「摘要调用 + 缓存重建」的估算花费
- 本轮输入放在最后一条用户消息的开头、状态放在末尾：每轮多命中上一轮输入那一段，旧状态不会残留在历史里
- 重新生成默认沿用首次发送的原文（含当时的联网 / 文件内容），请求逐字节一致；可选择刷新
- Token 估算按字符类型细分，并按服务商返回的真实用量自动校准；界面估算与实际发送对齐
- 价格规则（模型关键词匹配）与高峰时段、时区、非高峰倍数都可以在插件设置里修改
- 从 v0.3.x 覆盖安装即可升级，数据（含章节摘要）全部保留。详见 [docs/plugins/README.md](docs/plugins/README.md) 第 2 节

<img src="docs/light-rp-chapters.png" width="200"> <img src="docs/light-rp-delta.png" width="200"> <img src="docs/dark-rp-blocks.png" width="200">

**v0.3.6：账户余额、小米 MiMo、侧边栏分区与新图标**
- 侧边栏 / 设置新增「账户余额」：汇总已配置 API Key 的服务商；「刷新全部」并行查询。已核实支持：DeepSeek、硅基流动、Kimi/Moonshot、OpenRouter；其余显示「不支持查询」并给出控制台链接。结果带时间戳缓存，错误清晰展示，从不显示完整 Key
- 新增预设「小米 MiMo」：`https://api.xiaomimimo.com/v1`，模型含 mimo-v2.6-flash / pro / ultraspeed、mimo-v2.5-pro / mimo-v2.5（官方 OpenAI 兼容文档）
- 侧边栏重排：上方「对话」列表与下方「功能」两列网格分开，不再和聊天记录挤在一起
- 应用图标改为简洁双色聊天气泡（靛蓝底 + 白气泡三点），自适应各密度已重渲染

<img src="docs/icon-512.png" width="72"> <img src="docs/light-drawer.png" width="200"> <img src="docs/light-balances.png" width="200">

**v0.3.5：用量统计**
- 侧边栏新增「用量统计」入口（设置页也可进入）：汇总全部对话的 Token 用量，不是插件，无需开关
- 记录每次返回用量的对话 / 图片 / 章节摘要请求：输入、输出、缓存命中与未命中、模型、服务商、对话、时间
- 总览：总输入 / 总输出 / 总 Token / 缓存命中 / 未命中 / 请求次数，以及按 DeepSeek 等可编辑价格估算的花费（近似）
- 按天（近 30 天柱状图）、按模型、按服务商、按对话、最近请求；支持今天 / 近7天 / 近30天 / 全部 / 自定义
- 导出 CSV / JSON；可清空；升级时一次性回填已有消息里的 usage（不会重复计数）
- 侧边栏副标题显示今日 Token；每条消息上的「Token 用量显示」插件保持不变

<img src="docs/light-usage.png" width="240"> <img src="docs/dark-usage-models.png" width="240">

**v0.3.4：回复版本与对话分支**
- 重新生成不再丢弃旧回复：回复下方出现 `‹ 2/3 ›` 版本切换器（点箭头或左右滑动），每个版本保留自己的内容、思考过程、模型、用量、搜索来源和图片；当前显示的版本就是后续发送给模型的唯一版本，版本与选择会保存在本地
- 对话分支（类似 ChatGPT）：较早的回复也可以「从这里重新生成」，新版本开出新分支，原来后续的对话保存在旧版本里，切回旧版本即恢复；「编辑并重新发送」用户消息同样开出新分支，用户消息上显示 `‹ 1/2 ›`
- 点版本号打开菜单：切换到指定版本、只保留当前版本、删除当前版本（连同该版本的分支）
- 旧对话自动迁移为单版本消息，无需任何操作
- RP 缓存插件：请求与「只有选中版本」时逐字节一致；切换最后一条回复无提示，切换较早回复会提示「切换较早回复的版本会改变对话历史，下一轮缓存命中率会下降一次」，监控里的原因显示为版本切换；已写入章节摘要的消息不能切换版本；用量徽章显示当前版本的用量

<img src="docs/light-versions.png" width="240"> <img src="docs/dark-branch.png" width="240">

**v0.3.3：RP 缓存插件界面全中文**

- RP 缓存优化器的界面参数全部换成中文：
  - 六层：固定设定 / 长期记忆 / 章节摘要 / 对话历史 / 当前状态 / 本轮输入。
  - 诊断结果：未变 / 追加 / 已改动；「原因」。
  - 统计项：输入 Token / 缓存命中 / 未命中 / 输出 Token / 命中率 / 上下文构成，请求编号 #0001。
  - 版本显示为「固定设定 第 2 版」，命中率骤降提示也改为中文。
- 预算设置每项都改成中文名称，并附一行说明：
  - 上下文上限、输出预留、安全余量。
  - 触发摘要的历史长度、至少新增轮数、保留最近轮数。
  - 保存完整提示词。
- 章节摘要编辑页显示段落标题的中文对照，例如 FACTS = 已发生的事实。
- 「Token 用量显示」插件和插件列表同样改为中文。数字用「万」作单位。
- **只改显示**：发送给模型的内容逐字节不变，包括 `[WORLD]`、`[CURRENT_STATE]`、`[USER_INPUT]` 等分段标记，以及 FACTS 等摘要格式。保存的日志和设置键名也不变，缓存和已有数据不受影响。

**v0.3.2：更大的编辑框**

- ✏️ 编辑消息改为**全屏编辑器**：
  - 文本框占满屏幕（至少约 60–70% 视口高度，可滚动），字号更大、行距更舒适，右上角显示字数和「已修改」。
  - 打开时光标在末尾。
  - 底部固定「取消 / 保存 / 保存并重新发送」三个按钮。键盘弹出时编辑器跟随可视区域缩小（`adjustResize` + `visualViewport`），按钮始终在键盘上方。
  - 有修改时取消或按返回键，会先确认是否放弃。
- 用户消息有两种保存方式：
  - **保存**：只改这一条。
  - **保存并重新发送**：删除这条之后的消息，并重新生成。
- **AI 回复也可以编辑**：修改后作为后续对话的上下文。
- 其他长文本框右下角新增「⤢ 全屏编辑」按钮：对话系统提示词、默认系统提示词、模板正文、助手提示词、⚡ 提示词内容、RP 分层设定和章节摘要。输入框内容较长时，右上角也会出现这个按钮。
- RP 缓存优化器的行为不变：
  - 在 RP 对话中编辑历史消息时会提示「下一轮缓存命中率会下降一次」，监控里显示 `History CHANGED`。
  - RP 分层设定在全屏编辑后仍需回到原页面点「保存」才生效，继续走显式的版本更新。

**v0.3.1：提示词模板（一键切换系统提示词）**

- 📋 **提示词模板库**：每个模板有名称、图标（emoji）、标签和系统提示词正文。
  - 可以新建、编辑、复制、删除、上移 / 下移，★ 收藏的排在最前；支持搜索和按标签筛选。
  - 内置 8 个模板：通用助手、简洁回答、中英互译、润色改写、RP 叙事风格、代码审查、苏格拉底导师、以某种身份回答。内置模板也可以改或删。
  - **变量**：正文里写 `{{变量名}}`，应用时会弹出填写框（带预览，记住上次填的值）。
  - **导入 / 导出**：导出全部模板为 JSON（复制到剪贴板），可从 JSON 文件或粘贴 JSON 导入，重复的自动跳过。
- ⚡ **快速切换**：点输入栏的「模板」按钮、顶部的模板徽章，或模型胶囊菜单里的「📋 提示词模板」，都会打开模板面板。
  - 面板依次列出最近使用、收藏在前的全部模板，以及「从助手套用」。
  - 点一下就把**当前对话**的系统提示词替换掉，从下一条消息开始生效。
  - 顶部徽章和输入栏按钮会显示当前模板名；「无模板 / 清空」可以去掉系统提示词。
- 🆕 **新对话默认模板**：在模板「更多」菜单或设置 → 对话 →「新对话默认模板」里设置。含变量的模板不能设为默认。
- 三者的区别：
  - **模板**：替换本对话的系统提示词。
  - **⚡ 提示词库**：把一段文字插入输入框。
  - **助手**：用指定的提示词、模型和温度新建一个对话。
  - 助手也能在模板面板里当模板套用，这时只替换系统提示词，不改模型。
- 🎭 **与 RP 缓存优化器配合**：开启 RP 插件的对话里，系统提示词属于 L1 固定前缀。
  - 切换或清空模板前会先确认：「切换提示词会改变固定前缀，下一轮缓存命中率会下降一次」。
  - 确认后走显式的静态更新，static 版本号 +1。
  - 下一轮的缓存监控会显示 `Static CHANGED`，原因是「切换了提示词模板「X」，L1 固定前缀改变」；之后恢复 SAME。
  - 在系统提示词面板里手动修改，也会记录为「手动修改了对话系统提示词」。
- 从 v0.3.0 覆盖安装即可升级，数据全部保留。

**模板怎么用**

1. 在聊天页点输入栏的「📋 模板」，点一个模板即可切换。
2. 侧边栏 →「提示词模板」用来管理：点一行编辑，☆ 收藏，「⋯」菜单里可以复制、排序、设为默认或删除。右上角「⋯」用来导入 / 导出。
3. 新建模板时可以写 `{{主题}}` 这样的变量，应用时再填写。

**v0.3.0：插件**

- 🧩 **插件框架**：侧边栏或设置里的「插件」页列出所有插件，可以全局开关，也可以在单个对话中开关。
  - 插件能在请求发出前整理上下文、在回复结束后读取 usage，并在界面上显示徽章和对话面板。
  - 目前只有随应用内置的插件，不会下载任何第三方代码。API 文档见 [docs/plugins/README.md](docs/plugins/README.md)。
- 🎭 **DeepSeek RP 缓存优化器**：长篇角色扮演专用，按设计文档 [V1](docs/plugins/deepseek-rp-cache-design-v1.md) 实现。
  - 每次请求按固定的六层结构组装：永久锚点（世界观 / 角色卡 / 规则 / 格式 / Few-shot / 禁止事项 / 风格）→ 长期记忆 → 冻结章节摘要 → 原样追加的最近对话 → 当前动态状态 → 当前输入。
  - 动态状态放在最后，历史前缀每轮逐字节一致，让 DeepSeek 的上下文缓存尽量命中。
  - 历史超过阈值时自动生成「知识边界」格式的章节摘要。摘要是冻结快照，可以查看、编辑、回滚；原始消息永不删除。
  - 每次请求逐层诊断（SAME / APPEND / CHANGED）并给出原因。
  - 缓存监控：命中率、平均 Miss Tokens / 请求、今日统计、最近 20 次、各层 token 构成、命中率骤降报警、估算节省的费用。
- 📊 **Token 用量显示**插件：在回复上显示输入 / 输出 tokens。
- 流式请求现在会附带 `stream_options.include_usage`，从而拿到用量和缓存命中数据。默认对 OpenAI、DeepSeek、千问、OpenRouter 开启，其他服务商可在设置中手动打开。
- 从 v0.2.0 覆盖安装即可升级，数据全部保留。

**RP 插件怎么用**

1. 打开一个新对话，选择 DeepSeek 模型。
2. 点顶部模型胶囊 →「本对话插件 · RP 缓存优化」（也可以从侧边栏 → 插件 →「当前对话」进入），打开「在本对话启用」。
3. 在「分层设定」里填写世界观、角色卡、规则等。这些内容尽量一次写好，之后少改。
4. 「当前动态状态」（HP、时间、地点、好感度……）可以随时修改，不影响历史缓存。
5. 正常聊天即可：
   - 每条回复上会显示「缓存 xx%」，点击可以查看本次请求逐层的诊断和原因。
   - 历史变长后会自动生成章节摘要 #001、#002……，可以在「章节摘要」页检查、编辑或回滚。
   - 阈值等参数在「预算设置」里调整，每个对话单独设置。

**v0.2.0**：

- 🌐 **联网搜索**：输入框里的「联网」开关。开启后发送前先搜索网页，把前几条结果（标题、链接、摘要）交给模型；回答中用 `[1]`、`[2]` 角标标注来源，点击角标或下方来源卡片用系统浏览器打开原网页。支持 **Tavily**、**博查 Bocha**、**Brave Search**、自建 **SearXNG**；可选「智能提炼搜索词」（先让模型把问题改写成关键词）。
- 📄 **文件和 PDF 对话**：📎 按钮可选择 PDF、Word（.docx）、PowerPoint（.pptx）、Excel（.xlsx）、txt / md / csv / json / 代码等文本文件，**在手机本地**提取文字（内置 pdf.js 与中文 CMap），按「【文件：名称】」分段注入提示词；单个文件最多 3 万字、一条消息合计 8 万字，超出部分截断并告知模型。扫描版（无文字层）PDF 会明确提示，并把前 4 页转成图片交给视觉模型。图片仍走视觉模型。
- 🧩 **助手（角色）与提示词库**：内置 8 个中文助手（翻译官、写作助手、代码助手、英语陪练、文案策划、学习导师、总结提炼、心理倾听），可新建 / 编辑 / 复制 / 删除，并可指定默认服务商、模型和温度；从侧边栏「助手与提示词」或新对话空白页一键开始，对话中显示助手名称和头像。⚡ 按钮打开提示词库，一键插入常用提示词，也可把当前输入保存为提示词。
- 从 v0.1.1 覆盖安装即可升级，对话、服务商和 API Key 全部保留。

**v0.1.1**：应用改名为 AI Chat、全新图标与界面设计（浅色/深色）、顶部模型胶囊一键切换、各家预设更新为当前模型名、「从接口获取模型列表」、旧版设置自动迁移（DeepSeek 已下线的 `deepseek-chat` / `deepseek-reasoner` 自动换成 `deepseek-flash`，API Key 与对话不受影响）。

- 聊天气泡界面，Markdown 渲染（代码块高亮 + 一键复制、表格、列表等）
- **流式输出**（SSE），随时**停止生成**
- 消息操作：复制、编辑并重发、重新生成、删除
- 推理模型的「思考过程」折叠显示（DeepSeek-R1 / reasoner 等的 `reasoning_content`）
- 多对话：新建、切换、重命名、删除，全部保存在本机
- 顶部「模型胶囊」：点一下弹出已配置服务商的模型列表，一键切换；也可自定义模型名和本对话系统提示词
- 服务商设置里可「从接口获取模型列表」（OpenAI 兼容 `GET /models`、Claude `/v1/models`、Gemini `models`），勾选后添加
- 服务商：
  - **OpenAI 兼容**（自定义 Base URL + Key + 模型），预设：OpenAI、DeepSeek、通义千问（DashScope 兼容模式）、Moonshot/Kimi、智谱 GLM、硅基流动 SiliconFlow、小米 MiMo、OpenRouter
  - **Anthropic Claude**（原生 Messages API）
  - **Google Gemini**（原生 generateContent API）
  - 可添加任意多个自定义服务商
- 图片输入（视觉模型）：点输入框左侧 📎 按钮添加，自动压缩
- 联网搜索、文件 / PDF 对话、助手与提示词库（v0.2.0）；插件与 RP 缓存优化器（v0.3.0）；提示词模板（v0.3.1）；全屏编辑器（v0.3.2）
- 图片生成：点输入框里的「生图」切换模式，调用 OpenAI 兼容 `/images/generations`（如 OpenAI `gpt-image-2.5-flare`、智谱 `cogview-3-flash`、硅基流动 `Kwai-Kolors/Kolors`），可保存到相册
- 通用设置：默认系统提示词、流式开关、temperature、最大输出 tokens、生图尺寸
- 自动跟随系统深色模式

## 安装

1. 从 [Releases](../../releases) 下载 `AI-Chat.apk` 到手机（已安装旧版可直接覆盖安装，数据保留）。
2. 点击安装；如提示「禁止安装未知来源应用」，按提示在系统设置中允许当前浏览器/文件管理器「安装未知应用」。
3. 要求 Android 7.0（API 24）及以上。

## 配置服务商

1. 打开应用 → 点「去设置」（或左上角菜单 → 设置 / API Key）。
2. 点选要用的服务商（如 DeepSeek），粘贴 API Key，确认 Base URL 和模型名后点「保存」。
3. 不确定模型名时，点「从接口获取模型列表」，勾选需要的模型后保存。
4. 返回聊天页，点顶部的模型胶囊即可切换模型。

Base URL 填到 `/v1` 这一级即可（程序自动拼接 `/chat/completions`）。常用地址：

| 服务商 | Base URL |
|---|---|
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| 阿里云百炼 · 千问（中国） | `https://dashscope.aliyuncs.com/compatible-mode/v1`（或业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`） |
| 阿里云百炼 · 千问（国际） | `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`（新加坡；API Key 与中国站不通用） |
| Moonshot | `https://api.moonshot.cn/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` |
| 硅基流动 | `https://api.siliconflow.cn/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Claude | `https://api.anthropic.com` |
| Gemini | `https://generativelanguage.googleapis.com/v1beta` |

预设模型（2026-10 对照官方文档）：

| 服务商 | 预设模型 |
|---|---|
| OpenAI | gpt-6-astra、gpt-6.1-sol、gpt-6-luna；生图 gpt-image-2.5-flare |
| DeepSeek | deepseek-flash、deepseek-v4-pro |
| 千问（中国） | qwen3.8-max、qwen3.7-plus、qwen3.8-flash、qwen-plus、qwen-flash、qwen-plus-character、qwen3-coder-flash、qwen3-vl-plus |
| 千问（国际） | qwen3.8-max、qwen3.7-plus、qwen3.8-flash、qwen-plus、qwen-flash、qwen3-coder-flash、qwen3-vl-plus（国际站可用模型以控制台为准，可「从接口获取模型列表」） |
| Kimi | kimi-k3、kimi-k2.6、kimi-k2.7-code |
| 智谱 GLM | glm-5.3、glm-5.3-flash、glm-4.7-flash；生图 cogview-3-flash |
| 硅基流动 | deepseek-ai/DeepSeek-V3.2、Qwen/Qwen3.5-397B-A17B、Qwen/Qwen3-32B；生图 Kwai-Kolors/Kolors |
| OpenRouter | openai/gpt-6-astra、anthropic/claude-opus-5.5、google/gemini-3.8-flash |
| Claude | claude-opus-5-5、claude-sonnet-5-5、claude-haiku-4-5、claude-fable-5-1 |
| Gemini | gemini-3.8-flash、gemini-3.1-pro-preview、gemini-3.5-flash-lite |

模型更新很快，以各家控制台为准；可随时编辑或用「从接口获取模型列表」刷新。

> 注意：OpenAI / Claude / Gemini 在中国大陆通常需要可用的网络环境才能访问。

## 配置联网搜索

1. 左上角菜单 → 设置 → 「联网搜索」，选择搜索服务并填写 Key，可点「测试搜索」验证。
2. 回到聊天页，点输入框里的「联网」（地球图标）开启；再次点击关闭。

| 搜索服务 | 获取 Key | 说明 |
|---|---|---|
| Tavily | 在 [app.tavily.com](https://app.tavily.com) 注册登录，首页复制 `tvly-` 开头的 API Key | 免费版每月 1000 次额度，无需绑卡；海外服务 |
| 博查 Bocha | 在 [open.bochaai.com](https://open.bochaai.com) 微信扫码登录 →「API KEY 管理」新建 Key | 国内直连、中文结果好；新用户可在总览页领取免费调用资源包，之后预充值按次计费（约 ¥0.036/次） |
| Brave Search | 在 [api-dashboard.search.brave.com](https://api-dashboard.search.brave.com) 订阅 Search API 后获取 Token | 海外服务 |
| SearXNG | 无需 Key，填写自建实例地址 | 实例需在 `settings.yml` 的 `search.formats` 中加入 `json` |

请求格式（2026-10 对照官方文档）：Tavily `POST https://api.tavily.com/search`（`Authorization: Bearer`，`{query, max_results, search_depth}`）；博查 `POST https://api.bochaai.com/v1/web-search`（`Authorization: Bearer`，`{query, freshness, summary, count}`）；Brave `GET /res/v1/web/search?q=`（`X-Subscription-Token`）；SearXNG `GET /search?q=&format=json`。「接口地址」可改成自己的代理地址。

## 技术实现

- 原生 Android（Java）外壳 + WebView 界面（`app/src/main/assets/www`），无第三方 Android 依赖
- 网络请求通过 `NativeBridge`（`HttpURLConnection`）在原生层发出，流式数据逐块回传给页面
- 数据（设置、对话）以 JSON 文件保存在应用私有目录，`allowBackup=false`
- 前端库（本地打包，离线可用）：marked、DOMPurify、highlight.js、pdf.js 3.11（含 CMap，Apache-2.0）、fflate（MIT，解压 docx/pptx/xlsx）
- 代码分工如下，均为纯函数，带单元测试：
  - `providers.js`：各服务商的请求构造、SSE 解析，以及 usage 和缓存字段的统一
  - `search.js`：联网搜索
  - `files.js`：文件解析
  - `personas.js`：助手与提示词
  - `templates.js`：提示词模板（增删改、排序、收藏、搜索、变量、导入导出）
  - `versions.js`：回复/消息版本与对话分支（每个版本保存其后续分支，当前路径始终是线性的 `messages`）
  - `usage-stats.js`：全局 Token 用量统计（记录、回填、聚合、花费估算、导出）
  - `balance.js`：各家账户余额请求构造与响应解析（仅官方核实接口）
  - `plugins.js`：插件注册表
  - `rpcache.js`：RP 缓存优化器的 Context Builder
  - `rp-plugin.js`：插件的界面
- pdf.js 按需加载、在主线程运行（WebView 中不使用 Worker）；中文 CMap 通过 `NativeBridge.readAsset` 从 APK 内读取

## 图标

图标源文件在 `design/`（SVG），用 `node design/render.js`（需 puppeteer-core 与本机 Chrome）渲染出各密度的 mipmap PNG（自适应图标前景/背景/单色层 + 传统图标）。

## 构建

需要 JDK 17 与 Android SDK（platform 34、build-tools 34）。

```bash
echo "sdk.dir=$HOME/Android/Sdk" > local.properties
./gradlew assembleRelease        # 输出 app/build/outputs/apk/release/app-release.apk
```

签名：若根目录存在 `keystore.properties`（不提交到 Git），用其中的证书签名 release；否则回退为 debug 证书。格式：

```properties
storeFile=keystore/release.jks
storePassword=******
keyAlias=aichat
keyPassword=******
```

> 用不同证书签名的 APK 不能覆盖安装，需先卸载旧版本（会清除本地数据）。

## 测试

```bash
npm test          # 单元测试：服务商请求、SSE 与 usage 解析、搜索、文件提取、助手、提示词模板、插件钩子、RP 优化器（分层顺序、状态后置、逐字节稳定前缀、自动摘要、版本、诊断、统计、异常检测、隐私）
npm i && npm run test:ui   # 可选：用本机 Chrome 跑界面端到端测试（模拟原生桥，不访问网络；含旧版数据迁移、联网搜索、文件对话、助手、提示词模板、插件与 RP 优化器全流程；截图输出到 docs/）
npm run fixtures  # 重新生成测试用 PDF（一般不需要）
```

### OpenRouter 图片模型（0.6.4）
OpenRouter 的 `/models` 默认只返回文本模型，App 现以 `?output_modalities=all` 获取全部模型。
使用：打开 OpenRouter 服务商 → 从接口获取模型列表 → 点「图片」分类 → 点选模型填入「图片生成」字段 → 保存。
注意：图片生成仍走 OpenAI 兼容的 `POST /images/generations`；若某模型在该路径不可用，属于 OpenRouter 侧接口差异，后续版本再适配其专用图片 API。
