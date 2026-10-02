/* AI Chat —— 前端逻辑 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const bridge = window.AndroidBridge || null;
  const APP_VERSION = '0.1.1';
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
  });
  const stored = Store.get('settings.json', null);
  let settings = stored ? Object.assign(defaultSettings(), { settingsVersion: 1 }, stored) : defaultSettings();
  let convIndex = Store.get('convs.json', []); // [{id,title,providerId,model,updatedAt}]
  let conv = null;
  let attachments = [];
  let imageMode = false;
  let running = null;

  const saveSettings = () => Store.set('settings.json', settings);
  const saveIndex = () => Store.set('convs.json', convIndex);
  function saveConv(c, touch) {
    c = c || conv; if (!c) return;
    if (touch !== false) c.updatedAt = Date.now();
    Store.set('conv_' + c.id + '.json', c);
    const meta = { id: c.id, title: c.title, providerId: c.providerId, model: c.model, updatedAt: c.updatedAt };
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
  function copyText(t) { if (bridge) bridge.copy(t); else navigator.clipboard && navigator.clipboard.writeText(t).catch(() => {}); toast('已复制'); }

  let dialogResolve = null;
  function dialog({ title, body, input, value, okText, danger }) {
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
  function renderMarkdown(text) {
    const div = document.createElement('div');
    div.className = 'md';
    div.innerHTML = DOMPurify.sanitize(marked.parse(text || ''));
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
    div.querySelectorAll('a').forEach(a => a.setAttribute('target', '_blank'));
    return div;
  }

  // ---------------- 对话管理 ----------------
  function newConv() {
    const lp = getProvider(settings.lastProviderId);
    const pid = lp && lp.apiKey ? lp.id : ((configured()[0] || {}).id || '');
    const p = getProvider(pid);
    const model = settings.lastProviderId === pid && settings.lastModel ? settings.lastModel : (p ? p.models[0] || '' : '');
    conv = { id: uid(), title: '新对话', providerId: pid, model, systemPrompt: settings.systemPrompt || '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
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
    Store.del('conv_' + id + '.json');
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
  function renderHeader() {
    const p = getProvider(conv.providerId);
    const ok = p && p.apiKey;
    $('#mp-model').textContent = ok ? (conv.model || '未设置模型') : (configured().length ? '选择模型' : '未配置服务商');
    $('#mp-provider').textContent = ok ? p.name : (configured().length ? '点此切换' : '点此添加 API Key');
    const dot = $('#mp-dot');
    dot.style.background = ok ? (PROVIDER_COLORS[p.presetId] || PROVIDER_COLORS.custom) : '';
    dot.textContent = ok ? p.name.trim().charAt(0).toUpperCase() : '';
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
        esc((p ? p.name + ' · ' : '') + (m.model || '')) + '</div></div><button class="ci-more" aria-label="更多">' + ICON.more + '</button>';
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
      empty.innerHTML = '<img class="hero-logo" src="logo.svg" alt=""><h1>AI Chat</h1>' +
        (has ? '<p class="sub">你好，今天想聊点什么？</p><div class="suggest"></div>'
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
    const isLast = conv.messages[conv.messages.length - 1] === m;
    if (m.role === 'assistant') {
      const head = document.createElement('div'); head.className = 'bot-head';
      head.innerHTML = '<img class="bot-avatar" src="logo.svg" alt=""><span class="bot-name">' + esc(m.model || 'AI') + (m.stopped ? ' · 已停止' : '') + '</span>';
      el.appendChild(head);
    }
    if (m.images && m.images.length) {
      const imgs = document.createElement('div'); imgs.className = 'msg-images';
      m.images.forEach(src => { const i = document.createElement('img'); i.src = src; i.onclick = () => openViewer(src); imgs.appendChild(i); });
      el.appendChild(imgs);
    }
    if (m.role === 'user') {
      if (m.content) { const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.content; el.appendChild(b); }
    } else {
      const body = document.createElement('div'); body.className = 'bot-body';
      if (m.reasoning) {
        const d = document.createElement('details'); d.className = 'reasoning'; if (m.pending && !m.content) d.open = true;
        d.innerHTML = '<summary><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>' + (m.pending && !m.content ? '思考中…' : '思考过程') + '</summary><div class="r-text"></div>';
        d.querySelector('.r-text').textContent = m.reasoning;
        body.appendChild(d);
      }
      if (m.content) { const md = renderMarkdown(m.content); if (m.pending) md.classList.add('cursor'); body.appendChild(md); }
      if (m.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = m.error; body.appendChild(e); }
      if (!m.content && !m.error) {
        if (m.pending && !m.reasoning) { const t = document.createElement('div'); t.className = 'typing'; t.innerHTML = '<i></i><i></i><i></i>'; body.appendChild(t); }
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
    input.value = t; attachments = (m.images || []).slice(); renderAttachments();
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
  function updateSendState() { $('#btn-send').disabled = !running && !input.value.trim() && !attachments.length; }
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
    if (!text && !attachments.length) return;
    const p = ensureProvider(); if (!p) return;
    if (imageMode) return generateImage(p, text);
    const user = { id: uid(), role: 'user', content: text, images: attachments.slice(), createdAt: Date.now() };
    if (!user.images.length) delete user.images;
    conv.messages.push(user);
    if (conv.title === '新对话' && text) conv.title = text.replace(/\s+/g, ' ').slice(0, 24);
    input.value = ''; autosize(); attachments = []; renderAttachments();
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

  function runChat(p) {
    const ctx = conv.messages.filter(m => !m.error && !m.imageGen && !m.pending);
    const bot = { id: uid(), role: 'assistant', content: '', reasoning: '', pending: true, model: conv.model, createdAt: Date.now() };
    conv.messages.push(bot);
    renderMessages();
    settings.lastProviderId = p.id; settings.lastModel = conv.model; saveSettings();
    saveConv(); renderConvList();

    const stream = settings.stream !== false;
    const req = Providers.buildChatRequest(p, conv.model, ctx, conv.systemPrompt,
      { stream, temperature: numOrUndef(settings.temperature), maxTokens: numOrUndef(settings.maxTokens) });
    const parser = Providers.createStreamParser(p.type);
    let status = 0, raw = '', gotDelta = false;
    const thisConv = conv;
    const apply = deltas => deltas.forEach(d => {
      gotDelta = true;
      if (d.kind === 'text') bot.content += d.text;
      else if (d.kind === 'reasoning') bot.reasoning += d.text;
      else if (d.kind === 'error') bot.error = (bot.error ? bot.error + '\n' : '') + d.text;
    });
    const h = httpRequest(req, {
      onStatus: s => { status = s; },
      onChunk: t => {
        raw += t;
        if (status >= 200 && status < 300 && stream) { apply(parser.push(t)); if (conv === thisConv) scheduleUpdate(bot); }
      },
    });
    setRunning({ cancel: h.cancel, msg: bot });
    h.promise.then(() => {
      if (status >= 400 || (status === 0 && !bot.stopped)) {
        bot.error = status ? Providers.parseError(status, raw) : '请求失败：没有收到响应';
      } else if (stream) {
        apply(parser.end());
        if (!gotDelta && raw.trim() && !bot.stopped) apply(Providers.parseFullResponse(p.type, raw));
      } else if (!bot.stopped) {
        apply(Providers.parseFullResponse(p.type, raw));
      }
    }).catch(e => {
      bot.error = '网络错误：' + e.message + '\n请检查网络连接和 Base URL。';
    }).finally(() => {
      bot.pending = false;
      setRunning(null);
      saveConv(thisConv);
      if (conv === thisConv) renderMessages();
      renderConvList();
    });
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
    if (imageMode) { toast('图片生成模式下不能附加图片'); return; }
    $('#file-input').click();
  };
  $('#file-input').onchange = async e => {
    const files = Array.from(e.target.files || []);
    for (const f of files) { try { attachments.push(await compressImage(f)); } catch (err) { toast('图片读取失败'); } }
    e.target.value = ''; renderAttachments();
  };
  $('#btn-imagegen').onclick = () => {
    imageMode = !imageMode;
    $('#btn-imagegen').classList.toggle('active', imageMode);
    $('#composer-card').classList.toggle('imgmode', imageMode);
    input.placeholder = imageMode ? '描述你想生成的图片…' : '给 AI 发消息…';
    toast(imageMode ? '已切换到图片生成模式' : '已切换回聊天模式');
    if (imageMode && attachments.length) { attachments = []; renderAttachments(); }
  };
  function renderAttachments() {
    const box = $('#attach-preview'); box.innerHTML = '';
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
    if (list.length) tools.appendChild(t1);
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
    conv.systemPrompt = $('#sheet-system').value;
    selectModel(sheetPid, m);
    closeSheet();
  };

  // ---------------- 设置 ----------------
  function openSettings() {
    $('#set-system').value = settings.systemPrompt || '';
    $('#set-stream').checked = settings.stream !== false;
    $('#set-temp').value = settings.temperature || '';
    $('#set-maxtokens').value = settings.maxTokens || '';
    $('#set-imgsize').value = settings.imageSize || '';
    $('#about-ver').textContent = 'v' + APP_VERSION + ' · 数据仅存储在本机';
    renderProviderList();
    $('#page-settings').classList.add('show');
  }
  function readGeneral() {
    settings.systemPrompt = $('#set-system').value;
    settings.stream = $('#set-stream').checked;
    settings.temperature = $('#set-temp').value.trim();
    settings.maxTokens = $('#set-maxtokens').value.trim();
    settings.imageSize = $('#set-imgsize').value.trim() || '1024x1024';
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
    convIndex.forEach(m => Store.del('conv_' + m.id + '.json'));
    convIndex = []; saveIndex(); newConv(); toast('已删除全部对话');
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
      dialog({ title: '获取失败', body: String(e.message || e) + '\n\n部分服务商不提供模型列表接口，可手动输入模型名。', okText: '知道了' });
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

  // ---------------- 返回键 ----------------
  window.onAndroidBack = function () {
    const shown = s => $(s).classList.contains('show');
    if (shown('#viewer')) { closeViewer(); return true; }
    if (shown('#dialog-mask')) { closeDialog(null); return true; }
    if (shown('#action-sheet')) { closeActionSheet(); return true; }
    if (shown('#fetch-sheet')) { closeFetch(); return true; }
    if (shown('#model-menu')) { closeModelMenu(); return true; }
    if (shown('#sheet')) { closeSheet(); return true; }
    if (shown('#page-provider')) { closeProviderEdit(); return true; }
    if (shown('#page-settings')) { closeSettings(); return true; }
    if (shown('#drawer')) { closeDrawer(); return true; }
    return false;
  };

  // ---------------- 启动 ----------------
  saveSettings();
  if (!(convIndex.length && openConv(convIndex[0].id))) newConv();
  updateSendState();
})();
