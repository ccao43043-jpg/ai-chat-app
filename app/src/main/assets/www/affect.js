/* 好感度 / 心情（affect，A6）：取代旧 liveliness 关键词规则引擎。
 * 状态挂在 assistant 消息上：bot.affect = { v:1, aff, vec:{val,aro}, mood, ts, turn?, a, m, g, p }
 *   最新有效状态 = 最新一条带 affect 的 assistant 消息（显示前按 clock 衰减）。
 * 模型协议：回复最末尾单独一行 <state>{"a":1,"m":"开心"}</state>，a∈{-2..2}，m∈MOODS；解析后从正文剥离。
 * A6：档位文本化 relation=亲近；固定协议进 system；user 头仅一行 [AFFECT]；漏标补偿；clock∈{wall,turn}；辱骂 soft。
 * 纯逻辑可在 Node 中测试。
 */
(function (root) {
  'use strict';
  // ---- 常量（单测钉死）----
  const BASE_AFF = 0.30;                 // 好感基线
  const AFF_HALF_LIFE = 3 * 86400;       // 好感半衰期 3 天（秒，wall）
  const MOOD_HALF_LIFE = 3600;           // 心情向量半衰期 1 小时（秒，wall）
  const AFF_HALF_LIFE_TURN = 300;        // 好感半衰期 300 轮（turn）
  const MOOD_HALF_LIFE_TURN = 8;         // 心情半衰期 8 轮（turn）
  const BASE_VEC = { val: 0, aro: 0.20 };// 心情基线（valence, arousal）
  const DELTA = { '-2': -0.12, '-1': -0.05, '0': 0, '1': 0.04, '2': 0.08 }; // a → 原始 Δaff
  const NEG_MULT = 1.25;                 // 不对称：负向放大 1.25 倍（更容易掉）
  // 饱和：正向 Δ × (1-aff)/(1-BASE_AFF)，aff 越高越难涨（aff=0.3 时 ×1，aff=0.9 时 ×≈0.14）
  const DAILY_GAIN_CAP = 0.15;           // 每「本地自然日」净正增益上限（按设备本地时区日期 YYYY-MM-DD 计）
  const INERTIA = 0.5;                   // 心情惯性：vec 每轮向目标点移动 50%
  const HYS = 0.12;                      // 滞回：新标签须比当前标签近 HYS 以上才切换
  const TIER_TH = [0.15, 0.35, 0.55, 0.75]; // aff → 档位 1–5
  const TIER_LABELS = { 1: '疏远', 2: '戒备', 3: '熟悉', 4: '亲近', 5: '亲密' };
  const MOODS = ['平静', '开心', '兴奋', '害羞', '不悦', '低落', '愤怒'];
  const TARGET = { '平静': { val: 0, aro: 0.20 }, '开心': { val: 0.6, aro: 0.45 }, '兴奋': { val: 0.7, aro: 0.85 }, '害羞': { val: 0.3, aro: 0.6 },
    '不悦': { val: -0.4, aro: 0.5 }, '低落': { val: -0.6, aro: 0.15 }, '愤怒': { val: -0.75, aro: 0.9 } };
  const NEG_MOODS = ['不悦', '低落', '愤怒'];
  const MISS_WINDOW = 10;
  const MISS_THRESHOLD = 3;
  const DEMO_K = 3;
  const STRONG_REMIND = '[AFFECT_REMIND] 必须在回复末尾单独一行输出 <state>{"a":-2..2整数,"m":心情,"why":依据}</state>，勿漏标。';
  // 护栏：轻量关键词检测用户本轮话（只用于强制负向 / 校验 +2 依据，不再产生事件增量）
  const RX_BOUNDARY = /(脱光|裸照|发.{0,3}(裸|色)图|约炮|强奸|nude|nsfw)/i;
  const RX_ABUSE = /(滚|闭嘴|傻[逼比Bb]|\bsb\b|蠢货|白痴|废物|去死|垃圾|弱智|脑残|shut up|stupid|idiot|fuck)/i;
  const RX_PRAISE = /(谢谢|感谢|你真(好|棒|厉害|可爱|聪明|美|贴心)|好可爱|喜欢你|爱你|太棒了|你最好|抱抱|亲亲|想你|love you|thank|you'?re (great|amazing|cute|sweet))/i;

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const r4 = x => Math.round(x * 1e4) / 1e4;
  const dk = (b, v, hl, dt) => dt <= 0 ? v : b + (v - b) * Math.pow(0.5, dt / hl);
  const dayKey = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const tier = aff => { let t = 1; TIER_TH.forEach(th => { if (aff >= th) t++; }); return t; };
  const tierLabel = t => TIER_LABELS[t] || TIER_LABELS[1];
  const relationOf = st => tierLabel(tier(st && st.aff != null ? st.aff : BASE_AFF));
  const dist = (v, m) => Math.hypot(v.val - TARGET[m].val, v.aro - TARGET[m].aro);
  /** vec → 离散心情，带滞回 */
  function classify(vec, prev) {
    let best = MOODS[0]; MOODS.forEach(m => { if (dist(vec, m) < dist(vec, best)) best = m; });
    if (prev && TARGET[prev] && prev !== best && dist(vec, prev) - dist(vec, best) <= HYS) return prev;
    return best;
  }
  function baseState(now, opts) {
    opts = opts || {};
    const s = { v: 1, aff: BASE_AFF, vec: Object.assign({}, BASE_VEC), mood: '平静', ts: now };
    if (opts.clock === 'turn') s.turn = opts.turn != null ? opts.turn : 0;
    return s;
  }
  /**
   * 按 clock 衰减到 now。
   * opts.clock: 'wall'（默认，秒）| 'turn'（轮次）
   * opts.turn: 当前轮次索引（turn 模式必填语义；与 st.turn 差值为 dt）
   */
  function decay(st, now, opts) {
    opts = opts || {};
    const clock = opts.clock === 'turn' ? 'turn' : 'wall';
    if (!st) return baseState(now, { clock, turn: opts.turn });
    if (clock === 'turn') {
      const turnNow = opts.turn != null ? opts.turn : (st.turn != null ? st.turn : 0);
      const dt = Math.max(0, turnNow - (st.turn != null ? st.turn : turnNow));
      const vec = {
        val: r4(dk(BASE_VEC.val, st.vec ? st.vec.val : 0, MOOD_HALF_LIFE_TURN, dt)),
        aro: r4(dk(BASE_VEC.aro, st.vec ? st.vec.aro : BASE_VEC.aro, MOOD_HALF_LIFE_TURN, dt))
      };
      return Object.assign({}, st, {
        aff: r4(dk(BASE_AFF, st.aff == null ? BASE_AFF : st.aff, AFF_HALF_LIFE_TURN, dt)),
        vec, mood: classify(vec, st.mood), ts: now, turn: turnNow
      });
    }
    const dt = Math.max(0, (now - (st.ts || now)) / 1000);
    const vec = { val: r4(dk(BASE_VEC.val, st.vec ? st.vec.val : 0, MOOD_HALF_LIFE, dt)), aro: r4(dk(BASE_VEC.aro, st.vec ? st.vec.aro : BASE_VEC.aro, MOOD_HALF_LIFE, dt)) };
    return Object.assign({}, st, { aff: r4(dk(BASE_AFF, st.aff == null ? BASE_AFF : st.aff, AFF_HALF_LIFE, dt)), vec, mood: classify(vec, st.mood), ts: now });
  }

  // ---- 协议解析 / 剥离 ----
  const STATE_RX = /<state>\s*([\s\S]*?)\s*<\/state>/gi;
  function parseState(text) {
    const t = String(text || ''); let m, last = null;
    STATE_RX.lastIndex = 0; while ((m = STATE_RX.exec(t))) last = m[1];
    if (last == null) return null;
    let o; try { o = JSON.parse(last); } catch (e) { return null; }
    if (!o || typeof o !== 'object') return null;
    const a = Math.round(Number(o.a));
    if (!isFinite(a)) return null;
    const r = { a: clamp(a, -2, 2), m: MOODS.includes(o.m) ? o.m : null };
    if (typeof o.why === 'string' && o.why.trim()) r.why = o.why.trim().slice(0, 80); // A1：证据锚
    return r;
  }
  /** 剥离所有 <state>…</state>（含流式中途未闭合的尾巴）及其所在空行 */
  function stripState(text) {
    if (typeof text !== 'string' || text.indexOf('<state') < 0 && text.indexOf('</state>') < 0) return text;
    return text.replace(STATE_RX, '').replace(/<state>[\s\S]*$/i, '').replace(/<\/state>/gi, '').replace(/\s+$/, '');
  }
  const textOf = c => Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : String(c || '');
  const stripContent = c => Array.isArray(c) ? c.map(b => b && b.type === 'text' ? Object.assign({}, b, { text: stripState(b.text) }) : b) : stripState(c);
  function prependToContent(c, add) {
    if (Array.isArray(c)) return [{ type: 'text', text: add }].concat(c.map(x => Object.assign({}, x)));
    return add + '\n' + (c || '');
  }
  function appendToContent(c, add) {
    if (Array.isArray(c)) {
      const copy = c.map(x => Object.assign({}, x));
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i] && copy[i].type === 'text') {
          copy[i] = Object.assign({}, copy[i], { text: String(copy[i].text || '').replace(/\s+$/, '') + '\n' + add });
          return copy;
        }
      }
      return copy.concat([{ type: 'text', text: add }]);
    }
    return String(c || '').replace(/\s+$/, '') + '\n' + add;
  }

  // ---- A1：证据锚 Jaccard（字符 bigram，中英混排友好）----
  function grams(t) {
    const x = String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const g = new Set(); if (x.length === 1) g.add(x);
    for (let i = 0; i + 1 < x.length; i++) g.add(x.slice(i, i + 2));
    return g;
  }
  /** why 与用户原话的重合度：|why∩user| / |why|（包含度）与标准 Jaccard 取大，避免短引用被长原文稀释 */
  function jaccard(a, b) {
    const A = grams(a), B = grams(b); if (!A.size || !B.size) return 0;
    let n = 0; A.forEach(x => { if (B.has(x)) n++; });
    return r4(Math.max(n / (A.size + B.size - n), n / A.size * 0.8));
  }
  const WHY_TH = 0.3;
  // ---- P0-4：护栏分档 ----
  /** 去掉剧情引用：引号 / 书名号 / *动作* / （旁白） / > 引用行 内的内容不算「对 AI 说的话」 */
  function directText(u) {
    return String(u || '').replace(/「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"|‘[^’]*’|《[^》]*》|\*[^*\n]+\*|（[^）]*）|\([^)]*\)|【[^】]*】/g, ' ')
      .split('\n').filter(l => !/^\s*>/.test(l)).join('\n');
  }
  /** 关键词命中分档：'direct' 指向 AI（含「你」或无引用包裹）、'story' 只出现在剧情引用 / 旁白里、null 未命中 */
  function hitLevel(rx, u) {
    if (!rx.test(u)) return null;
    const d = directText(u);
    if (!rx.test(d)) return 'story';
    return 'direct';
  }
  const MODES = ['normal', 'dark', 'nsfw'];
  /** 会话模式：conv.affectMode 显式设置优先；否则角色 / 会话标签含 dark/nsfw 时自动降级 */
  function modeOf(conv) {
    if (!conv) return 'normal';
    if (MODES.includes(conv.affectMode)) return conv.affectMode;
    const tags = [].concat(conv.tags || [], conv.personaTags || [], (conv.charCard && conv.charCard.tags) || []).map(t => String(t).toLowerCase());
    if (tags.some(t => /nsfw|r18|18\+/.test(t))) return 'nsfw';
    if (tags.some(t => /dark|黑暗|致郁|暗黑/.test(t))) return 'dark';
    return 'normal';
  }
  /**
   * 时钟：conv.affectClock 显式覆盖；RP 对话默认 turn；否则 wall。
   * RP 检测：GeminiCache.isRpConv(conv, rpActive) 或 plugins.rpcache / rp / meta.rp。
   */
  function clockOf(conv, meta) {
    if (conv && (conv.affectClock === 'wall' || conv.affectClock === 'turn')) return conv.affectClock;
    const rpActive = !!(meta && meta.rp && !meta.rp.skipped);
    if (root.GeminiCache && typeof root.GeminiCache.isRpConv === 'function') {
      try { if (root.GeminiCache.isRpConv(conv, rpActive)) return 'turn'; } catch (e) { /* ignore */ }
    }
    if (rpActive) return 'turn';
    if (conv && conv.plugins && (conv.plugins.rpcache || conv.plugins.rp)) return 'turn';
    return 'wall';
  }
  /**
   * 护栏：返回修正后的 a/m 与命中的规则。
   * opts.mode：normal（默认）| dark（越界词不强制；辱骂 soft 对齐）| nsfw（越界词不强制）
   * opts.why：A1 证据锚，a=±2 时与用户原话 Jaccard ≥ WHY_TH 视为有据
   * opts.missingState：无模型自报时辱骂仍强制（保持安全）
   * A6(d)：辱骂 direct 且模型自报 a≥0 → abuse_soft，不改 a/m；boundary 仍强制。
   */
  function guard(a, m, userText, opts) {
    opts = opts || {};
    const u = String(userText || ''), hit = [], mode = MODES.includes(opts.mode) ? opts.mode : 'normal';
    const bd = hitLevel(RX_BOUNDARY, u), ab = hitLevel(RX_ABUSE, u);
    const why = opts.why, wj = why ? jaccard(why, u) : 0;
    const founded = why ? wj >= WHY_TH : null; // null = 未给 why
    if (bd === 'direct' && mode === 'normal') { a = -2; hit.push('boundary'); if (!NEG_MOODS.includes(m)) m = '愤怒'; }
    else if (ab === 'direct') {
      // 有模型自报且 a≥0：soft（不强制）；missing_state 无自报 → 仍强制
      const soft = a >= 0 && !opts.missingState;
      if (soft) {
        hit.push('abuse_soft');
      } else if (mode === 'dark') {
        if (a > 0) a = 0;
        hit.push('abuse_dark');
      } else {
        if (a > -1) a = -1;
        hit.push('abuse');
        if (!NEG_MOODS.includes(m)) m = '不悦';
      }
    }
    else {
      if (bd === 'story' || ab === 'story') hit.push('story_ref');
      else if (bd === 'direct') hit.push('boundary_' + mode);
      if (a === 2 && !RX_PRAISE.test(directText(u)) && founded !== true) { a = 1; hit.push('a2_unfounded'); }
      else if (a === -2 && founded === false) { a = -1; hit.push('why_weak'); }
    }
    if (why) hit.push('why:' + wj.toFixed(2));
    return { a, m, hit };
  }
  /** 一轮更新：prev（上一快照，可空）+ 解析结果（可空）+ 用户本轮话 → 新快照。
   * parsed===null → 未输出 <state>（missing_state），不等于明确中性 a:0。
   * opts.clock / opts.turn：与 decay 一致。
   */
  function step(prev, parsed, userText, now, opts) {
    opts = opts || {};
    const clock = opts.clock === 'turn' ? 'turn' : 'wall';
    const turnNow = clock === 'turn'
      ? (opts.turn != null ? opts.turn : ((prev && prev.turn != null ? prev.turn : 0) + 1))
      : undefined;
    const s0 = decay(prev, now, { clock, turn: clock === 'turn' ? turnNow : undefined });
    const day = dayKey(now);
    let net = prev && prev.g && prev.g.day === day ? prev.g.net || 0 : 0;

    // 未输出 <state>：只衰减；护栏仍可因用户辱骂/越界强制改 a（missingState→辱骂强制）
    if (parsed == null) {
      const gd = guard(0, null, userText, Object.assign({}, opts, { why: null, missingState: true }));
      const forced = gd.hit.some(h => h === 'abuse' || h === 'boundary' || h === 'abuse_dark' || h === 'boundary_dark' || h === 'boundary_nsfw');
      if (!forced) {
        const out = { v: 1, aff: s0.aff, vec: s0.vec, mood: s0.mood, ts: now, a: null, m: null,
          g: { day, net, guard: gd.hit }, p: 'missing_state', stateMissing: true };
        if (clock === 'turn') out.turn = turnNow;
        return out;
      }
      // 护栏强制：按修正后的 a 更新，仍标记 stateMissing
      const a = gd.a, m = gd.m;
      let d = DELTA[String(a)];
      if (d > 0) { d *= (1 - s0.aff) / (1 - BASE_AFF); d = Math.max(0, Math.min(d, DAILY_GAIN_CAP - net)); }
      else if (d < 0) d *= NEG_MULT;
      const aff = clamp(s0.aff + d, 0, 1);
      net = r4(net + (aff - s0.aff));
      const tg = m ? TARGET[m] : BASE_VEC;
      const vec = { val: r4(s0.vec.val + INERTIA * (tg.val - s0.vec.val)), aro: r4(s0.vec.aro + INERTIA * (tg.aro - s0.vec.aro)) };
      const out = { v: 1, aff: r4(aff), vec, mood: classify(vec, s0.mood), ts: now, a, m,
        g: { day, net, guard: gd.hit }, p: 'missing_state+guard', stateMissing: true };
      if (clock === 'turn') out.turn = turnNow;
      return out;
    }

    // 明确输出（含 a:0 中性）
    const gd = guard(parsed.a, parsed.m, userText, Object.assign({}, opts, { why: parsed.why }));
    const a = gd.a, m = gd.m;
    let d = DELTA[String(a)];
    if (d > 0) { d *= (1 - s0.aff) / (1 - BASE_AFF); d = Math.max(0, Math.min(d, DAILY_GAIN_CAP - net)); }
    else if (d < 0) d *= NEG_MULT;
    const aff = clamp(s0.aff + d, 0, 1);
    net = r4(net + (aff - s0.aff));
    const tg = m ? TARGET[m] : BASE_VEC;
    const vec = { val: r4(s0.vec.val + INERTIA * (tg.val - s0.vec.val)), aro: r4(s0.vec.aro + INERTIA * (tg.aro - s0.vec.aro)) };
    const whyLoc = parsed.why ? locateWhy(parsed.why, userText) : null;
    const out = { v: 1, aff: r4(aff), vec, mood: classify(vec, s0.mood), ts: now, a, m,
      g: { day, net, guard: gd.hit }, p: gd.hit.some(h => !/^why:/.test(h)) ? 'model+guard' : 'model',
      stateMissing: false, explicitNeutral: a === 0,
      ...(parsed.why ? { why: parsed.why } : {}),
      ...(whyLoc ? { whyLoc } : {}) };
    if (clock === 'turn') out.turn = turnNow;
    return out;
  }
  /** why 证据尽量定位到用户原文中的起止下标（字符） */
  function locateWhy(why, userText) {
    const u = String(userText || ''), w = String(why || '').trim();
    if (!w || !u) return null;
    let i = u.indexOf(w);
    if (i >= 0) return { start: i, end: i + w.length, quote: u.slice(i, i + w.length) };
    // 宽松：去空白后再找
    const strip = s => s.replace(/\s+/g, '');
    const us = strip(u), ws = strip(w);
    const j = us.indexOf(ws);
    if (j < 0) return { start: -1, end: -1, quote: w, approx: true };
    // 映射回原串大致位置
    let ci = 0, start = -1, end = -1;
    for (let k = 0; k < u.length; k++) {
      if (/\s/.test(u[k])) continue;
      if (ci === j) start = k;
      if (ci === j + ws.length - 1) { end = k + 1; break; }
      ci++;
    }
    return { start, end: end < 0 ? (start >= 0 ? start + w.length : -1) : end, quote: start >= 0 ? u.slice(start, end) : w, approx: true };
  }

  /** 最新有效状态（可传 before：只看该消息之前） */
  function latest(conv, before) {
    const ms = (conv && conv.messages) || [];
    let end = before ? ms.indexOf(before) : ms.length; if (end < 0) end = ms.length;
    for (let i = end - 1; i >= 0; i--) if (ms[i] && ms[i].role === 'assistant' && ms[i].affect) return ms[i].affect;
    return null;
  }
  /** 固定层协议：relation 五档含义 + <state> 输出规则（每轮相同，可缓存） */
  function fixedProtocol() {
    return '[AFFECT_RULE] relation 五档含义：疏远(1)/戒备(2)/熟悉(3)/亲近(4)/亲密(5)。'
      + '回复最末尾单独一行输出 <state>{"a":好感变化-2~2整数,"m":"' + MOODS.join('|') + '","why":"a≠0 时摘用户原话 ≤12 字作依据"}</state>，正文不要提及该标签或状态。';
  }
  function renderTag(st) { return '[AFFECT] mood=' + (st && st.mood || '平静') + ' relation=' + relationOf(st); }
  /** 兼容旧名：仅返回短 tag（协议已进 system） */
  function renderInjection(st) { return renderTag(st); }
  /** P0-3：历史只挂短 tag（冻结注入的首行），完整协议只在固定层 */
  const tagOf = inj => String(inj || '').split('\n')[0];

  // ---- A6(c) 漏标补偿 ----
  function affectSnapshots(conv, n) {
    const out = [];
    ((conv && conv.messages) || []).forEach(m => { if (m && m.role === 'assistant' && m.affect) out.push(m.affect); });
    return out.slice(-(n || MISS_WINDOW));
  }
  /** 近 n 轮漏标统计：missing / 有 affect 的轮数 */
  function missingStats(conv, n) {
    const snaps = affectSnapshots(conv, n || MISS_WINDOW);
    let missing = 0;
    snaps.forEach(s => {
      if (s.stateMissing || (s.p && String(s.p).indexOf('missing_state') >= 0)) missing++;
    });
    return { total: snaps.length, missing, rate: snaps.length ? missing / snaps.length : 0 };
  }
  function shouldDemoState(conv, n) {
    return missingStats(conv, n || MISS_WINDOW).missing >= MISS_THRESHOLD;
  }
  /** 从已存盘（已剥离）的 affect 重建示范 <state> */
  function rebuildStateTag(affect) {
    if (!affect || affect.a == null || !isFinite(Number(affect.a))) return '';
    const o = { a: Number(affect.a), m: affect.m || affect.mood || '平静' };
    if (affect.why) o.why = String(affect.why).slice(0, 80);
    return '<state>' + JSON.stringify(o) + '</state>';
  }
  /** 护栏命中汇总（非 why: 前缀；区分 soft / 强制） */
  function guardStats(conv) {
    const soft = {}, hard = {}, all = {};
    ((conv && conv.messages) || []).forEach(m => {
      const g = m && m.affect && m.affect.g && m.affect.g.guard;
      if (!Array.isArray(g)) return;
      g.forEach(h => {
        if (!h || /^why:/.test(h)) return;
        all[h] = (all[h] || 0) + 1;
        if (h === 'abuse_soft' || /_soft$/.test(h)) soft[h] = (soft[h] || 0) + 1;
        else hard[h] = (hard[h] || 0) + 1;
      });
    });
    const sum = o => Object.keys(o).reduce((n, k) => n + o[k], 0);
    return { soft, hard, all, softCount: sum(soft), hardCount: sum(hard) };
  }

  /** P0-2 方案 A：切版本 / 编辑后，从 idx 起清除 affect 与 affectInj（含各版本快照），返回清除条数 */
  function invalidateFrom(conv, idx) {
    const ms = (conv && conv.messages) || []; let n = 0;
    for (let i = Math.max(0, idx | 0); i < ms.length; i++) {
      const m = ms[i]; if (!m) continue;
      if (m.affect || m.affectInj) n++;
      delete m.affect; delete m.affectInj;
      if (Array.isArray(m.versions)) m.versions.forEach(v => { if (v && (v.affect || v.affectInj)) { delete v.affect; delete v.affectInj; } });
    }
    return n;
  }
  /** E2：最近 n 条 affect 好感序列（sparkline 用） */
  function series(conv, n) {
    const out = []; ((conv && conv.messages) || []).forEach(m => { if (m && m.role === 'assistant' && m.affect) out.push(m.affect.aff); });
    return out.slice(-(n || 30));
  }
  function sparkline(vals, w, h) {
    w = w || 160; h = h || 32; if (!vals || vals.length < 2) return '';
    const pts = vals.map((v, i) => (i * (w - 4) / (vals.length - 1) + 2).toFixed(1) + ',' + (h - 2 - clamp(v, 0, 1) * (h - 4)).toFixed(1)).join(' ');
    const by = (h - 2 - BASE_AFF * (h - 4)).toFixed(1);
    return '<svg class="af-spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '"><line x1="0" x2="' + w + '" y1="' + by + '" y2="' + by + '" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="2 3"/><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="' + pts + '"/></svg>';
  }

  /**
   * 改写请求消息：历史 assistant 默认剥离 <state>；漏标补偿期对最近 K 条有效 affect 重建示范；
   * 历史 user 回放冻结的短 tag；本轮 user 前置 tag（+ 可选临时强提醒，不进 affectInj）。
   * opts.demoState / opts.remind / opts.demoK
   */
  function applyToMessages(msgs, lastUser, inj, opts) {
    opts = opts || {};
    const demo = !!opts.demoState;
    const remind = opts.remind ? String(opts.remind) : '';
    const k = opts.demoK != null ? opts.demoK : DEMO_K;
    const demoSet = new Set();
    if (demo) {
      const cand = [];
      msgs.forEach(m => {
        const src = m._src || m;
        if (m.role === 'assistant' && src.affect && !src.affect.stateMissing && src.affect.a != null && isFinite(Number(src.affect.a))) cand.push(m);
      });
      cand.slice(-k).forEach(m => demoSet.add(m));
    }
    let idx = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { idx = i; break; }
    return msgs.map((m, i) => {
      if (m.role === 'assistant') {
        let content = stripContent(m.content);
        if (demoSet.has(m)) {
          const src = m._src || m;
          const tag = rebuildStateTag(src.affect);
          if (tag && textOf(content).indexOf('<state>') < 0) content = appendToContent(content, tag);
        }
        return Object.assign({}, m, { content });
      }
      if (m.role !== 'user') return m;
      const src = m._src;
      let add = null;
      if (i === idx) {
        add = (lastUser && lastUser.affectInj) || inj;
        if (remind && add) add = tagOf(add) + '\n' + remind;
      } else if (src && src.affectInj) add = tagOf(src.affectInj); // P0-3：历史只回放短 tag
      if (!add || textOf(m.content).startsWith(add)) return m;
      return Object.assign({}, m, { content: prependToContent(m.content, add) });
    });
  }

  const Affect = { BASE_AFF, AFF_HALF_LIFE, MOOD_HALF_LIFE, AFF_HALF_LIFE_TURN, MOOD_HALF_LIFE_TURN, BASE_VEC, DELTA, NEG_MULT, DAILY_GAIN_CAP, INERTIA, HYS, TIER_TH, TIER_LABELS, MOODS, TARGET,
    MISS_WINDOW, MISS_THRESHOLD, DEMO_K, STRONG_REMIND,
    tier, tierLabel, relationOf, classify, decay, parseState, renderTag, tagOf, invalidateFrom, series, sparkline, jaccard, directText, hitLevel, modeOf, clockOf, MODES, WHY_TH, stripState, stripContent, guard, step, locateWhy, latest, fixedProtocol, renderInjection, applyToMessages, dayKey, textOf,
    missingStats, shouldDemoState, rebuildStateTag, guardStats, affectSnapshots };

  // ---------------- 插件 ----------------
  const reg = root.Plugins && root.Plugins.registry;
  if (reg) {
    const ID = 'affect';
    reg.register({
      id: ID, icon: '💓', name: '好感度 / 心情', version: '1.1.0', perConversation: false, defaultEnabled: true,
      desc: '模型每轮在回复末尾自报 <state>{"a","m"}</state>（好感变化 + 心情）。A6：relation 档位文案、固定协议进 system、漏标补偿、RP 默认按轮衰减、辱骂 soft。缓存零侵入。',
      hooks: {
        onBeforeRequest(ctx) {
          const msgs = ctx.messages || [];
          if (!msgs.some(m => m.role === 'user')) return ctx;
          const now = Date.now();
          const clock = clockOf(ctx.conv, ctx.meta);
          const prev = latest(ctx.conv);
          const turn = clock === 'turn' ? ((prev && prev.turn) || 0) : undefined;
          const st = decay(prev, now, { clock, turn });
          const tag = renderTag(st);
          if (ctx.lastUser && !ctx.lastUser.affectInj) ctx.lastUser.affectInj = tag; // 首发冻结短 tag
          const proto = fixedProtocol();
          if (ctx.systemPrompt == null || ctx.systemPrompt === '') ctx.systemPrompt = proto;
          else if (String(ctx.systemPrompt).indexOf('[AFFECT_RULE]') < 0) ctx.systemPrompt = String(ctx.systemPrompt) + '\n' + proto;
          const demo = shouldDemoState(ctx.conv);
          const remind = demo ? STRONG_REMIND : '';
          ctx.messages = applyToMessages(msgs, ctx.lastUser, tag, { demoState: demo, remind });
          ctx.meta.affect = { injection: (ctx.lastUser && ctx.lastUser.affectInj) || tag, clock, demo };
          return ctx;
        },
        onAfterResponse(result, ctx, host) {
          const bot = result && result.bot; if (!bot) return;
          const raw = textOf(bot.content);
          const parsed = parseState(raw);
          bot.content = stripContent(bot.content);
          if (!result.ok) return;
          const clock = clockOf(ctx.conv, ctx.meta);
          const prev = latest(ctx.conv, bot);
          const turn = clock === 'turn' ? ((prev && prev.turn) || 0) + 1 : undefined;
          bot.affect = step(prev, parsed, textOf(ctx.lastUser && ctx.lastUser.content), Date.now(), { mode: modeOf(ctx.conv), clock, turn });
          if (host && host.saveConv) host.saveConv(ctx.conv);
        },
        headerBadges(conv, host) {
          const lt = latest(conv); if (!lt) return [];
          const clock = clockOf(conv);
          const turn = clock === 'turn' ? (lt.turn || 0) : undefined;
          const s = decay(lt, Date.now(), { clock, turn }), t = tier(s.aff), rel = tierLabel(t);
          return [{ text: s.mood + ' · ' + rel, tone: t <= 2 ? 'warn' : 'info', title: '心情 ' + s.mood + ' · 关系 ' + rel + '（档 ' + t + '，aff ' + s.aff.toFixed(2) + '）', action: () => host.openPanel(ID), kind: 'mood' }];
        },
      },
      renderPanel(box, host) {
        const conv = host.conv(), lt = latest(conv);
        if (!lt) { box.innerHTML = '<div class="hint">本对话还没有好感 / 心情状态（模型回复末尾输出 &lt;state&gt; 后出现）。</div>'; return; }
        const clock = clockOf(conv);
        const turn = clock === 'turn' ? (lt.turn || 0) : undefined;
        const s = decay(lt, Date.now(), { clock, turn });
        const md = modeOf(conv), sp = sparkline(series(conv, 30));
        const ms = missingStats(conv), gs = guardStats(conv);
        const rel = relationOf(s);
        box.innerHTML = '<div class="hint">当前心情：' + host.esc(s.mood) + ' · 好感 ' + s.aff.toFixed(3) + '（' + host.esc(rel) + ' · 档 ' + tier(s.aff) + '/5）· 时钟 ' + clock + '</div>' +
          (sp ? '<div class="hint">好感走势（近 30 轮，虚线 = 基线）<br>' + sp + '</div>' : '') +
          (lt.why ? '<div class="hint">依据：' + host.esc(lt.why) + '</div>' : '') +
          '<div class="hint">漏标率：' + ms.missing + '/' + ms.total + (ms.total ? '（' + Math.round(ms.rate * 100) + '%）' : '') +
          ' · 护栏：强制 ' + gs.hardCount + ' / soft ' + gs.softCount +
          (Object.keys(gs.all).length ? '（' + host.esc(Object.keys(gs.all).map(k => k + '×' + gs.all[k]).join(', ')) + '）' : '') + '</div>' +
          '<label class="field inline"><span>护栏档位<small>黑暗向：越界词不强制；辱骂在模型 a≥0 时 soft。剧情引用不触发</small></span><select class="af-mode">' +
          MODES.map(x => '<option value="' + x + '"' + (x === md ? ' selected' : '') + '>' + ({ normal: '标准', dark: '黑暗向', nsfw: 'NSFW' }[x]) + '</option>').join('') + '</select></label>' +
          '<div class="hint">最近一轮：a=' + lt.a + ' · m=' + host.esc(lt.m || '-') + ' · 来源 ' + host.esc(lt.p || '-') + (lt.g && lt.g.guard && lt.g.guard.length ? ' · 护栏 ' + host.esc(lt.g.guard.join(',')) : '') + (lt.g ? ' · 今日净增 ' + (lt.g.net || 0).toFixed(3) : '') + '</div>' +
          '<div class="hint">注入示例（user 头）：<br><code>' + host.esc(renderTag(s)) + '</code></div>' +
          '<div class="hint">固定协议（system）：<br><code>' + host.esc(fixedProtocol()) + '</code></div>' +
          '<button class="chip-btn af-reset">重置本对话状态</button>';
        box.querySelector('.af-mode').onchange = e => { conv.affectMode = e.target.value; host.saveConv(conv); host.toast('护栏档位：' + e.target.selectedOptions[0].textContent); };
        box.querySelector('.af-reset').onclick = () => {
          invalidateFrom(conv, 0);
          host.saveConv(conv); host.toast('已重置'); this.renderPanel(box, host);
        };
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Affect;
  root.Affect = Affect;
})(typeof window !== 'undefined' ? window : globalThis);
