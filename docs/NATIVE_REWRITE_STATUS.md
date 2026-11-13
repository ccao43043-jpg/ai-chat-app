# AI Chat 原生重写：整体进度与说明

> 更新日期：2026-11-14 02:35（香港时间）
> 原因：本周 Grok Bot 额度接近用尽，按约定先把已完成工作和不发正式版的说明放到 GitHub，不推 `main`、不打 tag、不发 Release。
> 规格原文：[NATIVE_REWRITE_SPEC.md](./NATIVE_REWRITE_SPEC.md)
> 仓库：https://github.com/ccao43043-jpg/ai-chat-app

## 1. 这是什么

把现有 WebView 混合应用（截至说明撰写时，线上正式版是 v0.29.0，versionCode 90）一次性改写成纯原生 Android：Kotlin + Jetpack Compose，底部固定两个 Tab「聊天 / 生图」，**v1.0.0 不内置任何网页**。

- 包名不变：`com.aichat.app`，启动组件仍是 `.MainActivity`
- versionCode **100**（安卓不能降级；卸载会清数据，所以备份/导出是必做功能）
- 就地读取旧版 `filesDir/store/`，不复制、不经过隐藏 WebView
- API Key 仍用 Android Keystore 别名 `aichat_secrets_v1`（AES-256-GCM）解密，覆盖安装后可继续用
- 签名密钥**不进 git**；覆盖安装必须沿用同一张调试证书

旧前端 `app/src/main/assets/www/` 留在仓库里只作参考和 golden 对照，已经从 APK 资源里排除。

## 2. 分支一览（均已推到 origin，均不在 main）

| 分支 | 最新提交 | 内容 |
|---|---|---|
| [`feat/native-v1`](https://github.com/ccao43043-jpg/ai-chat-app/tree/feat/native-v1) | `334e023` | 共享基线：规格、数据层、迁移、备份、golden 框架、模拟器旧数据回归 |
| [`native/A`](https://github.com/ccao43043-jpg/ai-chat-app/tree/native/A) | `bbda014` | 界面：壳、Tab、聊天、抽屉、设置、助手/提示词/模板库、附件、编辑/重生成/续写/版本、RP 冻结与徽章 |
| [`native/B-r2`](https://github.com/ccao43043-jpg/ai-chat-app/tree/native/B-r2) | `b957c8a` | 网络与引擎：流式、路由、附件、写入顺序对齐 JS，并已把联网搜索和 NetRetry 接到引擎。请用这一支，不要用下面的旧 `native/B` |
| [`native/B`](https://github.com/ccao43043-jpg/ai-chat-app/tree/native/B) | `f9e16b4` | **旧头**（未接 files 参数）。rebase 后非快进，没有强推，仅作历史保留 |
| [`native/C`](https://github.com/ccao43043-jpg/ai-chat-app/tree/native/C) | `ba4ece7` | 插件与 RP 领域：gcache / mmcache / usage、知识库 BM25F+MMR、affect、角色卡、世界书（三路合并、从全文填入）、AutoChar、rpcache 状态核心 |
| [`native/D`](https://github.com/ccao43043-jpg/ai-chat-app/tree/native/D) | `334e023` | 与 `feat/native-v1` 同提交 |
| [`native/integ`](https://github.com/ccao43043-jpg/ai-chat-app/tree/native/integ) | `c124a84` | **当前整合树**：已合并 A + B-r2 + 数据层，并接上真实 `ChatEngine`。插件（C）尚未合入 |

更新备份请用显式 refspec，例如：

```bash
git push origin native/integ:refs/heads/native/integ
```

禁止 `--force` / `--force-with-lease`，禁止推 `main`，禁止删除或重置他人工作树。

## 3. 各线状态

### A 界面（BErt）— M1～M4 已完成

底部「聊天 / 生图」Tab、对话列表与抽屉、设置、助手/提示词/模板库、附件（PDF/DOCX/PPTX/XLSX 自写抽取，40MB 上限）、编辑 / 重生成 / 续写 / 版本、RP 冻结与徽章。M4 还有 50ms 流式合并、崩溃防护、进程死后恢复。

待整合时再对的细节：`UiDeps.charCard` 与 `ChatMounts.rp`（`RpUiHooks`）留给 C 注册。

### B 网络与引擎（g胖）— 聊天主路径（含搜索和重试）已完成，成本和生图页未做

已完成：

- OpenAI 兼容、Anthropic、Gemini 的请求构造与流式
- `DefaultChatEngine`、`AffinityRouter`（`routePrices` → `chooseUpstream`）
- `ChatEngine.send(..., files)`：附件写入 `user.files[]`，请求按 `toRequestMsg` 展开；扫描件加识图提示；只发文件时标题为「📄 文件名」
- 写入顺序已对齐旧版 JS：
  - 单版本且失败或空回复时重新生成：先删旧消息并存盘，再建新消息，新 id 放在 `Started` 里
  - 多版本就地写
  - 续写前先清 `error` / `stopped` / `truncated` / `finishReason`，删除的键按 D5 显式写 `null`
  - 新对话标题加助手 emoji 前缀，截 24 字
- D6 排序：含非拉丁字符时用 `Collator(Locale.CHINESE)`；纯拉丁仍用已与 Node golden 对齐的近似排序（Java Collator 对 ASCII 标点和大小写与 ICU 不同）
- `native/B-r2` 上 `testDebugUnitTest` 112/112 通过，三份 golden `--check` 一致（以作者报告为准，整合线上已开始复测）

在 `b957c8a`（2026-11-14 02:30 香港时间）已把联网搜索和 `NetRetry` 接到引擎：改写查询、`searchQuery` / `sources` / `searchError` / `lastUser.search`，退避重试并经 `Notice` 提示（「已重试 N 次」），另有 M4 golden（netretry / search / files.context）和引擎测试。这份提交晚于当前 `native/integ`（仍基于 `db53f4f`），整合树还需要再快进合并一次。

还没做：成本和余额接到产品路径，生图页（`ImageClient` / `ImageScreen`），用量页。`CostCoreJs` / `UsageStats` / `Balance` / `formatModelPrice` 的代码和 golden 已在树里（`21cebe7`），但未完全接到界面和引擎产品路径。

后续提交请快进推到 `native/B-r2`。

### C 插件与 RP（openrouter）— 领域逻辑大部分完成，请求组装和页面未完

已完成：插件注册表、gcache / mmcache / usage、知识库（BM25F + MMR）、affect（Kalman + CUSUM）、角色卡解析（golden 781 条）、世界书（模板、三路合并、从全文填入、分节全文）、AutoChar、rpcache 状态核心与 `parseSections`。作者报告过 64 项测试通过。

还没做 / 未合入整合树：

- rpcache 经 `transformRequest` 的请求组装（下一优先）
- affect 钩子、knowledge-plugin、rpmemory / ledger、章节与摘要
- RP 页面，以及 C 侧对 `RpContracts` 的适配
- M4 回放对照
- 在 `AppGraph` 填 `charCard` 槽，运行时填写 `MessageState.light`（超预算消息 dim+light，已写入章节的只 dim）

### D 数据 / 迁移 / 对照（整合线）— M1、M2、M3 第一部分完成

- Codec 无损往返、仓库、conv-log（快照 + 日志 replay）、首启迁移、整库备份（SAF，导出不含 Key）
- golden 框架：`tests/golden-export/`，数字相对误差 ≤ 1e-9，字符串逐字相等
- 模拟器覆盖安装回归：真实 v0.24 数据 → v0.28.7 → 原生。7 个对话、134 条消息、72 条用量、9 个助手、11 个模板、1 个世界、1 个知识库，与旧版 JS 读同一份数据对比 **0 处差异**；5 个 Key 可解密。首次启动会自动备份。夹具在 `app/src/test/resources/regression/{v024,v0287}`（不含 Key）

过程中修了 3 个数据问题（已在 `334e023` / `f76fd4f`）：

1. 字段回到默认值或被删除后没有落盘（旧版 JS 也有同类问题）。现在删除的消息键显式写 `null`（有意差异 D5）
2. 迁移体检补上搜索 Key（`search:<id>`）
3. 助手角色卡空字段按 JS 丢弃

### 整合 `native/integ` — 进行中（I1）

已合并 `native/A`（`bbda014`）和 `native/B-r2`（`db53f4f`），并做了这些接线（`c124a84`）：

- `AppGraph` 使用 B 的 `DefaultChatEngine`、`DefaultProviderClient`、`AffinityRouter` 和 `onUsage`（写入 `usage-stats.jsonl` 的 `makeEntry`）
- `MainActivity` 不再用假依赖，走真实 `AppGraph`；首启迁移会跑 `providerMigration`
- UI 发送走 `files` 参数；对话模板键用类型化字段；服务商预设改读 B 的 `ProviderPresets`
- 契约补记 **#s**：`Usage.extras`；消息里的用量键与 JS 一致为 `cost`（不是 `costUsd`），以便无损读取旧的 `usage-stats`；`Usage.raw` 表示服务商返回的原始 usage，**不落盘**（存盘条目由归一化字段生成）
- versionName 改为 `1.0.0-alpha1`，versionCode 仍为 100

尚未完成（撰写时仍在跑）：

- 在整合树上复跑单测和 golden
- 模拟器上用假 LLM 验收：发送、流式、停止（`truncated`）、重生成、编辑后重发、版本、附件，以及旧对话能打开且内容正确
- 插件（C）尚未合并，目前仍是空的 `PluginRegistry`
- 面向用户的内测 APK 要等上述验收通过后再拷贝和核对证书；**未完成验收前请不要把构建产物当作可安装包分发**

## 4. 还差什么才能到 v1.0.0

按优先顺序：

1. 完成 I1：整合树通过单测 / golden / 模拟器真聊天验收，产出签过名的 `1.0.0-alpha1` 调试包
2. B：把 `b957c8a`（搜索 + NetRetry）并进整合树；然后成本和余额，最后生图页和用量页
3. C：rpcache 请求组装，其余插件钩子、RP 页面，再并入 `native/integ`
4. 全应用模拟器回归（含插件），对照旧版行为
5. M4 发版准备：`versionName` 改为 `1.0.0`，用本地 `keystore.properties`（不进 git）做 release 签名，`apksigner` 核对证书，Release 说明写上「不可降级，请先导出备份」
6. **发布 GitHub Release 前必须再问用户**，得到明确同意后才能打 tag、上传 APK

有意差异见规格 §3.5（D1～D7）。没登记的差异一律按 bug 处理。

## 5. 技术栈（与规格一致）

- AGP 8.5.2，Gradle 8.7，JDK 17，compileSdk / targetSdk 34，minSdk 24
- Kotlin 2.0.21，Compose BOM 2024.09.03，OkHttp 4.12.0，kotlinx-serialization 1.7.3
- **不引入 Room / Hilt / KSP**
- 盒子内存约 5G：构建请用 `./gradlew --no-daemon`，不要同时开多个 Gradle 或模拟器

## 6. 如何检出、构建、签名

### 6.1 检出

只看数据层和规格：

```bash
git fetch origin
git checkout feat/native-v1    # 334e023
```

要继续整合、或本地打目前的 alpha 包：

```bash
git checkout native/integ      # c124a84（撰写时的头；之后可能快进）
```

各线继续开发请在对应的 `native/A`、`native/B-r2`、`native/C` 上工作，定期 rebase 到最新的 `feat/native-v1`。

### 6.2 构建调试包

```bash
# 需要 Android SDK。仓库里的 local.properties 已 gitignore。
# 盒子上：sdk.dir=/home/box/Android/Sdk ，JAVA_HOME=/home/box/jdk17
export JAVA_HOME=/home/box/jdk17
./gradlew --no-daemon assembleDebug testDebugUnitTest
# 对照脚本（在已导出 golden 的前提下）
node tests/golden-export/run.mjs --check
```

调试 APK 默认用 `~/.android/debug.keystore`，别名 `androiddebugkey`。口令是 Android 官方调试密钥的标准口令，**不要写进仓库或文档**。

覆盖安装要与旧版同一张证书。核对：

```bash
apksigner verify --print-certs app/build/outputs/apk/debug/app-debug.apk
# SHA-256 必须是：
# 6054f9df0a648b7e693e2bc792b41db5b2abc83550445a51f38ecfebe9d7a360
```

`*.keystore`、`*.jks`、`keystore.properties` 已在 `.gitignore`，不要添加、不要提交。

### 6.3 覆盖安装与备份

1. 先在现有 App 里导出备份（原生版首次启动也会自动做一份整库备份；备份里不含 Key）
2. 直接安装 versionCode 100 的 APK，覆盖 v0.28.x / v0.29.0
3. 打开后应能看到旧对话、助手、模板、世界、知识库；已保存的 Key 应可直接使用
4. 不能再降回 versionCode 90 或更低。若必须回退，只能卸载（会清空数据）再装旧版，然后从备份恢复

### 6.4 正式版签名（M4，尚未执行）

- 把 `keystore.properties` 放在工程本地（不进 git），指向实际使用的 keystore
- 当前调试阶段仍用同一份 `~/.android/debug.keystore`，以保证覆盖安装
- `versionName` 改为 `1.0.0`，再用 `apksigner` 核对角后 SHA-256
- 未经用户明确同意，不要打 tag、不要创建 GitHub Release、不要把 APK 当作正式版发布

## 7. 旧数据位置（供对照）

应用内（覆盖安装后仍在）：

```
/data/data/com.aichat.app/files/store/
  settings.json  convs.json  conv_<id>.json  .snap.json  .log.jsonl
  personas / templates / prompts / worlds.json
  rplog_*  knowledge_world_*  usage-stats  balance-cache  device-id
```

Key 不在上述目录，而在 SharedPreferences `aichat_secrets`，由 Keystore 加密。

盒子上的回归产物（不在 git 里，或仅有去 Key 夹具）：

- `/workspace/_review/native-regression/v024-store/`、`v0287-store/`
- 对照报告 `compare-v0287-store.txt`（0 处差异）
- 去 Key 夹具：`app/src/test/resources/regression/{v024,v0287}`

## 8. 协作约定（摘要）

- 包名、启动组件、证书、versionCode 100 不可改
- 行为以 JS v0.28.7 为准；偏离必须写入规格 §3.5
- 插件注册顺序：knowledge → rpcache → usage → gcache → mmcache → affect
- 契约变更记在规格 §3.4；整合阶段又补了 #s（见上文）
- 不要把 agent 的口头「可以发版」当成用户授权

额度恢复后，优先把 I1 验收做完，再按第 4 节顺序继续。
