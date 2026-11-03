/* 内置插件：OpenRouter · Gemini 角色扮演提示缓存优化（移植自 ai-chat 4.1.3 plugins/rp_gemini_cache）
 * 原理：OpenRouter 对 Gemini 支持 Anthropic 风格的 cache_control 显式缓存断点（只有最后一个断点生效，读取约 0.25x 输入价）；
 *       Gemini 2.5+ 另有默认开启的隐式缓存（TTL 约 3~5 分钟）。两者都要求请求「前缀」逐字节一致才能命中。
 * 只在「OpenRouter 服务商 + Gemini 模型」的请求上生效，其他请求逐字节不变。
 * 纯逻辑部分（isOpenRouterGemini / applyToRequest / usageInfo）可在 Node 中测试；插件注册仅在浏览器中进行。
 */
(function (root) {
  'use strict';
  const ID = 'gcache';
  // v1.1.0（算法规格 v1.0）：mode 新增 auto（推荐默认：隐式优先，前缀够长且稳定才打显式断点）；rpGuardrails: auto|on|off；sessionId：稳定 session_id
  const DEFAULTS = { mode: 'auto', mergeSystem: true, ttl: '', responseCache: false, toast: true, sessionId: true, rpGuardrails: 'auto', diagToast: true, hybrid: true, autoTarget: 'history', writePrice: 1.0, keepaliveMaxPings: 3, missAlert: true };
  /** 固定层版本：协议锚点文本 / 分层规则变更时必须 +1（变更会让 static_hash 变化，缓存需重新写入） */
  const STATIC_PROMPT_VERSION = 1;
  /** 诊断阈值：滚动命中率 <40% 触发诊断，≥70% 视为良好 */
  const DIAG_LOW = 40, DIAG_GOOD = 70, ROLL_N = 8;
  /** 公开价目倍率（相对普通输入价，按价目表估算；token 数始终取真实 usage）：Gemini 2.5+ 缓存读取约 0.25x，OpenRouter 显式写入约 1x（另有少量存储费） */
  const PRICE = { read: 0.25, write: 1.0 };

  /** 简易稳定哈希（FNV-1a 32 位，十六进制），用于 static_hash / 前缀指纹 / session_id */
  function hash(str) {
    let h = 0x811c9dc5; const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  /** 静态层指纹：先按原始字符串 === 比较，与上次相同则复用上次哈希，避免重复计算 */
  let lastStatic = null, lastStaticHash = '';
  function staticHash(st) {
    const key = STATIC_PROMPT_VERSION + '\n' + st;
    if (key === lastStatic) return lastStaticHash;
    lastStatic = key; lastStaticHash = hash(key); return lastStaticHash;
  }
  /** 是否为 OpenRouter 上的 Gemini 模型 */
  function isOpenRouterGemini(provider, model) {
    const p = provider || {};
    if (p.type && p.type !== 'openai') return false;
    const isOR = p.presetId === 'openrouter' || /openrouter\.ai/i.test(String(p.baseUrl || ''));
    if (!isOR) return false;
    const m = String(model || '').toLowerCase();
    return m.startsWith('google/gemini') || m.startsWith('~google/gemini') || /(^|\/)gemini-/.test(m);
  }

  const partsText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p && p.type === 'text' ? p.text : '[' + ((p && p.type) || '?') + ']').join('') : JSON.stringify(c == null ? '' : c);
  const hasText = c => (typeof c === 'string' && !!c) || (Array.isArray(c) && c.some(p => p && p.type === 'text' && p.text));

  function stripCC(msg) {
    if (!Array.isArray(msg.content)) return;
    msg.content = msg.content.map(p => { if (p && p.cache_control) { const q = Object.assign({}, p); delete q.cache_control; return q; } return p; });
    // 只剩一段纯文本时还原为字符串，保持与未开启时一致的结构
    if (msg.content.length === 1 && msg.content[0].type === 'text' && Object.keys(msg.content[0]).length === 2) msg.content = msg.content[0].text;
  }
  function addBreakpoint(msg, ttl) {
    const cc = { type: 'ephemeral' }; if (ttl) cc.ttl = ttl;
    const c = msg.content;
    if (typeof c === 'string') { if (!c) return false; msg.content = [{ type: 'text', text: c, cache_control: cc }]; return true; }
    if (Array.isArray(c)) for (let i = c.length - 1; i >= 0; i--) {
      if (c[i] && c[i].type === 'text' && c[i].text) { c[i] = Object.assign({}, c[i], { cache_control: cc }); return true; }
    }
    return false;
  }
  function firstDiff(a, b) {
    const n = Math.min(a.length, b.length); let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return { pos: i, before: a.slice(Math.max(0, i - 30), i + 50), after: b.slice(Math.max(0, i - 30), i + 50) };
  }


  // ───────────────────────── PromptBuilder：分层指纹 ─────────────────────────
  /** RP 协议锚点（固定层 A）。文本必须简短稳定；修改时同时 bump STATIC_PROMPT_VERSION */
  const RP_ANCHOR = '【RP 协议】\n- 玩家角色的言行与决定只由玩家给出：不替玩家说话、行动或做选择。\n- NPC 的猜测、推断只能以猜测的口吻呈现，不得写成既定事实。\n- 人物核心性格保持一致；情绪、伤势、位置等临时状态单独描述，不改写核心设定。';
  // A–D 固定层：协议 / 世界 / 人物核心 / 玩法规则（与 rpcache 分段标题兼容）；E–G 动态层：长期记忆 / 近期剧情 / 当前场景（本轮输入在 user 消息里）
  const LAYERS = [
    ['A', 'static', /^(RP ?协议|协议|系统协议)$/i], ['B', 'static', /^(世界观|世界背景|背景设定|世界设定)$/],
    ['C', 'static', /^(角色卡|角色设定|人物设定|角色|人物核心|核心性格)$/], ['D', 'static', /^(RP ?规则|规则|扮演规则|玩法规则|输出格式|回复格式|格式|示例对白|示例对话|对白示例|禁止事项|禁止|写作风格|文风|风格)$/i],
    ['E', 'dynamic', /^(长期记忆|记忆|剧情摘要|摘要|章节摘要|前情提要)$/], ['F', 'dynamic', /^(近期剧情|最近剧情|近期事件)$/],
    ['G', 'dynamic', /^(当前场景|当前状态|状态|场景|临时状态)$/],
  ];
  const HEAD_RE = /^\s*(?:#+\s*)?(?:\*\*)?【([^】]{1,12})】/;
  /**
   * 把 system 文本按【标题】分段，返回 { blocks:[{layer,kind,title,text}], staticText, dynamicText, static_hash, dynamic_hash, layered, ordered }
   * 无标题的开头文本视为固定层（A 之前的前言）。layered=识别到 ≥2 个已知分段；ordered=动态段全部位于固定段之后。
   */
  function analyzeLayers(text) {
    const blocks = []; let cur = { layer: '-', kind: 'static', title: '', lines: [] }; let known = 0;
    String(text || '').split('\n').forEach(line => {
      const m = line.match(HEAD_RE);
      if (m) {
        const t = m[1].trim(), L = LAYERS.find(x => x[2].test(t));
        if (cur.lines.length) blocks.push(cur);
        cur = { layer: L ? L[0] : '?', kind: L ? L[1] : 'static', title: t, lines: [line] }; if (L) known++;
        return;
      }
      cur.lines.push(line);
    });
    if (cur.lines.length) blocks.push(cur);
    blocks.forEach(b => { b.text = b.lines.join('\n'); delete b.lines; });
    const st = blocks.filter(b => b.kind === 'static').map(b => b.text).join('\n');
    const dy = blocks.filter(b => b.kind === 'dynamic').map(b => b.text).join('\n');
    let seenDyn = false, ordered = true;
    blocks.forEach(b => { if (b.kind === 'dynamic') seenDyn = true; else if (seenDyn) ordered = false; });
    return { blocks, staticText: st, dynamicText: dy, static_hash: staticHash(st), dynamic_hash: hash(dy), layered: known >= 2, ordered, static_prompt_version: STATIC_PROMPT_VERSION };
  }
  const PromptBuilder = { RP_ANCHOR, LAYERS, analyzeLayers, hash, STATIC_PROMPT_VERSION };

  // ───────────────────────── CachePolicyEngine：隐式优先 ─────────────────────────
  /** Gemini 显式缓存最小前缀（Token，保守取值）：Flash 系 1024，Pro 系 4096 */
  function minCacheTokens(model) { return /pro/i.test(String(model || '')) ? 4096 : 1024; }
  /** 粗估 Token（仅用于决策门槛，不用于统计）：CJK 约 1 字 1 Token，其他约 4 字符 1 Token */
  function estTokens(s) { s = String(s || ''); const cjk = (s.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length; return Math.ceil(cjk + (s.length - cjk) / 4); }
  /**
   * 决定本轮是否打显式断点。mode=auto：固定前缀 ≥ 门槛 且 与上一轮 static_hash 相同（证明可复用，收益>写入成本）才启用；否则走隐式缓存。
   * 绝不填充文本凑门槛。返回 { explicit:boolean, reason }
   */
  function decide(cfg, info) {
    const mode = cfg.mode;
    if (mode === 'off') return { explicit: false, reason: '已关闭显式断点，仅隐式缓存' };
    if (mode === 'prefix' || mode === 'history') return { explicit: true, reason: '手动模式：' + mode };
    const need = minCacheTokens(info.model), have = estTokens(info.staticText);
    if (have < need) return { explicit: false, reason: '固定前缀约 ' + have + ' Token < 门槛 ' + need + '，走隐式缓存（不填充凑门槛）' };
    if (!info.prevStaticHash) return { explicit: false, reason: '首轮先走隐式缓存，确认前缀稳定后再写显式缓存' };
    if (info.prevStaticHash !== info.static_hash) return { explicit: false, reason: '固定层刚发生变化，本轮不写显式缓存' };
    return { explicit: true, reason: '固定前缀约 ' + have + ' Token 且稳定，启用显式断点' };
  }
  /** v1.3：auto + Hybrid 时断点放到「本轮 user 之前」（等价 history），门槛按「固定前缀+历史」估算，仍要求固定层稳定 */
  function decideHistory(cfg, info) {
    const need = minCacheTokens(info.model), have = estTokens(info.cacheText);
    if (have < need) return { explicit: false, reason: '固定前缀+历史约 ' + have + ' Token < 门槛 ' + need + '，走隐式缓存' };
    if (!info.prevStaticHash) return { explicit: false, reason: '首轮先走隐式缓存，确认前缀稳定后再写显式缓存' };
    if (info.prevStaticHash !== info.static_hash) return { explicit: false, reason: '固定层刚发生变化，本轮不写显式缓存' };
    return { explicit: true, history: true, reason: '固定前缀+历史约 ' + have + ' Token 且固定层稳定，断点放在本轮 user 之前（历史进缓存）' };
  }
  const CachePolicyEngine = { decide, decideHistory, minCacheTokens, estTokens, DIAG_LOW, DIAG_GOOD };

  // ───────────────────────── ProviderAdapters：OpenRouter ─────────────────────────
  /** 由对话 id 生成稳定 session_id（≤256 字符，UUID 形状）；同一对话恒定，换对话即换 */
  function sessionIdFor(convId) {
    if (convId == null || convId === '') return '';
    const s = String(convId), h = [hash(s), hash('a' + s), hash('b' + s), hash('c' + s)].join('');
    return 'aichat-' + h.slice(0, 8) + '-' + h.slice(8, 12) + '-4' + h.slice(13, 16) + '-8' + h.slice(17, 20) + '-' + h.slice(20, 32);
  }
  const OpenRouterAdapter = {
    sessionIdFor,
    /** 写入 session_id（OpenRouter 官方 sticky routing 字段：请求体顶层 session_id，优先于 x-session-id 头）；不改 model / provider 路由偏好 */
    applySession(body, sid) { if (sid && body.session_id == null) body.session_id = sid; return body; },
    /** 记录路由指纹：model + provider 偏好（只读，用于诊断「是否每轮改了模型/供应商」） */
    routeOf(body) { return { model: body.model || '', provider: body.provider ? JSON.stringify(body.provider) : '' }; },
    usage: usageInfo,
  };
  const ProviderAdapters = { openrouter: OpenRouterAdapter };

  // ───────────────────────── MemoryManager：L0–L3 ─────────────────────────
  // L0 核心（人物核心 / 世界铁律，永不自动压缩）· L1 长期记忆（摘要）· L2 近期剧情 · L3 原始历史（压缩后保留，只存指针不删原文）
  const tokenize = s => { s = String(s || '').toLowerCase(); const out = new Set(); (s.match(/[a-z0-9]+/g) || []).forEach(w => out.add(w)); const c = s.replace(/[^\u4e00-\u9fff]/g, ''); for (let i = 0; i < c.length - 1; i++) out.add(c.slice(i, i + 2)); return out; };
  /** 关键词/二元组重叠评分（0~1），轻量语义检索替代 */
  function score(query, text) { const q = tokenize(query), t = tokenize(text); if (!q.size || !t.size) return 0; let n = 0; q.forEach(w => { if (t.has(w)) n++; }); return n / q.size; }
  /** 从分层结果抽 L0：人物核心(C)/世界(B)/协议(A) 的非空行，各自指纹 */
  function extractL0(layers) {
    const out = [];
    (layers.blocks || []).filter(b => b.layer === 'A' || b.layer === 'B' || b.layer === 'C').forEach(b => b.text.split('\n').slice(1).map(x => x.trim()).filter(x => x.length >= 4).forEach(x => out.push({ layer: b.layer, text: x, fp: hash(x) })));
    return out;
  }
  const MemoryManager = {
    score, extractL0,
    /** 检索：按评分返回前 k 条 */
    search(entries, query, k) { return (entries || []).map(e => ({ e, s: score(query, e.text) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, k || 5).map(x => Object.assign({ score: Math.round(x.s * 100) / 100 }, x.e)); },
    /** 诊断误压缩：L0 条目不在本轮请求文本里即视为丢失 */
    missingL0(entries, requestText) { const t = String(requestText || ''); return (entries || []).filter(e => t.indexOf(e.text) < 0 && t.indexOf(JSON.stringify(String(e.text)).slice(1, -1)) < 0); }, // 请求体是 JSON：同时按转义后的形式匹配（含 " \\ 的设定行不再误报）
    /** 记录压缩前原始历史指针（不复制原文，原文仍在对话消息里） */
    backupPointer(messages) { const m = messages || []; return { at: Date.now(), count: m.length, fp: hash(m.map(x => x && x.role + ':' + partsText(x.content)).join('\n')) }; },
  };


  // ───────────────────────── HybridWindow（Hybrid-5：Zip 迟滞滑动窗口） ─────────────────────────
  // 历史原文保留 RAW_MIN~RAW_MAX 轮：满 RAW_MAX 时把最早 (RAW_MAX-RAW_MIN) 轮压成一段摘要（只生成一次、持久化、冻结），之后保留 RAW_MIN 轮。
  // 「摘要+窗口」前缀每 20 轮才变化一次。摘要为本地启发式（离线、确定性），不调用模型。
  const RAW_MIN = 20, RAW_MAX = 40, SUM_HEAD = '【前情提要（冻结摘要）】';
  const HW_SENT_MAX = 120;
  // 问题 1：冻结摘要上限。总长（字符）超 SUM_CAP 时，在 20 轮边界把最早 SUM_MERGE_K 段合并为一段更短的二级摘要
  const SUM_CAP = 8000, SUM_MERGE_K = 4, SUM_L2_LINE = 36, SUM_L2_MIN = 8;
  const sumLen = ss => ss.reduce((a, s) => a + s.text.length, 0) + Math.max(0, ss.length - 1);
  /** 二级合并：只压缩更早摘要的文本（确定性、不调用模型），逐行再截断；指纹覆盖合并后整段原文范围 */
  function mergeSummaries(ss, turns) {
    const k = ss.slice(0, SUM_MERGE_K), from = k[0].from, to = k[k.length - 1].to;
    const raw = k.map(s => s.level === 2 ? s.text.split('\n').slice(1).join('\n').split('；') : s.text.split('\n')).flat();
    const n = Math.max(SUM_L2_MIN, Math.min(SUM_L2_LINE, Math.floor(SUM_CAP / 2 / raw.length) - 1)); // 二级摘要总长约束在 SUM_CAP/2 以内
    const lines = raw.map(l => clip(l, n));
    const text = '【二级摘要 第' + (from + 1) + '–' + to + '轮】\n' + lines.join('；');
    return { from, to, fp: batchFp(turns.slice(from, to)), text, level: 2, at: k[k.length - 1].at };
  }
  /** 日期只精确到天：「2026-11-02 13:45(:10)」「2026年11月2日 13:45」→ 只保留日期部分 */
  function normalizeDates(s) {
    return String(s == null ? '' : s).replace(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月\d{1,2}日)(?:[ T]?|\s*)\d{1,2}[:：]\d{2}(?:[:：]\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '$1');
  }
  /** 把历史消息切成轮：每条 user 开启一轮；首条 user 之前的消息（如开场白）并入第 0 轮 */
  function splitTurns(hist) {
    const turns = []; let cur = null;
    hist.forEach(m => { if (m.role === 'user' || !cur) { cur = []; turns.push(cur); } cur.push(m); });
    return turns;
  }
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  /** 默认离线摘要：逐轮「用户要点 / 回复要点」截断拼接（确定性，可测试） */
  function summarizeTurns(turns, startNo) {
    return turns.map((t, i) => '第' + (startNo + i + 1) + '轮：' + t.map(m => (m.role === 'user' ? '玩家' : m.role === 'assistant' ? '回复' : m.role) + '「' + clip(partsText(m.content), m.role === 'user' ? 60 : 90) + '」').join(' → ')).join('\n');
  }
  // 冻结批次指纹：用于判定摘要是否仍有效（正确性相关），用 SHA-256 而非 32 位 FNV，避免碰撞导致改过的批次沿用旧摘要
  const batchText = batch => batch.flat().map(m => m.role + ':' + partsText(m.__orig != null ? m.__orig : m.content)).join('\n');
  const batchFp = batch => 'sha256:' + sha(batchText(batch));
  /** 校验冻结批次；兼容旧版 8 位 FNV 指纹（一致则就地升级为 SHA-256，不作废摘要） */
  function batchValid(s, batch) {
    if (typeof s.fp === 'string' && /^[0-9a-f]{8}$/.test(s.fp)) {
      if (hash(batchText(batch)) !== s.fp) return false;
      s.fp = batchFp(batch); return true;
    }
    return batchFp(batch) === s.fp;
  }
  function emptyHybrid() { return { v: 1, cut: 0, summaries: [], sent: {} }; }
  /**
   * apply(history, state) → { messagesForRequest, state, prefixChanged, summaryCreated, rawTurns, totalTurns, untilNext }
   * history：不含开头 system 与本轮 user 的历史消息；state 原地更新（调用方负责持久化）。
   */
  function hwApply(history, state) {
    state = state && state.v ? state : Object.assign(emptyHybrid(), state || {});
    state.summaries = state.summaries || []; hwMigrateSent(state);
    const turns = splitTurns(history || []);
    let prefixChanged = false, summaryCreated = false;
    if (turns.length < state.cut) { state.cut = 0; state.summaries = []; prefixChanged = true; } // 历史被删到摘要范围内：作废重来
    // 已冻结批次被编辑：按指纹校验，不一致则从该批起作废
    for (let i = 0; i < state.summaries.length; i++) {
      const s = state.summaries[i];
      if (!batchValid(s, turns.slice(s.from, s.to))) { state.summaries = state.summaries.slice(0, i); state.cut = i ? state.summaries[i - 1].to : 0; prefixChanged = true; break; }
    }
    while (turns.length - state.cut >= RAW_MAX) {
      const from = state.cut, to = from + (RAW_MAX - RAW_MIN), batch = turns.slice(from, to);
      state.summaries.push({ from, to, fp: batchFp(batch), text: summarizeTurns(batch, from), at: new Date().toISOString().slice(0, 10) });
      state.cut = to; summaryCreated = true; prefixChanged = true;
    }
    let summaryMerged = false;
    if (summaryCreated) { // 只在 20 轮边界（本次刚追加摘要）合并，前缀本就在此刻变化，不额外抖动
      while (state.summaries.length >= SUM_MERGE_K && sumLen(state.summaries) > SUM_CAP) {
        const m = mergeSummaries(state.summaries, turns), old = sumLen(state.summaries.slice(0, SUM_MERGE_K));
        if (m.text.length >= old) break;
        state.summaries = [m].concat(state.summaries.slice(SUM_MERGE_K)); summaryMerged = true;
      }
    }
    const raw = turns.slice(state.cut).flat();
    const out = state.summaries.length ? [{ role: 'system', content: SUM_HEAD + '\n' + state.summaries.map(s => s.text).join('\n') }].concat(raw) : raw;
    const rawTurns = turns.length - state.cut;
    return { messagesForRequest: out, state, prefixChanged, summaryCreated, summaryMerged, rawTurns, totalTurns: turns.length, untilNext: RAW_MAX - rawTurns };
  }
  // v1.4.0（P1 修复）：「已发送版本」表按消息身份索引（消息 id；无 id 时退化为历史中第 n 条 user 的序号），
  // 并记录原文 SHA-256 + 长度，替换前校验——原文变了（编辑 / 删除错位 / 哈希碰撞）就不替换。
  // 旧版以内容 FNV-32 为键：重复文本（连发「继续」）会互相覆盖、碰撞时静默替换，已废弃（旧条目加载时丢弃）。
  const sha = s => (root.RPCache || (typeof require === 'function' ? require('./rpcache.js') : null)).sha256(s);
  const sentKey = (id, ord) => (id != null && id !== '' ? 'i:' + id : ord != null ? 'u#' + ord : null);
  function hwRecordSent(state, key, original, sent) {
    if (key == null || typeof original !== 'string') return;
    state.sent = state.sent || {};
    delete state.sent[key];
    if (original === sent) return;
    state.sent[key] = { h: sha(original), n: original.length, sent };
    const ks = Object.keys(state.sent); if (ks.length > HW_SENT_MAX) ks.slice(0, ks.length - HW_SENT_MAX).forEach(k => delete state.sent[k]);
  }
  function hwOutbound(state, m, key) {
    if (m.role !== 'user' || typeof m.content !== 'string' || key == null) return m;
    const r = state.sent && state.sent[key];
    if (!r || typeof r !== 'object' || r.n !== m.content.length || r.h !== sha(m.content)) return m;
    const o = Object.assign({}, m, { content: r.sent }); Object.defineProperty(o, '__orig', { value: m.content, enumerable: false }); return o;
  }
  /** 清掉旧版（以内容哈希为键、值为字符串）的条目 */
  function hwMigrateSent(state) { const o = state.sent || {}; Object.keys(o).forEach(k => { if (!o[k] || typeof o[k] !== 'object') delete o[k]; }); state.sent = o; }
  const HybridWindow = { RAW_MIN, RAW_MAX, SUM_HEAD, SUM_CAP, SUM_MERGE_K, apply: hwApply, splitTurns, summarizeTurns, normalizeDates, recordSent: hwRecordSent, outbound: hwOutbound, sentKey, empty: emptyHybrid };

  // ───────────────────────── 诊断 ─────────────────────────
  /** 滚动命中率：只统计有真实 hit 字段的样本；无样本返回 null（未知） */
  function rollingRate(samples) { const k = (samples || []).filter(x => x && x.known); if (!k.length) return null; const p = k.reduce((a, x) => a + x.prompt, 0), h = k.reduce((a, x) => a + x.hit, 0); return p ? Math.round(h / p * 100) : null; }
  /** 生成诊断：stat 为对话统计，返回 { level:'good'|'ok'|'low'|'unknown', rate, issues:[] } */
  function diagnose(stat) {
    const rate = rollingRate(stat.roll), issues = [];
    if (rate == null) return { level: 'unknown', rate: null, issues: ['尚无带缓存字段的 usage，命中率未知（服务商未返回 cached_tokens）'] };
    if (rate >= DIAG_GOOD) return { level: 'good', rate, issues };
    if (rate >= DIAG_LOW) return { level: 'ok', rate, issues };
    const h = stat.hist || [];
    const ch = key => { const v = h.map(x => x[key]); return v.some((x, i) => i && x !== v[i - 1]); };
    if (ch('static_hash')) issues.push('固定层 static_hash 发生过变化：设定里有随机/时间/频繁修改的内容，应移到动态层（【当前状态】等）');
    if (ch('prefix_hash') && !ch('static_hash')) issues.push('前缀哈希变化（合并后的 system 有改动）');
    if (ch('model')) issues.push('请求间切换过模型，缓存按模型隔离');
    if (ch('provider')) issues.push('provider 路由偏好变化，可能被分到不同供应商');
    if (ch('session_id')) issues.push('session_id 不稳定');
    if (h.length && !h[h.length - 1].session_id) issues.push('未发送 session_id，OpenRouter 只能在命中后才 sticky');
    for (let i = 1; i < h.length; i++) if (h[i].t - h[i - 1].t > 5 * 60 * 1000) { issues.push('请求间隔超过 5 分钟，隐式缓存可能已过期（sticky 会话 10 分钟失效）'); break; }
    if (h.length && h[h.length - 1].tokens < 1024) issues.push('固定前缀较短（约 ' + h[h.length - 1].tokens + ' Token），低于 Gemini 缓存门槛，命中率低属正常');
    if (stat.lastDiff) issues.push('最近前缀变化位置 #' + stat.lastDiff.pos);
    if (!issues.length) issues.push('未发现明显原因：可能是供应商侧缓存未命中或刚写入');
    return { level: 'low', rate, issues };
  }

  /**
   * 改写 buildChatRequest 的结果（OpenAI 兼容格式）。req = {url, headers, body(string)}；cfg 见 DEFAULTS。
   * extra（可选）：{ sessionId, rp:boolean, prevStaticHash } —— 不传时行为与 v1.0 一致（不写 session_id、不注入锚点）。
   * 返回 { req, applied:{index,mode}|null, prefix, layers, decision, session_id }
   */
  function applyToRequest(req, cfg, extra) {
    cfg = Object.assign({}, DEFAULTS, cfg || {}); extra = extra || {};
    let body; try { body = JSON.parse(req.body); } catch (e) { return { req, applied: null, prefix: '' }; }
    const headers = Object.assign({}, req.headers);
    if (cfg.responseCache) headers['X-OpenRouter-Cache'] = 'true';
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    let applied = null, k = 0;
    // extra.ids：与 body.messages 尾部对齐的消息 id 并行数组（调用方传 ctx.messages[i]._src.id）；只用于 Hybrid 已发送表，不写入请求
    const src = Array.isArray(extra.ids) ? extra.ids : [];
    const ids = msgs.map((_, i) => { const j = i - (msgs.length - src.length); return j >= 0 ? src[j] : undefined; });
    while (k < msgs.length && msgs[k].role === 'system') k++;
    // 1. 合并开头连续 system 消息（保持 rpcache 已排好的顺序，只拼接不重排）
    if (k > 1 && cfg.mergeSystem && msgs.slice(0, k).every(m => typeof m.content === 'string')) {
      msgs.splice(0, k, { role: 'system', content: msgs.slice(0, k).map(m => m.content).filter(Boolean).join('\n\n') });
      ids.splice(0, k, undefined); k = 1;
    }
    // 2. RP 协议锚点 → 固定层 A（仅 RP 对话 / 用户开启；文本恒定）
    const guard = cfg.rpGuardrails === 'on' || cfg.rpGuardrails === true || (cfg.rpGuardrails === 'auto' && extra.rp);
    if (guard && cfg.rpGuardrails !== 'off') {
      if (k > 0 && typeof msgs[0].content === 'string') { if (msgs[0].content.indexOf(RP_ANCHOR) < 0) msgs[0].content = RP_ANCHOR + '\n\n' + msgs[0].content; }
      else if (k === 0) { msgs.unshift({ role: 'system', content: RP_ANCHOR }); ids.unshift(undefined); k = 1; }
    }
    // 2.5 Hybrid-5（仅调用方传入 extra.hybrid 状态时）：日期归一到天；动态层 E–G 从 system 移到本轮 user 尾部；历史走迟滞窗口
    let hybrid = null;
    if (extra.hybrid && cfg.hybrid !== false) {
      const st = extra.hybrid;
      for (let i = 0; i < k; i++) if (typeof msgs[i].content === 'string') msgs[i].content = normalizeDates(msgs[i].content);
      let lastUser = msgs.length - 1; if (lastUser < k || msgs[lastUser].role !== 'user') lastUser = -1;
      let dyn = '';
      if (k === 1 && typeof msgs[0].content === 'string') {
        const la = analyzeLayers(msgs[0].content);
        if (la.dynamicText && lastUser > 0) { dyn = la.dynamicText; msgs[0].content = la.blocks.filter(b => b.kind === 'static').map(b => b.text).join('\n').replace(/\s+$/, ''); }
      }
      const tail = lastUser > 0 ? msgs[lastUser] : null;
      let ord = 0;
      const hist = msgs.slice(k, lastUser > 0 ? lastUser : msgs.length).map((m, i) => hwOutbound(st, m, m.role === 'user' ? sentKey(ids[k + i], ord++) : null));
      const w = hwApply(hist, st);
      let sentUser = null;
      if (tail) {
        const orig = tail.content;
        if (typeof orig === 'string') { sentUser = Object.assign({}, tail, { content: normalizeDates(dyn ? dyn.replace(/\s+$/, '') + '\n\n' + orig : orig) }); hwRecordSent(st, sentKey(ids[lastUser], ord), orig, sentUser.content); }
        else sentUser = tail;
      }
      msgs.splice(k, msgs.length - k, ...w.messagesForRequest.concat(sentUser ? [sentUser] : []));
      hybrid = { prefixChanged: w.prefixChanged, summaryCreated: w.summaryCreated, rawTurns: w.rawTurns, totalTurns: w.totalTurns, untilNext: w.untilNext, summaries: st.summaries.length, movedDynamic: !!dyn };
    }
    const prefix = msgs.slice(0, k).map(m => partsText(m.content)).join('\n\0\n');
    const layers = analyzeLayers(prefix);
    let lastU = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastU = i; break; }
    const autoHist = cfg.mode === 'auto' && hybrid && cfg.autoTarget !== 'prefix' && lastU > k;
    const decision = autoHist
      ? decideHistory(cfg, { model: body.model, cacheText: msgs.slice(0, lastU).map(m => partsText(m.content)).join('\n'), static_hash: layers.static_hash, prevStaticHash: extra.prevStaticHash })
      : decide(cfg, { model: body.model, staticText: layers.dynamicText ? layers.staticText : prefix, static_hash: layers.static_hash, prevStaticHash: extra.prevStaticHash });
    // 3. 断点：OpenRouter 对 Gemini 只用最后一个断点，先清掉其他插件（RP 缓存优化器强制模式）加的断点
    if (cfg.mode !== 'off' && msgs.length) {
      msgs.forEach(stripCC);
      if (decision.explicit) {
        let target = -1;
        if (cfg.mode === 'history' || decision.history) {
          let lastUser = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = i; break; }
          for (let i = (lastUser > 0 ? lastUser : msgs.length) - 1; i >= 0; i--) if (hasText(msgs[i].content)) { target = i; break; }
        }
        // auto：单条 system 且末尾有动态层（且动态段都在固定段之后）→ 拆成两段，断点只覆盖固定层，动态层不写缓存
        if (target < 0 && cfg.mode === 'auto' && k === 1 && typeof msgs[0].content === 'string' && layers.dynamicText && layers.ordered) {
          const c = msgs[0].content, cut = c.indexOf(layers.blocks.find(x => x.kind === 'dynamic').text);
          if (cut > 0) {
            const cc = { type: 'ephemeral' }; if (cfg.ttl) cc.ttl = cfg.ttl;
            msgs[0].content = [{ type: 'text', text: c.slice(0, cut), cache_control: cc }, { type: 'text', text: c.slice(cut) }];
            applied = { index: 0, mode: 'auto', split: true };
          }
        }
        if (!applied) {
          if (target < 0 && k > 0) target = k - 1;
          if (target >= 0 && addBreakpoint(msgs[target], cfg.ttl || undefined)) { applied = { index: target, mode: cfg.mode }; if (decision.history) applied.history = true; }
        }
      }
    }
    body.messages = msgs;
    // 4. OpenRouter 适配：稳定 session_id；model / provider 偏好原样保留
    const sid = cfg.sessionId !== false && extra.sessionId ? extra.sessionId : '';
    if (sid) OpenRouterAdapter.applySession(body, sid);
    const route = OpenRouterAdapter.routeOf(body);
    return { req: Object.assign({}, req, { headers, body: JSON.stringify(body) }), applied, prefix, layers, decision, session_id: body.session_id || '', route, hybrid };
  }

  /** 从统一 usage（providers.normalizeUsage）取缓存信息；服务商未返回 hit 字段时 known=false、pct=null（标「未知」，不冒充 0%） */
  function usageInfo(u) {
    if (!u || u.prompt == null) return null;
    const prompt = u.prompt | 0, hit = u.hit | 0, write = u.cacheWrite | 0;
    if (u.hit == null && !u.cacheSupported) return { prompt, hit: 0, write, pct: null, known: false };
    return { prompt, hit, write, pct: prompt ? Math.round(hit / prompt * 100) : 0 };
  }
  function usageText(i) {
    if (i.known === false) return 'Gemini 缓存命中未知（服务商未返回 cached_tokens；输入 ' + i.prompt + ' Token）';
    return i.hit ? 'Gemini 缓存命中 ' + i.hit + '/' + i.prompt + ' Token（' + i.pct + '%）' + (i.write ? '，写入 ' + i.write : '')
      : 'Gemini 缓存未命中（输入 ' + i.prompt + ' Token' + (i.write ? '，写入 ' + i.write : '') + '）';
  }
  /** 成本（按价目表估算，单位：「普通输入 Token 等价」）：token 数取真实 usage，倍率取 PRICE。返回 { equiv, saved, pctSaved } */
  function estimateCost(i, price) {
    if (!i || i.known === false) return null;
    const P = Object.assign({}, PRICE, price || {});
    const miss = Math.max(0, i.prompt - i.hit - i.write);
    const equiv = miss + i.hit * P.read + i.write * P.write;
    return { equiv: Math.round(equiv), saved: Math.round(i.prompt - equiv), pctSaved: i.prompt ? Math.round((i.prompt - equiv) / i.prompt * 100) : 0 };
  }
  // ───────────────────────── KeepAlive：保活收益分析（只分析，不自动 ping） ─────────────────────────
  // 以前缀 L 为单位：命中 0.25L，未命中 1L；一次 ping（max_tokens=1）≈ 0.25L。仅当间隔 > TTL 且 ping 能覆盖到回复时有收益。
  // 前提：ping 会刷新 TTL（OpenRouter 未写明，需实测）。
  function pingsForGap(gap, interval, maxP) { return gap <= interval ? 0 : Math.min(Math.ceil(gap / interval) - 1, maxP); }
  function netForGap(gap, ttl, interval, maxP, read) {
    read = read == null ? PRICE.read : read;
    const cost = pingsForGap(gap, interval, maxP) * read, covered = gap <= maxP * interval + ttl;
    return (gap > ttl && covered ? 1 - read : 0) - cost;
  }
  function keepaliveRecommend(gaps, ttl, interval, maxP, read) {
    gaps = (gaps || []).filter(g => g > 0);
    if (!gaps.length) return { samples: 0, median: null, net: 0, enable: false, overTtl: 0 };
    const net = gaps.reduce((a, g) => a + netForGap(g, ttl, interval, maxP, read), 0) / gaps.length;
    const so = gaps.slice().sort((a, b) => a - b), mid = so.length >> 1;
    const median = so.length % 2 ? so[mid] : (so[mid - 1] + so[mid]) / 2;
    return { samples: gaps.length, median: Math.round(median * 10) / 10, net: Math.round(net * 10000) / 10000, enable: net > 0, overTtl: gaps.filter(g => g > ttl).length };
  }
  const ttlSec = cfg => cfg && cfg.ttl === '1h' ? 3600 : 300;
  const KeepAlive = { pingsForGap, netForGap, recommend: keepaliveRecommend, ttlSec };
  /** 「应命中却未命中」：上一轮已打显式断点、本轮前缀未变、间隔 < TTL，但 cached_tokens=0 */
  function expectedHit(prev, cur, ttl) { return !!(prev && prev.explicit && cur && cur.prefix_hash === prev.prefix_hash && cur.t - prev.t < ttl * 1000); }

  /** 是否 RP 对话：rpcache 插件对本对话生效 / 存有分层设定 / 系统提示识别到 ≥2 个分层标题 */
  function isRpConv(conv, rpActive) {
    if (rpActive) return true;
    const d = conv && conv.plugins && conv.plugins.rpcache;
    if (d && d.state && Object.keys(d.state).some(x => /world|character|layers|fields/.test(x))) return true;
    return !!(conv && analyzeLayers(conv.systemPrompt || '').layered);
  }

  const api = { ID, DEFAULTS, STATIC_PROMPT_VERSION, isOpenRouterGemini, applyToRequest, usageInfo, usageText, firstDiff, hash, PromptBuilder, CachePolicyEngine, MemoryManager, ProviderAdapters, OpenRouterAdapter, diagnose, rollingRate, PRICE, estimateCost, isRpConv, HybridWindow, normalizeDates, KeepAlive, expectedHit };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.GeminiCache = api;

  const reg = root.Plugins && root.Plugins.registry; if (!reg) return;
  const cfgOf = host => Object.assign({}, DEFAULTS, reg.config(host.settings(), ID));
  const lastPrefix = new Map(); // convId -> 上一轮 system 前缀（仅运行时）
  const statOf = conv => {
    const d = reg.convData(conv, ID);
    d.stat = Object.assign({ requests: 0, hits: 0, prompt: 0, cached: 0, write: 0, unknown: 0, prefixChanges: 0, prefixLen: 0, lastDiff: null, roll: [], hist: [], static_hash: '', static_prompt_version: STATIC_PROMPT_VERSION, session_id: '', decision: '', diag: null }, d.stat);
    return d.stat;
  };
  /** MemoryManager 存储：convData.gcache.memory = { L0:[{layer,text,fp}], backups:[指针] } */
  const memOf = conv => { const d = reg.convData(conv, ID); d.memory = Object.assign({ L0: [], backups: [] }, d.memory); return d.memory; };
  const rpActive = (host, conv) => { try { return reg.isActive('rpcache', host.settings(), conv, host); } catch (e) { return false; } };
  const LV = { good: '良好 ✅', ok: '一般', low: '偏低 ⚠️（已诊断）', unknown: '未知' };

  reg.register({
    id: ID, icon: '💎', name: 'Gemini 提示缓存（OpenRouter）', version: '1.4.0', perConversation: false, defaultEnabled: true,
    desc: '只对 OpenRouter 上的 Gemini 模型生效（算法规格 v1.0）：隐式缓存优先，固定前缀够长且稳定时才打 cache_control 显式断点；系统提示分层指纹（static_hash）、每个对话稳定 session_id（sticky routing）、RP 协议锚点、L0 核心记忆保护、按真实 cached_tokens 统计命中与成本并在命中率 <40% 时自动诊断。其他服务商 / 模型的请求完全不变。',
    hooks: {
      onBeforeRequest(ctx, host) {
        if (!isOpenRouterGemini(ctx.provider, ctx.model)) return ctx;
        ctx.opts = Object.assign({}, ctx.opts, { orGemini: cfgOf(host) });
        const rpa = rpActive(host, ctx.conv);
        ctx.meta = Object.assign({}, ctx.meta, { gcacheRp: isRpConv(ctx.conv, rpa), gcacheRpcache: rpa });
        return ctx;
      },
      onAfterResponse(result, ctx, host) {
        if (!ctx.opts || !ctx.opts.orGemini || !result.ok || !result.bot) return;
        const i = usageInfo(result.usage);
        const s = statOf(ctx.conv);
        if (i) {
          if (i.known === false) s.unknown++;
          else { s.prompt += i.prompt; s.cached += i.hit; s.write += i.write; if (i.hit) s.hits++; }
          s.roll = (s.roll || []).concat([{ prompt: i.prompt, hit: i.hit, known: i.known !== false }]).slice(-ROLL_N);
          result.bot.gcache = i;
          const prev = s.diag && s.diag.level;
          s.diag = diagnose(s);
          if (i.known !== false && s.expect) {
            s.missStreak = i.hit ? 0 : (s.missStreak | 0) + 1;
            if (s.missStreak === 2 && ctx.opts.orGemini.missAlert !== false) host.toast('💎 连续 2 轮应命中却未命中：前缀未变且在 TTL 内，可能被路由到不同供应商或缓存被驱逐');
          } else if (i.hit) s.missStreak = 0;
          if (ctx.opts.orGemini.toast) host.toast(usageText(i));
          if (ctx.opts.orGemini.diagToast && s.diag.level === 'low' && prev !== 'low') host.toast('💎 缓存命中率 ' + s.diag.rate + '%：' + s.diag.issues[0]);
        }
        host.saveConv(ctx.conv);
      },
      messageBadges(msg, conv, host) {
        const i = msg.role === 'assistant' && msg.gcache; if (!i) return [];
        if (i.known === false) return [{ text: '💎 缓存 ?', tone: 'info', title: usageText(i), action: () => host.openPanel(ID) }];
        return [{ text: '💎 缓存 ' + i.pct + '%', tone: i.pct >= DIAG_GOOD ? 'ok' : i.hit ? 'warn' : 'info', title: usageText(i), action: () => host.openPanel(ID) }];
      },
      headerBadges(conv, host) {
        // 顶栏：Gemini 滚动命中率（RP 有命中率时由 app 优先展示 RP）
        if (!conv) return [];
        const s = reg.convData(conv, ID).stat; if (!s || !(s.roll || []).length) return [];
        const d = s.diag || diagnose(s); if (d.rate == null) return [];
        const tn = d.level === 'good' ? 'ok' : d.level === 'low' ? 'bad' : d.level === 'ok' ? 'warn' : 'info';
        return [{ text: '命中 ' + d.rate + '%', tone: tn, title: 'Gemini 滚动命中率（近 ' + ROLL_N + ' 次）', action: () => host.openPanel(ID), kind: 'hit' }];
      },
    },
    /** app.js 在 buildChatRequest 之后调用：改写请求并记录分层指纹 / 前缀稳定性 */
    transformRequest(req, ctx) {
      const o = ctx.opts && ctx.opts.orGemini; if (!o) return req;
      const s = statOf(ctx.conv);
      // Hybrid-5 冲突策略（A）：RP 缓存优化器对本对话生效时不启用 Zip 窗口（以 rpcache 的章节策略为准），gcache 仍负责 session_id / auto 断点 / 指纹 / 诊断
      const hyOn = o.hybrid !== false && !(ctx.meta && ctx.meta.gcacheRpcache) && ctx.conv;
      const hd = ctx.conv && reg.convData(ctx.conv, ID);
      if (hyOn) hd.hybrid = hd.hybrid && hd.hybrid.v ? hd.hybrid : HybridWindow.empty();
      const r = applyToRequest(req, o, { sessionId: ctx.conv && sessionIdFor(ctx.conv.id), rp: !!(ctx.meta && ctx.meta.gcacheRp), prevStaticHash: s.static_hash, hybrid: hyOn ? hd.hybrid : null, ids: (ctx.messages || []).map(m => m && m._src ? m._src.id : undefined) });
      s.hybridInfo = r.hybrid ? r.hybrid : { off: o.hybrid === false ? 'setting' : 'rpcache' };
      s.requests++;
      const now = Date.now();
      if (s.lastT) s.gaps = (s.gaps || []).concat([Math.round((now - s.lastT) / 100) / 10]).slice(-50);
      s.lastT = now;
      s.expect = expectedHit(s.lastReq, { prefix_hash: hash(r.prefix), t: now }, ttlSec(o));
      s.lastReq = { explicit: !!r.applied, prefix_hash: hash(r.prefix), t: now };
      s.applied = r.applied;
      // v1.4.0：上一轮前缀只留在内存（不再随对话持久化整段 system）；持久化的只有 prefix_hash 与 lastDiff 样本
      const prevPrefix = ctx.conv ? lastPrefix.get(ctx.conv.id) : null, ph = hash(r.prefix);
      if (prevPrefix != null ? prevPrefix !== r.prefix : (s.prefix_hash && s.prefix_hash !== ph)) { s.prefixChanges++; if (prevPrefix != null) s.lastDiff = firstDiff(prevPrefix, r.prefix); }
      if (ctx.conv) lastPrefix.set(ctx.conv.id, r.prefix);
      delete s.prefix; s.prefix_hash = ph; s.prefixLen = r.prefix.length;
      if (r.layers) {
        s.static_hash = r.layers.static_hash; s.decision = r.decision.reason; s.session_id = r.session_id; s.layered = r.layers.layered;
        s.hist = (s.hist || []).concat([{ t: Date.now(), static_hash: r.layers.static_hash, prefix_hash: hash(r.prefix), model: r.route.model, provider: r.route.provider, session_id: r.session_id, tokens: estTokens(r.layers.staticText) }]).slice(-ROLL_N);
        // L0：首次识别到核心设定时登记指纹；之后每轮检查是否被压缩丢失
        const mem = memOf(ctx.conv), l0 = extractL0(r.layers);
        if (l0.length) { const have = new Set(mem.L0.map(x => x.fp)); l0.forEach(x => { if (!have.has(x.fp)) mem.L0.push(x); }); mem.L0 = mem.L0.slice(-200); }
        s.l0Missing = MemoryManager.missingL0(mem.L0, r.req.body).length;
      }
      return r.req;
    },
    renderSettings(box, host) {
      const c = cfgOf(host);
      const sel = (id, label, hint, opts, v) => '<label class="field"><span>' + label + '<small>' + hint + '</small></span><select id="' + id + '">' +
        opts.map(o => '<option value="' + o[0] + '"' + (String(v) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>';
      const sw = (id, label, hint, v) => '<label class="field inline"><span>' + label + '<small>' + hint + '</small></span><input type="checkbox" class="switch" id="' + id + '"' + (v ? ' checked' : '') + '></label>';
      box.innerHTML =
        sel('gc-mode', '缓存策略', '「自动」隐式缓存优先：固定前缀达到 Gemini 门槛且连续稳定时才打显式断点（不填充凑门槛）；OpenRouter 对 Gemini 只用最后一个断点', [['auto', '自动（推荐）'], ['off', '关闭（仅依赖 Gemini 隐式缓存）'], ['prefix', '系统前缀'], ['history', '前缀+历史']], c.mode) +
        sel('gc-at', '自动模式断点位置', 'Hybrid 开启时：「历史」把断点放到本轮 user 之前，历史也进缓存（推荐）；「固定前缀」只盖 system 固定层', [['history', '历史（本轮 user 之前）'], ['prefix', '只盖固定前缀']], c.autoTarget) +
        sw('gc-merge', '合并开头 system 消息', '把开头连续的多条 system 消息合并为一条（顺序不变），保证断点覆盖完整固定前缀', c.mergeSystem) +
        sw('gc-hy', 'Hybrid-5 迟滞窗口', '严格固定前缀（动态层 E–G 移到本轮输入尾部，日期只到天）+ 历史原文保留 20–40 轮：满 40 轮把最早 20 轮压成一段冻结摘要（只生成一次）。与「RP 缓存优化器」同开的对话以 rpcache 的章节策略为准，此项不生效', c.hybrid) +
        sw('gc-sid', '稳定 session_id', '每个对话固定一个 session_id，OpenRouter 从首轮起就把请求粘到同一供应商，缓存更稳', c.sessionId) +
        sel('gc-guard', 'RP 协议锚点', '在固定层开头注入简短规则：不替玩家说话/决定、NPC 猜测不写成事实、核心性格与临时状态分离', [['auto', '仅 RP 对话（推荐）'], ['on', '总是'], ['off', '关闭']], c.rpGuardrails) +
        sel('gc-ttl', '缓存 TTL', '写入 cache_control.ttl = "1h"（服务商不支持时会被忽略）', [['', '默认（5 分钟）'], ['1h', '1 小时']], c.ttl) +
        sw('gc-resp', 'OpenRouter 响应缓存', '发送 X-OpenRouter-Cache: true，完全相同的请求直接返回缓存的回复（重新生成会得到同样结果！）', c.responseCache) +
        sw('gc-toast', '命中提示', '每次回复结束后弹出提示显示缓存命中 Token 数', c.toast) +
        sw('gc-dtoast', '诊断提示', '滚动命中率跌破 40% 时弹出诊断结论', c.diagToast) +
        sw('gc-miss', '未命中告警', '已打断点、前缀未变且在 TTL 内却连续 2 轮未命中时提示', c.missAlert) +
        '<label class="field"><span>缓存写入价倍率<small>相对普通输入价，用于成本估算（OpenRouter Gemini 约 1.0，含存储费可调高）</small></span><input type="number" step="0.05" min="0" id="gc-wp" value="' + c.writePrice + '"></label>' +
        '<label class="field"><span>保活分析：最多 ping 次数<small>只用于计算建议，不会自动发送 ping</small></span><input type="number" step="1" min="0" max="20" id="gc-kp" value="' + c.keepaliveMaxPings + '"></label>';
      const save = patch => { Object.assign(reg.config(host.settings(), ID), patch); host.saveSettings(); };
      box.querySelector('#gc-mode').onchange = e => save({ mode: e.target.value });
      box.querySelector('#gc-guard').onchange = e => save({ rpGuardrails: e.target.value });
      box.querySelector('#gc-ttl').onchange = e => save({ ttl: e.target.value });
      box.querySelector('#gc-merge').onchange = e => save({ mergeSystem: e.target.checked });
      box.querySelector('#gc-hy').onchange = e => save({ hybrid: e.target.checked });
      box.querySelector('#gc-sid').onchange = e => save({ sessionId: e.target.checked });
      box.querySelector('#gc-resp').onchange = e => save({ responseCache: e.target.checked });
      box.querySelector('#gc-toast').onchange = e => save({ toast: e.target.checked });
      box.querySelector('#gc-dtoast').onchange = e => save({ diagToast: e.target.checked });
      box.querySelector('#gc-at').onchange = e => save({ autoTarget: e.target.value });
      box.querySelector('#gc-miss').onchange = e => save({ missAlert: e.target.checked });
      box.querySelector('#gc-wp').onchange = e => { const v = parseFloat(e.target.value); if (v >= 0) save({ writePrice: v }); };
      box.querySelector('#gc-kp').onchange = e => { const v = parseInt(e.target.value, 10); if (v >= 0) save({ keepaliveMaxPings: Math.min(20, v) }); };
    },
    renderPanel(box, host) {
      const conv = host.conv(), e = host.esc;
      const p = conv && host.provider(conv), on = !!(conv && isOpenRouterGemini(p, conv.model));
      const c = cfgOf(host);
      const L = [];
      L.push('当前模型：' + e((conv && conv.model) || '?') + (on ? '（已识别为 OpenRouter Gemini ✅）' : '（非 OpenRouter Gemini，本插件不生效）'));
      L.push('策略：' + ({ auto: '自动（隐式优先）', off: '关闭', prefix: '系统前缀', history: '前缀+历史' }[c.mode] || c.mode) + '　合并 system：' + (c.mergeSystem ? '是' : '否') + '　TTL：' + (c.ttl || '默认') + '　响应缓存：' + (c.responseCache ? '开' : '关') + '　RP 锚点：' + ({ auto: '仅 RP', on: '总是', off: '关' }[c.rpGuardrails] || c.rpGuardrails));
      const s = conv && reg.convData(conv, ID).stat;
      if (!s || !s.requests) L.push('<br>本对话尚无请求统计。');
      else {
        const known = s.prompt > 0;
        L.push('<br>请求数：' + s.requests + '　命中次数：' + s.hits + (s.unknown ? '　未返回缓存字段：' + s.unknown + ' 次' : ''));
        L.push('累计输入（真实 usage）：' + s.prompt + '　cached_tokens：' + s.cached + '（' + (known ? Math.round(s.cached / s.prompt * 100) + '%' : '未知') + '）　缓存写入：' + s.write);
        const wp = Number(c.writePrice) >= 0 ? Number(c.writePrice) : PRICE.write;
        const cost = known && estimateCost({ prompt: s.prompt, hit: s.cached, write: s.write }, { write: wp });
        if (cost) L.push('成本（按价目表估算：读 ' + PRICE.read + 'x / 写 ' + wp + 'x 输入价）：≈ ' + cost.equiv + ' 输入 Token 等价，节省约 ' + cost.pctSaved + '%');
        const d = s.diag || diagnose(s);
        L.push('滚动命中率（近 ' + ROLL_N + ' 次）：' + (d.rate == null ? '未知' : d.rate + '%') + ' · ' + LV[d.level]);
        if (d.level === 'low' || d.level === 'unknown') d.issues.forEach(x => L.push('　· ' + e(x)));
        L.push('static_hash：' + e(s.static_hash || '-') + '（v' + (s.static_prompt_version || STATIC_PROMPT_VERSION) + (s.layered ? '，已识别分层设定' : '') + '）　session_id：' + e(s.session_id || '未发送'));
        const hy = s.hybridInfo;
        if (hy) L.push('Hybrid-5：' + (hy.off ? (hy.off === 'rpcache' ? '本对话由 RP 缓存优化器管理历史（不启用 Zip 窗口）' : '已关闭') : '窗口原文 ' + hy.rawTurns + ' 轮 / 共 ' + hy.totalTurns + ' 轮　冻结摘要：' + (hy.summaries ? hy.summaries + ' 段' : '无') + '　下次压缩还剩 ' + hy.untilNext + ' 轮' + (hy.movedDynamic ? '　动态层已移到尾部' : '')));
        const ttl = ttlSec(c), ka = keepaliveRecommend(s.gaps, ttl, Math.max(30, ttl - 30), c.keepaliveMaxPings | 0);
        L.push('保活分析（TTL ' + ttl + 's，间隔 ' + Math.max(30, ttl - 30) + 's，最多 ' + (c.keepaliveMaxPings | 0) + ' 次 ping）：' + (ka.samples < 3 ? '样本不足（' + ka.samples + ' 个间隔）' : '中位间隔 ' + ka.median + 's，超 TTL ' + ka.overTtl + '/' + ka.samples + '，每轮净收益 ' + ka.net + ' L → ' + (ka.enable ? '建议保活（本插件不自动 ping）' : '不建议保活')));
        if (s.missStreak >= 2) L.push('⚠️ 连续 ' + s.missStreak + ' 轮应命中却未命中');
        if (s.decision) L.push('本轮缓存决策：' + e(s.decision));
        L.push('固定前缀长度：约 ' + s.prefixLen + ' 字符（Gemini 显式缓存通常需 ≥1024~4096 Token）　前缀变化次数：' + s.prefixChanges);
        const mem = reg.convData(conv, ID).memory;
        if (mem && mem.L0 && mem.L0.length) L.push('L0 核心条目：' + mem.L0.length + (s.l0Missing ? '　⚠️ 本轮请求缺失 ' + s.l0Missing + ' 条（可能被误压缩或设定已修改）' : '　✅ 全部保留'));
        if (s.lastDiff) L.push('最近一次前缀变化位置 #' + s.lastDiff.pos + '：<br>之前：…' + e(s.lastDiff.before) + '…<br>之后：…' + e(s.lastDiff.after) + '…<br>提示：时间、随机内容或频繁修改的块会破坏前缀，建议放到【当前状态】【当前场景】等动态层（尾部）。');
      }
      box.innerHTML = '<div class="hint" style="line-height:1.7">' + L.join('<br>') + '</div><button class="chip-btn" id="gc-reset" type="button" style="margin-top:12px">清空本对话统计</button>';
      box.querySelector('#gc-reset').onclick = () => { if (conv) { delete reg.convData(conv, ID).stat; host.saveConv(conv); } this.renderPanel(box, host); host.toast('已清空'); };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
