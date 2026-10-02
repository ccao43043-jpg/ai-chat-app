/* AI Chat —— 前端逻辑 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const bridge = window.AndroidBridge || null;
  const APP_VERSION = '0.3.1';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = {
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>',
    redo: '<svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 5v6h-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    chevR: '<svg class="chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></svg>',
    tune: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5s1.2-6.1 3.6-8.5z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
    dup: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="3"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/><path d="M14 11v6M11 14h6"/></svg>',
    chat: '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 01-11.6 7.1L4 20l1-4.1A8 8 0 1120 12z"/></svg>',
    warn: '<svg viewBox="0 0 24 24"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/></svg>',
  };
  const PROVIDER_COLORS = { openai: '#10a37f', deepseek: '#4d6bfe', qwen: '#615ced', moonshot: '#16191e', zhipu: '#2f5bff',
    siliconflow: '#7c3aed', openrouter: '#6467f2', anthropic: '#d97757', gemini: '#4285f4', custom: '#64748b' };
  function avatarHtml(p, cls) {
    const color = PROVIDER_COLORS[p && p.presetId] || PROVIDER_COLORS.custom;
    const ch = ((p && p.name) || '?').trim().charAt(0).toUpperCase();
    return '<span class="avatar ' + (cls || '') + '" style="background:' + color + '">' + esc(ch) + '</span>';
  }

  // ---------------- 存储 ----------------
  const Store = {
    get(name, def) {
      try {
        const v = bridge ? bridge.storeGet(name) : localStorage.getItem('aichat_' + name);
        return v == null ? def : JSON.parse(v);
      } catch (e) { return def; }
    },
    set(name, val) {
      const s = JSON.stringify(val);
      if (bridge) bridge.storeSet(name, s); else localStorage.setItem('aichat_' + name, s);
    },
    del(name) { if (bridge) bridge.storeDelete(name); else localStorage.removeItem('aichat_' + name); },
  };

  // ---------------- 原生 HTTP ----------------
  const pending = {};
  window.__nativeHttp = {
    onStart(id, status) { const h = pending[id]; if (h) { h.status = status; h.onStatus && h.onStatus(status); } },
    onChunk(id, text) { const h = pending[id]; if (h) h.onChunk && h.onChunk(text); },
    onEnd(id) { const h = pending[id]; if (h) { delete pending[id]; h.resolve(); } },
    onError(id, msg) { const h = pending[id]; if (h) { delete pending[id]; h.reject(new Error(msg)); } },
  };
  function httpRequest(req, handlers) {
    const id = uid();
    let cancel;
    const promise = new Promise((resolve, reject) => {
      pending[id] = Object.assign({ resolve, reject }, handlers);
      if (bridge) {
        bridge.request(id, req.method, req.url, JSON.stringify(req.headers || {}), req.body || '', 600);
        cancel = () => bridge.cancel(id);
      } else { // 浏览器调试回退（会受 CORS 限制）
        const ctl = new AbortController();
        cancel = () => ctl.abort();
        fetch(req.url, { method: req.method, headers: req.headers, body: req.body || undefined, signal: ctl.signal }).then(async res => {
          window.__nativeHttp.onStart(id, res.status);
          const reader = res.body.getReader(); const dec = new TextDecoder();
          for (;;) { const { done, value } = await reader.read(); if (done) break; window.__nativeHttp.onChunk(id, dec.decode(value, { stream: true })); }
          window.__nativeHttp.onEnd(id);
        }).catch(e => e.name === 'AbortError' ? window.__nativeHttp.onEnd(id) : window.__nativeHttp.onError(id, String(e)));
      }
    });
    return { promise, cancel: () => cancel && cancel() };
  }
  /** 简单的一次性请求，返回 {status, text} */
  function httpSimple(req) {
    let status = 0, text = '';
    const h = httpRequest(req, { onStatus: s => { status = s; }, onChunk: t => { text += t; } });
    return h.promise.then(() => ({ status, text }));
  }

  // ---------------- 状态 ----------------
  const presetToProvider = p => ({ id: p.presetId, presetId: p.presetId, name: p.name, type: p.type, baseUrl: p.baseUrl,
    apiKey: '', models: p.models.slice(), imageModel: p.imageModel || '' });
  const defaultSettings = () => ({
    providers: Providers.PRESETS.map(presetToProvider),
    systemPrompt: '', stream: true, temperature: '', maxTokens: '', imageSize: '1024x1024',
    lastProviderId: '', lastModel: '', settingsVersion: Providers.SETTINGS_VERSION,
    search: defaultSearch(), searchOn: false, removedPersonas: [],
  });
  function defaultSearch() { return { provider: 'tavily', keys: {}, urls: {}, count: 5, rewrite: false }; }
  const stored = Store.get('settings.json', null);
  let settings = stored ? Object.assign(defaultSettings(), { settingsVersion: 1 }, stored) : defaultSettings();
  let convIndex = Store.get('convs.json', []); // [{id,title,providerId,model,updatedAt}]
  let conv = null;
  let attachments = [];   // 图片 data URL
  let docs = [];          // 待发送的文件 [{id,name,size,kind,status,text,...}]
  let imageMode = false;
  let running = null;
  let lastRequest = null;

  settings.search = Object.assign(defaultSearch(), settings.search || {});
  let personas = Personas.mergeBuiltins(Store.get('personas.json', null) || Personas.defaultPersonas(), settings.removedPersonas);
  let prompts = (Store.get('prompts.json', null) || Personas.defaultPrompts()).map(Personas.normalizePrompt);
  const savePersonas = () => Store.set('personas.json', personas);
  const savePrompts = () => Store.set('prompts.json', prompts);
  let templates = Templates.mergeBuiltins(Store.get('templates.json', null) || Templates.defaultTemplates(), settings.removedTemplates);
  const saveTemplates = () => Store.set('templates.json', templates);
  const saveSettings = () => Store.set('settings.json', settings);
  const saveIndex = () => Store.set('convs.json', convIndex);
  function saveConv(c, touch) {
    c = c || conv; if (!c) return;
    if (touch !== false) c.updatedAt = Date.now();
    Store.set('conv_' + c.id + '.json', c);
    const meta = { id: c.id, title: c.title, providerId: c.providerId, model: c.model, updatedAt: c.updatedAt };
    if (c.personaName) { meta.personaName = c.personaName; meta.personaEmoji = c.personaEmoji; }
    const i = convIndex.findIndex(x => x.id === c.id);
    if (i >= 0) convIndex[i] = meta; else convIndex.unshift(meta);
    convIndex.sort((a, b) => b.updatedAt - a.updatedAt);
    saveIndex();
  }
  const getProvider = id => settings.providers.find(p => p.id === id);
  const configured = () => settings.providers.filter(p => p.apiKey && p.apiKey.trim());

  // ---------------- 升级迁移（不改 API Key） ----------------
  (function migrate() {
    const r = Providers.migrateSettings(settings);
    if (!r.changed) return;
    settings = r.settings;
    let n = 0;
    convIndex.forEach(meta => {
      const c = Store.get('conv_' + meta.id + '.json', null);
      if (c && Providers.migrateConversation(c, settings.providers)) { saveConv(c, false); n++; }
    });
    saveSettings();
    if (n) console.log('migrated conversations: ' + n);
  })();
  // 合并新增的预设
  Providers.PRESETS.forEach(pr => {
    if (pr.presetId !== 'custom' && !settings.providers.some(p => p.presetId === pr.presetId) && !(settings.removedPresets || []).includes(pr.presetId))
      settings.providers.push(presetToProvider(pr));
  });

  // ---------------- 工具 ----------------
  let toastTimer;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1900); }
  function openUrl(u) {
    if (!/^https?:\/\//i.test(u || '')) return;
    if (bridge && bridge.openUrl) bridge.openUrl(u); else window.open(u, '_blank', 'noopener');
  }
  function copyText(t) { if (bridge) bridge.copy(t); else navigator.clipboard && navigator.clipboard.writeText(t).catch(() => {}); toast('已复制'); }

  let dialogResolve = null;
  function dialog({ title, body, input, value, okText, danger, info }) {
    $('#dialog-cancel').style.display = info ? 'none' : '';
    $('#dialog-title').textContent = title || '';
    $('#dialog-body').textContent = body || '';
    const inp = $('#dialog-input');
    inp.style.display = input ? '' : 'none'; inp.value = value || '';
    const ok = $('#dialog-ok'); ok.textContent = okText || '确定';
    ok.className = 'pill-btn ' + (danger ? 'danger' : 'primary');
    $('#dialog-mask').classList.add('show');
    if (input) setTimeout(() => { inp.focus(); inp.select(); }, 80);
    return new Promise(res => { dialogResolve = res; });
  }
  function closeDialog(result) { $('#dialog-mask').classList.remove('show'); if (dialogResolve) { const r = dialogResolve; dialogResolve = null; r(result); } }
  $('#dialog-ok').onclick = () => closeDialog($('#dialog-input').style.display === 'none' ? true : $('#dialog-input').value);
  $('#dialog-cancel').onclick = () => closeDialog(null);
  $('#dialog-mask').onclick = e => { if (e.target.id === 'dialog-mask') closeDialog(null); };
  $('#dialog-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#dialog-ok').click(); });

  // 操作菜单
  function actionSheet(title, items) {
    $('#action-title').textContent = title || '';
    const list = $('#action-list'); list.innerHTML = '';
    items.forEach(it => {
      const b = document.createElement('button'); b.className = 'action-item' + (it.danger ? ' danger' : '');
      b.innerHTML = (it.icon || '') + '<span>' + esc(it.label) + '</span>';
      b.onclick = () => { closeActionSheet(); setTimeout(it.onClick, 120); };
      list.appendChild(b);
    });
    $('#action-sheet').classList.add('show'); $('#action-mask').classList.add('show');
  }
  function closeActionSheet() { $('#action-sheet').classList.remove('show'); $('#action-mask').classList.remove('show'); }
  $('#action-mask').onclick = closeActionSheet;

  // ---------------- Markdown ----------------
  marked.setOptions({ gfm: true, breaks: true });
  /** 把正文中的 [1]、[2][3]、[1, 2] 变成可点击的角标（跳过代码和链接） */
  function linkCitations(root, sources) {
    if (!sources || !sources.length) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement.closest('code, pre, a') ? NodeFilter.FILTER_REJECT : /\[\d/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    const re = /\[(\d{1,2}(?:\s*[,，、]\s*\d{1,2})*)\]/g;
    nodes.forEach(node => {
      const t = node.nodeValue; let last = 0, m, changed = false;
      const frag = document.createDocumentFragment();
      while ((m = re.exec(t))) {
        const nums = m[1].split(/[,，、]/).map(x => parseInt(x, 10));
        if (!nums.every(n => n >= 1 && n <= sources.length)) continue;
        changed = true;
        frag.appendChild(document.createTextNode(t.slice(last, m.index)));
        nums.forEach(n => {
          const a = document.createElement('button'); a.className = 'cite'; a.textContent = n; a.dataset.n = n;
          a.title = sources[n - 1].title; a.onclick = e => { e.stopPropagation(); openUrl(sources[n - 1].url); };
          frag.appendChild(a);
        });
        last = m.index + m[0].length;
      }
      if (!changed) return;
      frag.appendChild(document.createTextNode(t.slice(last)));
      node.replaceWith(frag);
    });
  }
  function renderMarkdown(text, sources) {
    const div = document.createElement('div');
    div.className = 'md';
    div.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
    linkCitations(div, sources);
    div.querySelectorAll('pre > code').forEach(code => {
      const pre = code.parentElement;
      const m = /language-([\w+#.-]+)/.exec(code.className || '');
      const lang = m ? m[1] : '';
      const raw = code.textContent;
      try {
        if (lang && hljs.getLanguage(lang)) code.innerHTML = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
        else if (raw.length < 20000) code.innerHTML = hljs.highlightAuto(raw).value;
        code.classList.add('hljs');
      } catch (e) { /* ignore */ }
      const wrap = document.createElement('div'); wrap.className = 'code-block';
      const head = document.createElement('div'); head.className = 'code-head';
      head.innerHTML = '<span>' + esc(lang || 'code') + '</span><button>' + ICON.copy + '复制</button>';
      head.querySelector('button').onclick = () => copyText(raw);
      pre.replaceWith(wrap); wrap.appendChild(head); wrap.appendChild(pre);
    });
    div.querySelectorAll('a').forEach(a => {
      a.setAttribute('target', '_blank');
      a.onclick = e => { const h = a.getAttribute('href') || ''; if (/^https?:/i.test(h)) { e.preventDefault(); openUrl(h); } };
    });
    return div;
  }

  // ---------------- 对话管理 ----------------
  function newConv() {
    const lp = getProvider(settings.lastProviderId);
    const pid = lp && lp.apiKey ? lp.id : ((configured()[0] || {}).id || '');
    const p = getProvider(pid);
    const model = settings.lastProviderId === pid && settings.lastModel ? settings.lastModel : (p ? p.models[0] || '' : '');
    conv = { id: uid(), title: '新对话', providerId: pid, model, systemPrompt: settings.systemPrompt || '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    const dt = settings.defaultTemplateId && templates.find(t => t.id === settings.defaultTemplateId);
    if (dt && !Templates.variables(dt.content).length) Object.assign(conv, Templates.applyToConv(conv, dt));
    renderAll();
  }
  function openConv(id) {
    const c = Store.get('conv_' + id + '.json', null);
    if (!c) { convIndex = convIndex.filter(x => x.id !== id); saveIndex(); renderConvList(); return false; }
    conv = c; renderAll(); return true;
  }
  async function deleteConv(id) {
    const meta = convIndex.find(x => x.id === id);
    const ok = await dialog({ title: '删除对话？', body: '「' + (meta ? meta.title : '') + '」将被永久删除。', okText: '删除', danger: true });
    if (!ok) return;
    if (running && conv && conv.id === id) stopGen();
    Store.del('conv_' + id + '.json'); Store.del('rplog_' + id + '.json');
    convIndex = convIndex.filter(x => x.id !== id); saveIndex();
    if (conv && conv.id === id) newConv(); else renderConvList();
    toast('已删除');
  }
  async function renameConv(id) {
    const c = conv && conv.id === id ? conv : Store.get('conv_' + id + '.json', null);
    if (!c) return;
    const t = await dialog({ title: '重命名对话', input: true, value: c.title });
    if (t == null || !t.trim()) return;
    c.title = t.trim(); saveConv(c, false);
    if (conv && conv.id === id) conv.title = c.title;
    renderConvList();
  }

  // ---------------- 渲染 ----------------
  function renderAll() { renderHeader(); renderMessages(); renderConvList(); }
  function renderConvBar() {
    const bar = $('#conv-bar'); if (!bar) return;
    const badges = conv ? Plugins.registry.headerBadges(settings, conv, pluginHost) : [];
    if (conv && conv.templateName) badges.unshift({ text: (conv.templateEmoji || '📋') + ' ' + conv.templateName, tone: 'info', title: '当前提示词模板（点击切换）', action: openTemplateSheet, cls: 'tpl' });
    renderTplChip();
    bar.innerHTML = '';
    bar.classList.toggle('show', badges.length > 0);
    badges.forEach(b => {
      const el = document.createElement('button'); el.className = 'hbadge tone-' + (b.tone || 'info') + (b.cls ? ' ' + b.cls : ''); el.textContent = b.text; if (b.title) el.title = b.title;
      if (b.action) el.onclick = b.action;
      bar.appendChild(el);
    });
  }
  function renderHeader() {
    const p = getProvider(conv.providerId);
    const ok = p && p.apiKey;
    $('#mp-model').textContent = ok ? (conv.model || '未设置模型') : (configured().length ? '选择模型' : '未配置服务商');
    $('#mp-provider').textContent = ok ? (conv.personaName ? conv.personaEmoji + ' ' + conv.personaName + ' · ' + p.name : p.name) : (configured().length ? '点此切换' : '点此添加 API Key');
    const dot = $('#mp-dot');
    dot.style.background = ok ? (PROVIDER_COLORS[p.presetId] || PROVIDER_COLORS.custom) : '';
    dot.textContent = ok ? p.name.trim().charAt(0).toUpperCase() : '';
    renderConvBar();
  }
  function dayGroup(t) {
    const d = new Date(t); const n = new Date();
    const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    if (t >= start) return '今天';
    if (t >= start - 864e5) return '昨天';
    if (t >= start - 7 * 864e5) return '近 7 天';
    if (t >= start - 30 * 864e5) return '近 30 天';
    return d.getFullYear() === n.getFullYear() ? (d.getMonth() + 1) + ' 月' : d.getFullYear() + ' 年';
  }
  function renderConvList() {
    const list = $('#conv-list');
    const q = ($('#conv-search').value || '').trim().toLowerCase();
    const items = convIndex.filter(m => !q || (m.title || '').toLowerCase().includes(q) || (m.model || '').toLowerCase().includes(q));
    if (!items.length) { list.innerHTML = '<div class="conv-empty">' + (q ? '没有匹配的对话' : '还没有对话<br>点击上方「新对话」开始') + '</div>'; return; }
    list.innerHTML = '';
    let last = '';
    items.forEach(m => {
      const g = dayGroup(m.updatedAt);
      if (g !== last) { const h = document.createElement('div'); h.className = 'conv-group'; h.textContent = g; list.appendChild(h); last = g; }
      const p = getProvider(m.providerId);
      const el = document.createElement('div');
      el.className = 'conv-item' + (conv && conv.id === m.id ? ' active' : '');
      el.innerHTML = '<div class="ci-main"><div class="ci-title">' + esc(m.title) + '</div><div class="ci-sub">' +
        esc((m.personaName ? m.personaName + ' · ' : '') + (p ? p.name + ' · ' : '') + (m.model || '')) + '</div></div><button class="ci-more" aria-label="更多">' + ICON.more + '</button>';
      el.querySelector('.ci-more').onclick = e => {
        e.stopPropagation();
        actionSheet(m.title, [
          { label: '重命名', icon: ICON.rename, onClick: () => renameConv(m.id) },
          { label: '删除', icon: ICON.trash, danger: true, onClick: () => deleteConv(m.id) },
        ]);
      };
      el.onclick = () => {
        if (running) { toast('请先停止当前生成'); return; }
        openConv(m.id); closeDrawer();
      };
      list.appendChild(el);
    });
  }
  const SUGGESTIONS = [
    { t: '写一封邮件', d: '向客户说明项目延期并致歉', p: '帮我写一封邮件，向客户说明项目将延期一周，语气诚恳专业。' },
    { t: '解释概念', d: '用简单的话讲清楚一个知识点', p: '用通俗易懂的方式解释一下什么是大语言模型，并举个生活中的例子。' },
    { t: '写段代码', d: 'Python 批量重命名文件', p: '写一个 Python 脚本，把一个文件夹里的所有图片按拍摄日期重命名。' },
    { t: '旅行规划', d: '制定三天两晚的行程', p: '帮我规划一个杭州三天两晚的旅行行程，包含美食推荐。' },
  ];
  function renderMessages() {
    const box = $('#messages');
    box.innerHTML = '';
    if (!conv.messages.length) {
      const has = configured().length > 0;
      const empty = document.createElement('div'); empty.className = 'empty';
      if (conv.personaName && has) {
        const ps = personas.find(x => x.id === conv.personaId);
        empty.innerHTML = '<div class="hero-emoji">' + esc(conv.personaEmoji) + '</div><h1>' + esc(conv.personaName) + '</h1>' +
          '<p class="sub">' + esc((ps && ps.desc) || '已加载助手设定') + '</p>' +
          '<div class="persona-note">' + ICON.chat + '<span>已载入「' + esc(conv.personaName) + '」的系统提示词，直接发消息即可开始。</span></div>' +
          '<button class="link-btn" id="empty-switch">换一个助手</button>';
        box.appendChild(empty);
        $('#empty-switch').onclick = () => openPersonas();
        return;
      }
      empty.innerHTML = '<img class="hero-logo" src="logo.svg" alt=""><h1>AI Chat</h1>' +
        (has ? '<p class="sub">你好，今天想聊点什么？</p><div class="suggest"></div>' +
          '<div class="persona-strip-head"><span>从助手开始</span><button class="link-btn" id="empty-all-personas">全部 ›</button></div><div class="persona-strip"></div>'
             : '<p class="sub">一个应用，连接多家 AI 服务</p><div class="setup-card"><b>开始之前</b><ol><li>打开设置，选择一个服务商</li><li>粘贴你的 API Key 并保存</li><li>回到这里，点顶部切换模型即可聊天</li></ol><button class="pill-btn primary" id="empty-setup" style="width:100%">去设置 API Key</button></div>');
      box.appendChild(empty);
      if (has) {
        const sg = empty.querySelector('.suggest');
        SUGGESTIONS.forEach(s => {
          const b = document.createElement('button');
          b.innerHTML = '<b>' + esc(s.t) + '</b><span>' + esc(s.d) + '</span>';
          b.onclick = () => { input.value = s.p; autosize(); updateSendState(); input.focus(); };
          sg.appendChild(b);
        });
        const strip = empty.querySelector('.persona-strip');
        personas.slice(0, 8).forEach(ps => {
          const b = document.createElement('button'); b.className = 'pchip';
          b.innerHTML = '<span class="pc-emoji">' + esc(ps.emoji) + '</span><span>' + esc(ps.name) + '</span>';
          b.onclick = () => startFromPersona(ps);
          strip.appendChild(b);
        });
        $('#empty-all-personas').onclick = () => openPersonas();
      } else $('#empty-setup').onclick = openSettings;
      return;
    }
    conv.messages.forEach(m => box.appendChild(buildMsgEl(m)));
    box.scrollTop = box.scrollHeight;
  }
  function buildMsgEl(m) {
    const el = document.createElement('div');
    el.dataset.id = m.id;
    fillMsgEl(el, m);
    return el;
  }
  function fillMsgEl(el, m) {
    el.className = 'msg ' + m.role + (m.error ? ' error' : '');
    el.innerHTML = '';
    const pst = !m.pending ? Plugins.registry.messageState(m, settings, conv, pluginHost) : null;
    if (pst && pst.dim) el.classList.add(pst.light ? 'dim-light' : 'dim');
    if (pst && pst.label) { const lb = document.createElement('div'); lb.className = 'msg-state'; lb.textContent = pst.label; el.appendChild(lb); }
    const isLast = conv.messages[conv.messages.length - 1] === m;
    if (m.role === 'assistant') {
      const head = document.createElement('div'); head.className = 'bot-head';
      const pe = m.personaEmoji || (!m.imageGen && conv.personaEmoji);
      const pn = m.personaName || (!m.imageGen && conv.personaName);
      head.innerHTML = (pe ? '<span class="bot-avatar emoji">' + esc(pe) + '</span>' : '<img class="bot-avatar" src="logo.svg" alt="">') +
        '<span class="bot-name">' + (pn ? '<b>' + esc(pn) + '</b> · ' : '') + esc(m.model || 'AI') + (m.stopped ? ' · 已停止' : '') + '</span>';
      if (!m.pending) Plugins.registry.messageBadges(m, settings, conv, pluginHost).forEach(b => {
        const bd = document.createElement('button'); bd.className = 'mbadge tone-' + (b.tone || 'info'); bd.textContent = b.text; if (b.title) bd.title = b.title;
        if (b.action) bd.onclick = e => { e.stopPropagation(); b.action(); };
        head.appendChild(bd);
      });
      el.appendChild(head);
    }
    if (m.files && m.files.length) el.appendChild(buildFileChips(m.files));
    if (m.images && m.images.length) {
      const imgs = document.createElement('div'); imgs.className = 'msg-images';
      m.images.forEach(src => { const i = document.createElement('img'); i.src = src; i.onclick = () => openViewer(src); imgs.appendChild(i); });
      el.appendChild(imgs);
    }
    if (m.role === 'user') {
      if (m.content) { const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.content; el.appendChild(b); }
    } else {
      const body = document.createElement('div'); body.className = 'bot-body';
      if (m.searching) {
        const st = document.createElement('div'); st.className = 'search-status';
        st.innerHTML = ICON.globe + '<span>' + (m.searchQuery ? '正在联网搜索：' + esc(m.searchQuery) : '正在提炼搜索关键词…') + '</span>';
        body.appendChild(st);
      }
      if (m.pluginStatus && m.pending) {
        const st = document.createElement('div'); st.className = 'search-status plugin-status';
        st.innerHTML = '<span class="spin"></span><span>' + esc(m.pluginStatus) + '</span>';
        body.appendChild(st);
      }
      if (m.searchError) {
        const st = document.createElement('div'); st.className = 'search-status warn';
        st.innerHTML = ICON.warn + '<span>' + esc(m.searchError) + '</span>';
        body.appendChild(st);
      }
      if (m.sources && m.sources.length) body.appendChild(buildSources(m));
      if (m.reasoning) {
        const d = document.createElement('details'); d.className = 'reasoning'; if (m.pending && !m.content) d.open = true;
        d.innerHTML = '<summary><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' + (m.pending && !m.content ? '思考中…' : '思考过程') + '</summary><div class="r-text"></div>';
        d.querySelector('.r-text').textContent = m.reasoning;
        body.appendChild(d);
      }
      if (m.content) { const md = renderMarkdown(m.content, m.sources); if (m.pending) md.classList.add('cursor'); body.appendChild(md); }
      if (m.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = m.error; body.appendChild(e); }
      if (!m.content && !m.error) {
        if (m.pending && !m.reasoning && !m.searching && !m.pluginStatus) { const t = document.createElement('div'); t.className = 'typing'; t.innerHTML = '<i></i><i></i><i></i>'; body.appendChild(t); }
        else if (!m.pending && !m.reasoning && !(m.images && m.images.length)) { const e = document.createElement('div'); e.className = 'muted'; e.textContent = m.stopped ? '（已停止）' : '（空回复）'; body.appendChild(e); }
      }
      if (body.childNodes.length) el.appendChild(body);
    }
    if (!m.pending) {
      const act = document.createElement('div'); act.className = 'actions';
      if (m.content) act.appendChild(mkAct(ICON.copy, '复制', () => copyText(m.content)));
      if (m.role === 'assistant' && isLast && !running) act.appendChild(mkAct(ICON.redo, '重新生成', regenerate));
      if (m.role === 'user' && !running && !m.imageGen) act.appendChild(mkAct(ICON.edit, '编辑', () => editUserMsg(m)));
      if (!running) act.appendChild(mkAct(ICON.trash, '删除', () => deleteMsg(m)));
      el.appendChild(act);
    }
  }
  const KIND_LABEL = { pdf: 'PDF', docx: 'Word', pptx: 'PPT', xlsx: 'Excel', text: '文本', unknown: '文本' };
  function fileMeta(f) {
    if (f.status === 'loading') return '正在读取…';
    if (f.error) return f.error;
    const parts = [KIND_LABEL[f.kind] || '文件'];
    if (f.pages) parts.push(f.pages + ' 页');
    if (f.scanned) parts.push('扫描件，已转图片');
    else if (f.total != null) parts.push(f.total >= 10000 ? (f.total / 10000).toFixed(1) + ' 万字' : f.total + ' 字');
    if (f.truncated) parts.push('已截断');
    return parts.join(' · ');
  }
  function fileChipHtml(f) {
    const cls = 'file-chip k-' + (f.kind || 'text') + (f.error ? ' bad' : '') + (f.status === 'loading' ? ' loading' : '');
    const ext = (Files.extOf(f.name) || 'txt').slice(0, 4).toUpperCase();
    return '<div class="' + cls + '"><span class="fc-ic">' + esc(ext) + '</span><span class="fc-main"><span class="fc-name">' + esc(f.name) +
      '</span><span class="fc-meta">' + esc(fileMeta(f)) + '</span></span></div>';
  }
  function buildFileChips(files) {
    const box = document.createElement('div'); box.className = 'msg-files';
    files.forEach(f => {
      const w = document.createElement('div'); w.innerHTML = fileChipHtml(f);
      const chip = w.firstChild;
      chip.onclick = () => previewFile(f);
      box.appendChild(chip);
    });
    return box;
  }
  function previewFile(f) {
    if (f.error) { dialog({ title: f.name, body: f.error, okText: '知道了', info: true }); return; }
    if (f.scanned) { dialog({ title: f.name, body: '这个 PDF 没有可提取的文字层（可能是扫描件或纯图片）。已把前 ' + (f.imagePages || 0) + ' 页转成图片随消息发送，需要支持图片识别的模型才能读取。', okText: '知道了', info: true }); return; }
    const t = f.text || '';
    dialog({ title: f.name, body: (t.length > 1500 ? t.slice(0, 1500) + '\n……' : t) + '\n\n（共 ' + (f.total || t.length) + ' 字' + (f.truncated ? '，发送给模型时截取前 ' + t.length + ' 字' : '') + '）', okText: '关闭', info: true });
  }
  function buildSources(m) {
    const wrap = document.createElement('div'); wrap.className = 'sources';
    const head = document.createElement('div'); head.className = 'src-head';
    head.innerHTML = ICON.globe + '<span>已参考 ' + m.sources.length + ' 个网页' + (m.searchQuery ? ' · ' + esc(m.searchQuery) : '') + '</span>';
    wrap.appendChild(head);
    const row = document.createElement('div'); row.className = 'src-row';
    m.sources.forEach((r, i) => {
      const c = document.createElement('button'); c.className = 'src-card';
      c.innerHTML = '<span class="sc-title"><span class="sc-n">' + (i + 1) + '</span>' + esc(r.title) + '</span><span class="sc-site"><span class="sc-fav">' +
        esc((r.site || Search.hostOf(r.url) || '?').charAt(0).toUpperCase()) + '</span>' + esc(r.site || Search.hostOf(r.url)) + (r.date ? ' · ' + esc(r.date) : '') + '</span>';
      c.onclick = () => openUrl(r.url);
      row.appendChild(c);
    });
    wrap.appendChild(row);
    return wrap;
  }
  function mkAct(icon, label, fn) { const b = document.createElement('button'); b.className = 'act'; b.innerHTML = icon; b.setAttribute('aria-label', label); b.title = label; b.onclick = fn; return b; }
  function nearBottom() { const b = $('#messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 140; }
  function updateMsg(m) {
    const el = document.querySelector('.msg[data-id="' + m.id + '"]');
    const stick = nearBottom();
    if (el) fillMsgEl(el, m); else { renderMessages(); return; }
    if (stick) $('#messages').scrollTop = $('#messages').scrollHeight;
  }
  let rafPending = new Set(), rafTimer = null;
  function scheduleUpdate(m) {
    rafPending.add(m);
    if (rafTimer) return;
    rafTimer = setTimeout(() => { rafTimer = null; const s = rafPending; rafPending = new Set(); s.forEach(updateMsg); }, 70);
  }
  $('#messages').addEventListener('scroll', () => $('.main-top').classList.toggle('scrolled', $('#messages').scrollTop > 4), { passive: true });

  function deleteMsg(m) { conv.messages = conv.messages.filter(x => x !== m); saveConv(); renderMessages(); }
  async function editUserMsg(m) {
    const t = await dialog({ title: '编辑并重新发送', input: true, value: m.content });
    if (t == null) return;
    const idx = conv.messages.indexOf(m);
    conv.messages = conv.messages.slice(0, idx);
    input.value = t; attachments = (m.images || []).slice();
    docs = (m.files || []).map(f => Object.assign({}, f, { id: uid(), status: 'ok' }));
    renderAttachments();
    saveConv(); renderMessages(); send();
  }

  // ---------------- 发送 / 生成 ----------------
  function setRunning(r) {
    running = r;
    const btn = $('#btn-send');
    btn.classList.toggle('stop', !!r);
    btn.setAttribute('aria-label', r ? '停止' : '发送');
    updateSendState();
  }
  function updateSendState() { $('#btn-send').disabled = !running && !input.value.trim() && !attachments.length && !docs.length; }
  function ensureProvider() {
    const p = getProvider(conv.providerId);
    if (!p || !p.apiKey) {
      if (!configured().length) { toast('请先在设置中填写 API Key'); openSettings(); }
      else { toast('请先选择服务商和模型'); openModelMenu(); }
      return null;
    }
    if (!conv.model) { toast('请填写模型名称'); openSheet(); return null; }
    return p;
  }
  function send() {
    if (running) return;
    const text = input.value.trim();
    if (!text && !attachments.length && !docs.length) return;
    if (docs.some(d => d.status === 'loading')) { toast('文件仍在读取，请稍候'); return; }
    const p = ensureProvider(); if (!p) return;
    if (imageMode) return generateImage(p, text);
    if (settings.searchOn && !searchReady()) { askSearchSetup(); return; }
    const okDocs = docs.filter(d => d.status === 'ok' && (d.text || d.scanned));
    if (docs.length > okDocs.length) toast('已忽略无法读取的文件');
    if (!text && !attachments.length && !okDocs.length) return;
    const user = { id: uid(), role: 'user', content: text, images: attachments.slice(), createdAt: Date.now() };
    if (!user.images.length) delete user.images;
    if (okDocs.length) user.files = okDocs.map(d => ({ name: d.name, size: d.size, kind: d.kind, text: d.text || '', total: d.total, truncated: !!d.truncated,
      pages: d.pages || undefined, scanned: !!d.scanned || undefined, imagePages: d.imagePages || undefined }));
    conv.messages.push(user);
    if (conv.title === '新对话') {
      const t = text || (okDocs[0] ? '📄 ' + okDocs[0].name : '');
      if (t) conv.title = (conv.personaEmoji && text ? conv.personaEmoji + ' ' : '') + t.replace(/\s+/g, ' ').slice(0, 24);
    }
    input.value = ''; autosize(); attachments = []; docs = []; renderAttachments();
    runChat(p);
  }
  function regenerate() {
    if (running) return;
    const last = conv.messages[conv.messages.length - 1];
    if (last && last.role === 'assistant') {
      if (last.imageGen) {
        conv.messages.pop(); const u = conv.messages.pop(); const p = ensureProvider();
        if (p && u) return generateImage(p, u.content);
        renderMessages(); return;
      }
      conv.messages.pop();
    }
    const p = ensureProvider(); if (!p) { renderMessages(); return; }
    runChat(p);
  }
  function numOrUndef(v) { const n = parseFloat(v); return isNaN(n) ? undefined : n; }

  /** 一次性请求（可取消、可超时），返回 {status, text} */
  function requestText(req, setCancel, timeoutMs) {
    return new Promise((resolve, reject) => {
      let status = 0, text = '', done = false, tm = null;
      const h = httpRequest(req, { onStatus: v => { status = v; }, onChunk: t => { text += t; } });
      const fin = (fn, v) => { if (done) return; done = true; clearTimeout(tm); fn(v); };
      if (timeoutMs) tm = setTimeout(() => { h.cancel(); fin(reject, new Error('请求超时')); }, timeoutMs);
      if (setCancel) setCancel(() => { h.cancel(); fin(reject, new Error('已取消')); });
      h.promise.then(() => fin(resolve, { status, text }), e => fin(reject, e));
    });
  }

  // ---------------- 联网搜索 ----------------
  const searchInfo = id => Search.SEARCH_PROVIDERS.find(x => x.id === id) || Search.SEARCH_PROVIDERS[0];
  function searchCfg() {
    const ss = settings.search;
    return { provider: ss.provider, apiKey: (ss.keys || {})[ss.provider] || '', baseUrl: (ss.urls || {})[ss.provider] || '', count: ss.count || 5 };
  }
  function searchReady() {
    const c = searchCfg(); const info = searchInfo(c.provider);
    return info.needsKey ? !!c.apiKey.trim() : /^https?:\/\/.+/.test(c.baseUrl.trim());
  }
  async function askSearchSetup() {
    const ok = await dialog({ title: '还没有配置联网搜索', body: '联网搜索需要一个搜索服务。推荐 Tavily（注册即送免费额度）或国内的博查 Bocha，在设置中填入 API Key 即可。', okText: '去设置' });
    if (ok) { openSettings(); setTimeout(() => { const el = $('#search-settings'); el && el.scrollIntoView({ block: 'start' }); }, 360); }
  }
  function searchErrorText(status, text) {
    let msg = '';
    try {
      const o = JSON.parse(text);
      const d = o.detail || o.error || o;
      msg = typeof d === 'string' ? d : (d.error || d.message || d.msg || (d.detail && (d.detail.message || d.detail.error)) || o.message || o.msg || '');
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
    } catch (e) { msg = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); }
    const hint = status === 401 || status === 403 ? 'API Key 无效或没有权限' : status === 429 ? '请求太频繁或额度已用完' :
      status === 432 || status === 433 || status === 402 ? '额度不足或超出套餐限制' : status === 0 ? '没有收到响应' : '';
    return 'HTTP ' + status + (hint ? '（' + hint + '）' : '') + (msg ? '：' + msg.slice(0, 200) : '');
  }
  async function webSearch(query, setCancel) {
    const cfg = searchCfg();
    const req = Search.buildSearchRequest(cfg, query);
    const r = await requestText(req, setCancel, 25000);
    if (r.status >= 400 || !r.status) throw new Error(searchErrorText(r.status, r.text));
    let list;
    try { list = Search.parseSearchResponse(cfg.provider, r.text, cfg.count); }
    catch (e) { throw new Error(e instanceof SyntaxError ? '返回的不是 JSON（SearXNG 需在实例中开启 json 格式）' : e.message); }
    return list;
  }
  async function rewriteQuery(p, q, history, setCancel) {
    try {
      const req = Providers.buildChatRequest(p, conv.model, [{ role: 'user', content: Search.buildRewritePrompt(q, history) }], '', { stream: false, temperature: 0, maxTokens: 256 });
      const r = await requestText(req, setCancel, 20000);
      if (r.status >= 400 || !r.status) return q;
      const text = Providers.parseFullResponse(p.type, r.text).filter(d => d.kind === 'text').map(d => d.text).join('');
      return Search.cleanRewrite(text, q);
    } catch (e) { if (e.message === '已取消') throw e; return q; }
  }

  /** 把存储的消息转换为请求消息：展开文件内容，最新一条用户消息注入搜索结果 */
  function toRequestMsg(m, injectSearch) {
    let content = m.content || '';
    if (m.role === 'user' && m.files && m.files.length) {
      const withText = m.files.filter(f => f.text);
      if (withText.length) content = Files.buildFileContext(withText, content);
      const scanned = m.files.filter(f => f.scanned);
      if (scanned.length) content = '（附带的 ' + scanned.map(f => '「' + f.name + '」').join('、') + ' 为扫描版 PDF，已转成图片附上，请识别图片中的文字。）\n' + (content || '请识别并概括这些图片中的内容。');
    }
    if (injectSearch && m.search && m.search.results && m.search.results.length) {
      const d = new Date(); const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      content = Search.buildSearchContext(m.search.results, content, { today });
    }
    return { role: m.role, content, images: m.images };
  }

  async function runChat(p) {
    const thisConv = conv;
    const lastUser = conv.messages.slice().reverse().find(m => m.role === 'user' && !m.imageGen);
    const wantSearch = !!(settings.searchOn && searchReady() && lastUser && (lastUser.content || '').trim());
    const bot = { id: uid(), role: 'assistant', content: '', reasoning: '', pending: true, model: conv.model, createdAt: Date.now() };
    if (conv.personaName) { bot.personaName = conv.personaName; bot.personaEmoji = conv.personaEmoji; }
    if (wantSearch) bot.searching = true;
    if (lastUser) delete lastUser.search;
    conv.messages.push(bot);
    renderMessages();
    settings.lastProviderId = p.id; settings.lastModel = conv.model; saveSettings();
    saveConv(); renderConvList();
    let cur = null;
    setRunning({ cancel: () => cur && cur(), msg: bot });
    const refresh = () => { if (conv === thisConv) scheduleUpdate(bot); };
    const finish = () => {
      bot.pending = false; delete bot.searching; delete bot.pluginStatus;
      setRunning(null);
      saveConv(thisConv);
      if (conv === thisConv) { renderMessages(); renderConvBar(); }
      renderConvList();
    };

    if (wantSearch) {
      try {
        let q = lastUser.content.trim();
        if (settings.search.rewrite) {
          const hist = thisConv.messages.filter(m => m !== bot && m !== lastUser && !m.error && !m.imageGen);
          q = await rewriteQuery(p, q, hist, c => { cur = c; });
        }
        bot.searchQuery = q.slice(0, 120); refresh();
        const results = await webSearch(q, c => { cur = c; });
        if (!results.length) throw new Error('没有搜索到相关结果');
        lastUser.search = { query: bot.searchQuery, results };
        bot.sources = results;
      } catch (e) {
        if (!bot.stopped) bot.searchError = '联网搜索失败：' + e.message + '。以下为模型直接回答。';
      }
      bot.searching = false;
      if (bot.stopped) { finish(); return; }
      refresh();
    }

    const stream = settings.stream !== false;
    const temp = thisConv.temperature != null && thisConv.temperature !== '' ? numOrUndef(thisConv.temperature) : numOrUndef(settings.temperature);
    // 插件管线：搜索结果、文件内容只在用户消息里，系统提示词保持稳定
    let rctx = {
      conv: thisConv, provider: p, model: thisConv.model, systemPrompt: thisConv.systemPrompt, settings, lastUser, meta: {},
      messages: thisConv.messages.filter(m => m !== bot && !m.error && !m.imageGen && !m.pending).map(m => Object.assign(toRequestMsg(m, m === lastUser), { _src: m })),
      opts: { stream, temperature: temp, maxTokens: numOrUndef(settings.maxTokens) },
      setStatus: t => { if (t) bot.pluginStatus = t; else delete bot.pluginStatus; refresh(); },
      setCancel: c => { cur = c; },
    };
    rctx = await Plugins.registry.runBeforeRequest(rctx, pluginHost);
    delete bot.pluginStatus;
    if (bot.stopped) { finish(); return; }
    if (rctx.plugins.length) bot.plugins = rctx.plugins;
    const req = Providers.buildChatRequest(p, rctx.model, rctx.messages, rctx.systemPrompt, rctx.opts);
    lastRequest = { convId: thisConv.id, body: req.body, url: req.url };
    const parser = Providers.createStreamParser(p.type);
    let status = 0, raw = '', gotDelta = false;
    const apply = deltas => deltas.forEach(d => {
      if (d.kind === 'usage') { bot.usage = Providers.mergeUsage(bot.usage, d.usage); return; }
      gotDelta = true;
      if (d.kind === 'text') bot.content += d.text;
      else if (d.kind === 'reasoning') bot.reasoning += d.text;
      else if (d.kind === 'error') bot.error = (bot.error ? bot.error + '\n' : '') + d.text;
    });
    const h = httpRequest(req, {
      onStatus: v => { status = v; },
      onChunk: t => {
        raw += t;
        if (status >= 200 && status < 300 && stream) { apply(parser.push(t)); refresh(); }
      },
    });
    cur = h.cancel;
    try {
      await h.promise;
      if (status >= 400 || (status === 0 && !bot.stopped)) {
        bot.error = status ? Providers.parseError(status, raw) : '请求失败：没有收到响应';
      } else if (stream) {
        apply(parser.end());
        if (!gotDelta && raw.trim() && !bot.stopped) apply(Providers.parseFullResponse(p.type, raw));
      } else if (!bot.stopped) {
        apply(Providers.parseFullResponse(p.type, raw));
      }
    } catch (e) {
      bot.error = '网络错误：' + e.message + '\n请检查网络连接和 Base URL。';
    }
    Plugins.registry.runAfterResponse(rctx, { ok: !bot.error && !bot.stopped && status >= 200 && status < 300, usage: bot.usage || null, bot, status }, pluginHost);
    finish();
  }

  function generateImage(p, prompt) {
    if (p.type !== 'openai') { toast('图片生成仅支持 OpenAI 兼容接口'); return; }
    if (!p.imageModel) { toast('请先在设置中为「' + p.name + '」填写图片生成模型'); return; }
    if (!prompt) { toast('请输入图片描述'); return; }
    const user = { id: uid(), role: 'user', content: prompt, imageGen: true, createdAt: Date.now() };
    const bot = { id: uid(), role: 'assistant', content: '', pending: true, imageGen: true, model: p.imageModel + ' · 生成图片', createdAt: Date.now() };
    conv.messages.push(user, bot);
    if (conv.title === '新对话') conv.title = '🎨 ' + prompt.slice(0, 20);
    input.value = ''; autosize(); renderMessages();
    const req = Providers.buildImageRequest(p, p.imageModel, prompt, { size: settings.imageSize || '1024x1024' });
    let status = 0, raw = '';
    const thisConv = conv;
    const h = httpRequest(req, { onStatus: s => { status = s; }, onChunk: t => { raw += t; } });
    setRunning({ cancel: h.cancel, msg: bot });
    h.promise.then(() => {
      if (bot.stopped) return;
      if (status >= 400 || !status) { bot.error = Providers.parseError(status, raw); return; }
      try {
        const imgs = Providers.parseImageResponse(raw);
        if (!imgs.length) bot.error = '未返回图片：' + raw.slice(0, 300); else bot.images = imgs;
      } catch (e) { bot.error = '无法解析响应：' + raw.slice(0, 300); }
    }).catch(e => { bot.error = '网络错误：' + e.message; })
      .finally(() => { bot.pending = false; setRunning(null); saveConv(thisConv); if (conv === thisConv) renderMessages(); renderConvList(); });
  }

  function stopGen() { if (!running) return; running.msg.stopped = true; running.cancel(); }

  // ---------------- 输入区 ----------------
  const input = $('#input');
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 168) + 'px'; updateSendState(); }
  input.addEventListener('input', autosize);
  input.addEventListener('focus', () => $('#composer-card').classList.add('focus'));
  input.addEventListener('blur', () => $('#composer-card').classList.remove('focus'));
  $('#btn-send').onclick = () => running ? stopGen() : send();
  $('#btn-attach').onclick = () => {
    if (imageMode) { toast('图片生成模式下不能添加附件'); return; }
    $('#file-input').click();
  };
  $('#file-input').onchange = async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      const kind = Files.classifyFile(f.name, f.type);
      if (kind === 'image') {
        try { attachments.push(await compressImage(f)); } catch (err) { toast('图片读取失败'); }
        renderAttachments();
      } else addDoc(f, kind);
    }
  };
  const MAX_FILE_BYTES = 40 * 1024 * 1024;
  function addDoc(file, kind) {
    const d = { id: uid(), name: file.name || '未命名文件', size: file.size, kind, status: 'loading' };
    docs.push(d); renderAttachments();
    readDoc(file, d).then(r => Object.assign(d, r, { status: 'ok' }))
      .catch(err => { d.status = 'error'; d.error = String(err && err.message || err); })
      .finally(() => {
        renderAttachments();
        if (d.status === 'error') toast(d.name + '：' + d.error);
        else if (d.scanned) dialog({ title: '这是扫描版 PDF', body: '「' + d.name + '」里没有可以提取的文字（可能是扫描件或纯图片）。\n\n' +
          (d.imagePages ? '已把前 ' + d.imagePages + ' 页转成图片附上，请使用支持图片识别的模型（如 GPT-4o、Claude、Gemini、Qwen-VL、GLM-4V）。' : '请先用 OCR 工具转换为文字版再上传。'), okText: '知道了', info: true });
        else if (d.truncated) toast('「' + d.name + '」内容较长，只会发送前 ' + d.text.length + ' 字');
      });
  }
  function readBytes(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader(); r.onerror = () => reject(new Error('文件读取失败')); r.onload = () => resolve(new Uint8Array(r.result)); r.readAsArrayBuffer(file);
    });
  }
  async function readDoc(file, d) {
    if (d.kind === 'unsupported') throw new Error('暂不支持旧版 Office 格式，请另存为 .docx/.pptx/.xlsx 或 PDF');
    if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 40 MB，无法读取');
    const bytes = await readBytes(file);
    let text = '', extra = {};
    if (d.kind === 'pdf') {
      const lib = await loadPdfjs();
      let r;
      try { r = await Files.extractPdf(lib, bytes, { CMapReaderFactory: AssetCMapReaderFactory }); }
      catch (e) { throw new Error(e.message); }
      extra.pages = r.pages;
      if (r.scanned) {
        const imgs = await renderPdfPages(r.doc, Math.min(r.pages, 4)).catch(() => []);
        imgs.forEach(src => attachments.push(src));
        try { r.doc.destroy(); } catch (e) { /* ignore */ }
        return Object.assign(extra, { scanned: true, imagePages: imgs.length, images: imgs, text: '', total: 0 });
      }
      try { r.doc.destroy(); } catch (e) { /* ignore */ }
      text = r.text;
    } else if (d.kind === 'docx') text = Files.extractDocx(fflate, bytes);
    else if (d.kind === 'pptx') text = Files.extractPptx(fflate, bytes);
    else if (d.kind === 'xlsx') text = Files.extractXlsx(fflate, bytes);
    else {
      const dec = Files.decodeText(bytes);
      if (Files.looksBinary(dec.text)) throw new Error('无法识别的文件类型（不是文本文件）');
      text = dec.text;
    }
    text = String(text || '').replace(/\r\n?/g, '\n').trim();
    if (!text) throw new Error('文件中没有可读取的文字');
    const c = Files.capText(text, Files.DEFAULT_FILE_MAX);
    return Object.assign(extra, { text: c.text, truncated: c.truncated, total: c.total });
  }

  // pdf.js 按需加载（主线程运行，无需 Worker）
  let pdfjsPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => { const sc = document.createElement('script'); sc.src = src; sc.onload = resolve; sc.onerror = () => reject(new Error('加载 ' + src + ' 失败')); document.head.appendChild(sc); });
  }
  function loadPdfjs() {
    if (!pdfjsPromise) pdfjsPromise = loadScript('lib/pdf.worker.min.js').then(() => loadScript('lib/pdf.min.js')).then(() => window.pdfjsLib)
      .catch(e => { pdfjsPromise = null; throw e; });
    return pdfjsPromise;
  }
  function b64ToBytes(b64) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  /** 中文 PDF 常用的 CMap：从 APK 内置资源读取 */
  class AssetCMapReaderFactory {
    constructor() { /* 参数不需要 */ }
    async fetch({ name }) {
      const path = 'www/lib/cmaps/' + name + '.bcmap';
      let data = null;
      if (bridge && bridge.readAsset) { const b64 = bridge.readAsset(path); if (b64) data = b64ToBytes(b64); }
      if (!data) {
        data = await new Promise((resolve, reject) => {
          const x = new XMLHttpRequest(); x.open('GET', 'lib/cmaps/' + name + '.bcmap'); x.responseType = 'arraybuffer';
          x.onload = () => (x.response && x.response.byteLength ? resolve(new Uint8Array(x.response)) : reject(new Error('CMap 不存在：' + name)));
          x.onerror = () => reject(new Error('CMap 加载失败：' + name)); x.send();
        });
      }
      return { cMapData: data, compressionType: 1 };
    }
  }
  async function renderPdfPages(doc, n) {
    const out = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const v0 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1400 / Math.max(v0.width, v0.height));
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: g, viewport: vp }).promise;
      out.push(c.toDataURL('image/jpeg', 0.82));
    }
    return out;
  }

  $('#btn-imagegen').onclick = () => {
    imageMode = !imageMode;
    $('#btn-imagegen').classList.toggle('active', imageMode);
    $('#composer-card').classList.toggle('imgmode', imageMode);
    input.placeholder = imageMode ? '描述你想生成的图片…' : (settings.searchOn ? '联网搜索已开启，问点新鲜事…' : '给 AI 发消息…');
    toast(imageMode ? '已切换到图片生成模式' : '已切换回聊天模式');
    if (imageMode && (attachments.length || docs.length)) { attachments = []; docs = []; renderAttachments(); }
  };
  function renderSearchChip() {
    $('#btn-search').classList.toggle('active', !!settings.searchOn);
    if (!imageMode) input.placeholder = settings.searchOn ? '联网搜索已开启，问点新鲜事…' : '给 AI 发消息…';
  }
  $('#btn-search').onclick = () => {
    if (!settings.searchOn && !searchReady()) { askSearchSetup(); return; }
    settings.searchOn = !settings.searchOn; saveSettings(); renderSearchChip();
    toast(settings.searchOn ? '联网搜索已开启（' + searchInfo(settings.search.provider).name + '）' : '联网搜索已关闭');
  };
  function renderAttachments() {
    const box = $('#attach-preview'); box.innerHTML = '';
    docs.forEach(d => {
      const w = document.createElement('div'); w.className = 'thumb doc';
      w.innerHTML = fileChipHtml(d) + '<button class="rm" aria-label="移除">×</button>';
      w.querySelector('.file-chip').onclick = () => d.status !== 'loading' && previewFile(d);
      w.querySelector('.rm').onclick = () => {
        docs = docs.filter(x => x !== d);
        if (d.images) attachments = attachments.filter(src => !d.images.includes(src));
        renderAttachments();
      };
      box.appendChild(w);
    });
    attachments.forEach((src, i) => {
      const t = document.createElement('div'); t.className = 'thumb';
      t.innerHTML = '<img src="' + src + '"><button class="rm" aria-label="移除">×</button>';
      t.querySelector('.rm').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
      box.appendChild(t);
    });
    updateSendState();
  }
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const max = 1568; let w = img.width, h = img.height;
          if (w > max || h > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(img, 0, 0, w, h);
          resolve(c.toDataURL('image/jpeg', 0.85));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // ---------------- 侧边栏 ----------------
  function openDrawer() { renderConvList(); $('#drawer').classList.add('show'); $('#drawer-mask').classList.add('show'); }
  function closeDrawer() { $('#drawer').classList.remove('show'); $('#drawer-mask').classList.remove('show'); }
  $('#btn-menu').onclick = openDrawer;
  $('#drawer-mask').onclick = closeDrawer;
  $('#conv-search').addEventListener('input', renderConvList);
  const startNew = () => { if (running) { toast('请先停止当前生成'); return; } newConv(); closeDrawer(); };
  $('#btn-new').onclick = startNew;
  $('#drawer-new').onclick = startNew;
  $('#btn-settings').onclick = () => { closeDrawer(); setTimeout(openSettings, 120); };
  $('#btn-personas').onclick = () => { closeDrawer(); setTimeout(() => openPersonas(), 120); };

  // ---------------- 模型快速切换 ----------------
  function selectModel(pid, model) {
    conv.providerId = pid; conv.model = model;
    settings.lastProviderId = pid; settings.lastModel = model; saveSettings();
    if (conv.messages.length) saveConv(conv, false);
    renderHeader();
  }
  function openModelMenu() {
    const menu = $('#model-menu');
    const list = configured();
    menu.innerHTML = '';
    if (!list.length) {
      menu.innerHTML = '<div class="pm-group"><div class="pm-head">还没有配置服务商</div></div>';
    }
    // 当前服务商放在最前
    list.sort((a, b) => (a.id === conv.providerId ? -1 : b.id === conv.providerId ? 1 : 0));
    list.forEach(p => {
      const g = document.createElement('div'); g.className = 'pm-group';
      g.innerHTML = '<div class="pm-head">' + avatarHtml(p) + esc(p.name) + '</div>';
      const models = p.models.filter(Boolean).slice();
      if (p.id === conv.providerId && conv.model && !models.includes(conv.model)) models.unshift(conv.model);
      models.forEach(m => {
        const active = p.id === conv.providerId && m === conv.model;
        const b = document.createElement('button'); b.className = 'pm-item' + (active ? ' active' : '');
        b.innerHTML = '<span class="pm-name">' + esc(m) + '</span>' + (active ? ICON.check.replace('<svg', '<svg class="check"') : '');
        b.onclick = () => { selectModel(p.id, m); closeModelMenu(); toast('已切换到 ' + m); };
        g.appendChild(b);
      });
      menu.appendChild(g);
    });
    const tools = document.createElement('div'); tools.className = 'pm-group';
    const t1 = document.createElement('button'); t1.className = 'pm-item tool'; t1.innerHTML = ICON.tune + '<span class="pm-name">自定义模型名 / 本对话系统提示词</span>';
    t1.onclick = () => { closeModelMenu(); openSheet(); };
    const t2 = document.createElement('button'); t2.className = 'pm-item tool'; t2.innerHTML = ICON.key + '<span class="pm-name">管理服务商与 API Key</span>';
    t2.onclick = () => { closeModelMenu(); openSettings(); };
    const t3 = document.createElement('button'); t3.className = 'pm-item tool';
    t3.innerHTML = '<span class="pm-emoji">🎭</span><span class="pm-name">本对话插件 · RP 缓存优化' + (Plugins.registry.isActive('rpcache', settings, conv) ? '（已开启）' : '') + '</span>';
    t3.onclick = () => { closeModelMenu(); openPluginPanel('rpcache'); };
    const t4 = document.createElement('button'); t4.className = 'pm-item tool';
    t4.innerHTML = '<span class="pm-emoji">📋</span><span class="pm-name">提示词模板' + (conv.templateName ? ' · ' + esc(conv.templateName) : ' · 切换系统提示词') + '</span>';
    t4.onclick = () => { closeModelMenu(); openTemplateSheet(); };
    tools.appendChild(t4);
    if (list.length) { tools.appendChild(t1); tools.appendChild(t3); }
    tools.appendChild(t2);
    menu.appendChild(tools);
    menu.classList.add('show'); $('#menu-mask').classList.add('show'); $('#model-pill').classList.add('open');
  }
  function closeModelMenu() { $('#model-menu').classList.remove('show'); $('#menu-mask').classList.remove('show'); $('#model-pill').classList.remove('open'); }
  $('#model-pill').onclick = () => $('#model-menu').classList.contains('show') ? closeModelMenu() : openModelMenu();
  $('#menu-mask').onclick = closeModelMenu;

  // ---------------- 模型 / 系统提示词面板 ----------------
  let sheetPid = '';
  function openSheet() {
    const list = configured();
    if (!list.length) { toast('请先在设置中填写 API Key'); openSettings(); return; }
    sheetPid = getProvider(conv.providerId) && getProvider(conv.providerId).apiKey ? conv.providerId : list[0].id;
    $('#sheet-model').value = sheetPid === conv.providerId ? conv.model : (getProvider(sheetPid).models[0] || '');
    $('#sheet-system').value = conv.systemPrompt || '';
    renderSheet();
    $('#sheet').classList.add('show'); $('#sheet-mask').classList.add('show');
  }
  function renderSheet() {
    const pbox = $('#sheet-providers'); pbox.innerHTML = '';
    configured().forEach(p => {
      const c = document.createElement('button'); c.className = 'chip' + (p.id === sheetPid ? ' active' : ''); c.textContent = p.name;
      c.onclick = () => { sheetPid = p.id; $('#sheet-model').value = p.models[0] || ''; renderSheet(); };
      pbox.appendChild(c);
    });
    const mbox = $('#sheet-models'); mbox.innerHTML = '';
    const p = getProvider(sheetPid);
    (p ? p.models : []).filter(Boolean).forEach(m => {
      const c = document.createElement('button'); c.className = 'chip' + ($('#sheet-model').value === m ? ' active' : ''); c.textContent = m;
      c.onclick = () => { $('#sheet-model').value = m; renderSheet(); };
      mbox.appendChild(c);
    });
  }
  $('#sheet-model').addEventListener('input', renderSheet);
  function closeSheet() { $('#sheet').classList.remove('show'); $('#sheet-mask').classList.remove('show'); }
  $('#sheet-mask').onclick = closeSheet;
  $('#sheet-cancel').onclick = closeSheet;
  $('#sheet-ok').onclick = () => {
    const m = $('#sheet-model').value.trim();
    if (!m) { toast('请填写模型名称'); return; }
    const ns = $('#sheet-system').value;
    if (ns !== (conv.systemPrompt || '')) setConvSystem(ns, null, { kind: 'manual' });
    selectModel(sheetPid, m);
    closeSheet();
  };

  // ---------------- 设置 ----------------
  function openSettings() {
    $('#set-system').value = settings.systemPrompt || '';
    renderDefaultTplSelect();
    $('#set-stream').checked = settings.stream !== false;
    $('#set-temp').value = settings.temperature || '';
    $('#set-maxtokens').value = settings.maxTokens || '';
    $('#set-imgsize').value = settings.imageSize || '';
    $('#about-ver').textContent = 'v' + APP_VERSION + ' · 数据仅存储在本机';
    renderProviderList();
    renderSearchSettings();
    $('#page-settings').classList.add('show');
  }
  function readGeneral() {
    settings.systemPrompt = $('#set-system').value;
    settings.defaultTemplateId = $('#set-deftpl').value || null;
    settings.stream = $('#set-stream').checked;
    settings.temperature = $('#set-temp').value.trim();
    settings.maxTokens = $('#set-maxtokens').value.trim();
    settings.imageSize = $('#set-imgsize').value.trim() || '1024x1024';
    readSearchSettings();
    saveSettings();
  }
  function closeSettings() {
    readGeneral();
    $('#page-settings').classList.remove('show');
    const cur = getProvider(conv.providerId);
    if (!cur || !cur.apiKey) {
      const p = configured()[0]; if (p) { conv.providerId = p.id; conv.model = p.models[0] || ''; }
    }
    renderAll();
  }
  ['#set-system', '#set-temp', '#set-maxtokens', '#set-imgsize'].forEach(s => $(s).addEventListener('change', readGeneral));
  $('#set-stream').onchange = readGeneral;
  function renderProviderList() {
    const box = $('#provider-list'); box.innerHTML = '';
    const sorted = settings.providers.slice().sort((a, b) => (b.apiKey ? 1 : 0) - (a.apiKey ? 1 : 0));
    sorted.forEach(p => {
      const el = document.createElement('button'); el.className = 'prov-item';
      const ok = p.apiKey && p.apiKey.trim();
      el.innerHTML = avatarHtml(p, 'lg') + '<div class="pi-main"><div class="pi-name">' + esc(p.name) + '</div><div class="pi-sub">' +
        esc(ok ? (p.models.filter(Boolean).slice(0, 3).join(' · ') || p.baseUrl) : p.baseUrl) + '</div></div>' +
        '<span class="status' + (ok ? ' ok' : '') + '">' + (ok ? '已配置' : '未配置') + '</span>' + ICON.chevR;
      el.onclick = () => openProviderEdit(p.id);
      box.appendChild(el);
    });
  }
  $('#btn-add-provider').onclick = () => {
    openProviderEdit(null, { id: uid(), presetId: 'custom', name: '自定义服务', type: 'openai', baseUrl: 'https://', apiKey: '', models: [], imageModel: '' });
  };
  $('#btn-clear-all').onclick = async () => {
    const ok = await dialog({ title: '删除全部对话？', body: '将删除所有本地对话记录（服务商与 API Key 设置会保留）。', okText: '全部删除', danger: true });
    if (!ok) return;
    if (running) stopGen();
    convIndex.forEach(m => { Store.del('conv_' + m.id + '.json'); Store.del('rplog_' + m.id + '.json'); });
    convIndex = []; saveIndex(); newConv(); toast('已删除全部对话');
  };

  // ---------------- 联网搜索设置 ----------------
  const SEARCH_HINTS = {
    tavily: '在 <a data-url="https://app.tavily.com">app.tavily.com</a> 注册登录后，首页即可复制 API Key（tvly- 开头），免费版每月 1000 次额度。',
    bocha: '在 <a data-url="https://open.bochaai.com">open.bochaai.com</a> 微信扫码登录，于「API KEY 管理」中创建 Key；新用户可在总览页领取免费调用资源包，之后按次付费（预充值）。国内直连，中文结果更好。',
    brave: '在 <a data-url="https://api-dashboard.search.brave.com">api-dashboard.search.brave.com</a> 订阅 Search API 后获取 Token。',
    searxng: '填写自建 SearXNG 实例地址（如 https://searx.example.com），并在实例 settings.yml 的 search.formats 中加入 json。无需 Key。',
  };
  (function initSearchSelect() {
    $('#ss-provider').innerHTML = Search.SEARCH_PROVIDERS.map(x => '<option value="' + x.id + '">' + esc(x.name) + '</option>').join('');
  })();
  let ssShown = '';
  function renderSearchSettings() {
    const ss = settings.search; const info = searchInfo(ss.provider);
    ssShown = ss.provider;
    $('#ss-provider').value = ss.provider;
    $('#ss-key-field').style.display = info.needsKey ? '' : 'none';
    $('#ss-key').value = (ss.keys || {})[ss.provider] || ''; $('#ss-key').placeholder = info.keyHint || '';
    $('#ss-key').type = 'password'; $('#ss-key-toggle').textContent = '显示';
    $('#ss-url').value = (ss.urls || {})[ss.provider] || '';
    $('#ss-url').placeholder = ss.provider === 'searxng' ? 'https://searx.example.com' : Search.DEFAULT_BASE[ss.provider];
    $('#ss-url-label').textContent = ss.provider === 'searxng' ? '实例地址（必填）' : '接口地址（可选，留空使用官方地址）';
    $('#ss-hint').innerHTML = SEARCH_HINTS[ss.provider] || '';
    $('#ss-hint').querySelectorAll('a[data-url]').forEach(a => { a.onclick = () => openUrl(a.dataset.url); });
    $('#ss-count').value = ss.count || 5;
    $('#ss-rewrite').checked = !!ss.rewrite;
  }
  function readSearchSettings() {
    const ss = settings.search; const pid = ssShown || ss.provider;
    ss.keys = ss.keys || {}; ss.urls = ss.urls || {};
    ss.keys[pid] = $('#ss-key').value.trim();
    ss.urls[pid] = $('#ss-url').value.trim().replace(/\/+$/, '');
    const n = parseInt($('#ss-count').value, 10); ss.count = isNaN(n) ? 5 : Math.max(1, Math.min(10, n));
    ss.rewrite = $('#ss-rewrite').checked;
  }
  $('#ss-provider').onchange = () => { readSearchSettings(); settings.search.provider = $('#ss-provider').value; saveSettings(); renderSearchSettings(); };
  ['#ss-key', '#ss-url', '#ss-count'].forEach(sel => $(sel).addEventListener('change', () => { readSearchSettings(); saveSettings(); }));
  $('#ss-rewrite').onchange = () => { readSearchSettings(); saveSettings(); };
  $('#ss-key-toggle').onclick = () => {
    const k = $('#ss-key'); const show = k.type === 'password';
    k.type = show ? 'text' : 'password'; $('#ss-key-toggle').textContent = show ? '隐藏' : '显示';
  };
  $('#ss-test').onclick = async () => {
    readSearchSettings(); saveSettings();
    if (!searchReady()) { toast(settings.search.provider === 'searxng' ? '请先填写实例地址' : '请先填写 API Key'); return; }
    const q = $('#ss-test-q').value.trim() || '今天的科技新闻';
    const btn = $('#ss-test'); btn.disabled = true; btn.textContent = '搜索中…';
    try {
      const list = await webSearch(q);
      dialog({ title: list.length ? '搜索成功 · ' + list.length + ' 条结果' : '没有结果',
        body: list.slice(0, 5).map((r, i) => (i + 1) + '. ' + r.title + '\n   ' + r.site).join('\n') || '接口可用，但没有返回结果。', okText: '好的', info: true });
    } catch (e) {
      dialog({ title: '搜索失败', body: String(e.message || e), okText: '知道了', info: true });
    } finally { btn.disabled = false; btn.textContent = '测试搜索'; }
  };

  // ---------------- 助手库 ----------------
  let plTab = 'personas';
  function openPersonas(tab) {
    closeDrawer();
    plTab = tab || 'personas';
    renderPersonaPage();
    $('#page-personas').classList.add('show');
  }
  function closePersonas() { $('#page-personas').classList.remove('show'); }
  function renderPersonaPage() {
    document.querySelectorAll('#pl-seg button').forEach(b => b.classList.toggle('active', b.dataset.tab === plTab));
    $('#pl-personas').style.display = plTab === 'personas' ? '' : 'none';
    $('#pl-prompts').style.display = plTab === 'prompts' ? '' : 'none';
    $('#pl-add').setAttribute('aria-label', plTab === 'personas' ? '新建助手' : '新建提示词');
    if (plTab === 'personas') renderPersonaGrid(); else renderPromptManage();
  }
  document.querySelectorAll('#pl-seg button').forEach(b => b.onclick = () => { plTab = b.dataset.tab; renderPersonaPage(); });
  $('#pl-add').onclick = () => plTab === 'personas' ? openPersonaEdit(null) : openPromptEdit(null);
  function renderPersonaGrid() {
    const box = $('#persona-grid'); box.innerHTML = '';
    personas.forEach(ps => {
      const prov = ps.providerId && getProvider(ps.providerId);
      const el = document.createElement('div'); el.className = 'persona-card';
      el.innerHTML = '<div class="pcard-top"><span class="pcard-emoji">' + esc(ps.emoji) + '</span><button class="ci-more" aria-label="更多">' + ICON.more + '</button></div>' +
        '<div class="pcard-name">' + esc(ps.name) + '</div><div class="pcard-desc">' + esc(ps.desc || ps.systemPrompt.slice(0, 40)) + '</div>' +
        '<div class="pcard-tags">' + (prov ? '<span>' + esc(ps.model || prov.name) + '</span>' : '') + (ps.temperature !== '' ? '<span>温度 ' + esc(ps.temperature) + '</span>' : '') +
        (ps.builtin ? '<span class="soft">内置</span>' : '') + '</div>';
      el.onclick = () => startFromPersona(ps);
      el.querySelector('.ci-more').onclick = e => {
        e.stopPropagation();
        actionSheet(ps.emoji + ' ' + ps.name, [
          { label: '开始对话', icon: ICON.chat, onClick: () => startFromPersona(ps) },
          { label: '编辑', icon: ICON.edit, onClick: () => openPersonaEdit(ps.id) },
          { label: '复制一份', icon: ICON.dup, onClick: () => { personas = Personas.duplicate(personas, ps.id); savePersonas(); renderPersonaGrid(); toast('已复制'); } },
          { label: '删除', icon: ICON.trash, danger: true, onClick: () => deletePersona(ps) },
        ]);
      };
      box.appendChild(el);
    });
    const add = document.createElement('button'); add.className = 'persona-card add';
    add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg><span>新建助手</span>';
    add.onclick = () => openPersonaEdit(null);
    box.appendChild(add);
    $('#persona-count').textContent = personas.length + ' 个助手 · ' + prompts.length + ' 条提示词';
  }
  async function deletePersona(ps) {
    const ok = await dialog({ title: '删除助手？', body: '「' + ps.name + '」将被删除，已有的对话不受影响。', okText: '删除', danger: true });
    if (!ok) return;
    personas = Personas.remove(personas, ps.id);
    if (ps.builtin) settings.removedPersonas = (settings.removedPersonas || []).concat(ps.id);
    savePersonas(); saveSettings(); renderPersonaGrid(); toast('已删除');
  }
  function startFromPersona(ps) {
    if (running) { toast('请先停止当前生成'); return; }
    newConv();
    const f = Personas.conversationFromPersona(ps, configured(), { providerId: conv.providerId, model: conv.model });
    Object.assign(conv, f, { title: '新对话' });
    if (conv.temperature === undefined) delete conv.temperature;
    closePersonas(); closeDrawer();
    renderAll();
    toast('已切换到「' + ps.name + '」');
  }

  // 助手编辑
  const EMOJIS = ['🤖', '🧠', '✨', '📚', '🧑‍💻', '🎨', '📈', '⚖️', '🩺', '🍳', '✈️', '🎵', '🧾', '💡', '🐱', '🦊'];
  let editingPersona = null;
  function openPersonaEdit(id) {
    const ps = id ? personas.find(x => x.id === id) : null;
    editingPersona = ps ? Object.assign({}, ps) : Personas.normalizePersona({ name: '', emoji: '🤖' });
    editingPersona.isNew = !ps;
    $('#ps-title').textContent = ps ? '编辑助手' : '新建助手';
    $('#ps-emoji').value = editingPersona.emoji; $('#ps-emoji-view').textContent = editingPersona.emoji;
    $('#ps-name').value = ps ? ps.name : ''; $('#ps-desc').value = editingPersona.desc; $('#ps-prompt').value = editingPersona.systemPrompt;
    const sel = $('#ps-provider');
    sel.innerHTML = '<option value="">跟随当前对话</option>' + settings.providers.filter(p => p.apiKey || p.id === editingPersona.providerId)
      .map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + (p.apiKey ? '' : '（未配置）') + '</option>').join('');
    sel.value = editingPersona.providerId || '';
    $('#ps-model').value = editingPersona.model || '';
    $('#ps-temp').value = editingPersona.temperature === '' ? '' : editingPersona.temperature;
    $('#ps-delete').style.display = ps ? '' : 'none';
    const row = $('#ps-emoji-row'); row.innerHTML = '';
    EMOJIS.forEach(em => { const b = document.createElement('button'); b.textContent = em; b.onclick = () => { $('#ps-emoji').value = em; $('#ps-emoji-view').textContent = em; }; row.appendChild(b); });
    renderPsModels();
    $('#page-persona').classList.add('show');
  }
  function renderPsModels() {
    const p = getProvider($('#ps-provider').value);
    const box = $('#ps-models'); box.innerHTML = '';
    $('#ps-model').disabled = !p;
    if (!p) { $('#ps-model').value = ''; return; }
    p.models.filter(Boolean).forEach(m => {
      const c = document.createElement('button'); c.className = 'chip' + ($('#ps-model').value === m ? ' active' : ''); c.textContent = m;
      c.onclick = () => { $('#ps-model').value = m; renderPsModels(); };
      box.appendChild(c);
    });
  }
  $('#ps-provider').onchange = () => { $('#ps-model').value = ''; renderPsModels(); };
  $('#ps-model').addEventListener('input', renderPsModels);
  $('#ps-emoji').addEventListener('input', () => { $('#ps-emoji-view').textContent = $('#ps-emoji').value.trim() || '🤖'; });
  function closePersonaEdit() { $('#page-persona').classList.remove('show'); editingPersona = null; if ($('#page-personas').classList.contains('show')) renderPersonaGrid(); }
  $('#ps-save').onclick = () => {
    const name = $('#ps-name').value.trim();
    if (!name) { toast('请填写助手名称'); return; }
    if (!$('#ps-prompt').value.trim()) { toast('请填写系统提示词'); return; }
    const t = $('#ps-temp').value.trim();
    const item = { id: editingPersona.id, builtin: editingPersona.builtin, emoji: $('#ps-emoji').value.trim() || '🤖', name, desc: $('#ps-desc').value.trim(),
      systemPrompt: $('#ps-prompt').value, providerId: $('#ps-provider').value, model: $('#ps-model').value.trim(), temperature: t === '' ? '' : t };
    personas = Personas.upsert(personas, item);
    savePersonas(); toast('已保存'); closePersonaEdit();
  };
  $('#ps-delete').onclick = async () => { const ps = personas.find(x => x.id === editingPersona.id); if (!ps) return; closePersonaEdit(); deletePersona(ps); };

  // ---------------- 提示词库 ----------------
  function openPromptSheet() {
    $('#pr-search').value = '';
    renderPromptList();
    $('#prompt-sheet').classList.add('show'); $('#prompt-mask').classList.add('show');
  }
  function closePromptSheet() { $('#prompt-sheet').classList.remove('show'); $('#prompt-mask').classList.remove('show'); }
  function renderPromptList() {
    const q = $('#pr-search').value.trim().toLowerCase();
    const box = $('#prompt-list'); box.innerHTML = '';
    const list = prompts.filter(x => !q || x.title.toLowerCase().includes(q) || x.content.toLowerCase().includes(q));
    if (!list.length) { box.innerHTML = '<div class="conv-empty">' + (q ? '没有匹配的提示词' : '还没有提示词') + '</div>'; return; }
    list.forEach(x => {
      const el = document.createElement('button'); el.className = 'prompt-item';
      el.innerHTML = '<span class="pi-t">' + esc(x.title) + '</span><span class="pi-c">' + esc(x.content.replace(/\s+/g, ' ').slice(0, 80)) + '</span>';
      el.onclick = () => insertPrompt(x);
      box.appendChild(el);
    });
  }
  function insertPrompt(x) {
    const r = Personas.insertSnippet(input.value, input.selectionStart, input.selectionEnd, x.content);
    input.value = r.value; closePromptSheet(); autosize();
    setTimeout(() => { input.focus(); input.setSelectionRange(r.cursor, r.cursor); }, 60);
  }
  $('#btn-prompts').onclick = openPromptSheet;
  $('#prompt-mask').onclick = closePromptSheet;
  $('#pr-search').addEventListener('input', renderPromptList);
  $('#pr-manage').onclick = () => { closePromptSheet(); openPersonas('prompts'); };
  $('#pr-new').onclick = () => openPromptEdit(null);
  $('#pr-save-input').onclick = () => {
    const v = input.value.trim();
    if (!v) { toast('输入框是空的'); return; }
    openPromptEdit(null, { title: v.replace(/\s+/g, ' ').slice(0, 16), content: input.value });
  };
  function renderPromptManage() {
    const box = $('#prompt-manage'); box.innerHTML = '';
    if (!prompts.length) box.innerHTML = '<div class="conv-empty">还没有提示词，点右上角 ＋ 新建</div>';
    prompts.forEach(x => {
      const el = document.createElement('div'); el.className = 'prov-item prompt-row';
      el.innerHTML = '<span class="row-ic">' + ICON.rename + '</span><div class="pi-main"><div class="pi-name">' + esc(x.title) + '</div><div class="pi-sub">' + esc(x.content.replace(/\s+/g, ' ').slice(0, 60)) + '</div></div>' + ICON.chevR;
      el.onclick = () => openPromptEdit(x.id);
      box.appendChild(el);
    });
    $('#persona-count').textContent = personas.length + ' 个助手 · ' + prompts.length + ' 条提示词';
  }
  let editingPrompt = null;
  function openPromptEdit(id, preset) {
    const x = id ? prompts.find(q => q.id === id) : null;
    editingPrompt = x ? x.id : null;
    $('#pe2-title').textContent = x ? '编辑提示词' : '新建提示词';
    $('#pe2-name').value = x ? x.title : (preset ? preset.title : '');
    $('#pe2-content').value = x ? x.content : (preset ? preset.content : '');
    $('#pe2-delete').style.display = x ? '' : 'none';
    $('#pe2-mask').classList.add('show');
    setTimeout(() => (x || preset ? $('#pe2-content') : $('#pe2-name')).focus(), 80);
  }
  function closePromptEdit() { $('#pe2-mask').classList.remove('show'); editingPrompt = null; }
  $('#pe2-cancel').onclick = closePromptEdit;
  $('#pe2-mask').onclick = e => { if (e.target.id === 'pe2-mask') closePromptEdit(); };
  $('#pe2-ok').onclick = () => {
    const content = $('#pe2-content').value;
    if (!content.trim()) { toast('请填写内容'); return; }
    const item = Personas.normalizePrompt({ id: editingPrompt || undefined, title: $('#pe2-name').value, content });
    const i = prompts.findIndex(q => q.id === item.id);
    if (i >= 0) prompts[i] = Object.assign(prompts[i], { title: item.title, content: item.content }); else prompts.unshift(item);
    savePrompts(); closePromptEdit(); toast('已保存');
    if ($('#prompt-sheet').classList.contains('show')) renderPromptList();
    if ($('#page-personas').classList.contains('show')) renderPromptManage();
  };
  $('#pe2-delete').onclick = async () => {
    const id = editingPrompt; closePromptEdit();
    const ok = await dialog({ title: '删除提示词？', body: '删除后无法恢复。', okText: '删除', danger: true });
    if (!ok) return;
    prompts = prompts.filter(q => q.id !== id); savePrompts(); renderPromptManage(); renderPromptList(); toast('已删除');
  };

  // ---------------- 服务商编辑 ----------------
  let editing = null, editModels = [];
  const baseHints = {
    openai: '填写到版本路径这一级（通常以 /v1 结尾），程序会自动拼接 /chat/completions。',
    anthropic: '一般为 https://api.anthropic.com（程序拼接 /v1/messages）。',
    gemini: '一般为 https://generativelanguage.googleapis.com/v1beta。',
  };
  const presetHints = {
    deepseek: 'DeepSeek 官方地址：https://api.deepseek.com',
    qwen: '也可使用百炼业务空间专属域名：https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  };
  function openProviderEdit(id, fresh) {
    editing = fresh || Object.assign({}, getProvider(id));
    editModels = (editing.models || []).filter(Boolean).slice();
    $('#pe-title').textContent = fresh ? '添加服务商' : editing.name;
    $('#pe-name').value = editing.name;
    $('#pe-type').value = editing.type;
    $('#pe-base').value = editing.baseUrl;
    $('#pe-key').value = editing.apiKey || ''; $('#pe-key').type = 'password'; $('#pe-key-toggle').textContent = '显示';
    $('#pe-imgmodel').value = editing.imageModel || '';
    $('#pe-streamusage').checked = Providers.streamUsageEnabled(Object.assign({}, editing, { type: 'openai' }));
    $('#pe-su-row').style.display = editing.type === 'openai' ? '' : 'none';
    $('#pe-model-add').value = '';
    $('#pe-base-hint').textContent = presetHints[editing.presetId] || baseHints[editing.type];
    $('#pe-delete').style.display = fresh ? 'none' : '';
    renderModelChips();
    $('#page-provider').classList.add('show');
  }
  function renderModelChips() {
    const box = $('#pe-model-chips'); box.innerHTML = '';
    editModels.forEach((m, i) => {
      const c = document.createElement('span'); c.className = 'mchip' + (i === 0 ? ' default' : '');
      c.innerHTML = '<span class="mc-name">' + esc(m) + '</span><button class="mc-x" aria-label="删除">×</button>';
      c.querySelector('.mc-name').onclick = () => { editModels.splice(i, 1); editModels.unshift(m); renderModelChips(); };
      c.querySelector('.mc-x').onclick = () => { editModels.splice(i, 1); renderModelChips(); };
      box.appendChild(c);
    });
  }
  function addModels(list) {
    let n = 0;
    list.forEach(m => { m = String(m).trim(); if (m && !editModels.includes(m)) { editModels.push(m); n++; } });
    renderModelChips();
    return n;
  }
  $('#pe-model-add-btn').onclick = () => {
    const v = $('#pe-model-add').value.split(/[\n,，]/);
    if (!addModels(v)) { toast('请输入新的模型名称'); return; }
    $('#pe-model-add').value = '';
  };
  $('#pe-model-add').addEventListener('keydown', e => { if (e.key === 'Enter') $('#pe-model-add-btn').click(); });
  $('#pe-type').onchange = () => {
    const t = $('#pe-type').value; $('#pe-base-hint').textContent = baseHints[t];
    $('#pe-su-row').style.display = t === 'openai' ? '' : 'none';
    const def = { anthropic: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com/v1beta' }[t];
    if (def && (!$('#pe-base').value || $('#pe-base').value === 'https://')) $('#pe-base').value = def;
  };
  $('#pe-key-toggle').onclick = () => {
    const k = $('#pe-key'); const show = k.type === 'password';
    k.type = show ? 'text' : 'password'; $('#pe-key-toggle').textContent = show ? '隐藏' : '显示';
  };
  function closeProviderEdit() { $('#page-provider').classList.remove('show'); editing = null; renderProviderList(); }
  $('#pe-save').onclick = () => {
    const base = $('#pe-base').value.trim();
    if (!/^https?:\/\/.+/.test(base)) { toast('Base URL 需以 http:// 或 https:// 开头'); return; }
    if ($('#pe-model-add').value.trim()) addModels($('#pe-model-add').value.split(/[\n,，]/));
    if (!editModels.length) { toast('请至少添加一个模型'); return; }
    const p = { id: editing.id, presetId: editing.presetId, name: $('#pe-name').value.trim() || '未命名', type: $('#pe-type').value,
      baseUrl: base, apiKey: $('#pe-key').value.trim(), models: editModels.slice(), imageModel: $('#pe-imgmodel').value.trim() };
    if ($('#pe-type').value === 'openai') {
      const su = $('#pe-streamusage').checked;
      if (su !== Providers.streamUsageEnabled(Object.assign({}, p, { streamUsage: undefined }))) p.streamUsage = su; // 只保存与默认不同的选择
    }
    const i = settings.providers.findIndex(x => x.id === p.id);
    if (i >= 0) settings.providers[i] = p; else settings.providers.push(p);
    saveSettings(); toast('已保存'); closeProviderEdit(); renderHeader();
  };
  $('#pe-delete').onclick = async () => {
    const ok = await dialog({ title: '删除服务商？', body: '将删除「' + editing.name + '」及其 API Key。', okText: '删除', danger: true });
    if (!ok) return;
    settings.providers = settings.providers.filter(x => x.id !== editing.id);
    if (editing.presetId && editing.presetId !== 'custom') settings.removedPresets = (settings.removedPresets || []).concat(editing.presetId);
    saveSettings(); closeProviderEdit(); renderHeader();
  };

  // 从接口获取模型列表
  let fetched = [], fetchSel = new Set();
  $('#pe-fetch').onclick = async () => {
    const prov = { type: $('#pe-type').value, baseUrl: $('#pe-base').value.trim(), apiKey: $('#pe-key').value.trim() };
    if (!/^https?:\/\/.+/.test(prov.baseUrl)) { toast('请先填写正确的 Base URL'); return; }
    if (!prov.apiKey) { toast('请先填写 API Key'); return; }
    const btn = $('#pe-fetch'); btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '获取中…';
    try {
      const r = await httpSimple(Providers.buildModelsRequest(prov));
      if (r.status >= 400 || !r.status) throw new Error(Providers.parseError(r.status, r.text));
      fetched = Providers.parseModelsResponse(prov.type, r.text);
      if (!fetched.length) throw new Error('接口没有返回任何模型');
      fetchSel = new Set();
      $('#fetch-search').value = '';
      renderFetchList();
      $('#fetch-sheet').classList.add('show'); $('#fetch-mask').classList.add('show');
    } catch (e) {
      dialog({ title: '获取失败', body: String(e.message || e) + '\n\n部分服务商不提供模型列表接口，可手动输入模型名。', okText: '知道了', info: true });
    } finally { btn.disabled = false; btn.innerHTML = old; }
  };
  function renderFetchList() {
    const q = $('#fetch-search').value.trim().toLowerCase();
    const box = $('#fetch-list'); box.innerHTML = '';
    fetched.filter(m => !q || m.toLowerCase().includes(q)).forEach(m => {
      const had = editModels.includes(m);
      const el = document.createElement('div'); el.className = 'check-item' + (fetchSel.has(m) || had ? ' on' : '');
      el.innerHTML = '<span class="box">' + ICON.check + '</span><span class="cl-name">' + esc(m) + '</span>' + (had ? '<span class="cl-tag">已添加</span>' : '');
      if (!had) el.onclick = () => { fetchSel.has(m) ? fetchSel.delete(m) : fetchSel.add(m); renderFetchList(); };
      box.appendChild(el);
    });
    $('#fetch-ok').textContent = fetchSel.size ? '添加所选（' + fetchSel.size + '）' : '添加所选';
  }
  function closeFetch() { $('#fetch-sheet').classList.remove('show'); $('#fetch-mask').classList.remove('show'); }
  $('#fetch-search').addEventListener('input', renderFetchList);
  $('#fetch-all').onclick = () => {
    const q = $('#fetch-search').value.trim().toLowerCase();
    fetched.filter(m => (!q || m.toLowerCase().includes(q)) && !editModels.includes(m)).forEach(m => fetchSel.add(m));
    renderFetchList();
  };
  $('#fetch-cancel').onclick = closeFetch;
  $('#fetch-mask').onclick = closeFetch;
  $('#fetch-ok').onclick = () => {
    const n = addModels(fetched.filter(m => fetchSel.has(m)));
    closeFetch(); toast(n ? '已添加 ' + n + ' 个模型，记得保存' : '没有选择新模型');
  };
  document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => window.onAndroidBack());

  // ---------------- 图片查看 ----------------
  let viewerSrc = '';
  function openViewer(src) { viewerSrc = src; $('#viewer-img').src = src; $('#viewer').classList.add('show'); }
  function closeViewer() { $('#viewer').classList.remove('show'); }
  $('#viewer-close').onclick = closeViewer;
  $('#viewer-save').onclick = () => {
    if (bridge) { bridge.saveImage(viewerSrc); toast('正在保存…'); }
    else { const a = document.createElement('a'); a.href = viewerSrc; a.download = 'image.png'; a.click(); }
  };

  // ---------------- 提示词模板 ----------------
  // 模板 = 替换当前对话的系统提示词；⚡ 提示词库 = 插入输入框；助手 = 新建对话
  const rpOn = c => !!(c && Plugins.registry.isActive('rpcache', settings, c));
  /** 修改当前对话的系统提示词。RP 插件开启时走显式的 L1 静态更新（static 版本 +1，并记录原因） */
  function setConvSystem(text, tpl, cause) {
    const c = conv;
    const before = c.systemPrompt || '';
    if (tpl) Object.assign(c, { systemPrompt: text, templateId: tpl.id, templateName: tpl.name, templateEmoji: tpl.emoji || '' });
    else { c.systemPrompt = text; delete c.templateId; delete c.templateName; delete c.templateEmoji; }
    if (rpOn(c) && RPCache.canonicalize(before) !== RPCache.canonicalize(text)) {
      const d = Plugins.registry.convData(c, 'rpcache');
      d.state = RPCache.explicitBaseUpdate(d.state, text, cause, Date.now()).state;
    }
    if (c.messages.length || c.plugins) saveConv(c, false);
    renderHeader(); renderConvBar();
  }
  const RP_WARN = '本对话开启了 RP 缓存优化：系统提示词属于 L1 固定前缀，切换提示词会改变固定前缀，下一轮缓存命中率会下降一次（之后恢复）。';
  async function applyTemplate(tpl, opt) {
    opt = opt || {};
    if (!tpl) { // 清空
      if (!conv.systemPrompt && !conv.templateId) { toast('当前没有系统提示词'); return false; }
      if (rpOn(conv) && !(await dialog({ title: '清空系统提示词？', body: RP_WARN, okText: '仍然清空' }))) return false;
      setConvSystem('', null, { kind: 'clear' }); closeTemplateSheet(); toast('已清空本对话的系统提示词'); return true;
    }
    const vars = Templates.variables(tpl.content);
    let values = {};
    if (vars.length) { values = await openVarDialog(tpl, vars); if (!values) return false; }
    const text = Templates.fill(tpl.content, values);
    if (text === (conv.systemPrompt || '') && conv.templateId === tpl.id) { closeTemplateSheet(); toast('已经在使用「' + tpl.name + '」'); return false; }
    if (rpOn(conv) && !(await dialog({ title: '切换为「' + tpl.name + '」？', body: RP_WARN, okText: '切换' }))) return false;
    setConvSystem(text, tpl, { kind: 'template', name: tpl.name });
    if (!String(tpl.id).startsWith('persona:')) { settings.recentTemplates = Templates.pushRecent(settings.recentTemplates, tpl.id, 5); saveSettings(); }
    closeTemplateSheet();
    toast('已切换为「' + tpl.name + '」' + (conv.messages.length ? '，从下一条消息开始生效' : ''));
    return true;
  }

  // 变量填写
  let varResolve = null;
  function openVarDialog(tpl, vars) {
    const last = (settings.templateVars || {})[tpl.id] || {};
    $('#tv-title').textContent = '填写「' + tpl.name + '」的变量';
    const box = $('#tv-fields'); box.innerHTML = '';
    vars.forEach(v => {
      const l = document.createElement('label'); l.className = 'field';
      l.innerHTML = '<span>' + esc(v) + '</span><input data-var="' + esc(v) + '" placeholder="填写' + esc(v) + '">';
      l.querySelector('input').value = last[v] || '';
      box.appendChild(l);
    });
    const preview = () => { const vals = collectVars(); $('#tv-preview').textContent = Templates.fill(tpl.content, vals).slice(0, 160); };
    box.querySelectorAll('input').forEach(i => i.addEventListener('input', preview)); preview();
    $('#tv-mask').classList.add('show');
    setTimeout(() => { const f = box.querySelector('input'); if (f) f.focus(); }, 80);
    return new Promise(res => { varResolve = vals => { if (vals) { settings.templateVars = Object.assign({}, settings.templateVars, { [tpl.id]: vals }); saveSettings(); } res(vals); }; });
  }
  function collectVars() { const o = {}; $('#tv-fields').querySelectorAll('input').forEach(i => { o[i.dataset.var] = i.value; }); return o; }
  function closeVarDialog(vals) { $('#tv-mask').classList.remove('show'); const r = varResolve; varResolve = null; if (r) r(vals); }
  $('#tv-cancel').onclick = () => closeVarDialog(null);
  $('#tv-ok').onclick = () => closeVarDialog(collectVars());
  $('#tv-mask').onclick = e => { if (e.target.id === 'tv-mask') closeVarDialog(null); };

  // 快速切换面板
  function renderTplChip() {
    const b = $('#btn-template'); if (!b || !conv) return;
    b.classList.toggle('active', !!conv.templateName);
    $('#tpl-chip-label').textContent = conv.templateName ? (conv.templateName.length > 5 ? conv.templateName.slice(0, 5) + '…' : conv.templateName) : '模板';
  }
  function openTemplateSheet() {
    $('#tq-search').value = '';
    renderTemplateSheet();
    $('#tpl-sheet').classList.add('show'); $('#tpl-mask').classList.add('show');
  }
  function closeTemplateSheet() { $('#tpl-sheet').classList.remove('show'); $('#tpl-mask').classList.remove('show'); }
  function tplItem(t, opts) {
    const el = document.createElement('button');
    const cur = conv.templateId === t.id;
    el.className = 'prompt-item tpl-item' + (cur ? ' current' : '');
    const vars = Templates.variables(t.content);
    el.innerHTML = '<span class="pi-t"><span class="tpl-emoji">' + esc(t.emoji || '📋') + '</span>' + esc(t.name) + (t.pinned ? '<span class="tpl-star">★</span>' : '') +
      (cur ? '<span class="tpl-cur">使用中</span>' : '') + (vars.length ? '<span class="tpl-var">' + vars.length + ' 个变量</span>' : '') + '</span>' +
      '<span class="pi-c">' + esc(t.content.replace(/\s+/g, ' ').slice(0, 70)) + '</span>';
    el.onclick = () => applyTemplate(t);
    return el;
  }
  function renderTemplateSheet() {
    const q = $('#tq-search').value.trim();
    const box = $('#tq-list'); box.innerHTML = '';
    const cur = $('#tq-cur');
    cur.innerHTML = conv.templateName ? '当前：<b>' + esc((conv.templateEmoji || '📋') + ' ' + conv.templateName) + '</b>' + (rpOn(conv) ? ' · <span class="muted">RP 模式下切换会改变固定前缀</span>' : '')
      : conv.systemPrompt ? '当前：<b>自定义系统提示词</b>' : '当前：<span class="muted">无系统提示词</span>';
    const sec = t => { const h = document.createElement('div'); h.className = 'tq-sec'; h.textContent = t; box.appendChild(h); };
    const list = Templates.filter(templates, { query: q });
    if (!q) {
      const rec = Templates.recentOf(templates, settings.recentTemplates).slice(0, 3);
      if (rec.length) { sec('最近使用'); rec.forEach(t => box.appendChild(tplItem(t))); }
      sec('全部模板（★ 收藏在前）');
    }
    if (!list.length) box.insertAdjacentHTML('beforeend', '<div class="conv-empty">没有匹配的模板</div>');
    list.forEach(t => box.appendChild(tplItem(t)));
    const ps = personas.filter(p => p.systemPrompt && (!q || p.name.includes(q) || p.systemPrompt.includes(q)));
    if (ps.length) { sec('从助手套用（只替换系统提示词，不改模型）'); ps.forEach(p => box.appendChild(tplItem(Templates.fromPersona(p)))); }
  }
  $('#btn-template').onclick = openTemplateSheet;
  $('#tpl-mask').onclick = closeTemplateSheet;
  $('#tq-search').addEventListener('input', renderTemplateSheet);
  $('#tq-clear').onclick = () => applyTemplate(null);
  $('#tq-manage').onclick = () => { closeTemplateSheet(); openTemplates(); };
  $('#tq-new').onclick = () => { closeTemplateSheet(); openTemplates(); openTemplateEdit(null); };

  // 模板管理页
  let tmTag = '';
  function openTemplates() { closeDrawer(); $('#tm-search').value = ''; tmTag = ''; renderTemplateManage(); $('#page-templates').classList.add('show'); }
  function closeTemplates() { $('#page-templates').classList.remove('show'); renderConvBar(); }
  function renderTemplateManage() {
    const tags = Templates.allTags(templates);
    const tb = $('#tm-tags'); tb.innerHTML = '';
    ['', ...tags].forEach(g => {
      const c = document.createElement('button'); c.className = 'chip' + (g === tmTag ? ' active' : ''); c.textContent = g || '全部';
      c.onclick = () => { tmTag = g; renderTemplateManage(); };
      tb.appendChild(c);
    });
    const box = $('#tm-list'); box.innerHTML = '';
    const list = Templates.filter(templates, { query: $('#tm-search').value, tag: tmTag });
    if (!list.length) box.innerHTML = '<div class="conv-empty">没有模板</div>';
    list.forEach(t => {
      const el = document.createElement('div'); el.className = 'prov-item tm-row';
      const def = settings.defaultTemplateId === t.id;
      el.innerHTML = '<span class="avatar lg tm-ic">' + esc(t.emoji || '📋') + '</span><div class="pi-main"><div class="pi-name">' + esc(t.name) +
        (def ? '<span class="tpl-cur">新对话默认</span>' : '') + '</div><div class="pi-sub">' + (t.tags.length ? esc(t.tags.join(' · ')) + ' — ' : '') + esc(t.content.replace(/\s+/g, ' ').slice(0, 40)) + '</div></div>' +
        '<button class="tm-pin' + (t.pinned ? ' on' : '') + '" aria-label="收藏">' + (t.pinned ? '★' : '☆') + '</button><button class="ci-more" aria-label="更多">' + ICON.more + '</button>';
      el.querySelector('.tm-pin').onclick = e => { e.stopPropagation(); templates = Templates.togglePin(templates, t.id); saveTemplates(); renderTemplateManage(); };
      el.querySelector('.ci-more').onclick = e => { e.stopPropagation(); templateActions(t); };
      el.onclick = () => openTemplateEdit(t.id);
      box.appendChild(el);
    });
    $('#template-count').textContent = templates.length + ' 个模板 · 一键切换系统提示词';
  }
  function templateActions(t) {
    const vars = Templates.variables(t.content).length;
    actionSheet(t.name, [
      { label: '应用到当前对话', icon: ICON.check, onClick: async () => { if (await applyTemplate(t)) closeTemplates(); } },
      { label: '编辑', icon: ICON.edit, onClick: () => openTemplateEdit(t.id) },
      { label: '复制一份', icon: ICON.dup, onClick: () => { templates = Templates.duplicate(templates, t.id); saveTemplates(); renderTemplateManage(); toast('已复制'); } },
      { label: '上移', icon: ICON.chevR, onClick: () => { templates = Templates.move(templates, t.id, -1); saveTemplates(); renderTemplateManage(); } },
      { label: '下移', icon: ICON.chevR, onClick: () => { templates = Templates.move(templates, t.id, 1); saveTemplates(); renderTemplateManage(); } },
      settings.defaultTemplateId === t.id ? { label: '取消新对话默认', icon: ICON.chat, onClick: () => { settings.defaultTemplateId = null; saveSettings(); renderTemplateManage(); toast('新对话不再使用默认模板'); } }
        : { label: '设为新对话默认', icon: ICON.chat, onClick: () => { if (vars) { toast('含变量的模板不能设为默认'); return; } settings.defaultTemplateId = t.id; saveSettings(); renderTemplateManage(); toast('新对话将默认使用「' + t.name + '」'); } },
      { label: '删除', icon: ICON.trash, danger: true, onClick: () => deleteTemplate(t) },
    ]);
  }
  async function deleteTemplate(t) {
    const ok = await dialog({ title: '删除「' + t.name + '」？', body: '已经使用该模板的对话不受影响（系统提示词保留）。' + (t.builtin ? '内置模板删除后不会再自动出现。' : ''), okText: '删除', danger: true });
    if (!ok) return;
    templates = Templates.remove(templates, t.id);
    if (t.builtin) settings.removedTemplates = (settings.removedTemplates || []).concat([t.id]);
    if (settings.defaultTemplateId === t.id) settings.defaultTemplateId = null;
    settings.recentTemplates = (settings.recentTemplates || []).filter(x => x !== t.id);
    saveSettings(); saveTemplates(); renderTemplateManage(); toast('已删除');
  }
  $('#tm-search').addEventListener('input', renderTemplateManage);
  $('#tm-new').onclick = () => openTemplateEdit(null);
  $('#btn-templates').onclick = () => { closeDrawer(); setTimeout(openTemplates, 120); };
  $('#tm-more').onclick = () => actionSheet('导入 / 导出', [
    { label: '导出全部（复制 JSON 到剪贴板）', icon: ICON.copy, onClick: () => { copyText(Templates.exportJSON(templates)); toast('已复制 ' + templates.length + ' 个模板的 JSON，可粘贴保存或分享'); } },
    { label: '从 JSON 文件导入', icon: ICON.file, onClick: () => $('#tm-file').click() },
    { label: '粘贴 JSON 导入', icon: ICON.rename, onClick: async () => {
      const v = await dialog({ title: '粘贴 JSON 导入', body: '粘贴之前导出的模板 JSON：', input: true, value: '', okText: '导入' });
      if (typeof v === 'string' && v.trim()) importTemplates(v);
    } },
  ]);
  function importTemplates(text) {
    try {
      const r = Templates.importJSON(text, templates);
      templates = r.list; saveTemplates(); renderTemplateManage();
      toast('已导入 ' + r.added + ' 个模板' + (r.skipped ? '，跳过 ' + r.skipped + ' 个（重复或无内容）' : ''));
    } catch (e) { dialog({ title: '导入失败', body: e.message, okText: '知道了', info: true }); }
  }
  $('#tm-file').onchange = e => {
    const f = e.target.files && e.target.files[0]; e.target.value = '';
    if (!f) return;
    const rd = new FileReader(); rd.onload = () => importTemplates(String(rd.result)); rd.readAsText(f);
  };

  // 模板编辑页
  let editingTpl = null;
  function openTemplateEdit(id) {
    const t = id ? templates.find(x => x.id === id) : null;
    editingTpl = t ? t.id : null;
    $('#te-title').textContent = t ? '编辑模板' : '新建模板';
    $('#te-emoji').value = t ? t.emoji : ''; $('#te-name').value = t ? t.name : '';
    $('#te-tags').value = t ? t.tags.join(', ') : ''; $('#te-content').value = t ? t.content : '';
    $('#te-pin').checked = t ? t.pinned : false;
    $('#te-delete').style.display = t ? '' : 'none';
    teVars();
    $('#page-template').classList.add('show');
  }
  function teVars() {
    const v = Templates.variables($('#te-content').value);
    $('#te-vars').textContent = v.length ? '变量：' + v.map(x => '{{' + x + '}}').join('、') + '（应用时填写）' : '可以用 {{变量名}} 插入变量，应用模板时会提示填写。';
  }
  $('#te-content').addEventListener('input', teVars);
  function closeTemplateEdit() { $('#page-template').classList.remove('show'); editingTpl = null; }
  $('#te-save').onclick = () => {
    const content = $('#te-content').value;
    if (!content.trim()) { toast('请填写系统提示词'); return; }
    const old = editingTpl ? templates.find(x => x.id === editingTpl) : null;
    const t = Templates.normalizeTemplate({ id: editingTpl || undefined, name: $('#te-name').value, emoji: $('#te-emoji').value, tags: $('#te-tags').value, content, pinned: $('#te-pin').checked, builtin: old && old.builtin });
    templates = Templates.upsert(templates, t);
    if (settings.defaultTemplateId === t.id && Templates.variables(t.content).length) { settings.defaultTemplateId = null; saveSettings(); }
    saveTemplates(); closeTemplateEdit(); renderTemplateManage(); toast('已保存');
  };
  $('#te-delete').onclick = () => { const t = templates.find(x => x.id === editingTpl); if (!t) return; closeTemplateEdit(); deleteTemplate(t); };
  function renderDefaultTplSelect() {
    const sel = $('#set-deftpl');
    sel.innerHTML = '<option value="">不使用（用下方的默认系统提示词）</option>' +
      templates.filter(t => !Templates.variables(t.content).length).map(t => '<option value="' + esc(t.id) + '">' + esc((t.emoji || '📋') + ' ' + t.name) + '</option>').join('');
    sel.value = settings.defaultTemplateId && templates.some(t => t.id === settings.defaultTemplateId) ? settings.defaultTemplateId : '';
    $('#set-system-row').style.opacity = sel.value ? '.5' : '';
  }
  $('#set-deftpl').addEventListener('change', () => { $('#set-system-row').style.opacity = $('#set-deftpl').value ? '.5' : ''; readGeneral(); });

  // ---------------- 插件 ----------------
  const pluginHost = {
    settings: () => settings, saveSettings, conv: () => conv,
    saveConv: c => saveConv(c || conv, false),
    store: { get: (n, d) => Store.get(n, d), set: (n, v) => Store.set(n, v) },
    toast, dialog, esc,
    refresh: () => { if (conv) { renderHeader(); renderMessages(); } },
    openPanel: (id, tab) => openPluginPanel(id, tab),
    /** 用当前对话的模型做一次非流式调用，返回文本 */
    async callModel(prompt, o) {
      o = o || {};
      const p = getProvider(conv.providerId);
      if (!p || !p.apiKey) throw new Error('请先为本对话选择已配置 API Key 的服务商');
      const req = Providers.buildChatRequest(p, o.model || conv.model, [{ role: 'user', content: prompt }], '', { stream: false, temperature: 0.3, maxTokens: o.maxTokens || 4096 });
      const r = await requestText(req, o.setCancel || null, 180000);
      if (r.status >= 400 || !r.status) throw new Error(Providers.parseError(r.status, r.text));
      const ds = Providers.parseFullResponse(p.type, r.text);
      const err = ds.find(d => d.kind === 'error'); if (err) throw new Error(err.text);
      return ds.filter(d => d.kind === 'text').map(d => d.text).join('');
    },
  };
  function pluginSummary() {
    const on = Plugins.registry.all().filter(pl => Plugins.registry.isGloballyEnabled(pl.id, settings)).length;
    return Plugins.registry.all().length + ' 个内置插件 · 已启用 ' + on;
  }
  function openPlugins() { closeDrawer(); renderPluginList(); $('#page-plugins').classList.add('show'); }
  function closePlugins() { $('#page-plugins').classList.remove('show'); renderAll(); }
  function renderPluginList() {
    const box = $('#plugin-list'); box.innerHTML = '';
    Plugins.registry.all().forEach(pl => {
      const on = Plugins.registry.isGloballyEnabled(pl.id, settings);
      const card = document.createElement('div'); card.className = 'plugin-card' + (on ? ' on' : '');
      card.innerHTML = '<div class="plc-head"><span class="plc-icon">' + esc(pl.icon) + '</span><div class="plc-main"><div class="plc-name">' + esc(pl.name) +
        '<span class="plc-ver">v' + esc(pl.version) + ' · 内置</span></div><div class="plc-desc">' + esc(pl.desc) + '</div></div>' +
        '<input type="checkbox" class="switch" aria-label="启用"' + (on ? ' checked' : '') + '></div>' +
        '<div class="plc-foot">' + (pl.perConversation ? '<span class="plc-note">需在每个对话中单独开启</span>' : '<span class="plc-note">对所有对话生效，可在对话中关闭</span>') +
        (pl.renderPanel ? '<button class="chip-btn accent plc-open">当前对话 ›</button>' : '') + (pl.renderSettings ? '<button class="chip-btn plc-set">设置</button>' : '') + '</div>' +
        '<div class="plc-settings" hidden></div>';
      card.querySelector('.switch').onchange = e => {
        Plugins.registry.setGlobal(settings, pl.id, e.target.checked); saveSettings();
        card.classList.toggle('on', e.target.checked); $('#plugin-count').textContent = pluginSummary(); $('#set-plugins-sub').textContent = pluginSummary();
        toast((e.target.checked ? '已启用 ' : '已停用 ') + pl.name);
      };
      const op = card.querySelector('.plc-open'); if (op) op.onclick = () => openPluginPanel(pl.id);
      const st = card.querySelector('.plc-set');
      if (st) st.onclick = () => {
        const sb = card.querySelector('.plc-settings');
        sb.hidden = !sb.hidden; if (!sb.hidden) pl.renderSettings(sb, pluginHost);
      };
      box.appendChild(card);
    });
    const tip = document.createElement('div'); tip.className = 'hint'; tip.style.marginTop = '14px';
    tip.innerHTML = '开发者：插件 API 见仓库 docs/plugins/README.md。';
    box.appendChild(tip);
  }
  let panelPlugin = null;
  function openPluginPanel(id, tab) {
    const pl = Plugins.registry.get(id); if (!pl) return;
    panelPlugin = pl;
    $('#pp-title').textContent = pl.icon + ' ' + pl.name.replace(/^DeepSeek /, '');
    if (pl.renderPanel) pl.renderPanel($('#pp-body'), pluginHost, tab);
    $('#page-plugin').classList.add('show');
  }
  function closePluginPanel() {
    $('#page-plugin').classList.remove('show'); panelPlugin = null;
    if ($('#page-plugins').classList.contains('show')) renderPluginList();
    renderAll();
  }
  $('#btn-plugins').onclick = () => { closeDrawer(); setTimeout(openPlugins, 120); };
  $('#set-plugins').onclick = () => openPlugins();

  // ---------------- 返回键 ----------------
  window.onAndroidBack = function () {
    const shown = s => $(s).classList.contains('show');
    if (shown('#viewer')) { closeViewer(); return true; }
    if (shown('#dialog-mask')) { closeDialog(null); return true; }
    if (shown('#pe2-mask')) { closePromptEdit(); return true; }
    if (shown('#action-sheet')) { closeActionSheet(); return true; }
    if (shown('#fetch-sheet')) { closeFetch(); return true; }
    if (shown('#model-menu')) { closeModelMenu(); return true; }
    if (shown('#sheet')) { closeSheet(); return true; }
    if (shown('#prompt-sheet')) { closePromptSheet(); return true; }
    if (shown('#tv-mask')) { closeVarDialog(null); return true; }
    if (shown('#tpl-sheet')) { closeTemplateSheet(); return true; }
    if (shown('#page-template')) { closeTemplateEdit(); return true; }
    if (shown('#page-templates')) { closeTemplates(); return true; }
    if (shown('#page-plugin')) { if (panelPlugin && panelPlugin.onBack && panelPlugin.onBack()) return true; closePluginPanel(); return true; }
    if (shown('#page-plugins')) { closePlugins(); return true; }
    if (shown('#page-persona')) { closePersonaEdit(); return true; }
    if (shown('#page-personas')) { closePersonas(); return true; }
    if (shown('#page-provider')) { closeProviderEdit(); return true; }
    if (shown('#page-settings')) { closeSettings(); return true; }
    if (shown('#drawer')) { closeDrawer(); return true; }
    return false;
  };

  // ---------------- 启动 ----------------
  saveSettings();
  if (!Store.get('personas.json', null)) savePersonas();
  if (!Store.get('prompts.json', null)) savePrompts();
  $('#persona-count').textContent = personas.length + ' 个助手 · ' + prompts.length + ' 条提示词';
  $('#plugin-count').textContent = pluginSummary(); $('#set-plugins-sub').textContent = pluginSummary();
  $('#template-count').textContent = templates.length + ' 个模板 · 一键切换系统提示词';
  if (!Store.get('templates.json', null)) saveTemplates();
  if (!(convIndex.length && openConv(convIndex[0].id))) newConv();
  renderSearchChip();
  updateSendState();
})();
