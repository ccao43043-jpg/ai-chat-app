/* DeepSeek RP 缓存优化器 V1 —— Context Builder 核心逻辑（纯函数，可在 Node 中测试）
 * 设计文档：docs/plugins/deepseek-rp-cache-design-v1.md；实现说明：docs/plugins/README.md
 * 核心：能不动就不动，能追加就不重写，能摘要就不盲删，能把动态内容放后面就绝不放前面。
 * 六层顺序：L1 永久锚点 → L2 长期记忆 → L3 冻结章节摘要 → L4 最近完整对话 → L5 当前动态状态 → L6 当前用户输入
 */
(function (root) {
  'use strict';

  // L1 永久锚点（固定顺序）
  const STATIC_DEFS = [
    { id: 'world', tag: 'WORLD', title: '世界观', hint: '世界背景、地点、势力、魔法/科技规则。几乎不改。' },
    { id: 'character', tag: 'CHARACTER', title: '角色卡', hint: '角色身份、性格、说话方式、人物基础资料与人物关系基础。' },
    { id: 'rules', tag: 'RP_RULES', title: 'RP 规则', hint: '例如：NPC 不能读取玩家内心；NPC 只知道自己应该知道的信息；不替玩家决定行动。' },
    { id: 'format', tag: 'OUTPUT_FORMAT', title: '输出格式', hint: '回复格式、长度、人称、是否带动作描写等。' },
    { id: 'fewshot', tag: 'FEW_SHOT', title: 'Few-shot 示例', hint: '示例对话，展示期望的文风与格式。' },
    { id: 'prohibit', tag: 'PROHIBITIONS', title: '禁止事项', hint: '绝对不能出现的内容或行为。' },
    { id: 'style', tag: 'STYLE', title: '写作风格', hint: '固定写作风格、语气、节奏。' },
  ];
  const BLOCK_DEFS = STATIC_DEFS.map(d => Object.assign({ layer: 'L1', type: 'static', cache_priority: 'high' }, d)).concat([
    { id: 'memory', tag: 'LONG_TERM_MEMORY', title: '长期记忆', layer: 'L2', type: 'memory', cache_priority: 'medium',
      hint: '已确认的重要事实、人物关系、重大事件、长期目标、关键道具、已揭开的秘密、未解决的剧情线。只在发生重要事件时手动更新。' },
    { id: 'state', tag: 'CURRENT_STATE', title: '当前动态状态', layer: 'L5', type: 'dynamic', cache_priority: 'low',
      hint: 'HP / MP / 金钱 / 时间 / 地点 / 好感度 / 天气 / 任务 / 装备 / Buff。放在最新输入之前，随时修改都不会破坏历史缓存。' },
  ]);
  const BLOCK_TITLES = Object.fromEntries(BLOCK_DEFS.map(d => [d.id, d.title]));
  const LAYERS = ['static', 'memory', 'summary', 'history', 'state', 'input'];
  const LAYER_TITLES = { static: 'Static', memory: 'Memory', summary: 'Summary', history: 'History', state: 'State', input: 'Input' };
  const LAYER_CN = { static: '永久锚点', memory: '长期记忆', summary: '章节摘要', history: '最近对话', state: '动态状态', input: '当前输入' };
  // 默认工程参数（设计文档第 9、17、26 节）——不是 DeepSeek 官方阈值，可按会话修改
  const DEFAULT_SETTINGS = {
    max_context: 100000, output_reserve: 12000, safety_margin: 2000,
    summary: { enabled: true, trigger_tokens: 30000, min_new_turns: 15, keep_recent_turns: 20 },
    summary_model: '', save_prompt: false,
  };
  // DeepSeek 官方价格（美元 / 百万 tokens，高峰时段；非高峰为一半）—— 2026-10 核对 api-docs.deepseek.com/quick_start/pricing
  const DEFAULT_PRICES = {
    'deepseek-flash': { hit: 0.006, miss: 0.3, out: 1.2 },
    'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96 },
  };
  const HISTORY_LIMIT = 30;
  const LOG_LIMIT = 500;
  const pad3 = n => String(n).padStart(3, '0');
  const vlabel = (prefix, n) => prefix + '_v' + pad3(n | 0);
  const slabel = n => '#' + pad3(n | 0);

  // ---------------- 规范化（只做安全的格式处理，不改语义） ----------------
  function canonicalize(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/^\uFEFF/, '');              // UTF-8 BOM
    s = s.replace(/\r\n?/g, '\n');             // CRLF / CR -> LF
    s = s.replace(/[ \t\u00A0]+$/gm, '');      // 行尾空白
    s = s.replace(/\n{5,}/g, '\n\n\n');        // 连续 4 个以上空行 -> 2 个空行
    s = s.replace(/^\n+/, '').replace(/\n+$/, ''); // 首尾空行
    return s;
  }

  // ---------------- SHA-256（同步实现，UTF-8） ----------------
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
    0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138,
    0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624,
    0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f,
    0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  function sha256(str) {
    const msg = new TextEncoder().encode(String(str));
    const len = msg.length;
    const total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(msg); buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(len / 0x20000000), false);
    dv.setUint32(total - 4, (len << 3) >>> 0, false);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return Array.from(H, x => x.toString(16).padStart(8, '0')).join('');
  }

  // ---------------- 会话状态 ----------------
  function newState() {
    return {
      blocks: BLOCK_DEFS.map(d => ({ id: d.id, version: 0, content: '', history: [], updatedAt: 0 })),
      staticVersion: 0, baseHash: null,
      summaries: [],                       // 冻结章节摘要快照（只追加），最后一个为当前生效
      window: { startId: null, startOrdinal: 0 }, // 仅在超预算且无法摘要时使用的「分块截断」起点
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      seq: 0,
    };
  }
  function normalizeState(st) {
    const base = newState();
    if (!st || typeof st !== 'object') return base;
    const blocks = BLOCK_DEFS.map(d => {
      const b = (st.blocks || []).find(x => x && x.id === d.id) || {};
      return { id: d.id, version: b.version | 0, content: String(b.content || ''), history: Array.isArray(b.history) ? b.history : [], updatedAt: b.updatedAt || 0,
        restoredFrom: b.restoredFrom };
    });
    const ss = st.settings || {};
    const settings = Object.assign({}, DEFAULT_SETTINGS, ss, { summary: Object.assign({}, DEFAULT_SETTINGS.summary, ss.summary || {}) });
    return Object.assign({}, st, { blocks, settings, staticVersion: st.staticVersion | 0, baseHash: st.baseHash == null ? null : st.baseHash,
      summaries: Array.isArray(st.summaries) ? st.summaries : [], window: Object.assign({ startId: null, startOrdinal: 0 }, st.window || {}), seq: st.seq | 0 });
  }
  const getBlock = (st, id) => st.blocks.find(b => b.id === id);
  const defOf = id => BLOCK_DEFS.find(d => d.id === id);

  /** 更新块内容：规范化后与当前内容完全相同则不升级版本。返回 { block, changed } */
  function updateBlock(block, content, at) {
    const c = canonicalize(content);
    if (c === block.content) return { block, changed: false };
    const history = block.history.slice();
    if (block.version > 0) history.push({ version: block.version, content: block.content, hash: sha256(block.content), at: block.updatedAt || at || 0 });
    while (history.length > HISTORY_LIMIT) history.shift();
    const nb = Object.assign({}, block, { content: c, version: block.version + 1, history, updatedAt: at || 0 });
    delete nb.restoredFrom;
    return { block: nb, changed: true };
  }
  function restoreBlock(block, version, at) {
    const h = block.history.find(x => x.version === version);
    if (!h) throw new Error('找不到版本 v' + version);
    const r = updateBlock(block, h.content, at);
    if (r.changed) r.block.restoredFrom = version;
    return r;
  }
  /** 用户显式编辑某个块（UPDATE_STATIC_BLOCK / 更新记忆 / 更新状态）。L1 任何块变化都会让 static 版本 +1 */
  function setBlock(st, id, content, at, restoreVersion) {
    const i = st.blocks.findIndex(b => b.id === id);
    if (i < 0) throw new Error('未知的块：' + id);
    const r = restoreVersion != null ? restoreBlock(st.blocks[i], restoreVersion, at) : updateBlock(st.blocks[i], content, at);
    if (!r.changed) return { state: st, changed: false };
    const blocks = st.blocks.slice(); blocks[i] = r.block;
    const out = Object.assign({}, st, { blocks });
    if (defOf(id).layer === 'L1') out.staticVersion = (st.staticVersion | 0) + 1;
    return { state: out, changed: true };
  }
  /** 对话本身的系统提示词（助手人设）视为 L1 的第一部分：变化时 static 版本 +1 */
  function syncBase(st, baseSystem) {
    const h = sha256(canonicalize(baseSystem));
    if (st.baseHash === h) return st;
    return Object.assign({}, st, { baseHash: h, staticVersion: st.baseHash == null ? Math.max(st.staticVersion | 0, canonicalize(baseSystem) ? 1 : 0) : (st.staticVersion | 0) + 1 });
  }

  // ---------------- 章节摘要快照（冻结，只追加；编辑/回滚也生成新快照） ----------------
  const activeSummary = st => { const s = st.summaries || []; return s.length ? s[s.length - 1] : null; };
  function addSummary(st, o) {
    const no = (st.summaries || []).length + 1;
    const snap = { no, content: canonicalize(o.content), coveredIds: (o.coveredIds || []).slice(), at: o.at || 0, source: o.source || 'auto',
      basedOn: o.basedOn == null ? null : o.basedOn, newMessages: o.newMessages | 0, rounds: o.rounds | 0 };
    snap.hash = sha256(snap.content);
    return Object.assign({}, st, { summaries: (st.summaries || []).concat([snap]), window: { startId: null, startOrdinal: 0 } });
  }
  function editSummary(st, content, at) {
    const cur = activeSummary(st); if (!cur) throw new Error('还没有章节摘要');
    if (canonicalize(content) === cur.content) return { state: st, changed: false };
    return { state: addSummary(st, { content, coveredIds: cur.coveredIds, at, source: 'edit', basedOn: cur.no }), changed: true };
  }
  function rollbackSummary(st, no, at) {
    const old = (st.summaries || []).find(s => s.no === no); if (!old) throw new Error('找不到摘要 ' + slabel(no));
    const cur = activeSummary(st);
    if (cur && cur.no === no) return { state: st, changed: false };
    return { state: addSummary(st, { content: old.content, coveredIds: old.coveredIds, at, source: 'rollback', basedOn: no }), changed: true };
  }

  // ---------------- 序列化（逐字节稳定：同样的内容 → 同样的文本） ----------------
  function staticText(st, baseSystem) {
    const parts = [];
    const b = canonicalize(baseSystem); if (b) parts.push(b);
    STATIC_DEFS.forEach(d => { const c = getBlock(st, d.id).content; if (c) parts.push('[' + d.tag + ']\n' + c); });
    return parts.join('\n\n');
  }
  function memoryText(st) { const c = getBlock(st, 'memory').content; return c ? '[LONG_TERM_MEMORY]\n' + c : ''; }
  function summaryText(st) { const s = activeSummary(st); return s && s.content ? '[CHAPTER_SUMMARY ' + slabel(s.no) + ']\n' + s.content : ''; }
  function stateText(st) { const c = getBlock(st, 'state').content; return c ? '[CURRENT_STATE]\n' + c : ''; }
  function buildSystem(st, baseSystem) { return [staticText(st, baseSystem), memoryText(st), summaryText(st)].filter(Boolean).join('\n\n'); }
  /** L5 + L6：状态只出现在最后一条用户消息中，不进入历史 */
  function finalUserContent(st, input) { const s = stateText(st); return s ? s + '\n\n[USER_INPUT]\n' + input : input; }
  const imgSig = imgs => (imgs || []).map(x => String(x).length + ':' + String(x).slice(-48));
  function serializeHistory(msgs, n) {
    const arr = (n == null ? msgs : msgs.slice(0, n)).map(m => [m.role, m.content || '', imgSig(m.images)]);
    return JSON.stringify(arr);
  }

  // ---------------- Token 估算 ----------------
  function estimateTokens(text) {
    const s = String(text || ''); let cjk = 0;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef)) cjk++; }
    return Math.ceil(cjk * 0.6 + (s.length - cjk) * 0.3);
  }
  const estimateItems = items => items.reduce((n, m) => n + estimateTokens(m.content) + 4 + (m.images ? m.images.length * 1000 : 0), 0);
  const roundsOf = items => items.filter(m => m.role === 'user').length;
  /** 最旧的一批历史：除最近 keep 轮之外的全部 */
  function oldestBatch(hist, keep) {
    const users = []; hist.forEach((m, i) => { if (m.role === 'user') users.push(i); });
    keep = Math.max(1, keep | 0);
    if (users.length <= keep) return [];
    return hist.slice(0, users[users.length - keep]);
  }

  /**
   * Context Builder（规划，不调用模型）。items：对话中可发送的消息（按原顺序），最后一条为本轮用户输入。
   * 返回各层内容、Token 预算、是否需要生成章节摘要。
   */
  function plan(state, baseSystem, items) {
    const st = normalizeState(state);
    const s = st.settings, sum = s.summary;
    const act = activeSummary(st);
    const covered = new Set(act ? act.coveredIds : []);
    const elig = items.filter(m => !covered.has(m.id));
    const last = elig[elig.length - 1];
    const input = last && last.role === 'user' ? last : null;
    const unsummarized = input ? elig.slice(0, -1) : elig.slice();
    // 分块截断（仅在超预算且无法摘要时设置过）：起点固定不动
    let start = 0;
    if (st.window.startId) {
      start = unsummarized.findIndex(m => m.id === st.window.startId);
      if (start < 0) start = Math.min(st.window.startOrdinal | 0, Math.max(0, unsummarized.length - 1));
    }
    const hist = unsummarized.slice(start);
    const system = buildSystem(st, baseSystem);
    const tokens = {
      static: estimateTokens(staticText(st, baseSystem)), memory: estimateTokens(memoryText(st)), summary: estimateTokens(summaryText(st)),
      history: estimateItems(hist), state: estimateTokens(stateText(st)), input: input ? estimateItems([input]) + 6 : 0,
    };
    tokens.total = LAYERS.reduce((n, k) => n + tokens[k], 0);
    const limit = Math.max(1000, s.max_context - s.output_reserve - s.safety_margin);
    const overBudget = tokens.total > limit;
    const batch = oldestBatch(unsummarized, sum.keep_recent_turns);
    const batchRounds = roundsOf(batch);
    let summaryReason = null;
    if (sum.enabled && batch.length) {
      if (overBudget) summaryReason = 'budget';
      else if (estimateItems(unsummarized) >= sum.trigger_tokens && batchRounds >= Math.max(1, sum.min_new_turns | 0)) summaryReason = 'trigger';
    }
    return { st, system, hist, input, unsummarized, covered, tokens, limit, overBudget, batch, batchRounds, needSummary: !!summaryReason, summaryReason,
      trimmed: start > 0, dropped: start };
  }
  /** 无法摘要（关闭 / 失败 / 无可摘要历史）而仍超预算时：一次性截掉一大块旧历史，起点固定到下次超预算为止 */
  function fallbackTrim(st, p) {
    const keep = Math.max(1, st.settings.summary.keep_recent_turns | 0);
    const un = p.unsummarized;
    const users = []; un.forEach((m, i) => { if (m.role === 'user') users.push(i); });
    let k = Math.max(0, users.length - keep);
    const fixed = p.tokens.total - p.tokens.history;
    while (k < users.length - 1 && fixed + estimateItems(un.slice(users[k])) > p.limit) k++;
    const startIdx = users.length ? users[k] : 0;
    if (!un[startIdx]) return st;
    return Object.assign({}, st, { window: { startId: un[startIdx].id, startOrdinal: startIdx } });
  }
  /** 组装最终消息：L4 原样追加，L5+L6 合并为最后一条用户消息 */
  function assemble(p) {
    const messages = p.hist.map(m => { const o = { role: m.role, content: m.content || '' }; if (m.images && m.images.length) o.images = m.images; if (m._src) o._src = m._src; o.id = m.id; return o; });
    if (p.input) {
      const o = { role: 'user', content: finalUserContent(p.st, p.input.content || '') };
      if (p.input.images && p.input.images.length) o.images = p.input.images;
      if (p.input._src) o._src = p.input._src; o.id = p.input.id;
      messages.push(o);
    }
    return { system: p.system, messages };
  }

  // ---------------- 指纹与诊断 ----------------
  function fingerprints(p, baseSystem) {
    const histSer = serializeHistory(p.hist);
    const act = activeSummary(p.st);
    return {
      static_hash: sha256(staticText(p.st, baseSystem)), memory_hash: sha256(memoryText(p.st)), summary_hash: sha256(summaryText(p.st)),
      history_hash: sha256(histSer), state_hash: sha256(stateText(p.st)), input_hash: sha256(p.input ? JSON.stringify([p.input.content || '', imgSig(p.input.images)]) : ''),
      full_prefix_hash: sha256(p.system + '\u0000' + histSer), history_count: p.hist.length,
      versions: { static: p.st.staticVersion | 0, memory: getBlock(p.st, 'memory').version, summary: act ? act.no : 0, state: getBlock(p.st, 'state').version },
    };
  }
  /** 各层与上一次请求相比：SAME / APPEND（仅 history）/ CHANGED；首次为 NEW */
  function diagnose(prev, fp, hist) {
    const out = {};
    if (!prev || !prev.static_hash) { LAYERS.forEach(k => { out[k] = 'NEW'; }); return out; }
    ['static', 'memory', 'summary', 'state', 'input'].forEach(k => { out[k] = prev[k + '_hash'] === fp[k + '_hash'] ? 'SAME' : 'CHANGED'; });
    if (prev.history_hash === fp.history_hash) out.history = 'SAME';
    else if (fp.history_count > (prev.history_count | 0) && sha256(serializeHistory(hist, prev.history_count | 0)) === prev.history_hash) out.history = 'APPEND';
    else out.history = 'CHANGED';
    return out;
  }
  /** 用大白话解释本次命中情况（第 39 节） */
  function reasons(entry, prev) {
    const d = entry.diag || {}; const out = [];
    if (!prev) return ['首次请求，缓存尚未建立'];
    if (entry.summary_happened) out.push(entry.summary_reason === 'budget' ? '超出预算触发摘要（' + slabel(entry.summary_no) + '），前缀从摘要处重新建立'
      : '历史达到摘要阈值，已生成章节摘要 ' + slabel(entry.summary_no) + '，前缀从摘要处重新建立');
    if (d.static === 'CHANGED') out.push('角色卡 / 世界观等永久锚点被修改');
    if (d.memory === 'CHANGED') out.push('长期记忆已更新');
    if (d.summary === 'CHANGED' && !entry.summary_happened) out.push('章节摘要刚更新（手动生成、编辑或回滚）');
    if (d.history === 'CHANGED' && !entry.summary_happened) out.push(entry.trimmed ? '超出预算，较早历史被一次性截断' : '历史被修改（编辑、删除或重新生成了较早的消息）');
    if (prev && entry.timestamp - prev.timestamp > 3 * 3600e3) out.push('距上次请求超过 ' + Math.floor((entry.timestamp - prev.timestamp) / 3600e3) + ' 小时，服务端缓存可能已清除');
    if (prev && prev.model !== entry.model) out.push('切换了模型（缓存按模型分开）');
    if (!out.length) {
      if (entry.supported && entry.hit_rate != null && entry.hit_rate < 0.3) out.push('前缀未变，但服务端没有命中（缓存尚未建立或已过期，DeepSeek 缓存为尽力而为）');
      else out.push('正常动态更新');
    }
    return out;
  }

  // ---------------- 章节摘要提示词（第 10 节：知识边界） ----------------
  const SUMMARY_SECTIONS = ['FACTS', 'CHARACTER_KNOWLEDGE', 'PLAYER_KNOWLEDGE', 'SECRET', 'UNRESOLVED', 'RELATIONSHIPS', 'OBJECTS', 'LOCATION'];
  function buildSummaryPrompt(o) {
    const transcript = (o.batch || []).map(m => (m.role === 'user' ? '【玩家】' : '【角色】') + String(m.content || '').trim()).join('\n\n');
    return '你是长篇角色扮演（RP）的「章节摘要记录员」。请把「上一版章节摘要」与「本批旧对话」合并成一份新的章节摘要（它将完整替代上一版），供后续剧情使用。\n\n' +
      '硬性要求：\n' +
      '1. 只记录对话里真实发生、已经确认的内容，不要编造、不要推测剧情走向、不要改写人设。\n' +
      '2. 必须区分「知识边界」：每个角色只知道自己亲眼所见或被告知的事；玩家知道的不等于 NPC 知道的。\n' +
      '3. 上一版摘要中的信息要完整继承，除非被新剧情明确更新。\n' +
      '4. 不要写“他们聊了很多”这类空泛总结，写具体的人、事、物、地点、数字。\n' +
      '5. 严格按以下格式输出，标题保持英文原样，每项用「- 」开头；某项没有内容写「- 无」：\n\n' +
      'FACTS:\n- 已确认的事实\n\nCHARACTER_KNOWLEDGE:\n- 角色名：该角色知道什么（每个重要角色一行）\n\nPLAYER_KNOWLEDGE:\n- 玩家知道什么\n\n' +
      'SECRET:\n- 尚未公开的秘密（注明对谁保密）\n\nUNRESOLVED:\n- 未解决事件\n\nRELATIONSHIPS:\n- 人物关系\n\nOBJECTS:\n- 关键物品及归属\n\nLOCATION:\n- 地点状态\n\n' +
      '只输出摘要正文，不要任何解释。\n\n' +
      (o.memory ? '===== 长期记忆（只读参考，不要复述） =====\n' + o.memory + '\n\n' : '') +
      '===== 上一版章节摘要 =====\n' + (o.prevSummary || '（无）') + '\n\n' +
      '===== 本批旧对话（按原顺序） =====\n' + transcript;
  }
  function parseSummary(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    t = t.replace(/^\[?CHAPTER[ _]SUMMARY[^\n]*\]?\s*\n/i, '');
    t = canonicalize(t);
    const missing = SUMMARY_SECTIONS.filter(k => !new RegExp('(^|\\n)\\s*[#*]*\\s*' + k + '\\b', 'i').test(t));
    return { ok: !!t && missing.indexOf('FACTS') < 0 && missing.length <= 4, text: t, missing };
  }

  // ---------------- 价格 ----------------
  function priceFor(model, prices) {
    prices = prices || DEFAULT_PRICES; const m = String(model || '').toLowerCase();
    if (!m.includes('deepseek')) return null;
    return m.includes('pro') ? prices['deepseek-v4-pro'] : prices['deepseek-flash'];
  }
  /** 高峰：周一至周五 UTC 01:00–04:00、06:00–10:00（北京 9–12、14–18） */
  function isPeak(at) { const d = new Date(at); const day = d.getUTCDay(), h = d.getUTCHours(); return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10)); }
  function costOf(e, prices, mode) {
    const p = priceFor(e.model, prices);
    if (!p || !e.supported) return null;
    const f = mode === 'peak' ? 1 : mode === 'offpeak' ? 0.5 : (isPeak(e.timestamp) ? 1 : 0.5);
    const actual = (e.cache_hit_tokens * p.hit + e.cache_miss_tokens * p.miss + (e.completion_tokens || 0) * p.out) / 1e6 * f;
    const noCache = (e.prompt_tokens * p.miss + (e.completion_tokens || 0) * p.out) / 1e6 * f;
    return { actual, noCache, saved: noCache - actual };
  }

  // ---------------- 指标日志（第 20 节；默认不保存完整 Prompt） ----------------
  function makeLogEntry(o) {
    const u = o.usage || {};
    const supported = !!u.cacheSupported && (u.prompt || 0) > 0;
    const fp = o.fp || {};
    const e = {
      request_id: o.request_id || '', timestamp: o.at || 0, model: o.model || '', provider: o.provider || '', supported,
      prompt_tokens: u.prompt || 0, cache_hit_tokens: supported ? u.hit || 0 : 0, cache_miss_tokens: supported ? u.miss || 0 : 0, completion_tokens: u.completion || 0,
      hit_rate: supported ? (u.hit || 0) / ((u.hit || 0) + (u.miss || 0) || u.prompt) : null,
      static_hash: fp.static_hash, memory_hash: fp.memory_hash, summary_hash: fp.summary_hash, history_hash: fp.history_hash, state_hash: fp.state_hash,
      input_hash: fp.input_hash, full_prefix_hash: fp.full_prefix_hash, history_count: fp.history_count | 0, versions: fp.versions || {},
      layer_tokens: o.tokens || {}, diag: o.diag || {}, summary_happened: !!o.summaryNo, summary_no: o.summaryNo || 0, summary_reason: o.summaryReason || null,
      summary_error: o.summaryError || null, over_budget: !!o.overBudget, trimmed: !!o.trimmed, msg_id: o.msgId || '',
    };
    e.reasons = reasons(e, o.prev || null);
    e.reason = e.reasons[0];
    if (o.savePrompt && o.prompt) e.prompt = o.prompt; // 调试：仅在用户开启 save_prompt 时保存
    return e;
  }
  function appendLog(logs, e) { const out = (logs || []).concat([e]); while (out.length > LOG_LIMIT) out.shift(); return out; }
  const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
  function stats(logs, prices, mode, now) {
    const all = logs || [];
    const sup = all.filter(e => e.supported);
    const agg = list => {
      const prompt = list.reduce((n, e) => n + e.prompt_tokens, 0), hit = list.reduce((n, e) => n + e.cache_hit_tokens, 0), miss = list.reduce((n, e) => n + e.cache_miss_tokens, 0);
      return { requests: list.length, prompt, hit, miss, rate: hit + miss ? hit / (hit + miss) : null };
    };
    const today = all.filter(e => sameDay(e.timestamp, now == null ? Date.now() : now));
    const rates = sup.map(e => e.hit_rate);
    let streak = 0; for (let i = sup.length - 1; i >= 0 && sup[i].cache_hit_tokens > 0; i--) streak++;
    let saved = 0, actual = 0, priced = 0;
    sup.forEach(e => { const c = costOf(e, prices, mode); if (c) { saved += c.saved; actual += c.actual; priced++; } });
    const last20 = all.slice(-20).map((e, i, arr) => ({ n: all.length - arr.length + i + 1, rate: e.hit_rate, supported: e.supported, miss: e.cache_miss_tokens, summary: e.summary_happened, reason: e.reason }));
    return {
      requests: all.length, supported: sup.length, today: Object.assign(agg(today.filter(e => e.supported)), { requests: today.length }), total: agg(sup),
      avgRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      avgMiss: sup.length ? sup.reduce((n, e) => n + e.cache_miss_tokens, 0) / sup.length : null,
      max: rates.length ? Math.max.apply(null, rates) : null, min: rates.length ? Math.min.apply(null, rates) : null,
      streak, last20, saved, actual, priced, last: all[all.length - 1] || null, summaries: all.filter(e => e.summary_happened).length,
    };
  }
  /** 第 23 节：命中率骤降检测（与之前最多 5 次有统计的请求平均值比较） */
  function detectAnomaly(logs) {
    const sup = (logs || []).filter(e => e.supported);
    const cur = (logs || [])[(logs || []).length - 1];
    const res = { anomaly: false, avg: null, current: cur ? cur.hit_rate : null, changed: [], causes: [] };
    if (!cur) return res;
    res.changed = LAYERS.filter(k => k !== 'input' && cur.diag && cur.diag[k] === 'CHANGED');
    if (!cur.supported) return res;
    const prev = sup.slice(0, -1).filter(e => !(e.diag && e.diag.static === 'NEW')).slice(-5); // 首次请求（缓存尚未建立）不计入基线
    if (prev.length < 2) return res;
    const avg = prev.reduce((n, e) => n + e.hit_rate, 0) / prev.length;
    res.avg = avg;
    res.anomaly = avg >= 0.5 && cur.hit_rate < avg - 0.3 && cur.hit_rate < avg * 0.6;
    if (res.anomaly) {
      const map = { static: 'Static Hash 变化：角色卡 / 世界观等永久锚点被修改', memory: 'Memory Hash 变化：长期记忆被更新',
        summary: 'Summary Hash 变化：章节摘要被重新生成 / 修改，导致稳定前缀发生变化', history: 'History Hash 变化：较早的历史被编辑、删除、截断或摘要',
        state: 'State Hash 变化：动态状态位于末尾，正常情况下只影响最后一小段' };
      res.causes = res.changed.filter(k => k !== 'state').map(k => map[k]);
      (cur.reasons || []).forEach(r => { if (r !== '正常动态更新' && !res.causes.some(c => c.indexOf(r) >= 0)) res.causes.push(r); });
      if (!res.causes.length) res.causes.push('本地上下文没有变化：可能是服务端缓存过期或尚未建立（DeepSeek 缓存为尽力而为，通常数小时到数天清除）');
    }
    return res;
  }

  const api = { STATIC_DEFS, BLOCK_DEFS, BLOCK_TITLES, LAYERS, LAYER_TITLES, LAYER_CN, DEFAULT_SETTINGS, DEFAULT_PRICES, SUMMARY_SECTIONS,
    canonicalize, sha256, vlabel, slabel, newState, normalizeState, getBlock, updateBlock, restoreBlock, setBlock, syncBase,
    activeSummary, addSummary, editSummary, rollbackSummary, staticText, memoryText, summaryText, stateText, buildSystem, finalUserContent, serializeHistory,
    estimateTokens, estimateItems, oldestBatch, plan, fallbackTrim, assemble, fingerprints, diagnose, reasons,
    buildSummaryPrompt, parseSummary, priceFor, isPeak, costOf, makeLogEntry, appendLog, stats, detectAnomaly };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RPCache = api;
})(typeof window !== 'undefined' ? window : globalThis);
