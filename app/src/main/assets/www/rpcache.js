/* RP 缓存优化器 V2/V3（DeepSeek / 千问）—— Context Builder 核心逻辑（纯函数，可在 Node 中测试）
 * 设计文档：docs/plugins/deepseek-rp-cache-design-v1.md（V1）+ docs/plugins/README.md「V2 变更」；
 * 核心：能不动就不动，能追加就不重写，能摘要就不盲删，能把动态内容放后面就绝不放前面。
 * 请求顺序：system = L1 永久锚点 → L2 长期记忆（稳定事实）→ L3 冻结章节 #001、#002…（只追加）
 *           messages = L4 最近完整对话（原样追加）→ 最后一条用户消息 = L6 本轮输入 + 记忆增量 + L5 当前状态
 * V2：章节只追加（超过上限才合并一次）、记忆增量放在尾部、摘要最小间隔、按实际用量校准 Token 估算、
 *     服务商适用性判断（默认只对 DeepSeek 生效）、价格 / 高峰时段可配置。
 *  V3：千问（显式 / 隐式缓存）、缓存能力识别与策略选择、按上下文窗口自动预算、自适应摘要时机、缓存冷却感知、内置价格表。
 */
(function (root) {
  'use strict';

  // L1 永久锚点（固定顺序）
  const STATIC_DEFS = [
    { id: 'world', tag: 'WORLD', title: '世界观', hint: '世界背景、地点、势力、魔法/科技规则。几乎不改。' },
    { id: 'character', tag: 'CHARACTER', title: '角色卡', hint: '角色身份、性格、说话方式、人物基础资料与人物关系基础。' },
    { id: 'rules', tag: 'RP_RULES', title: 'RP 规则', hint: '例如：NPC 不能读取玩家内心；NPC 只知道自己应该知道的信息；不替玩家决定行动。' },
    { id: 'format', tag: 'OUTPUT_FORMAT', title: '输出格式', hint: '回复格式、长度、人称、是否带动作描写等。' },
    { id: 'fewshot', tag: 'FEW_SHOT', title: '示例对白', hint: '几段示例对话（Few-shot），展示期望的文风与格式。' },
    { id: 'prohibit', tag: 'PROHIBITIONS', title: '禁止事项', hint: '绝对不能出现的内容或行为。' },
    { id: 'style', tag: 'STYLE', title: '写作风格', hint: '固定写作风格、语气、节奏。' },
  ];
  const BLOCK_DEFS = STATIC_DEFS.map(d => Object.assign({ layer: 'L1', type: 'static', cache_priority: 'high' }, d)).concat([
    { id: 'memory', tag: 'LONG_TERM_MEMORY', title: '长期记忆', layer: 'L2', type: 'memory', cache_priority: 'medium',
      hint: '已确认的重要事实、人物关系、重大事件、长期目标、关键道具、已揭开的秘密、未解决的剧情线。只在发生重要事件时手动更新。' },
    { id: 'delta', tag: 'MEMORY_UPDATE', title: '记忆增量', layer: 'L4+', type: 'delta', cache_priority: 'low',
      hint: '新近确认、还没合并进长期记忆的事实。放在对话历史之后（最后一条用户消息里），随时修改都不会破坏前面的缓存；攒多了再「合并进长期记忆」。' },
    { id: 'state', tag: 'CURRENT_STATE', title: '当前动态状态', layer: 'L5', type: 'dynamic', cache_priority: 'low',
      hint: 'HP / MP / 金钱 / 时间 / 地点 / 好感度 / 天气 / 任务 / 装备 / 增益效果。放在最后一条用户消息末尾，随时修改都不会破坏历史缓存。' },
  ]);
  const BLOCK_TITLES = Object.fromEntries(BLOCK_DEFS.map(d => [d.id, d.title]));
  const LAYERS = ['static', 'memory', 'summary', 'history', 'delta', 'state', 'input'];
  // 界面显示用（v0.3.3 起为中文）；日志 / 诊断里保存的仍是英文键名与 SAME / APPEND / CHANGED
  const LAYER_TITLES = { static: '固定设定', memory: '长期记忆', summary: '章节摘要', history: '对话历史', delta: '记忆增量', state: '当前状态', input: '本轮输入' };
  const LAYER_EN = { static: 'Static', memory: 'Memory', summary: 'Summary', history: 'History', delta: 'Delta', state: 'State', input: 'Input' };
  const DIAG_LABELS = { SAME: '未变', APPEND: '追加', CHANGED: '已改动', NEW: '首次' };
  const diagLabel = v => DIAG_LABELS[v] || v || '—';
  // 章节摘要各段标题（发送给模型 / 保存的文本保持英文，界面显示中文释义）
  const SUMMARY_SECTION_CN = { FACTS: '已发生的事实', CHARACTER_KNOWLEDGE: '角色知道的', PLAYER_KNOWLEDGE: '玩家知道的', SECRET: '秘密（角色不知道）',
    UNRESOLVED: '未解决的线索', RELATIONSHIPS: '人物关系', OBJECTS: '关键物品', LOCATION: '地点' };
  const LAYER_CN = { static: '永久锚点', memory: '长期记忆', summary: '章节摘要', history: '最近对话', delta: '记忆增量', state: '动态状态', input: '当前输入' };
  // 默认工程参数（设计文档第 9、17、26 节）——不是 DeepSeek 官方阈值，可按会话修改
  const DEFAULT_SETTINGS = {
    max_context: 100000, output_reserve: 12000, safety_margin: 2000,
    summary: { enabled: true, trigger_tokens: 30000, min_new_turns: 15, keep_recent_turns: 20,
      min_interval_turns: 10,      // V2：距上一章至少这么多轮才会因「达到阈值」再摘要（超预算不受限）
      chapter_cap_tokens: 12000 }, // V2：全部章节合计超过此值时，下一次摘要改为「合并全部章节」（一次性重建缓存）
    summary_model: '', save_prompt: false,
    force_enable: false,      // V2：非 DeepSeek 服务商也强制启用（默认不适用，不改写请求）
    refresh_on_regen: false,  // V2：重新生成最后一条回复时，是否用最新内容（联网搜索 / 文件）刷新冻结的用户消息
    auto_budget: true,        // V3：按模型上下文窗口 / 价格阶梯自动推导预算（手动修改任一预算数值即关闭）
    auto_summary: true,       // V3：自适应摘要时机（成本回本 + 缓存冷却），关闭则只按固定阈值
    cache_mode: 'auto',       // V3：auto | explicit | implicit —— 支持显式缓存的模型（千问）用哪种缓存
    // v0.12：世界书 ST 语义（默认保持 v0.9.3 行为：scanDepth=2、无递归、概率 100）
    lore: {
      scanDepth: 2,           // 扫描最近 N 条消息（含本轮用户）；2 ≈ 旧「本轮+上一条回复」
      recursionDepth: 0,      // 0=关闭；>0 时被激活条目的 content 再参与扫描
      budgetPct: 0.25,        // 触发条目单轮预算（相对 max_context）
      constantBudgetPct: 0.15,// 常驻条目预算兜底
      rebuildOnEdit: false,   // 修改世界书后立即重建上下文（清空冻结并冷路径重排）
    },
  };
  const DEFAULT_PEAK = { windows: '09:00-12:00,14:00-18:00', tz: 8, weekdays: true, off_factor: 0.5 };
  // DeepSeek 官方价格（美元 / 百万 tokens，高峰时段；非高峰为一半）—— 2026-10 核对 api-docs.deepseek.com/quick_start/pricing
  // match：模型名包含其中任意一个关键词即使用该价格（逗号分隔，越长越优先）；可在插件设置里修改 / 新增
  const DEFAULT_PRICES = {
    'deepseek-flash': { hit: 0.006, miss: 0.3, out: 1.2, match: 'deepseek' },
    'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96, match: 'deepseek-v4-pro,deepseek-pro' },
  };
  // V3：内置价格表（用户规则没有匹配时自动使用，「新模型自动匹配价格」）。千问为阿里云百炼中国站第一档价格（元 / 百万 Token），
  // 按 1 美元 ≈ 7.2 元换算成美元；隐式缓存命中 = 输入 20%，显式缓存命中 = 10%，显式缓存创建 = 125%；千问无高峰时段（peak:false）。
  // 来源：help.aliyun.com/zh/model-studio/model-pricing（2026-10-15 更新）、/context-cache、/explicit-cache-guide
  const CNY_PER_USD = 7.2;
  const qp = (miss, out, match) => {
    const m = miss / CNY_PER_USD, r = v => Math.round(v * 1e5) / 1e5;
    return { hit: r(m * 0.2), hit_explicit: r(m * 0.1), write: r(m * 1.25), miss: r(m), out: r(out / CNY_PER_USD), match, peak: false, builtin: true };
  };
  const BUILTIN_PRICES = {
    'deepseek-flash': Object.assign({}, DEFAULT_PRICES['deepseek-flash'], { builtin: true }),
    'deepseek-v4-pro': Object.assign({}, DEFAULT_PRICES['deepseek-v4-pro'], { builtin: true }),
    'qwen3.8-max': qp(12, 36, 'qwen3.8-max,qwen3.7-max'),
    'qwen3.7-plus': qp(2, 8, 'qwen3.7-plus'),
    'qwen3.6-plus': qp(2, 12, 'qwen3.6-plus'),
    'qwen3.5-plus': qp(0.8, 4.8, 'qwen3.5-plus'),
    'qwen-plus': qp(0.8, 2, 'qwen-plus,qwen'),            // 兜底：未知千问模型按 qwen-plus 估算
    'qwen3.8-flash': qp(0.8, 2.7, 'qwen3.8-flash'),
    'qwen3.7-flash': qp(0.2, 0.8, 'qwen3.7-flash'),
    'qwen3.6-flash': qp(1.2, 7.2, 'qwen3.6-flash'),
    'qwen3.5-flash': qp(0.2, 2, 'qwen3.5-flash'),
    'qwen-flash': qp(0.15, 1.5, 'qwen-flash,qwen-turbo'),
    'qwen-max': qp(2.4, 9.6, 'qwen-max'),
    'qwen3-coder-flash': qp(1, 4, 'qwen3-coder-flash,qwen3-coder'),
    'qwen3-vl-plus': qp(1, 10, 'qwen3-vl-plus,qwen-vl'),
    'qwen-plus-character': qp(0.8, 2, 'qwen-plus-character,character'),
    'qwen-long': qp(0.5, 2, 'qwen-long'),
  };
  const HISTORY_LIMIT = 30;
  const LOG_LIMIT = 500;
  const pad3 = n => String(n).padStart(3, '0');
  const vlabel = (prefix, n) => prefix + '_v' + pad3(n | 0);
  const slabel = n => '#' + pad3(n | 0);
  const VER_KIND_CN = { static: '固定设定', memory: '长期记忆', delta: '记忆增量', state: '当前状态' };
  /** 中文版本标签：固定设定 第 2 版 */
  const verLabel = (kind, n) => (VER_KIND_CN[kind] || kind) + ' 第 ' + (n | 0) + ' 版';

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
      chapters: [],                        // V2：冻结章节（只追加），按顺序全部发送
      chapterSeq: 0,                       // 章节编号计数（合并后也不复用旧编号）
      archive: [],                         // 被合并 / 撤销的旧章节（只读存档）
      lastSummaryRound: 0,                 // 上一次生成章节时的对话轮数（最小间隔用）
      calib: 1,                            // Token 估算校准系数（按服务商返回的真实输入 Token 自动调整）
      window: { startId: null, startOrdinal: 0 }, // 仅在超预算且无法摘要时使用的「分块截断」起点
      settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
      seq: 0,
      loreState: { turn: 0, entries: {} }, // v0.13：sticky / cooldown / delay 状态机
    };
  }
  /** v0.3.x 的单份合并摘要 → V2 章节 #001（覆盖范围不变，内容逐字保留） */
  function migrateSummaries(summaries) {
    if (!Array.isArray(summaries) || !summaries.length) return null;
    const act = summaries[summaries.length - 1];
    if (!act || !act.content) return null;
    const content = canonicalize(act.content);
    return [{ no: 1, content, hash: sha256(content), coveredIds: (act.coveredIds || []).slice(), at: act.at || 0, source: 'migrated', rounds: act.rounds | 0,
      atRound: 0, history: [], migratedFrom: act.no | 0 }];
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
    const settings = Object.assign({}, DEFAULT_SETTINGS, ss, {
      summary: Object.assign({}, DEFAULT_SETTINGS.summary, ss.summary || {}),
      lore: Object.assign({}, DEFAULT_SETTINGS.lore, ss.lore || {}),
    });
    // 旧版（v0.4 及以前）保存的设置没有 auto_budget：数值仍是默认值 → 自动；用户改过 → 保持手动
    if (ss.max_context != null && ss.auto_budget == null) settings.auto_budget = budgetIsDefault(settings);
    let chapters = Array.isArray(st.chapters) ? st.chapters : null;
    let chapterSeq = st.chapterSeq | 0;
    if (!chapters) { chapters = migrateSummaries(st.summaries) || []; chapterSeq = Math.max(chapterSeq, chapters.length); }
    const calib = typeof st.calib === 'number' && st.calib >= 0.5 && st.calib <= 2.5 ? st.calib : 1;
    return Object.assign({}, st, { blocks, settings, staticVersion: st.staticVersion | 0, baseHash: st.baseHash == null ? null : st.baseHash,
      summaries: Array.isArray(st.summaries) ? st.summaries : [], chapters, chapterSeq: Math.max(chapterSeq, chapters.reduce((n, c) => Math.max(n, c.no | 0), 0)),
      archive: Array.isArray(st.archive) ? st.archive : [], lastSummaryRound: st.lastSummaryRound | 0, calib,
      window: Object.assign({ startId: null, startOrdinal: 0 }, st.window || {}), seq: st.seq | 0,
      loreState: normalizeLoreState(st.loreState) });
  }
  function normalizeLoreState(ls) {
    const base = { turn: 0, entries: {} };
    if (!ls || typeof ls !== 'object') return base;
    const entries = {};
    const src = ls.entries && typeof ls.entries === 'object' ? ls.entries : {};
    Object.keys(src).forEach(id => {
      const e = src[id] || {};
      entries[id] = {
        stickyUntil: e.stickyUntil | 0,
        cooldownUntil: e.cooldownUntil | 0,
        lastAnchorId: e.lastAnchorId || null,
      };
    });
    return { turn: ls.turn | 0, entries };
  }
  function loreStateOf(st) { return normalizeLoreState(st && st.loreState); }
  /** 章节覆盖 / 重建时清理：去掉已无有效冻结的条目状态，或整表重置 */
  function pruneLoreState(st, opts) {
    opts = opts || {};
    if (opts.reset) return Object.assign({}, st, { loreState: { turn: 0, entries: {} } });
    const ls = loreStateOf(st);
    const keep = opts.keepEntryIds ? new Set(opts.keepEntryIds) : null;
    if (!keep) {
      // 默认：仅保留仍有 activeFired 的 entry
      const live = new Set((opts.active || activeFired(st, opts.items || [])).map(r => r.entryId));
      const entries = {};
      Object.keys(ls.entries).forEach(id => { if (live.has(id)) entries[id] = ls.entries[id]; });
      return Object.assign({}, st, { loreState: { turn: ls.turn, entries } });
    }
    const entries = {};
    Object.keys(ls.entries).forEach(id => { if (keep.has(id)) entries[id] = ls.entries[id]; });
    return Object.assign({}, st, { loreState: { turn: ls.turn, entries } });
  }
  function budgetIsDefault(s) {
    const d = DEFAULT_SETTINGS, a = s.summary || {}, b = d.summary;
    return s.max_context === d.max_context && s.output_reserve === d.output_reserve && s.safety_margin === d.safety_margin &&
      a.trigger_tokens === b.trigger_tokens && a.chapter_cap_tokens === b.chapter_cap_tokens;
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

  /** 显式更新 L1 的对话系统提示词（切换提示词模板 / 手动修改），记录原因供下一次请求的诊断使用 */
  function explicitBaseUpdate(state, baseSystem, cause, at) {
    const st = normalizeState(state);
    const s2 = syncBase(st, baseSystem);
    if (s2 === st) return { state: st, changed: false };
    return { state: Object.assign({}, s2, { pendingStaticCause: Object.assign({ at: at || 0 }, cause || { kind: 'manual' }) }), changed: true };
  }
  /** 记录「对话历史将被改变」的原因（切换较早回复的版本 / 从较早回复重新生成 / 编辑并重发），下一次请求诊断为 History CHANGED 时显示 */
  function markHistoryCause(state, cause, at) {
    return Object.assign({}, normalizeState(state), { pendingHistoryCause: Object.assign({ at: at || 0 }, cause || { kind: 'version' }) });
  }
  const HISTORY_CAUSE = c => !c ? null : c.kind === 'regen' ? '从较早的回复重新生成（新分支），对话历史改变'
    : c.kind === 'branch' ? '编辑并重新发送了较早的消息（新分支），对话历史改变'
    : c.kind === 'delete' ? '删除了较早回复的版本，对话历史改变' : '切换了较早回复的版本，对话历史改变';
  const STATIC_CAUSE = c => !c ? null : c.kind === 'template' ? '切换了提示词模板「' + c.name + '」，L1 固定前缀改变'
    : c.kind === 'clear' ? '清空了提示词模板，L1 固定前缀改变' : '手动修改了对话系统提示词，L1 固定前缀改变';

  // ---------------- 章节（V2：冻结、只追加；超过上限才合并一次） ----------------
  const ARCHIVE_LIMIT = 50;
  const chaptersOf = st => (st && st.chapters) || [];
  /** 当前最后一章（兼容旧接口名） */
  const activeSummary = st => { const c = chaptersOf(st); return c.length ? c[c.length - 1] : null; };
  /** 已写入章节（不再发送原文）的全部消息 id */
  function coveredIds(st) { const out = []; chaptersOf(st).forEach(c => (c.coveredIds || []).forEach(id => out.push(id))); return out; }
  function chapterSourceFp(items, covered) {
    const set = new Set(covered || []);
    const parts = (items || []).filter(m => set.has(m.id)).map(m => m.role + ':' + String(m.content || ''));
    return parts.length ? ('sha256:' + sha256(parts.join('\n'))) : null;
  }
  function mkChapter(st, o) {
    const no = (st.chapterSeq | 0) + 1;
    const content = canonicalize(o.content);
    return { no, content, hash: sha256(content), coveredIds: (o.coveredIds || []).slice(), at: o.at || 0, source: o.source || 'auto', rounds: o.rounds | 0,
      atRound: o.atRound | 0, history: [], mergedFrom: o.mergedFrom || null,
      sourceFp: o.sourceFp || null, quality: o.quality != null ? o.quality : null };
  }
  /** 事务提交：校验摘要质量 / 源指纹后再落章；失败不推进窗口 */
  function commitChapter(st, o) {
    const ps = o.parsed || parseSummary(o.content);
    if (!ps.ok) return { ok: false, state: st, reason: 'invalid_summary', parsed: ps };
    if (ps.quality != null && ps.quality < SUMMARY_MIN_QUALITY && !o.force) return { ok: false, state: st, reason: 'low_quality', parsed: ps };
    const sourceFp = o.sourceFp || (o.batch ? chapterSourceFp(o.batch, o.coveredIds) : null);
    const next = addChapter(st, Object.assign({}, o, { content: ps.text || o.content, sourceFp, quality: ps.quality }));
    return { ok: true, state: next, chapter: chaptersOf(next)[chaptersOf(next).length - 1], parsed: ps };
  }
  /** 追加新章节：只覆盖本批新移出的历史；之前的章节逐字不变 → 前缀保持 */
  function addChapter(st, o) {
    const ch = mkChapter(st, o);
    const next = Object.assign({}, st, { chapters: chaptersOf(st).concat([ch]), chapterSeq: ch.no, lastSummaryRound: o.atRound != null ? o.atRound | 0 : st.lastSummaryRound | 0,
      window: { startId: null, startOrdinal: 0 }, overflow: null });
    return clearLoreStateForCovered(next, ch.coveredIds || []);
  }
  /** 锚点被章节覆盖后，清掉对应条目的 sticky/cooldown，允许再次触发 */
  function clearLoreStateForCovered(st, covered) {
    const cov = new Set(covered || []);
    if (!cov.size) return st;
    const ls = loreStateOf(st);
    const entries = {};
    Object.keys(ls.entries).forEach(id => {
      const es = ls.entries[id];
      if (es && es.lastAnchorId && cov.has(es.lastAnchorId)) return;
      entries[id] = es;
    });
    return Object.assign({}, st, { loreState: { turn: ls.turn, entries } });
  }
  const pushArchive = (st, list, why, at) => (st.archive || []).concat(list.map(c => Object.assign({}, c, { archivedAt: at || 0, archivedWhy: why }))).slice(-ARCHIVE_LIMIT);
  /** 合并全部章节（+ 可选的新一批历史）为一章：只在章节总量超过上限时使用，会让 L3 之后的缓存重建一次 */
  function consolidate(st, o) {
    // 与 commitChapter 一致：合并路径同样执行质量门（八分区 + SUMMARY_MIN_QUALITY）
    if (!o.force) {
      const ps = o.parsed || parseSummary(o.content);
      if (!ps.ok) return { ok: false, state: st, reason: 'invalid_summary', parsed: ps };
      if (ps.quality != null && ps.quality < SUMMARY_MIN_QUALITY) return { ok: false, state: st, reason: 'low_quality', parsed: ps };
      o = Object.assign({}, o, { content: ps.text || o.content, quality: ps.quality, parsed: ps });
    }
    const old = chaptersOf(st);
    const ch = mkChapter(st, Object.assign({}, o, { coveredIds: coveredIds(st).concat(o.coveredIds || []), mergedFrom: old.map(c => c.no), source: o.source || 'merge' }));
    const next = Object.assign({}, st, { chapters: [ch], chapterSeq: ch.no, archive: pushArchive(st, old, 'merge', o.at),
      lastSummaryRound: o.atRound != null ? o.atRound | 0 : st.lastSummaryRound | 0, window: { startId: null, startOrdinal: 0 } });
    const cleared = clearLoreStateForCovered(next, ch.coveredIds || []);
    return o.force ? cleared : { ok: true, state: cleared, chapter: chaptersOf(cleared)[0], parsed: o.parsed || null };
  }
  /** 编辑某一章（会让这一章及之后的缓存重建）；旧内容进入该章的版本历史 */
  function editChapter(st, no, content, at) {
    const list = chaptersOf(st); const i = list.findIndex(c => c.no === no);
    if (i < 0) throw new Error('找不到章节 ' + slabel(no));
    const c = canonicalize(content);
    if (!c) throw new Error('章节内容不能为空');
    if (c === list[i].content) return { state: st, changed: false };
    const old = list[i];
    const history = (old.history || []).concat([{ content: old.content, hash: old.hash, at: old.editedAt || old.at || 0, source: old.source }]).slice(-HISTORY_LIMIT);
    const nc = Object.assign({}, old, { content: c, hash: sha256(c), history, editedAt: at || 0, source: 'edit' });
    const chapters = list.slice(); chapters[i] = nc;
    return { state: Object.assign({}, st, { chapters }), changed: true, tailFrom: i };
  }
  /** 撤销最后一章：它覆盖的消息重新以原文发送（存档保留） */
  function removeLastChapter(st, at) {
    const list = chaptersOf(st); if (!list.length) throw new Error('还没有章节');
    const last = list[list.length - 1];
    if (last.mergedFrom && last.mergedFrom.length) {
      // 合并章：恢复被合并的原章节
      const restored = (st.archive || []).filter(a => a.archivedWhy === 'merge' && last.mergedFrom.indexOf(a.no) >= 0)
        .map(a => { const c = Object.assign({}, a); delete c.archivedAt; delete c.archivedWhy; return c; });
      if (restored.length === last.mergedFrom.length) {
        const extra = (last.coveredIds || []).filter(id => !restored.some(c => c.coveredIds.indexOf(id) >= 0));
        return { state: Object.assign({}, st, { chapters: restored, archive: pushArchive(st, [last], 'undo', at), window: { startId: null, startOrdinal: 0 } }), changed: true, reopened: extra.length };
      }
    }
    return { state: Object.assign({}, st, { chapters: list.slice(0, -1), archive: pushArchive(st, [last], 'undo', at), window: { startId: null, startOrdinal: 0 } }),
      changed: true, reopened: (last.coveredIds || []).length };
  }
  // 兼容 v0.3.x 测试 / 调用：addSummary = 追加章节（coveredIds 若包含已覆盖的 id 会自动去重）
  function addSummary(st, o) {
    const had = new Set(coveredIds(st));
    return addChapter(st, Object.assign({}, o, { coveredIds: (o.coveredIds || []).filter(id => !had.has(id)) }));
  }

  // ---------------- v0.9.3+v0.12：世界书（ST 语义 + 双轨冻结） ----------------
  /**
   * 文本格式（一段一条）：
   *   ## 名称 | 关键词1, 关键词2      → 触发条目
   *   ## 名称 | *                     → 常驻条目（进 L1，带预算兜底）
   *   ## 名称 | keys | priority=10;prob=80;sec=a,b;secLogic=AND_ANY;depth=4
   * 热路径：新触发只冻结追加到锚点消息（前缀稳定）。
   * 冷路径：rebuildLore / 设定「修改后立即重建」时完整重排。
   */
  const LORE_DEFAULT_ATTRS = {
    secondaryKeys: [], secondaryLogic: 'AND_ANY', probability: 100, priority: 100, order: 100,
    scanDepth: null, caseSensitive: false, matchWholeWords: false, useRegex: false,
    sticky: 0, cooldown: 0, delay: 0, inclusionGroup: '',
  };
  function parseLoreAttrs(raw) {
    const a = Object.assign({}, LORE_DEFAULT_ATTRS);
    String(raw || '').split(/[;；]/).map(s => s.trim()).filter(Boolean).forEach(pair => {
      const eq = pair.indexOf('=');
      const k = (eq < 0 ? pair : pair.slice(0, eq)).trim().toLowerCase();
      const v = (eq < 0 ? '1' : pair.slice(eq + 1)).trim();
      if (k === 'priority' || k === 'prio') a.priority = parseInt(v, 10) || 0;
      else if (k === 'order') a.order = parseInt(v, 10) || 0;
      else if (k === 'prob' || k === 'probability') a.probability = Math.max(0, Math.min(100, parseFloat(v) || 0));
      else if (k === 'depth' || k === 'scandepth') a.scanDepth = Math.max(1, parseInt(v, 10) || 1);
      else if (k === 'sec' || k === 'secondary' || k === 'secondarykeys') a.secondaryKeys = v.split(/[,，、]/).map(x => x.trim()).filter(Boolean);
      else if (k === 'seclogic' || k === 'logic') {
        const m = String(v).toUpperCase();
        a.secondaryLogic = ['AND_ANY', 'AND_ALL', 'NOT_ANY', 'NOT_ALL'].includes(m) ? m : 'AND_ANY';
      } else if (k === 'regex') a.useRegex = v !== '0' && v !== 'false';
      else if (k === 'case' || k === 'casesensitive') a.caseSensitive = v !== '0' && v !== 'false';
      else if (k === 'whole' || k === 'wholeword') a.matchWholeWords = v !== '0' && v !== 'false';
      else if (k === 'sticky') a.sticky = Math.max(0, parseInt(v, 10) || 0);
      else if (k === 'cooldown') a.cooldown = Math.max(0, parseInt(v, 10) || 0);
      else if (k === 'delay') a.delay = Math.max(0, parseInt(v, 10) || 0);
      else if (k === 'group' || k === 'inclusiongroup') a.inclusionGroup = v;
    });
    return a;
  }
  function parseLore(text) {
    const out = []; let cur = null;
    String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach(line => {
      const m = /^##\s*(.+?)\s*(?:\|\s*(.*))?$/.exec(line);
      if (m) { cur = { name: m[1].trim(), keysRaw: (m[2] || '').trim(), lines: [] }; out.push(cur); }
      else if (cur) cur.lines.push(line);
    });
    return out.map((e, idx) => {
      // keysRaw 可能含第二段 attrs：`keys | attrs` 或仅 `*`
      let keysPart = e.keysRaw, attrsPart = '';
      const pipe = e.keysRaw.indexOf('|');
      if (pipe >= 0) { keysPart = e.keysRaw.slice(0, pipe).trim(); attrsPart = e.keysRaw.slice(pipe + 1).trim(); }
      const constant = keysPart === '*' || keysPart === '';
      const keys = constant ? [] : keysPart.split(/[,，、]/).map(k => k.trim()).filter(Boolean);
      const content = canonicalize(e.lines.join('\n'));
      const attrs = parseLoreAttrs(attrsPart);
      return Object.assign({
        id: sha256(e.name + '\0' + keysPart).slice(0, 12),
        name: e.name, mode: constant ? 'constant' : 'trigger', keys, content,
      }, attrs, { order: attrs.order !== 100 ? attrs.order : idx });
    }).filter(e => e.content);
  }
  function loreToText(list) {
    return (list || []).map(e => {
      let head = '## ' + e.name + ' | ' + (e.mode === 'constant' ? '*' : (e.keys || []).join(', '));
      const attrs = [];
      if (e.priority != null && e.priority !== 100) attrs.push('priority=' + e.priority);
      if (e.order != null && e.order !== 100) attrs.push('order=' + e.order);
      if (e.probability != null && e.probability !== 100) attrs.push('prob=' + e.probability);
      if (e.scanDepth != null) attrs.push('depth=' + e.scanDepth);
      if (e.secondaryKeys && e.secondaryKeys.length) {
        attrs.push('sec=' + e.secondaryKeys.join(','));
        if (e.secondaryLogic && e.secondaryLogic !== 'AND_ANY') attrs.push('secLogic=' + e.secondaryLogic);
      }
      if (e.useRegex) attrs.push('regex=1');
      if (e.caseSensitive) attrs.push('case=1');
      if (e.matchWholeWords) attrs.push('whole=1');
      if (e.sticky) attrs.push('sticky=' + e.sticky);
      if (e.cooldown) attrs.push('cooldown=' + e.cooldown);
      if (e.delay) attrs.push('delay=' + e.delay);
      if (e.inclusionGroup) attrs.push('group=' + e.inclusionGroup);
      if (attrs.length) head += ' | ' + attrs.join(';');
      return head + '\n' + e.content;
    }).join('\n\n');
  }
  function loreOf(st) { return Array.isArray(st && st.lore) ? st.lore : []; }
  function firedOf(st) { return Array.isArray(st && st.loreFired) ? st.loreFired : []; }
  function loreSettings(st) {
    const d = DEFAULT_SETTINGS.lore || {};
    return Object.assign({}, d, (st && st.settings && st.settings.lore) || {});
  }
  function setLore(st, text, at) {
    const lore = parseLore(text);
    const prevHash = st && st.loreTextHash;
    const loreText = String(text || '');
    const loreTextHash = sha256(loreText);
    let next = Object.assign({}, st, { lore, loreText, loreTextHash });
    if (prevHash && prevHash !== loreTextHash && firedOf(st).length) next = Object.assign(next, { loreEditedWhileFrozen: true });
    const ls = loreSettings(next);
    if (ls.rebuildOnEdit && prevHash && prevHash !== loreTextHash) {
      next = Object.assign(next, { loreFired: [], loreEditedWhileFrozen: false, loreNeedsRebuild: true });
    }
    return next;
  }
  function estimateLoreTokens(e) { return estimateTokens((e.name || '') + '\n' + (e.content || '')); }
  /** 常驻条目按 priority 贪心填入预算，防止撑爆 static */
  function selectConstantLore(st, ctxTokens) {
    const ls = loreSettings(st);
    const all = loreOf(st).filter(e => e.mode === 'constant');
    if (!all.length) return [];
    const ctx = ctxTokens || (st.settings && st.settings.max_context) || DEFAULT_SETTINGS.max_context;
    const budget = Math.max(200, Math.floor(ctx * (ls.constantBudgetPct != null ? ls.constantBudgetPct : 0.15)));
    const sorted = all.slice().sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
    const out = []; let used = 0; let remaining = budget;
    for (const e of sorted) {
      const t = estimateLoreTokens(e);
      if (t > remaining) continue; // 装不下则跳过，继续试下一条
      out.push(e); used += t; remaining -= t;
    }
    return out;
  }
  function constantLoreText(st) {
    const c = selectConstantLore(st);
    return c.length ? '[LOREBOOK]\n' + c.map(e => '# ' + e.name + '\n' + e.content).join('\n\n') : '';
  }
  const loreBlockText = r => '[LORE_TRIGGERED ' + r.name + ']\n' + r.content;
  function activeFired(st, items) {
    const covered = new Set(coveredIds(st)); const ids = new Set((items || []).map(m => m.id));
    return firedOf(st).filter(r => ids.has(r.anchorId) && !covered.has(r.anchorId));
  }
  function matchKey(scan, key, e) {
    if (!key) return false;
    if (e.useRegex) {
      try {
        const re = new RegExp(key, e.caseSensitive ? '' : 'i');
        return re.test(scan);
      } catch (_) { return false; }
    }
    const hay = e.caseSensitive ? scan : scan.toLowerCase();
    const needle = e.caseSensitive ? key : key.toLowerCase();
    if (e.matchWholeWords) {
      const re = new RegExp('(?:^|[^\\w\\u4e00-\\u9fff])' + needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|[^\\w\\u4e00-\\u9fff])', e.caseSensitive ? '' : 'i');
      return re.test(scan);
    }
    return hay.includes(needle);
  }
  function matchPrimary(scan, e) {
    return (e.keys || []).some(k => matchKey(scan, k, e));
  }
  function matchSecondary(scan, e) {
    const keys = e.secondaryKeys || [];
    if (!keys.length) return true;
    const hits = keys.map(k => matchKey(scan, k, e));
    const logic = e.secondaryLogic || 'AND_ANY';
    if (logic === 'AND_ALL') return hits.every(Boolean);
    if (logic === 'NOT_ANY') return hits.every(h => !h);
    if (logic === 'NOT_ALL') return !hits.every(Boolean);
    return hits.some(Boolean); // AND_ANY
  }
  function scanWindow(items, depth) {
    const n = Math.max(1, depth | 0);
    const slice = (items || []).slice(-n);
    return slice.map(m => String(m.content || '')).join('\n');
  }
  /** 确定性种子 RNG：同 (convId+anchorId+entryId) 重生成结果一致 */
  function seedHash(str) {
    // 复用 cyrb53 的数值部分作为 32-bit 种子
    const hex = cyrb53(String(str || ''), 0);
    return parseInt(hex.slice(-8), 16) >>> 0;
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function rngForSeed(seedStr) { return mulberry32(seedHash(seedStr)); }
  function loreSeedKey(convId, anchorId, entryId) {
    return String(convId || '') + '\0' + String(anchorId || '') + '\0' + String(entryId || '');
  }
  function rollProbability(p, rng) {
    const prob = p == null ? 100 : Number(p);
    if (!(prob < 100)) return true;
    const r = typeof rng === 'function' ? rng() : Math.random();
    return r * 100 < prob;
  }
  /**
   * 激活条目（ST 语义核心）。opts.mode: 'hot'|'cold'
   * 返回按 priority/order 排序后、已过预算裁剪的条目列表（不含已 live 的）。
   */
  function activateLore(st, items, opts) {
    opts = opts || {};
    const ls = loreSettings(st);
    const lore = loreOf(st).filter(e => e.mode === 'trigger' && e.keys && e.keys.length);
    if (!lore.length || !(items || []).length) return [];
    const live = new Set(opts.excludeIds || []);
    const depth0 = ls.scanDepth | 0 || 2;
    let scan = scanWindow(items, depth0);
    // 条目级 depth：取最大窗口再扫一次（热路径仍基于同一 messages 后缀）
    const maxDepth = Math.max(depth0, ...lore.map(e => e.scanDepth || 0));
    if (maxDepth > depth0) scan = scanWindow(items, maxDepth);
    const loreSt = loreStateOf(st);
    const turn = opts.turn != null ? opts.turn | 0 : loreSt.turn | 0;
    const convId = opts.convId || '';
    const anchorId = opts.anchorId || ((items[items.length - 1] || {}).id) || '';
    // sticky 中的条目视为已激活，不重复追加；cooldown 中跳过；delay 未到跳过
    const stickyLive = new Set();
    lore.forEach(e => {
      const es = loreSt.entries[e.id];
      if (es && (es.stickyUntil | 0) > turn) stickyLive.add(e.id);
    });
    stickyLive.forEach(id => live.add(id));
    let activated = [];
    // A4：触发 trace（opts.trace 为数组时记录每条的 fired / rejected 原因；同一条只记最后一次判定）
    const tr = Array.isArray(opts.trace) ? opts.trace : null;
    const why = (e, status, reason) => { if (!tr) return; const i = tr.findIndex(x => x.id === e.id); const r = { id: e.id, name: e.name || e.id, status, reason }; if (i >= 0) tr[i] = r; else tr.push(r); };
    if (tr) lore.forEach(e => { if (live.has(e.id)) why(e, 'rejected', stickyLive.has(e.id) ? 'sticky_live' : 'already_live'); });
    function runPass(scanText) {
      const hit = [];
      for (const e of lore) {
        if (live.has(e.id) || activated.some(x => x.id === e.id)) continue;
        const es = loreSt.entries[e.id] || {};
        if ((e.delay | 0) > 0 && turn < (e.delay | 0)) { why(e, 'rejected', 'delay'); continue; }
        if ((es.cooldownUntil | 0) > turn && (es.stickyUntil | 0) <= turn) { why(e, 'rejected', 'cooldown'); continue; }
        const depth = e.scanDepth || depth0;
        const localScan = depth === maxDepth ? scanText : scanWindow(items, depth);
        if (!matchPrimary(localScan, e)) { why(e, 'rejected', 'no_key'); continue; }
        if (!matchSecondary(localScan, e)) { why(e, 'rejected', 'secondary'); continue; }
        const seed = loreSeedKey(convId, anchorId, e.id);
        const rng = opts.rng || rngForSeed(seed);
        if (!rollProbability(e.probability, rng)) { why(e, 'rejected', 'probability'); continue; }
        hit.push(e);
      }
      return hit;
    }
    activated = activated.concat(runPass(scan));
    const recMax = opts.recursionDepth != null ? opts.recursionDepth : (ls.recursionDepth | 0);
    for (let d = 0; d < recMax; d++) {
      if (!activated.length) break;
      const extra = activated.map(e => e.content).join('\n');
      scan = scan + '\n' + extra;
      const more = runPass(scan);
      if (!more.length) break;
      activated = activated.concat(more);
    }
    // inclusionGroup：同组只取 priority 最高的一条
    const byGroup = {};
    const ung = [];
    activated.forEach(e => {
      if (e.inclusionGroup) {
        const g = e.inclusionGroup;
        if (!byGroup[g] || e.priority > byGroup[g].priority) byGroup[g] = e;
      } else ung.push(e);
    });
    if (tr) activated.forEach(e => { if (e.inclusionGroup && byGroup[e.inclusionGroup] !== e) why(e, 'rejected', 'group'); });
    activated = ung.concat(Object.keys(byGroup).map(k => byGroup[k]));
    activated.sort((a, b) => (b.priority - a.priority) || (a.order - b.order));
    const ctx = opts.ctxTokens || (st.settings && st.settings.max_context) || DEFAULT_SETTINGS.max_context;
    let budget = Math.max(200, Math.floor(ctx * (ls.budgetPct != null ? ls.budgetPct : 0.25)));
    // P1：可用剩余额度（已用常量等占位）+ 装不下则 continue 试下一条
    if (opts.usedBudget != null) budget = Math.max(0, budget - (opts.usedBudget | 0));
    const remaining0 = opts.remainingBudget != null ? opts.remainingBudget | 0 : budget;
    let remaining = Math.max(0, remaining0);
    const out = []; let used = 0;
    for (const e of activated) {
      const t = estimateLoreTokens(e);
      if (t > remaining) { why(e, 'rejected', 'budget'); continue; } // 装不下就跳过，继续试下一条
      out.push(e); used += t; remaining -= t; why(e, 'fired', 'ok');
    }
    return out;
  }
  /**
   * 热路径：扫描本轮输入窗口触发条目，把新触发的冻结到本轮用户消息上（只追加）。
   * 默认 scanDepth=2、无递归时行为与 v0.9.3 兼容。
   */
  function fireLore(st, items, at, opts) {
    opts = opts || {};
    const last = items[items.length - 1];
    if (!last || last.role !== 'user' || !last.id) return { state: st, fired: [] };
    const active = activeFired(st, items);
    if (active.some(r => r.anchorId === last.id)) return { state: st, fired: [] };
    const live = new Set(active.map(r => r.entryId));
    const loreSt0 = loreStateOf(st);
    const turn = (loreSt0.turn | 0) + 1;
    const convId = opts.convId || '';
    const trace = [];
    const picked = activateLore(st, items, Object.assign({
      excludeIds: [...live],
      turn,
      convId,
      anchorId: last.id,
    }, opts, { trace }));
    // v0.16：trace 增强（版本 / 注入 Token / 预算）
    const injectTokens = picked.reduce((n, e) => n + estimateLoreTokens(e), 0);
    const ctxTok = (st.settings && st.settings.max_context) || DEFAULT_SETTINGS.max_context;
    const budgetTotal = Math.max(200, Math.floor(ctxTok * ((loreSettings(st).budgetPct != null ? loreSettings(st).budgetPct : 0.25))));
    const loreTrace = {
      v: 2, turn, anchorId: last.id, at: at || 0,
      injectTokens, budget: { total: budgetTotal, used: injectTokens, remaining: Math.max(0, budgetTotal - injectTokens) },
      items: trace.slice(0, 60).map(x => {
        const e = loreOf(st).find(y => y.id === x.id);
        return Object.assign({}, x, e ? { tokens: estimateLoreTokens(e) } : {});
      }),
    };
    // 更新 sticky / cooldown 状态机
    const entries = Object.assign({}, loreSt0.entries);
    picked.forEach(e => {
      const sticky = e.sticky | 0;
      const cooldown = e.cooldown | 0;
      const stickyUntil = sticky > 0 ? turn + sticky : turn;
      const cooldownUntil = stickyUntil + (cooldown > 0 ? cooldown : 0);
      entries[e.id] = {
        stickyUntil,
        cooldownUntil: cooldown > 0 || sticky > 0 ? cooldownUntil : (entries[e.id] && entries[e.id].cooldownUntil) || 0,
        lastAnchorId: last.id,
      };
    });
    // 过期清理：sticky/cooldown 都已过的条目可删
    Object.keys(entries).forEach(id => {
      const es = entries[id];
      if ((es.stickyUntil | 0) <= turn && (es.cooldownUntil | 0) <= turn && !picked.some(e => e.id === id) && !live.has(id)) {
        // 保留最近一次记录一小段，避免无限膨胀：仅删双过期且非 live
        delete entries[id];
      }
    });
    const loreState = { turn, entries };
    const fired = picked.map(e => ({
      entryId: e.id, name: e.name, anchorId: last.id, content: e.content,
      hash: sha256(e.content), at: at || 0, priority: e.priority | 0,
    }));
    if (!fired.length) return { state: Object.assign({}, st, { loreState, loreTrace }), fired, trace };
    const old = firedOf(st).slice(-200);
    return { state: Object.assign({}, st, { loreFired: old.concat(fired), loreState, loreTrace }), fired, trace };
  }
  const LORE_REASON = { ok: '已触发', already_live: '已在上下文中', sticky_live: 'sticky 保持中', delay: 'delay 未到', cooldown: '冷却中', no_key: '未命中关键词', secondary: '次要关键词不满足', probability: '概率未中', group: '同组被更高优先级取代', budget: '超出预算' };
  /** 把有效的冻结记录拼到各自锚点消息上（顺序 = 触发顺序；逐字节稳定） */
  function applyFrozenLore(st, items) {
    const act = activeFired(st, items); if (!act.length) return items;
    const by = {}; act.forEach(r => { (by[r.anchorId] = by[r.anchorId] || []).push(r); });
    return items.map(m => by[m.id] ? Object.assign({}, m, { content: [m.content || ''].filter(Boolean).concat(by[m.id].map(loreBlockText)).join('\n\n') }) : m);
  }
  /**
   * 冷路径：清空冻结记录，按时间顺序完整重跑激活并重新冻结（章节边界 / 用户点重建 / rebuildOnEdit）。
   * 会改变历史前缀 → 调用方应预期缓存未命中一次。
   */
  function rebuildLore(st, items, at, opts) {
    opts = opts || {};
    let state = Object.assign({}, st, {
      loreFired: [], loreNeedsRebuild: false, loreEditedWhileFrozen: false,
      loreState: { turn: 0, entries: {} }, // 重建清理状态机
    });
    const list = items || [];
    const allFired = [];
    const convId = opts.convId || '';
    for (let i = 0; i < list.length; i++) {
      if (list[i].role !== 'user' || !list[i].id) continue;
      const prefix = list.slice(0, i + 1);
      const live = new Set(allFired.filter(r => {
        const covered = new Set(coveredIds(state));
        return !covered.has(r.anchorId);
      }).map(r => r.entryId));
      const turn = (loreStateOf(state).turn | 0) + 1;
      // 临时 state 供 activate 读 lore；用 prefix 作扫描窗口
      const picked = activateLore(state, prefix, Object.assign({
        excludeIds: [...live],
        recursionDepth: loreSettings(state).recursionDepth,
        turn, convId, anchorId: list[i].id,
      }, opts));
      const entries = Object.assign({}, loreStateOf(state).entries);
      picked.forEach(e => {
        const sticky = e.sticky | 0;
        const cooldown = e.cooldown | 0;
        const stickyUntil = sticky > 0 ? turn + sticky : turn;
        const cooldownUntil = stickyUntil + (cooldown > 0 ? cooldown : 0);
        entries[e.id] = { stickyUntil, cooldownUntil: cooldown > 0 || sticky > 0 ? cooldownUntil : 0, lastAnchorId: list[i].id };
        allFired.push({
          entryId: e.id, name: e.name, anchorId: list[i].id, content: e.content,
          hash: sha256(e.content), at: at || 0, priority: e.priority | 0, rebuilt: true,
        });
      });
      state = Object.assign(state, { loreState: { turn, entries } });
    }
    state = Object.assign(state, { loreFired: allFired.slice(-200) });
    return { state, fired: allFired };
  }
  /** 摘要勘误：不改写已冻结章节，而是写进「记忆增量」 */
  function addErratum(st, no, text, at) {
    const t = canonicalize(text); if (!t) throw new Error('勘误内容不能为空');
    const cur = getBlock(st, 'delta').content;
    const line = '[SUMMARY_ERRATUM ' + slabel(no) + '] ' + t;
    return setBlock(st, 'delta', cur ? cur + '\n' + line : line, at);
  }

  // ---------------- 序列化（逐字节稳定：同样的内容 → 同样的文本） ----------------
  function staticText(st, baseSystem) {
    const parts = [];
    const b = canonicalize(baseSystem); if (b) parts.push(b);
    STATIC_DEFS.forEach(d => { const c = getBlock(st, d.id).content; if (c) parts.push('[' + d.tag + ']\n' + c); });
    const lb = constantLoreText(st); if (lb) parts.push(lb);
    return parts.join('\n\n');
  }
  function memoryText(st) { const c = getBlock(st, 'memory').content; return c ? '[LONG_TERM_MEMORY]\n' + c : ''; }
  const chapterText = c => '[CHAPTER_SUMMARY ' + slabel(c.no) + ']\n' + c.content;
  /** L3：全部章节按顺序拼接；新章节只在末尾追加，前面的章节逐字不变 */
  function summaryText(st) { return chaptersOf(st).filter(c => c.content).map(chapterText).join('\n\n'); }
  function stateText(st) { const c = getBlock(st, 'state').content; return c ? '[CURRENT_STATE]\n' + c : ''; }
  function deltaText(st) { const c = getBlock(st, 'delta').content; return c ? '[MEMORY_UPDATE]\n' + c : ''; }
  function buildSystem(st, baseSystem) { return [staticText(st, baseSystem), memoryText(st), summaryText(st)].filter(Boolean).join('\n\n'); }
  /**
   * 最后一条用户消息 = 本轮输入 + 记忆增量 + 当前状态（V2：输入在前）。
   * 这条消息进入历史后只保留输入原文；因为输入在开头，上一轮请求与本轮请求的公共前缀一直延伸到上一轮输入的末尾，
   * 比 V1（状态在前）多命中「上一轮输入」这一段，而旧的状态 / 增量不会残留在历史里误导模型。
   */
  function finalUserContent(st, input) {
    const tail = [deltaText(st), stateText(st)].filter(Boolean);
    if (!tail.length) return input;
    return [input].filter(x => x).concat(tail).join('\n\n');
  }
  const imgSig = imgs => (imgs || []).map(x => String(x).length + ':' + String(x).slice(-48));
  function serializeHistory(msgs, n) {
    const arr = (n == null ? msgs : msgs.slice(0, n)).map(m => [m.role, m.content || '', imgSig(m.images)]);
    return JSON.stringify(arr);
  }

  // ---------------- Token 估算 ----------------
  /**
   * 本地估算（DeepSeek 官方换算：1 个中文字符 ≈ 0.6 Token，1 个英文字符 ≈ 0.3 Token），V2 细分：
   * 汉字 / 假名 / 谚文 / 全角 0.6；英文字母 0.3；数字 0.5；ASCII 标点 0.6；空白 0.1；其他（emoji 等）每个码点 1.5。
   * 再乘以按真实用量自动校准的系数（plan 内部处理）。
   */
  function estimateTokens(text) {
    const s = String(text || ''); let n = 0;
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xff00 && c <= 0xffef) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x2fa1f)) n += 0.6;
      else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) n += 0.3;
      else if (c >= 48 && c <= 57) n += 0.5;
      else if (c === 32 || c === 9 || c === 10 || c === 13) n += 0.1;
      else if (c < 128) n += 0.6;
      else if (c < 0x3000) n += 0.6; // 拉丁扩展 / 西里尔 / 中文标点前的符号
      else n += 1.5;
    }
    return Math.ceil(n);
  }
  /** 校准键：provider / model / modality 隔离，避免跨模型互相污染 */
  function calibKey(meta) {
    meta = meta || {};
    return [meta.provider || '', meta.model || '', meta.modality || 'text'].join('|');
  }
  function calibOf(st, meta) {
    const key = calibKey(meta);
    if (st && st.calibBy && typeof st.calibBy[key] === 'number') return st.calibBy[key];
    // 新模型从 1.0 起，不继承全局 st.calib（避免跨模型污染）
    return 1;
  }
  /** 用服务商返回的真实输入 Token 校准估算（指数平均，系数限制在 0.5–2.5；按 provider/model/modality 隔离） */
  function calibrate(st, rawEstimate, actualPrompt, meta) {
    if (!(rawEstimate > 200) || !(actualPrompt > 0)) return st;
    const key = calibKey(meta);
    const map = Object.assign({}, st.calibBy || {});
    const prev = typeof map[key] === 'number' ? map[key] : 1.0;
    const ratio = Math.min(2.5, Math.max(0.5, actualPrompt / rawEstimate));
    const calib = Math.round((prev * 0.7 + ratio * 0.3) * 1000) / 1000;
    map[key] = calib;
    const nMap = Object.assign({}, st.calibNBy || {}); nMap[key] = (nMap[key] | 0) + 1;
    return Object.assign({}, st, { calib, calibN: (st.calibN | 0) + 1, calibBy: map, calibNBy: nMap, calibKey: key });
  }

  // v0.8.9（P2）：每条消息的估算按 id 缓存（内容 / 图片数不变则复用；运行时，不持久化）
  const tokCache = new Map();
  function itemTokens(m) {
    const imgN = m.images ? m.images.length : 0;
    if (m.id == null) return estimateTokens(m.content) + 4 + imgN * 1000;
    const hit = tokCache.get(m.id);
    if (hit && hit.c === m.content && hit.i === imgN) return hit.t;
    const t = estimateTokens(m.content) + 4 + imgN * 1000;
    if (tokCache.size > 20000) tokCache.clear();
    tokCache.set(m.id, { c: m.content, i: imgN, t });
    return t;
  }
  const estimateItems = items => { let n = 0; for (let i = 0; i < items.length; i++) n += itemTokens(items[i]); return n; };
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
   * 返回各层内容、Token 预算（已乘校准系数）、是否需要生成章节 / 合并章节。
   */
  function plan(state, baseSystem, items, env) {
    const st = normalizeState(state);
    const s = effectiveSettings(st.settings, env), sum = s.summary;
    const k = (env && (env.calibMeta || env.model)) ? calibOf(st, env.calibMeta || { provider: env.provider, model: env.model, modality: env.modality || 'text' }) : (st.calib || 1);
    const cal = n => Math.round(n * k);
    items = applyFrozenLore(st, items);
    const covered = new Set(coveredIds(st));
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
    const raw = {
      static: estimateTokens(staticText(st, baseSystem)), memory: estimateTokens(memoryText(st)), summary: estimateTokens(summaryText(st)),
      history: estimateItems(hist), delta: estimateTokens(deltaText(st)), state: estimateTokens(stateText(st)), input: input ? estimateItems([input]) + 6 : 0,
    };
    const tokens = {}; LAYERS.forEach(x => { tokens[x] = cal(raw[x]); });
    tokens.total = LAYERS.reduce((n, x) => n + tokens[x], 0);
    tokens.raw_total = LAYERS.reduce((n, x) => n + raw[x], 0);
    const limit = Math.max(1000, s.max_context - s.output_reserve - s.safety_margin);
    const overBudget = tokens.total > limit;
    const batch = oldestBatch(unsummarized, sum.keep_recent_turns);
    const batchRounds = roundsOf(batch);
    const rounds = roundsOf(items);
    const sinceLast = st.chapters.length ? rounds - (st.lastSummaryRound | 0) : Infinity;
    const minGap = Math.max(0, sum.min_interval_turns | 0);
    let summaryReason = null, summaryBlocked = null;
    if (sum.enabled && batch.length) {
      if (overBudget) summaryReason = 'budget';
      else if (cal(estimateItems(unsummarized)) >= sum.trigger_tokens && batchRounds >= Math.max(1, sum.min_new_turns | 0)) {
        if (sinceLast < minGap) summaryBlocked = 'interval'; else summaryReason = 'trigger';
      }
    }
    const chapterTokens = tokens.summary;
    const cap = Math.max(1000, sum.chapter_cap_tokens | 0 || DEFAULT_SETTINGS.summary.chapter_cap_tokens);
    const p = { st, system, hist, input, unsummarized, covered, tokens, limit, overBudget, batch, batchRounds, needSummary: !!summaryReason, summaryReason,
      summaryBlocked, sinceLast, minGap, rounds, chapterTokens, cap, needConsolidate: false, calib: k, trimmed: start > 0, dropped: start, settings: s, auto: null };
    // V3：自适应摘要时机（只在宿主提供 env 时启用；不传 env 与 v0.4 完全一致）
    if (env && s.auto_summary !== false && sum.enabled && batch.length && !summaryReason) {
      const a = adaptiveSummary(p, env);
      p.auto = a;
      if (a.reason) { p.summaryReason = a.reason; p.needSummary = true; p.summaryBlocked = null; }
    }
    const cold = !!(env && env.cold);
    // 合并章节：章节合计超上限；V3：缓存已冷（反正要重建）时提前到 60% 上限就合并
    p.needConsolidate = !!p.summaryReason && st.chapters.length > 1 && (chapterTokens >= cap || (cold && s.auto_summary !== false && chapterTokens >= cap * 0.6));
    return p;
  }
  /** V3：自动预算覆盖会话设置（auto_budget 开启且 env.budget 存在时） */
  function effectiveSettings(s, env) {
    if (!env || !env.budget || s.auto_budget === false) return s;
    const b = env.budget, d = DEFAULT_SETTINGS, sum = s.summary || {};
    // 逐项：仍是默认值的字段用推导值；单独改过的字段视为手动覆盖，保留
    const pick = (cur, def, auto) => (cur === def || cur == null ? auto : cur);
    return Object.assign({}, s, { max_context: pick(s.max_context, d.max_context, b.max_context), output_reserve: pick(s.output_reserve, d.output_reserve, b.output_reserve),
      safety_margin: pick(s.safety_margin, d.safety_margin, b.safety_margin),
      summary: Object.assign({}, sum, { trigger_tokens: pick(sum.trigger_tokens, d.summary.trigger_tokens, b.trigger_tokens),
        chapter_cap_tokens: pick(sum.chapter_cap_tokens, d.summary.chapter_cap_tokens, b.chapter_cap_tokens) }) });
  }
  /**
   * V3：自适应摘要。返回 { reason: 'cold'|'adaptive'|null, why, breakEven, unsummarized, trigger }
   *  - cold：距上次请求已超过缓存有效期（缓存大概率已失效），本轮无论如何都要重建 → 提前到阈值 50% 就摘要，重建不额外花钱
   *  - adaptive：未摘要历史 ≥ 阈值 70% 时按成本估算：摘要一次的花费 ÷ 每轮少发送的历史花费（按近期命中率加权）≤ 回本轮数上限 → 现在摘要更省
   */
  function adaptiveSummary(p, env) {
    const s = p.settings, sum = s.summary, k = p.calib || 1;
    const U = Math.round(estimateItems(p.unsummarized) * k), T = sum.trigger_tokens;
    const r = { reason: null, why: '', breakEven: null, unsummarized: U, trigger: T };
    const minRounds = Math.max(3, Math.ceil((sum.min_new_turns | 0) / 3));
    if (U < T * 0.5) { r.why = '未摘要历史不足阈值一半'; return r; }
    if (p.batchRounds < minRounds) { r.why = '可摘要的旧对话不足 ' + minRounds + ' 轮'; return r; }
    if (p.sinceLast < Math.ceil(p.minGap / 2)) { r.why = '距上一章太近'; return r; }
    if (env.cold) { r.reason = 'cold'; r.why = '缓存大概率已过期（空闲 ' + Math.round((env.idleSec || 0) / 60) + ' 分钟），本轮重建不额外花钱'; return r; }
    if (U < T * 0.7) { r.why = '未摘要历史不足阈值 70%'; return r; }
    const c = env.cost || {};
    const pr = c.model ? priceFor(c.model, c.prices) : null;
    if (!pr) { r.why = '没有价格信息，按固定阈值'; return r; }
    const est = summaryCost(p, Object.assign({}, c, { warm: env.warm != null ? env.warm : 1 }));
    const batchTok = Math.round(estimateItems(p.batch) * k);
    // v0.16：无真实命中样本时不做自适应成本决策（禁止默认 80%）
    if (env.hitRate == null || !(env.hitSamples > 0)) { r.why = '尚无真实缓存命中样本，不做自适应摘要成本决策'; return r; }
    const hr = env.hitRate;
    const hitP = env.strategy === 'explicit' && pr.hit_explicit != null ? pr.hit_explicit : pr.hit;
    const perTurn = Math.max(0, batchTok - est.callOut) * (hr * hitP + (1 - hr) * pr.miss) / 1e6 * factorFor(pr, c.at || Date.now(), c.mode, c.peak);
    if (!(perTurn > 0) || est.usd == null) { r.why = '无法估算收益'; return r; }
    r.breakEven = est.usd / perTurn;
    const horizon = env.horizon || 12;
    if (r.breakEven <= horizon) { r.reason = 'adaptive'; r.why = '摘要约 ' + r.breakEven.toFixed(1) + ' 轮回本（≤ ' + horizon + '），命中率 ' + Math.round(hr * 100) + '%（' + env.hitSamples + ' 样本）'; }
    else r.why = '摘要需 ' + r.breakEven.toFixed(1) + ' 轮才回本，暂不摘要';
    return r;
  }
  /** 计算超预算时的裁剪起点（不修改状态） */
  function computeTrimWindow(st, p) {
    const keep = Math.max(1, (st.settings.summary && st.settings.summary.keep_recent_turns) | 0 || 1);
    const k = p.calib || 1;
    const un = p.unsummarized || [];
    const users = []; un.forEach((m, i) => { if (m.role === 'user') users.push(i); });
    const fixed = p.tokens.total - p.tokens.history;
    const S = [0]; for (let i = 0; i < un.length; i++) S.push(S[i] + itemTokens(un[i]));
    const fits = j => fixed + (S[un.length] - S[users[j]]) * k <= p.limit;
    let j = Math.max(0, users.length - keep);
    if (users.length && !fits(j)) { let lo = j, hi = users.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (fits(mid)) hi = mid; else lo = mid + 1; } j = lo; }
    const startIdx = users.length ? users[j] : 0;
    if (!un[startIdx]) return null;
    return { startId: un[startIdx].id, startOrdinal: startIdx, startIdx };
  }
  /**
   * 临时裁剪：只改本轮 plan.hist，不永久推进 st.window。
   * 摘要失败后的超预算必须走这里，避免剧情被静默永久丢掉。
   */
  function temporaryTrimPlan(st, p, opts) {
    opts = opts || {};
    const win = computeTrimWindow(st, p);
    if (!win) return { state: st, plan: p };
    const hist = (p.unsummarized || []).slice(win.startIdx);
    const k = p.calib || 1;
    const histTok = Math.round(estimateItems(hist) * k);
    const tokens = Object.assign({}, p.tokens, { history: histTok, total: p.tokens.total - p.tokens.history + histTok });
    const plan = Object.assign({}, p, { hist, tokens, trimmed: true, tempTrim: true, dropped: win.startIdx, overBudget: tokens.total > p.limit });
    const state = Object.assign({}, st, {
      overflow: {
        tempStartId: win.startId, tempStartOrdinal: win.startOrdinal, permanent: false,
        reason: opts.reason || 'over_budget_temp', last_error: opts.error || null, at: Date.now(),
      },
    });
    return { state, plan, window: win };
  }
  /**
   * fallbackTrim：默认临时（只记 overflow，不推进 window）；opts.permanent=true 才永久覆盖起点。
   */
  function fallbackTrim(st, p, opts) {
    opts = opts || {};
    const win = computeTrimWindow(st, p);
    if (!win) return st;
    if (opts.permanent) {
      return Object.assign({}, st, { window: { startId: win.startId, startOrdinal: win.startOrdinal }, overflow: null });
    }
    return Object.assign({}, st, {
      overflow: {
        tempStartId: win.startId, tempStartOrdinal: win.startOrdinal, permanent: false,
        reason: opts.reason || 'over_budget_temp', last_error: opts.error || null, at: Date.now(),
      },
    });
  }

  /** 组装最终消息：L4 原样追加，L6 + 增量 + L5 合并为最后一条用户消息 */
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

  // ---------------- 服务商适用性（V2） ----------------
  /** 默认适用（auto）：DeepSeek（预设 / 接口地址 / 模型名）与千问（DashScope 接口 / 模型名含 qwen、qwq） */
  function isApplicable(provider, model) { return capability(provider, model).auto; }

  // ---------------- V3：服务商缓存能力 / 上下文窗口 / 自动预算 ----------------
  // 千问显式缓存支持的模型（help.aliyun.com/zh/model-studio/explicit-cache-guide，2026-10）；其余千问模型走隐式缓存
  const QWEN_EXPLICIT = /^(qwen3\.[78]-max|qwen3\.[567]-plus|qwen3\.[5-8]-flash|qwen3\.8-(2\.4t|27b)|qwen-plus|qwen-flash|qwen3-coder-flash|qwen3-vl-plus)/;
  const isDashscope = p => !!p && (p.presetId === 'qwen' || p.presetId === 'qwen-intl' || /dashscope|\.maas\.aliyuncs\.com/i.test(String(p.baseUrl || '')));
  /**
   * { vendor, kind: 'implicit'|'explicit'|'none', auto（默认启用）, ttl（秒，缓存大致有效期）, explicit: {maxMarkers, minTokens} | null, label }
   */
  function capability(provider, model) {
    const p = provider || {}, base = String(p.baseUrl || '').toLowerCase();
    const m = String(model || '').toLowerCase(), bare = m.replace(/^.*\//, '');
    if (p.presetId === 'deepseek' || /deepseek/.test(base) || /deepseek/.test(m))
      return { vendor: 'deepseek', kind: 'implicit', auto: true, ttl: 3 * 3600, explicit: null, label: 'DeepSeek 自动前缀缓存（硬盘缓存，通常数小时）' };
    if (isDashscope(p) || /qwen|qwq/.test(m)) {
      if (isDashscope(p) && QWEN_EXPLICIT.test(bare) && !/flash-character/.test(bare))
        return { vendor: 'qwen', kind: 'explicit', auto: true, ttl: 300, explicit: { maxMarkers: 4, minTokens: 1024, lookback: 20 },
          label: '千问显式缓存（cache_control，5 分钟有效，命中时重置）+ 隐式缓存' };
      return { vendor: 'qwen', kind: 'implicit', auto: true, ttl: 600, explicit: null, label: '千问隐式缓存（自动，命中按输入价 20%）' };
    }
    if (p.type === 'anthropic' || /claude/.test(m)) return { vendor: 'anthropic', kind: 'explicit', auto: false, ttl: 300, explicit: { maxMarkers: 4, minTokens: 1024 }, label: 'Claude cache_control（需手动启用）' };
    if (p.type === 'gemini' || /gemini/.test(m)) return { vendor: 'gemini', kind: 'implicit', auto: false, ttl: 300, explicit: null, label: 'Gemini 隐式缓存（需手动启用）' };
    if (p.presetId === 'openai' || /api\.openai\.com/.test(base) || /^(gpt-|o\d)/.test(bare)) return { vendor: 'openai', kind: 'implicit', auto: false, ttl: 600, explicit: null, label: 'OpenAI 自动前缀缓存（需手动启用）' };
    return { vendor: 'other', kind: 'none', auto: false, ttl: 0, explicit: null, label: '未知 / 无上下文缓存（不改写请求）' };
  }
  // 内置上下文窗口表（模型列表接口返回 context_length 等时优先使用）；tier = 价格第一档上限（超过后单价上调）
  const CONTEXT_TABLE = [
    [/deepseek/, 128000],
    [/qwen3\.7-flash/, 1000000, 32000], [/qwen3-coder-flash/, 1000000, 32000], [/qwen3-vl-plus/, 256000, 32000],
    [/qwen3\.7-plus/, 1000000, 256000], [/qwen3\.6-(plus|flash)/, 1000000, 256000],
    [/qwen3\.5-(plus|flash)|qwen-plus-character|qwen-flash-character/, 0],
    [/character/, 32000],
    [/qwen3\.5-(plus|flash)/, 1000000, 128000], [/qwen-plus|qwen-flash|qwen-turbo/, 1000000, 128000],
    [/qwen3\.8-flash/, 1000000],
    [/qwen3\.[78]-max/, 256000], [/qwen-max/, 32000], [/qwen-long/, 10000000], [/qwq|qwen/, 128000],
    [/claude/, 200000], [/gemini/, 1000000], [/gpt-|^o\d/, 400000],
  ];
  function contextInfo(model, meta) {
    const m = String(model || '').toLowerCase().replace(/^.*\//, '');
    let window = 0, tier = 0, source = 'default';
    for (const row of CONTEXT_TABLE) {
      if (!row[0].test(m)) continue;
      if (row[1] === 0) { if (/character/.test(m)) { window = 32000; } else continue; } else { window = row[1]; tier = row[2] || 0; }
      source = 'table'; break;
    }
    if (meta && meta.context > 0) { window = meta.context; source = 'meta'; }
    if (!window) window = 64000;
    return { window, tier, source };
  }
  const round1k = n => Math.max(1000, Math.round(n / 1000) * 1000);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  /**
   * 按上下文窗口推导预算：上限 = min(窗口, 价格第一档, 200K) × 0.8；输出预留 10%（4K–16K）；余量 2%（1K–4K）；
   * 摘要阈值 30%；章节合计上限 12%（4K–24K）。DeepSeek 保持 v0.4 默认值不变（100K / 12K / 2K / 30K / 12K）。
   */
  function autoBudget(cap, model, meta) {
    const d = DEFAULT_SETTINGS;
    const ci = contextInfo(model, meta);
    if (cap && cap.vendor === 'deepseek' && ci.source !== 'meta')
      return { max_context: d.max_context, output_reserve: d.output_reserve, safety_margin: d.safety_margin, trigger_tokens: d.summary.trigger_tokens, chapter_cap_tokens: d.summary.chapter_cap_tokens, window: ci.window, tier: 0, source: 'deepseek-default' };
    const usable = Math.min(ci.window, ci.tier || Infinity, 200000);
    const max = round1k(Math.max(8000, usable * 0.8));
    return { max_context: max, output_reserve: round1k(clamp(max * 0.1, 4000, 16000)), safety_margin: Math.round(clamp(max * 0.02, 1000, 4000)),
      trigger_tokens: round1k(max * 0.3), chapter_cap_tokens: round1k(clamp(max * 0.12, 4000, 24000)), window: ci.window, tier: ci.tier, source: ci.source };
  }
  /** 选择缓存策略：explicit（显式断点）/ implicit（自动前缀）/ none */
  function chooseStrategy(cap, mode, gapMedianSec) {
    if (!cap || cap.kind === 'none') return { strategy: 'none', why: '服务商没有可用的上下文缓存' };
    if (cap.kind !== 'explicit' || cap.vendor !== 'qwen') return { strategy: cap.kind === 'explicit' ? 'explicit' : 'implicit', why: cap.label };
    if (mode === 'implicit') return { strategy: 'implicit', why: '手动选择隐式缓存' };
    if (mode === 'explicit') return { strategy: 'explicit', why: '手动选择显式缓存' };
    // 显式缓存 5 分钟有效：平均间隔太长时每轮都要按 125% 重新创建，不如隐式缓存
    if (gapMedianSec != null && gapMedianSec > 240) return { strategy: 'implicit', why: '最近请求间隔中位数 ' + Math.round(gapMedianSec / 60) + ' 分钟 > 4 分钟，显式缓存容易过期，改用隐式缓存' };
    return { strategy: 'explicit', why: '连续对话（间隔 ≤ 4 分钟）：显式缓存命中按 10% 计费，比隐式缓存（20%）更省且确定命中' };
  }
  /** 从日志推导运行时信息：近期命中率、空闲时长、请求间隔中位数 */
  function runtimeEnv(logs, now, cap) {
    const all = logs || []; const sup = all.filter(e => e.supported);
    const recent = sup.slice(-5);
    const hitRate = recent.length ? recent.reduce((n, e) => n + (e.hit_rate || 0), 0) / recent.length : null;
    const hitSamples = recent.length;
    const older = sup.slice(-10, -5);
    const trend = recent.length && older.length ? hitRate - older.reduce((n, e) => n + (e.hit_rate || 0), 0) / older.length : null;
    const last = all[all.length - 1];
    const idleSec = last && last.timestamp ? Math.max(0, (now - last.timestamp) / 1000) : null;
    const ts = all.slice(-11).map(e => e.timestamp).filter(Boolean);
    const gaps = []; for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 1000);
    gaps.sort((a, b) => a - b);
    const gapMedian = gaps.length >= 3 ? gaps[Math.floor(gaps.length / 2)] : null;
    const ttl = cap && cap.ttl || 0;
    const cold = !!(ttl && idleSec != null && idleSec > ttl);
    return { hitRate, hitSamples, trend, idleSec, gapMedian, cold, warm: cold ? 0 : 1 };
  }

  // ---------------- 指纹与诊断 ----------------
  // v0.8.9（P2）：历史指纹增量化。每条消息 digest（cyrb53）按 id 缓存；history_hash = 滚动前缀哈希 prefix[n]。
  // 只有需要跨会话比较的层指纹（static / memory / summary / 章节…）保留 SHA-256。新格式以 'c:' 开头，旧日志（64 位十六进制）按旧算法比较。
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed | 0), h2 = 0x41c6ce57 ^ (seed | 0);
    for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }
  const digestCache = new Map();
  function digestOf(m) {
    const imgs = m.images ? imgSig(m.images).join('|') : '';
    const hit = m.id != null ? digestCache.get(m.id) : null;
    if (hit && hit.c === m.content && hit.r === m.role && hit.g === imgs) return hit.d;
    const d = cyrb53(m.role + '\u0001' + String(m.content || '') + '\u0002' + imgs);
    if (m.id != null) { if (digestCache.size > 20000) digestCache.clear(); digestCache.set(m.id, { c: m.content, r: m.role, g: imgs, d }); }
    return d;
  }
  /** 滚动前缀哈希：out[i] = 前 i 条历史的指纹（out[0] 为空历史） */
  function historyPrefixes(hist) {
    const out = ['c:' + cyrb53('')];
    for (let i = 0; i < hist.length; i++) out.push('c:' + cyrb53(out[i] + ':' + digestOf(hist[i])));
    return out;
  }
  const isLegacyHash = h => typeof h === 'string' && h.length === 64 && h.indexOf(':') < 0;
  function fingerprints(p, baseSystem) {
    const pre = historyPrefixes(p.hist), hh = pre[pre.length - 1];
    const act = activeSummary(p.st);
    return {
      static_hash: sha256(staticText(p.st, baseSystem)), memory_hash: sha256(memoryText(p.st)), summary_hash: sha256(summaryText(p.st)),
      history_hash: hh, delta_hash: sha256(deltaText(p.st)), state_hash: sha256(stateText(p.st)), input_hash: sha256(p.input ? JSON.stringify([p.input.content || '', imgSig(p.input.images)]) : ''),
      full_prefix_hash: 'c:' + cyrb53(cyrb53(p.system) + '\u0000' + hh), history_count: p.hist.length,
      chapters: chaptersOf(p.st).map(c => c.no + ':' + c.hash.slice(0, 12)),
      versions: { static: p.st.staticVersion | 0, memory: getBlock(p.st, 'memory').version, summary: act ? act.no : 0, delta: getBlock(p.st, 'delta').version, state: getBlock(p.st, 'state').version },
    };
  }
  /** 各层与上一次请求相比：SAME / APPEND（仅 history）/ CHANGED；首次为 NEW */
  function diagnose(prev, fp, hist) {
    const out = {};
    if (!prev || !prev.static_hash) { LAYERS.forEach(k => { out[k] = 'NEW'; }); return out; }
    ['static', 'memory', 'summary', 'delta', 'state', 'input'].forEach(k => {
      const a = prev[k + '_hash'], b = fp[k + '_hash'];
      out[k] = a === b || (a === undefined && k === 'delta' && b === sha256('')) ? 'SAME' : 'CHANGED';
    });
    // V2：章节只追加 → 之前的章节全部不变时为 APPEND
    if (out.summary === 'CHANGED' && Array.isArray(prev.chapters) && Array.isArray(fp.chapters) && prev.chapters.length && fp.chapters.length > prev.chapters.length &&
      prev.chapters.every((c, i) => fp.chapters[i] === c)) out.summary = 'APPEND';
    if (prev.history_hash === fp.history_hash) out.history = 'SAME';
    else if (fp.history_count > (prev.history_count | 0) && (isLegacyHash(prev.history_hash)
      ? sha256(serializeHistory(hist, prev.history_count | 0)) === prev.history_hash
      : historyPrefixes((hist || []).slice(0, prev.history_count | 0)).pop() === prev.history_hash)) out.history = 'APPEND';
    else out.history = 'CHANGED';
    return out;
  }
  /** 用大白话解释本次命中情况（第 39 节） */
  function reasons(entry, prev) {
    const d = entry.diag || {}; const out = [];
    if (!prev) return ['首次请求，缓存尚未建立'];
    if (entry.summary_happened) out.push(entry.summary_merged ? '章节总量超过上限，已合并为 ' + slabel(entry.summary_no) + '，章节及之后的缓存重建一次'
      : ({ budget: '超出预算，追加了章节 ', cold: '缓存已过期（空闲较久），趁重建顺便追加了章节 ', adaptive: '按成本估算提前摘要（几轮即可回本），追加了章节 ' }[entry.summary_reason] || '历史达到摘要阈值，追加了章节 ') + slabel(entry.summary_no) + '：之前的章节保持命中，从新章节处重新建立');
    if (d.static === 'CHANGED') out.push(STATIC_CAUSE(entry.static_cause) || '角色卡 / 世界观等永久锚点被修改');
    if (entry.lore_edited_frozen || entry.loreEditedButFrozen) out.push('世界书已修改但历史中仍保留旧的冻结片段（loreEditedButFrozen）；可开启「修改设定后立即重建上下文」或手动重建');
    if (d.memory === 'CHANGED') out.push('长期记忆已更新（建议改用「记忆增量」，不破坏前缀）');
    if (d.summary === 'CHANGED' && !entry.summary_happened) out.push('章节摘要刚更新（编辑、撤销或合并）');
    if (d.summary === 'APPEND' && !entry.summary_happened) out.push('手动追加了新章节，之前的章节保持命中');
    if (d.history === 'CHANGED' && !entry.summary_happened) out.push(entry.trimmed ? '超出预算，较早历史被一次性截断' : HISTORY_CAUSE(entry.history_cause) || '历史被修改（编辑、删除或重新生成了较早的消息）');
    const ai = entry.auto_info || {};
    if (prev && entry.cache_mode === 'explicit' && entry.timestamp - prev.timestamp > 300e3 && entry.timestamp - prev.timestamp <= 3 * 3600e3)
      out.push('距上次请求超过 5 分钟，千问显式缓存已过期，本轮重新创建');
    else if (prev && ai.vendor === 'qwen' && entry.timestamp - prev.timestamp > 600e3 && entry.timestamp - prev.timestamp <= 3 * 3600e3)
      out.push('距上次请求超过 10 分钟，千问隐式缓存可能已清除');
    if (prev && entry.timestamp - prev.timestamp > 3 * 3600e3) out.push('距上次请求超过 ' + Math.floor((entry.timestamp - prev.timestamp) / 3600e3) + ' 小时，服务端缓存可能已清除');
    if (prev && prev.model !== entry.model) out.push('切换了模型（缓存按模型分开）');
    if (!out.length) {
      if (entry.supported && entry.hit_rate != null && entry.hit_rate < 0.3) out.push('前缀未变，但服务端没有命中（缓存尚未建立或已过期；DeepSeek / 千问隐式缓存为尽力而为）');
      else out.push('正常动态更新');
    }
    return out;
  }

  // ---------------- 章节摘要提示词（第 10 节：知识边界） ----------------
  const SUMMARY_SECTIONS = ['FACTS', 'CHARACTER_KNOWLEDGE', 'PLAYER_KNOWLEDGE', 'SECRET', 'UNRESOLVED', 'RELATIONSHIPS', 'OBJECTS', 'LOCATION'];
  const FORMAT_RULES = '严格按以下格式输出，标题保持英文原样，每项用「- 」开头；某项没有内容写「- 无」：\n\n' +
    'FACTS:\n- 已确认的事实\n\nCHARACTER_KNOWLEDGE:\n- 角色名：该角色知道什么（每个重要角色一行）\n\nPLAYER_KNOWLEDGE:\n- 玩家知道什么\n\n' +
    'SECRET:\n- 尚未公开的秘密（注明对谁保密）\n\nUNRESOLVED:\n- 未解决事件\n\nRELATIONSHIPS:\n- 人物关系\n\nOBJECTS:\n- 关键物品及归属\n\nLOCATION:\n- 地点状态\n\n' +
    '只输出摘要正文，不要任何解释。\n\n';
  const transcriptOf = batch => (batch || []).map(m => (m.role === 'user' ? '【玩家】' : '【角色】') + String(m.content || '').trim()).join('\n\n');
  /**
   * V2 新章节提示词：只总结「本批新移出的旧对话」，前面的章节只读参考、不复述（它们会原样保留并继续发送）。
   * 兼容 V1 调用：传 prevSummary 时作为只读参考。
   */
  function buildSummaryPrompt(o) {
    const prev = o.chapters && o.chapters.length ? o.chapters.map(c => '[' + slabel(c.no) + ']\n' + c.content).join('\n\n') : (o.prevSummary || '');
    return '你是长篇角色扮演（RP）的「章节摘要记录员」。请把「本批旧对话」写成新的一章摘要。之前的章节会原样保留并继续提供给模型，新章节将接在它们之后。\n\n' +
      '硬性要求：\n' +
      '1. 只记录本批对话里真实发生、已经确认的内容，不要编造、不要推测剧情走向、不要改写人设。\n' +
      '2. 必须区分「知识边界」：每个角色只知道自己亲眼所见或被告知的事；玩家知道的不等于 NPC 知道的。\n' +
      '3. 之前章节已经写过的内容不要重复；只有被新剧情改变时才写出新的状态（例如「关系：A 与 B 由敌对转为合作」）。\n' +
      '4. 不要写“他们聊了很多”这类空泛总结，写具体的人、事、物、地点、数字。\n' +
      '5. ' + FORMAT_RULES +
      (o.memory ? '===== 长期记忆（只读参考，不要复述） =====\n' + o.memory + '\n\n' : '') +
      '===== 之前的章节（只读参考，不要复述） =====\n' + (prev || '（无）') + '\n\n' +
      '===== 本批旧对话（按原顺序） =====\n' + transcriptOf(o.batch);
  }
  /** 合并提示词：把全部章节（+ 可选的本批旧对话）压缩成一章，用于章节总量超过上限时 */
  function buildConsolidatePrompt(o) {
    const prev = (o.chapters || []).map(c => '[' + slabel(c.no) + ']\n' + c.content).join('\n\n');
    return '你是长篇角色扮演（RP）的「章节摘要记录员」。之前的章节摘要太长了，请把它们' + (o.batch && o.batch.length ? '和「本批旧对话」' : '') +
      '合并压缩成一份完整的章节摘要（它将替代全部旧章节）。\n\n' +
      '硬性要求：\n1. 完整保留仍然有效的事实、知识边界、秘密、未解决线索和关键物品；删除已被后续剧情推翻或已经无关紧要的细节。\n' +
      '2. 区分「知识边界」：每个角色只知道自己亲眼所见或被告知的事。\n3. 不要编造，不要推测。\n' +
      '4. ' + FORMAT_RULES +
      (o.memory ? '===== 长期记忆（只读参考，不要复述） =====\n' + o.memory + '\n\n' : '') +
      '===== 需要合并的章节（按顺序） =====\n' + (prev || '（无）') +
      (o.batch && o.batch.length ? '\n\n===== 本批旧对话（按原顺序） =====\n' + transcriptOf(o.batch) : '');
  }
  /** 关键知识分区：缺任一项则拒提交（勿静默丢剧情边界） */
  const CRITICAL_SUMMARY = ['FACTS', 'CHARACTER_KNOWLEDGE', 'PLAYER_KNOWLEDGE', 'SECRET', 'UNRESOLVED'];
  /** 统一质量门槛（CHANGELOG / parseSummary / commitChapter 一致）；空分区写「无」不得凑分 */
  const SUMMARY_MIN_QUALITY = 0.60;
  function sectionBody(text, key) {
    const re = new RegExp('(?:^|\\n)\\s*[#*]*\\s*' + key + '\\s*:?\\s*\\n([\\s\\S]*?)(?=(?:\\n\\s*[#*]*\\s*(?:' + SUMMARY_SECTIONS.join('|') + ')\\b)|$)', 'i');
    const m = re.exec(text || '');
    return m ? m[1].trim() : '';
  }
  function isEmptySectionBody(body) {
    const b = String(body || '').trim();
    if (!b) return true;
    const lines = b.split(/\n/).map(x => x.trim()).filter(Boolean);
    if (!lines.length) return true;
    // 整区只有「无 / none / n/a」视为空，不得凑分
    return lines.every(l => /^[-–—*•]?\s*(无|none|n\/?a|nil|空)\s*$/i.test(l));
  }
  function scoreSummary(text) {
    let score = 0, filled = 0, critFilled = 0;
    SUMMARY_SECTIONS.forEach(k => {
      const body = sectionBody(text, k);
      if (!body || isEmptySectionBody(body)) return; // 空分区（含「无」）得 0 分
      filled++;
      const crit = CRITICAL_SUMMARY.indexOf(k) >= 0;
      if (crit) critFilled++;
      score += crit ? 0.14 : 0.06;
    });
    // 五个关键分区全空：直接 0（即使 soft 有内容也不允许靠「无」过门）
    if (!critFilled) return 0;
    return Math.max(0, Math.min(1, Math.round((score + Math.min(0.2, filled * 0.02)) * 100) / 100));
  }
  function parseSummary(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    t = t.replace(/^\[?CHAPTER[ _]SUMMARY[^\n]*\]?\s*\n/i, '');
    t = canonicalize(t);
    // 八分区必须完整
    const missing = SUMMARY_SECTIONS.filter(k => !new RegExp('(^|\\n)\\s*[#*]*\\s*' + k + '\\b', 'i').test(t));
    const critMissing = CRITICAL_SUMMARY.filter(k => missing.indexOf(k) >= 0);
    const quality = scoreSummary(t);
    const critEmpty = CRITICAL_SUMMARY.filter(k => isEmptySectionBody(sectionBody(t, k)));
    // 缺任一分区、质量不达标、或五个关键分区全空 → 拒
    const ok = !!t && !missing.length && quality >= SUMMARY_MIN_QUALITY && critEmpty.length < CRITICAL_SUMMARY.length;
    return { ok, text: t, missing, critMissing, critEmpty, quality, minQuality: SUMMARY_MIN_QUALITY };
  }
  function priceFor(model, prices) {
    return priceForRules(model, prices) || (model ? priceForRules(model, BUILTIN_PRICES, true) : null);
  }
  function priceForRules(model, prices, builtinOnly) {
    prices = prices || DEFAULT_PRICES; const m = String(model || '').toLowerCase();
    if (builtinOnly) { let b = null, bl = -1; Object.keys(prices).forEach(n => String(prices[n].match).split(',').forEach(k => { if (k && m.includes(k) && k.length > bl) { b = prices[n]; bl = k.length; } })); return b; }
    let best = null, bestLen = -1;
    Object.keys(prices).forEach(name => {
      const p = prices[name]; if (!p) return;
      const keys = String(p.match != null ? p.match : name).toLowerCase().split(/[,，\s]+/).filter(Boolean);
      keys.forEach(k => { if (m.includes(k) && k.length > bestLen) { best = p; bestLen = k.length; } });
    });
    if (best) return best;
    // 旧配置（没有 match 字段）：沿用 V1 规则
    if (!m.includes('deepseek')) return null;
    return m.includes('pro') ? prices['deepseek-v4-pro'] || null : prices['deepseek-flash'] || null;
  }
  function parseWindows(str) {
    return String(str || '').split(/[,，;\s]+/).map(x => x.match(/^(\d{1,2}):?(\d{2})?-(\d{1,2}):?(\d{2})?$/)).filter(Boolean)
      .map(r => [(+r[1]) * 60 + (+(r[2] || 0)), (+r[3]) * 60 + (+(r[4] || 0))]).filter(w => w[0] >= 0 && w[1] <= 1440 && w[0] < w[1]);
  }
  /** 高峰：默认周一至周五北京时间 9:00–12:00、14:00–18:00（可配置：时段、时区偏移、是否仅工作日） */
  function isPeak(at, peak) {
    const pk = Object.assign({}, DEFAULT_PEAK, peak || {});
    const d = new Date(at + (Number(pk.tz) || 0) * 3600e3);
    const day = d.getUTCDay(); const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (pk.weekdays && (day === 0 || day === 6)) return false;
    return parseWindows(pk.windows).some(w => mins >= w[0] && mins < w[1]);
  }
  function peakFactor(at, mode, peak) {
    const off = Object.assign({}, DEFAULT_PEAK, peak || {}).off_factor;
    const f = Number(off); const offF = isNaN(f) ? 0.5 : f;
    return mode === 'peak' ? 1 : mode === 'offpeak' ? offF : (isPeak(at, peak) ? 1 : offF);
  }
  /** 价格规则 peak:false（如千问）不分高峰 / 非高峰 */
  const factorFor = (p, at, mode, peak) => (p && p.peak === false ? 1 : peakFactor(at, mode, peak));
  function costOf(e, prices, mode, peak) {
    const p = priceFor(e.model, prices);
    if (!p || !e.supported) return null;
    const f = factorFor(p, e.timestamp, mode, peak);
    const hitP = e.cache_mode === 'explicit' && p.hit_explicit != null ? p.hit_explicit : p.hit;
    const write = (e.cache_write_tokens || 0) * Math.max(0, (p.write != null ? p.write : p.miss) - p.miss); // 显式缓存创建的溢价
    const actual = (e.cache_hit_tokens * hitP + e.cache_miss_tokens * p.miss + write + (e.completion_tokens || 0) * p.out) / 1e6 * f;
    const noCache = (e.prompt_tokens * p.miss + (e.completion_tokens || 0) * p.out) / 1e6 * f;
    return { actual, noCache, saved: noCache - actual };
  }
  /**
   * V2：估算一次自动摘要 / 合并的额外开销（本地估算）。
   * call：摘要调用本身（输入全部未命中 + 输出）；rebuild：本轮因前缀变化额外未命中的 Token（新章节 + 剩余历史，合并时还包括全部章节）。
   */
  function summaryCost(p, o) {
    o = o || {};
    const k = p.calib || 1;
    const batchTok = Math.round(estimateItems(p.batch || []) * k);
    const out = Math.max(300, Math.min(2000, Math.round(batchTok * 0.15)));
    const merge = !!(o.merge != null ? o.merge : p.needConsolidate);
    const memTok = p.tokens ? p.tokens.memory : 0;
    const callIn = batchTok + memTok + (p.chapterTokens || 0) + 700;
    const remain = Math.max(0, (p.tokens ? p.tokens.history : 0) - batchTok);
    const rebuild = out + remain;
    const r = { merge, callIn, callOut: out, rebuild, chapterTokens: p.chapterTokens || 0, usd: null };
    const pr = o.model ? priceFor(o.model, o.prices) : null;
    if (pr) {
      const f = factorFor(pr, o.at || Date.now(), o.mode, o.peak);
      const missOverHit = Math.max(0, pr.miss - pr.hit) * (o.warm != null ? o.warm : 1); // V3：缓存已冷时重建不额外花钱
      // 合并：新章节之后的全部内容都要重建，且原来命中的章节变成未命中
      const rebuildCost = (rebuild + (merge ? p.chapterTokens || 0 : 0)) * missOverHit;
      r.usd = (callIn * pr.miss + out * pr.out + rebuildCost) / 1e6 * f;
    }
    return r;
  }
  /** V2：把记忆增量合并进长期记忆的一次性代价：L2 之后的章节 + 历史全部重建 */
  function mergeDeltaCost(p, o) {
    o = o || {};
    const rebuild = (p.tokens.summary || 0) + (p.tokens.history || 0);
    const r = { rebuild, usd: null };
    const pr = o.model ? priceFor(o.model, o.prices) : null;
    if (pr) r.usd = rebuild * Math.max(0, pr.miss - pr.hit) / 1e6 * factorFor(pr, o.at || Date.now(), o.mode, o.peak);
    return r;
  }
  /** 合并记忆增量：追加到长期记忆末尾（L2 版本 +1），清空增量 */
  function mergeDelta(st, at) {
    const delta = getBlock(st, 'delta').content; if (!delta) return { state: st, changed: false };
    const mem = getBlock(st, 'memory').content;
    let r = setBlock(st, 'memory', mem ? mem + '\n' + delta : delta, at);
    r = setBlock(r.state, 'delta', '', at);
    return { state: r.state, changed: true };
  }

  // ---------------- 指标日志（第 20 节；默认不保存完整 Prompt） ----------------
  function makeLogEntry(o) {
    const u = o.usage || {};
    const supported = !!u.cacheSupported && (u.prompt || 0) > 0;
    const fp = o.fp || {};
    const e = {
      request_id: o.request_id || '', timestamp: o.at || 0, model: o.model || '', provider: o.provider || '', supported,
      prompt_tokens: u.prompt || 0, est_tokens: (o.tokens && o.tokens.raw_total) || 0, cache_hit_tokens: supported ? u.hit || 0 : 0, cache_miss_tokens: supported ? u.miss || 0 : 0, completion_tokens: u.completion || 0,
      cache_write_tokens: supported ? u.cacheWrite || 0 : 0, cache_mode: o.cacheMode || null, auto_info: o.autoInfo || null,
      hit_rate: supported ? (u.hit || 0) / ((u.hit || 0) + (u.miss || 0) || u.prompt) : null,
      static_hash: fp.static_hash, memory_hash: fp.memory_hash, summary_hash: fp.summary_hash, history_hash: fp.history_hash, delta_hash: fp.delta_hash, state_hash: fp.state_hash,
      chapters: fp.chapters || [], summary_merged: !!o.summaryMerged, summary_cost: o.summaryCost || null,
      input_hash: fp.input_hash, full_prefix_hash: fp.full_prefix_hash, history_count: fp.history_count | 0, versions: fp.versions || {},
      layer_tokens: o.tokens || {}, diag: o.diag || {}, summary_happened: !!o.summaryNo, summary_no: o.summaryNo || 0, summary_reason: o.summaryReason || null,
      summary_error: o.summaryError || null, static_cause: o.staticCause || null, history_cause: o.historyCause || null, over_budget: !!o.overBudget, trimmed: !!o.trimmed, msg_id: o.msgId || '',
      loreEditedButFrozen: !!(o.loreEditedButFrozen || (o.state && o.state.loreEditedWhileFrozen)),
    };
    e.reasons = reasons(e, o.prev || null);
    e.reason = e.reasons[0];
    if (o.savePrompt && o.prompt) e.prompt = o.prompt; // 调试：仅在用户开启 save_prompt 时保存
    return e;
  }
  const PROMPT_KEEP = 20; // v0.7.5：完整 prompt（调试用，体积大）只保留最近 20 条
  function appendLog(logs, e) {
    const out = (logs || []).concat([e]); while (out.length > LOG_LIMIT) out.shift();
    let kept = 0;
    for (let i = out.length - 1; i >= 0; i--) if (out[i] && out[i].prompt) { if (++kept > PROMPT_KEEP) { out[i] = Object.assign({}, out[i]); delete out[i].prompt; } }
    return out;
  }
  const sameDay = (a, b) => { const x = new Date(a), y = new Date(b); return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
  function stats(logs, prices, mode, now, peak) {
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
    sup.forEach(e => { const c = costOf(e, prices, mode, peak); if (c) { saved += c.saved; actual += c.actual; priced++; } });
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
      const map = { static: '固定设定指纹变化：角色卡 / 世界观等永久设定被修改', memory: '长期记忆指纹变化：长期记忆被更新',
        summary: '章节摘要指纹变化：章节被编辑 / 撤销 / 合并，导致稳定前缀发生变化', history: '对话历史指纹变化：较早的历史被编辑、删除、截断或摘要',
        delta: '记忆增量变化：位于末尾，正常情况下只影响最后一小段',
        state: '当前状态指纹变化：当前状态位于末尾，正常情况下只影响最后一小段' };
      res.causes = res.changed.filter(k => k !== 'state' && k !== 'delta').map(k => map[k]);
      (cur.reasons || []).forEach(r => { if (r !== '正常动态更新' && !res.causes.some(c => c.indexOf(r) >= 0)) res.causes.push(r); });
      if (!res.causes.length) res.causes.push('本地上下文没有变化：可能是服务端缓存过期或尚未建立（DeepSeek 缓存为尽力而为，通常数小时到数天清除）');
    }
    return res;
  }

  // ---------------- v0.7.4：首条消息自动提取设定 ----------------
  /** 可自动填充的块（L1 固定设定 + 长期记忆 + 当前状态）；只填空白块，绝不覆盖已有内容 */
  const EXTRACT_FIELDS = ['world', 'character', 'rules', 'format', 'style', 'prohibit', 'memory', 'state'];
  function buildExtractPrompt(text) {
    return '下面是用户在一段角色扮演 / 故事对话中发送的第一条消息，通常包含角色背景、人物设定、世界观或故事背景。\n' +
      '请从中提取设定信息，只输出一个 JSON 对象（不要代码块、不要解释），字段如下，原文没有提到的字段输出空字符串，不要编造：\n' +
      '{\n  "world": "世界观：时代、地点、势力、魔法/科技规则、故事背景",\n  "character": "角色卡：姓名年龄性别、外貌（身高体型五官发色衣着标志）、身份地位、性格优缺点习惯情绪、说话方式口头禅、背景经历、人物关系、喜好禁忌秘密、与用户关系定位",\n' +
      '  "rules": "RP 规则：用户明确提出的扮演规则（如不替玩家行动）",\n  "format": "输出格式：人称、动作描写、对白标点；篇幅随剧情自然决定，不要刻意控制字数",\n' +
      '  "style": "写作风格：文风、语气、节奏",\n  "prohibit": "禁止事项",\n  "memory": "已确定的重要事实 / 前情（非长期设定的剧情事实）",\n' +
      '  "state": "当前状态：开场时间、地点、场景、数值等"\n}\n' +
      '要求：用简洁的中文条目（可用「- 」分行），尽量保留原文中的专有名词与关键细节；不要把用户本轮的行动或提问写进设定。\n\n=== 用户的第一条消息 ===\n' + String(text || '').slice(0, 12000);
  }
  /** 解析模型返回的 JSON（容忍代码块、前后多余文字）；失败返回 null */
  // ---------------- v0.7.6：分层设定模板 ----------------
  /** 各 L1 块的填写骨架（编辑页「从模板填充」） */
  const BLOCK_TEMPLATES = {
    world: '- 时代 / 地点：\n- 主要势力与关系：\n- 世界规则（魔法 / 科技 / 社会制度）：\n- 基调与氛围：\n- 重要地点：',
    character: '- 姓名：\n- 年龄 / 性别：\n- 外貌 · 身高体型：\n- 外貌 · 五官与发色：\n- 外貌 · 衣着风格：\n- 外貌 · 标志性特征：\n- 身份与社会地位：\n- 背景经历（出身、关键转折、重要过往）：\n- 性格优点：\n- 性格缺点 / 软肋：\n- 习惯与日常小癖好：\n- 情绪反应：\n- 说话方式 / 语气 / 口头禅：\n- 喜好：\n- 禁忌 / 雷区：\n- 秘密：\n- 人物关系（重要 NPC）：\n- 与用户的关系定位：\n- 目标与动机：',
    rules: '- 始终以角色的视角和口吻回应，不跳出角色，不提及自己是 AI。\n- 只描写角色和 NPC 的言行，不替用户决定行动、台词或内心想法。\n- 角色只知道自己应该知道的信息；保持前后设定一致。\n- 主动推动剧情，给出细节与新的变化，避免重复句式。',
    format: '- 动作、神态与环境用 *斜体*，台词用「」。\n- 篇幅根据剧情需要自然决定长度，不要刻意控制字数。\n- 第三人称 / 第一人称：\n- 结尾停在需要用户做出反应的时刻。',
    fewshot: '用户：……\n角色：……\n\n用户：……\n角色：……\n\n用户：……\n角色：……',
    prohibit: '- 不输出「（扮演开始）」「旁白：」等元信息。\n- 不总结剧情、不询问「接下来要做什么」。\n- 角色绝不会做 / 说的事：\n- ',
    style: '- 文风：\n- 节奏：\n- 描写侧重（动作 / 心理 / 环境 / 对白）：\n- 参考作品或作者：',
  };
  const SECTION_ALIASES = { world: /^(世界观|世界背景|背景设定|世界设定)$/, character: /^(角色卡|角色设定|人物设定|角色)$/, rules: /^(RP ?规则|规则|扮演规则)$/i,
    format: /^(输出格式|回复格式|格式)$/, fewshot: /^(示例对白|示例对话|对白示例)$/, prohibit: /^(禁止事项|禁止)$/, style: /^(写作风格|文风|风格)$/, opening: /^(开场白|开场|开场旁白)$/ };
  const SECTION_SKIP = /^(精修说明|说明|备注)$/; // 不会导入分层设定
  /** 解析「【世界观】……【角色卡】……」分段文本 → { world, character, …, opening? }；少于 2 个可导入块返回 null */
  function parseSections(text) {
    const out = {}; let cur = null, n = 0;
    String(text || '').split('\n').forEach(line => {
      const m = line.match(/^\s*(?:#+\s*)?(?:\*\*)?【([^】]{1,12})】(?:\*\*)?\s*(.*)$/) || line.match(/^\s{0,3}#{1,3}\s+([^\n]{1,12})\s*$/);
      if (m) {
        const name = m[1].trim();
        if (SECTION_SKIP.test(name)) { cur = null; return; }
        cur = Object.keys(SECTION_ALIASES).find(k => SECTION_ALIASES[k].test(name)) || null;
        if (cur) { n++; out[cur] = (out[cur] ? out[cur] + '\n' : '') + (m[2] || ''); }
        return;
      }
      if (cur) out[cur] += '\n' + line;
    });
    Object.keys(out).forEach(k => { out[k] = canonicalize(out[k]); if (!out[k]) delete out[k]; });
    const keys = Object.keys(out).filter(k => k !== 'opening');
    return keys.length >= 2 ? out : null;
  }
  /** 从对话消息里找最近一条含可导入分段的助手回复（最多往回看 limit 条） */
  function findSectionMessage(messages, limit) {
    const list = (messages || []).filter(m => m && m.role === 'assistant' && !m.error && m.content);
    for (let i = list.length - 1, seen = 0; i >= 0 && seen < (limit || 8); i--, seen++) {
      const fields = parseSections(list[i].content);
      if (fields) return { msg: list[i], fields };
    }
    return null;
  }
  /** v0.7.5：自动触发门槛——首条消息足够长且像设定（手动提取不受限） */
  const EXTRACT_MIN = 80;
  const EXTRACT_KW = /角色|世界观|你扮演|扮演|设定|人物|背景|人设|身份|性格|规则|character|setting|role ?play|persona|you are/i;
  function shouldAutoExtract(text) { const t = String(text || '').trim(); return t.length >= EXTRACT_MIN && EXTRACT_KW.test(t); }
  function parseExtract(raw) {
    const t = String(raw || '').replace(/```(?:json)?/gi, '');
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) return null;
    let o; try { o = JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    const out = {};
    EXTRACT_FIELDS.forEach(k => {
      let v = o[k];
      if (Array.isArray(v)) v = v.map(x => (typeof x === 'string' ? '- ' + x : JSON.stringify(x))).join('\n');
      else if (v && typeof v === 'object') v = Object.keys(v).map(x => '- ' + x + '：' + (typeof v[x] === 'string' ? v[x] : JSON.stringify(v[x]))).join('\n');
      v = canonicalize(v == null ? '' : String(v));
      if (v && !/^(无|空|没有|未提及|none|null|n\/a)$/i.test(v)) out[k] = v;
    });
    return out;
  }
  /** 只把提取结果写进空白块（用户已填写的块保持不变）；返回写入的块 id */
  function fillEmptyBlocks(st, fields, at, keys) {
    let state = st; const filled = [];
    (keys || EXTRACT_FIELDS).forEach(k => {
      const v = fields && fields[k];
      if (!v || getBlock(state, k).content) return;
      const r = setBlock(state, k, v, at);
      if (r.changed) { state = r.state; filled.push(k); }
    });
    return { state, filled };
  }

  const api = { STATIC_DEFS, BLOCK_DEFS, BLOCK_TITLES, LAYERS, LAYER_TITLES, LAYER_EN, LAYER_CN, DIAG_LABELS, diagLabel, SUMMARY_SECTION_CN, verLabel, DEFAULT_SETTINGS, DEFAULT_PRICES, DEFAULT_PEAK, SUMMARY_SECTIONS, BUILTIN_PRICES, CNY_PER_USD, QWEN_EXPLICIT,
    capability, contextInfo, autoBudget, chooseStrategy, runtimeEnv, adaptiveSummary, effectiveSettings, budgetIsDefault, factorFor,
    canonicalize, sha256, vlabel, slabel, newState, normalizeState, migrateSummaries, getBlock, updateBlock, restoreBlock, setBlock, syncBase, explicitBaseUpdate, markHistoryCause,
    activeSummary, chaptersOf, coveredIds, addChapter, addSummary, commitChapter, chapterSourceFp, CRITICAL_SUMMARY, SUMMARY_MIN_QUALITY, isEmptySectionBody, scoreSummary, consolidate, editChapter, removeLastChapter,
    staticText, memoryText, summaryText, deltaText, stateText, buildSystem, finalUserContent, serializeHistory,
    estimateTokens, estimateItems, itemTokens, cyrb53, historyPrefixes, calibrate, calibKey, calibOf, oldestBatch, plan, computeTrimWindow, temporaryTrimPlan, fallbackTrim, assemble, isApplicable, fingerprints, diagnose, reasons,
    buildSummaryPrompt, buildConsolidatePrompt, parseSummary, priceFor, parseWindows, isPeak, peakFactor, costOf, summaryCost, mergeDeltaCost, mergeDelta,
    makeLogEntry, appendLog, LOG_LIMIT_RP: LOG_LIMIT, stats, detectAnomaly, EXTRACT_FIELDS, BLOCK_TEMPLATES, parseSections, findSectionMessage, buildExtractPrompt, shouldAutoExtract, EXTRACT_MIN, PROMPT_KEEP, parseExtract, fillEmptyBlocks,
    LORE_REASON, parseLore, loreToText, setLore, constantLoreText, selectConstantLore, activeFired, fireLore, applyFrozenLore, rebuildLore, activateLore, loreSettings, addErratum, loreStateOf, pruneLoreState, normalizeLoreState, loreSeedKey, rngForSeed, seedHash, rollProbability };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RPCache = api;
})(typeof window !== 'undefined' ? window : globalThis);
