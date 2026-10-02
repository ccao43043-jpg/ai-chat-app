# DeepSeek RP Cache Optimizer V1
## 面向长篇角色扮演 API 的上下文缓存优化代理

> **版本：V1.0**
>
> 目标：作为 RP 客户端与 DeepSeek API 之间的本地代理/Context Builder，尽可能保持请求前缀稳定，从而提高 DeepSeek Context Cache 的长期命中表现。
>
> **重要：本项目不是“自己实现 DeepSeek 缓存”。** DeepSeek 的 Context Caching 仍由 DeepSeek 服务端自动管理。本项目负责的是上下文组织、历史压缩、动态状态后置、Token 预算与命中率监控。

---

# 1. 项目目标

长篇 RP 最大的问题不是“模型能不能记住”，而是：

1. 对话越来越长；
2. 世界观、角色卡、规则越来越复杂；
3. 每回合都有动态状态变化；
4. 为了控制上下文长度，需要不断摘要/截断；
5. 一旦前面的 Prompt 被重写，后面的内容可能无法继续命中缓存。

因此 V1 的核心原则只有一句：

> **能不动就不动，能追加就不重写，能摘要就不盲删，能把动态内容放后面就绝不放前面。**

DeepSeek 官方文档说明，其 Context Caching 对输入前缀进行缓存匹配，只有从第 0 个 token 开始连续匹配的前缀才能命中；API 会返回 `prompt_cache_hit_tokens` 和 `prompt_cache_miss_tokens` 用于监控。缓存由服务端自动管理，并非客户端可以强制指定 100% 命中。  
参考：DeepSeek Context Caching 文档。

---

# 2. V1 的工作方式

```text
┌──────────────────────────┐
│        RP 客户端          │
│ SillyTavern / 自制客户端 │
└────────────┬─────────────┘
             │ OpenAI兼容请求
             ▼
┌──────────────────────────┐
│   DeepSeek RP Optimizer  │
│      127.0.0.1:8000      │
├──────────────────────────┤
│ 1. 请求解析               │
│ 2. Prompt 分层             │
│ 3. Context Builder        │
│ 4. Token 预算检查          │
│ 5. 历史摘要                │
│ 6. 动态状态后置             │
│ 7. Cache 指纹监控           │
│ 8. SQLite 统计              │
└────────────┬─────────────┘
             │
             ▼
┌──────────────────────────┐
│       DeepSeek API       │
│ https://api.deepseek.com │
└────────────┬─────────────┘
             │
             ▼
        RP 模型回复
```

RP 客户端只需要把 API Base URL 从：

```text
https://api.deepseek.com
```

改为：

```text
http://127.0.0.1:8000
```

API Key 由本地代理保存并转发。

---

# 3. 最重要的缓存原则

## 3.1 前缀比“内容总量”更重要

不要理解成：

```text
上下文越长 → 缓存越差
```

更准确的理解是：

```text
前面的内容越稳定
        ↓
连续可复用的前缀越长
        ↓
缓存命中 Token 越多
```

因此：

```text
稳定内容
稳定内容
稳定内容
稳定内容
动态内容
当前输入
```

通常比：

```text
动态内容
稳定内容
稳定内容
稳定内容
当前输入
```

更适合缓存。

---

# 4. Context 分层设计

V1 将 RP 上下文拆成 6 层。

```text
L1 永久锚点
L2 长期记忆
L3 章节摘要
L4 最近完整对话
L5 当前动态状态
L6 当前用户输入
```

最终结构：

```text
┌─────────────────────────────┐
│ L1 世界观 / RP规则 / 角色卡 │  ← 极少修改
├─────────────────────────────┤
│ L2 长期记忆                  │  ← 重大事件才修改
├─────────────────────────────┤
│ L3 章节摘要                  │  ← 批量更新
├─────────────────────────────┤
│ L4 最近完整对话              │  ← 只追加
├─────────────────────────────┤
│ L5 动态状态                  │  ← 放在后面
├─────────────────────────────┤
│ L6 当前用户输入              │  ← 最后
└─────────────────────────────┘
```

---

# 5. L1 永久锚点

内容包括：

- 世界观
- 角色卡
- 人物基础资料
- 人物关系基础
- RP 规则
- 输出格式
- Few-shot
- 禁止事项
- 固定写作风格

例如：

```text
[WORLD]
这是一个魔法世界……

[CHARACTER]
曹含森，23岁……

[RP_RULES]
1. NPC不能读取玩家内心
2. NPC只知道自己应该知道的信息
3. 不替玩家决定行动
4. 保持人物性格连续
5. 不跳过关键剧情
```

### 原则

**V1 默认禁止自动修改 L1。**

如果用户修改角色卡，应该明确执行：

```text
UPDATE_STATIC_BLOCK
```

然后记录一个新的版本：

```text
static_v001
static_v002
static_v003
```

不要每回合自动重写。

---

# 6. L2 长期记忆

长期记忆用于保存：

- 已确认的重要事实
- 重要人物关系
- 已发生的重大事件
- 长期目标
- 关键道具
- 已揭开的秘密
- 未解决的重要剧情线

例如：

```text
[LONG_TERM_MEMORY]

人物：
曹含森与张燕目前保持长期合作关系。

事件：
第12章发生了城堡袭击事件。

秘密：
张燕尚不知道曹含森拥有特殊魔法能力。

任务：
调查北方商会失踪事件。
```

## 不推荐

每一回合：

```text
重新总结全部剧情
↓
覆盖旧 Summary
↓
发送新的 Summary
```

因为 Summary 一旦变化，它后面的内容也可能失去原来的前缀连续性。

## 推荐

采用版本化快照：

```text
memory_v001
memory_v002
memory_v003
```

只有发生重要事件时才更新。

---

# 7. L3 章节摘要

这是解决超长 RP 的核心。

假设：

```text
第1～30轮 = 30,000 Token
```

达到摘要阈值后：

```text
第1～30轮
      ↓
Chapter Summary #001
```

然后：

```text
Summary #001
+
第31轮以后完整对话
```

继续运行。

---

# 8. 为什么不能每轮重新摘要

错误方案：

```text
Turn 100
→ Summary A

Turn 101
→ Summary B

Turn 102
→ Summary C
```

如果 Summary 位于大量历史之前，那么每次 Summary 变化都会改变后续输入前缀。

结果可能出现：

```text
缓存前缀
██████████████████

Summary 修改
██████████████████ ❌

后续历史
██████████████████ ❌
```

因此 V1 使用：

> **Frozen Summary Snapshot**

摘要不是“实时状态”，而是“阶段性快照”。

---

# 9. 推荐摘要策略

默认工程参数：

```yaml
summary:
  enabled: true
  trigger_tokens: 30000
  min_new_turns: 15
  keep_recent_turns: 20
```

注意：

**30000 Token 不是 DeepSeek 官方规定的阈值。**

它只是 V1 的工程起始值。

实际使用时应该根据：

- 模型上下文窗口
- RP 客户端
- 平均回复长度
- 缓存命中率
- 摘要质量

进行调整。

---

# 10. 摘要必须保存“知识边界”

普通摘要容易出现 RP 最大的问题：

> NPC突然知道了自己本来不应该知道的事情。

所以 Summary 必须区分：

```text
FACTS
已确认事实

CHARACTER_KNOWLEDGE
角色A知道什么

PLAYER_KNOWLEDGE
玩家知道什么

SECRET
尚未公开的秘密

UNRESOLVED
未解决事件

RELATIONSHIPS
人物关系

OBJECTS
关键物品

LOCATION
地点状态
```

例如：

```text
[CHAPTER SUMMARY]

FACTS:
曹含森进入北境城市。

PLAYER_KNOWLEDGE:
玩家知道商会正在调查失踪案。

ZHANG_YAN_KNOWLEDGE:
张燕只知道失踪案与北方商人有关。

SECRET:
张燕不知道曹含森已经发现内鬼。

UNRESOLVED:
真正的幕后组织尚未确认。
```

---

# 11. L4 最近完整对话

最近对话应该：

> **只追加，不重写。**

例如：

```text
user
assistant
user
assistant
user
assistant
```

每次新请求：

```text
旧历史
+
新的 user
```

而不是：

```text
旧历史
+
重新格式化的历史
+
新的 user
```

---

# 12. L5 动态状态

动态状态包括：

- HP
- MP
- 金钱
- 时间
- 地点
- 好感度
- 天气
- 当前任务
- 战斗状态
- 装备
- Buff / Debuff

例如：

```text
[CURRENT_STATE]

Location: 王都西区
Time: 21:40
HP: 82/100
MP: 55/100
Gold: 1380
Quest: 调查失踪商人
ZhangYan_Affection: 37
```

---

# 13. 动态状态为什么要放后面

错误：

```text
STATE
WORLD
CHARACTER
HISTORY
CURRENT INPUT
```

每回合：

```text
HP 80
↓
HP 78
↓
HP 73
```

那么从 HP 开始的整个后续前缀都可能发生变化。

推荐：

```text
WORLD
CHARACTER
MEMORY
SUMMARY
HISTORY
STATE
INPUT
```

这样：

```text
WORLD ──────────────── 稳定
CHARACTER ──────────── 稳定
MEMORY ─────────────── 大部分稳定
SUMMARY ────────────── 稳定
HISTORY ────────────── 追加
STATE ──────────────── 动态
INPUT ──────────────── 动态
```

---

# 14. L6 当前用户输入

当前输入永远放最后：

```text
[CURRENT_STATE]
...

[USER_INPUT]
曹含森推开房门。
```

不要：

```text
[USER_INPUT]
曹含森推开房门。

[WORLD]
...

[HISTORY]
...
```

---

# 15. Context Builder

核心伪代码：

```python
def build_context(request):

    static = load_static_version()
    memory = load_memory_version()
    summary = load_summary_version()
    history = load_recent_history()
    state = load_current_state()
    user_input = request.user_input

    context = []

    context += static
    context += memory
    context += summary
    context += history

    if over_budget(context):
        summary = compress_old_history(
            history
        )

        save_new_summary(summary)

        history = keep_recent_history()

        context = (
            static
            + memory
            + summary
            + history
        )

    context += state
    context += user_input

    return context
```

---

# 16. Token Budget

V1 不应该简单地：

```python
messages = messages[-20:]
```

因为这会直接丢掉旧信息。

正确流程：

```text
检查 Token
      ↓
是否超预算？
      ↓
   否 → 直接发送
   是
      ↓
找到最旧的一批历史
      ↓
生成章节摘要
      ↓
保存 Summary Snapshot
      ↓
删除已摘要历史
      ↓
保留最近完整对话
      ↓
重新计算 Token
      ↓
发送
```

---

# 17. Token 预算公式

设：

```text
MAX_CONTEXT = 模型可用上下文预算
```

则：

```text
STATIC
+
MEMORY
+
SUMMARY
+
RECENT_HISTORY
+
STATE
+
CURRENT_INPUT
+
OUTPUT_RESERVE
<= MAX_CONTEXT
```

建议预留：

```yaml
token_budget:
  max_context: 100000
  output_reserve: 12000
  safety_margin: 2000
```

实际值根据所使用的模型调整。

---

# 18. 版本化机制

每个重要 Block 都拥有：

```text
id
version
hash
updated_at
token_count
```

例如：

```text
STATIC
version = 12
hash = a8f92c...
tokens = 8200
```

每次请求前：

```text
计算 hash
↓
与上一次比较
↓
是否发生变化？
```

如果：

```text
static_hash 不变
memory_hash 不变
summary_hash 不变
```

则说明稳定前缀没有被本地 Context Builder 主动修改。

---

# 19. Cache Fingerprint

V1 可以计算：

```text
static_hash
memory_hash
summary_hash
history_hash
state_hash
full_prefix_hash
```

用于诊断。

例如：

```text
Request #203

static:  SAME
memory:  SAME
summary: SAME
history: APPEND
state:   CHANGED
input:   CHANGED
```

这是理想状态。

---

# 20. Cache 命中监控

DeepSeek API 返回：

```json
{
  "usage": {
    "prompt_tokens": 10000,
    "prompt_cache_hit_tokens": 9000,
    "prompt_cache_miss_tokens": 1000
  }
}
```

V1 保存：

```text
request_id
timestamp
model
prompt_tokens
cache_hit_tokens
cache_miss_tokens
completion_tokens
hit_rate
static_hash
memory_hash
summary_hash
history_hash
state_hash
```

DeepSeek 官方 API 文档明确提供 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`，且 `prompt_tokens = hit + miss`。

---

# 21. 命中率计算

```python
hit_rate = (
    hit_tokens /
    (hit_tokens + miss_tokens)
)
```

例如：

```text
Hit = 334208
Miss = 28196
```

则：

```text
Hit Rate ≈ 92.22%
```

---

# 22. 不要只看命中率

例如：

```text
请求A：
Hit = 900
Miss = 100
命中率 = 90%

请求B：
Hit = 90000
Miss = 10000
命中率 = 90%
```

两者命中率一样。

但 B 的实际缓存利用规模大得多。

因此 Dashboard 同时显示：

```text
Cache Hit Rate
Cache Hit Tokens
Cache Miss Tokens
Prompt Tokens
Average Hit Rate
Average Miss Tokens / Request
```

---

# 23. Cache 异常检测

V1 建议加入简单异常检测。

例如最近：

```text
92%
93%
91%
92%
93%
```

突然：

```text
41%
```

触发：

```text
⚠ Cache Hit Drop
```

然后检查：

```text
Static Hash
Memory Hash
Summary Hash
History Hash
State Hash
```

如果发现：

```text
summary_hash changed
```

则提示：

```text
可能原因：
Summary 被重新生成/修改
导致稳定前缀发生变化。
```

---

# 24. 推荐 Dashboard

首页：

```text
DeepSeek RP Cache Optimizer

────────────────────────────

今日请求：
46

Prompt Tokens：
362,404

Cache Hit：
334,208

Cache Miss：
28,196

Hit Rate：
92.22%

────────────────────────────

最近20次：

#46   91.8%
#45   93.2%
#44   92.7%
#43   90.4%
...
```

再显示：

```text
Context

Static        8,240
Memory        3,120
Summary       9,800
History      32,500
State           480
Current Input   120
```

---

# 25. 推荐技术栈

V1：

```text
Python 3.11+
FastAPI
httpx
Pydantic
SQLite
uvicorn
tiktoken / 对应 Tokenizer
Jinja2
```

推荐目录：

```text
deepseek-rp-cache-optimizer/
│
├── main.py
├── config.yaml
├── requirements.txt
├── README.md
│
├── context/
│   ├── __init__.py
│   ├── builder.py
│   ├── tokenizer.py
│   ├── history.py
│   ├── summary.py
│   └── state.py
│
├── memory/
│   ├── __init__.py
│   └── manager.py
│
├── deepseek/
│   ├── __init__.py
│   └── client.py
│
├── monitor/
│   ├── __init__.py
│   └── metrics.py
│
├── database/
│   ├── __init__.py
│   └── db.py
│
├── web/
│   ├── __init__.py
│   ├── dashboard.py
│   └── templates/
│
└── data/
    ├── rp.db
    ├── logs/
    └── snapshots/
```

---

# 26. config.yaml

建议：

```yaml
server:
  host: "127.0.0.1"
  port: 8000

deepseek:
  base_url: "https://api.deepseek.com"
  api_key: "${DEEPSEEK_API_KEY}"
  timeout: 180

context:
  max_context_tokens: 100000
  output_reserve_tokens: 12000
  safety_margin_tokens: 2000

summary:
  enabled: true
  trigger_tokens: 30000
  min_new_turns: 15
  keep_recent_turns: 20

monitor:
  enabled: true
  database: "./data/rp.db"

debug:
  save_prompt: false
  log_hashes: true
```

---

# 27. API 兼容目标

V1 应尽量保持 OpenAI-compatible：

```http
POST /v1/chat/completions
```

请求：

```json
{
  "model": "deepseek-flash",
  "messages": [
    {
      "role": "user",
      "content": "你好"
    }
  ],
  "stream": true
}
```

代理：

```text
RP Client
   ↓
POST /v1/chat/completions
   ↓
Context Builder
   ↓
DeepSeek
   ↓
原样/兼容返回
```

这样可以最大限度减少对现有 RP 客户端的修改。

---

# 28. Streaming

V1 必须支持：

```json
"stream": true
```

因为 RP 客户端通常需要流式输出。

代理应：

```text
DeepSeek SSE
      ↓
FastAPI StreamingResponse
      ↓
RP Client
```

不能为了监控缓存而把整个回复等待完再一次性返回。

---

# 29. API Key 安全

不要把：

```text
DEEPSEEK_API_KEY
```

硬编码进 Python。

推荐：

Linux/macOS：

```bash
export DEEPSEEK_API_KEY="你的Key"
```

Windows：

```powershell
setx DEEPSEEK_API_KEY "你的Key"
```

或者：

```text
.env
```

并加入：

```text
.gitignore
```

---

# 30. V1 功能范围

## 必须实现

```text
[x] OpenAI兼容代理
[x] DeepSeek转发
[x] Streaming
[x] Context Builder
[x] 静态 Prompt
[x] 长期 Memory
[x] Summary Snapshot
[x] 最近历史
[x] Dynamic State
[x] Token Budget
[x] Cache Hit/Miss 统计
[x] SQLite
[x] Hash 指纹
[x] Dashboard
```

---

# 31. V1 暂时不要做

为了避免第一版变成一艘装满雷达的航空母舰，以下功能暂时不做：

```text
[ ] 多模型自动路由
[ ] 自动选择多个API供应商
[ ] 自动改写角色卡
[ ] 自动修改世界观
[ ] 自动改变 Temperature
[ ] 自动预测缓存
[ ] 自己实现 KV Cache
[ ] 本地运行 DeepSeek 模型
[ ] 自动判断“剧情应该怎么发展”
```

尤其：

> **不要让优化器擅自修改 RP 内容。**

它应该优化：

```text
上下文结构
```

而不是优化：

```text
剧情本身
```

---

# 32. V2

未来可以增加：

```text
多 RP Session
```

例如：

```text
/session/caohansen
/session/world_a
/session/world_b
```

每个 Session 独立：

```text
Static
Memory
Summary
History
State
Metrics
```

---

# 33. V2 自动记忆提取

模型可以辅助判断：

```text
这一轮是否值得进入长期记忆？
```

例如：

```text
普通闲聊
→ 不保存

重大剧情
→ 保存

新人物出现
→ 保存

人物关系发生重大变化
→ 保存

秘密揭露
→ 保存

获得关键道具
→ 保存
```

但是：

> 自动记忆必须经过规则过滤，不能让 LLM 每一轮自由改写长期记忆。

---

# 34. V3 智能缓存优化

V3 可以根据历史统计：

```text
命中率
Token长度
摘要频率
摘要造成的命中下降
```

自动调整：

```text
Summary Trigger
Recent History Size
Memory Update Frequency
Token Reserve
```

例如：

```text
如果摘要后平均命中率下降很明显
→ 降低摘要频率

如果上下文经常爆掉
→ 提前摘要

如果命中率长期稳定
→ 保持当前策略
```

---

# 35. 最重要的设计取舍

## 方案 A：追求100%缓存命中

不推荐。

因为：

```text
不修改历史
不更新状态
不摘要
不压缩
```

最终会导致：

```text
Context 爆炸
```

## 方案 B：不断压缩 Context

也不推荐。

因为：

```text
每次摘要
→ 前缀变化
→ 缓存断裂
```

## 方案 C：分阶段冻结

V1 采用：

```text
稳定前缀
    ↓
阶段性摘要
    ↓
冻结
    ↓
继续追加
    ↓
达到阈值
    ↓
下一次阶段性摘要
```

这是整个项目的核心策略。

---

# 36. 一个完整 RP 生命周期

假设：

```text
0～20轮
```

保持：

```text
Static
Memory
History
State
Input
```

↓

```text
20～40轮
```

继续追加。

↓

```text
History 达到 30K Token
```

执行：

```text
Summary #001
```

变成：

```text
Static
Memory
Summary #001
Recent History
State
Input
```

↓

继续：

```text
40～70轮
```

↓

再次达到阈值：

```text
Summary #002
```

最终：

```text
Static
Memory
Summary #002
Recent History
State
Input
```

---

# 37. 缓存优化的核心思想

不要追求：

```text
“每一轮都重新整理Prompt”
```

而应该追求：

```text
“让前面的东西尽可能多年不变”
```

在长篇 RP 中：

```text
世界观
角色卡
规则
Few-shot
长期记忆
章节摘要
```

都是“缓存资产”。

而：

```text
HP
时间
地点
好感度
最新剧情
当前输入
```

都是“动态资产”。

V1 的任务就是：

> **让缓存资产尽可能长，让动态资产尽可能晚出现。**

---

# 38. 失败模式

## 失败模式 1：动态状态放在 System 最前面

```text
STATE
WORLD
CHARACTER
HISTORY
```

问题：

```text
STATE 每次变化
↓
后面的全部内容可能无法继续作为相同前缀
```

解决：

```text
WORLD
CHARACTER
HISTORY
STATE
INPUT
```

---

## 失败模式 2：每轮重写 Summary

```text
Summary 1
Summary 2
Summary 3
Summary 4
```

问题：

```text
前缀不断变化
```

解决：

```text
Frozen Summary
```

---

## 失败模式 3：重新排序历史

不要：

```text
第1轮
第3轮
第2轮
第5轮
```

更不要：

```text
系统把“最重要对话”自动移动到最前面
```

这会破坏原有前缀结构。

---

## 失败模式 4：为了省 Token 每轮重新压缩所有内容

这种方法可能节省输入 Token，却牺牲缓存稳定性。

V1 优先：

```text
稳定性
```

而不是：

```text
每一轮都最短
```

---

# 39. Dashboard 应该回答的 5 个问题

每次出现缓存下降时，用户应该能够看到：

### 1

```text
这次命中了多少？
```

### 2

```text
为什么没命中？
```

### 3

```text
哪个 Block 发生变化？
```

### 4

```text
是不是发生了摘要？
```

### 5

```text
是不是 Token 超预算？
```

因此 V1 的监控不是单纯：

```text
92%
```

而是：

```text
92%

Static       SAME
Memory       SAME
Summary      SAME
History      APPEND
State        CHANGED
Input        CHANGED

Reason:
正常动态更新
```

---

# 40. 安全原则

代理默认：

```text
不上传本地日志
不上传 API Key
不保存完整 Prompt
```

除非用户主动开启：

```yaml
debug:
  save_prompt: true
```

默认只保存：

```text
Token统计
Hash
时间
模型
请求ID
```

如果开启完整 Prompt 日志，应明确提示：

> 日志可能包含角色卡、私密剧情、API 请求内容，请谨慎使用。

---

# 41. 最终目标

最终希望达到：

```text
普通 RP API
        ↓
长 Prompt
        ↓
缓存表现随时间恶化
```

变成：

```text
RP Client
        ↓
Cache Optimizer
        ↓
稳定 Prefix
        ↓
阶段性 Summary
        ↓
动态 State 后置
        ↓
DeepSeek
        ↓
高稳定缓存命中
```

---

# 42. V1 开发顺序

严格按照：

```text
Step 1
OpenAI兼容 Proxy

↓

Step 2
DeepSeek Forward

↓

Step 3
Cache Metrics

↓

Step 4
SQLite

↓

Step 5
Context Builder

↓

Step 6
Static / Memory / History / State 分层

↓

Step 7
Token Budget

↓

Step 8
Summary Snapshot

↓

Step 9
Hash / Anomaly Detection

↓

Step 10
Dashboard
```

不要一开始就做自动记忆、AI摘要、自动路由等复杂功能。

先让：

```text
请求 → 优化 → DeepSeek → 返回
```

稳定运行。

---

# 43. 验收标准

V1 至少满足：

```text
[ ] RP客户端可以正常连接
[ ] DeepSeek可以正常返回
[ ] Streaming正常
[ ] 原始messages不会无故丢失
[ ] Static不会每轮重写
[ ] History保持顺序
[ ] State默认位于动态区域
[ ] 超预算可以自动摘要
[ ] Summary具有版本号
[ ] Cache Hit/Miss可以记录
[ ] 可以查看历史命中率
[ ] 可以发现命中率异常
[ ] API Key不会写死
```

---

# 44. 关于“92%命中率”的目标

如果当前已经能达到约 92%：

**不要为了追求一个漂亮的 99% 数字而牺牲 RP 上下文质量。**

更合理的目标是：

```text
高稳定性
+
低 Miss Token
+
长时间运行不崩
+
摘要后可控
+
剧情连续
```

尤其要关注：

```text
Miss Tokens / Request
```

而不只是：

```text
Hit Rate
```

---

# 45. 重要官方资料

DeepSeek Context Caching：
https://api-docs.deepseek.com/guides/kv_cache/

DeepSeek Chat Completions：
https://api-docs.deepseek.com/api/create-chat-completion/

DeepSeek 多轮对话：
https://api-docs.deepseek.com/guides/multi_round_chat/

DeepSeek Responses API：
https://api-docs.deepseek.com/api/create-response/

---

# 46. 一句话总结

这个项目不是：

> “我自己造一个缓存系统。”

而是：

> **“我给 DeepSeek 喂一个结构稳定、长期可复用、动态信息尽量后置的上下文。”**

最终架构：

```text
固定世界观
    ↓
固定角色
    ↓
长期记忆
    ↓
冻结章节摘要
    ↓
最近完整历史
    ↓
动态状态
    ↓
当前输入
    ↓
DeepSeek
```

**这就是 DeepSeek RP Cache Optimizer V1 的核心。**
