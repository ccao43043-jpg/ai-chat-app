# 插件优化落地状态（v0.8.9）

对应审阅文档 plugin-optimization.md 的第 4 节。

| 项 | 状态 | 说明 |
|---|---|---|
| 4.1 P1 已发送表按身份索引 | ✅ | `gcache.js` HybridWindow：键 `i:<msgId>`，无 id 时 `u#<序号>`；值 `{h: sha256, n: length, sent}`，替换前校验。测试 `tests/gcache-p1.test.js` |
| 3.1 P2 L0 双引号误报 | ✅ | `missingL0` 同时匹配 JSON 转义形式 |
| 4.2 增量指纹 | ✅ | `rpcache.js`：cyrb53 digest 运行时缓存 + 滚动前缀哈希；旧 SHA-256 history_hash 兼容 |
| 4.3 Token 缓存 + 二分截断 | ✅ | `itemTokens` 按 id 缓存；`fallbackTrim` 前缀和 + 二分。测试 `tests/rpcache-p2.test.js`（含 <10ms 性能回归） |
| 4.6 gcache `stat.prefix` 不持久化 | ✅ | 内存 Map 保存上一轮前缀 |
| 4.8 `errors` 上限 | ✅ | 最近 50 条，连续重复合并计数 |
| 4.4 渲染路径缓存 | ⏳ 未做 | 涉及 app.js 渲染流程，后续版本 |
| 4.5 日志瘦身 / 写穿 | ⏳ 未做 | 需按字段实测，后续版本 |
| 4.7 统一估算 / 价格表 | ⏳ 未做 | P3 |
| 4.8 onRequestBody 钩子 / 写时复制 | ⏳ 未做 | P3 |

性能（桌面 Node，600 条约 700KB，`node tests/bench/rpcache-core.bench.js`）：请求核心 36.5ms → 0.63ms（稳态），首轮冷启动约 18ms。
