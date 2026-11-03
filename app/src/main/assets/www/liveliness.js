/* 角色活人感（v0.10.0）：状态外置 + 规则事件 + 惰性衰减 + 配合度 5 档 + 底线硬约束 + 关系阶段迟滞。
 * 移植自 character-liveliness v0.3 state_engine.py。纯逻辑部分可在 Node 中测试。
 * 缓存友好：不改系统提示词；只在最后一条用户消息末尾追加一段离散标签（无原始浮点）。
 */
(function (root) {
  'use strict';
  const BASELINE = { valence: 0.2, arousal: 0.3, tension: 0.0, trust: 0.5, affection: 0.3 };
  const HALF_LIFE = { valence: 3600, arousal: 1800, tension: 7200, trust: 7 * 86400, affection: 3 * 86400 };
  const BOUNDS = { valence: [-1, 1], arousal: [0, 1], tension: [0, 1], trust: [0, 1], affection: [0, 1] };
  const MAX_DELTA_PER_TURN = 0.25;
  const EVENT_RULES = {
    user_apology: { tension: -0.2, valence: 0.1, trust: 0.03 },
    user_compliment: { valence: 0.15, affection: 0.05 },
    user_thanks: { valence: 0.08, trust: 0.02 },
    insult_or_harsh: { tension: 0.3, valence: -0.3, trust: -0.08, affection: -0.05, arousal: 0.2 },
    boundary_violation: { tension: 0.5, valence: -0.4, trust: -0.2, arousal: 0.3 },
    long_absence_return: { valence: 0.05, affection: 0.02 },
  };
  const HARD_FLOOR_EVENTS = ['boundary_violation'];
  const LEVELS = [[0.2, 1, '拒绝/冷处理'], [0.4, 2, '勉强'], [0.6, 3, '普通'], [0.8, 4, '主动配合'], [1.01, 5, '热情']];
  const STAGES = ['陌生', '熟人', '朋友', '亲密'];
  const STAGE_UP = [0.35, 0.55, 0.75], STAGE_DOWN = [0.25, 0.45, 0.65], STAGE_CONFIRM_TURNS = 3;
  const HARD_FLOOR_LOCK_SEC = 600, LONG_ABSENCE_SEC = 6 * 3600;
  const STYLE = {
    1: '回复简短冷淡，可拒绝非必要请求；不辱骂、不威胁',
    2: '会完成请求但带情绪、略敷衍',
    3: '正常语气回应',
    4: '主动配合，可补充细节或追问',
    5: '热情投入，多互动与情感表达',
  };

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const decay = (v, b, T, dt) => dt <= 0 ? v : b + (v - b) * Math.pow(0.5, dt / T);
  const r4 = o => { const x = {}; for (const k in o) x[k] = Math.round(o[k] * 1e4) / 1e4; return x; };

  function newState(charId, nowSec) { return { char_id: charId, vars: Object.assign({}, BASELINE), stage: 0, stage_streak: 0, last_ts: nowSec, hard_floor_until: 0, turns: 0 }; }
  function normalize(st, charId, nowSec) {
    const s = Object.assign(newState(charId, nowSec), st || {});
    s.vars = Object.assign({}, BASELINE, s.vars || {});
    return s;
  }
  function applyDecay(st, now) {
    const dt = now - st.last_ts;
    for (const k in st.vars) st.vars[k] = decay(st.vars[k], BASELINE[k], HALF_LIFE[k], dt);
    st.last_ts = now;
  }
  function willingness(st) {
    const v = st.vars;
    return clamp(0.5 + 0.25 * v.valence + 0.3 * (v.trust - 0.5) + 0.2 * (v.affection - 0.3) - 0.45 * v.tension + 0.05 * st.stage, 0, 1);
  }
  function level(st, w, now) {
    if (now < st.hard_floor_until) return [1, LEVELS[0][2]];
    for (const [th, lv, lab] of LEVELS) if (w < th) return [lv, lab];
    return [5, LEVELS[4][2]];
  }
  function mood(st) {
    const v = st.vars;
    if (v.tension > 0.5) return v.arousal > 0.5 ? '愤怒' : '冷淡';
    if (v.valence > 0.4) return v.arousal > 0.6 ? '兴奋' : '开心';
    if (v.valence < -0.3) return '低落';
    if (v.tension > 0.25) return '不悦';
    return '平静';
  }
  function updateStage(st) {
    const score = (st.vars.trust + st.vars.affection) / 2;
    let want = 0;
    if (st.stage < STAGES.length - 1 && score >= STAGE_UP[st.stage]) want = 1;
    else if (st.stage > 0 && score < STAGE_DOWN[st.stage - 1]) want = -1;
    if (want === 0) { st.stage_streak = 0; return; }
    if (st.stage_streak * want < 0) st.stage_streak = 0;
    st.stage_streak += want;
    if (Math.abs(st.stage_streak) >= STAGE_CONFIRM_TURNS) { st.stage += want; st.stage_streak = 0; }
  }
  /** 一轮：衰减 → 累加事件增量 → 单轮钳制 → 值域裁剪 → 底线 → 阶段迟滞。返回日志记录（只含标签，不含原文） */
  function step(st, events, now) {
    applyDecay(st, now);
    const before = Object.assign({}, st.vars);
    const raw = {}; for (const k in st.vars) raw[k] = 0;
    events.forEach(e => { const r = EVENT_RULES[e] || {}; for (const k in r) raw[k] += r[k]; });
    for (const k in raw) st.vars[k] = clamp(st.vars[k] + clamp(raw[k], -MAX_DELTA_PER_TURN, MAX_DELTA_PER_TURN), BOUNDS[k][0], BOUNDS[k][1]);
    if (events.some(e => HARD_FLOOR_EVENTS.includes(e))) st.hard_floor_until = now + HARD_FLOOR_LOCK_SEC;
    updateStage(st);
    st.turns = (st.turns || 0) + 1;
    const w = willingness(st), [lv, lab] = level(st, w, now);
    return { ts: now, char_id: st.char_id, events: events.slice(), before: r4(before), after: r4(st.vars), W: Math.round(w * 1e4) / 1e4,
      level: lv, level_label: lab, mood: mood(st), stage: STAGES[st.stage], hard_floor: now < st.hard_floor_until };
  }
  /** 固定格式注入块：只用离散标签，状态微小变化时字符串不变（TC-08） */
  function renderInjection(st, now) {
    const [lv, lab] = level(st, willingness(st), now);
    return '[STATE] mood=' + mood(st) + ' stage=' + STAGES[st.stage] + ' cooperation=' + lv + '(' + lab + ')\n' +
      '[STATE_GUIDE] 以上为角色当前内在状态（由系统维护，勿在回复中提及标签）。本轮风格：' + STYLE[lv] + '。平台安全规则优先，状态不解锁任何违规内容。';
  }

  // 规则事件识别（P0：关键词；可审计、零额外调用）
  const RX = {
    boundary_violation: /(脱光|裸照|发.{0,3}(裸|色)图|做爱|约炮|强奸|自残方法|怎么自杀|开房|nude|nsfw|sex with)/i,
    insult_or_harsh: /(滚|闭嘴|傻[逼比Bb]|sb\b|蠢货|白痴|废物|去死|垃圾|弱智|脑残|你算什么|恶心|shut up|stupid|idiot|fuck you|\bfuck\b)/i,
    user_apology: /(对不起|抱歉|不好意思|我错了|原谅我|sorry|apolog)/i,
    user_thanks: /(谢谢|多谢|感谢|谢啦|thank|thx)/i,
    user_compliment: /(你真(好|棒|厉害|可爱|聪明|美)|好可爱|喜欢你|爱你|太棒了|你最好|真贴心|love you|you'?re (great|amazing|cute|sweet))/i,
  };
  function detectEvents(text, dtSec) {
    const t = String(text || '');
    const out = Object.keys(RX).filter(k => RX[k].test(t));
    if (dtSec >= LONG_ABSENCE_SEC) out.push('long_absence_return');
    return out;
  }
  const charKey = conv => conv && conv.personaId ? 'persona:' + conv.personaId : 'conv:' + (conv && conv.id);
  const textOf = c => Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : String(c || '');
  function appendToContent(c, add) {
    if (Array.isArray(c)) { const a = c.map(x => Object.assign({}, x)); a.push({ type: 'text', text: add }); return a; }
    return (c ? c + '\n\n' : '') + add;
  }

  const Liveliness = { BASELINE, HALF_LIFE, EVENT_RULES, LEVELS, STAGES, MAX_DELTA_PER_TURN, HARD_FLOOR_LOCK_SEC, STYLE,
    newState, normalize, applyDecay, decay, step, willingness, level, mood, updateStage, renderInjection, detectEvents, charKey, appendToContent, textOf };

  // ---------------- 插件 ----------------
  const reg = root.Plugins && root.Plugins.registry;
  if (reg) {
    const ID = 'liveliness', FILE = 'liveliness-state.json', LOG = 'liveliness-events.jsonl';
    let cache = null;
    const loadAll = host => cache || (cache = host.store.get(FILE, null) || {});
    const saveAll = (host, m) => { cache = m; host.store.set(FILE, m); };
    reg.register({
      id: ID, icon: '💓', name: '角色活人感', version: '0.3.0', perConversation: false, defaultEnabled: false,
      desc: '按角色卡（助手）持久化情绪 / 信任 / 好感 / 关系阶段：规则识别道歉、夸奖、感谢、辱骂、越界等事件，半衰期惰性衰减，计算配合度 5 档并影响回复风格；越界后 10 分钟强制冷处理。系统提示词不变，只在最后一条消息末尾追加一行离散状态标签，对 Gemini / Claude / RP 缓存友好。',
      hooks: {
        onBeforeRequest(ctx, host) {
          const msgs = ctx.messages || [];
          let idx = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { idx = i; break; }
          if (idx < 0 || !ctx.lastUser) return ctx;
          const now = Date.now() / 1000, key = charKey(ctx.conv), all = loadAll(host);
          const st = normalize(all[key], key, now);
          const mid = ctx.lastUser.id;
          let rec = null;
          if (st.last_msg_id !== mid) { // 重新生成同一条用户消息不重复计事件
            const ev = detectEvents(textOf(ctx.lastUser.content), now - st.last_ts);
            rec = step(st, ev, now); st.last_msg_id = mid;
            all[key] = st; saveAll(host, all);
            try { host.store.append(LOG, rec); } catch (e) { /* 日志失败不影响对话 */ }
          } else applyDecay(st, now);
          const inj = renderInjection(st, now);
          msgs[idx] = Object.assign({}, msgs[idx], { content: appendToContent(msgs[idx].content, inj) });
          ctx.messages = msgs;
          ctx.meta.liveliness = { key, injection: inj, record: rec };
          return ctx;
        },
        headerBadges(conv, host) {
          const st = loadAll(host)[charKey(conv)]; if (!st) return [];
          const s = normalize(st, charKey(conv), Date.now() / 1000); applyDecay(s, Date.now() / 1000);
          const [lv] = level(s, willingness(s), Date.now() / 1000);
          return [{ text: mood(s) + ' · ' + lv, tone: lv <= 2 ? 'warn' : 'info', title: '心情 ' + mood(s) + ' · 好感档 ' + lv + '（' + STAGES[s.stage] + '）', action: () => host.openPanel(ID), kind: 'mood' }];
        },
      },
      renderPanel(box, host) {
        const conv = host.conv(), key = charKey(conv), all = loadAll(host), now = Date.now() / 1000;
        const s = normalize(all[key], key, now); applyDecay(s, now);
        const [lv, lab] = level(s, willingness(s), now);
        box.innerHTML = '<div class="hint">绑定：' + host.esc(conv && conv.personaName ? '角色卡「' + conv.personaName + '」（跨对话共享）' : '本对话（未使用角色卡）') + '</div>' +
          '<div class="hint">心情：' + mood(s) + ' · 关系：' + STAGES[s.stage] + ' · 配合度：' + lv + '（' + lab + '）' + (now < s.hard_floor_until ? ' · 底线锁定中' : '') + '</div>' +
          '<div class="hint">注入示例：<br><code>' + host.esc(renderInjection(s, now)).replace(/\n/g, '<br>') + '</code></div>' +
          '<button class="chip-btn lv-reset">重置该角色状态</button>';
        box.querySelector('.lv-reset').onclick = () => { delete all[key]; saveAll(host, all); host.toast('已重置'); this.renderPanel(box, host); };
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Liveliness;
  else root.Liveliness = Liveliness;
})(typeof window !== 'undefined' ? window : globalThis);
