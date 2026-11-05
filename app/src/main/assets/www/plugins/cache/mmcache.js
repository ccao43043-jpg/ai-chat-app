/**
 * mmcache.js — MiniMax 提示缓存命中优化（仅 OpenRouter + minimax/* 模型）。
 * MiniMax prompt-cache hit optimiser for OpenRouter. Pure logic is Node-testable; registration only in browser.
 *
 * 研究结论（2026-11，来源见 docs/plugins/minimax-cache.md）：
 *  - MiniMax 官方：自动（被动）缓存，按「tools → system → messages」前缀匹配；≥512 输入 Token 才缓存；
 *    无单独写入费；过期时间随负载变化（无固定 TTL）；支持 M3.1-Flash / M3 / M2.7 / M2.5 / M2.1。
 *  - 显式 cache_control 仅 MiniMax 自家 Anthropic 兼容端点、且支持表只列 M2.x（不含 M3 / M3.1-Flash）；
 *    OpenRouter 提示缓存文档没有 MiniMax 段落 → 证据不足，本插件 **不发送 cache_control**。
 *  - OpenRouter：session_id 作为 sticky routing 键（首轮即生效，10 分钟无活动过期）；provider.order 会关闭 sticky。
 *  - OpenRouter 价目：m3.1-flash 读 0.1x、m3 0.2x、m2.7 0.2x、m2.5 ≈0.11x 输入价；未列写入价（按普通输入计）。
 * 因此策略：稳定 session_id + 前缀稳定（合并开头 system、指纹追踪）+ 真实 cached_tokens 统计与诊断。
 */
(function (root) {
  'use strict';
  const C = root.CacheCommon || (typeof require === 'function' ? require('./cache-common.js') : null);
  const ID = 'mmcache';
  const DEFAULTS = { sessionId: true, mergeSystem: true, toast: false, diagToast: true };
  /** MiniMax 自动缓存最小输入 Token（官方文档） */
  const MIN_TOKENS = 512;
  /** OpenRouter sticky 会话过期（秒）；MiniMax 缓存本身无固定 TTL，用它作为「应命中」窗口的保守上限 */
  const STICKY_SEC = 600;
  const DIAG_LOW = 40, DIAG_GOOD = 70, ROLL_N = 8;
  /** 相对输入价倍率（OpenRouter /models 的 input_cache_read / prompt）；写入无额外费用 → 1.0 */
  const PRICES = { 'minimax-m3.1-flash': 0.1, 'minimax-m3': 0.2, 'minimax-m2.7': 0.2, 'minimax-m2.5': 0.11 };
  function priceFor(model) {
    const m = String(model || '').toLowerCase().replace(/^~/, '').split('/').pop().replace(/:.*$/, '');
    const k = Object.keys(PRICES).sort((a, b) => b.length - a.length).find(x => m === x || m.startsWith(x + '-'));
    return { read: k ? PRICES[k] : 0.2, write: 1.0, known: !!k };
  }

  /** 是否 MiniMax 模型（minimax/xxx、~minimax/xxx） */
  function isMiniMaxModel(model) { return /^~?minimax\//i.test(String(model || '').trim()); }
  /** 闸门：仅 OpenRouter（OpenAI 兼容）+ MiniMax 模型。与 gcache 的 isOpenRouterGemini 互斥 */
  function isOpenRouterMiniMax(provider, model) { return isMiniMaxModel(model) && C.isOpenRouterProvider(provider); }
  /** 当前模型是否支持经 OpenRouter 的显式 cache_control —— 无证据，恒为 false（保留接口便于以后按实测打开） */
  function supportsCacheControl() { return false; }

  /** 合并开头连续的纯文本 system 消息（顺序不变），让固定前缀成为单一稳定块 */
  function mergeLeadingSystem(msgs) {
    let n = 0; while (n < msgs.length && msgs[n].role === 'system' && typeof msgs[n].content === 'string') n++;
    if (n < 2) return msgs;
    return [{ role: 'system', content: msgs.slice(0, n).map(m => m.content).join('\n\n') }].concat(msgs.slice(n));
  }
  /** MiniMax 前缀顺序：tools → system → messages；返回「固定前缀」文本（tools + 开头 system） */
  function prefixOf(body) {
    const msgs = body.messages || [];
    let sys = ''; for (const m of msgs) { if (m.role !== 'system') break; sys += C.partsText(m.content) + '\n'; }
    return (body.tools ? JSON.stringify(body.tools) + '\n' : '') + sys;
  }

  /**
   * 改写请求（纯函数）：只加 session_id、可选合并 system；不改 model / provider / 内容顺序，不发 cache_control。
   * info = { sessionId }
   */
  function applyToRequest(req, cfg, info) {
    cfg = Object.assign({}, DEFAULTS, cfg); info = info || {};
    let body; try { body = typeof req.body === 'string' ? JSON.parse(req.body) : Object.assign({}, req.body); } catch (e) { return { req, prefix: '', applied: false }; }
    if (!body || !Array.isArray(body.messages)) return { req, prefix: '', applied: false };
    if (cfg.mergeSystem) body.messages = mergeLeadingSystem(body.messages);
    let sid = '';
    if (cfg.sessionId && info.sessionId) { if (body.session_id == null) body.session_id = info.sessionId; sid = body.session_id; }
    const prefix = prefixOf(body);
    const out = Object.assign({}, req, { body: typeof req.body === 'string' ? JSON.stringify(body) : body });
    const route = { model: body.model, order: !!(body.provider && Array.isArray(body.provider.order) && body.provider.order.length) };
    return { req: out, prefix, session_id: sid, prefixTokens: C.estTokens(prefix), promptTokens: C.estTokens(JSON.stringify(body.messages)), route, applied: false };
  }

  /** 诊断：基于真实 cached_tokens 滚动命中率 + 已知破坏因素 */
  function diagnose(s) {
    const rate = C.rollingRate(s.roll);
    const issues = [];
    if (rate == null) issues.push('服务商未返回 cached_tokens，无法统计（可能路由到不报告缓存的供应商）');
    if (s.lastPromptEst != null && s.lastPromptEst < MIN_TOKENS) issues.push('输入约 ' + s.lastPromptEst + ' Token，低于 MiniMax 自动缓存门槛 ' + MIN_TOKENS);
    if (s.prefixChanges > 0 && s.requests > 1 && s.prefixChanges / s.requests > 0.3) issues.push('固定前缀（tools/system）频繁变化 ' + s.prefixChanges + ' 次：把时间、随机内容移到对话尾部');
    if (s.routeOrder) issues.push('请求指定了 provider.order，OpenRouter 不会做 sticky routing，缓存易落空');
    if (!s.session_id) issues.push('未发送 session_id（设置里已关闭），首轮起的 sticky 路由失效');
    const gaps = (s.gaps || []).slice(-ROLL_N);
    if (gaps.length >= 3 && gaps.filter(g => g > STICKY_SEC).length / gaps.length > 0.5) issues.push('多数请求间隔超过 ' + STICKY_SEC / 60 + ' 分钟，sticky 会话已过期、缓存可能已被驱逐');
    const level = rate == null ? 'unknown' : rate >= DIAG_GOOD ? 'good' : rate < DIAG_LOW ? 'low' : 'ok';
    if (level === 'low' && !issues.length) issues.push('前缀稳定但未命中：MiniMax 缓存过期随负载变化，或被路由到不同供应商');
    return { rate, level, issues };
  }
  function usageText(i) {
    if (i.known === false) return 'MiniMax 缓存命中未知（未返回 cached_tokens；输入 ' + i.prompt + ' Token）';
    return i.hit ? 'MiniMax 缓存命中 ' + i.hit + '/' + i.prompt + ' Token（' + i.pct + '%）' : 'MiniMax 缓存未命中（输入 ' + i.prompt + ' Token）';
  }

  const api = { ID, DEFAULTS, MIN_TOKENS, STICKY_SEC, PRICES, priceFor, isMiniMaxModel, isOpenRouterMiniMax, supportsCacheControl, mergeLeadingSystem, prefixOf, applyToRequest, diagnose, usageText, sessionIdFor: id => C.sessionIdFor(id, 'mmcache') };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.MiniMaxCache = api;

  const reg = root.Plugins && root.Plugins.registry; if (!reg) return;
  const cfgOf = host => Object.assign({}, DEFAULTS, reg.config(host.settings(), ID));
  const lastPrefix = new Map(), lastBody = new Map();
  const statOf = conv => {
    const d = reg.convData(conv, ID);
    d.stat = Object.assign({ requests: 0, hits: 0, prompt: 0, cached: 0, unknown: 0, prefixChanges: 0, prefixLen: 0, prefix_hash: '', roll: [], gaps: [], session_id: '', lastDiff: null, diag: null }, d.stat);
    return d.stat;
  };
  const LV = { good: '良好 ✅', ok: '一般', low: '偏低 ⚠️（已诊断）', unknown: '未知' };

  reg.register({
    id: ID, icon: '🧊', name: 'MiniMax 提示缓存（OpenRouter）', version: '1.0.0', perConversation: false, defaultEnabled: true,
    desc: '仅对 OpenRouter 上的 MiniMax 模型生效：依赖 MiniMax 自动前缀缓存（≥512 Token），每个对话稳定 session_id（sticky routing）、合并开头 system 保持前缀稳定、按真实 cached_tokens 统计命中与成本并诊断。不发送 cache_control（OpenRouter/MiniMax 对 M3.x 无显式缓存支持证据）。其他服务商 / 模型完全不变。',
    hooks: {
      onBeforeRequest(ctx, host) {
        if (!isOpenRouterMiniMax(ctx.provider, ctx.model)) return ctx;
        ctx.opts = Object.assign({}, ctx.opts, { orMiniMax: cfgOf(host) });
        return ctx;
      },
      onAfterResponse(result, ctx, host) {
        if (!ctx.opts || !ctx.opts.orMiniMax || !result.ok || !result.bot) return;
        const i = C.usageInfo(result.usage); if (!i) return;
        const s = statOf(ctx.conv);
        if (i.known === false) s.unknown++; else { s.prompt += i.prompt; s.cached += i.hit; if (i.hit) s.hits++; }
        s.roll = (s.roll || []).concat([{ prompt: i.prompt, hit: i.hit, known: i.known !== false }]).slice(-ROLL_N);
        s.lastPromptEst = i.prompt;
        result.bot.mmcache = i;
        const prev = s.diag && s.diag.level; s.diag = diagnose(s);
        if (ctx.opts.orMiniMax.toast) host.toast(usageText(i));
        if (ctx.opts.orMiniMax.diagToast && s.diag.level === 'low' && prev !== 'low') host.toast('🧊 MiniMax 缓存命中率 ' + s.diag.rate + '%：' + s.diag.issues[0]);
        host.saveConv(ctx.conv);
      },
      messageBadges(msg) {
        const i = msg.role === 'assistant' && msg.mmcache; if (!i) return [];
        if (i.known === false) return [{ text: '🧊 缓存 ?', tone: 'info', title: usageText(i) }];
        return [{ text: '🧊 缓存 ' + i.pct + '%', tone: i.pct >= DIAG_GOOD ? 'ok' : i.hit ? 'warn' : 'info', title: usageText(i) }];
      },
      headerBadges(conv, host) {
        if (!conv) return [];
        const s = reg.convData(conv, ID).stat; if (!s || !(s.roll || []).length) return [];
        const d = s.diag || diagnose(s); if (d.rate == null) return [];
        const tn = d.level === 'good' ? 'ok' : d.level === 'low' ? 'bad' : d.level === 'ok' ? 'warn' : 'info';
        return [{ text: '命中 ' + d.rate + '%', tone: tn, title: 'MiniMax 滚动命中率（近 ' + ROLL_N + ' 次）', action: () => host.openPanel(ID), kind: 'hit' }];
      },
    },
    /** app.js 在 buildChatRequest 之后调用 */
    transformRequest(req, ctx) {
      const o = ctx.opts && ctx.opts.orMiniMax; if (!o) return req;
      const s = statOf(ctx.conv), now = Date.now();
      const r = applyToRequest(req, o, { sessionId: ctx.conv ? api.sessionIdFor(ctx.conv.id) : '' });
      s.requests++;
      if (s.lastT) s.gaps = (s.gaps || []).concat([Math.round((now - s.lastT) / 100) / 10]).slice(-50);
      s.lastT = now; s.session_id = r.session_id || ''; s.routeOrder = !!(r.route && r.route.order);
      const id = ctx.conv && ctx.conv.id, ph = C.hash(r.prefix), prevP = id != null ? lastPrefix.get(id) : null;
      if (prevP != null ? prevP !== r.prefix : (s.prefix_hash && s.prefix_hash !== ph)) { s.prefixChanges++; if (prevP != null) s.lastDiff = C.firstDiff(prevP, r.prefix); }
      const body = r.req && r.req.body != null ? String(r.req.body) : '', pb = id != null ? lastBody.get(id) : null;
      s.lastLcp = pb != null ? C.lcpRatio(pb, body) : null;
      if (id != null) { lastPrefix.set(id, r.prefix); lastBody.set(id, body); }
      s.prefix_hash = ph; s.prefixLen = r.prefix.length; s.prefixTokens = r.prefixTokens;
      return r.req;
    },
    renderSettings(box, host) {
      const c = cfgOf(host);
      const sw = (id, label, hint, v) => '<label class="field inline"><span>' + label + '<small>' + hint + '</small></span><input type="checkbox" class="switch" id="' + id + '"' + (v ? ' checked' : '') + '></label>';
      box.innerHTML =
        sw('mm-sid', '稳定 session_id', '每个对话固定一个 session_id，OpenRouter 从首轮起把请求粘到同一供应商（10 分钟无活动过期）', c.sessionId) +
        sw('mm-merge', '合并开头 system 消息', '把开头连续的多条 system 合并为一条（顺序不变），固定前缀更稳定', c.mergeSystem) +
        sw('mm-toast', '命中提示', '每次回复后弹出 MiniMax 缓存命中 Token 数', c.toast) +
        sw('mm-dtoast', '诊断提示', '滚动命中率跌破 40% 时弹出诊断结论', c.diagToast);
      const save = patch => { Object.assign(reg.config(host.settings(), ID), patch); host.saveSettings(); };
      box.querySelector('#mm-sid').onchange = e => save({ sessionId: e.target.checked });
      box.querySelector('#mm-merge').onchange = e => save({ mergeSystem: e.target.checked });
      box.querySelector('#mm-toast').onchange = e => save({ toast: e.target.checked });
      box.querySelector('#mm-dtoast').onchange = e => save({ diagToast: e.target.checked });
    },
    renderPanel(box, host) {
      const conv = host.conv(), e = host.esc;
      const p = conv && host.provider(conv), on = !!(conv && isOpenRouterMiniMax(p, conv.model));
      const L = [];
      L.push('当前模型：' + e((conv && conv.model) || '?') + (on ? '（OpenRouter MiniMax ✅）' : '（非 OpenRouter MiniMax，本插件不生效）'));
      L.push('策略：MiniMax 自动前缀缓存（≥' + MIN_TOKENS + ' Token，无固定 TTL）+ 稳定 session_id；不发送 cache_control');
      const s = conv && reg.convData(conv, ID).stat;
      if (!s || !s.requests) L.push('<br>本对话尚无请求统计。');
      else {
        const known = s.prompt > 0, pr = priceFor(conv.model);
        L.push('<br>请求数：' + s.requests + '　命中次数：' + s.hits + (s.unknown ? '　未返回缓存字段：' + s.unknown + ' 次' : ''));
        L.push('累计输入（真实 usage）：' + s.prompt + '　cached_tokens：' + s.cached + '（' + (known ? Math.round(s.cached / s.prompt * 100) + '%' : '未知') + '）');
        const cost = known && C.estimateCost({ prompt: s.prompt, hit: s.cached, write: 0 }, pr);
        if (cost) L.push('成本（读 ' + pr.read + 'x 输入价' + (pr.known ? '' : '，未知型号按 0.2x 估') + '）：≈ ' + cost.equiv + ' 输入 Token 等价，节省约 ' + cost.pctSaved + '%');
        const d = s.diag || diagnose(s);
        L.push('滚动命中率（近 ' + ROLL_N + ' 次）：' + (d.rate == null ? '未知' : d.rate + '%') + ' · ' + LV[d.level]);
        d.issues.forEach(x => L.push('　· ' + e(x)));
        L.push('session_id：' + e(s.session_id || '未发送') + '　固定前缀（tools+system）：约 ' + (s.prefixTokens | 0) + ' Token　变化次数：' + s.prefixChanges);
        if (s.lastLcp != null) L.push('本轮与上一轮请求公共前缀占比：' + Math.round(s.lastLcp * 1000) / 10 + '%');
        if (s.lastDiff) L.push('最近一次前缀变化位置 #' + s.lastDiff.pos + '：<br>之前：…' + e(s.lastDiff.before) + '…<br>之后：…' + e(s.lastDiff.after) + '…');
      }
      box.innerHTML = '<div class="hint" style="line-height:1.7">' + L.join('<br>') + '</div><button class="chip-btn" id="mm-reset" type="button" style="margin-top:12px">清空本对话统计</button>';
      box.querySelector('#mm-reset').onclick = () => { if (conv) { delete reg.convData(conv, ID).stat; host.saveConv(conv); } this.renderPanel(box, host); host.toast('已清空'); };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
