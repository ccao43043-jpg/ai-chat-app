/* 内置插件：DeepSeek RP 缓存优化器 V1（钩子 + 界面）与 Token 用量显示。依赖 plugins.js、rpcache.js
 * 设计文档：docs/plugins/deepseek-rp-cache-design-v1.md */
(function () {
  'use strict';
  const R = window.RPCache;
  const reg = window.Plugins.registry;
  const ID = 'rpcache';
  const pct = v => (v == null ? '—' : (v * 100).toFixed(v >= 0.9995 || v === 0 ? 0 : 1) + '%');
  const fmtN = n => (n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
  const num = n => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
  const fmtUsd = v => (v == null ? '—' : '$' + (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(3)));
  const tone = r => (r == null ? 'info' : r >= 0.7 ? 'ok' : r >= 0.3 ? 'warn' : 'bad');
  const fmtTime = t => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const SRC = { auto: '自动', manual: '手动生成', edit: '手动编辑', rollback: '回滚' };

  const normalized = new WeakSet();
  /** 会话数据；状态只在第一次读取时补齐字段，之后保持同一个对象（界面持有的引用不会失效） */
  function data(conv) {
    const d = reg.convData(conv, ID);
    if (!d.state || !normalized.has(d.state)) { d.state = R.normalizeState(d.state); normalized.add(d.state); }
    return d;
  }
  function cfg(host) { const c = reg.config(host.settings(), ID); c.prices = Object.assign({}, R.DEFAULT_PRICES, c.prices || {}); c.priceMode = c.priceMode || 'auto'; return c; }
  const logKey = conv => 'rplog_' + conv.id + '.json';
  const loadLogs = (host, conv) => host.store.get(logKey(conv), []) || [];

  /** 请求项：用户消息「冻结」首次发送的内容（含当时的联网搜索 / 文件内容），以后每轮逐字节一致；动态状态不写入历史 */
  function toItems(ctx) {
    return ctx.messages.map(m => {
      const src = m._src || {};
      let content = m.content || '';
      if (m.role === 'user') {
        if (src === ctx.lastUser || src.rpSent == null) src.rpSent = content;
        else content = src.rpSent;
      }
      return { id: src.id, role: m.role, content, images: m.images, _src: src };
    });
  }
  /** 不发请求时，用对话里的消息估算（界面展示用） */
  function convItems(conv) {
    return conv.messages.filter(m => !m.error && !m.imageGen && !m.pending).map(m => ({ id: m.id, role: m.role, content: m.rpSent != null ? m.rpSent : m.content, images: m.images }));
  }
  function planConv(conv) { const d = data(conv); return R.plan(d.state, conv.systemPrompt, convItems(conv)); }

  /** 生成下一版章节摘要（合并上一版 + 最旧一批历史），保存为新的冻结快照 */
  async function makeSummary(host, conv, p, source, setCancel) {
    const st = p.st; const prev = R.activeSummary(st);
    if (!p.batch.length) throw new Error('没有可摘要的旧对话（最近 ' + st.settings.summary.keep_recent_turns + ' 轮始终保留原文）');
    const prompt = R.buildSummaryPrompt({ prevSummary: prev && prev.content, memory: R.getBlock(st, 'memory').content, batch: p.batch });
    const text = await host.callModel(prompt, { maxTokens: 4096, model: st.settings.summary_model || undefined, setCancel });
    const r = R.parseSummary(text);
    if (!r.ok) throw new Error('模型返回的摘要格式不完整（缺少 ' + r.missing.join(' / ') + '）');
    const ids = p.batch.map(m => m.id).filter(Boolean);
    const state = R.addSummary(st, { content: r.text, coveredIds: (prev ? prev.coveredIds : []).concat(ids), at: Date.now(), source,
      basedOn: prev ? prev.no : null, newMessages: ids.length, rounds: p.batchRounds });
    return { state, no: R.activeSummary(state).no, count: ids.length, missing: r.missing };
  }

  let coverMemo = { key: null, set: null };
  function coveredSet(st) {
    const a = R.activeSummary(st); const key = a ? a.no + ':' + a.coveredIds.length : '-';
    if (coverMemo.key !== key) coverMemo = { key, set: new Set(a ? a.coveredIds : []) };
    return coverMemo.set;
  }

  const plugin = reg.register({
    id: ID, icon: '🎭', name: 'DeepSeek RP 缓存优化器', version: '1.0.0', perConversation: true, defaultEnabled: true,
    desc: '长篇角色扮演专用 Context Builder：六层上下文（永久锚点 → 长期记忆 → 冻结章节摘要 → 原样历史 → 动态状态 → 当前输入）、超预算自动章节摘要、逐层指纹诊断与缓存命中监控。',
    hooks: {
      async onBeforeRequest(ctx, host) {
        const d = data(ctx.conv);
        const base = ctx.systemPrompt;
        let st = R.syncBase(d.state, base);
        const items = toItems(ctx);
        let p = R.plan(st, base, items);
        const overBudget = p.overBudget;
        let summaryNo = 0, summaryReason = null, summaryError = null;
        if (p.needSummary) {
          summaryReason = p.summaryReason;
          ctx.setStatus && ctx.setStatus('正在生成章节摘要…');
          try {
            const r = await makeSummary(host, ctx.conv, p, 'auto', ctx.setCancel);
            st = r.state; summaryNo = r.no;
            host.toast('已生成章节摘要 ' + R.slabel(r.no) + '（' + r.count + ' 条旧消息已写入摘要，原文保留）');
          } catch (e) {
            summaryError = String(e && e.message || e);
            host.toast('章节摘要生成失败：' + summaryError);
          }
          ctx.setStatus && ctx.setStatus(null);
          p = R.plan(st, base, items);
        }
        let trimmedNow = false;
        if (p.overBudget) { // 仍超预算（摘要关闭 / 失败）：一次性截掉一大块旧历史，起点固定
          st = R.fallbackTrim(st, p); p = R.plan(st, base, items); trimmedNow = true;
          host.toast('上下文超出预算，本次只发送最近 ' + R.estimateItems(p.hist) + ' tokens 的历史（原文仍保存在本地）');
        }
        d.state = st;
        const a = R.assemble(p);
        ctx.systemPrompt = a.system; ctx.messages = a.messages;
        const fp = R.fingerprints(p, base);
        const logs = loadLogs(host, ctx.conv);
        const prev = logs[logs.length - 1] || null;
        ctx.meta.rp = {
          fp, diag: R.diagnose(prev, fp, p.hist), tokens: p.tokens, overBudget, staticCause: st.pendingStaticCause || null, trimmed: p.trimmed, trimmedNow, summaryNo, summaryReason, summaryError,
          prompt: st.settings.save_prompt ? { system: a.system, messages: a.messages.map(m => ({ role: m.role, content: m.content })) } : null,
        };
        if (summaryNo || trimmedNow) host.saveConv(ctx.conv);
        return ctx;
      },
      onAfterResponse(result, ctx, host) {
        if (!result.ok || !ctx.meta.rp) return;
        const info = ctx.meta.rp; const d = data(ctx.conv);
        const logs0 = loadLogs(host, ctx.conv);
        d.state.seq = (d.state.seq | 0) + 1;
        const entry = R.makeLogEntry({ request_id: 'req_' + String(d.state.seq).padStart(4, '0'), at: Date.now(), usage: result.usage, model: ctx.model,
          provider: ctx.provider.presetId || ctx.provider.id, fp: info.fp, diag: info.diag, tokens: info.tokens, summaryNo: info.summaryNo, summaryReason: info.summaryReason,
          summaryError: info.summaryError, staticCause: info.diag.static === 'CHANGED' ? info.staticCause : null, overBudget: info.overBudget, trimmed: info.trimmed, msgId: result.bot && result.bot.id, prev: logs0[logs0.length - 1] || null,
          savePrompt: d.state.settings.save_prompt, prompt: info.prompt });
        if (d.state.pendingStaticCause) d.state = Object.assign({}, d.state, { pendingStaticCause: null });
        const logs = R.appendLog(logs0, entry);
        host.store.set(logKey(ctx.conv), logs);
        const an = R.detectAnomaly(logs);
        if (result.bot) result.bot.rpCache = { rate: entry.hit_rate, hit: entry.cache_hit_tokens, miss: entry.cache_miss_tokens, prompt: entry.prompt_tokens,
          supported: entry.supported, anomaly: an.anomaly, summaryNo: entry.summary_no, reason: entry.reason, req: entry.request_id };
        d.lastAnomaly = an.anomaly ? { at: entry.timestamp, avg: an.avg, current: an.current, causes: an.causes, changed: an.changed } : null;
        if (an.anomaly) host.toast('⚠ 缓存命中率骤降（' + pct(an.avg) + ' → ' + pct(an.current) + '），点消息上的徽章查看原因');
      },
      messageBadges(msg, conv, host) {
        if (msg.role !== 'assistant' || !msg.rpCache) return [];
        const c = msg.rpCache; const out = [];
        if (!c.supported) out.push({ text: '缓存 不支持统计', tone: 'info', title: '该服务商未返回缓存字段', action: () => host.openPanel(ID, 'monitor') });
        else out.push({ text: (c.anomaly ? '⚠ ' : '') + '缓存 ' + pct(c.rate), tone: c.anomaly ? 'bad' : tone(c.rate), title: '命中 ' + c.hit + ' / ' + c.prompt + ' tokens · ' + (c.reason || ''),
          action: () => host.openPanel(ID, 'monitor') });
        if (c.summaryNo) out.push({ text: '📚 摘要 ' + R.slabel(c.summaryNo), tone: 'info', title: '本次请求前生成了章节摘要', action: () => host.openPanel(ID, 'summary') });
        return out;
      },
      headerBadges(conv, host) {
        const logs = loadLogs(host, conv); const last = logs[logs.length - 1];
        const out = [{ text: '🎭 RP' + (last ? ' · 命中 ' + (last.supported ? pct(last.hit_rate) : '—') : ''), tone: last && last.supported ? tone(last.hit_rate) : 'info', action: () => host.openPanel(ID, last ? 'monitor' : 'blocks') }];
        const p = planConv(conv); const act = R.activeSummary(p.st);
        if (act) out.push({ text: '📚 摘要 ' + R.slabel(act.no), tone: 'info', action: () => host.openPanel(ID, 'summary') });
        const sum = p.st.settings.summary;
        const unTok = R.estimateItems(p.unsummarized);
        if (sum.enabled && !p.needSummary && unTok >= sum.trigger_tokens * 0.85) out.push({ text: '即将自动摘要', tone: 'warn', action: () => host.openPanel(ID, 'summary') });
        else if (p.needSummary) out.push({ text: '下次发送将自动摘要', tone: 'warn', action: () => host.openPanel(ID, 'summary') });
        return out;
      },
      messageState(msg, conv) {
        const st = data(conv).state;
        const cov = coveredSet(st);
        if (cov.has(msg.id)) {
          const elig = conv.messages.filter(m => cov.has(m.id));
          const isLast = elig[elig.length - 1] === msg;
          return { dim: true, label: isLast ? '↑ 以上 ' + elig.length + ' 条已写入章节摘要 ' + R.slabel(R.activeSummary(st).no) + '，不再发送（原文保留）' : '' };
        }
        if (!st.window.startId) return null;
        const elig = conv.messages.filter(m => !m.error && !m.imageGen && !m.pending && !cov.has(m.id));
        const i = elig.findIndex(m => m.id === st.window.startId);
        const j = elig.indexOf(msg);
        if (i > 0 && j >= 0 && j < i) return { dim: true, light: true, label: j === i - 1 ? '↑ 以上超出预算，暂不发送（原文保留，建议开启自动摘要）' : '' };
        return null;
      },
    },

    // ---------------- 插件设置（全局：价格） ----------------
    renderSettings(box, host) {
      const c = cfg(host);
      const row = id => '<div class="price-row"><span>' + id + '</span>' +
        ['hit', 'miss', 'out'].map(k => '<input type="number" step="0.001" min="0" data-m="' + id + '" data-k="' + k + '" value="' + c.prices[id][k] + '">').join('') + '</div>';
      box.innerHTML = '<div class="pl-set-title">价格（美元 / 百万 tokens，高峰价），用于估算节省的费用</div>' +
        '<div class="price-row head"><span>模型</span><span>缓存命中</span><span>未命中</span><span>输出</span></div>' +
        row('deepseek-flash') + row('deepseek-v4-pro') +
        '<label class="field" style="margin-top:10px"><span>时段</span><select id="rp-price-mode"><option value="auto">自动（按请求时间判断高峰/非高峰）</option><option value="peak">按高峰价</option><option value="offpeak">按非高峰价（半价）</option></select></label>' +
        '<div class="hint small">默认价格来自 DeepSeek 官方定价页（2026-10 核对）。高峰：周一至周五北京时间 9:00–12:00、14:00–18:00，其余时段半价（节假日未计入）。</div>' +
        '<button class="chip-btn" id="rp-price-reset" type="button">恢复默认价格</button>';
      box.querySelector('#rp-price-mode').value = c.priceMode;
      box.querySelectorAll('input[data-m]').forEach(inp => inp.addEventListener('change', () => {
        const v = parseFloat(inp.value); if (isNaN(v) || v < 0) { inp.value = c.prices[inp.dataset.m][inp.dataset.k]; return; }
        c.prices[inp.dataset.m] = Object.assign({}, c.prices[inp.dataset.m], { [inp.dataset.k]: v }); host.saveSettings();
      }));
      box.querySelector('#rp-price-mode').onchange = e => { c.priceMode = e.target.value; host.saveSettings(); };
      box.querySelector('#rp-price-reset').onclick = () => { c.prices = Object.assign({}, R.DEFAULT_PRICES); host.saveSettings(); this.renderSettings(box, host); host.toast('已恢复默认价格'); };
    },

    // ---------------- 对话面板 ----------------
    panel: { tab: 'blocks', view: null, busy: null },
    onBack() { if (this.panel.view) { this.panel.view = null; this._render(); return true; } return false; },
    renderPanel(box, host, tab) {
      this._box = box; this._host = host;
      if (tab) { this.panel.tab = tab; this.panel.view = null; }
      this._render();
    },
    _render() {
      const box = this._box, host = this._host, conv = host.conv();
      if (!box || !conv) return;
      const on = reg.isActive(ID, host.settings(), conv);
      box.innerHTML = '';
      const head = document.createElement('div'); head.className = 'group form';
      head.innerHTML = '<label class="field inline"><span>在本对话启用 RP 缓存优化<small>每个对话是独立会话：设定 / 记忆 / 摘要 / 历史 / 状态 / 统计互不影响</small></span><input type="checkbox" class="switch" id="rp-on"' + (on ? ' checked' : '') + '></label>';
      box.appendChild(head);
      head.querySelector('#rp-on').onchange = e => {
        if (!reg.isGloballyEnabled(ID, host.settings())) { reg.setGlobal(host.settings(), ID, true); host.saveSettings(); }
        reg.setForConversation(conv, ID, e.target.checked); data(conv); host.saveConv(conv); host.refresh();
        host.toast(e.target.checked ? '已启用 RP 缓存优化' : '已关闭 RP 缓存优化（设定与摘要保留）'); this._render();
      };
      if (!on) {
        const tip = document.createElement('div'); tip.className = 'hint'; tip.style.marginTop = '12px';
        tip.innerHTML = '开启后，本对话的每次请求按固定的六层结构组织：<br><b>L1 永久锚点</b>（世界观 / 角色卡 / 规则…）→ <b>L2 长期记忆</b> → <b>L3 冻结章节摘要</b> → <b>L4 最近完整对话</b>（只追加）→ <b>L5 当前动态状态</b> → <b>L6 当前输入</b>。<br>' +
          '稳定内容在前、动态内容在后，让 DeepSeek 的上下文缓存尽可能命中。历史超出阈值时自动生成章节摘要，原始消息永远保留在本地。';
        box.appendChild(tip);
        return;
      }
      if (this.panel.view) { this.panel.view(box); return; }
      const seg = document.createElement('div'); seg.className = 'seg in-body';
      [['blocks', '分层设定'], ['summary', '章节摘要'], ['monitor', '缓存监控'], ['opts', '预算设置']].forEach(([k, t]) => {
        const b = document.createElement('button'); b.textContent = t; b.dataset.tab = k; if (k === this.panel.tab) b.className = 'active';
        b.onclick = () => { this.panel.tab = k; this._render(); };
        seg.appendChild(b);
      });
      box.appendChild(seg);
      const body = document.createElement('div'); box.appendChild(body);
      ({ blocks: this._blocks, summary: this._summary, monitor: this._monitor, opts: this._opts })[this.panel.tab].call(this, body, conv, host);
    },

    // ----- 分层设定 -----
    _blocks(body, conv, host) {
      const d = data(conv); const st = d.state; const p = planConv(conv);
      const base = R.canonicalize(conv.systemPrompt);
      const layer = (no, title, sub) => { const el = document.createElement('div'); el.className = 'layer-head'; el.innerHTML = '<span class="lh-no">' + no + '</span><span class="lh-t">' + title + '</span><span class="lh-sub">' + sub + '</span>'; body.appendChild(el); };
      const card = (title, meta, preview, fp, onClick, cls) => {
        const el = document.createElement('button'); el.className = 'rp-block' + (cls ? ' ' + cls : '');
        el.innerHTML = '<div class="rb-top"><span class="rb-title">' + host.esc(title) + '</span>' + meta + '</div>' +
          '<div class="rb-prev">' + (preview ? host.esc(preview.slice(0, 90)) : '<span class="muted">（空，不会发送）</span>') + '</div>' +
          (fp ? '<div class="rb-fp">SHA-256 ' + fp.slice(0, 12) + '…</div>' : '');
        if (onClick) el.onclick = onClick;
        body.appendChild(el);
      };
      const edit = id => () => { this.panel.view = box => this._editBlock(box, conv, host, id); this._render(); };
      const blockCard = id => {
        const b = R.getBlock(st, id); const def = R.BLOCK_DEFS.find(x => x.id === id);
        card(def.title, '<span class="rb-tag soft">[' + def.tag + ']</span><span class="rb-ver">v' + b.version + '</span>', b.content, b.content ? R.sha256(b.content) : '', edit(id));
      };
      const tip = document.createElement('div'); tip.className = 'hint';
      tip.textContent = '请求按 L1 → L6 的固定顺序组装。只有你手动保存且内容真正改变时版本号才会 +1，插件从不自动改写设定。越靠前的层越稳定，修改它会让其后的缓存全部重建。';
      body.appendChild(tip);
      layer('L1', '永久锚点', R.vlabel('static', st.staticVersion) + ' · ≈' + fmtN(p.tokens.static) + ' tokens');
      card('对话系统提示词 / 助手设定', '<span class="rb-tag soft">来自对话</span>', base, base ? R.sha256(base) : '',
        () => host.dialog({ title: '对话系统提示词 / 助手设定', body: (base || '（空）') + '\n\n这是本对话的系统提示词（或所选助手的设定），作为 L1 的第一部分。可在顶部模型菜单 →「本对话系统提示词」中修改；修改后 static 版本 +1。', okText: '知道了', info: true }), 'base');
      R.STATIC_DEFS.forEach(def => blockCard(def.id));
      layer('L2', '长期记忆', R.vlabel('memory', R.getBlock(st, 'memory').version) + ' · ≈' + fmtN(p.tokens.memory) + ' tokens');
      blockCard('memory');
      const act = R.activeSummary(st);
      layer('L3', '冻结章节摘要', act ? 'Summary ' + R.slabel(act.no) + ' · ≈' + fmtN(p.tokens.summary) + ' tokens' : '尚未生成');
      card(act ? 'Summary ' + R.slabel(act.no) : '章节摘要', '<span class="rb-tag t-memory">' + (act ? SRC[act.source] || act.source : '自动') + '</span>', act ? act.content : '', act ? act.hash : '', () => { this.panel.tab = 'summary'; this._render(); });
      layer('L4', '最近完整对话', p.hist.filter(m => m.role === 'user').length + ' 轮 · ≈' + fmtN(p.tokens.history) + ' tokens · 只追加');
      layer('L5', '当前动态状态', 'state v' + R.getBlock(st, 'state').version + ' · 放在最新输入之前');
      blockCard('state');
      layer('L6', '当前用户输入', '永远在最后');
      const prev = document.createElement('button'); prev.className = 'ghost-btn'; prev.id = 'rp-preview'; prev.textContent = '预览请求结构';
      prev.onclick = () => {
        const a = R.assemble(p); const n = a.messages.length;
        const txt = '── system ──\n' + (a.system || '（空）') + '\n\n── 历史 ' + p.hist.length + ' 条（原样）──\n' +
          p.hist.slice(-2).map(m => m.role + '：' + String(m.content).slice(0, 60)).join('\n') + '\n\n── 最后一条 user ──\n' + R.finalUserContent(st, '（你的下一条输入）') +
          '\n\n共 ' + (n + 1) + ' 条消息 · 估算 ' + fmtN(p.tokens.total) + ' tokens';
        host.dialog({ title: '请求结构预览', body: txt, okText: '关闭', info: true });
      };
      body.appendChild(prev);
    },

    _editBlock(box, conv, host, id) {
      const d = data(conv); const b = R.getBlock(d.state, id); const def = R.BLOCK_DEFS.find(x => x.id === id);
      const warn = def.layer === 'L1' ? '修改永久锚点（UPDATE_STATIC_BLOCK）会让全部缓存重建，建议攒到一起再改。保存后为 ' + R.vlabel('static', d.state.staticVersion + 1) + '。'
        : def.layer === 'L2' ? '只在发生重大事件时更新长期记忆；修改会让摘要与历史的缓存重建。保存后为 ' + R.vlabel('memory', b.version + 1) + '。'
        : '动态状态放在最新输入之前，每轮修改都不影响历史缓存。旧的状态不会留在历史里。';
      box.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div class="rp-edit-head"><button class="chip-btn" id="rb-back">‹ 返回</button><span class="rb-title">' + def.layer + ' · ' + host.esc(def.title) + '</span><span class="rb-ver">v' + b.version + '</span></div>' +
        '<div class="hint">' + host.esc(def.hint) + '<br><span class="muted">' + host.esc(warn) + '</span></div>' +
        '<div class="group form"><textarea id="rb-text" rows="12" placeholder="在这里输入' + host.esc(def.title) + '…"></textarea>' +
        '<div class="rb-meta" id="rb-meta"></div>' +
        '<div class="btn-row"><button class="pill-btn" id="rb-cancel">取消</button><button class="pill-btn primary" id="rb-save">保存</button></div></div>' +
        '<div class="group-title">版本历史</div><div class="group" id="rb-hist"></div>';
      box.appendChild(wrap);
      const ta = wrap.querySelector('#rb-text'); ta.value = b.content;
      const meta = () => {
        const c = R.canonicalize(ta.value);
        wrap.querySelector('#rb-meta').textContent = c.length + ' 字 · 约 ' + R.estimateTokens(c) + ' tokens · SHA-256 ' + R.sha256(c).slice(0, 12) + '…' + (c === b.content ? ' · 未修改' : ' · 保存后为 v' + (b.version + 1));
      };
      ta.addEventListener('input', meta); meta();
      const back = () => { this.panel.view = null; this._render(); };
      wrap.querySelector('#rb-back').onclick = back; wrap.querySelector('#rb-cancel').onclick = back;
      wrap.querySelector('#rb-save').onclick = () => {
        const r = R.setBlock(d.state, id, ta.value, Date.now());
        if (!r.changed) { host.toast('内容没有变化（仅空白/换行差异），版本保持 v' + b.version); back(); return; }
        d.state = r.state; host.saveConv(conv); host.refresh();
        host.toast(def.title + ' 已更新为 v' + R.getBlock(r.state, id).version); back();
      };
      const hist = wrap.querySelector('#rb-hist');
      if (!b.history.length) hist.innerHTML = '<div class="conv-empty">还没有历史版本</div>';
      b.history.slice().reverse().forEach(h => {
        const el = document.createElement('div'); el.className = 'prov-item hist-row';
        el.innerHTML = '<span class="rb-ver">v' + h.version + '</span><div class="pi-main"><div class="pi-name">' + host.esc((h.content || '（空）').slice(0, 40)) + '</div><div class="pi-sub">' +
          (h.at ? fmtTime(h.at) + ' · ' : '') + h.content.length + ' 字 · ' + h.hash.slice(0, 10) + '…</div></div><button class="chip-btn accent">恢复</button>';
        el.querySelector('button').onclick = async () => {
          const ok = await host.dialog({ title: '恢复到 v' + h.version + '？', body: '会以 v' + h.version + ' 的内容生成新版本 v' + (b.version + 1) + '，当前内容保留在历史中。', okText: '恢复' });
          if (!ok) return;
          const r = R.setBlock(d.state, id, null, Date.now(), h.version);
          if (!r.changed) { host.toast('与当前内容相同，无需恢复'); return; }
          d.state = r.state; host.saveConv(conv); host.refresh();
          host.toast('已恢复为 v' + h.version + ' 的内容（新版本 v' + R.getBlock(r.state, id).version + '）'); this._editBlock(box, conv, host, id);
        };
        hist.appendChild(el);
      });
    },

    // ----- 章节摘要 -----
    _summary(body, conv, host) {
      const d = data(conv); const st = d.state; const p = planConv(conv); const sum = st.settings.summary;
      const act = R.activeSummary(st);
      const unTok = R.estimateItems(p.unsummarized);
      const kv = (k, v, cls) => '<div class="kv' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>';
      let html = '<div class="hint">章节摘要是「阶段性冻结快照」：生成后就不再改动，直到下一次达到阈值才生成 ' + R.slabel((act ? act.no : 0) + 1) +
        '（合并上一版，只发送最新的一份）。被摘要的旧消息仍在聊天里（变灰），只是不再发送。</div>';
      html += '<div class="group form kv-box">' +
        kv('自动摘要', sum.enabled ? '开启' : '关闭', sum.enabled ? 'ok' : '') +
        kv('未摘要历史', '≈' + num(unTok) + ' / ' + num(sum.trigger_tokens) + ' tokens') +
        kv('可摘要的旧轮数', p.batchRounds + ' 轮（需 ≥ ' + sum.min_new_turns + '，保留最近 ' + sum.keep_recent_turns + ' 轮原文）') +
        kv('上下文预算', '≈' + num(p.tokens.total) + ' / ' + num(p.limit) + ' tokens', p.overBudget ? 'bad' : '') +
        kv('已摘要消息', (act ? act.coveredIds.length : 0) + ' 条') + '</div>';
      if (p.needSummary) html += '<div class="rp-suggest">下次发送时会先自动生成章节摘要（' + (p.summaryReason === 'budget' ? '超出上下文预算' : '达到摘要阈值') + '）。</div>';
      if (this.panel.busy) html += '<div class="rp-status"><span class="spin"></span>' + host.esc(this.panel.busy) + '</div>';
      html += '<button class="pill-btn primary wide" id="rp-sum-now"' + (this.panel.busy ? ' disabled' : '') + '>立即生成章节摘要</button>';
      html += '<div class="group-title">当前生效</div>';
      if (!act) html += '<div class="group"><div class="conv-empty">还没有章节摘要</div></div>';
      else html += '<button class="rp-block" id="rp-sum-cur"><div class="rb-top"><span class="rb-title">Summary ' + R.slabel(act.no) + '</span><span class="rb-tag t-memory">' + (SRC[act.source] || act.source) + '</span>' +
        '<span class="rb-ver">' + fmtN(R.estimateTokens(act.content)) + ' tok</span></div><div class="rb-prev">' + host.esc(act.content.slice(0, 120)) + '</div>' +
        '<div class="rb-fp">' + fmtTime(act.at) + ' · 覆盖 ' + act.coveredIds.length + ' 条 · SHA-256 ' + act.hash.slice(0, 12) + '… · 点击查看 / 编辑</div></button>';
      if (st.summaries.length > 1) {
        html += '<div class="group-title">历史版本</div><div class="group" id="rp-sum-hist"></div>';
      }
      body.innerHTML = html;
      body.querySelector('#rp-sum-now').onclick = () => this.manualSummary(conv, host);
      const cur = body.querySelector('#rp-sum-cur'); if (cur) cur.onclick = () => { this.panel.view = box => this._summaryView(box, conv, host); this._render(); };
      const hl = body.querySelector('#rp-sum-hist');
      if (hl) st.summaries.slice(0, -1).reverse().forEach(s => {
        const el = document.createElement('div'); el.className = 'prov-item hist-row';
        el.innerHTML = '<span class="rb-ver">' + R.slabel(s.no) + '</span><div class="pi-main"><div class="pi-name">' + host.esc(s.content.slice(0, 40)) + '</div><div class="pi-sub">' +
          (SRC[s.source] || s.source) + ' · ' + fmtTime(s.at) + ' · 覆盖 ' + s.coveredIds.length + ' 条</div></div><button class="chip-btn accent">回滚</button>';
        el.onclick = e => { if (e.target.tagName === 'BUTTON') return; host.dialog({ title: 'Summary ' + R.slabel(s.no), body: s.content, okText: '关闭', info: true }); };
        el.querySelector('button').onclick = async () => {
          const ok = await host.dialog({ title: '回滚到 ' + R.slabel(s.no) + '？', body: '会以 ' + R.slabel(s.no) + ' 的内容与覆盖范围生成新快照 ' + R.slabel(st.summaries.length + 1) + '。' +
            (s.coveredIds.length < act.coveredIds.length ? '之后被摘要的 ' + (act.coveredIds.length - s.coveredIds.length) + ' 条消息会重新发送原文。' : ''), okText: '回滚' });
          if (!ok) return;
          const r = R.rollbackSummary(d.state, s.no, Date.now());
          d.state = r.state; host.saveConv(conv); host.refresh(); host.toast('已回滚，当前为 ' + R.slabel(R.activeSummary(d.state).no)); this._render();
        };
        hl.appendChild(el);
      });
    },
    async manualSummary(conv, host) {
      const p = planConv(conv);
      if (!p.batch.length) { host.toast('最近不足 ' + p.st.settings.summary.keep_recent_turns + ' 轮，没有可摘要的旧对话（可在「预算设置」调小保留轮数）'); return; }
      const ok = await host.dialog({ title: '生成章节摘要？', body: '将把 ' + p.batch.length + ' 条较早的消息（' + p.batchRounds + ' 轮）与上一版摘要交给 ' + (p.st.settings.summary_model || conv.model) +
        ' 合并成新的章节摘要（一次额外的模型调用）。生成后可查看、编辑或回滚；原始消息不会删除。', okText: '生成' });
      if (!ok) return;
      this.panel.busy = '正在生成章节摘要…'; this.panel.tab = 'summary'; this.panel.view = null; this._render();
      try {
        const r = await makeSummary(host, conv, p, 'manual');
        data(conv).state = r.state; host.saveConv(conv); host.refresh();
        host.toast('已生成章节摘要 ' + R.slabel(r.no) + (r.missing.length ? '（缺少 ' + r.missing.join('/') + '，可手动补充）' : ''));
        this.panel.busy = null;
        this.panel.view = box => this._summaryView(box, conv, host);
      } catch (e) {
        this.panel.busy = null;
        host.dialog({ title: '摘要生成失败', body: String(e && e.message || e), okText: '知道了', info: true });
      }
      if (host.conv() === conv) this._render();
    },
    _summaryView(box, conv, host) {
      const d = data(conv); const act = R.activeSummary(d.state);
      if (!act) { this.panel.view = null; this._render(); return; }
      box.innerHTML = '<div class="rp-edit-head"><button class="chip-btn" id="sv-back">‹ 返回</button><span class="rb-title">L3 · Summary ' + R.slabel(act.no) + '</span><span class="rb-tag t-memory">' + (SRC[act.source] || act.source) + '</span></div>' +
        '<div class="hint">按「知识边界」格式保存：FACTS / CHARACTER_KNOWLEDGE / PLAYER_KNOWLEDGE / SECRET / UNRESOLVED / RELATIONSHIPS / OBJECTS / LOCATION。请检查角色是否「知道了不该知道的事」。修改后保存为新快照 ' + R.slabel(d.state.summaries.length + 1) + '。</div>' +
        '<div class="group form"><textarea id="sv-text" rows="16"></textarea><div class="rb-meta" id="sv-meta"></div>' +
        '<div class="btn-row"><button class="pill-btn" id="sv-cancel">关闭</button><button class="pill-btn primary" id="sv-save">保存修改</button></div></div>' +
        '<div class="hint small">覆盖 ' + act.coveredIds.length + ' 条消息 · ' + fmtTime(act.at) + (act.basedOn ? ' · 基于 ' + R.slabel(act.basedOn) : '') + '</div>';
      const ta = box.querySelector('#sv-text'); ta.value = act.content;
      const meta = () => { const c = R.canonicalize(ta.value); box.querySelector('#sv-meta').textContent = c.length + ' 字 · 约 ' + R.estimateTokens(c) + ' tokens' + (c === act.content ? ' · 未修改' : ' · 已修改'); };
      ta.addEventListener('input', meta); meta();
      const back = () => { this.panel.view = null; this._render(); };
      box.querySelector('#sv-back').onclick = back; box.querySelector('#sv-cancel').onclick = back;
      box.querySelector('#sv-save').onclick = () => {
        if (!R.canonicalize(ta.value)) { host.toast('摘要不能为空'); return; }
        const r = R.editSummary(d.state, ta.value, Date.now());
        if (!r.changed) { host.toast('内容没有变化'); back(); return; }
        d.state = r.state; host.saveConv(conv); host.refresh(); host.toast('已保存为 ' + R.slabel(R.activeSummary(d.state).no)); back();
      };
    },

    // ----- 缓存监控（第 22 / 24 / 39 节） -----
    _monitor(body, conv, host) {
      const c = cfg(host);
      const logs = loadLogs(host, conv);
      const s = R.stats(logs, c.prices, c.priceMode);
      const an = R.detectAnomaly(logs);
      const last = s.last;
      const kv = (k, v, cls) => '<div class="kv' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>';
      let html = '';
      if (an.anomaly) {
        html += '<div class="rp-alert"><b>⚠ Cache Hit Drop</b><div>最近平均 ' + pct(an.avg) + ' → 本次 ' + pct(an.current) + '</div><div class="ra-sub">可能原因：</div><ol>' +
          an.causes.map(x => '<li>' + host.esc(x) + '</li>').join('') + '</ol></div>';
      }
      html += '<div class="group-title">本次请求' + (last ? ' · ' + last.request_id : '') + '</div><div class="group form kv-box">';
      if (!last) html += '<div class="muted" style="padding:8px 0">还没有请求记录。发送一条消息后这里会显示 DeepSeek 返回的真实 usage。</div>';
      else {
        html += last.supported ? '<div class="hit-big ' + tone(last.hit_rate) + '">' + pct(last.hit_rate) + '<small>命中率</small></div>'
          : '<div class="muted" style="padding:8px 0">该服务商没有返回缓存字段（不支持统计）。DeepSeek 返回 prompt_cache_hit_tokens；OpenAI 返回 cached_tokens；Claude 返回 cache_read_input_tokens。</div>';
        html += '<div class="diag">' + R.LAYERS.map(k => { const v = (last.diag || {})[k] || '—'; return '<div class="dg-row"><span>' + R.LAYER_TITLES[k] + '</span><b class="dg-' + v.toLowerCase() + '">' + v + '</b></div>'; }).join('') + '</div>';
        html += '<div class="dg-reason"><span>Reason：</span>' + (last.reasons || [last.reason]).map(r => host.esc(r)).join('；') + '</div>';
        html += kv('是否发生摘要', last.summary_happened ? '是 · ' + R.slabel(last.summary_no) : last.summary_error ? '失败：' + host.esc(last.summary_error.slice(0, 30)) : '否') +
          kv('是否超预算', last.over_budget ? '是' : '否', last.over_budget ? 'bad' : '') +
          kv('Prompt Tokens', num(last.prompt_tokens)) + (last.supported ? kv('Cache Hit', num(last.cache_hit_tokens), 'ok') + kv('Cache Miss', num(last.cache_miss_tokens), 'bad') : '') +
          kv('Completion Tokens', num(last.completion_tokens));
      }
      html += '</div>';
      if (last && last.layer_tokens) {
        const lt = last.layer_tokens; const tot = R.LAYERS.reduce((n, k) => n + (lt[k] || 0), 0) || 1;
        html += '<div class="group-title">Context（本地估算 tokens）</div><div class="group form kv-box ctx-break">' +
          R.LAYERS.map(k => '<div class="cb-row"><span>' + R.LAYER_TITLES[k] + '</span><i style="width:' + Math.max(1, Math.round((lt[k] || 0) / tot * 100)) + '%" class="cb-' + k + '"></i><b>' + num(lt[k] || 0) + '</b></div>').join('') + '</div>';
      }
      html += '<div class="group-title">今日</div><div class="group form kv-box">' +
        kv('今日请求', s.today.requests) + kv('Prompt Tokens', num(s.today.prompt)) + kv('Cache Hit', num(s.today.hit), 'ok') + kv('Cache Miss', num(s.today.miss), 'bad') + kv('Hit Rate', pct(s.today.rate)) + '</div>';
      html += '<div class="group-title">本会话</div><div class="group form kv-box">' +
        '<div class="miss-big"><span>平均 Miss Tokens / 请求</span><b>' + num(s.avgMiss) + '</b><small>比命中率更能反映实际花费</small></div>' +
        kv('请求次数', s.requests + (s.supported < s.requests ? '（有统计 ' + s.supported + '）' : '')) + kv('平均命中率', pct(s.avgRate)) + kv('总命中率（按 token）', pct(s.total.rate)) +
        kv('最高 / 最低', pct(s.max) + ' / ' + pct(s.min)) + kv('连续命中次数', s.streak) + kv('章节摘要次数', s.summaries) +
        kv('估算已节省', s.priced ? fmtUsd(s.saved) : '—（非 DeepSeek 模型）', 'ok') + '</div>';
      html += '<div class="group-title">最近 ' + s.last20.length + ' 次</div><div class="group form kv-box">' +
        '<div class="mini-chart">' + (s.last20.length ? s.last20.map(r => '<i class="' + (r.supported ? tone(r.rate) : 'na') + '" style="height:' + (r.supported ? Math.max(4, Math.round(r.rate * 100)) : 4) + '%"></i>').join('') : '<span class="muted">暂无数据</span>') + '</div>' +
        '<div class="l20">' + s.last20.slice().reverse().map(r => '<div class="l20-row"><span class="l20-n">#' + r.n + '</span><b class="tone-t-' + (r.supported ? tone(r.rate) : 'info') + '">' + (r.supported ? pct(r.rate) : '—') + '</b><span class="l20-m">miss ' + fmtN(r.miss) + '</span><span class="l20-r">' + (r.summary ? '📚 ' : '') + host.esc(r.reason || '') + '</span></div>').join('') + '</div></div>';
      html += '<div class="hint" style="margin-top:12px">DeepSeek 缓存由服务端尽力而为（best-effort），插件只能让前缀更稳定，不能保证 100% 命中。Context 各层 tokens 为本地估算；日志默认只保存统计、哈希、时间、模型和请求 ID。</div>' +
        '<button class="ghost-btn danger" id="rp-clear-log">清空本会话统计</button>';
      body.innerHTML = html;
      body.querySelector('#rp-clear-log').onclick = async () => {
        const ok = await host.dialog({ title: '清空统计？', body: '只删除本对话的缓存统计记录，不影响聊天内容。', okText: '清空', danger: true });
        if (!ok) return; host.store.set(logKey(conv), []); this._render();
      };
    },

    // ----- 预算设置（每个会话独立） -----
    _opts(body, conv, host) {
      const d = data(conv); const s = d.state.settings;
      const n = (id, label, v, step) => '<label class="field"><span>' + label + '</span><input id="' + id + '" type="number" min="0" step="' + (step || 1) + '" value="' + v + '"></label>';
      body.innerHTML = '<div class="hint">STATIC + MEMORY + SUMMARY + HISTORY + STATE + INPUT + 输出预留 + 安全余量 ≤ 最大上下文。以下数值为工程起始值（不是 DeepSeek 官方阈值），每个对话单独设置。</div>' +
        '<div class="group-title">Token 预算</div><div class="group form">' +
        '<div class="field-row">' + n('rp-maxctx', '最大上下文', s.max_context, 1000) + n('rp-reserve', '输出预留', s.output_reserve, 1000) + '</div>' +
        '<div class="field-row">' + n('rp-margin', '安全余量', s.safety_margin, 500) + '<span class="field"></span></div></div>' +
        '<div class="group-title">章节摘要</div><div class="group form">' +
        '<label class="field inline"><span>超过阈值自动生成摘要<small>关闭后超预算时只能一次性截断旧历史</small></span><input type="checkbox" class="switch" id="rp-sum-on"' + (s.summary.enabled ? ' checked' : '') + '></label>' +
        '<div class="field-row">' + n('rp-trigger', '触发阈值 tokens', s.summary.trigger_tokens, 1000) + n('rp-minnew', '最少新增轮数', s.summary.min_new_turns) + '</div>' +
        '<div class="field-row">' + n('rp-keep', '保留最近轮数', s.summary.keep_recent_turns) + '<span class="field"></span></div>' +
        '<label class="field"><span>摘要所用模型（留空 = 与对话相同）</span><input id="rp-summodel" type="text" placeholder="例如 deepseek-flash" value="' + host.esc(s.summary_model || '') + '"></label>' +
        '<div class="hint small" style="margin:0">未摘要历史 ≥ 触发阈值，且除最近 N 轮外至少还有「最少新增轮数」轮时生成下一版摘要；超出上下文预算时立即摘要。</div></div>' +
        '<div class="group-title">调试</div><div class="group form">' +
        '<label class="field inline"><span>保存完整 Prompt（save_prompt）<small>默认关闭：日志只保存 Token 统计、哈希、时间、模型和请求 ID</small></span><input type="checkbox" class="switch" id="rp-saveprompt"' + (s.save_prompt ? ' checked' : '') + '></label></div>' +
        '<button class="ghost-btn" id="rp-reset-win">重置截断起点</button>';
      const save = () => {
        const s = data(conv).state.settings;
        const g = (id, min, def) => { const v = parseInt(body.querySelector(id).value, 10); return isNaN(v) ? def : Math.max(min, v); };
        s.max_context = g('#rp-maxctx', 4000, 100000); s.output_reserve = g('#rp-reserve', 0, 12000); s.safety_margin = g('#rp-margin', 0, 2000);
        s.summary = { enabled: body.querySelector('#rp-sum-on').checked, trigger_tokens: g('#rp-trigger', 1000, 30000), min_new_turns: g('#rp-minnew', 1, 15), keep_recent_turns: g('#rp-keep', 1, 20) };
        s.summary_model = body.querySelector('#rp-summodel').value.trim();
        host.saveConv(conv); host.refresh();
      };
      body.querySelectorAll('input:not(#rp-saveprompt)').forEach(i => i.addEventListener('change', save));
      body.querySelector('#rp-saveprompt').onchange = async e => {
        if (e.target.checked) {
          const ok = await host.dialog({ title: '开启完整 Prompt 日志？', body: '日志可能包含角色卡、私密剧情、API 请求内容，请谨慎使用。\n\n日志只保存在本机（不会上传），可随时在「缓存监控」中清空。', okText: '仍然开启', danger: true });
          if (!ok) { e.target.checked = false; return; }
        }
        data(conv).state.settings.save_prompt = e.target.checked; host.saveConv(conv);
        host.toast(e.target.checked ? '已开启完整 Prompt 日志' : '已关闭完整 Prompt 日志');
      };
      body.querySelector('#rp-reset-win').onclick = () => { data(conv).state.window = { startId: null, startOrdinal: 0 }; host.saveConv(conv); host.refresh(); host.toast('已重置截断起点'); };
    },
  });
  plugin._internals = { toItems, makeSummary, planConv, loadLogs };

  // 第二个内置插件：Token 用量显示（演示通用钩子；对所有对话生效，可在对话中关闭）
  reg.register({
    id: 'usage', icon: '📊', name: 'Token 用量显示', version: '1.0.0', perConversation: false, defaultEnabled: false,
    desc: '在每条回复上显示本次请求的输入 / 输出 tokens（服务商返回 usage 时）。',
    hooks: {
      messageBadges(msg) {
        if (msg.role !== 'assistant' || !msg.usage || msg.usage.prompt == null) return [];
        return [{ text: '↑' + fmtN(msg.usage.prompt) + ' ↓' + fmtN(msg.usage.completion || 0), tone: 'info', title: '输入 ' + msg.usage.prompt + ' / 输出 ' + (msg.usage.completion || 0) + ' tokens' }];
      },
    },
  });
})();
