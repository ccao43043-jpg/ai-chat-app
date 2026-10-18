/* DeepSeek RP 缓存优化器 V2 —— Context Builder 核心逻辑（纯函数，可在 Node 中测试）
 * 设计文档：docs/plugins/deepseek-rp-cache-design-v1.md（V1）+ docs/plugins/README.md「V2 变更」；
 * 核心：能不动就不动，能追加就不重写，能摘要就不盲删，能把动态内容放后面就绝不放前面。
 * 请求顺序：system = L1 永久锚点 → L2 长期记忆（稳定事实）→ L3 冻结章节 #001、#002…（只追加）
 *           messages = L4 最近完整对话（原样追加）→ 最后一条用户消息 = L6 本轮输入 + 记忆增量 + L5 当前状态
 * V2：章节只追加（超过上限才合并一次）、记忆增量放在尾部、摘要最小间隔、按实际用量校准 Token 估算、
 *     服务商适用性判断（默认只对 DeepSeek 生效）、价格 / 高峰时段可配置。
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
  };
  const DEFAULT_PEAK = { windows: '09:00-12:00,14:00-18:00', tz: 8, weekdays: true, off_factor: 0.5 };
  // DeepSeek 官方价格（美元 / 百万 tokens，高峰时段；非高峰为一半）—— 2026-10 核对 api-docs.deepseek.com/quick_start/pricing
  // match：模型名包含其中任意一个关键词即使用该价格（逗号分隔，越长越优先）；可在插件设置里修改 / 新增
  const DEFAULT_PRICES = {
    'deepseek-flash': { hit: 0.006, miss: 0.3, out: 1.2, match: 'deepseek' },
    'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96, match: 'deepseek-v4-pro,deepseek-pro' },
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
    const settings = Object.assign({}, DEFAULT_SETTINGS, ss, { summary: Object.assign({}, DEFAULT_SETTINGS.summary, ss.summary || {}) });
    let chapters = Array.isArray(st.chapters) ? st.chapters : null;
    let chapterSeq = st.chapterSeq | 0;
    if (!chapters) { chapters = migrateSummaries(st.summaries) || []; chapterSeq = Math.max(chapterSeq, chapters.length); }
    const calib = typeof st.calib === 'number' && st.calib >= 0.5 && st.calib <= 2.5 ? st.calib : 1;
    return Object.assign({}, st, { blocks, settings, staticVersion: st.staticVersion | 0, baseHash: st.baseHash == null ? null : st.baseHash,
      summaries: Array.isArray(st.summaries) ? st.summaries : [], chapters, chapterSeq: Math.max(chapterSeq, chapters.reduce((n, c) => Math.max(n, c.no | 0), 0)),
      archive: Array.isArray(st.archive) ? st.archive : [], lastSummaryRound: st.lastSummaryRound | 0, calib,
      window: Object.assign({ startId: null, startOrdinal: 0 }, st.window || {}), seq: st.seq | 0 });
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
  function mkChapter(st, o) {
    const no = (st.chapterSeq | 0) + 1;
    const content = canonicalize(o.content);
    return { no, content, hash: sha256(content), coveredIds: (o.coveredIds || []).slice(), at: o.at || 0, source: o.source || 'auto', rounds: o.rounds | 0,
      atRound: o.atRound | 0, history: [], mergedFrom: o.mergedFrom || null };
  }
  /** 追加新章节：只覆盖本批新移出的历史；之前的章节逐字不变 → 前缀保持 */
  function addChapter(st, o) {
    const ch = mkChapter(st, o);
    return Object.assign({}, st, { chapters: chaptersOf(st).concat([ch]), chapterSeq: ch.no, lastSummaryRound: o.atRound != null ? o.atRound | 0 : st.lastSummaryRound | 0,
      window: { startId: null, startOrdinal: 0 } });
  }
  const pushArchive = (st, list, why, at) => (st.archive || []).concat(list.map(c => Object.assign({}, c, { archivedAt: at || 0, archivedWhy: why }))).slice(-ARCHIVE_LIMIT);
  /** 合并全部章节（+ 可选的新一批历史）为一章：只在章节总量超过上限时使用，会让 L3 之后的缓存重建一次 */
  function consolidate(st, o) {
    const old = chaptersOf(st);
    const ch = mkChapter(st, Object.assign({}, o, { coveredIds: coveredIds(st).concat(o.coveredIds || []), mergedFrom: old.map(c => c.no), source: o.source || 'merge' }));
    return Object.assign({}, st, { chapters: [ch], chapterSeq: ch.no, archive: pushArchive(st, old, 'merge', o.at),
      lastSummaryRound: o.atRound != null ? o.atRound | 0 : st.lastSummaryRound | 0, window: { startId: null, startOrdinal: 0 } });
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

  // ---------------- 序列化（逐字节稳定：同样的内容 → 同样的文本） ----------------
  function staticText(st, baseSystem) {
    const parts = [];
    const b = canonicalize(baseSystem); if (b) parts.push(b);
    STATIC_DEFS.forEach(d => { const c = getBlock(st, d.id).content; if (c) parts.push('[' + d.tag + ']\n' + c); });
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
  /** 用服务商返回的真实输入 Token 校准估算（指数平均，系数限制在 0.5–2.5） */
  function calibrate(st, rawEstimate, actualPrompt) {
    if (!(rawEstimate > 200) || !(actualPrompt > 0)) return st;
    const ratio = Math.min(2.5, Math.max(0.5, actualPrompt / rawEstimate));
    const prev = typeof st.calib === 'number' ? st.calib : 1;
    const calib = Math.round((prev * 0.7 + ratio * 0.3) * 1000) / 1000;
    return Object.assign({}, st, { calib, calibN: (st.calibN | 0) + 1 });
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
   * 返回各层内容、Token 预算（已乘校准系数）、是否需要生成章节 / 合并章节。
   */
  function plan(state, baseSystem, items) {
    const st = normalizeState(state);
    const s = st.settings, sum = s.summary;
    const k = st.calib || 1; const cal = n => Math.round(n * k);
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
    const needConsolidate = !!summaryReason && st.chapters.length > 1 && chapterTokens >= cap;
    return { st, system, hist, input, unsummarized, covered, tokens, limit, overBudget, batch, batchRounds, needSummary: !!summaryReason, summaryReason,
      summaryBlocked, sinceLast, minGap, rounds, chapterTokens, cap, needConsolidate, calib: k, trimmed: start > 0, dropped: start };
  }
  /** 无法摘要（关闭 / 失败 / 无可摘要历史）而仍超预算时：一次性截掉一大块旧历史，起点固定到下次超预算为止 */
  function fallbackTrim(st, p) {
    const keep = Math.max(1, st.settings.summary.keep_recent_turns | 0);
    const k = p.calib || 1;
    const un = p.unsummarized;
    const users = []; un.forEach((m, i) => { if (m.role === 'user') users.push(i); });
    let j = Math.max(0, users.length - keep);
    const fixed = p.tokens.total - p.tokens.history;
    while (j < users.length - 1 && fixed + estimateItems(un.slice(users[j])) * k > p.limit) j++;
    const startIdx = users.length ? users[j] : 0;
    if (!un[startIdx]) return st;
    return Object.assign({}, st, { window: { startId: un[startIdx].id, startOrdinal: startIdx } });
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
  /** DeepSeek 预设 / DeepSeek 接口地址 / 模型名含 deepseek → 适用 */
  function isApplicable(provider, model) {
    const p = provider || {};
    if (p.presetId === 'deepseek') return true;
    if (/deepseek/i.test(String(p.baseUrl || ''))) return true;
    return /deepseek/i.test(String(model || ''));
  }

  // ---------------- 指纹与诊断 ----------------
  function fingerprints(p, baseSystem) {
    const histSer = serializeHistory(p.hist);
    const act = activeSummary(p.st);
    return {
      static_hash: sha256(staticText(p.st, baseSystem)), memory_hash: sha256(memoryText(p.st)), summary_hash: sha256(summaryText(p.st)),
      history_hash: sha256(histSer), delta_hash: sha256(deltaText(p.st)), state_hash: sha256(stateText(p.st)), input_hash: sha256(p.input ? JSON.stringify([p.input.content || '', imgSig(p.input.images)]) : ''),
      full_prefix_hash: sha256(p.system + '\u0000' + histSer), history_count: p.hist.length,
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
    else if (fp.history_count > (prev.history_count | 0) && sha256(serializeHistory(hist, prev.history_count | 0)) === prev.history_hash) out.history = 'APPEND';
    else out.history = 'CHANGED';
    return out;
  }
  /** 用大白话解释本次命中情况（第 39 节） */
  function reasons(entry, prev) {
    const d = entry.diag || {}; const out = [];
    if (!prev) return ['首次请求，缓存尚未建立'];
    if (entry.summary_happened) out.push(entry.summary_merged ? '章节总量超过上限，已合并为 ' + slabel(entry.summary_no) + '，章节及之后的缓存重建一次'
      : (entry.summary_reason === 'budget' ? '超出预算，追加了章节 ' : '历史达到摘要阈值，追加了章节 ') + slabel(entry.summary_no) + '：之前的章节保持命中，从新章节处重新建立');
    if (d.static === 'CHANGED') out.push(STATIC_CAUSE(entry.static_cause) || '角色卡 / 世界观等永久锚点被修改');
    if (d.memory === 'CHANGED') out.push('长期记忆已更新（建议改用「记忆增量」，不破坏前缀）');
    if (d.summary === 'CHANGED' && !entry.summary_happened) out.push('章节摘要刚更新（编辑、撤销或合并）');
    if (d.summary === 'APPEND' && !entry.summary_happened) out.push('手动追加了新章节，之前的章节保持命中');
    if (d.history === 'CHANGED' && !entry.summary_happened) out.push(entry.trimmed ? '超出预算，较早历史被一次性截断' : HISTORY_CAUSE(entry.history_cause) || '历史被修改（编辑、删除或重新生成了较早的消息）');
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
  function parseSummary(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '');
    t = t.replace(/^\[?CHAPTER[ _]SUMMARY[^\n]*\]?\s*\n/i, '');
    t = canonicalize(t);
    const missing = SUMMARY_SECTIONS.filter(k => !new RegExp('(^|\\n)\\s*[#*]*\\s*' + k + '\\b', 'i').test(t));
    return { ok: !!t && missing.indexOf('FACTS') < 0 && missing.length <= 4, text: t, missing };
  }

  // ---------------- 价格（V2：可配置的匹配规则与高峰时段） ----------------
  function priceFor(model, prices) {
    prices = prices || DEFAULT_PRICES; const m = String(model || '').toLowerCase();
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
  function costOf(e, prices, mode, peak) {
    const p = priceFor(e.model, prices);
    if (!p || !e.supported) return null;
    const f = peakFactor(e.timestamp, mode, peak);
    const actual = (e.cache_hit_tokens * p.hit + e.cache_miss_tokens * p.miss + (e.completion_tokens || 0) * p.out) / 1e6 * f;
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
      const f = peakFactor(o.at || Date.now(), o.mode, o.peak);
      const missOverHit = Math.max(0, pr.miss - pr.hit);
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
    if (pr) r.usd = rebuild * Math.max(0, pr.miss - pr.hit) / 1e6 * peakFactor(o.at || Date.now(), o.mode, o.peak);
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
      hit_rate: supported ? (u.hit || 0) / ((u.hit || 0) + (u.miss || 0) || u.prompt) : null,
      static_hash: fp.static_hash, memory_hash: fp.memory_hash, summary_hash: fp.summary_hash, history_hash: fp.history_hash, delta_hash: fp.delta_hash, state_hash: fp.state_hash,
      chapters: fp.chapters || [], summary_merged: !!o.summaryMerged, summary_cost: o.summaryCost || null,
      input_hash: fp.input_hash, full_prefix_hash: fp.full_prefix_hash, history_count: fp.history_count | 0, versions: fp.versions || {},
      layer_tokens: o.tokens || {}, diag: o.diag || {}, summary_happened: !!o.summaryNo, summary_no: o.summaryNo || 0, summary_reason: o.summaryReason || null,
      summary_error: o.summaryError || null, static_cause: o.staticCause || null, history_cause: o.historyCause || null, over_budget: !!o.overBudget, trimmed: !!o.trimmed, msg_id: o.msgId || '',
    };
    e.reasons = reasons(e, o.prev || null);
    e.reason = e.reasons[0];
    if (o.savePrompt && o.prompt) e.prompt = o.prompt; // 调试：仅在用户开启 save_prompt 时保存
    return e;
  }
  function appendLog(logs, e) { const out = (logs || []).concat([e]); while (out.length > LOG_LIMIT) out.shift(); return out; }
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

  const api = { STATIC_DEFS, BLOCK_DEFS, BLOCK_TITLES, LAYERS, LAYER_TITLES, LAYER_EN, LAYER_CN, DIAG_LABELS, diagLabel, SUMMARY_SECTION_CN, verLabel, DEFAULT_SETTINGS, DEFAULT_PRICES, DEFAULT_PEAK, SUMMARY_SECTIONS,
    canonicalize, sha256, vlabel, slabel, newState, normalizeState, migrateSummaries, getBlock, updateBlock, restoreBlock, setBlock, syncBase, explicitBaseUpdate, markHistoryCause,
    activeSummary, chaptersOf, coveredIds, addChapter, addSummary, consolidate, editChapter, removeLastChapter,
    staticText, memoryText, summaryText, deltaText, stateText, buildSystem, finalUserContent, serializeHistory,
    estimateTokens, estimateItems, calibrate, oldestBatch, plan, fallbackTrim, assemble, isApplicable, fingerprints, diagnose, reasons,
    buildSummaryPrompt, buildConsolidatePrompt, parseSummary, priceFor, parseWindows, isPeak, peakFactor, costOf, summaryCost, mergeDeltaCost, mergeDelta,
    makeLogEntry, appendLog, stats, detectAnomaly };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RPCache = api;
})(typeof window !== 'undefined' ? window : globalThis);
