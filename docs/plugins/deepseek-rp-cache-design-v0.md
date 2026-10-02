# DeepSeek RP Cache Optimizer

一个面向长文本角色扮演（Role-Playing / RP）场景的 DeepSeek API
本地代理与上下文优化器。

> 核心目标：**不是自己实现一个"假缓存"，而是让发送给 DeepSeek
> 的请求拥有更稳定、更长、可重复利用的前缀，从而提高 DeepSeek 服务端
> Context Caching 的实际命中量。**

------------------------------------------------------------------------

## 1. 项目背景

DeepSeek API 已经默认提供 Context Caching on Disk。

DeepSeek
会自动尝试缓存请求中的前缀。后续请求如果能够完整匹配已经形成的缓存前缀单元，对应部分就会产生
cache hit。

API 返回的 `usage` 中包含：

-   `prompt_cache_hit_tokens`
-   `prompt_cache_miss_tokens`

其中：

``` text
prompt_tokens
= prompt_cache_hit_tokens
+ prompt_cache_miss_tokens
```

因此，本项目不需要自己向 DeepSeek 上传或写入"缓存文件"。

本项目的职责是：

1.  保持固定 Prompt 前缀稳定。
2.  将高频变化内容移动到 Prompt 后部。
3.  对 RP 长对话进行记忆压缩。
4.  避免无意义地修改已经缓存的内容。
5.  统计真实 cache hit / miss。
6.  根据统计数据自动优化上下文结构。

------------------------------------------------------------------------

# 2. 核心设计理念

## 2.1 Prefix First

DeepSeek 的缓存重点是 **prefix**。

理想请求：

``` text
[固定世界观]
[固定角色卡]
[固定 RP 规则]
[长期剧情记忆]
[当前剧情状态]
[最近对话]
[玩家最新输入]
```

而不是：

``` text
[当前时间]
[当前状态]
[随机提示]
[世界观]
[角色卡]
[规则]
[最近对话]
```

任何高频变化的信息，如果放在前面，都可能破坏后续请求的可复用前缀。

------------------------------------------------------------------------

# 3. 推荐上下文分层

## Layer 0：Static Prompt

长期不变：

``` text
世界观
角色设定
人物性格
RP规则
输出格式
Few-shot 示例
```

特点：

-   极少修改
-   尽可能保持原始文本完全一致
-   不放当前时间
-   不放实时数值
-   不放随机内容

------------------------------------------------------------------------

## Layer 1：Long-Term Memory

低频修改：

``` text
人物关系
重要历史事件
已经确认的世界状态
重要物品
人物秘密
未解决剧情
长期任务
```

例如：

``` text
【长期记忆】

曹含森与张燕已经认识三个月。

张燕知道曹含森是公司的实际负责人。

两人在第二章发生过一次争执，之后已经和解。

张燕目前不知道曹含森隐藏的真实计划。
```

只有发生重要剧情变化时才更新。

------------------------------------------------------------------------

## Layer 2：Current State

中频修改：

``` text
时间
地点
天气
人物当前位置
当前任务
当前关系状态
当前场景状态
```

这一层应该尽可能放在固定 Prompt 后面。

------------------------------------------------------------------------

## Layer 3：Recent Conversation

高频修改：

``` text
最近 N 轮对话
```

推荐初始值：

``` text
20 ~ 40 轮
```

实际数量应该根据 Token 长度动态调整。

------------------------------------------------------------------------

## Layer 4：Current User Input

永远放在最后：

``` text
玩家最新行动
```

------------------------------------------------------------------------

# 4. 最终请求结构

推荐：

``` text
SYSTEM
│
├── 世界观
├── 角色卡
├── RP规则
├── 输出格式
├── Few-shot
│
├── 长期记忆
│
├── 当前状态
│
└── 最近对话
    │
    └── 玩家最新输入
```

更严格地说：

``` text
PREFIX
├── Static Prompt
├── Long-Term Memory
├── Current State
└── Recent Conversation

CURRENT INPUT
└── Player Message
```

插件应该避免在 Prefix 最前面插入：

``` text
timestamp
random seed
request id
session id
token budget
动态系统提示
随机写作风格
```

------------------------------------------------------------------------

# 5. 为什么不要做"本地回答缓存"

不推荐：

``` text
用户输入
↓
Hash
↓
如果以前出现过
↓
直接返回旧回答
```

因为 RP 中即使用户输入相同：

``` text
“她看着我。”
```

在不同剧情状态下也应该产生不同回答。

例如：

``` text
第10轮：
张燕正在生气。

第100轮：
张燕已经和玩家关系亲密。
```

相同文本对应的正确回复完全不同。

因此本项目缓存的是：

> **上下文组织与 DeepSeek 服务端缓存可复用性**

而不是模型最终回答。

------------------------------------------------------------------------

# 6. Cache Block 数据结构

建议使用 Block 管理 Prompt：

``` json
{
  "id": "character",
  "version": 8,
  "type": "static",
  "content": "角色卡内容",
  "cache_priority": "high"
}
```

完整示例：

``` json
{
  "blocks": [
    {
      "id": "world",
      "version": 3,
      "type": "static",
      "content": "世界观……",
      "cache_priority": "high"
    },
    {
      "id": "character",
      "version": 8,
      "type": "static",
      "content": "角色卡……",
      "cache_priority": "high"
    },
    {
      "id": "rules",
      "version": 2,
      "type": "static",
      "content": "RP规则……",
      "cache_priority": "high"
    },
    {
      "id": "memory",
      "version": 15,
      "type": "memory",
      "content": "长期剧情记忆……",
      "cache_priority": "medium"
    },
    {
      "id": "state",
      "version": 120,
      "type": "dynamic",
      "content": "当前状态……",
      "cache_priority": "low"
    },
    {
      "id": "recent",
      "version": 400,
      "type": "dynamic",
      "content": "最近对话……",
      "cache_priority": "low"
    }
  ]
}
```

------------------------------------------------------------------------

# 7. Block Versioning

每个 Prompt Block 都拥有版本号。

例如：

``` text
world v3
character v8
rules v2
memory v15
```

修改角色卡：

``` text
character v8
↓
character v9
```

插件记录：

``` text
旧版本
character v8

新版本
character v9
```

并重新建立请求上下文。

不要为了更新时间而修改没有变化的 Block。

------------------------------------------------------------------------

# 8. Prompt Canonicalization

为了减少无意义的前缀变化，插件可以进行规范化处理。

例如统一：

-   换行符
-   UTF-8
-   BOM
-   文件编码
-   尾随空格
-   多余空行

但要注意：

> **不要擅自修改角色卡的实际语义。**

推荐只做安全的格式规范化：

``` text
CRLF → LF
UTF-8 BOM → UTF-8
连续 4 个以上空行 → 2 个空行
```

不要自动：

``` text
重写句子
改标点
改变段落顺序
同义词替换
```

因为这些操作可能破坏前缀一致性。

------------------------------------------------------------------------

# 9. RP Memory Engine

这是本项目的重要功能。

## 9.1 记忆分类

将剧情信息分为：

### Permanent

永久事实：

``` text
人物身份
世界规则
人物背景
已经确定的历史
```

### Long-Term

长期记忆：

``` text
人物关系
重要事件
重要承诺
重大秘密
任务
```

### Short-Term

短期状态：

``` text
当前场景
最近事件
临时情绪
当前对话
```

------------------------------------------------------------------------

# 10. 自动记忆压缩

当最近对话达到阈值：

``` text
最近对话 > 30轮
```

触发：

``` text
Memory Extractor
```

让模型提取：

``` text
新人物
重要事件
关系变化
获得物品
失去物品
世界状态变化
未解决问题
重要伏笔
```

然后生成：

``` text
Long-Term Memory
```

再删除已经被压缩的旧对话。

------------------------------------------------------------------------

# 11. 记忆压缩必须避免的问题

不能简单总结成：

``` text
“他们进行了愉快的聊天。”
```

这种总结对于 RP 几乎没有价值。

应该提取：

``` text
人物：
张燕

关系变化：
张燕对曹含森的信任提高。

事件：
曹含森向张燕透露了公司即将进行一次重大调整。

未知信息：
张燕不知道调整背后的真正原因。

未解决问题：
张燕准备调查公司财务记录。
```

------------------------------------------------------------------------

# 12. Cache Monitor

每次 DeepSeek 返回结果后读取：

``` json
{
  "usage": {
    "prompt_tokens": 18000,
    "prompt_cache_hit_tokens": 14500,
    "prompt_cache_miss_tokens": 3500
  }
}
```

计算：

``` text
cache_hit_rate =
prompt_cache_hit_tokens / prompt_tokens
```

例如：

``` text
14500 / 18000
= 80.56%
```

------------------------------------------------------------------------

# 13. 推荐监控面板

``` text
DeepSeek RP Cache Monitor

当前请求
────────────────────────

Prompt Tokens       18,000
Cache Hit            14,500
Cache Miss            3,500

Hit Rate              80.56%

────────────────────────

本会话

Requests                  327
Average Hit Rate          84.7%
Total Prompt Tokens       5.21M
Cached Tokens              4.31M
Miss Tokens                0.90M
```

还可以增加：

``` text
最近20次命中率
平均命中率
最高命中率
最低命中率
连续命中次数
Cache Miss 异常检测
```

------------------------------------------------------------------------

# 14. 自动异常检测

如果：

``` text
最近平均命中率：85%
```

突然：

``` text
当前：12%
```

插件提示：

``` text
⚠ Cache Hit 异常下降

可能原因：

1. System Prompt 被修改
2. 角色卡版本发生变化
3. Prompt 前部出现动态内容
4. 消息顺序发生变化
5. 模型/后端发生变化
6. 缓存尚未建立
```

------------------------------------------------------------------------

# 15. Cache Fingerprint

插件可以对每个 Block 计算 Hash：

``` text
SHA-256(world)
SHA-256(character)
SHA-256(rules)
SHA-256(memory)
```

例如：

``` text
world:
a7f83c...

character:
9c31da...

rules:
e27f11...

memory:
8a90de...
```

这样可以快速判断：

``` text
角色卡有没有变化？
世界观有没有变化？
长期记忆有没有变化？
```

但注意：

> Hash 只是插件内部的版本管理工具，不能用 Hash 代替 DeepSeek
> 的实际缓存匹配。

------------------------------------------------------------------------

# 16. DeepSeek API Proxy

插件可以提供 OpenAI-compatible API。

例如：

``` text
客户端
    ↓
http://127.0.0.1:8787/v1/chat/completions
    ↓
RP Cache Optimizer
    ↓
https://api.deepseek.com/v1/chat/completions
```

客户端只需要修改：

``` text
Base URL
```

而不需要修改自己的 RP 程序。

------------------------------------------------------------------------

# 17. Proxy 工作流程

``` text
收到请求
   ↓
解析 messages
   ↓
识别 System Prompt
   ↓
识别角色卡
   ↓
识别长期记忆
   ↓
识别动态状态
   ↓
规范化固定内容
   ↓
检查 Block Version
   ↓
重组 Prompt
   ↓
发送 DeepSeek
   ↓
读取 usage
   ↓
记录 cache hit / miss
   ↓
返回原始响应
```

------------------------------------------------------------------------

# 18. 不要做过度优化

第一版不要尝试：

``` text
自动重写所有 Prompt
自动改变角色设定
自动改变消息顺序
自动删除历史对话
自动猜测用户意图
```

这些容易导致：

``` text
缓存可能提高
但是 RP 质量下降
```

本项目应该优先保证：

``` text
剧情一致性
>
Prompt 稳定性
>
缓存命中
>
Token 节省
```

------------------------------------------------------------------------

# 19. 推荐技术栈

第一版：

``` text
Python 3.11+

FastAPI
SQLite
httpx
Pydantic
uvicorn
```

可选：

``` text
Jinja2
HTML / CSS / JavaScript
```

不建议第一版直接上：

``` text
Redis
PostgreSQL
Docker Swarm
Kubernetes
消息队列
```

个人 RP 使用完全没有必要。

------------------------------------------------------------------------

# 20. 推荐项目结构

``` text
deepseek-rp-cache/
│
├── main.py
├── config.yaml
├── requirements.txt
│
├── proxy/
│   ├── server.py
│   ├── deepseek.py
│   └── transformer.py
│
├── cache/
│   ├── blocks.py
│   ├── fingerprint.py
│   └── optimizer.py
│
├── memory/
│   ├── manager.py
│   ├── extractor.py
│   └── compressor.py
│
├── database/
│   ├── db.py
│   └── models.py
│
├── monitor/
│   ├── metrics.py
│   └── analyzer.py
│
└── web/
    ├── index.html
    ├── app.js
    └── style.css
```

------------------------------------------------------------------------

# 21. MVP 第一版功能

第一版只实现：

``` text
[必须]

✓ DeepSeek API Proxy
✓ OpenAI-compatible endpoint
✓ Prompt Block 管理
✓ 固定/动态内容分离
✓ Prompt 规范化
✓ Cache Hit / Miss 统计
✓ Hit Rate 统计
✓ SQLite 日志
✓ 基础 Web Dashboard
```

暂时不要做：

``` text
× 自动剧情总结
× 向量数据库
× 多模型路由
× 自动 Prompt 改写
× 云同步
× 多用户
```

------------------------------------------------------------------------

# 22. V2 功能

完成 MVP 后：

``` text
✓ 自动长期记忆
✓ 自动剧情压缩
✓ Cache 异常检测
✓ Prompt 版本控制
✓ 一键恢复旧角色卡
✓ Token 成本统计
✓ 多 RP Session
```

------------------------------------------------------------------------

# 23. V3 功能

高级版本：

``` text
✓ 自动分析哪个 Block 导致 Cache Miss
✓ Prompt A/B 测试
✓ 自动寻找最佳上下文长度
✓ 不同 RP 的独立缓存策略
✓ 多模型适配
✓ Claude / Gemini / OpenAI 等 Provider Adapter
```

------------------------------------------------------------------------

# 24. 一个重要限制

这个项目**不能保证 100% Cache Hit**。

DeepSeek 官方明确说明 Context Caching 使用 best-effort 机制。

因此：

``` text
插件优化
≠
强制 DeepSeek 命中缓存
```

插件能控制的是：

``` text
请求结构
Prompt 前缀稳定性
动态内容位置
上下文压缩
版本管理
```

最终是否产生 cache hit，仍然由 DeepSeek 服务端决定。

------------------------------------------------------------------------

# 25. 最重要的开发原则

## Rule 1

固定内容永远放前面。

## Rule 2

动态内容尽可能放后面。

## Rule 3

不要修改没有变化的 Prompt。

## Rule 4

不要把当前时间放进固定 Prompt。

## Rule 5

不要为了缓存而牺牲 RP 剧情一致性。

## Rule 6

用 DeepSeek API 返回的真实 usage 判断缓存效果。

## Rule 7

不要把"本地缓存"误认为"DeepSeek 服务端缓存"。

------------------------------------------------------------------------

# 26. 参考资料

DeepSeek 官方 Context Caching：

https://api-docs.deepseek.com/guides/kv_cache/

DeepSeek Chat Completions API：

https://api-docs.deepseek.com/api/create-chat-completion/

DeepSeek Models & Pricing：

https://api-docs.deepseek.com/quick_start/pricing/

DeepSeek Chat Prefix Completion：

https://api-docs.deepseek.com/guides/chat_prefix_completion/

------------------------------------------------------------------------

# 27. 项目一句话定义

> **DeepSeek RP Cache Optimizer 是一个面向长文本角色扮演的本地 API
> 代理，通过稳定 Prompt 前缀、分层上下文、长期记忆压缩和实时缓存监控，让
> DeepSeek 自动 Context Caching 更容易复用，同时降低 Token 成本和首
> Token 延迟。**
