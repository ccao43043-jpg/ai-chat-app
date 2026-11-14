# 原生 v1 实施计划（I1 → 1.0.0）

> 基线：`native/integ` @ `c124a84`（versionName `1.0.0-alpha1` / versionCode `100`）
> 配套文档：`docs/NATIVE_REWRITE_SPEC.md`（行为规格与契约）、`docs/NATIVE_REWRITE_STATUS.md`（各线进度快照）
> 本文只写「接下来怎么走」，不重复规格里的行为细节。

---

## 1. 这个文件怎么用

- 每个工作包（W）都有 **验收标准**。没写验收标准的任务不算完成。
- 括号里标 `[未核实]` 的内容来自作者口头报告，**不是**在本仓库里跑出来的结果。CI 绿了之后请把 `[未核实]` 删掉。
- 契约变更（数据格式、键名、插件顺序）必须同步改 `SPEC §3.4`，行为偏离必须写 `SPEC §3.5`。
- 顺序是有依赖的：W0 → W1 → W2 是硬依赖，W3/W4/W5 可并行。

---

## 2. 现状快照（2026-11-14）

| 分支 | 头 | 内容 | 与 integ 的关系 |
|---|---|---|---|
| `main` | `c855c76` | 旧 WebView 版 v0.29.0 / versionCode 90 | 不动，继续当行为基准的**上一版** |
| `feat/native-v1` | `e599caa` | 骨架 + 文档，v0.29 之后冻结 | 已并入 |
| `native/A` | `bbda014` | UI 层 M1–M4 | 已并入（`ebcebc7`） |
| `native/B-r2` | `b957c8a` | 引擎接入联网搜索 + NetRetry | **未并入** ⚠ |
| `native/C` | `ba4ece7` | 插件注册表 / 知识库 / affect / 角色卡 / 世界书 / RP 状态核 | **未并入** ⚠ |
| `native/D` | `334e023` | 数据层、golden、模拟器回归 | 已并入 |
| `native/integ` | `c124a84` | I1 整合树，可编译的 alpha | 当前基线 |
| `native/i2` | 待建 | 本计划第一刀 | 从 integ 起 |

**关于 integ 落后 B-r2**：integ 的合并父是 `23552b6`（= merge native/B-r2 的 `db53f4f`），而 B-r2 后来又推了 `b957c8a`。所以整合树里 `engine.DefaultChatEngine` **没有**接搜索和重试，但 `net/Search.kt`、`net/NetRetry.kt` 文件已经在树里（死代码）。

**关于 C 未合**：`AiChatApp.kt` 里 `plugins = EmptyPluginRegistry`，且 **engine 和 uiDeps 各传了一份独立的 EmptyPluginRegistry**。这意味着即使把 C 合进来，如果只改其中一处，引擎看到的插件状态和 UI 看到的不再是同一个对象。

---

## 3. 不变量（改任何代码前先过一遍）

1. 包名 `com.aichat.app`、启动组件 `.MainActivity`、`versionCode 100`。
2. 签名必须沿用 `aichat_secrets_v1`（Keystore），**旧版覆盖安装依赖同一张签名证书**。
3. 旧数据目录 `/data/data/com.aichat.app/files/store/` 原地沿用，不搬家、不改名。
4. `app/src/main/assets/www/` 只作为 golden 数据源，`sourceSets.main.assets.srcDirs = []` 保持。
5. 不引入 Room / Hilt / KSP / 注解处理器。
6. 行为基准 = 旧 JS **v0.28.7**（`f6bdd62`）。
7. 不推 `main`、不打 tag、不发 Release。发布前必须单独问用户。

---

## 4. 决策记录（DEC）

| # | 决策 | 理由 | 何时复核 |
|---|---|---|---|
| DEC-1 | 基线锁 v0.28.7，不追 v0.29.0 | v0.29.0 是底部 Tab 的 UI 改动，golden 已按 v0.28.7 导出；追版本要重导全部 fixture，收益低 | 若 v0.29 出现数据层/协议层改动 |
| DEC-2 | 插件注册顺序沿用 SPEC：knowledge → rpcache → usage → gcache → mmcache → affect | 顺序影响 hit/miss 归属，改了等于改账单口径 | 由 SPEC 变更触发 |
| DEC-3 | alpha 包只在持有 `6054f9df…a360` 证书的机器上出 | 换证书 = 老用户必须卸载重装 = 丢数据 | v1.0.0 正式签名时 |
| DEC-4 | 用量入库只保留一份实现（见 OPT-1） | 原 `AppGraph.recordUsage` 与 `UsageStatsCore.makeEntry` 是两份手写逻辑，键格式必然漂移 | 已执行 |
| DEC-5 | `fromVersionCode = { 0 }` 保留，但新增 `.store-schema` 标记文件 | 覆盖安装后拿不到旧 versionCode 是平台限制；从 1.0.0 起写 schema 号，未来迁移有据可依 | 下一个破坏性 schema 变更 |
| DEC-6 | CI 只做「编译 + 单测」，不做签名/发布 | 签名密钥不入仓 | 需要自动出包时改用 secrets |

---

## 5. 工作包

### W0 · 基线可验证（本次完成一半）

**目的**：把「作者口头说绿了」变成「CI 说了算」。当前 `.github/workflows/test.yml` 只 `npm test`，Android 一行没编过。

- [x] 新增 `.github/workflows/android.yml`：JDK 17 + `assembleDebug` + `testDebugUnitTest`，失败时上传测试报告与 APK
- [ ] 首跑转绿，把用例数 / 耗时记到 §8
- [ ] 红了的用例按模块分派，**不要**用 `@Ignore` 抹平

**验收**：`native/i2` 的 CI check 全绿，且能在 Actions 页面下载 `app-debug.apk`。
**风险**：首次跑可能暴露一堆真失败（5 条线的单测从没在同一棵树上跑过）。

---

### W1 · 合并 B-r2：引擎接搜索 + NetRetry ⚠ P0

**目的**：`plugins=EmptyPluginRegistry` 之外，这是整棵树**功能上最明显的缺口**——设置里能开联网搜索，但请求根本不会带搜索结果。

**现状**：`b957c8a` 改了 13 个文件（`engine/DefaultChatEngine.kt` +111/−25、`net/Search.kt`、`net/NetRetry.kt`、`net/StreamParser.kt`、`net/ModelCatalog.kt`、`net/ProviderPresets.kt`、`net/Router.kt`、`net/JsCompat.kt`、`net/DefaultProviderClient.kt`、`domain/cost/{Balance,CostCoreJs,UsageStatsCore}.kt`、`test/engine/ChatEngineTest.kt`、`test/net/M4GoldenTest.kt`），无新增 golden 资源。

**步骤**：

1. `git switch -c native/i2 origin/native/integ`
2. `git merge origin/native/B-r2`
3. 冲突预判：
   - `UsageStatsCore.kt`：B 改过，D 也改过 → 大概率冲突，**以 JS `usage-stats.js` 为准**逐段比。
   - `DefaultChatEngine.kt`：integ 未改过此文件 → 应干净。
   - `domain/cost/UsageEntry.kt`（本批新增）：B 不涉及，无冲突。
4. 合完确认 `AppGraph` 里 engine 的构造参数没被旧版本覆盖（B 加了 `search`/`retry` 相关入参）。
5. 搜索 Key 的读取路径：确认走 `secretVault`，键名 `search:<providerId>`（迁移体检已补这一项）。

**验收**：
- 单测全绿，`M4GoldenTest` 绿
- 手动：配置搜索 Key → 开「联网搜索」→ 问一个时效性问题 → 消息带 `sources` 且正文引用了结果
- 手动：飞行模式下发送 → 出现 Notice「已重试 N 次」而不是直接报错

**风险**：搜索结果的注入会改变 prompt，**golden 里有没有覆盖带搜索的请求**要确认；若没有，需要补一条。

---

### W2 · 合并 C：插件 + RP 核心 ⚠ P0

**目的**：现在 `plugins = EmptyPluginRegistry` → gcache/mmcache 全失效，**缓存命中率恒为 0，实际花费会比旧版高**（这是最容易被用户当成「原生版更贵」的坑）；RP 相关页面整块缺失。

**步骤**：

1. **不要整体 merge C**。C 从 `60a68af` 起、与 A/B/D 并行开发，共享文件（`Contracts.kt` / `Models.kt` / `AiChatApp.kt` / `AppRoot.kt`）必然大面积冲突。
   改为按文件取新增：
   ```bash
   git checkout origin/native/C -- app/src/main/java/com/aichat/app/plugin/ \
       app/src/main/java/com/aichat/app/domain/rp/ app/src/main/java/com/aichat/app/domain/knowledge/
   ```
2. 手工合并「两边都改过」的文件，规则：**A 的 UI 改动优先，C 的数据结构优先，D 的 codec 优先**。
3. 新建 `RealPluginRegistry`，严格按 DEC-2 的顺序注册。
4. **`plugins` 收敛成一个实例**（见 OPT-3）：`engine` 和 `uiDeps()` 必须用同一个 registry。
5. `UiDeps.charCard` 接 C 的 `CharCardCodec`；`ChatMounts.rp` 接 `RpUiHooks`。
6. rpcache 的 `transformRequest` 是 C 里唯一还没接进引擎的钩子，按 `plugins.js` 的调用点补。

**验收**：
- C 报的 64 项测试绿 [未核实] → 改成 CI 绿
- 开 gcache 后连发两条相同问题：第二条 usage 里 `hit > 0` 且 `miss` 相应减少
- 插件顺序可验证：usage 条目里的 cache 统计来自 rpcache 之后的状态
- RP 对话出现徽章，角色卡能读能写

**风险**：插件会改写请求体 → 影响所有既有 golden。合之前先把 golden 跑一遍存底。

---

### W3 · 成本 / 余额 / 用量页

`net/UsageCodec.kt`、`domain/cost/*`、`Balance.kt` 都已存在但没接 UI（B 报告「已写未接入」）。

- [ ] `AppGraph` 暴露 `usageStats` / `balance` 给 UI
- [ ] 用量页：日/月聚合、按模型分组、CSV 导出（`UsageStatsCore.toCSV` 已实现）
- [ ] 顶部费用条（`settings.showTopCost`）
- [ ] 余额查询：`Balance` + 缓存 `balance-cache`

**验收**：与旧版同一份 `usage-stats.jsonl` 对比，条目数、`hit/miss`、`cost` 求和一致（相对误差 ≤1e-9，沿用 golden 口径）。

---

### W4 · 生图页

- [ ] `ImageClient`（多服务商：OpenAI images / Gemini image / OpenRouter）
- [ ] `ImageScreen`：prompt、尺寸、参考图、历史（`HISTORY_LIMIT=10`）
- [ ] 把生成结果落 `imagegen` 历史（旧版 JS 的数据格式）

**验收**：生成一次 → 杀进程 → 重进，历史还在。

---

### W5 · RP 页面

- [ ] 章节 / 摘要 / ledger / rpmemory 的 UI
- [ ] `RpContracts` 适配（C 的待办）
- [ ] M4 回放对照（用 C 的 rpcache golden）

---

### W6 · 全应用回归（模拟器矩阵）

- [ ] API 24（minSdk 下限）与 API 34 各跑一遍
- [ ] 覆盖安装链：v0.24 → v0.28.7 → 原生 alpha，数据 0 处差异
- [ ] 假 LLM 全流程：发送 / 流式 / 停止（truncated）/ 重生成 / 编辑重发 / 版本切换 / 附件 / 旧对话打开
- [ ] 断电/杀进程恢复：流式中杀进程，重进不丢消息、不重复计费

---

### W7 · 发版准备

- [ ] `versionName` → `1.0.0`
- [ ] 本地 `keystore.properties`（**不入 git**），`apksigner verify --print-certs` 核对指纹 = `6054f9df…a360`
- [ ] `versionCode 100` 复核（不可回退）
- [ ] 出包后在**真机**上做覆盖安装验证（模拟器过了不算）
- [ ] 更新 `CHANGELOG.md` 与 `docs/NATIVE_REWRITE_STATUS.md`

---

### W8 · 发布（需用户单独授权）

推 `main` / 打 tag / 发 Release 三件事都必须在动手前问用户。**agent 说「可以发版」不算授权。**

---

## 6. 优化清单

| # | 项 | 收益 | 成本 | 优先级 |
|---|---|---|---|---|
| OPT-1 | `AppGraph.recordUsage` 收口到 `domain/cost/UsageEntry` + `UsageStatsCore.makeEntry` | 消掉两份手写实现，`key`/`id`/`actualCost` 只在一处定义；可单测 | 已完成（本批） | ★★★ |
| OPT-2 | Android CI | 「编不过」从口头承诺变成门禁 | 已完成（本批） | ★★★ |
| OPT-3 | `plugins` 收敛为单实例 | 现在 `engine` 与 `uiDeps()` 各拿一个 `EmptyPluginRegistry`，合 C 后插件状态会分裂成两份 | 小 | ★★★ |
| OPT-4 | 补 `filesGoToEngineAsAttachments` 的断言 | 该用例**改名后只剩注释、没有任何断言**，附件链路在 UI 层零覆盖 | 小 | ★★☆ |
| OPT-5 | `DefaultUsageStats.makeEntry` 补 `convTitle`/`providerName` | 与 `app.js recordUsage` 对齐，否则用量页按对话分组是空的 | 小 | ★★☆ |
| OPT-6 | `fromVersionCode = { 0 }` → 加 `.store-schema` 标记文件 | 将来做数据迁移时能判断来源版本 | 小 | ★★☆ |
| OPT-7 | `AppGraph` 瘦身 | 目前 DI 根里塞了业务逻辑（`recordUsage`、迁移、诊断），迟早变成第二个上帝类 | 中 | ★☆☆ |
| OPT-8 | golden `--check` 进 CI | 现在 golden 只靠人手跑 | 小 | ★★☆ |
| OPT-9 | 设置里加「导出诊断包」 | `data/diag/` 已有基础，线上排查省事 | 中 | ★☆☆ |
| OPT-10 | `gradle.properties` 调优 + configuration cache | 5G 内存的盒子构建更稳 | 小 | ★☆☆ |
| OPT-11 | 大文件抽取的线程与内存（40MB 上限） | `minSdk 24` 低端机上 OOM 风险 | 中 | ★★☆ |
| OPT-12 | `CHANGELOG.md`（86KB 手工维护）按 tag 生成 | 减少发版时的人工整理 | 小 | ★☆☆ |

---

## 7. 发布门（Release Gate）

全绿才允许进 W8：

1. CI：`assembleDebug` + `testDebugUnitTest` 绿
2. golden 三份 `--check` 一致
3. 覆盖安装链 0 处数据差异（v0.24 / v0.28.7 / alpha）
4. 签名指纹 = `6054f9df…a360`，真机覆盖安装通过
5. 假 LLM 全流程清单（W6）逐项打勾
6. 搜索、缓存命中、计费、生图、RP 五条主链路各跑一遍
7. 用户明确说「发」

---

## 8. 附录

### 常用命令

```bash
# 5G 内存的盒子：一律 --no-daemon
./gradlew --no-daemon :app:testDebugUnitTest
./gradlew --no-daemon :app:assembleDebug

# 签名核对
apksigner verify --print-certs app/build/outputs/apk/debug/app-debug.apk

# golden
node tests/golden-export/export.js --check
```

### 文件地图（integ 树）

```
app/src/main/java/com/aichat/app/
  AiChatApp.kt            手写 DI 根（本计划 W2/OPT-3/OPT-7 的主战场）
  data/                   codec / convlog / repo / migration / backup / diag
  domain/                 Contracts.kt、cost/、model/、rp/
  engine/                 DefaultChatEngine.kt、FileContext.kt
  net/                    三协议客户端、Router、Search、NetRetry、StreamParser
  ui/                     AppRoot + chat/ conversation/ library/ settings/ image/
```

### 已知坑

- `integ` 里 `net/Search.kt`、`net/NetRetry.kt` 是**死代码**（引擎没调），别以为已经接上了。
- `versionCode 100` + 同签名 = 单向门，装上就回不到 v0.29.0。
- 调试签名：文档里的指纹来自「盒子」机器；本机 Windows 直接 `assembleDebug` 出来的证书不同 → 覆盖安装会失败，只能卸载（清数据）。
- 旧 JS 的 `usage-stats.jsonl` 里键名是 `cost`（不是 `costUsd`），`costUsd` 只在内存里用。
