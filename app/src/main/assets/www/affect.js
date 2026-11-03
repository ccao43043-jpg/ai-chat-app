/* 好感度 / 心情（affect，v0.14.0）：取代旧 liveliness 关键词规则引擎。
 * 状态挂在 assistant 消息上：bot.affect = { v:1, aff, vec:{val,aro}, mood, ts, a, m, g, p }
 *   最新有效状态 = 最新一条带 affect 的 assistant 消息（显示前按 ts 衰减）。
 * 模型协议：回复最末尾单独一行 <state>{"a":1,"m":"开心"}</state>，a∈{-2..2}，m∈MOODS；解析后从正文剥离。
 * 缓存零侵入：不改 system（Gemini static_hash 不变）；只把一行离散标签前置到【本轮】user 消息开头，
 *   且首发时冻结在该 user 消息上（affectInj），之后回放/重新生成逐字节不变；历史 assistant 回放前剥离 <state>。
 * 纯逻辑可在 Node 中测试。
 */
(function (root) {
  'use strict';
  // ---- 常量（单测钉死）----
  const BASE_AFF = 0.30;                 // 好感基线
  const AFF_HALF_LIFE = 3 * 86400;       // 好感半衰期 3 天（秒）
  const MOOD_HALF_LIFE = 3600;           // 心情向量半衰期 1 小时（秒）
  const BASE_VEC = { val: 0, aro: 0.20 };// 心情基线（valence, arousal）
  const DELTA = { '-2': -0.12, '-1': -0.05, '0': 0, '1': 0.04, '2': 0.08 }; // a → 原始 Δaff
  const NEG_MULT = 1.25;                 // 不对称：负向放大 1.25 倍（更容易掉）
  // 饱和：正向 Δ × (1-aff)/(1-BASE_AFF)，aff 越高越难涨（aff=0.3 时 ×1，aff=0.9 时 ×≈0.14）
  const DAILY_GAIN_CAP = 0.15;           // 每「本地自然日」净正增益上限（按设备本地时区日期 YYYY-MM-DD 计）
  const INERTIA = 0.5;                   // 心情惯性：vec 每轮向目标点移动 50%
  const HYS = 0.12;                      // 滞回：新标签须比当前标签近 HYS 以上才切换
  const TIER_TH = [0.15, 0.35, 0.55, 0.75]; // aff → 档位 1–5
  const MOODS = ['平静', '开心', '兴奋', '害羞', '不悦', '低落', '愤怒'];
  const TARGET = { '平静': { val: 0, aro: 0.20 }, '开心': { val: 0.6, aro: 0.45 }, '兴奋': { val: 0.7, aro: 0.85 }, '害羞': { val: 0.3, aro: 0.6 },
    '不悦': { val: -0.4, aro: 0.5 }, '低落': { val: -0.6, aro: 0.15 }, '愤怒': { val: -0.75, aro: 0.9 } };
  const NEG_MOODS = ['不悦', '低落', '愤怒'];
  // 护栏：轻量关键词检测用户本轮话（只用于强制负向 / 校验 +2 依据，不再产生事件增量）
  const RX_BOUNDARY = /(脱光|裸照|发.{0,3}(裸|色)图|约炮|强奸|nude|nsfw)/i;
  const RX_ABUSE = /(滚|闭嘴|傻[逼比Bb]|\bsb\b|蠢货|白痴|废物|去死|垃圾|弱智|脑残|shut up|stupid|idiot|fuck)/i;
  const RX_PRAISE = /(谢谢|感谢|你真(好|棒|厉害|可爱|聪明|美|贴心)|好可爱|喜欢你|爱你|太棒了|你最好|抱抱|亲亲|想你|love you|thank|you'?re (great|amazing|cute|sweet))/i;

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const r4 = x => Math.round(x * 1e4) / 1e4;
  const dk = (b, v, hl, dt) => dt <= 0 ? v : b + (v - b) * Math.pow(0.5, dt / hl);
  const dayKey = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  const tier = aff => { let t = 1; TIER_TH.forEach(th => { if (aff >= th) t++; }); return t; };
  const dist = (v, m) => Math.hypot(v.val - TARGET[m].val, v.aro - TARGET[m].aro);
  /** vec → 离散心情，带滞回 */
  function classify(vec, prev) {
    let best = MOODS[0]; MOODS.forEach(m => { if (dist(vec, m) < dist(vec, best)) best = m; });
    if (prev && TARGET[prev] && prev !== best && dist(vec, prev) - dist(vec, best) <= HYS) return prev;
    return best;
  }
  function baseState(now) { return { v: 1, aff: BASE_AFF, vec: Object.assign({}, BASE_VEC), mood: '平静', ts: now }; }
  /** 按 ts 衰减到 now（ms）；返回新对象 */
  function decay(st, now) {
    if (!st) return baseState(now);
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
    return { a: clamp(a, -2, 2), m: MOODS.includes(o.m) ? o.m : null };
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

  /** 护栏：返回修正后的 a/m 与命中的规则 */
  function guard(a, m, userText) {
    const u = String(userText || ''), hit = [];
    if (RX_BOUNDARY.test(u)) { a = -2; hit.push('boundary'); if (!NEG_MOODS.includes(m)) m = '愤怒'; }
    else if (RX_ABUSE.test(u)) { if (a > -1) a = -1; hit.push('abuse'); if (!NEG_MOODS.includes(m)) m = '不悦'; }
    else if (a === 2 && !RX_PRAISE.test(u)) { a = 1; hit.push('a2_unfounded'); }
    return { a, m, hit };
  }
  /** 一轮更新：prev（上一快照，可空）+ 解析结果（可空）+ 用户本轮话 → 新快照 */
  function step(prev, parsed, userText, now) {
    const s = decay(prev, now);
    const gd = guard(parsed ? parsed.a : 0, parsed ? parsed.m : null, userText);
    const a = gd.a, m = gd.m;
    const day = dayKey(now);
    let net = prev && prev.g && prev.g.day === day ? prev.g.net || 0 : 0;
    let d = DELTA[String(a)];
    if (d > 0) { d *= (1 - s.aff) / (1 - BASE_AFF); d = Math.max(0, Math.min(d, DAILY_GAIN_CAP - net)); }
    else if (d < 0) d *= NEG_MULT;
    const aff = clamp(s.aff + d, 0, 1);
    net = r4(net + (aff - s.aff));
    const tg = m ? TARGET[m] : BASE_VEC;
    const vec = { val: r4(s.vec.val + INERTIA * (tg.val - s.vec.val)), aro: r4(s.vec.aro + INERTIA * (tg.aro - s.vec.aro)) };
    return { v: 1, aff: r4(aff), vec, mood: classify(vec, s.mood), ts: now, a, m, g: { day, net, guard: gd.hit }, p: parsed ? (gd.hit.length ? 'model+guard' : 'model') : (gd.hit.length ? 'guard' : 'none') };
  }
  /** 最新有效状态（可传 before：只看该消息之前） */
  function latest(conv, before) {
    const ms = (conv && conv.messages) || [];
    let end = before ? ms.indexOf(before) : ms.length; if (end < 0) end = ms.length;
    for (let i = end - 1; i >= 0; i--) if (ms[i] && ms[i].role === 'assistant' && ms[i].affect) return ms[i].affect;
    return null;
  }
  const PROTOCOL = '[AFFECT_RULE] 回复最末尾单独一行输出 <state>{"a":好感变化-2~2整数,"m":"' + MOODS.join('|') + '"}</state>，正文不要提及该标签或状态。';
  function renderInjection(st) { return '[AFFECT] mood=' + st.mood + ' aff_tier=' + tier(st.aff) + '\n' + PROTOCOL; }

  /** 改写请求消息：历史 assistant 剥离 <state>；历史 user 回放冻结的注入；本轮 user 前置注入（首发冻结） */
  function applyToMessages(msgs, lastUser, inj) {
    let idx = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { idx = i; break; }
    return msgs.map((m, i) => {
      if (m.role === 'assistant') return Object.assign({}, m, { content: stripContent(m.content) });
      if (m.role !== 'user') return m;
      const src = m._src;
      let add = null;
      if (i === idx) add = (lastUser && lastUser.affectInj) || inj;
      else if (src && src.affectInj) add = src.affectInj;
      if (!add || textOf(m.content).startsWith(add)) return m;
      return Object.assign({}, m, { content: prependToContent(m.content, add) });
    });
  }

  const Affect = { BASE_AFF, AFF_HALF_LIFE, MOOD_HALF_LIFE, BASE_VEC, DELTA, NEG_MULT, DAILY_GAIN_CAP, INERTIA, HYS, TIER_TH, MOODS, TARGET,
    tier, classify, decay, parseState, stripState, stripContent, guard, step, latest, renderInjection, applyToMessages, dayKey, textOf };

  // ---------------- 插件 ----------------
  const reg = root.Plugins && root.Plugins.registry;
  if (reg) {
    const ID = 'affect';
    reg.register({
      id: ID, icon: '💓', name: '好感度 / 心情', version: '1.0.0', perConversation: false, defaultEnabled: true,
      desc: '模型每轮在回复末尾自报 <state>{"a","m"}</state>（好感变化 + 心情），客户端解析后剥离并写入该条回复：好感半衰期 3 天、心情 1 小时回归基线，正向饱和、负向更易、每日净增益上限 0.15，辱骂/越界强制负向、无依据的 +2 降为 +1，心情带惯性与滞回。系统提示词与历史不变，只在本轮用户消息开头加一行离散标签，对 Gemini / DeepSeek 缓存零侵入。',
      hooks: {
        onBeforeRequest(ctx) {
          const msgs = ctx.messages || [];
          if (!msgs.some(m => m.role === 'user')) return ctx;
          const now = Date.now();
          const st = decay(latest(ctx.conv), now);
          const inj = renderInjection(st);
          if (ctx.lastUser && !ctx.lastUser.affectInj) ctx.lastUser.affectInj = inj; // 首发冻结：重新生成逐字节不变
          ctx.messages = applyToMessages(msgs, ctx.lastUser, inj);
          ctx.meta.affect = { injection: (ctx.lastUser && ctx.lastUser.affectInj) || inj };
          return ctx;
        },
        onAfterResponse(result, ctx, host) {
          const bot = result && result.bot; if (!bot) return;
          const raw = textOf(bot.content);
          const parsed = parseState(raw);
          bot.content = stripContent(bot.content);
          if (!result.ok) return;
          bot.affect = step(latest(ctx.conv, bot), parsed, textOf(ctx.lastUser && ctx.lastUser.content), Date.now());
          if (host && host.saveConv) host.saveConv(ctx.conv);
        },
        headerBadges(conv, host) {
          const lt = latest(conv); if (!lt) return [];
          const s = decay(lt, Date.now()), t = tier(s.aff);
          return [{ text: s.mood + ' · ' + t, tone: t <= 2 ? 'warn' : 'info', title: '心情 ' + s.mood + ' · 好感档 ' + t + '（aff ' + s.aff.toFixed(2) + '）', action: () => host.openPanel(ID), kind: 'mood' }];
        },
      },
      renderPanel(box, host) {
        const conv = host.conv(), lt = latest(conv);
        if (!lt) { box.innerHTML = '<div class="hint">本对话还没有好感 / 心情状态（模型回复末尾输出 &lt;state&gt; 后出现）。</div>'; return; }
        const s = decay(lt, Date.now());
        box.innerHTML = '<div class="hint">当前心情：' + host.esc(s.mood) + ' · 好感 ' + s.aff.toFixed(3) + '（档位 ' + tier(s.aff) + '/5）</div>' +
          '<div class="hint">最近一轮：a=' + lt.a + ' · m=' + host.esc(lt.m || '-') + ' · 来源 ' + host.esc(lt.p || '-') + (lt.g && lt.g.guard && lt.g.guard.length ? ' · 护栏 ' + host.esc(lt.g.guard.join(',')) : '') + (lt.g ? ' · 今日净增 ' + (lt.g.net || 0).toFixed(3) : '') + '</div>' +
          '<div class="hint">注入示例：<br><code>' + host.esc(renderInjection(s)).replace(/\n/g, '<br>') + '</code></div>' +
          '<button class="chip-btn af-reset">重置本对话状态</button>';
        box.querySelector('.af-reset').onclick = () => {
          (conv.messages || []).forEach(m => { delete m.affect; });
          host.saveConv(conv); host.toast('已重置'); this.renderPanel(box, host);
        };
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Affect;
  root.Affect = Affect;
})(typeof window !== 'undefined' ? window : globalThis);
