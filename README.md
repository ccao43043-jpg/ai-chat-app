# AI Chat（Android）

一个**无后端**的多服务商 AI 聊天 Android 应用：你自己填写各家 API Key，Key 只保存在手机本地，请求由手机原生网络层直接发往服务商（无 CORS 问题，不经过任何中转服务器）。

<p>
<img src="docs/icon-512.png" width="96">
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

## 功能

**v0.2.0 新增**：

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
  - **OpenAI 兼容**（自定义 Base URL + Key + 模型），预设：OpenAI、DeepSeek、通义千问（DashScope 兼容模式）、Moonshot/Kimi、智谱 GLM、硅基流动 SiliconFlow、OpenRouter
  - **Anthropic Claude**（原生 Messages API）
  - **Google Gemini**（原生 generateContent API）
  - 可添加任意多个自定义服务商
- 图片输入（视觉模型）：点输入框左侧 📎 按钮添加，自动压缩
- 联网搜索、文件 / PDF 对话、助手与提示词库（见上方 v0.2.0）
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
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1`（或业务空间专属域名 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`） |
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
| 通义千问 | qwen3.8-max、qwen3.8-flash、qwen3.7-plus |
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
- 各服务商请求构造 / SSE 解析在 `providers.js`；联网搜索在 `search.js`；文件解析在 `files.js`；助手与提示词在 `personas.js`（均为纯函数，带单元测试）
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
npm test          # 单元测试：服务商请求/SSE 解析、搜索请求格式与结果注入、PDF/Word/PPT/Excel/文本提取（tests/fixtures 中的样例 PDF）、助手存储
npm i && npm run test:ui   # 可选：用本机 Chrome 跑界面端到端测试（模拟原生桥，不访问网络；含旧版数据迁移、联网搜索、文件对话、助手；截图输出到 docs/）
npm run fixtures  # 重新生成测试用 PDF（一般不需要）
```
