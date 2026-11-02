/* 内置插件：OpenRouter · Gemini 角色扮演提示缓存优化（移植自 ai-chat 4.1.3 plugins/rp_gemini_cache）
 * 原理：OpenRouter 对 Gemini 支持 Anthropic 风格的 cache_control 显式缓存断点（只有最后一个断点生效，读取约 0.25x 输入价）；
 *       Gemini 2.5+ 另有默认开启的隐式缓存（TTL 约 3~5 分钟）。两者都要求请求「前缀」逐字节一致才能命中。
 * 只在「OpenRouter 服务商 + Gemini 模型」的请求上生效，其他请求逐字节不变。
 * 纯逻辑部分（isOpenRouterGemini / applyToRequest / usageInfo）可在 Node 中测试；插件注册仅在浏览器中进行。
 */
(function (root) {
  'use strict';
  const ID = 'gcache';
  const DEFAULTS = { mode: 'prefix', mergeSystem: true, ttl: '', responseCache: false, toast: true };

  /** 是否为 OpenRouter 上的 Gemini 模型 */
  function isOpenRouterGemini(provider, model) {
    const p = provider || {};
    if (p.type && p.type !== 'openai') return false;
    const isOR = p.presetId === 'openrouter' || /openrouter\.ai/i.test(String(p.baseUrl || '')) || String(p.apiKey || '').trim().startsWith('sk-or-');
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

  /**
   * 改写 buildChatRequest 的结果（OpenAI 兼容格式）。req = {url, headers, body(string)}；cfg 见 DEFAULTS。
   * 返回 { req, applied:{index,mode}|null, prefix:string }
   */
  function applyToRequest(req, cfg) {
    cfg = Object.assign({}, DEFAULTS, cfg || {});
    let body; try { body = JSON.parse(req.body); } catch (e) { return { req, applied: null, prefix: '' }; }
    const headers = Object.assign({}, req.headers);
    if (cfg.responseCache) headers['X-OpenRouter-Cache'] = 'true';
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    let applied = null, k = 0;
    while (k < msgs.length && msgs[k].role === 'system') k++;
    // 1. 合并开头连续 system 消息
    if (k > 1 && cfg.mergeSystem && msgs.slice(0, k).every(m => typeof m.content === 'string')) {
      msgs.splice(0, k, { role: 'system', content: msgs.slice(0, k).map(m => m.content).filter(Boolean).join('\n\n') });
      k = 1;
    }
    const prefix = msgs.slice(0, k).map(m => partsText(m.content)).join('\n\0\n');
    // 2. 断点：OpenRouter 对 Gemini 只用最后一个断点，先清掉其他插件（RP 缓存优化器强制模式）加的断点
    if (cfg.mode !== 'off' && msgs.length) {
      msgs.forEach(stripCC);
      let target = -1;
      if (cfg.mode === 'history') {
        let lastUser = -1; for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { lastUser = i; break; }
        for (let i = (lastUser > 0 ? lastUser : msgs.length) - 1; i >= 0; i--) if (hasText(msgs[i].content)) { target = i; break; }
      }
      if (target < 0 && k > 0) target = k - 1;
      if (target >= 0 && addBreakpoint(msgs[target], cfg.ttl || undefined)) applied = { index: target, mode: cfg.mode };
    }
    body.messages = msgs;
    return { req: Object.assign({}, req, { headers, body: JSON.stringify(body) }), applied, prefix };
  }

  /** 从统一 usage（providers.normalizeUsage）取缓存信息 */
  function usageInfo(u) {
    if (!u || u.prompt == null) return null;
    const prompt = u.prompt | 0, hit = u.hit | 0, write = u.cacheWrite | 0;
    return { prompt, hit, write, pct: prompt ? Math.round(hit / prompt * 100) : 0 };
  }
  function usageText(i) {
    return i.hit ? 'Gemini 缓存命中 ' + i.hit + '/' + i.prompt + ' Token（' + i.pct + '%）' + (i.write ? '，写入 ' + i.write : '')
      : 'Gemini 缓存未命中（输入 ' + i.prompt + ' Token' + (i.write ? '，写入 ' + i.write : '') + '）';
  }

  const api = { ID, DEFAULTS, isOpenRouterGemini, applyToRequest, usageInfo, usageText, firstDiff };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.GeminiCache = api;

  const reg = root.Plugins && root.Plugins.registry; if (!reg) return;
  const cfgOf = host => Object.assign({}, DEFAULTS, reg.config(host.settings(), ID));
  const statOf = conv => {
    const d = reg.convData(conv, ID);
    d.stat = Object.assign({ requests: 0, hits: 0, prompt: 0, cached: 0, write: 0, prefixChanges: 0, prefixLen: 0, prefix: null, lastDiff: null }, d.stat);
    return d.stat;
  };

  reg.register({
    id: ID, icon: '💎', name: 'Gemini 提示缓存（OpenRouter）', version: '1.0.0', perConversation: false, defaultEnabled: true,
    desc: '只对 OpenRouter 上的 Gemini 模型生效：合并开头的系统提示、在稳定前缀（或前缀+历史）末尾加 cache_control 显式缓存断点，可选 1 小时 TTL、OpenRouter 响应缓存，并在回复上显示缓存命中。其他服务商 / 模型的请求完全不变。',
    hooks: {
      onBeforeRequest(ctx, host) {
        if (!isOpenRouterGemini(ctx.provider, ctx.model)) return ctx;
        ctx.opts = Object.assign({}, ctx.opts, { orGemini: cfgOf(host) });
        return ctx;
      },
      onAfterResponse(result, ctx, host) {
        if (!ctx.opts || !ctx.opts.orGemini || !result.ok || !result.bot) return;
        const i = usageInfo(result.usage);
        const s = statOf(ctx.conv);
        if (i) {
          s.prompt += i.prompt; s.cached += i.hit; s.write += i.write; if (i.hit) s.hits++;
          result.bot.gcache = i;
          if (ctx.opts.orGemini.toast) host.toast(usageText(i));
        }
        host.saveConv(ctx.conv);
      },
      messageBadges(msg, conv, host) {
        const i = msg.role === 'assistant' && msg.gcache; if (!i) return [];
        return [{ text: '💎 缓存 ' + i.pct + '%', tone: i.pct >= 50 ? 'ok' : i.hit ? 'warn' : 'info', title: usageText(i), action: () => host.openPanel(ID) }];
      },
    },
    /** app.js 在 buildChatRequest 之后调用：改写请求并记录前缀稳定性 */
    transformRequest(req, ctx) {
      const o = ctx.opts && ctx.opts.orGemini; if (!o) return req;
      const r = applyToRequest(req, o);
      const s = statOf(ctx.conv);
      s.requests++;
      if (s.prefix != null && s.prefix !== r.prefix) { s.prefixChanges++; s.lastDiff = firstDiff(s.prefix, r.prefix); }
      s.prefix = r.prefix; s.prefixLen = r.prefix.length;
      return r.req;
    },
    renderSettings(box, host) {
      const c = cfgOf(host);
      const sel = (id, label, hint, opts, v) => '<label class="field"><span>' + label + '<small>' + hint + '</small></span><select id="' + id + '">' +
        opts.map(o => '<option value="' + o[0] + '"' + (String(v) === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select></label>';
      const sw = (id, label, hint, v) => '<label class="field inline"><span>' + label + '<small>' + hint + '</small></span><input type="checkbox" class="switch" id="' + id + '"' + (v ? ' checked' : '') + '></label>';
      box.innerHTML =
        sel('gc-mode', '显式缓存断点', '「前缀+历史」把断点放在最新用户消息之前，长对话更省（OpenRouter 对 Gemini 只用最后一个断点）', [['off', '关闭（仅依赖 Gemini 隐式缓存）'], ['prefix', '系统前缀（推荐）'], ['history', '前缀+历史']], c.mode) +
        sw('gc-merge', '合并开头 system 消息', '把开头连续的多条 system 消息合并为一条，保证断点覆盖完整固定前缀', c.mergeSystem) +
        sel('gc-ttl', '缓存 TTL', '写入 cache_control.ttl = "1h"（服务商不支持时会被忽略）', [['', '默认（5 分钟）'], ['1h', '1 小时']], c.ttl) +
        sw('gc-resp', 'OpenRouter 响应缓存', '发送 X-OpenRouter-Cache: true，完全相同的请求直接返回缓存的回复（重新生成会得到同样结果！）', c.responseCache) +
        sw('gc-toast', '命中提示', '每次回复结束后弹出提示显示缓存命中 Token 数', c.toast);
      const save = patch => { Object.assign(reg.config(host.settings(), ID), patch); host.saveSettings(); };
      box.querySelector('#gc-mode').onchange = e => save({ mode: e.target.value });
      box.querySelector('#gc-ttl').onchange = e => save({ ttl: e.target.value });
      box.querySelector('#gc-merge').onchange = e => save({ mergeSystem: e.target.checked });
      box.querySelector('#gc-resp').onchange = e => save({ responseCache: e.target.checked });
      box.querySelector('#gc-toast').onchange = e => save({ toast: e.target.checked });
    },
    renderPanel(box, host) {
      const conv = host.conv(), e = host.esc;
      const p = conv && host.provider(conv), on = !!(conv && isOpenRouterGemini(p, conv.model));
      const c = cfgOf(host);
      const L = [];
      L.push('当前模型：' + e((conv && conv.model) || '?') + (on ? '（已识别为 OpenRouter Gemini ✅）' : '（非 OpenRouter Gemini，本插件不生效）'));
      L.push('断点模式：' + ({ off: '关闭', prefix: '系统前缀', history: '前缀+历史' }[c.mode] || c.mode) + '　合并 system：' + (c.mergeSystem ? '是' : '否') + '　TTL：' + (c.ttl || '默认') + '　响应缓存：' + (c.responseCache ? '开' : '关'));
      const s = conv && reg.convData(conv, ID).stat;
      if (!s || !s.requests) L.push('<br>本对话尚无请求统计。');
      else {
        L.push('<br>请求数：' + s.requests + '　命中次数：' + s.hits);
        L.push('累计输入：' + s.prompt + '　缓存读取：' + s.cached + '（' + (s.prompt ? Math.round(s.cached / s.prompt * 100) : 0) + '%）　缓存写入：' + s.write);
        L.push('固定前缀长度：约 ' + s.prefixLen + ' 字符（≈' + Math.round(s.prefixLen / 3) + ' Token；Gemini 显式缓存通常需 ≥1024~4096 Token）');
        L.push('前缀变化次数：' + s.prefixChanges);
        if (s.lastDiff) L.push('最近一次前缀变化位置 #' + s.lastDiff.pos + '：<br>之前：…' + e(s.lastDiff.before) + '…<br>之后：…' + e(s.lastDiff.after) + '…<br>提示：系统提示词 / 分层设定里的时间、随机内容或频繁修改的块会破坏前缀，建议放到「当前状态」等尾部内容里。');
      }
      box.innerHTML = '<div class="hint" style="line-height:1.7">' + L.join('<br>') + '</div><button class="chip-btn" id="gc-reset" type="button" style="margin-top:12px">清空本对话统计</button>';
      box.querySelector('#gc-reset').onclick = () => { if (conv) { delete reg.convData(conv, ID).stat; host.saveConv(conv); } this.renderPanel(box, host); host.toast('已清空'); };
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
