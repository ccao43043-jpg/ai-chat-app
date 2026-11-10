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
  const relationOf = st => tierLabel((st && st.cusum && st.cusum.tier) ? st.cusum.tier : tier(st && st.aff != null ? st.aff : BASE_AFF));
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
  // ---- D/KF：观测融合 + 卡尔曼 + CUSUM（§5.2）----
  const KF_Q = 0.04;           // 过程噪声
  const KF_R = 0.30;           // 观测噪声
  const KF_W = 0.65;           // 默认模型权重
  const KF_W_WHY = 0.75;       // 有 why 证据时
  const KF_W_INCONSISTENT = 0.7; // 自报不一致时再乘
  const CUSUM_K_UP = 0.15;
  const CUSUM_K_DN = -0.15;
  const CUSUM_H_UP = 0.45;
  const CUSUM_H_DN = 0.45;
  const CUSUM_D = 4;           // 驻留轮数
  const CHAR_SELF_W = 0.70;    // 多角色：自身权重
  const CHAR_SCENE_W = 0.30;   // 场景氛围权重
  // KF 路径 vec：用滤波 â 驱动目标，步进增益跟 K 联动（legacy 仍用固定 INERTIA）
  const VEC_KF_ALPHA = 0.35;   // 合成目标里 â→(val,aro) 的权重；其余留给 mood TARGET
  const VEC_KF_G_MIN = 0.25;   // 每轮向目标靠近的最小增益
  const VEC_KF_G_MAX = 0.65;   // 最大增益（避免单轮跳变）
  // 词典（轻量）：正/负词、否定、程度
  const LEX_POS = ['谢谢', '感谢', '喜欢', '爱你', '真棒', '厉害', '可爱', '开心', '高兴', '棒', '贴心', '抱抱', '亲亲', '想你', '优秀', '温柔', 'thank', 'love', 'great', 'amazing', 'cute', 'sweet', 'nice'];
  const LEX_NEG = ['滚', '闭嘴', '讨厌', '恨', '烦', '蠢', '白痴', '废物', '垃圾', '去死', '恶心', '失望', '分手', '生气', '伤心', '难过', '恨你', 'stupid', 'idiot', 'hate', 'fuck', 'shut'];
  const LEX_NEGATE = ['并非', '不是', '没有', '不要', '别再', '绝不', '毫无', '不', '没', '别', '未', '勿']; // 不含单字「非」，避免误伤「非常」
  const LEX_DEGREE = { '很': 1.5, '太': 1.6, '非常': 1.7, '超级': 1.8, '极其': 1.8, '特别': 1.5, '真': 1.3, '有点': 0.6, '有些': 0.6, '稍': 0.5, '略': 0.5, '比较': 0.8, 'so': 1.4, 'very': 1.5, 'really': 1.4, 'extremely': 1.8, 'slightly': 0.5 };
  const RX_CARE = /(担心你|我担心|抱歉|对不起|不好意思|想你|抱抱|亲亲|心疼|照顾|爱你|安慰|别难过|没事的|我在|陪伴)/;
  const RX_REBUKE = /(滚开|闭嘴|讨厌你|恶心|无聊透|失望透顶|分手吧|你滚|别烦我|受够了|恨你)/;
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
  /** 旧路径：观测直用 + DELTA/INERTIA（可回退）。parsed===null → missing_state。 */
  function stepLegacy(prev, parsed, userText, now, opts) {
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

  // ---- 词典观测：正词−负词，否定翻转，程度加权，夹到 [-2,2] ----
  function lexiconScore(userText) {
    const u = String(userText || '');
    if (!u.trim()) return 0;
    const lower = u.toLowerCase();
    let score = 0;
    function windowBefore(idx, n) {
      return lower.slice(Math.max(0, idx - n), idx);
    }
    function weightAt(idx) {
      let w = 1;
      // 含关键词前若干字，便于匹配「非常喜欢」
      const prev = windowBefore(idx, 10);
      const degKeys = Object.keys(LEX_DEGREE).sort((a, b) => b.length - a.length);
      for (let i = 0; i < degKeys.length; i++) {
        const adv = degKeys[i];
        const p = prev.lastIndexOf(adv);
        if (p >= 0 && prev.length - (p + adv.length) <= 2) { w *= LEX_DEGREE[adv]; break; }
      }
      let neg = false;
      for (let i = 0; i < LEX_NEGATE.length; i++) {
        const ng = LEX_NEGATE[i];
        const p = prev.lastIndexOf(ng);
        if (p < 0 || prev.length - (p + ng.length) > 3) continue;
        // 若否定词是某程度副词的前缀（如「非」⊂「非常」），跳过
        const after = prev.slice(p);
        if (degKeys.some(adv => adv.indexOf(ng) === 0 && adv.length > ng.length && after.indexOf(adv) === 0)) continue;
        neg = true; break;
      }
      return neg ? -w : w;
    }
    function addAll(words, sign) {
      words.forEach(w => {
        const key = w.toLowerCase();
        let from = 0, idx;
        while ((idx = lower.indexOf(key, from)) >= 0) {
          score += sign * weightAt(idx);
          from = idx + Math.max(key.length, 1);
        }
      });
    }
    addAll(LEX_POS, 1);
    addAll(LEX_NEG, -1);
    return r4(clamp(score, -2, 2));
  }

  /**
   * 映射说明（KF 状态空间）：
   * - 观测 y_model / y_lex / y_t 均在 a 尺度 [-2, 2]（与护栏后自报 a 同域）
   * - KF 状态 x=â 同在 [-2, 2]；缺省用 affToX(当前 aff) 初始化（BASE_AFF→0，aff=1→+2）
   * - 滤波后 â 经 deltaFromA（DELTA 表分段线性）映到 Δaff，再套饱和 / NEG_MULT / DAILY_GAIN_CAP
   * - CUSUM 也在 â（a 尺度）上累积，档位对齐 relation 五档
   */
  function affToX(aff) {
    const a = aff == null ? BASE_AFF : aff;
    return r4(clamp((a - BASE_AFF) / ((1 - BASE_AFF) / 2), -2, 2));
  }
  function deltaFromA(a) {
    const x = clamp(a, -2, 2);
    const lo = Math.floor(x), hi = Math.ceil(x);
    if (lo === hi) return DELTA[String(lo)];
    const t = x - lo;
    return DELTA[String(lo)] * (1 - t) + DELTA[String(hi)] * t;
  }

  /** 一维卡尔曼更新；返回 { x, P, yUsed, K, robust } */
  function kfUpdate(prevKf, y, affHint) {
    let x = prevKf && prevKf.x != null && isFinite(prevKf.x) ? prevKf.x : affToX(affHint);
    let P = prevKf && prevKf.P != null && isFinite(prevKf.P) && prevKf.P > 0 ? prevKf.P : 1;
    const xPrior = x;
    const PPrior = P + KF_Q;
    let yUsed = y, robust = false;
    const gate = 3 * Math.sqrt(PPrior + KF_R);
    if (Math.abs(y - xPrior) > gate) {
      yUsed = xPrior + 0.5 * (y - xPrior);
      robust = true;
    }
    const K = PPrior / (PPrior + KF_R);
    const xPost = xPrior + K * (yUsed - xPrior);
    const PPost = (1 - K) * PPrior;
    return { x: r4(clamp(xPost, -2, 2)), P: r4(Math.max(PPost, 1e-6)), yUsed: r4(yUsed), K: r4(K), robust: robust, xPrior: r4(xPrior), PPrior: r4(PPrior) };
  }

  /** CUSUM 关系档：S 超 h 且当前档驻留 ≥ D 才升/降一档 */
  function cusumUpdate(prevCu, x, affHint) {
    const prev = prevCu || {};
    let sp = prev.sp || 0, sm = prev.sm || 0;
    let dwell = (prev.dwell != null ? prev.dwell : 0) + 1;
    let t = prev.tier != null ? prev.tier : tier(affHint != null ? affHint : BASE_AFF);
    t = clamp(t | 0, 1, 5);
    sp = Math.max(0, sp + (x - CUSUM_K_UP));
    sm = Math.max(0, sm + (CUSUM_K_DN - x));
    let changed = false;
    if (sp > CUSUM_H_UP && dwell >= CUSUM_D && t < 5) {
      t += 1; sp = 0; sm = 0; dwell = 0; changed = true;
    } else if (sm > CUSUM_H_DN && dwell >= CUSUM_D && t > 1) {
      t -= 1; sp = 0; sm = 0; dwell = 0; changed = true;
    }
    return { sp: r4(sp), sm: r4(sm), dwell: dwell, tier: t, changed: changed };
  }

  /** 自报 vs 正文语气一致性；返回 { wMul, inconsistent, hit } */
  function checkConsistency(assistantText, a, m) {
    const t = String(assistantText || '');
    if (!t) return { wMul: 1, inconsistent: false, hit: [] };
    const hit = [];
    const negMood = NEG_MOODS.includes(m);
    if (RX_CARE.test(t) && (a <= -1 || negMood)) {
      hit.push('inconsistent');
      return { wMul: KF_W_INCONSISTENT, inconsistent: true, hit: hit };
    }
    if (RX_REBUKE.test(t) && a >= 1) {
      hit.push('inconsistent');
      return { wMul: KF_W_INCONSISTENT, inconsistent: true, hit: hit };
    }
    return { wMul: 1, inconsistent: false, hit: [] };
  }

  /** 是否走 KF：默认 on；opts.estimator==='legacy' 或 settings/conv 关闭则回退 */
  function useKfEstimator(opts) {
    opts = opts || {};
    if (opts.estimator === 'legacy') return false;
    if (opts.estimator === 'kf') return true;
    const src = opts.settings || {};
    if (src.affectKf === false || src.affectEstimator === 'legacy') return false;
    if (opts.affectKf === false || opts.affectEstimator === 'legacy') return false;
    if (opts.conv && (opts.conv.affectKf === false || opts.conv.affectEstimator === 'legacy')) return false;
    return true;
  }

  /** 会话估计器：conv.affectEstimator 优先，其次 settings；仅 'kf'|'legacy' */
  function estimatorOf(conv, settings) {
    const e = (conv && conv.affectEstimator) || (settings && settings.affectEstimator);
    if (e === 'legacy' || e === 'kf') return e;
    if (conv && conv.affectKf === false) return 'legacy';
    if (settings && settings.affectKf === false) return 'legacy';
    return 'kf';
  }

  /**
   * KF 路径心情向量更新（设计：减少纯 INERTIA，用滤波状态驱动目标）。
   *
   * 算法：
   * 1) tg_m = mood∈TARGET ? TARGET[mood] : BASE_VEC（离散标签锚点，与 legacy 同）
   * 2) 由滤波 â=kf.x∈[-2,2] 推状态目标 tg_x：
   *      val = clamp(â/2, -1, 1)
   *      aro = clamp(BASE_VEC.aro + 0.4·|â|/2, 0, 1)   // |â| 大 → 唤醒略升
   * 3) 合成目标 tg = (1-α)·tg_m + α·tg_x，α=VEC_KF_ALPHA
   *    —— 标签仍主导方向，但 â 把目标从「纯自报 mood」往隐状态拉一截
   * 4) 步进增益 g = clamp(0.5·INERTIA + 0.5·K, G_MIN, G_MAX)
   *    K 来自本轮 kfUpdate；观测可信（K 较大）时更快跟上，尖峰被 robust 门控后 K 也不会让单轮跳飞
   * 5) vec ← vec + g·(tg−vec)；分类仍走 classify(..., prev) 滞回
   *
   * legacy / stepLegacy 不调用本函数，继续固定 INERTIA，兼容既有单测。
   */
  function vecStepKf(s0vec, mood, kf) {
    const prev = s0vec || BASE_VEC;
    const tgMood = (mood && TARGET[mood]) ? TARGET[mood] : BASE_VEC;
    const x = kf && kf.x != null && isFinite(kf.x) ? kf.x : 0;
    const tgX = {
      val: r4(clamp(x / 2, -1, 1)),
      aro: r4(clamp(BASE_VEC.aro + 0.4 * Math.abs(x) / 2, 0, 1))
    };
    const a = VEC_KF_ALPHA;
    const tg = {
      val: r4((1 - a) * tgMood.val + a * tgX.val),
      aro: r4((1 - a) * tgMood.aro + a * tgX.aro)
    };
    const K = kf && kf.K != null && isFinite(kf.K) ? kf.K : INERTIA;
    const g = r4(clamp(0.5 * INERTIA + 0.5 * K, VEC_KF_G_MIN, VEC_KF_G_MAX));
    return {
      vec: {
        val: r4(prev.val + g * (tg.val - prev.val)),
        aro: r4(prev.aro + g * (tg.aro - prev.aro))
      },
      tg: tg, g: g, tgMood: tgMood, tgX: tgX
    };
  }

  /** 面板短 hint：KF 状态（非调试墙） */
  function formatKfHint(st) {
    if (!st || !st.kf || st.kf.x == null) return '';
    const bits = ['â=' + Number(st.kf.x).toFixed(2), 'P=' + Number(st.kf.P != null ? st.kf.P : 0).toFixed(3)];
    const g = st.g || {};
    if (g.yT != null) bits.push('yT=' + Number(g.yT).toFixed(2));
    if (g.yModel != null) bits.push('yM=' + g.yModel);
    if (g.yLex != null) bits.push('yL=' + Number(g.yLex).toFixed(2));
    if (g.w != null) bits.push('w=' + Number(g.w).toFixed(2));
    if (g.robust) bits.push('robust');
    return bits.join(' · ');
  }

  /** 面板短 hint：CUSUM */
  function formatCusumHint(st) {
    if (!st || !st.cusum) return '';
    const c = st.cusum;
    return '档' + c.tier + '/5 · dwell=' + (c.dwell != null ? c.dwell : 0)
      + ' · S+=' + Number(c.sp || 0).toFixed(2) + ' · S-=' + Number(c.sm || 0).toFixed(2);
  }

  // ---- 多角色隔离（轻量 API，UI 不做）----
  function getAffectFor(conv, charId) {
    if (!conv) return null;
    const id = charId != null ? String(charId) : '';
    const own = (conv.affectBy && id && conv.affectBy[id]) || null;
    return blendAffect(own, conv.sceneMood);
  }
  function setAffectFor(conv, charId, state) {
    if (!conv || charId == null) return null;
    if (!conv.affectBy) conv.affectBy = {};
    conv.affectBy[String(charId)] = state;
    return state;
  }
  function setSceneMood(conv, scene) {
    if (!conv) return null;
    conv.sceneMood = scene;
    return scene;
  }
  /** 角色有效状态 = 自身 70% + 场景 30%（对 aff / vec 混合） */
  function blendAffect(own, scene) {
    if (!own && !scene) return null;
    if (!scene) return own ? Object.assign({}, own) : null;
    if (!own) {
      const s = Object.assign({}, scene);
      if (s.aff == null) s.aff = BASE_AFF;
      return s;
    }
    const aff = r4(CHAR_SELF_W * (own.aff != null ? own.aff : BASE_AFF) + CHAR_SCENE_W * (scene.aff != null ? scene.aff : BASE_AFF));
    const ov = own.vec || BASE_VEC, sv = scene.vec || BASE_VEC;
    const vec = {
      val: r4(CHAR_SELF_W * ov.val + CHAR_SCENE_W * sv.val),
      aro: r4(CHAR_SELF_W * ov.aro + CHAR_SCENE_W * sv.aro)
    };
    return Object.assign({}, own, { aff: aff, vec: vec, mood: classify(vec, own.mood), blended: true });
  }

  /**
   * 一轮更新。默认 KF 路径（§5.2）；opts.estimator==='legacy' 回退 stepLegacy。
   * opts.assistantText：assistant 正文（已剥 state）供一致性校验。
   * opts.clock / opts.turn：与 decay 一致。
   */
  function step(prev, parsed, userText, now, opts) {
    opts = opts || {};
    if (!useKfEstimator(opts)) return stepLegacy(prev, parsed, userText, now, opts);

    const clock = opts.clock === 'turn' ? 'turn' : 'wall';
    const turnNow = clock === 'turn'
      ? (opts.turn != null ? opts.turn : ((prev && prev.turn != null ? prev.turn : 0) + 1))
      : undefined;
    const s0 = decay(prev, now, { clock, turn: clock === 'turn' ? turnNow : undefined });
    const day = dayKey(now);
    let net = prev && prev.g && prev.g.day === day ? prev.g.net || 0 : 0;

    let forcedMissing = false;
    let guardHitForced = null;
    let parsedUse = parsed;

    if (parsedUse == null) {
      const gd0 = guard(0, null, userText, Object.assign({}, opts, { why: null, missingState: true }));
      const forced = gd0.hit.some(h => h === 'abuse' || h === 'boundary' || h === 'abuse_dark' || h === 'boundary_dark' || h === 'boundary_nsfw');
      if (!forced) {
        const out = { v: 1, aff: s0.aff, vec: s0.vec, mood: s0.mood, ts: now, a: null, m: null,
          g: { day: day, net: net, guard: gd0.hit }, p: 'missing_state', stateMissing: true,
          kf: prev && prev.kf ? Object.assign({}, prev.kf) : { x: affToX(s0.aff), P: 1 },
          cusum: prev && prev.cusum ? Object.assign({}, prev.cusum) : { sp: 0, sm: 0, dwell: 0, tier: tier(s0.aff) } };
        if (clock === 'turn') out.turn = turnNow;
        return out;
      }
      parsedUse = { a: gd0.a, m: gd0.m };
      forcedMissing = true;
      guardHitForced = gd0.hit;
    }

    const gd = forcedMissing
      ? { a: parsedUse.a, m: parsedUse.m, hit: guardHitForced || [] }
      : guard(parsedUse.a, parsedUse.m, userText, Object.assign({}, opts, { why: parsedUse.why }));
    const a = gd.a, m = gd.m;

    const cons = checkConsistency(opts.assistantText, a, m);
    const guardHit = gd.hit.slice();
    if (cons.inconsistent) guardHit.push('inconsistent');

    const yModel = a;
    const yLex = lexiconScore(userText);
    const why = parsedUse.why;
    const founded = why ? jaccard(why, userText) >= WHY_TH : false;
    let w = founded ? KF_W_WHY : KF_W;
    w *= cons.wMul;
    const yT = r4(w * yModel + (1 - w) * yLex);

    const kf = kfUpdate(prev && prev.kf, yT, s0.aff);
    let d = deltaFromA(kf.x);
    if (d > 0) { d *= (1 - s0.aff) / (1 - BASE_AFF); d = Math.max(0, Math.min(d, DAILY_GAIN_CAP - net)); }
    else if (d < 0) d *= NEG_MULT;
    const aff = clamp(s0.aff + d, 0, 1);
    net = r4(net + (aff - s0.aff));

    // vec：KF 路径用滤波 â + K 驱动（见 vecStepKf）；不再纯 INERTIA
    const vs = vecStepKf(s0.vec, m, kf);
    const vec = vs.vec;
    const cu = cusumUpdate(prev && prev.cusum, kf.x, s0.aff);
    const whyLoc = parsedUse.why ? locateWhy(parsedUse.why, userText) : null;
    const hardGuard = guardHit.some(h => !/^why:/.test(h) && h !== 'inconsistent');
    const pBase = forcedMissing ? 'missing_state+guard' : (hardGuard ? 'model+guard' : 'model');
    const out = { v: 1, aff: r4(aff), vec: vec, mood: classify(vec, s0.mood), ts: now, a: a, m: m,
      g: { day: day, net: net, guard: guardHit, inconsistent: !!cons.inconsistent, w: r4(w), yModel: yModel, yLex: yLex, yT: yT, robust: !!kf.robust, vecG: vs.g },
      p: pBase + '+kf',
      stateMissing: !!forcedMissing, explicitNeutral: a === 0,
      kf: { x: kf.x, P: kf.P, K: kf.K },
      cusum: { sp: cu.sp, sm: cu.sm, dwell: cu.dwell, tier: cu.tier } };
    if (parsedUse.why) out.why = parsedUse.why;
    if (whyLoc) out.whyLoc = whyLoc;
    if (clock === 'turn') out.turn = turnNow;
    return out;
  }

  /** 轻量步进：无模型 <state> 时只走衰减 / 护栏强迫路径，不强制跑 KF（step 内已有此分支）。 */
  function stepLight(prev, userText, now, opts) {
    return step(prev, null, userText, now, opts);
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
    KF_Q, KF_R, KF_W, KF_W_WHY, KF_W_INCONSISTENT, CUSUM_K_UP, CUSUM_K_DN, CUSUM_H_UP, CUSUM_H_DN, CUSUM_D, CHAR_SELF_W, CHAR_SCENE_W, VEC_KF_ALPHA, VEC_KF_G_MIN, VEC_KF_G_MAX,
    tier, tierLabel, relationOf, classify, decay, parseState, renderTag, tagOf, invalidateFrom, series, sparkline, jaccard, directText, hitLevel, modeOf, clockOf, MODES, WHY_TH, stripState, stripContent, guard, step, stepLight, stepLegacy, locateWhy, latest, fixedProtocol, renderInjection, applyToMessages, dayKey, textOf,
    lexiconScore, kfUpdate, cusumUpdate, checkConsistency, useKfEstimator, estimatorOf, vecStepKf, formatKfHint, formatCusumHint, affToX, deltaFromA,
    getAffectFor, setAffectFor, setSceneMood, blendAffect,
    missingStats, shouldDemoState, rebuildStateTag, guardStats, affectSnapshots };

  // ---------------- 插件 ----------------
  const reg = root.Plugins && root.Plugins.registry;
  if (reg) {
    const ID = 'affect';
    reg.register({
      id: ID, icon: '💓', name: '好感度 / 心情', version: '1.3.0', perConversation: false, defaultEnabled: true,
      desc: '模型每轮自报 <state>{"a","m"}</state>。v1.3：KF 路径 vec 由滤波 â/K 驱动（减少纯 INERTIA）；面板 KF/CUSUM 短 hint + KF/旧版开关；v1.2 起含 KF+CUSUM+词典+一致性；estimator=legacy 可回退。',
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
          const est = estimatorOf(ctx.conv, ctx.settings);
          const asstText = textOf(bot.content);
          bot.affect = step(prev, parsed, textOf(ctx.lastUser && ctx.lastUser.content), Date.now(), {
            mode: modeOf(ctx.conv), clock, turn, estimator: est, assistantText: asstText, settings: ctx.settings, conv: ctx.conv
          });
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
        const settings = host.settings ? host.settings() : (host.getSettings ? host.getSettings() : null);
        const est = estimatorOf(conv, settings);
        if (!lt) {
          box.innerHTML = '<div class="hint">本对话还没有好感 / 心情状态（模型回复末尾输出 &lt;state&gt; 后出现）。</div>' +
            '<label class="field inline"><span>估计器<small>KF=隐状态平滑；旧版=DELTA/INERTIA</small></span><select class="af-est">' +
            '<option value="kf"' + (est === 'kf' ? ' selected' : '') + '>KF</option>' +
            '<option value="legacy"' + (est === 'legacy' ? ' selected' : '') + '>旧版</option></select></label>';
          box.querySelector('.af-est').onchange = e => {
            conv.affectEstimator = e.target.value; host.saveConv(conv);
            host.toast('估计器：' + (e.target.value === 'kf' ? 'KF' : '旧版'));
            this.renderPanel(box, host);
          };
          return;
        }
        const clock = clockOf(conv);
        const turn = clock === 'turn' ? (lt.turn || 0) : undefined;
        const s = decay(lt, Date.now(), { clock, turn });
        const md = modeOf(conv), sp = sparkline(series(conv, 30));
        const ms = missingStats(conv), gs = guardStats(conv);
        const rel = relationOf(s);
        const kfHint = formatKfHint(lt), cuHint = formatCusumHint(lt);
        const tierShow = (lt.cusum && lt.cusum.tier != null) ? lt.cusum.tier : tier(s.aff);
        box.innerHTML = '<div class="hint">当前心情：' + host.esc(s.mood) + ' · 好感 ' + s.aff.toFixed(3) + '（' + host.esc(rel) + ' · 档 ' + tierShow + '/5）· 时钟 ' + clock + ' · 估计器 ' + est + '</div>' +
          (sp ? '<div class="hint">好感走势（近 30 轮，虚线 = 基线）<br>' + sp + '</div>' : '') +
          (lt.why ? '<div class="hint">依据：' + host.esc(lt.why) + '</div>' : '') +
          (kfHint ? '<div class="hint">KF：' + host.esc(kfHint) + '</div>' : '') +
          (cuHint ? '<div class="hint">CUSUM：' + host.esc(cuHint) + '</div>' : '') +
          '<div class="hint">漏标率：' + ms.missing + '/' + ms.total + (ms.total ? '（' + Math.round(ms.rate * 100) + '%）' : '') +
          ' · 护栏：强制 ' + gs.hardCount + ' / soft ' + gs.softCount +
          (Object.keys(gs.all).length ? '（' + host.esc(Object.keys(gs.all).map(k => k + '×' + gs.all[k]).join(', ')) + '）' : '') + '</div>' +
          '<label class="field inline"><span>估计器<small>KF=隐状态平滑；旧版=DELTA/INERTIA。写入本对话</small></span><select class="af-est">' +
          '<option value="kf"' + (est === 'kf' ? ' selected' : '') + '>KF</option>' +
          '<option value="legacy"' + (est === 'legacy' ? ' selected' : '') + '>旧版</option></select></label>' +
          '<label class="field inline"><span>护栏档位<small>黑暗向：越界词不强制；辱骂在模型 a≥0 时 soft。剧情引用不触发</small></span><select class="af-mode">' +
          MODES.map(x => '<option value="' + x + '"' + (x === md ? ' selected' : '') + '>' + ({ normal: '标准', dark: '黑暗向', nsfw: 'NSFW' }[x]) + '</option>').join('') + '</select></label>' +
          '<div class="hint">最近一轮：a=' + lt.a + ' · m=' + host.esc(lt.m || '-') + ' · 来源 ' + host.esc(lt.p || '-') + (lt.g && lt.g.guard && lt.g.guard.length ? ' · 护栏 ' + host.esc(lt.g.guard.join(',')) : '') + (lt.g ? ' · 今日净增 ' + (lt.g.net || 0).toFixed(3) : '') + '</div>' +
          '<div class="hint">注入示例（user 头）：<br><code>' + host.esc(renderTag(s)) + '</code></div>' +
          '<div class="hint">固定协议（system）：<br><code>' + host.esc(fixedProtocol()) + '</code></div>' +
          '<button class="chip-btn af-reset">重置本对话状态</button>';
        box.querySelector('.af-est').onchange = e => {
          conv.affectEstimator = e.target.value; host.saveConv(conv);
          host.toast('估计器：' + (e.target.value === 'kf' ? 'KF' : '旧版'));
          this.renderPanel(box, host);
        };
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
