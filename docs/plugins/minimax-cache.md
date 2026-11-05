# MiniMax 提示缓存（`plugins/cache/mmcache.js`）

缓存命中优化插件统一放在 `app/src/main/assets/www/plugins/cache/`：

| 文件 | 作用 |
|---|---|
| `cache-common.js` | 公共纯函数：hash、session_id、Token 估算、usage 解析、LCP、成本估算、OpenRouter 渠道判断 |
| `gcache.js` | Gemini 提示缓存（原 `www/gcache.js` 原样迁移，仅 require 相对路径改为 `../../`） |
| `mmcache.js` | MiniMax 提示缓存（本文） |

加载顺序（index.html）：`plugins.js` → `rpcache.js` → … → `plugins/cache/cache-common.js` → `gcache.js` → `mmcache.js` → `app.js`。

## 研究结论（2026-11-05 核对）

来源：MiniMax 官方 [Prompt Caching](https://platform.minimax.io/docs/api-reference/text-prompt-caching)、
[Explicit Prompt Caching (Anthropic API)](https://platform.minimax.io/docs/api-reference/anthropic-api-compatible-cache)、
OpenRouter [Prompt Caching](https://openrouter.ai/docs/features/prompt-caching)、OpenRouter `/api/v1/models` 与 `/models/minimax/minimax-m3.1-flash/endpoints`。

- **OpenRouter 模型 id**：`minimax/minimax-m3.1-flash`（1M ctx），另有 `minimax-m3`、`minimax-m2.7`、`minimax-m2.5`、`minimax-m1`（m1 无缓存价）。
- **自动缓存**：有。MiniMax 官方为被动前缀缓存，无需参数，前缀顺序 `tools → system → messages`；支持 M3.1-Flash / M3 / M2.7 / M2.5 / M2.1。
- **门槛**：≥ 512 输入 Token。
- **TTL**：自动缓存无固定 TTL（随负载）；显式缓存（Anthropic 端点）5 分钟、命中刷新。OpenRouter sticky 会话 10 分钟无活动过期。
- **cache_control**：MiniMax 显式缓存仅自家 Anthropic 兼容端点，支持表只列 M2.x，不含 M3 / M3.1-Flash；OpenRouter 文档没有 MiniMax 段落。→ **证据不足，不发送**。
- **session_id**：OpenRouter 通用 sticky routing 键，带上后首轮即粘到同一供应商（M3.1-Flash 在 OpenRouter 有 10+ 家供应商，sticky 很重要）；`provider.order` 会关闭 sticky。
- **价格**（相对输入价）：m3.1-flash 读 0.1x（$0.15 → $0.015/M）；m3 0.2x；m2.7 0.2x；m2.5 ≈0.11x；OpenRouter 未列 cache write 价，MiniMax 官方说明自动缓存无写入费。

## 策略

1. 闸门 `isOpenRouterMiniMax`：OpenAI 兼容 + OpenRouter（预设 / 域名 / `cacheAdapter=openrouter`）+ 模型 `minimax/*`。与 gcache 的 `isOpenRouterGemini` 互斥；`cacheAdapter=none|openai-compat` 时不生效。
2. 请求改写只做两件事：顶层 `session_id`（对话级稳定，命名空间 `mmcache`，不覆盖已有值）；合并开头连续纯文本 system（顺序不变）。不改 model / provider / 消息顺序，不发 `cache_control`。
3. 统计：按真实 `prompt_tokens_details.cached_tokens` 记录命中、滚动命中率（近 8 次）、按模型价目估算节省；记录 tools+system 前缀指纹与变化位置、请求间 LCP。
4. 诊断：低于 512 Token、前缀频繁变化、`provider.order`、未发 session_id、间隔 > 10 分钟。
5. UI：消息徽章 `🧊 缓存 N%`、顶栏 `命中 N%`（kind: hit，优先级 rpcache > gcache > mmcache），面板 / 设置文案标明 MiniMax。

`supportsCacheControl()` 恒为 false，后续若实测 OpenRouter 对 MiniMax 透传 cache_control 并返回 `cache_write_tokens`，可在此处按模型打开。
