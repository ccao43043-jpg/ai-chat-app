/* AI 聊天 —— 前端逻辑 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const bridge = window.AndroidBridge || null;
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
        fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: ctl.signal }).then(async res => {
          window.__nativeHttp.onStart(id, res.status);
          const reader = res.body.getReader(); const dec = new TextDecoder();
          for (;;) { const { done, value } = await reader.read(); if (done) break; window.__nativeHttp.onChunk(id, dec.decode(value, { stream: true })); }
          window.__nativeHttp.onEnd(id);
        }).catch(e => e.name === 'AbortError' ? window.__nativeHttp.onEnd(id) : window.__nativeHttp.onError(id, String(e)));
      }
    });
    return { promise, cancel: () => cancel && cancel() };
  }

  // ---------------- 状态 ----------------
  const defaultSettings = () => ({
    providers: Providers.PRESETS.map(p => ({ id: p.presetId, presetId: p.presetId, name: p.name, type: p.type, baseUrl: p.baseUrl,
      apiKey: '', models: p.models.slice(), imageModel: p.imageModel || '' })),
    systemPrompt: '', stream: true, temperature: '', maxTokens: '', imageSize: '1024x1024',
    lastProviderId: '', lastModel: '',
  });
  let settings = Object.assign(defaultSettings(), Store.get('settings.json', {}));
  let convIndex = Store.get('convs.json', []); // [{id,title,providerId,model,updatedAt}]
  let conv = null;          // 当前对话（含 messages）
  let attachments = [];     // 待发送图片 dataURL
  let imageMode = false;
  let running = null;       // {cancel, msg}

  const saveSettings = () => Store.set('settings.json', settings);
  const saveIndex = () => Store.set('convs.json', convIndex);
  function saveConv(c) {
    c = c || conv; if (!c) return;
    c.updatedAt = Date.now();
    Store.set('conv_' + c.id + '.json', c);
    const meta = { id: c.id, title: c.title, providerId: c.providerId, model: c.model, updatedAt: c.updatedAt };
    const i = convIndex.findIndex(x => x.id === c.id);
    if (i >= 0) convIndex[i] = meta; else convIndex.unshift(meta);
    convIndex.sort((a, b) => b.updatedAt - a.updatedAt);
    saveIndex();
  }
  const getProvider = id => settings.providers.find(p => p.id === id);
  const configured = () => settings.providers.filter(p => p.apiKey && p.apiKey.trim());

  // ---------------- 工具 ----------------
  let toastTimer;
  function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 1800); }
  function copyText(t) { if (bridge) bridge.copy(t); else navigator.clipboard && navigator.clipboard.writeText(t); toast('已复制'); }

  let dialogResolve = null;
  function dialog({ title, body, input, value, okText, danger }) {
    $('#dialog-title').textContent = title || '';
    $('#dialog-body').textContent = body || '';
    const inp = $('#dialog-input');
    inp.style.display = input ? '' : 'none'; inp.value = value || '';
    const ok = $('#dialog-ok'); ok.textContent = okText || '确定';
    ok.className = 'pill-btn ' + (danger ? 'danger' : 'primary');
    $('#dialog-mask').classList.add('show');
    if (input) setTimeout(() => { inp.focus(); inp.select(); }, 50);
    return new Promise(res => { dialogResolve = res; });
  }
  function closeDialog(result) { $('#dialog-mask').classList.remove('show'); if (dialogResolve) { const r = dialogResolve; dialogResolve = null; r(result); } }
  $('#dialog-ok').onclick = () => closeDialog($('#dialog-input').style.display === 'none' ? true : $('#dialog-input').value);
  $('#dialog-cancel').onclick = () => closeDialog(null);
  $('#dialog-input').addEventListener('keydown', e => { if (e.key === 'Enter') $('#dialog-ok').click(); });

  // ---------------- Markdown ----------------
  marked.setOptions({ gfm: true, breaks: true });
  function renderMarkdown(text) {
    const html = DOMPurify.sanitize(marked.parse(text || ''));
    const div = document.createElement('div');
    div.className = 'md';
    div.innerHTML = html;
    div.querySelectorAll('pre > code').forEach(code => {
      const pre = code.parentElement;
      const m = /language-([\w+#.-]+)/.exec(code.className || '');
      const lang = m ? m[1] : '';
      try {
        if (lang && hljs.getLanguage(lang)) code.innerHTML = hljs.highlight(code.textContent, { language: lang, ignoreIllegals: true }).value;
        else if (code.textContent.length < 20000) code.innerHTML = hljs.highlightAuto(code.textContent).value;
        code.classList.add('hljs');
      } catch (e) { /* ignore */ }
      const wrap = document.createElement('div'); wrap.className = 'code-block';
      const head = document.createElement('div'); head.className = 'code-head';
      head.innerHTML = '<span>' + esc(lang || 'code') + '</span><button>复制</button>';
      const raw = code.textContent;
      head.querySelector('button').onclick = () => copyText(raw);
      pre.replaceWith(wrap); wrap.appendChild(head); wrap.appendChild(pre);
    });
    return div;
  }

  // ---------------- 对话管理 ----------------
  function newConv() {
    const pid = (getProvider(settings.lastProviderId) && getProvider(settings.lastProviderId).apiKey) ? settings.lastProviderId : ((configured()[0] || {}).id || '');
    const p = getProvider(pid);
    let model = settings.lastProviderId === pid && settings.lastModel ? settings.lastModel : (p ? p.models[0] || '' : '');
    conv = { id: uid(), title: '新对话', providerId: pid, model, systemPrompt: settings.systemPrompt || '', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    renderAll();
  }
  function openConv(id) {
    const c = Store.get('conv_' + id + '.json', null);
    if (!c) { convIndex = convIndex.filter(x => x.id !== id); saveIndex(); renderConvList(); return; }
    conv = c; renderAll();
  }
  async function deleteConv(id) {
    const meta = convIndex.find(x => x.id === id);
    const ok = await dialog({ title: '删除对话', body: '确定删除「' + (meta ? meta.title : '') + '」吗？此操作不可恢复。', okText: '删除', danger: true });
    if (!ok) return;
    if (running && conv && conv.id === id) stopGen();
    Store.del('conv_' + id + '.json');
    convIndex = convIndex.filter(x => x.id !== id); saveIndex();
    if (conv && conv.id === id) newConv(); else renderConvList();
  }
  async function renameConv(id) {
    const c = conv && conv.id === id ? conv : Store.get('conv_' + id + '.json', null);
    if (!c) return;
    const t = await dialog({ title: '重命名对话', input: true, value: c.title });
    if (t == null || !t.trim()) return;
    c.title = t.trim(); saveConv(c);
    if (conv && conv.id === id) conv.title = c.title;
    renderHeader(); renderConvList();
  }

  // ---------------- 渲染 ----------------
  function renderAll() { renderHeader(); renderMessages(); renderConvList(); }
  function renderHeader() {
    $('#conv-title').textContent = conv.title || '新对话';
    const p = getProvider(conv.providerId);
    $('#conv-model').textContent = p ? (p.name + ' · ' + (conv.model || '未设置模型') + ' ▾') : '点此选择模型 ▾';
  }
  function fmtTime(t) {
    const d = new Date(t), n = new Date();
    const pad = x => String(x).padStart(2, '0');
    if (d.toDateString() === n.toDateString()) return pad(d.getHours()) + ':' + pad(d.getMinutes());
    return (d.getMonth() + 1) + '/' + d.getDate();
  }
  function renderConvList() {
    const list = $('#conv-list');
    if (!convIndex.length) { list.innerHTML = '<div class="hint" style="padding:12px">还没有对话</div>'; return; }
    list.innerHTML = '';
    convIndex.forEach(m => {
      const p = getProvider(m.providerId);
      const el = document.createElement('div');
      el.className = 'conv-item' + (conv && conv.id === m.id ? ' active' : '');
      el.innerHTML = '<div class="ci-main"><div class="ci-title">' + esc(m.title) + '</div><div class="ci-sub">' +
        esc((p ? p.name + ' · ' : '') + (m.model || '')) + ' · ' + fmtTime(m.updatedAt) + '</div></div>' +
        '<button class="ci-act" data-a="rename">重命名</button><button class="ci-act" data-a="del">删除</button>';
      el.onclick = e => {
        const a = e.target.dataset && e.target.dataset.a;
        if (a === 'rename') return renameConv(m.id);
        if (a === 'del') return deleteConv(m.id);
        if (running) { toast('请先停止当前生成'); return; }
        openConv(m.id); closeDrawer();
      };
      list.appendChild(el);
    });
  }
  function renderMessages() {
    const box = $('#messages');
    box.innerHTML = '';
    if (!conv.messages.length) {
      const has = configured().length > 0;
      box.innerHTML = '<div class="empty"><div class="logo">AI</div><div>' +
        (has ? '开始新的对话吧<br><small>点击顶部可切换服务商和模型</small>' : '欢迎使用 AI 聊天<br><small>请先在设置中填写至少一个服务商的 API Key</small>') +
        '</div>' + (has ? '' : '<button class="pill-btn primary" id="empty-setup">去设置</button>') + '</div>';
      const b = $('#empty-setup'); if (b) b.onclick = openSettings;
      return;
    }
    conv.messages.forEach(m => box.appendChild(buildMsgEl(m)));
    box.scrollTop = box.scrollHeight;
  }
  function buildMsgEl(m) {
    const el = document.createElement('div');
    el.className = 'msg ' + m.role + (m.error ? ' error' : '');
    el.dataset.id = m.id;
    fillMsgEl(el, m);
    return el;
  }
  function fillMsgEl(el, m) {
    el.className = 'msg ' + m.role + (m.error ? ' error' : '');
    el.innerHTML = '';
    if (m.images && m.images.length) {
      const imgs = document.createElement('div'); imgs.className = 'msg-images';
      m.images.forEach(src => { const i = document.createElement('img'); i.src = src; i.onclick = () => openViewer(src); imgs.appendChild(i); });
      el.appendChild(imgs);
    }
    const isLast = conv.messages[conv.messages.length - 1] === m;
    if (m.role === 'user') {
      if (m.content) { const b = document.createElement('div'); b.className = 'bubble'; b.textContent = m.content; el.appendChild(b); }
    } else {
      const showBubble = m.content || m.reasoning || m.error || m.pending || !(m.images && m.images.length);
      if (showBubble) {
        const b = document.createElement('div'); b.className = 'bubble';
        if (m.reasoning) {
          const d = document.createElement('details'); d.className = 'reasoning'; if (m.pending && !m.content) d.open = true;
          d.innerHTML = '<summary>思考过程</summary><div class="r-text"></div>';
          d.querySelector('.r-text').textContent = m.reasoning;
          b.appendChild(d);
        }
        if (m.error) { const e = document.createElement('div'); e.textContent = m.error; if (m.content) b.appendChild(renderMarkdown(m.content)); b.appendChild(e); }
        else if (m.content) b.appendChild(renderMarkdown(m.content));
        else if (m.pending) { const t = document.createElement('div'); t.className = 'typing'; t.innerHTML = '<i></i><i></i><i></i>'; b.appendChild(t); }
        else if (!m.reasoning) { const e = document.createElement('div'); e.style.color = 'var(--fg2)'; e.textContent = m.stopped ? '（已停止）' : '（空回复）'; b.appendChild(e); }
        el.appendChild(b);
      }
      if (m.model) { const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = m.model + (m.stopped ? ' · 已停止' : ''); el.appendChild(meta); }
    }
    if (!m.pending) {
      const act = document.createElement('div'); act.className = 'actions';
      if (m.content) act.appendChild(mkBtn('复制', () => copyText(m.content)));
      if (m.role === 'assistant' && isLast && !running) act.appendChild(mkBtn('重新生成', regenerate));
      if (m.role === 'user' && !running) act.appendChild(mkBtn('编辑', () => editUserMsg(m)));
      if (!running) act.appendChild(mkBtn('删除', () => deleteMsg(m)));
      el.appendChild(act);
    }
  }
  const mkBtn = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.onclick = fn; return b; };
  function nearBottom() { const b = $('#messages'); return b.scrollHeight - b.scrollTop - b.clientHeight < 120; }
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
    rafTimer = setTimeout(() => { rafTimer = null; const s = rafPending; rafPending = new Set(); s.forEach(updateMsg); }, 80);
  }

  function deleteMsg(m) {
    conv.messages = conv.messages.filter(x => x !== m);
    saveConv(); renderMessages();
  }
  async function editUserMsg(m) {
    const t = await dialog({ title: '编辑消息并重新发送', input: true, value: m.content });
    if (t == null) return;
    const idx = conv.messages.indexOf(m);
    conv.messages = conv.messages.slice(0, idx);
    $('#input').value = t; attachments = (m.images || []).slice(); renderAttachments();
    saveConv(); renderMessages(); send();
  }

  // ---------------- 发送 / 生成 ----------------
  function setRunning(r) {
    running = r;
    const btn = $('#btn-send');
    btn.classList.toggle('stop', !!r);
    btn.setAttribute('aria-label', r ? '停止' : '发送');
  }
  function ensureProvider() {
    const p = getProvider(conv.providerId);
    if (!p || !p.apiKey) {
      if (!configured().length) { toast('请先在设置中填写 API Key'); openSettings(); }
      else { toast('请先选择服务商和模型'); openSheet(); }
      return null;
    }
    if (!conv.model) { toast('请填写模型名称'); openSheet(); return null; }
    return p;
  }
  function send() {
    if (running) return;
    const text = $('#input').value.trim();
    if (!text && !attachments.length) return;
    const p = ensureProvider(); if (!p) return;
    if (imageMode) return generateImage(p, text);
    const user = { id: uid(), role: 'user', content: text, images: attachments.slice(), createdAt: Date.now() };
    if (!user.images.length) delete user.images;
    conv.messages.push(user);
    if (conv.title === '新对话' && text) conv.title = text.replace(/\s+/g, ' ').slice(0, 24);
    $('#input').value = ''; autosize(); attachments = []; renderAttachments();
    renderHeader(); runChat(p);
  }
  function regenerate() {
    if (running) return;
    const last = conv.messages[conv.messages.length - 1];
    if (last && last.role === 'assistant') {
      if (last.imageGen) { conv.messages.pop(); const u = conv.messages.pop(); const p = ensureProvider(); if (p && u) { $('#input').value = u.content; return generateImage(p, u.content); } return; }
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
    const maxTokens = numOrUndef(settings.maxTokens);
    const req = Providers.buildChatRequest(p, conv.model, ctx, conv.systemPrompt, { stream, temperature: numOrUndef(settings.temperature), maxTokens });
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
      if (status >= 400 || status === 0 && !bot.stopped) {
        bot.error = status ? Providers.parseError(status, raw) : '请求失败：没有收到响应';
      } else if (stream) {
        apply(parser.end());
        if (!gotDelta && raw.trim() && !bot.stopped) apply(Providers.parseFullResponse(p.type, raw)); // 服务端忽略了 stream
      } else if (!bot.stopped) {
        apply(Providers.parseFullResponse(p.type, raw));
      }
    }).catch(e => {
      bot.error = '网络错误：' + e.message + '\n请检查网络、Base URL 是否正确。';
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
    $('#input').value = ''; autosize(); renderHeader(); renderMessages();
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

  function stopGen() {
    if (!running) return;
    running.msg.stopped = true;
    running.cancel();
  }

  // ---------------- 输入区 ----------------
  const input = $('#input');
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight + 2, 160) + 'px'; }
  input.addEventListener('input', autosize);
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
    input.placeholder = imageMode ? '描述要生成的图片…（图片生成模式）' : '输入消息…';
    toast(imageMode ? '已切换到图片生成模式' : '已切换回聊天模式');
    if (imageMode && attachments.length) { attachments = []; renderAttachments(); }
  };
  function renderAttachments() {
    const box = $('#attach-preview'); box.innerHTML = '';
    attachments.forEach((src, i) => {
      const t = document.createElement('div'); t.className = 'thumb';
      t.innerHTML = '<img src="' + src + '"><button class="rm">×</button>';
      t.querySelector('.rm').onclick = () => { attachments.splice(i, 1); renderAttachments(); };
      box.appendChild(t);
    });
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
  const startNew = () => { if (running) { toast('请先停止当前生成'); return; } newConv(); closeDrawer(); };
  $('#btn-new').onclick = startNew;
  $('#drawer-new').onclick = startNew;
  $('#btn-settings').onclick = () => { closeDrawer(); openSettings(); };
  $('#conv-title').onclick = e => { e.stopPropagation(); if (conv.messages.length) renameConv(conv.id); else openSheet(); };
  $('#conv-model').onclick = e => { e.stopPropagation(); openSheet(); };

  // ---------------- 模型选择 ----------------
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
    conv.providerId = sheetPid; conv.model = $('#sheet-model').value.trim();
    conv.systemPrompt = $('#sheet-system').value;
    settings.lastProviderId = conv.providerId; settings.lastModel = conv.model; saveSettings();
    if (conv.messages.length) saveConv();
    renderHeader(); closeSheet();
  };

  // ---------------- 设置 ----------------
  function openSettings() {
    $('#set-system').value = settings.systemPrompt || '';
    $('#set-stream').checked = settings.stream !== false;
    $('#set-temp').value = settings.temperature || '';
    $('#set-maxtokens').value = settings.maxTokens || '';
    $('#set-imgsize').value = settings.imageSize || '';
    renderProviderList();
    $('#page-settings').classList.add('show');
  }
  function closeSettings() {
    settings.systemPrompt = $('#set-system').value;
    settings.stream = $('#set-stream').checked;
    settings.temperature = $('#set-temp').value.trim();
    settings.maxTokens = $('#set-maxtokens').value.trim();
    settings.imageSize = $('#set-imgsize').value.trim() || '1024x1024';
    saveSettings();
    $('#page-settings').classList.remove('show');
    if (!conv.providerId || !getProvider(conv.providerId)) {
      const p = configured()[0]; if (p) { conv.providerId = p.id; conv.model = p.models[0] || ''; }
    }
    renderAll();
  }
  ['#set-system', '#set-temp', '#set-maxtokens', '#set-imgsize'].forEach(s => $(s).addEventListener('change', () => {
    settings.systemPrompt = $('#set-system').value; settings.temperature = $('#set-temp').value.trim();
    settings.maxTokens = $('#set-maxtokens').value.trim(); settings.imageSize = $('#set-imgsize').value.trim() || '1024x1024'; saveSettings();
  }));
  $('#set-stream').onchange = () => { settings.stream = $('#set-stream').checked; saveSettings(); };
  function renderProviderList() {
    const box = $('#provider-list'); box.innerHTML = '';
    settings.providers.forEach(p => {
      const el = document.createElement('div'); el.className = 'prov-item';
      const ok = p.apiKey && p.apiKey.trim();
      el.innerHTML = '<div class="pi-main"><div class="pi-name">' + esc(p.name) + '</div><div class="pi-sub">' + esc(p.baseUrl) + '</div></div>' +
        '<span class="badge' + (ok ? ' ok' : '') + '">' + (ok ? '已配置' : '未配置') + '</span>';
      el.onclick = () => openProviderEdit(p.id);
      box.appendChild(el);
    });
  }
  $('#btn-add-provider').onclick = () => {
    const p = { id: uid(), presetId: 'custom', name: '自定义服务', type: 'openai', baseUrl: 'https://', apiKey: '', models: [''], imageModel: '', isNew: true };
    openProviderEdit(null, p);
  };
  $('#btn-clear-all').onclick = async () => {
    const ok = await dialog({ title: '删除全部对话', body: '将删除所有本地对话记录（API Key 设置保留）。', okText: '全部删除', danger: true });
    if (!ok) return;
    if (running) stopGen();
    convIndex.forEach(m => Store.del('conv_' + m.id + '.json'));
    convIndex = []; saveIndex(); newConv(); toast('已删除');
  };

  // ---------------- 服务商编辑 ----------------
  let editing = null;
  const baseHints = {
    openai: '填写到 /v1 这一级，程序会自动拼接 /chat/completions。例如 https://api.deepseek.com/v1',
    anthropic: '一般为 https://api.anthropic.com（程序拼接 /v1/messages）',
    gemini: '一般为 https://generativelanguage.googleapis.com/v1beta',
  };
  function openProviderEdit(id, fresh) {
    editing = fresh || Object.assign({}, getProvider(id));
    $('#pe-title').textContent = fresh ? '添加服务商' : '编辑服务商';
    $('#pe-name').value = editing.name;
    $('#pe-type').value = editing.type;
    $('#pe-base').value = editing.baseUrl;
    $('#pe-key').value = editing.apiKey || ''; $('#pe-key').type = 'password'; $('#pe-key-toggle').textContent = '显示';
    $('#pe-models').value = (editing.models || []).join('\n');
    $('#pe-imgmodel').value = editing.imageModel || '';
    $('#pe-base-hint').textContent = baseHints[editing.type];
    $('#pe-delete').style.display = fresh ? 'none' : '';
    $('#page-provider').classList.add('show');
  }
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
    const models = $('#pe-models').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!models.length) { toast('请至少填写一个模型名称'); return; }
    const p = { id: editing.id, presetId: editing.presetId, name: $('#pe-name').value.trim() || '未命名', type: $('#pe-type').value,
      baseUrl: base, apiKey: $('#pe-key').value.trim(), models, imageModel: $('#pe-imgmodel').value.trim() };
    const i = settings.providers.findIndex(x => x.id === p.id);
    if (i >= 0) settings.providers[i] = p; else settings.providers.push(p);
    saveSettings(); toast('已保存'); closeProviderEdit();
  };
  $('#pe-delete').onclick = async () => {
    const ok = await dialog({ title: '删除服务商', body: '确定删除「' + editing.name + '」及其 API Key 吗？', okText: '删除', danger: true });
    if (!ok) return;
    settings.providers = settings.providers.filter(x => x.id !== editing.id);
    if (editing.presetId && editing.presetId !== 'custom') settings.removedPresets = (settings.removedPresets || []).concat(editing.presetId);
    saveSettings(); closeProviderEdit();
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
    if ($('#viewer').classList.contains('show')) { closeViewer(); return true; }
    if ($('#dialog-mask').classList.contains('show')) { closeDialog(null); return true; }
    if ($('#sheet').classList.contains('show')) { closeSheet(); return true; }
    if ($('#page-provider').classList.contains('show')) { closeProviderEdit(); return true; }
    if ($('#page-settings').classList.contains('show')) { closeSettings(); return true; }
    if ($('#drawer').classList.contains('show')) { closeDrawer(); return true; }
    return false;
  };

  // ---------------- 启动 ----------------
  // 合并新增的预设（升级时）
  Providers.PRESETS.forEach(pr => {
    if (!settings.providers.some(p => p.presetId === pr.presetId) && !(settings.removedPresets || []).includes(pr.presetId) && pr.presetId !== 'custom') {
      settings.providers.push({ id: pr.presetId, presetId: pr.presetId, name: pr.name, type: pr.type, baseUrl: pr.baseUrl, apiKey: '', models: pr.models.slice(), imageModel: pr.imageModel || '' });
    }
  });
  if (convIndex.length) openConv(convIndex[0].id); else newConv();
  if (!conv) newConv();
})();
