/* AI Chat —— 前端逻辑 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const bridge = window.AndroidBridge || null;
  const APP_VERSION = '0.13.1';
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
    image: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><circle cx="9" cy="9.5" r="1.8"/><path d="M3.5 15.5l4.5-4 3.5 3.2 3-2.7 6 5.5"/></svg>',
  };
  const PROVIDER_COLORS = { openai: '#10a37f', deepseek: '#4d6bfe', qwen: '#615ced', 'qwen-intl': '#615ced', moonshot: '#16191e', zhipu: '#2f5bff',
    siliconflow: '#7c3aed', xiaomi: '#ff6900', openrouter: '#6467f2', anthropic: '#d97757', gemini: '#4285f4', custom: '#64748b' };
  function avatarHtml(p, cls) {
    const color = PROVIDER_COLORS[p && p.presetId] || PROVIDER_COLORS.custom;
    const ch = ((p && p.name) || '?').trim().charAt(0).toUpperCase();
    return '<span class="avatar ' + (cls || '') + '" style="background:' + color + '">' + esc(ch) + '</span>';
  }

  // ---------------- 存储 ----------------
  // v0.9.0：读取到损坏的 JSON 时不再静默用默认值覆盖——先把坏文件改名为 name.corrupt-<时间戳> 保留，
  // 再尝试用上一次成功写入留下的 name.bak 恢复；原生层写入为「写临时文件 → 旧文件转 .bak → 改名」。
  const storeIssues = []; // [{ name, restored: 'bak'|'' , corrupt }]
  const lsKey = n => 'aichat_' + n;
  const Store = {
    raw(name) { return bridge ? bridge.storeGet(name) : localStorage.getItem(lsKey(name)); },
    exists(name) {
      if (bridge && bridge.storeExists) return !!bridge.storeExists(name);
      const v = this.raw(name); return v != null;
    },
    rename(from, to) {
      if (bridge && bridge.storeRename) return !!bridge.storeRename(from, to);
      const v = this.raw(from); if (v == null) return false;
      if (bridge) { if (!bridge.storeSet(to, v)) return false; bridge.storeDelete(from); return true; }
      localStorage.setItem(lsKey(to), v); localStorage.removeItem(lsKey(from)); return true;
    },
    list() {
      if (bridge && bridge.storeList) { try { return JSON.parse(bridge.storeList() || '[]'); } catch (e) { return []; } }
      if (bridge) return [];
      const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('aichat_')) out.push(k.slice(7)); }
      return out;
    },
    get(name, def) {
      let v;
      try { v = this.raw(name); } catch (e) { return def; }
      if (v == null) return def;
      try { return JSON.parse(v); } catch (e) {
        const corrupt = Secure.corruptName(name);
        try { this.rename(name, corrupt); } catch (_) {}
        let restored = '', val = def;
        try {
          const b = this.raw(name + '.bak');
          if (b != null) { val = JSON.parse(b); restored = 'bak'; this.rawSet(name, b); }
        } catch (_) { val = def; restored = ''; }
        storeIssues.push({ name, restored, corrupt });
        console.warn('[store] 损坏的文件已改名为 ' + corrupt + (restored ? '，已从 .bak 恢复' : ''));
        return val;
      }
    },
    rawSet(name, s) { if (bridge) return bridge.storeSet(name, s); localStorage.setItem(lsKey(name), s); return true; },
    set(name, val) { return this.rawSet(name, JSON.stringify(val)); },
    del(name) { if (bridge) bridge.storeDelete(name); else localStorage.removeItem(lsKey(name)); },
    /** 追加一行（JSONL）。原生层是追加写，不会重写整个文件 */
    append(name, obj) {
      const line = JSON.stringify(obj) + '\n';
      if (bridge && bridge.storeAppend) return bridge.storeAppend(name, line);
      const cur = this.raw(name) || ''; return this.rawSet(name, cur + line);
    },
    readJsonl(name) { const v = this.raw(name); return v == null ? null : Secure.parseJsonl(v).items; },
    writeJsonl(name, items) { return this.rawSet(name, Secure.toJsonl(items)); },
  };

  // ---------------- 密钥（v0.9.0：只存在原生安全存储，页面读不到明文） ----------------
  const Secrets = (function () {
    const native = !!(bridge && bridge.setSecret);
    // 浏览器调试回退（无原生桥）：仅用于开发 / 自动化测试
    const reg = {}; const sk = (kind, id) => 'aichat_secret:' + kind + ':' + id;
    return {
      native,
      has(kind, id) { return native ? !!bridge.hasSecret(kind, id) : !!localStorage.getItem(sk(kind, id)); },
      set(kind, id, value) { return native ? !!bridge.setSecret(kind, id, value) : (localStorage.setItem(sk(kind, id), value), true); },
      del(kind, id) { if (native) bridge.deleteSecret(kind, id); else localStorage.removeItem(sk(kind, id)); },
      clear() { if (native) bridge.clearSecrets(); else Object.keys(localStorage).filter(k => k.startsWith('aichat_secret:')).forEach(k => localStorage.removeItem(k)); },
      /** 登记服务商的 Base URL 与认证方式；返回 'cleared' 表示主机变了、原密钥已被原生层清除 */
      register(id, baseUrl, authType) {
        if (native) return bridge.registerProvider(id, baseUrl || '', authType || 'bearer') || 'ok';
        const old = reg[id]; reg[id] = { baseUrl, authType };
        if (old && Secure.originOf(old.baseUrl) !== Secure.originOf(baseUrl)) {
          const kind = id.startsWith('search:') ? 'search_key' : 'provider_key', kid = id.startsWith('search:') ? id.slice(7) : id;
          if (localStorage.getItem(sk(kind, kid))) { localStorage.removeItem(sk(kind, kid)); return 'cleared'; }
        }
        return 'ok';
      },
      /** 仅浏览器回退：按登记信息注入认证头 */
      _inject(req) {
        const r = reg[req.auth]; if (!r) throw new Error('服务商未登记');
        if (!Secure.isUrlAllowed(req.url, r.baseUrl)) throw new Error('请求地址与服务商 Base URL 不一致，已拒绝');
        const kind = req.auth.startsWith('search:') ? 'search_key' : 'provider_key', kid = req.auth.startsWith('search:') ? req.auth.slice(7) : req.auth;
        const key = localStorage.getItem(sk(kind, kid)); const h = Secure.stripAuthHeaders(req.headers);
        if (key) {
          if (r.authType === 'anthropic') h['x-api-key'] = key;
          else if (r.authType === 'gemini') h['x-goog-api-key'] = key;
          else if (r.authType === 'brave') h['X-Subscription-Token'] = key;
          else h['Authorization'] = 'Bearer ' + key;
        }
        return Object.assign({}, req, { headers: h });
      },
    };
  })();
  /** 输入框里代表「已保存的密钥」的占位值：保持不变 = 不改；清空 = 删除；输入新值 = 替换 */
  const KEY_MASK = '••••••••（已保存）';
  const hasKey = p => !!(p && (p.hasKey || String(p.apiKey || '').trim()));
  /** 标记请求使用哪个服务商的已存密钥（providerId；搜索为 'search:<id>'） */
  const authed = (req, id) => (req && id ? Object.assign(req, { auth: id }) : req);

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
        if (req.auth && bridge.requestForProvider) {
          bridge.requestForProvider(id, req.auth, req.method, req.url, JSON.stringify(Secure.stripAuthHeaders(req.headers)), req.body || '', 600);
        } else {
          if (req.auth) { try { req = Secrets._inject(req); } catch (e) { setTimeout(() => window.__nativeHttp.onError(id, e.message), 0); return; } } // 旧版原生桥（无安全存储）
          bridge.request(id, req.method, req.url, JSON.stringify(req.headers || {}), req.body || '', 600);
        }
        cancel = () => bridge.cancel(id);
      } else { // 浏览器调试回退（会受 CORS 限制）
        if (req.auth) { try { req = Secrets._inject(req); } catch (e) { setTimeout(() => window.__nativeHttp.onError(id, e.message), 0); return; } }
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
    models: p.models.slice(), imageModel: p.imageModel || '', videoModel: p.videoModel || '',
    embeddingModel: p.embeddingModel || '', speechModel: p.speechModel || '', transcriptionModel: p.transcriptionModel || '' });
  const defaultSettings = () => ({
    providers: Providers.PRESETS.map(presetToProvider),
    systemPrompt: '', stream: true, temperature: '', maxTokens: '', imageSize: '1024x1024',
    imageGenProviderId: '', imageGenModel: '',
    lastProviderId: '', lastModel: '', settingsVersion: Providers.SETTINGS_VERSION,
    search: defaultSearch(), searchOn: false, removedPersonas: [],
  });
  function defaultSearch() { return { provider: 'tavily', hasKeys: {}, urls: {}, count: 5, rewrite: false }; }
  const stored = Store.get('settings.json', null);
  let settings = stored ? Object.assign(defaultSettings(), { settingsVersion: 1 }, stored) : defaultSettings();
  // v0.8.4：首条消息自动生成角色卡默认改为「直接生成」；旧版默认的「先询问」迁移一次（关闭的保持关闭）
  if (!settings.autoCharV084) { if (!settings.autoCharMode || settings.autoCharMode === 'ask') settings.autoCharMode = 'auto'; settings.autoCharV084 = true; }
  let convIndex = loadConvIndex(); // [{id,title,providerId,model,updatedAt}]
  /** v0.9.0：convs.json 损坏 / 丢失但还有 conv_*.json 时，扫描对话文件重建索引 */
  function loadConvIndex() {
    const idx = Store.get('convs.json', null);
    if (Array.isArray(idx)) return idx;
    const files = Store.list().filter(n => /^conv_[^/]+\.json$/.test(n));
    if (!files.length) return [];
    const rebuilt = Secure.rebuildIndex(files.map(n => Store.get(n, null)));
    Store.set('convs.json', rebuilt);
    storeIssues.push({ name: 'convs.json', restored: 'rebuild', count: rebuilt.length });
    console.warn('[store] 已从 ' + files.length + ' 个对话文件重建 convs.json');
    return rebuilt;
  }
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
  // 全局 Token 用量统计（非插件，独立页面）
  // v0.9.0：用量明细改为追加式 usage-stats.jsonl（每条一行），价格等元数据放 usage-stats-meta.json
  const USAGE_LOG = 'usage-stats.jsonl', USAGE_META = 'usage-stats-meta.json';
  let usageState = loadUsageStats();
  function loadUsageStats() {
    const meta = Store.get(USAGE_META, null);
    if (!meta) {
      const old = Store.get('usage-stats.json', null);
      const st = UsageStats.normalize(old);
      if (old) { // 旧版整文件 JSON → 迁移一次，旧文件改名保留
        if (Store.writeJsonl(USAGE_LOG, st.log) !== false && Store.set(USAGE_META, usageMetaOf(st)) !== false) Store.rename('usage-stats.json', 'usage-stats.json.migrated');
      }
      return st;
    }
    const items = Store.readJsonl(USAGE_LOG) || [];
    const seen = new Set(), log = [];
    items.forEach(e => { if (e && e.key && !seen.has(e.key)) { seen.add(e.key); log.push(e); } });
    const st = UsageStats.normalize(Object.assign({}, meta, { log: log.slice(-UsageStats.LOG_LIMIT) }));
    if (items.length > Math.max(UsageStats.LOG_LIMIT, log.length) * 1.2 || items.length - log.length > 200) Store.writeJsonl(USAGE_LOG, st.log); // 压缩
    return st;
  }
  function usageMetaOf(st) { return { version: st.version, backfilled: st.backfilled, prices: st.prices, priceMode: st.priceMode }; }
  // 若 RP 插件里改过价格，合并过来（用户只改一处）
  (function syncPricesFromRp() {
    const rp = settings.plugins && settings.plugins.rpcache && settings.plugins.rpcache.prices;
    if (rp) usageState.prices = Object.assign({}, usageState.prices, rp);
    if (settings.plugins && settings.plugins.rpcache && settings.plugins.rpcache.priceMode)
      usageState.priceMode = settings.plugins.rpcache.priceMode;
  })();
  const saveUsageMeta = () => Store.set(USAGE_META, usageMetaOf(usageState));
  /** 整体重写（清空 / 回填时用）；平时新增一条只追加一行 */
  const saveUsageStats = () => { Store.writeJsonl(USAGE_LOG, usageState.log); saveUsageMeta(); };
  const saveSettings = () => Store.set('settings.json', settings);
  const saveIndex = () => Store.set('convs.json', convIndex);
  function saveConv(c, touch) {
    c = c || conv; if (!c) return;
    if (touch !== false) c.updatedAt = Date.now();
    Store.set('conv_' + c.id + '.json', c);
    const meta = { id: c.id, title: c.title, providerId: c.providerId, model: c.model, updatedAt: c.updatedAt };
    if (c.personaName) { meta.personaName = c.personaName; meta.personaEmoji = c.personaEmoji; }
    const i = convIndex.findIndex(x => x.id === c.id);
    if (i >= 0 && JSON.stringify(convIndex[i]) === JSON.stringify(meta)) return; // v0.7.5：索引没变化就不重写
    if (i >= 0) convIndex[i] = meta; else convIndex.unshift(meta);
    convIndex.sort((a, b) => b.updatedAt - a.updatedAt);
    saveIndex();
  }
  /** v0.7.5：插件后台写入（提取设定、统计等）合并为约 500ms 一次；切到后台 / 关闭时立即写盘 */
  const pendingSaves = new Map(); let saveTimer = null;
  function flushSaves() { clearTimeout(saveTimer); saveTimer = null; const list = Array.from(pendingSaves.values()); pendingSaves.clear(); list.forEach(c => saveConv(c, false)); }
  function saveConvSoon(c) { if (!c) return; pendingSaves.set(c.id, c); if (!saveTimer) saveTimer = setTimeout(flushSaves, 500); }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSaves(); });
  window.addEventListener('pagehide', flushSaves);
  const getProvider = id => settings.providers.find(p => p.id === id);
  const configured = () => settings.providers.filter(hasKey);

  // ---------------- 升级迁移（不改 API Key） ----------------
  (function migrate() {
    (settings.providers || []).forEach(Providers.normalizeModelFields); // 0.6.3：补齐模型分类字段（缺失 = ''）
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


  // ---------------- v0.9.0：API Key 迁入原生安全存储 ----------------
  const providerAuth = p => Secure.authTypeFor('provider_key', p.type);
  function registerProvider(p) { return Secrets.register(p.id, p.baseUrl, providerAuth(p)); }
  const searchBase = id => ((settings.search.urls || {})[id] || Search.DEFAULT_BASE[id] || '');
  function registerSearch(id) { return Secrets.register('search:' + id, searchBase(id), Secure.authTypeFor('search_key', id)); }
  function refreshKeyFlags() {
    settings.providers.forEach(p => { p.hasKey = Secrets.has('provider_key', p.id); });
    const hk = {}; Search.SEARCH_PROVIDERS.forEach(x => { if (Secrets.has('search_key', x.id)) hk[x.id] = true; });
    settings.search.hasKeys = hk;
  }
  (function migrateSecrets() {
    settings.providers.forEach(registerProvider);
    Search.SEARCH_PROVIDERS.forEach(x => registerSearch(x.id));
    const r = Secure.stripSecrets(settings);
    let ok = true;
    r.secrets.forEach(x => { if (!Secrets.set(x.kind, x.id, x.value)) ok = false; });
    refreshKeyFlags();
    if (r.changed && ok) { saveSettings(); if (r.secrets.length) console.log('[secrets] 已迁移 ' + r.secrets.length + ' 个密钥到安全存储'); }
    else if (r.changed) console.warn('[secrets] 部分密钥写入安全存储失败，settings.json 暂不改写');
  })();

  // ---------------- 工具 ----------------
  let toastTimer;
  /** actions（v0.7.5）：[{ label, onClick }]，带按钮的提示停留更久 */
  function toast(t, actions) {
    const el = $('#toast'); el.textContent = t; el.classList.toggle('has-actions', !!(actions && actions.length));
    (actions || []).forEach(a => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-act'; b.textContent = a.label;
      b.onclick = e => { e.stopPropagation(); el.classList.remove('show'); clearTimeout(toastTimer); try { a.onClick(); } catch (err) { console.error(err); } };
      el.appendChild(b);
    });
    el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), actions && actions.length ? 6000 : 1900);
  }
  function openUrl(u) {
    if (!/^https?:\/\//i.test(u || '')) return;
    if (bridge && bridge.openUrl) bridge.openUrl(u); else window.open(u, '_blank', 'noopener');
  }
  function copyText(t) { if (bridge) bridge.copy(t); else navigator.clipboard && navigator.clipboard.writeText(t).catch(() => {}); toast('已复制'); }

  /** 记录一次带 usage 的请求（对话 / 图片 / 摘要）。无 usage 或无输入则忽略。 */
  function recordUsage(opts) {
    opts = opts || {};
    const u = opts.usage;
    if (!u || u.prompt == null) return;
    const c = opts.conv || conv;
    const p = opts.provider || (c && getProvider(c.providerId));
    const entry = UsageStats.makeEntry({
      usage: u, at: opts.at || Date.now(), type: opts.type || 'chat',
      model: opts.model || (c && c.model) || '',
      providerId: (p && (p.presetId || p.id)) || (c && c.providerId) || '',
      providerName: (p && p.name) || '',
      convId: c && c.id || '', convTitle: c && c.title || '',
      msgId: opts.msgId || '', key: opts.key,
    });
    const before = usageState.log.length, last = usageState.log[before - 1];
    usageState = UsageStats.record(usageState, entry);
    const added = usageState.log[usageState.log.length - 1];
    if (added && added !== last && added.key === entry.key) { if (!Store.exists(USAGE_META)) saveUsageMeta(); Store.append(USAGE_LOG, added); }
    updateUsageSubtitle();
  }
  function updateUsageSubtitle() {
    const today = UsageStats.filterLog(usageState.log, UsageStats.rangeOf('today'));
    const t = UsageStats.sumList(today);
    const el = $('#usage-count');
    if (!el) return;
    if (!t.requests) { el.textContent = 'Token 统计'; return; }
    const fmt = n => n >= 1e4 ? (n / 1e4).toFixed(n >= 1e5 ? 1 : 2).replace(/\.?0+$/, '') + '万' : String(Math.round(n));
    el.textContent = '今日 ' + fmt(t.total);
    const sub = $('#set-usage-sub');
    if (sub) {
      const all = UsageStats.sumList(usageState.log);
      sub.textContent = '累计 ' + fmt(all.total) + ' Token · ' + all.requests + ' 次请求';
    }
  }
  function backfillUsageStats() {
    if (usageState.backfilled) { updateUsageSubtitle(); return; }
    const convs = convIndex.map(meta => {
      const c = Store.get('conv_' + meta.id + '.json', null) || meta;
      const p = getProvider(c.providerId);
      return {
        id: c.id, title: c.title, providerId: c.providerId,
        providerName: p ? p.name : '', model: c.model, updatedAt: c.updatedAt, messages: c.messages || [],
      };
    });
    usageState = UsageStats.backfill(usageState, convs);
    saveUsageStats();
    updateUsageSubtitle();
  }

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

  // ---------------- 全屏文本编辑器 ----------------
  // 高度跟随 visualViewport（Android adjustResize 下键盘弹出时 WebView 变矮，visualViewport 同步变化），底部按钮始终在键盘上方
  const vv = window.visualViewport;
  function syncViewport() {
    const h = vv ? vv.height : window.innerHeight, top = vv ? vv.offsetTop : 0;
    const root = document.documentElement.style;
    root.setProperty('--vvh', Math.round(h) + 'px'); root.setProperty('--vv-top', Math.round(top) + 'px');
    // 键盘：可视高度明显小于布局高度（未开 adjustResize 时），或比初始高度小 150px 以上（adjustResize）
    const kb = (window.innerHeight - h > 120) || (fullH - h > 150);
    document.body.classList.toggle('kb-open', kb);
    const ta = $('#ed-text');
    if (ta && edState && document.activeElement === ta) keepCaretVisible(ta);
  }
  let fullH = window.innerHeight;
  window.addEventListener('orientationchange', () => setTimeout(() => { fullH = window.innerHeight; syncViewport(); }, 300));
  if (vv) { vv.addEventListener('resize', syncViewport); vv.addEventListener('scroll', syncViewport); }
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    // 宽度变化（旋转 / 分屏）时重新记录「无键盘」高度；宽度不变时只会因键盘变矮
    if (window.innerWidth !== lastW) { lastW = window.innerWidth; fullH = window.innerHeight; } else if (window.innerHeight > fullH) fullH = window.innerHeight;
    syncViewport();
  });
  /** 光标在末尾附近时，把它滚到可见区域（键盘弹出后 textarea 变矮） */
  function keepCaretVisible(ta) {
    const tail = ta.value.length - ta.selectionEnd;
    if (tail < 40) ta.scrollTop = ta.scrollHeight;
  }
  const charCount = t => Array.from(t).length;
  let edState = null;
  /**
   * 打开全屏编辑器。
   * actions: [{ key, text, primary }]；返回 Promise<{ key, text } | null>（null = 取消）
   */
  function openEditor({ title, value, hint, warn, placeholder, actions }) {
    const ta = $('#ed-text');
    $('#ed-title').textContent = title || '编辑';
    const h = $('#ed-hint'); h.textContent = hint || ''; h.classList.toggle('warn', !!warn);
    ta.placeholder = placeholder || '';
    ta.value = value || '';
    const bar = $('#ed-bar'); bar.innerHTML = '';
    const cancel = document.createElement('button'); cancel.className = 'pill-btn ghost'; cancel.id = 'ed-cancel'; cancel.textContent = '取消';
    cancel.onclick = () => closeEditor(null); bar.appendChild(cancel);
    (actions || [{ key: 'ok', text: '完成', primary: true }]).forEach(a => {
      const b = document.createElement('button'); b.className = 'pill-btn ' + (a.primary ? 'primary' : ''); b.dataset.key = a.key; b.id = 'ed-' + a.key; b.textContent = a.text;
      b.onclick = () => closeEditor({ key: a.key, text: ta.value });
      bar.appendChild(b);
    });
    syncViewport();
    $('#editor').classList.add('show');
    edCount();
    // 在用户点击的同一调用栈里聚焦，Android WebView 才会弹出键盘；光标放到末尾
    ta.focus({ preventScroll: true });
    const n = ta.value.length; ta.setSelectionRange(n, n); ta.scrollTop = ta.scrollHeight;
    return new Promise(res => { edState = { res, orig: ta.value }; });
  }
  function edCount() {
    const t = $('#ed-text').value, c = $('#ed-count');
    c.textContent = charCount(t) + ' 字';
    c.classList.toggle('dirty', !!edState && t !== edState.orig);
  }
  $('#ed-text').addEventListener('input', edCount);
  async function closeEditor(result, force) {
    if (!edState) return;
    if (!result && !force && $('#ed-text').value !== edState.orig) {
      if (!(await dialog({ title: '放弃修改？', body: '编辑的内容不会保存。', okText: '放弃', danger: true }))) return;
    }
    const r = edState.res; edState = null;
    $('#ed-text').blur();
    $('#editor').classList.remove('show');
    r(result);
  }
  $('#ed-close').onclick = () => closeEditor(null);
  syncViewport();
  /** 给长文本框加一个「全屏编辑」按钮（写回后触发 input / change 事件） */
  const EXPAND_ICON = '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
  function expandTextarea(ta, title, hintFn) {
    if (!ta || ta.dataset.expand) return;
    ta.dataset.expand = '1';
    const wrap = document.createElement('div'); wrap.className = 'ta-wrap';
    ta.parentNode.insertBefore(wrap, ta); wrap.appendChild(ta);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ta-expand'; b.setAttribute('aria-label', '全屏编辑'); b.title = '全屏编辑'; b.innerHTML = EXPAND_ICON;
    b.onclick = async e => {
      e.preventDefault(); e.stopPropagation();
      const r = await openEditor({ title: typeof title === 'function' ? title() : title, value: ta.value, hint: hintFn ? hintFn() : '', placeholder: ta.placeholder });
      if (!r) return;
      ta.value = r.text;
      ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
    };
    wrap.appendChild(b);
  }

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
  // Markdown 渲染 LRU 缓存（流式输出不读写缓存）
  const MD_CACHE_MAX = 80, HL_CACHE_MAX = 300, MD_CACHE_TEXT_MAX = 20000;
  const mdHtmlCache = new Map(), hlCache = new Map();
  function lruGet(map, k) { if (!map.has(k)) return undefined; const v = map.get(k); map.delete(k); map.set(k, v); return v; }
  function lruSet(map, k, v, max) { if (map.has(k)) map.delete(k); map.set(k, v); while (map.size > max) map.delete(map.keys().next().value); }
  let streamHeadCache = null; // { src, html, codes } 只保留一条（当前正在流式的消息）
  function renderMarkdown(text, sources, opts) {
    const streaming = !!(opts && opts.streaming);
    const src = text || '';
    const cacheable = !streaming && src.length <= MD_CACHE_TEXT_MAX;
    const div = document.createElement('div');
    div.className = 'md';
    let html = cacheable ? lruGet(mdHtmlCache, src) : undefined;
    let stableCodes = 0; // 流式时，前面已稳定部分的代码块数量（这些块可以走高亮缓存）
    if (html === undefined && streaming) {
      // v0.9.0：流式增量渲染——在稳定边界处切开，前半段复用上次结果，只重新解析尾部
      const sp = Secure.splitStableMarkdown(src);
      if (sp.head) {
        if (!streamHeadCache || streamHeadCache.src !== sp.head) {
          const h = DOMPurify.sanitize(marked.parse(sp.head));
          streamHeadCache = { src: sp.head, html: h, codes: (h.match(/<pre[\s>]/g) || []).length };
        }
        html = streamHeadCache.html + DOMPurify.sanitize(marked.parse(sp.tail));
        stableCodes = streamHeadCache.codes;
      } else html = DOMPurify.sanitize(marked.parse(src));
    }
    if (html === undefined) { html = DOMPurify.sanitize(marked.parse(src)); if (cacheable) lruSet(mdHtmlCache, src, html, MD_CACHE_MAX); }
    div.innerHTML = html;
    let codeIdx = 0;
    linkCitations(div, sources);
    div.querySelectorAll('pre > code').forEach(code => {
      const pre = code.parentElement; codeIdx++;
      const m = /language-([\w+#.-]+)/.exec(code.className || '');
      const lang = m ? m[1] : '';
      const raw = code.textContent;
      try {
        const known = !!(lang && hljs.getLanguage(lang));
        const stable = cacheable || codeIdx <= stableCodes;
        const hk = stable && raw.length <= MD_CACHE_TEXT_MAX ? (lang || '') + '\u0000' + raw : null;
        let hl = hk ? lruGet(hlCache, hk) : undefined;
        if (hl === undefined) {
          if (known) hl = hljs.highlight(raw, { language: lang, ignoreIllegals: true }).value;
          else if (!streaming && raw.length < 20000) hl = hljs.highlightAuto(raw).value;
          else hl = null;
          if (hk && hl !== null) lruSet(hlCache, hk, hl, HL_CACHE_MAX);
        }
        if (hl !== null) { code.innerHTML = hl; code.classList.add('hljs'); }
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
    const pid = hasKey(lp) ? lp.id : ((configured()[0] || {}).id || '');
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
    conv = Versions.normalizeConv(c); renderAll(); return true;
  }
  async function deleteConv(id) {
    const meta = convIndex.find(x => x.id === id);
    const ok = await dialog({ title: '删除对话？', body: '「' + (meta ? meta.title : '') + '」将被永久删除。', okText: '删除', danger: true });
    if (!ok) return;
    if (running && conv && conv.id === id) stopGen();
    pendingSaves.delete(id); Store.del('conv_' + id + '.json'); Store.del('rplog_' + id + '.json'); Store.del('rplog_' + id + '.jsonl');
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
    const ok = hasKey(p);
    $('#mp-model').textContent = ok ? (conv.model || '未设置模型') : (configured().length ? '选择模型' : '未配置服务商');
    $('#mp-provider').textContent = ok ? (conv.personaName ? conv.personaEmoji + ' ' + conv.personaName + ' · ' + p.name : p.name) : (configured().length ? '点此切换' : '点此添加 API Key');
    const dot = $('#mp-dot');
    dot.style.background = ok ? (PROVIDER_COLORS[p.presetId] || PROVIDER_COLORS.custom) : '';
    dot.textContent = ok ? p.name.trim().charAt(0).toUpperCase() : '';
    const sub = document.querySelector('.brand-sub');
    if (sub) {
      if (ok && conv.model) sub.textContent = (p.name || '多模型') + ' · ' + conv.model;
      else if (ok) sub.textContent = (p.name || '多模型') + ' · 文字生成';
      else sub.textContent = '文字生成 · 多模型';
    }
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
    { t: '写一份周报', d: '总结本周工作与下周计划', p: '帮我写一份简洁专业的周报，包含本周完成事项、进行中事项和下周计划，用条目列出。' },
    { t: '解释这段代码', d: '用通俗语言讲清逻辑', p: '请用通俗易懂的方式解释下面这段代码在做什么，并指出关键逻辑（我会接着粘贴代码）：' },
    { t: '翻译成英文', d: '自然、地道的英文表达', p: '把下面内容翻译成自然、地道的英文，保留专业术语：' },
    { t: '旅行规划', d: '制定三天两晚的行程', p: '帮我规划一个杭州三天两晚的旅行行程，包含美食推荐。' },
  ];
  // ---- 虚拟滚动：长列表只渲染可视区；流式仍走 updateMsg 定点 patch ----
  const VS_EST = 140;           // 未实测前的预估高度
  const VS_OVERSCAN = 2;        // 上下各多渲几条
  const vsHeight = new Map();   // msgId → 实测高度
  let vsScrollBound = false;
  let vsRaf = 0;
  let vsLastRange = { start: -1, end: -1, empty: true };
  function vsEstimate(m) {
    if (m && m.id && vsHeight.has(m.id)) return vsHeight.get(m.id);
    const len = ((m && m.content) || '').length + ((m && m.reasoning) || '').length;
    return Math.min(1200, Math.max(72, VS_EST + Math.floor(len / 80) * 18));
  }
  function vsMeasure(el, m) {
    if (!el || !m || !m.id) return;
    const h = el.offsetHeight;
    if (h > 0) vsHeight.set(m.id, h);
  }
  function vsTotalHeight(list) {
    let t = 0; for (let i = 0; i < list.length; i++) t += vsEstimate(list[i]); return t;
  }
  function vsFindStart(list, scrollTop) {
    let acc = 0;
    for (let i = 0; i < list.length; i++) {
      const h = vsEstimate(list[i]);
      if (acc + h > scrollTop) return i;
      acc += h;
    }
    return Math.max(0, list.length - 1);
  }
  function renderEmptyState(box) {
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
    empty.innerHTML = '<div class="hero-icon"><img class="hero-logo" src="logo.svg" alt=""></div><h1>你好，我是 AI Chat</h1>' +
      (has ? '<p class="sub">专注高质量文字生成。支持插件扩展能力。</p><div class="suggest"></div>' +
        '<div class="persona-strip-head"><span>从助手开始</span><button class="link-btn" id="empty-all-personas">全部 ›</button></div><div class="persona-strip"></div>'
           : '<p class="sub">一个应用，连接多家 AI 服务。支持插件扩展能力。</p><div class="setup-card"><b>开始之前</b><ol><li>打开设置，选择一个服务商</li><li>粘贴你的 API Key 并保存</li><li>回到这里，点顶部切换模型即可聊天</li></ol><button class="pill-btn primary" id="empty-setup" style="width:100%">去设置 API Key</button></div>');
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
  }
  function renderMessages(opts) {
    opts = opts || {};
    const box = $('#messages');
    const stick = opts.stickBottom != null ? opts.stickBottom : true;
    if (!vsScrollBound) {
      vsScrollBound = true;
      box.addEventListener('scroll', () => {
        $('.main-top').classList.toggle('scrolled', box.scrollTop > 4);
        if (!conv.messages.length) return;
        if (vsRaf) return;
        vsRaf = requestAnimationFrame(() => { vsRaf = 0; renderMessages({ stickBottom: false, fromScroll: true }); });
      }, { passive: true });
    }
    if (!conv.messages.length) {
      box.innerHTML = '';
      vsLastRange = { start: -1, end: -1, empty: true };
      renderEmptyState(box);
      return;
    }
    const list = conv.messages;
    // 短列表：直接全量（开销更小，也避免 spacer 抖动）
    if (list.length <= 40) {
      if (vsLastRange.empty || vsLastRange.start !== 0 || vsLastRange.end !== list.length || opts.force) {
        const keepScroll = box.scrollTop;
        box.innerHTML = '';
        list.forEach(m => { const el = buildMsgEl(m); box.appendChild(el); vsMeasure(el, m); });
        vsLastRange = { start: 0, end: list.length, empty: false };
        if (stick) box.scrollTop = box.scrollHeight;
        else box.scrollTop = keepScroll;
      } else if (stick) box.scrollTop = box.scrollHeight;
      return;
    }
    const viewH = box.clientHeight || 600;
    const scrollTop = box.scrollTop;
    const heights = list.map(vsEstimate);
    const hasWin = !!box.querySelector(':scope > .vs-window');
    // 滞回：滚动触发时，已渲染窗口仍覆盖视口+余量就不重建（v0.13.0 每次 range 变化都重建，向上滑时反复重排）
    if (opts.fromScroll && !opts.force && hasWin && VScroll.windowCovers(vsLastRange, heights, scrollTop, viewH)) return;
    const { start, end, topH, bottomH } = VScroll.computeRange(heights, scrollTop, viewH, VS_OVERSCAN);
    // 范围未变且非强制：跳过 DOM 重建（流式靠 updateMsg）
    if (!opts.force && !vsLastRange.empty && vsLastRange.start === start && vsLastRange.end === end && hasWin) {
      if (stick) box.scrollTop = box.scrollHeight;
      return;
    }
    const prevStick = stick || (box.scrollHeight - box.scrollTop - box.clientHeight < 140);
    // 锚点：记录重渲染前首个可见消息相对视口的偏移
    const boxTop = box.getBoundingClientRect().top;
    let anchorId = null, anchorOffset = 0;
    if (!prevStick && hasWin) {
      const visible = box.querySelectorAll('.vs-window > .msg');
      for (let i = 0; i < visible.length; i++) {
        const r = visible[i].getBoundingClientRect();
        if (r.bottom > boxTop + 1) { anchorId = visible[i].dataset.id; anchorOffset = r.top - boxTop; break; }
      }
    }
    // 不再 innerHTML='' 整体清空：复用 spacer 与已存在的消息节点（图片不重载、不露背景闪黑）
    let topSp = box.querySelector(':scope > .vs-top'), win = box.querySelector(':scope > .vs-window'), botSp = box.querySelector(':scope > .vs-bot');
    const reuse = new Map();
    if (!topSp || !win || !botSp) {
      box.innerHTML = '';
      topSp = document.createElement('div'); topSp.className = 'vs-spacer vs-top';
      win = document.createElement('div'); win.className = 'vs-window';
      botSp = document.createElement('div'); botSp.className = 'vs-spacer vs-bot';
      box.appendChild(topSp); box.appendChild(win); box.appendChild(botSp);
    } else if (!opts.force) {
      win.querySelectorAll(':scope > .msg').forEach(el => reuse.set(el.dataset.id, el));
    }
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.appendChild(reuse.get(list[i].id) || buildMsgEl(list[i]));
    win.replaceChildren(frag);
    // 实测窗口内高度；spacer 只依赖窗口外高度，实测不应改变它（旧版在此「重算」导致向上滑时 spacer 突变）
    win.querySelectorAll(':scope > .msg').forEach((el, j) => vsMeasure(el, list[start + j]));
    topSp.style.height = topH + 'px';
    botSp.style.height = bottomH + 'px';
    vsLastRange = { start, end, empty: false };
    if (prevStick) box.scrollTop = box.scrollHeight;
    else if (anchorId) {
      let el2 = null;
      win.querySelectorAll(':scope > .msg').forEach(el => { if (!el2 && el.dataset.id === anchorId) el2 = el; });
      if (el2) {
        const delta = (el2.getBoundingClientRect().top - box.getBoundingClientRect().top) - anchorOffset;
        if (isFinite(delta) && Math.abs(delta) >= 1) box.scrollTop = box.scrollTop + delta;
      }
    }
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
    let botCol = null;
    if (m.role === 'assistant') {
      const row = document.createElement('div'); row.className = 'bot-row';
      const avWrap = document.createElement('div'); avWrap.className = 'bot-avatar-wrap';
      const pe = m.personaEmoji || (!m.imageGen && conv.personaEmoji);
      const pn = m.personaName || (!m.imageGen && conv.personaName);
      avWrap.innerHTML = pe ? '<span class="bot-avatar emoji">' + esc(pe) + '</span>' : '<img class="bot-avatar" src="logo.svg" alt="">';
      botCol = document.createElement('div'); botCol.className = 'bot-col';
      const head = document.createElement('div'); head.className = 'bot-head';
      head.innerHTML = '<span class="bot-name">' + (pn ? '<b>' + esc(pn) + '</b> · ' : '') + esc(m.model || 'AI') + (m.stopped ? ' · 已停止' : '') + '</span>';
      if (!m.pending) Plugins.registry.messageBadges(m, settings, conv, pluginHost).forEach(b => {
        const bd = document.createElement('button'); bd.className = 'mbadge tone-' + (b.tone || 'info'); bd.textContent = b.text; if (b.title) bd.title = b.title;
        if (b.action) bd.onclick = e => { e.stopPropagation(); b.action(); };
        head.appendChild(bd);
      });
      botCol.appendChild(head);
      row.appendChild(avWrap); row.appendChild(botCol);
      el.appendChild(row);
    }
    const attachTarget = botCol || el;
    if (m.files && m.files.length) attachTarget.appendChild(buildFileChips(m.files));
    if (m.images && m.images.length) {
      const imgs = document.createElement('div'); imgs.className = 'msg-images';
      m.images.forEach(src => { const i = document.createElement('img'); i.src = src; i.onclick = () => openViewer(src); imgs.appendChild(i); });
      attachTarget.appendChild(imgs);
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
      if (m.content) { const md = renderMarkdown(m.content, m.sources, { streaming: !!m.pending }); if (m.pending) md.classList.add('cursor'); body.appendChild(md); }
      if (m.error) { const e = document.createElement('div'); e.className = 'err'; e.textContent = m.error; body.appendChild(e); }
      if (m.pending && m.imageGen && !m.error) {
        const st = document.createElement('div'); st.className = 'gen-status';
        const label = m.genStatus || '正在生成图片…';
        st.innerHTML = '<span class="spin"></span><span></span>';
        st.querySelector('span:last-child').textContent = label;
        if (m.genElapsed) {
          const el = document.createElement('span'); el.className = 'gen-elapsed'; el.textContent = m.genElapsed;
          st.appendChild(el);
        }
        body.appendChild(st);
        const t = document.createElement('div'); t.className = 'typing'; t.innerHTML = '<i></i><i></i><i></i>'; body.appendChild(t);
      } else if (!m.content && !m.error) {
        if (m.pending && !m.reasoning && !m.searching && !m.pluginStatus) { const t = document.createElement('div'); t.className = 'typing'; t.innerHTML = '<i></i><i></i><i></i>'; body.appendChild(t); }
        else if (!m.pending && !m.reasoning && !(m.images && m.images.length)) { const e = document.createElement('div'); e.className = 'muted'; e.textContent = m.stopped ? '（已停止）' : '（空回复）'; body.appendChild(e); }
      }
      if (body.childNodes.length) (botCol || el).appendChild(body);
    }
    if (!m.pending) {
      const act = document.createElement('div'); act.className = 'actions';
      const nv = Versions.count(m);
      if (nv > 1) act.appendChild(buildVerSwitch(m, nv, pst && pst.dim));
      if (m.content) act.appendChild(mkAct(ICON.copy, '复制', () => copyText(m.content)));
      if (m.role === 'assistant' && !running && !m.imageGen && !(pst && pst.dim) && (isLast || !rpFrozen(m))) act.appendChild(mkAct(ICON.redo, isLast ? '重新生成' : '从这里重新生成', () => regenerate(m)));
      else if (m.role === 'assistant' && isLast && !running && m.imageGen) act.appendChild(mkAct(ICON.redo, '重新生成', () => regenerate(m)));
      if (!running && !m.imageGen && (m.role === 'user' || m.role === 'assistant') && (m.content || (m.images && m.images.length))) {
        act.appendChild(mkAct(ICON.image, '据此生图', () => openImageGenFromChat(m)));
      }
      if (m.role === 'user' && !running && !m.imageGen) act.appendChild(mkAct(ICON.edit, '编辑', () => editMsg(m)));
      if (m.role === 'assistant' && !running && !m.imageGen && m.content) act.appendChild(mkAct(ICON.edit, '编辑', () => editMsg(m)));
      if (!running) act.appendChild(mkAct(ICON.trash, '删除', () => deleteMsg(m)));
      (botCol || el).appendChild(act);
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
    const el = document.querySelector('.msg[data-id="' + String(m.id).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
    const stick = nearBottom();
    if (el) {
      fillMsgEl(el, m);
      vsMeasure(el, m);
      if (stick) $('#messages').scrollTop = $('#messages').scrollHeight;
      return;
    }
    // 虚拟窗口外：仅当是末条或贴近底部时扩展窗口，避免流式全量重建
    const last = conv.messages[conv.messages.length - 1];
    if (stick || m === last) renderMessages({ stickBottom: stick, force: true });
  }
  let rafPending = new Set(), rafTimer = null;
  function scheduleUpdate(m) {
    rafPending.add(m);
    if (rafTimer) return;
    rafTimer = setTimeout(() => { rafTimer = null; const s = rafPending; rafPending = new Set(); s.forEach(updateMsg); }, 70);
  }

  function deleteMsg(m) { conv.messages = conv.messages.filter(x => x !== m); if (m && m.id) vsHeight.delete(m.id); saveConv(); renderMessages({ force: true }); }

  // ---------------- 回复版本 / 对话分支 ----------------
  /** RP：已写入章节摘要（或超出预算未发送）的消息不能切换版本 */
  function rpFrozen(m) {
    const st = Plugins.registry.messageState(m, settings, conv, pluginHost);
    return !!(st && st.dim);
  }
  function buildVerSwitch(m, n, frozen) {
    const i = Versions.index(m);
    const w = document.createElement('span'); w.className = 'ver-sw' + (frozen ? ' frozen' : '');
    w.innerHTML = '<button class="vs-prev" aria-label="上一个版本"' + (i <= 0 ? ' disabled' : '') + '>‹</button>' +
      '<button class="vs-label" aria-label="版本管理">' + (i + 1) + ' / ' + n + '</button>' +
      '<button class="vs-next" aria-label="下一个版本"' + (i >= n - 1 ? ' disabled' : '') + '>›</button>';
    w.querySelector('.vs-prev').onclick = () => switchVersion(m, i - 1);
    w.querySelector('.vs-next').onclick = () => switchVersion(m, i + 1);
    w.querySelector('.vs-label').onclick = () => versionMenu(m);
    return w;
  }
  const VER_RP_WARN = '本对话开启了 RP 缓存优化：切换较早回复的版本会改变对话历史，下一轮缓存命中率会下降一次。';
  /** 改变「较早」历史前的确认（RP 对话）。返回 false = 取消 */
  async function confirmHistoryChange(m, title, body, kind) {
    const idx = conv.messages.indexOf(m);
    const later = idx >= 0 && idx < conv.messages.length - 1;
    if (!later || !rpOn(conv)) return true;
    if (body !== false) { // body === false：调用方已经提示过（例如编辑器里的 RP 提示），不再弹窗
      const ok = await dialog({ title, body: body || VER_RP_WARN, okText: '继续' });
      if (!ok) return false;
    }
    const d = Plugins.registry.convData(conv, 'rpcache');
    d.state = RPCache.markHistoryCause(d.state, { kind }, Date.now());
    return true;
  }
  /** 保持被操作消息在屏幕上的位置不变（避免跳动） */
  function rerenderKeeping(m) {
    const box = $('#messages');
    const el = box.querySelector('.msg[data-id="' + m.id + '"]');
    const top = el ? el.getBoundingClientRect().top : null;
    renderMessages();
    const el2 = box.querySelector('.msg[data-id="' + m.id + '"]');
    if (el2 && top != null) box.scrollTop = box.scrollTop + (el2.getBoundingClientRect().top - top);
  }
  async function switchVersion(m, k) {
    if (running) { toast('请先停止当前生成'); return; }
    const n = Versions.count(m); if (k < 0 || k >= n || k === Versions.index(m)) return;
    if (rpFrozen(m)) { toast('这条消息已写入章节摘要（或超出预算未发送），不能切换版本'); return; }
    const i = conv.messages.indexOf(m); if (i < 0) return;
    const before = conv.messages.length - i - 1;
    if (!(await confirmHistoryChange(m, '切换到第 ' + (k + 1) + ' 个版本？', null, 'version'))) return;
    conv.messages = Versions.select(conv.messages, i, k);
    saveConv(conv, false); rerenderKeeping(m); renderConvBar();
    const after = conv.messages.length - i - 1;
    if (before || after) toast('已切换到第 ' + (k + 1) + ' 个版本' + (after ? '，后面显示该版本的 ' + after + ' 条对话' : '（该版本之后还没有对话）'));
  }
  function versionMenu(m) {
    if (running) { toast('请先停止当前生成'); return; }
    const n = Versions.count(m), i = Versions.index(m);
    const items = [];
    for (let k = 0; k < n; k++) if (k !== i) items.push({ label: '切换到第 ' + (k + 1) + ' 个：' + Versions.versionContent(m, k).replace(/\s+/g, ' ').slice(0, 24), icon: ICON.chevR, onClick: () => switchVersion(m, k) });
    items.push({ label: '只保留当前版本（第 ' + (i + 1) + ' 个）', icon: ICON.check, onClick: () => keepOnlyVersion(m) });
    items.push({ label: '删除当前版本', icon: ICON.trash, danger: true, onClick: () => deleteVersion(m, i) });
    actionSheet((m.role === 'user' ? '消息' : '回复') + '版本 ' + (i + 1) + ' / ' + n, items);
  }
  async function deleteVersion(m, k) {
    if (rpFrozen(m)) { toast('这条消息已写入章节摘要，不能修改版本'); return; }
    const i = conv.messages.indexOf(m); if (i < 0) return;
    const tl = Versions.tailLength(conv.messages, i, k);
    const ok = await dialog({ title: '删除第 ' + (k + 1) + ' 个版本？', body: (tl ? '这个版本之后的 ' + tl + ' 条对话也会一起删除。' : '删除后无法恢复。') + (rpOn(conv) && i < conv.messages.length - 1 ? '\n' + VER_RP_WARN : ''), okText: '删除', danger: true });
    if (!ok) return;
    if (rpOn(conv) && i < conv.messages.length - 1) { const d = Plugins.registry.convData(conv, 'rpcache'); d.state = RPCache.markHistoryCause(d.state, { kind: 'delete' }, Date.now()); }
    conv.messages = Versions.removeVersion(conv.messages, i, k);
    saveConv(conv, false); rerenderKeeping(m); renderConvBar(); toast('已删除该版本');
  }
  async function keepOnlyVersion(m) {
    const i = conv.messages.indexOf(m); if (i < 0) return;
    const n = Versions.count(m);
    const ok = await dialog({ title: '只保留当前版本？', body: '其他 ' + (n - 1) + ' 个版本（以及它们之后的对话分支）会被删除，当前显示的内容不变。', okText: '只保留这个', danger: true });
    if (!ok) return;
    conv.messages = Versions.keepOnly(conv.messages, i);
    saveConv(conv, false); rerenderKeeping(m); toast('已只保留当前版本');
  }
  // 左右滑动回复切换版本（避开代码块 / 表格等可横向滚动的区域）
  (function () {
    let sx = 0, sy = 0, el = null, t0 = 0;
    const box = $('#messages');
    box.addEventListener('touchstart', e => {
      const t = e.touches[0]; el = e.target.closest('.msg'); sx = t.clientX; sy = t.clientY; t0 = Date.now();
      if (el && e.target.closest('pre, table, .code-block, .src-row, .msg-images, .ver-sw, .actions')) el = null;
    }, { passive: true });
    box.addEventListener('touchend', e => {
      if (!el) return;
      const t = e.changedTouches[0]; const dx = t.clientX - sx, dy = t.clientY - sy;
      const m = conv.messages.find(x => x.id === el.dataset.id); el = null;
      if (!m || Versions.count(m) < 2 || Date.now() - t0 > 600 || Math.abs(dx) < 70 || Math.abs(dy) > 40) return;
      switchVersion(m, Versions.index(m) + (dx < 0 ? 1 : -1));
    }, { passive: true });
  })();

  /** 编辑消息：全屏编辑器。用户消息可「保存」或「保存并重新发送」；AI 回复可「保存」 */
  async function editMsg(m) {
    const user = m.role === 'user';
    const idx = conv.messages.indexOf(m);
    const after = conv.messages.length - idx - 1;
    const rp = rpOn(conv);
    let hint = user ? (after ? '「保存并重新发送」会从这里开出一个新分支重新生成，原来的内容和之后的 ' + after + ' 条消息保留在旧版本里（可用 ‹ › 切换回去）；「保存」只修改这条消息。' : '「保存并重新发送」会用新内容重新生成回复。')
      : '修改这条 AI 回复的内容，后续对话会以修改后的内容作为上下文。';
    if ((m.images && m.images.length) || (m.files && m.files.length)) hint += '图片和文件附件会保留。';
    if (rp && (after || !user)) hint += '\n本对话开启了 RP 缓存优化：修改历史消息会改变历史前缀，下一轮缓存命中率会下降一次。';
    const r = await openEditor({ title: user ? '编辑消息' : '编辑 AI 回复', value: m.content || '', hint, warn: rp && (after || !user),
      placeholder: user ? '输入消息…' : '回复内容…',
      actions: user ? [{ key: 'save', text: '保存' }, { key: 'resend', text: '保存并重新发送', primary: true }] : [{ key: 'save', text: '保存', primary: true }] });
    if (!r) return;
    const t = r.text;
    if (r.key === 'resend') {
      if (!t.trim() && !(m.images && m.images.length) && !(m.files && m.files.length)) { toast('消息不能为空'); return; }
      if (running) { toast('请先停止当前生成'); return; }
      const p = ensureProvider(); if (!p) return;
      if (settings.searchOn && !searchReady()) { askSearchSetup(); return; }
      if (!(await confirmHistoryChange(m, '编辑并重新发送？', false, 'branch'))) return;
      // 新分支：这条消息新增一个版本，原来的内容和后面的对话保留在旧版本里（‹ 1/2 › 切换）
      const init = { content: t, createdAt: Date.now() };
      if (m.images && m.images.length) init.images = m.images.slice();
      if (m.files && m.files.length) init.files = m.files.slice();
      conv.messages = Versions.addVersion(conv.messages, conv.messages.indexOf(m), init);
      saveConv(); renderMessages(); runChat(p);
      return;
    }
    if (t === (m.content || '')) return;
    if (user && !t.trim() && !(m.images && m.images.length) && !(m.files && m.files.length)) { toast('消息不能为空'); return; }
    m.content = t; m.edited = true;
    delete m.rpSent; // RP：冻结的发送原文作废，下一轮按修改后的内容进入历史
    saveConv(); renderMessages(); toast('已保存');
  }
  const editUserMsg = editMsg;

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
    if (!hasKey(p)) {
      if (!configured().length) { toast('请先在设置中填写 API Key'); openSettings(); }
      else { toast('请先选择服务商和模型'); openModelMenu(); }
      return null;
    }
    if (!conv.model) { toast('请填写模型名称'); openSheet(); return null; }
    return p;
  }
  let autoCharBusy = false;
  /** v0.8.3：RP 模板首条消息 → 询问（或按设置直接）生成角色卡，绑定到本对话，再继续正常回复。
   * 拒绝 / 失败 / 取消都不阻塞回复；生成中发送键变「停止」可取消；首条消息本身是分段角色卡时直接导入，不调用模型。 */
  async function maybeAutoChar(c) {
    if (!window.AutoChar || !AutoChar.shouldOffer(c, templates, settings)) return;
    c.autoChar = { asked: true, at: Date.now() };
    const first = c.messages.find(m => m.role === 'user' && !m.error && !m.imageGen);
    const firstText = first ? String(first.content || '') : '';
    let fields = AutoChar.fromUserText(firstText), fromUser = !!fields;
    if (!fromUser && AutoChar.mode(settings) !== 'auto') {
      const ok = await dialog({ title: '生成角色卡？', body: '当前是角色扮演模板，但本对话还没有角色卡。\n\n是否根据 RP 模板和你的首条消息先生成角色卡（世界观、人物、规则、开场白），绑定到本对话后再回复？\n\n会额外调用一次模型；生成中可点「停止」跳过。可在 设置 → 对话 里改为「直接生成」或「关闭」。', okText: '生成' });
      if (!ok) {
        c.autoChar.status = 'declined'; saveConv(c);
        toast('已跳过角色卡，按原设定回复', [{ label: '不再询问', onClick: () => { settings.autoCharMode = 'off'; saveSettings(); toast('已关闭自动生成角色卡（设置 → 对话 可重新打开）'); } }]);
        return;
      }
    }
    autoCharBusy = true; c.autoChar.status = 'running';
    let cancelFn = null, cancelled = false;
    const cancel = () => { cancelled = true; if (cancelFn) cancelFn(); };
    if (!fromUser) {
      setRunning({ msg: {}, cancel, autoChar: true });
      const tip = $('#input'); if (tip) { c.autoChar.ph = tip.placeholder; tip.placeholder = '正在生成角色卡…点「停止」可跳过'; }
      toast('正在生成角色卡…（完成后自动继续回复，点「停止」跳过）');
    }
    try {
      if (!fromUser) {
        const skill = templates.find(t => t.id === Templates.CARD_SKILL_ID);
        const prompt = AutoChar.buildPrompt(firstText, c.systemPrompt, skill && skill.content);
        const o = { conv: c, maxTokens: Math.max(4096, +settings.maxTokens || 0), timeoutMs: 150000, usageType: 'extract', setCancel: f => { cancelFn = f; } };
        const raw = await pluginHost.callModel(prompt, o);
        fields = AutoChar.parse(raw);
        if (!fields && !cancelled && String(raw || '').trim()) {
          // 只重试一次：把上次输出交给模型按格式整理（比整段重新生成快，也不丢内容）
          fields = AutoChar.parse(await pluginHost.callModel('把下面这段角色设定原样整理成 8 段格式输出，每段单独一行【标题】开头，标题依次为：\n' +
            '【世界观】【角色卡】【RP规则】【输出格式】【示例对白】【禁止事项】【写作风格】【开场白】\n不要序号、不要 Markdown 标题、不要代码块、不要解释。\n\n---\n' + String(raw).slice(0, 12000), o));
        }
        if (!fields) throw new Error(String(raw || '').trim() ? '模型没有按分段格式输出角色卡' : '模型返回为空');
      }
      const name = AutoChar.charName(fields);
      const rp = Plugins.registry.get('rpcache');
      c.systemPrompt = AutoChar.fillLeftovers(c.systemPrompt, fields); // 模板里没填的 {{角色名}} 等变量 → 用生成的名字 / 去掉
      if (rpOn(c) && rp && rp._internals && rp._internals.importSections) {
        rp._internals.importSections(pluginHost, c, fields); c.autoChar.target = 'blocks';
      } else {
        c.systemPrompt = String(c.systemPrompt || '').trimEnd() + AutoChar.toPromptAppend(fields); c.autoChar.target = 'system';
        toast((fromUser ? '已识别首条消息里的角色卡' : '已生成角色卡') + (name ? '「' + name + '」' : '') + '，写入本对话系统提示词',
          fields.opening ? [{ label: '复制开场白', onClick: () => { try { navigator.clipboard.writeText(fields.opening); toast('开场白已复制'); } catch (e) { toast(fields.opening.slice(0, 80)); } } }] : null);
      }
      c.autoChar.status = 'done'; c.autoChar.name = name; c.autoChar.opening = fields.opening || ''; c.autoChar.fromUser = fromUser || undefined;
    } catch (e) {
      if (cancelled) { c.autoChar.status = 'cancelled'; toast('已跳过角色卡生成，按原设定回复'); }
      else {
        c.autoChar.status = 'error'; c.autoChar.error = String(e && e.message || e).slice(0, 120);
        toast('角色卡生成失败：' + c.autoChar.error + '。已按原设定继续回复', [{ label: '用 Skill 手动生成', onClick: () => { const t = templates.find(x => x.id === Templates.CARD_SKILL_ID); if (t) toast('新建对话 → 模板选「' + t.name + '」，把想法发给它即可'); } }]);
      }
    } finally {
      autoCharBusy = false;
      const tip = $('#input'); if (tip && c.autoChar.ph != null) { tip.placeholder = c.autoChar.ph; delete c.autoChar.ph; }
      if (running && running.autoChar) setRunning(false);
      saveConv(c); if (conv === c) renderMessages();
    }
  }
  function send() {
    if (running || autoCharBusy) return;
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
    const c0 = conv;
    if (window.AutoChar && AutoChar.shouldOffer(c0, templates, settings)) {
      renderMessages(); saveConv(c0);
      maybeAutoChar(c0).catch(() => {}).then(() => { if (conv === c0 && !running) runChat(getProvider(c0.providerId) || p); });
      return;
    }
    runChat(p);
  }
  /** 重新生成：保留旧回复为一个版本（‹ 1/2 ›）。较早的回复也可以重新生成，后面的对话保留在旧版本的分支里 */
  async function regenerate(target) {
    if (running) return;
    const last = conv.messages[conv.messages.length - 1];
    const m = target && target.role === 'assistant' ? target : last;
    if (m && m.role === 'assistant' && !m.imageGen) {
      const i = conv.messages.indexOf(m); if (i < 0) return;
      const p = ensureProvider(); if (!p) return;
      if (settings.searchOn && !searchReady()) { askSearchSetup(); return; }
      if (i < conv.messages.length - 1) {
        if (rpFrozen(m)) { toast('这条回复已写入章节摘要，不能重新生成'); return; }
        const rest = conv.messages.length - i - 1;
        const ok = await dialog({ title: '从这里重新生成？', body: '会为这条回复生成一个新版本。之后的 ' + rest + ' 条对话保留在旧版本里，可以用 ‹ › 切换回去。' +
          (rpOn(conv) ? '\n\n本对话开启了 RP 缓存优化：从较早的回复重新生成会改变对话历史，下一轮缓存命中率会下降一次。' : ''), okText: '重新生成' });
        if (!ok) return;
        if (rpOn(conv)) { const d = Plugins.registry.convData(conv, 'rpcache'); d.state = RPCache.markHistoryCause(d.state, { kind: 'regen' }, Date.now()); }
      }
      // 失败 / 空的回复不保留为版本，直接在原位置重试
      if ((m.error || m.stopped) && !m.content && i === conv.messages.length - 1) {
        if (Versions.count(m) === 1) conv.messages.pop();
        else { Versions.applySnap(m, {}); return runChat(p, { bot: m }); }
      } else {
        conv.messages = Versions.addVersion(conv.messages, i, {});
        return runChat(p, { bot: m });
      }
      return runChat(p);
    }
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
    return { provider: ss.provider, hasKey: !!(ss.hasKeys || {})[ss.provider], baseUrl: (ss.urls || {})[ss.provider] || '', count: ss.count || 5 };
  }
  function searchReady() {
    const c = searchCfg(); const info = searchInfo(c.provider);
    return info.needsKey ? c.hasKey : /^https?:\/\/.+/.test(c.baseUrl.trim());
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
    const req = authed(Search.buildSearchRequest(cfg, query), cfg.hasKey ? 'search:' + cfg.provider : '');
    const r = await requestText(req, setCancel, 25000);
    if (r.status >= 400 || !r.status) throw new Error(searchErrorText(r.status, r.text));
    let list;
    try { list = Search.parseSearchResponse(cfg.provider, r.text, cfg.count); }
    catch (e) { throw new Error(e instanceof SyntaxError ? '返回的不是 JSON（SearXNG 需在实例中开启 json 格式）' : e.message); }
    return list;
  }
  async function rewriteQuery(p, q, history, setCancel) {
    try {
      const req = authed(Providers.buildChatRequest(p, conv.model, [{ role: 'user', content: Search.buildRewritePrompt(q, history) }], '', { stream: false, temperature: 0, maxTokens: 256 }), p.id);
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

  async function runChat(p, opts) {
    const thisConv = conv;
    const reuse = opts && opts.bot; // 重新生成：在同一个消息位置写入新版本
    const lastUser = conv.messages.slice().reverse().find(m => m.role === 'user' && !m.imageGen && m !== reuse);
    const wantSearch = !!(settings.searchOn && searchReady() && lastUser && (lastUser.content || '').trim());
    const bot = reuse || { id: uid(), role: 'assistant' };
    Object.assign(bot, { content: '', reasoning: '', pending: true, model: conv.model, createdAt: Date.now() });
    if (conv.personaName) { bot.personaName = conv.personaName; bot.personaEmoji = conv.personaEmoji; }
    if (wantSearch) bot.searching = true;
    if (lastUser) delete lastUser.search;
    if (!reuse) conv.messages.push(bot);
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
    let req = Providers.buildChatRequest(p, rctx.model, rctx.messages, rctx.systemPrompt, rctx.opts);
    const gcp = rctx.opts && rctx.opts.orGemini && Plugins.registry.get('gcache'); // v0.8.2：OpenRouter Gemini 提示缓存
    if (gcp) { try { req = gcp.transformRequest(req, rctx); } catch (e) { console.warn('[gcache]', e); } }
    authed(req, p.id);
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
    const okResp = !bot.error && !bot.stopped && status >= 200 && status < 300;
    Plugins.registry.runAfterResponse(rctx, { ok: okResp, usage: bot.usage || null, bot, status }, pluginHost);
    if (okResp && bot.usage) recordUsage({ usage: bot.usage, type: 'chat', conv: thisConv, provider: p, model: rctx.model || thisConv.model, msgId: bot.id, at: bot.createdAt || Date.now() });
    finish();
  }

  function generateImage(p, prompt) {
    const check = ImageGen.canGenerate(p);
    if (!check.ok) { toast(check.reason); return; }
    if (!prompt) { toast('请输入图片描述'); return; }
    const user = { id: uid(), role: 'user', content: prompt, imageGen: true, createdAt: Date.now() };
    const bot = { id: uid(), role: 'assistant', content: '', pending: true, imageGen: true,
      genStatus: '请求已发送…', genElapsed: '0 秒',
      model: (check.model || p.imageModel) + ' · 生成图片', createdAt: Date.now() };
    conv.messages.push(user, bot);
    if (conv.title === '新对话') conv.title = '🎨 ' + prompt.slice(0, 20);
    input.value = ''; autosize(); renderMessages();
    const req = authed(ImageGen.buildRequest(p, prompt, settings.imageSize || ImageGen.DEFAULT_SIZE), p.id);
    let status = 0, raw = '', httpStarted = false, receiving = false;
    const thisConv = conv;
    const startedAt = Date.now();
    const tickChatProgress = () => {
      const elapsed = Date.now() - startedAt;
      const stage = ImageGen.progressStage(elapsed, { httpStarted: httpStarted, receiving: receiving });
      bot.genStatus = stage.text;
      bot.genElapsed = ImageGen.formatElapsed(elapsed);
      if (conv === thisConv) scheduleUpdate(bot); // v0.9.0：只更新这条消息，不整表重绘
    };
    const progressTimer = setInterval(tickChatProgress, 900);
    const h = httpRequest(req, {
      onStatus: s => { status = s; httpStarted = true; tickChatProgress(); },
      onChunk: t => { raw += t; if (!receiving) { receiving = true; tickChatProgress(); } },
    });
    setRunning({ cancel: h.cancel, msg: bot });
    h.promise.then(() => {
      if (bot.stopped) return;
      if (status >= 400 || !status) { bot.error = Providers.parseError(status, raw); return; }
      try {
        const imgs = ImageGen.parseResponse(raw);
        if (!imgs.length) bot.error = '未返回图片：' + raw.slice(0, 300); else bot.images = imgs;
        try {
          const obj = JSON.parse(raw);
          const u = Providers.normalizeUsage(p.type, obj.usage || obj.meta || null);
          if (u) { bot.usage = u; recordUsage({ usage: u, type: 'image', conv: thisConv, provider: p, model: p.imageModel, msgId: bot.id, at: bot.createdAt || Date.now() }); }
        } catch (_) {}
      } catch (e) { bot.error = '无法解析响应：' + raw.slice(0, 300); }
    }).catch(e => { bot.error = '网络错误：' + e.message; })
      .finally(() => {
        clearInterval(progressTimer);
        delete bot.genStatus; delete bot.genElapsed;
        bot.pending = false; setRunning(null); saveConv(thisConv);
        if (conv === thisConv) updateMsg(bot); renderConvList();
      });
  }

  function stopGen() { if (!running) return; running.msg.stopped = true; running.cancel(); }

  // ---------------- 输入区 ----------------
  const input = $('#input');
  function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 168) + 'px'; updateSendState(); $('#composer-card').classList.toggle('long', input.scrollHeight > 130 || input.value.split('\n').length > 4); }
  input.addEventListener('input', autosize);
  input.addEventListener('focus', () => $('#composer-card').classList.add('focus'));
  input.addEventListener('blur', () => $('#composer-card').classList.remove('focus'));
  $('#btn-send').onclick = () => running ? stopGen() : send();
  async function handlePickedFiles(fileList) {
    const files = Array.from(fileList || []);
    for (const f of files) {
      const kind = Files.classifyFile(f.name, f.type);
      if (kind === 'image') {
        try { attachments.push(await compressImage(f)); } catch (err) { toast('图片读取失败'); }
        renderAttachments();
      } else addDoc(f, kind);
    }
  }
  $('#btn-attach').onclick = () => {
    if (imageMode) { toast('图片生成模式下不能添加附件'); return; }
    actionSheet('添加', [
      { label: '从相册选择', onClick: () => $('#file-input-image').click() },
      { label: '选择文件', onClick: () => $('#file-input').click() },
    ]);
  };
  $('#file-input').onchange = async e => {
    const files = Files.takeInputFiles(e.target);
    if (!files.length) { toast('未选择文件或读取失败，请重试'); return; }
    try { await handlePickedFiles(files); } catch (err) { console.error(err); toast('文件添加失败：' + (err && err.message || err)); }
  };
  $('#file-input-image').onchange = async e => {
    const files = Files.takeInputFiles(e.target);
    if (!files.length) { toast('未选择文件或读取失败，请重试'); return; }
    try { await handlePickedFiles(files); } catch (err) { console.error(err); toast('文件添加失败：' + (err && err.message || err)); }
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

  function syncComposerTags() {
    const box = $('#composer-tags');
    if (!box) return;
    const tags = [];
    if (settings.searchOn && !imageMode) tags.push({ icon: 'globe', label: '联网' });
    if (imageMode) tags.push({ icon: 'spark', label: '生图' });
    box.innerHTML = '';
    if (!tags.length) { box.hidden = true; return; }
    box.hidden = false;
    tags.forEach(t => {
      const s = document.createElement('span'); s.className = 'composer-tag';
      s.innerHTML = (t.icon === 'globe'
        ? '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.4 3.6 5.2 3.6 8.5s-1.2 6.1-3.6 8.5c-2.4-2.4-3.6-5.2-3.6-8.5s1.2-6.1 3.6-8.5z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 3.5c.6 4.2 1.9 5.5 6 6.3-4.1.8-5.4 2.1-6 6.3-.6-4.2-1.9-5.5-6-6.3 4.1-.8 5.4-2.1 6-6.3z"/></svg>') +
        '<span>' + t.label + '</span>';
      box.appendChild(s);
    });
  }
  function defaultPlaceholder() {
    if (imageMode) return '描述你想生成的图片…';
    if (settings.searchOn) return '联网搜索已开启，问点新鲜事…';
    return '输入消息… (Shift + Enter 换行)';
  }
  $('#btn-imagegen').onclick = () => {
    imageMode = !imageMode;
    $('#btn-imagegen').classList.toggle('active', imageMode);
    $('#composer-card').classList.toggle('imgmode', imageMode);
    input.placeholder = defaultPlaceholder();
    syncComposerTags();
    toast(imageMode ? '已切换到图片生成模式' : '已切换回聊天模式');
    if (imageMode && (attachments.length || docs.length)) { attachments = []; docs = []; renderAttachments(); }
  };
  function renderSearchChip() {
    $('#btn-search').classList.toggle('active', !!settings.searchOn);
    if (!imageMode) input.placeholder = defaultPlaceholder();
    syncComposerTags();
  }
  $('#btn-search').onclick = () => {
    if (!settings.searchOn && !searchReady()) { askSearchSetup(); return; }
    settings.searchOn = !settings.searchOn; saveSettings(); renderSearchChip();
  syncComposerTags();
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
    sheetPid = hasKey(getProvider(conv.providerId)) ? conv.providerId : list[0].id;
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
    if ($('#set-autochar')) $('#set-autochar').value = window.AutoChar ? AutoChar.mode(settings) : 'auto';
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
    if ($('#set-autochar')) { settings.autoCharMode = $('#set-autochar').value; delete settings.autoCharGen; }
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
    if (!hasKey(cur)) {
      const p = configured()[0]; if (p) { conv.providerId = p.id; conv.model = p.models[0] || ''; }
    }
    renderAll();
  }
  ['#set-system', '#set-temp', '#set-maxtokens', '#set-imgsize'].forEach(s => $(s).addEventListener('change', readGeneral));
  $('#set-stream').onchange = readGeneral;
  if ($('#set-autochar')) $('#set-autochar').onchange = readGeneral;
  function renderProviderList() {
    const box = $('#provider-list'); box.innerHTML = '';
    const sorted = settings.providers.slice().sort((a, b) => (hasKey(b) ? 1 : 0) - (hasKey(a) ? 1 : 0));
    sorted.forEach(p => {
      const el = document.createElement('button'); el.className = 'prov-item';
      const ok = hasKey(p);
      el.innerHTML = avatarHtml(p, 'lg') + '<div class="pi-main"><div class="pi-name">' + esc(p.name) + '</div><div class="pi-sub">' +
        esc(ok ? (p.models.filter(Boolean).slice(0, 3).join(' · ') || p.baseUrl) : p.baseUrl) + '</div></div>' +
        '<span class="status' + (ok ? ' ok' : '') + '">' + (ok ? '已配置' : '未配置') + '</span>' + ICON.chevR;
      el.onclick = () => openProviderEdit(p.id);
      box.appendChild(el);
    });
  }
  $('#btn-add-provider').onclick = () => {
    openProviderEdit(null, { id: uid(), presetId: 'custom', name: '自定义服务', type: 'openai', baseUrl: 'https://', models: [], imageModel: '', videoModel: '', embeddingModel: '', speechModel: '', transcriptionModel: '' });
  };
  $('#btn-clear-all').onclick = async () => {
    const ok = await dialog({ title: '删除全部对话？', body: '将删除所有本地对话记录（服务商与 API Key 设置会保留）。', okText: '全部删除', danger: true });
    if (!ok) return;
    if (running) stopGen();
    pendingSaves.clear();
    convIndex.forEach(m => { Store.del('conv_' + m.id + '.json'); Store.del('rplog_' + m.id + '.json'); Store.del('rplog_' + m.id + '.jsonl'); });
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
    $('#ss-key').value = (ss.hasKeys || {})[ss.provider] ? KEY_MASK : ''; $('#ss-key').placeholder = info.keyHint || '';
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
    ss.urls = ss.urls || {}; ss.hasKeys = ss.hasKeys || {};
    ss.urls[pid] = $('#ss-url').value.trim().replace(/\/+$/, '');
    const cleared = registerSearch(pid) === 'cleared';
    const kv = $('#ss-key').value.trim();
    if (kv === KEY_MASK) { if (cleared) { toast('接口地址的主机已变更，旧 Key 已清除，请重新填写'); $('#ss-key').value = ''; } }
    else if (kv) Secrets.set('search_key', pid, kv);
    else Secrets.del('search_key', pid);
    ss.hasKeys[pid] = Secrets.has('search_key', pid);
    if (ss.hasKeys[pid] && kv && kv !== KEY_MASK) $('#ss-key').value = KEY_MASK;
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
  // ---- Character Card V2 导入 / 导出 ----
  async function importPersonaCardFile(file) {
    if (!file) return;
    try {
      const buf = await CharCard.readFileAsArrayBuffer(file);
      const card = CharCard.parseCard(new Uint8Array(buf));
      const mapped = CharCard.cardToPersona(card);
      const item = Personas.normalizePersona(Object.assign({}, mapped, { builtin: false }));
      item.loreText = mapped.loreText || '';
      item.firstMes = mapped.firstMes || '';
      item.alternateGreetings = mapped.alternateGreetings || [];
      item.mesExample = mapped.mesExample || '';
      item.cardSpec = mapped.cardSpec;
      item.cardRaw = mapped.cardRaw;
      personas = Personas.upsert(personas, item);
      // normalizePersona 会丢掉扩展字段，再补回去
      const i = personas.findIndex(x => x.id === item.id);
      if (i >= 0) personas[i] = Object.assign({}, personas[i], {
        loreText: item.loreText, firstMes: item.firstMes, alternateGreetings: item.alternateGreetings,
        mesExample: item.mesExample, cardSpec: item.cardSpec, cardRaw: item.cardRaw,
      });
      savePersonas(); renderPersonaGrid();
      toast('已导入角色卡「' + item.name + '」' + (item.loreText ? '（含世界书）' : ''));
      openPersonaEdit(item.id);
    } catch (e) {
      toast('导入失败：' + (e && e.message || e));
    }
  }
  function exportPersonaCard(ps) {
    try {
      const full = personas.find(x => x.id === ps.id) || ps;
      const card = CharCard.personaToCard(full);
      const png = CharCard.writeCardToPng(card);
      const blob = new Blob([png], { type: 'image/png' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = (full.name || 'character') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('已导出「' + full.name + '」角色卡 PNG');
    } catch (e) { toast('导出失败：' + (e && e.message || e)); }
  }
  function pickPersonaCardImport() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/png,.png,application/json,.json';
    inp.onchange = () => { const f = inp.files && inp.files[0]; if (f) importPersonaCardFile(f); };
    inp.click();
  }

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
  $('#pl-add').onclick = () => {
    if (plTab !== 'personas') { openPromptEdit(null); return; }
    actionSheet('新建助手', [
      { label: '空白助手', icon: ICON.edit, onClick: () => openPersonaEdit(null) },
      { label: '导入角色卡 PNG / JSON', icon: ICON.image, onClick: () => pickPersonaCardImport() },
    ]);
  };
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
          { label: '导出角色卡 PNG', icon: ICON.image, onClick: () => exportPersonaCard(ps) },
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
    $('#persona-count').textContent = personas.length + ' 助手 · ' + prompts.length + ' 提示词';
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
    // Character Card：世界书写入 RP 状态；开场白作为首条助手消息
    if (ps.loreText && typeof RPCache !== 'undefined') {
      const d = Plugins.registry.convData(conv, 'rpcache');
      d.state = RPCache.setLore(d.state || RPCache.newState(), ps.loreText);
      if (!conv.plugins) conv.plugins = {};
      if (!conv.plugins.rpcache) conv.plugins.rpcache = { enabled: true };
      else conv.plugins.rpcache.enabled = true;
    }
    if (ps.firstMes) {
      conv.messages.push({ id: uid(), role: 'assistant', content: ps.firstMes, model: conv.model, personaName: ps.name, personaEmoji: ps.emoji, createdAt: Date.now() });
    }
    saveConv();
    closePersonas(); closeDrawer();
    renderAll();
    toast('已切换到「' + ps.name + '」' + (ps.loreText ? '（已导入世界书）' : ''));
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
    sel.innerHTML = '<option value="">跟随当前对话</option>' + settings.providers.filter(p => hasKey(p) || p.id === editingPersona.providerId)
      .map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + (hasKey(p) ? '' : '（未配置）') + '</option>').join('');
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
    const i = personas.findIndex(x => x.id === item.id);
    if (i >= 0) personas[i] = Object.assign({}, personas[i], {
      loreText: editingPersona.loreText || personas[i].loreText || '',
      firstMes: editingPersona.firstMes || '',
      alternateGreetings: editingPersona.alternateGreetings || [],
      mesExample: editingPersona.mesExample || '',
      cardSpec: editingPersona.cardSpec,
      cardRaw: editingPersona.cardRaw,
    });
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
    $('#persona-count').textContent = personas.length + ' 助手 · ' + prompts.length + ' 提示词';
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
  let editing = null, editModels = [], editMeta = {};
  const baseHints = {
    openai: '填写到版本路径这一级（通常以 /v1 结尾），程序会自动拼接 /chat/completions。',
    anthropic: '一般为 https://api.anthropic.com（程序拼接 /v1/messages）。',
    gemini: '一般为 https://generativelanguage.googleapis.com/v1beta。',
  };
  const presetHints = {
    deepseek: 'DeepSeek 官方地址：https://api.deepseek.com',
    qwen: '阿里云百炼（北京）OpenAI 兼容地址；也可使用业务空间专属域名：https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1。API Key 与地域绑定，国际站 Key 请用「千问（国际）」。',
    'qwen-intl': '阿里云百炼国际站（新加坡）OpenAI 兼容地址；API Key 需在国际站（modelstudio.console.alibabacloud.com）创建，与中国站不通用。',
    xiaomi: '小米 MiMo 官方 OpenAI 兼容地址：https://api.xiaomimimo.com/v1（也可用 api-key 请求头；本应用使用 Bearer）',
    moonshot: '余额查询：GET /users/me/balance',
    siliconflow: '余额查询：GET /user/info',
    openrouter: '额度查询：GET /key（账户总余额需管理密钥）',
  };
  const PE_FIELDS = { imageModel: '#pe-imgmodel', videoModel: '#pe-videomodel', embeddingModel: '#pe-embedmodel',
    speechModel: '#pe-speechmodel', transcriptionModel: '#pe-sttmodel' };
  const CAT_FIELD = { image: 'imageModel', video: 'videoModel', embedding: 'embeddingModel', speech: 'speechModel', transcription: 'transcriptionModel' };
  function openProviderEdit(id, fresh) {
    editing = fresh || Object.assign({}, getProvider(id));
    editModels = (editing.models || []).filter(Boolean).slice();
    $('#pe-title').textContent = fresh ? '添加服务商' : editing.name;
    $('#pe-name').value = editing.name;
    $('#pe-type').value = editing.type;
    $('#pe-base').value = editing.baseUrl;
    $('#pe-key').value = hasKey(editing) ? KEY_MASK : ''; $('#pe-key').type = 'password'; $('#pe-key-toggle').textContent = '显示';
    Providers.normalizeModelFields(editing);
    Object.keys(PE_FIELDS).forEach(f => { $(PE_FIELDS[f]).value = editing[f] || ''; });
    $('#pe-streamusage').checked = Providers.streamUsageEnabled(Object.assign({}, editing, { type: 'openai' }));
    $('#pe-su-row').style.display = editing.type === 'openai' ? '' : 'none';
    $('#pe-thinking').value = editing.thinking || '';
    $('#pe-think-row').style.display = Providers.isQwenEndpoint(editing) ? '' : 'none';
    editMeta = Object.assign({}, editing.modelMeta || {});
    $('#pe-model-add').value = '';
    $('#pe-base-hint').textContent = presetHints[editing.presetId] || baseHints[editing.type];
    $('#pe-delete').style.display = fresh ? 'none' : '';
    renderModelChips(); renderFieldPrices();
    $('#page-provider').classList.add('show');
  }
  function renderModelChips() {
    const box = $('#pe-model-chips'); box.innerHTML = '';
    editModels.forEach((m, i) => {
      const c = document.createElement('span'); c.className = 'mchip' + (i === 0 ? ' default' : '');
      const pr = editMeta[m] && editMeta[m].price ? Providers.formatModelPrice(editMeta[m]) : '';
      c.innerHTML = '<span class="mc-name">' + esc(m) + (pr && pr !== '—' ? '<small class="mc-price">' + esc(pr) + '</small>' : '') + '</span><button class="mc-x" aria-label="删除">×</button>';
      if (pr) c.title = pr;
      c.querySelector('.mc-name').onclick = () => { editModels.splice(i, 1); editModels.unshift(m); renderModelChips(); };
      c.querySelector('.mc-x').onclick = () => { editModels.splice(i, 1); renderModelChips(); };
      box.appendChild(c);
    });
  }
  /** 图片/视频等单字段：若模型有价格元数据，在输入框下显示 #pe-*-price */
  function renderFieldPrices() {
    Object.keys(PE_FIELDS).forEach(f => {
      const inp = $(PE_FIELDS[f]); const hid = PE_FIELDS[f].slice(1) + '-price';
      let h = document.getElementById(hid);
      if (!h) {
        h = document.createElement('div'); h.id = hid; h.className = 'field-price';
        inp.insertAdjacentElement('afterend', h);
        inp.addEventListener('input', renderFieldPrices);
      }
      const meta = editMeta[inp.value.trim()]; const t = meta ? Providers.formatModelPrice(meta) : '—';
      h.textContent = t === '—' ? '' : '价格：' + t; h.style.display = t === '—' ? 'none' : '';
    });
  }
  function modelInfoLine(m) {
    const meta = editMeta[m]; if (!meta) return '';
    const parts = [];
    if (meta.context) parts.push(Providers.formatContext(meta.context));
    const t = Providers.formatModelPrice(meta); if (t !== '—') parts.push(t);
    return parts.length ? '<small class="cl-price">' + esc(parts.join(' · ')) + '</small>' : '';
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
  $('#pe-base').addEventListener('input', () => { $('#pe-think-row').style.display = Providers.isQwenEndpoint({ presetId: editing && editing.presetId, baseUrl: $('#pe-base').value }) ? '' : 'none'; });
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
      baseUrl: base, models: editModels.slice() };
    const keyVal = $('#pe-key').value.trim();
    Object.keys(PE_FIELDS).forEach(f => { p[f] = $(PE_FIELDS[f]).value.trim(); });
    const th = $('#pe-thinking').value;
    if (th && Providers.isQwenEndpoint(p)) p.thinking = th;
    const meta = {}; p.models.concat(Object.keys(PE_FIELDS).map(f => p[f])).forEach(m => { if (m && editMeta[m]) meta[m] = editMeta[m]; });
    if (Object.keys(meta).length) p.modelMeta = meta; // 模型列表接口返回的上下文窗口，供 RP 插件自动推导预算
    if ($('#pe-type').value === 'openai') {
      const su = $('#pe-streamusage').checked;
      if (su !== Providers.streamUsageEnabled(Object.assign({}, p, { streamUsage: undefined }))) p.streamUsage = su; // 只保存与默认不同的选择
    }
    // v0.9.0：密钥写入原生安全存储（先登记 Base URL，主机变化时原生层会清掉旧 Key）
    const cleared = registerProvider(p) === 'cleared';
    if (keyVal === KEY_MASK) { /* 保持原密钥 */ }
    else if (keyVal) { if (!Secrets.set('provider_key', p.id, keyVal)) { toast('API Key 保存失败'); return; } }
    else Secrets.del('provider_key', p.id);
    p.hasKey = Secrets.has('provider_key', p.id);
    const i = settings.providers.findIndex(x => x.id === p.id);
    if (i >= 0) settings.providers[i] = p; else settings.providers.push(p);
    saveSettings(); toast(cleared && keyVal === KEY_MASK ? 'Base URL 主机已变更，旧 API Key 已清除，请重新填写' : '已保存'); closeProviderEdit(); renderHeader();
  };
  $('#pe-delete').onclick = async () => {
    const ok = await dialog({ title: '删除服务商？', body: '将删除「' + editing.name + '」及其 API Key。', okText: '删除', danger: true });
    if (!ok) return;
    settings.providers = settings.providers.filter(x => x.id !== editing.id);
    Secrets.del('provider_key', editing.id);
    if (editing.presetId && editing.presetId !== 'custom') settings.removedPresets = (settings.removedPresets || []).concat(editing.presetId);
    saveSettings(); closeProviderEdit(); renderHeader();
  };

  // 从接口获取模型列表
  let fetched = [], fetchSel = new Set(), fetchCat = 'all';
  const FETCH_CATS = [['all', '全部'], ['text', '文本'], ['image', '图片'], ['video', '视频'], ['embedding', '嵌入'], ['audio', '音频']];
  const catOf = m => { const c = Providers.classifyModel(m, editMeta[m]); return c === 'speech' || c === 'transcription' ? 'audio' : c; };
  $('#pe-fetch').onclick = async () => {
    const typed = $('#pe-key').value.trim();
    // 新输入的 Key 直接用于本次请求（页面本来就知道）；已保存的 Key 由原生层注入，且只能发往登记的同源地址
    const useStored = typed === KEY_MASK;
    const prov = { presetId: editing.presetId, type: $('#pe-type').value, baseUrl: $('#pe-base').value.trim(), apiKey: useStored ? '' : typed };
    if (!/^https?:\/\/.+/.test(prov.baseUrl)) { toast('请先填写正确的 Base URL'); return; }
    if (!typed) { toast('请先填写 API Key'); return; }
    if (useStored && !Secure.isUrlAllowed(prov.baseUrl, (getProvider(editing.id) || {}).baseUrl)) { toast('Base URL 主机已改动，请重新填写 API Key 再获取'); return; }
    const btn = $('#pe-fetch'); btn.disabled = true; const old = btn.innerHTML; btn.innerHTML = '获取中…';
    try {
      const r = await httpSimple(authed(Providers.buildModelsRequest(prov), useStored ? editing.id : ''));
      if (r.status >= 400 || !r.status) throw new Error(Providers.parseError(r.status, r.text));
      fetched = Providers.parseModelsResponse(prov.type, r.text);
      Object.assign(editMeta, Providers.parseModelsMeta(prov.type, r.text));
      if (!fetched.length) throw new Error('接口没有返回任何模型');
      fetchSel = new Set(); fetchCat = 'all';
      $('#fetch-search').value = '';
      renderFetchList();
      if (/openrouter\.ai/i.test(prov.baseUrl) && fetched.some(m => ['image', 'video'].includes(catOf(m)))) toast('已包含图片/视频等模型，可切换分类查看');
      $('#fetch-sheet').classList.add('show'); $('#fetch-mask').classList.add('show');
    } catch (e) {
      dialog({ title: '获取失败', body: String(e.message || e) + '\n\n部分服务商不提供模型列表接口，可手动输入模型名。', okText: '知道了', info: true });
    } finally { btn.disabled = false; btn.innerHTML = old; }
  };
  function renderFetchList() {
    const q = $('#fetch-search').value.trim().toLowerCase();
    const box = $('#fetch-list'); box.innerHTML = '';
    const cb = $('#fetch-cats'); cb.innerHTML = '';
    FETCH_CATS.forEach(([k, label]) => {
      const n = k === 'all' ? fetched.length : fetched.filter(m => catOf(m) === k).length;
      if (k !== 'all' && !n) return;
      const c = document.createElement('span'); c.className = 'mchip' + (fetchCat === k ? ' default' : '');
      c.innerHTML = '<span class="mc-name">' + label + ' ' + n + '</span>';
      c.onclick = () => { fetchCat = k; renderFetchList(); };
      cb.appendChild(c);
    });
    $('#fetch-cat-hint').textContent = fetchCat === 'all' || fetchCat === 'text' ? '勾选后添加到文本模型' : '点模型名直接设为对应分类的模型（图片/视频/嵌入/语音）';
    fetched.filter(m => (!q || m.toLowerCase().includes(q)) && (fetchCat === 'all' || catOf(m) === fetchCat)).forEach(m => {
      if (fetchCat !== 'all' && fetchCat !== 'text') {
        let c = Providers.classifyModel(m, editMeta[m]); if (c === 'audio' || c === 'text') c = 'speech';
        const f = CAT_FIELD[c], cur = $(PE_FIELDS[f]).value.trim() === m;
        const el = document.createElement('div'); el.className = 'check-item' + (cur ? ' on' : '');
        el.innerHTML = '<span class="box">' + ICON.check + '</span><span class="cl-name">' + esc(m) + modelInfoLine(m) + '</span><span class="cl-tag">' +
          esc(Providers.MODEL_CATEGORIES.find(x => x.key === c).label) + '</span>';
        el.onclick = () => { $(PE_FIELDS[f]).value = m; toast('已设为' + Providers.MODEL_CATEGORIES.find(x => x.key === c).label + '模型，记得保存'); renderFetchList(); renderFieldPrices(); };
        box.appendChild(el); return;
      }
      const had = editModels.includes(m);
      const el = document.createElement('div'); el.className = 'check-item' + (fetchSel.has(m) || had ? ' on' : '');
      el.innerHTML = '<span class="box">' + ICON.check + '</span><span class="cl-name">' + esc(m) + modelInfoLine(m) + '</span>' + (had ? '<span class="cl-tag">已添加</span>' : '');
      if (!had) el.onclick = () => { fetchSel.has(m) ? fetchSel.delete(m) : fetchSel.add(m); renderFetchList(); };
      box.appendChild(el);
    });
    $('#fetch-ok').textContent = fetchSel.size ? '添加所选（' + fetchSel.size + '）' : '添加所选';
  }
  function closeFetch() { $('#fetch-sheet').classList.remove('show'); $('#fetch-mask').classList.remove('show'); }
  $('#fetch-search').addEventListener('input', renderFetchList);
  $('#fetch-all').onclick = () => {
    const q = $('#fetch-search').value.trim().toLowerCase();
    if (fetchCat !== 'all' && fetchCat !== 'text') return;
    fetched.filter(m => (!q || m.toLowerCase().includes(q)) && (fetchCat === 'all' || catOf(m) === fetchCat) && !editModels.includes(m)).forEach(m => fetchSel.add(m));
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
    const text = Templates.fill(tpl.content, values, { dropEmpty: !!tpl.builtin }); // 内置模板：留空的变量行 / 分段省略
    if (text === (conv.systemPrompt || '') && conv.templateId === tpl.id) { closeTemplateSheet(); toast('已经在使用「' + tpl.name + '」'); return false; }
    if (rpOn(conv) && !(await dialog({ title: '切换为「' + tpl.name + '」？', body: RP_WARN, okText: '切换' }))) return false;
    setConvSystem(text, tpl, { kind: 'template', name: tpl.name });
    if (!String(tpl.id).startsWith('persona:')) { settings.recentTemplates = Templates.pushRecent(settings.recentTemplates, tpl.id, 5); saveSettings(); }
    closeTemplateSheet();
    // v0.7.8：Skill 无变量，套用后直接引导在输入框说话
    if (tpl.skill || tpl.id === Templates.CARD_SKILL_ID) {
      toast('已启用「' + tpl.name + '」：直接发一句想法或贴旧设定；之后可说「精修一下」「加秘密」等');
      const inp = $('#input'); if (inp) { inp.placeholder = '发一句角色想法，或贴旧设定 / 说「精修一下」…'; setTimeout(() => inp.focus(), 80); }
    } else toast('已切换为「' + tpl.name + '」' + (conv.messages.length ? '，从下一条消息开始生效' : ''));
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
      const long = /设定|背景|场景|信息|规则|禁止|风格|想法|重点|保留|要求|偏好/.test(v); // v0.7.6/0.7.7：长内容用多行输入
      const ph = v === '模式' ? '一句话生成 或 逐步问答' : v === '想法' ? '一句话角色 / 故事想法，可留空后在聊天里说' : '填写' + v;
      l.innerHTML = '<span>' + esc(v) + (tpl.builtin ? '<small>可留空' + (long ? '，留空时整段省略' : '') + '</small>' : '') + '</span>' +
        (long ? '<textarea rows="3" data-var="' + esc(v) + '" placeholder="' + esc(ph) + '"></textarea>' : '<input data-var="' + esc(v) + '" placeholder="' + esc(ph) + '">');
      l.querySelector('[data-var]').value = last[v] || '';
      box.appendChild(l);
    });
    if (tpl.builtin && (tpl.tags || []).indexOf('角色扮演') >= 0 && rpOn(conv)) {
      const h = document.createElement('div'); h.className = 'hint';
      h.textContent = '本对话已启用 RP 缓存优化器：角色设定 / 世界背景等长内容更建议写进「分层设定」的角色卡 / 世界观块（缓存更稳），这里可以留空，避免同一段设定发送两遍。';
      box.appendChild(h);
    }
    const preview = () => { const vals = collectVars(); $('#tv-preview').textContent = Templates.fill(tpl.content, vals, { dropEmpty: !!tpl.builtin }).slice(0, 200); };
    box.querySelectorAll('[data-var]').forEach(i => i.addEventListener('input', preview)); preview();
    $('#tv-mask').classList.add('show');
    setTimeout(() => { const f = box.querySelector('[data-var]'); if (f) f.focus(); }, 80);
    return new Promise(res => { varResolve = vals => { if (vals) { settings.templateVars = Object.assign({}, settings.templateVars, { [tpl.id]: vals }); saveSettings(); } res(vals); }; });
  }
  function collectVars() { const o = {}; $('#tv-fields').querySelectorAll('[data-var]').forEach(i => { o[i.dataset.var] = i.value; }); return o; }
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
      (t.skill ? '<span class="tpl-skill">Skill</span>' : '') +
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
    $('#template-count').textContent = templates.length + ' 个模板';
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
    saveConv: c => saveConvSoon(c || conv),
    store: { get: (n, d) => Store.get(n, d), set: (n, v) => Store.set(n, v), del: n => Store.del(n),
      append: (n, v) => Store.append(n, v), readJsonl: n => Store.readJsonl(n), writeJsonl: (n, v) => Store.writeJsonl(n, v) },
    toast, dialog, esc,
    /** v0.7.8：一键启用角色卡 Skill（无变量模板） */
    applyCardSkill: () => { const t = templates.find(x => x.id === Templates.CARD_SKILL_ID) || templates.find(x => x.skill); return t ? applyTemplate(t) : (toast('未找到角色卡 Skill'), false); },
    /** 当前打开的对话（插件判断后台任务完成时是否刷新界面） */
    isCurrent: c => c === conv,
    refresh: () => { if (conv) { renderHeader(); renderMessages(); } },
    openPanel: (id, tab) => openPluginPanel(id, tab),
    expandTextarea: (ta, title, hint) => expandTextarea(ta, title, hint ? () => hint : null),
    /** 对话所用的服务商（插件判断适用性） */
    provider: c => getProvider((c || conv).providerId) || null,
    /** 与发送时相同的消息展开（文件内容等；不含本轮联网搜索），供插件界面估算与实际发送对齐 */
    requestItems: c => (c || conv).messages.filter(m => !m.error && !m.imageGen && !m.pending).map(m => Object.assign(toRequestMsg(m, false), { _src: m })),
    /** 用当前对话的模型做一次非流式调用，返回文本 */
    async callModel(prompt, o) {
      o = o || {};
      const cv = o.conv || conv; // v0.7.5：后台调用固定在发起时的对话（切换对话不串）
      const p = getProvider(cv.providerId);
      if (!hasKey(p)) throw new Error('请先为本对话选择已配置 API Key 的服务商');
      const model = o.model || cv.model;
      // 摘要等后台调用：千问关闭思考模式（enable_thinking=false）省钱省时；其他服务商不受影响
      const req = authed(Providers.buildChatRequest(p, model, [{ role: 'user', content: prompt }], '', { stream: false, temperature: 0.3, maxTokens: o.maxTokens || 4096, thinking: false, jsonMode: !!o.jsonMode }), p.id);
      const r = await requestText(req, o.setCancel || null, o.timeoutMs || 180000);
      if (r.status >= 400 || !r.status) throw new Error(Providers.parseError(r.status, r.text));
      const ds = Providers.parseFullResponse(p.type, r.text);
      const err = ds.find(d => d.kind === 'error'); if (err) throw new Error(err.text);
      let usage = null;
      ds.forEach(d => { if (d.kind === 'usage') usage = Providers.mergeUsage(usage, d.usage); });
      if (usage) recordUsage({ usage, type: o.usageType || 'summary', conv: cv, provider: p, model, at: Date.now() });
      return ds.filter(d => d.kind === 'text').map(d => d.text).join('');
    },
  };
  Plugins.registry.setHost(pluginHost); // 插件自动启用（autoActive）需要查询对话的服务商
  function pluginSummary() {
    const on = Plugins.registry.all().filter(pl => Plugins.registry.isGloballyEnabled(pl.id, settings)).length;
    return Plugins.registry.all().length + ' 个内置插件 · 已启用 ' + on;
  }
  function pluginSummaryShort() {
    const on = Plugins.registry.all().filter(pl => Plugins.registry.isGloballyEnabled(pl.id, settings)).length;
    return '已启用 ' + on;
  }
  function openPlugins() { closeDrawer(); renderPluginList(); $('#page-plugins').classList.add('show'); }
  function closePlugins() { $('#page-plugins').classList.remove('show'); renderAll(); }
  function renderPluginList() {
    const box = $('#plugin-list'); box.innerHTML = '';
    Plugins.registry.all().forEach(pl => {
      const on = Plugins.registry.isGloballyEnabled(pl.id, settings);
      const card = document.createElement('div'); card.className = 'plugin-card' + (on ? ' on' : '');
      card.innerHTML = '<div class="plc-head"><span class="plc-icon">' + esc(pl.icon) + '</span><div class="plc-main"><div class="plc-name">' + esc(pl.name) +
        '<span class="plc-ver">版本 ' + esc(pl.version) + ' · 内置</span></div><div class="plc-desc">' + esc(pl.desc) + '</div></div>' +
        '<input type="checkbox" class="switch" aria-label="启用"' + (on ? ' checked' : '') + '></div>' +
        '<div class="plc-foot">' + (pl.perConversation ? '<span class="plc-note">需在每个对话中单独开启</span>' : '<span class="plc-note">对所有对话生效，可在对话中关闭</span>') +
        (pl.renderPanel ? '<button class="chip-btn accent plc-open">当前对话 ›</button>' : '') + (pl.renderSettings ? '<button class="chip-btn plc-set">设置</button>' : '') + '</div>' +
        '<div class="plc-settings" hidden></div>';
      card.querySelector('.switch').onchange = e => {
        Plugins.registry.setGlobal(settings, pl.id, e.target.checked); saveSettings();
        card.classList.toggle('on', e.target.checked); $('#plugin-count').textContent = pluginSummaryShort(); $('#set-plugins-sub').textContent = pluginSummary();
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
  $('#btn-imagegen-page').onclick = () => { closeDrawer(); setTimeout(() => openImageGen(), 120); };
  $('#btn-usage').onclick = () => { closeDrawer(); setTimeout(openUsage, 120); };
  $('#set-usage').onclick = () => openUsage();
  $('#us-more').onclick = () => usageMore();
  $('#btn-balance').onclick = () => { closeDrawer(); setTimeout(openBalance, 120); };
  $('#set-balance').onclick = () => openBalance();
  $('#bal-refresh').onclick = () => refreshBalances();

  // ---------------- 返回键 ----------------
  // 长文本框：全屏编辑按钮
  expandTextarea($('#sheet-system'), '本对话系统提示词', () => (rpOn(conv) ? '本对话开启了 RP 缓存优化：修改系统提示词会改变 L1 固定前缀，下一轮缓存命中率会下降一次。' : '只影响当前对话。完成后点「确定」生效。'));
  expandTextarea($('#set-system'), '默认系统提示词', () => '新对话默认使用（未设置默认模板时）。');
  expandTextarea($('#te-content'), '模板 · 系统提示词', () => '可以用 {{变量名}} 插入变量，应用模板时会提示填写。完成后点「保存」。');
  expandTextarea($('#ps-prompt'), '助手 · 系统提示词', () => '描述助手的身份、任务、语气和输出格式。完成后点「保存」。');
  expandTextarea($('#pe2-content'), '提示词内容', () => '插入到输入框的文字。');
  // 输入框内容较长时，右上角出现「全屏编辑」
  (function () {
    const card = $('#composer-card');
    const b = document.createElement('button'); b.type = 'button'; b.id = 'btn-expand-input'; b.className = 'ta-expand input-expand'; b.setAttribute('aria-label', '全屏编辑'); b.innerHTML = EXPAND_ICON;
    card.appendChild(b);
    b.onclick = async () => {
      const r = await openEditor({ title: '编辑输入', value: input.value, placeholder: '给 AI 发消息…', actions: [{ key: 'ok', text: '完成' }, { key: 'send', text: '发送', primary: true }] });
      if (!r) return;
      input.value = r.text; input.dispatchEvent(new Event('input'));
      if (r.key === 'send') send();
    };
  })();

  window.onAndroidBack = function () {
    const shown = s => $(s).classList.contains('show');
    if (shown('#viewer')) { closeViewer(); return true; }
    if (shown('#dialog-mask')) { closeDialog(null); return true; }
    if (shown('#editor')) { closeEditor(null); return true; }
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
    if (shown('#page-balance')) { closeBalance(); return true; }
    if (shown('#page-imagegen')) { closeImageGen(); return true; }
    if (shown('#page-usage')) { closeUsage(); return true; }
    if (shown('#page-plugins')) { closePlugins(); return true; }
    if (shown('#page-persona')) { closePersonaEdit(); return true; }
    if (shown('#page-personas')) { closePersonas(); return true; }
    if (shown('#page-provider')) { closeProviderEdit(); return true; }
    if (shown('#page-settings')) { closeSettings(); return true; }
    if (shown('#drawer')) { closeDrawer(); return true; }
    return false;
  };



  // ---------------- 账户余额页 ----------------
  let balanceCache = Store.get('balance-cache.json', {}) || {}; // { [providerId]: { at, result } }
  const saveBalanceCache = () => Store.set('balance-cache.json', balanceCache);
  function updateBalanceSubtitle() {
    const el = $('#balance-count'); if (!el) return;
    const n = configured().length;
    const ok = Object.values(balanceCache).filter(x => x && x.result && x.result.ok).length;
    el.textContent = n ? (ok ? ok + '/' + n + ' 已查询' : n + ' 个服务商') : '未配置 Key';
    const sub = $('#set-balance-sub');
    if (sub) sub.textContent = n ? ('已配置 ' + n + ' 个服务商' + (ok ? ' · ' + ok + ' 个有余额数据' : '')) : '填写 API Key 后可查询';
  }
  function openBalance() {
    closeDrawer();
    if ($('#page-settings').classList.contains('show')) closeSettings();
    renderBalancePage();
    $('#page-balance').classList.add('show');
    // 自动刷新过期（>30 分钟）或从未查询的
    const stale = configured().filter(p => {
      const c = balanceCache[p.id];
      return !c || !c.at || (Date.now() - c.at > 30 * 60 * 1000);
    });
    if (stale.length) setTimeout(() => refreshBalances(stale.map(p => p.id)), 200);
  }
  function closeBalance() { $('#page-balance').classList.remove('show'); updateBalanceSubtitle(); }
  function renderBalancePage() {
    const box = $('#bal-body'); if (!box) return;
    const list = configured();
    if (!list.length) {
      box.innerHTML = '<div class="bal-empty">还没有配置带 API Key 的服务商。<br>去「设置」里填写 Key 后再来查看余额。</div>' +
        '<div style="text-align:center"><button class="chip-btn accent" id="bal-go-set">打开设置</button></div>';
      const b = box.querySelector('#bal-go-set'); if (b) b.onclick = () => { closeBalance(); openSettings(); };
      return;
    }
    let html = '<div class="bal-hint">支持官方余额接口的服务商可一键查询；其余显示「不支持查询」并提供控制台链接。不会在界面或日志中展示完整 API Key。</div>';
    list.forEach(p => {
      const info = Balance.supportInfo(p.presetId);
      const cached = balanceCache[p.id];
      const r = cached && cached.result;
      let amt = '', amtCls = 'muted', details = '', actions = '';
      if (!info.supported) {
        amt = '不支持查询'; amtCls = 'muted';
        actions = info.consoleUrl ? '<button class="chip-btn bal-console" data-url="' + esc(info.consoleUrl) + '">打开控制台</button>' : '';
      } else if (cached && cached.loading) {
        amt = '查询中…'; amtCls = 'muted';
      } else if (r && r.ok) {
        amt = r.primary ? r.primary.text : '—'; amtCls = '';
        if (r.details && r.details.length) {
          details = '<div class="bal-details">' + r.details.map(d =>
            '<div class="bal-d"><span>' + esc(d.label) + '</span><b>' + esc(d.text) + '</b></div>').join('') + '</div>';
        }
        const when = cached.at ? new Date(cached.at) : null;
        const tstr = when ? (when.getMonth() + 1) + '/' + when.getDate() + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0') : '';
        actions = '<button class="chip-btn bal-one" data-id="' + esc(p.id) + '">刷新</button>' +
          (info.consoleUrl ? '<button class="chip-btn bal-console" data-url="' + esc(info.consoleUrl) + '">控制台</button>' : '') +
          (tstr ? '<span class="bal-sub" style="margin-left:auto">更新于 ' + tstr + '</span>' : '');
      } else if (r && r.unsupported) {
        amt = '不支持查询'; amtCls = 'muted';
        actions = (r.consoleUrl || info.consoleUrl) ? '<button class="chip-btn bal-console" data-url="' + esc(r.consoleUrl || info.consoleUrl) + '">打开控制台</button>' : '';
      } else if (r && r.error) {
        amt = r.error; amtCls = 'err';
        actions = '<button class="chip-btn bal-one" data-id="' + esc(p.id) + '">重试</button>' +
          (info.consoleUrl ? '<button class="chip-btn bal-console" data-url="' + esc(info.consoleUrl) + '">控制台</button>' : '');
      } else {
        amt = '尚未查询'; amtCls = 'muted';
        actions = '<button class="chip-btn bal-one" data-id="' + esc(p.id) + '">查询</button>' +
          (info.consoleUrl ? '<button class="chip-btn bal-console" data-url="' + esc(info.consoleUrl) + '">控制台</button>' : '');
      }
      html += '<div class="bal-card" data-pid="' + esc(p.id) + '"><div class="bal-top">' + avatarHtml(p, 'lg') +
        '<div style="min-width:0"><div class="bal-name">' + esc(p.name) + '</div>' +
        '<div class="bal-sub">' + esc(p.presetId || p.type) + (info.supported ? ' · 可查询' : '') + '</div></div>' +
        '<div class="bal-amt ' + amtCls + '">' + esc(amt) + '</div></div>' + details +
        (actions ? '<div class="bal-actions">' + actions + '</div>' : '') + '</div>';
    });
    // 列出无 Key 但已有预设的，提示可去设置
    const noKey = settings.providers.filter(p => p.presetId !== 'custom' && !hasKey(p));
    if (noKey.length) {
      html += '<div class="group-title">未填写 API Key</div><div class="hint">在设置中为 ' +
        noKey.slice(0, 4).map(p => esc(p.name)).join('、') + (noKey.length > 4 ? ' 等' : '') + ' 填写 Key 后即可出现在上方。</div>';
    }
    box.innerHTML = html;
    box.querySelectorAll('.bal-console').forEach(b => b.onclick = () => openUrl(b.dataset.url));
    box.querySelectorAll('.bal-one').forEach(b => b.onclick = () => refreshBalances([b.dataset.id]));
  }
  async function refreshBalances(ids) {
    const targets = (ids && ids.length) ? configured().filter(p => ids.includes(p.id)) : configured();
    if (!targets.length) { toast('没有可查询的服务商'); return; }
    const btn = $('#bal-refresh'); if (btn) btn.disabled = true;
    targets.forEach(p => {
      balanceCache[p.id] = Object.assign({}, balanceCache[p.id], { loading: true });
    });
    renderBalancePage();
    await Promise.all(targets.map(async p => {
      const info = Balance.supportInfo(p.presetId);
      if (!info.supported) {
        balanceCache[p.id] = { at: Date.now(), result: { ok: false, unsupported: true, error: info.hint, consoleUrl: info.consoleUrl } };
        return;
      }
      const req = Balance.buildBalanceRequest(p);
      if (!req) {
        balanceCache[p.id] = { at: Date.now(), result: { ok: false, error: '无法构造请求', consoleUrl: info.consoleUrl } };
        return;
      }
      try {
        const r = await httpSimple(authed(req, p.id));
        const parsed = Balance.parseBalanceResponse(p.presetId, r.status, r.text);
        balanceCache[p.id] = { at: Date.now(), result: parsed };
      } catch (e) {
        balanceCache[p.id] = { at: Date.now(), result: { ok: false, error: '网络错误：' + (e && e.message || e), consoleUrl: info.consoleUrl } };
      }
    }));
    saveBalanceCache();
    if (btn) btn.disabled = false;
    if ($('#page-balance').classList.contains('show')) renderBalancePage();
    updateBalanceSubtitle();
  }

  // ---------------- 用量统计页 ----------------
  let usRange = '30d', usTab = 'day', usCustom = null;
  const usFmtN = n => (n == null ? '—' : n >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e5 ? 1 : 2).replace(/\.?0+$/, '') + '万' : String(Math.round(n)));
  const usFmtUsd = v => (v == null ? '—' : '$' + (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(3)));
  // ---------------- 生图页 ----------------
  // 独立于聊天顶栏：settings.imageGenProviderId / imageGenModel
  // 聊天输入框「图片模式」(#btn-imagegen) 仍用当前对话服务商，见 generateImage(currentProvider)
  let igResults = [];
  let igRefs = [];
  let igRunning = null;
  let igUiSyncing = false;
  function imageCapableProviders() {
    return ImageGen.listImageProviders(settings.providers);
  }
  function resolveImageModel(provider) {
    return ImageGen.effectiveModel(provider, settings.imageGenModel);
  }
  function resolveImageProvider() {
    const id = (settings.imageGenProviderId || '').trim();
    if (id) {
      const p = getProvider(id);
      if (p && p.type === 'openai') return p;
    }
    const list = imageCapableProviders();
    const withKey = list.filter(hasKey);
    const prefer = withKey.find(p => (p.imageModel || '').trim()) || withKey[0] || list[0] || null;
    if (prefer && !id) {
      settings.imageGenProviderId = prefer.id;
      if (!(settings.imageGenModel || '').trim() && (prefer.imageModel || '').trim())
        settings.imageGenModel = prefer.imageModel;
      saveSettings();
    }
    return prefer;
  }
  function fillImageSizeSelect(preferred) {
    const sel = $('#ig-size'); if (!sel) return;
    const want = ImageGen.normalizeSize(preferred || settings.imageSize || ImageGen.DEFAULT_SIZE);
    const sizes = ImageGen.SIZES.slice();
    if (want && !sizes.includes(want)) sizes.unshift(want);
    const p = resolveImageProvider();
    const model = resolveImageModel(p);
    const flux = ImageGen.isFluxTierModel(model, p);
    sel.innerHTML = sizes.map(s => {
      const label = ImageGen.sizeOptionLabel(s, flux);
      return '<option value="' + esc(s) + '"' + (s === want ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
    const hint = $('#ig-size-hint');
    if (hint) {
      hint.textContent = flux
        ? 'FLUX 3 使用分辨率档位 + 宽高比（已自动转换）'
        : '默认取自设置里的「生成图片尺寸」';
    }
  }
  function fillImageGenControls() {
    const sel = $('#ig-provider-sel');
    const modelEl = $('#ig-model');
    if (!sel || !modelEl) return;
    igUiSyncing = true;
    const list = imageCapableProviders();
    const cur = resolveImageProvider();
    const curId = cur ? cur.id : '';
    if (!list.length) {
      sel.innerHTML = '<option value="">（无 OpenAI 兼容服务商）</option>';
    } else {
      sel.innerHTML = list.map(p => {
        const label = esc(p.name || p.id) + (hasKey(p) ? '' : '（未填 Key）');
        return '<option value="' + esc(p.id) + '"' + (p.id === curId ? ' selected' : '') + '>' + label + '</option>';
      }).join('');
      if (curId) sel.value = curId;
    }
    const model = (settings.imageGenModel || '').trim() || (cur && cur.imageModel) || '';
    modelEl.value = model;
    if (!(settings.imageGenModel || '').trim() && model) {
      settings.imageGenModel = model;
    }
    igUiSyncing = false;
    fillImageSizeSelect($('#ig-size') && $('#ig-size').value);
    refreshImageGenMeta();
  }
  function persistImageGenSelection() {
    if (igUiSyncing) return;
    const sel = $('#ig-provider-sel');
    const modelEl = $('#ig-model');
    if (sel) settings.imageGenProviderId = sel.value || '';
    if (modelEl) settings.imageGenModel = (modelEl.value || '').trim();
    saveSettings();
    fillImageSizeSelect($('#ig-size') && $('#ig-size').value);
    refreshImageGenMeta();
  }
  function onImageGenProviderChange() {
    if (igUiSyncing) return;
    const sel = $('#ig-provider-sel');
    const modelEl = $('#ig-model');
    const pid = sel ? sel.value : '';
    settings.imageGenProviderId = pid;
    const p = getProvider(pid);
    // 切换服务商时，用其默认 imageModel 覆盖当前模型栏（便于快速切换）
    const next = p && (p.imageModel || '').trim() ? p.imageModel.trim() : '';
    if (modelEl) modelEl.value = next;
    settings.imageGenModel = next;
    saveSettings();
    fillImageSizeSelect($('#ig-size') && $('#ig-size').value);
    refreshImageGenMeta();
  }
  function refreshImageGenMeta() {
    const el = $('#ig-provider-status'); if (!el) return;
    const p = resolveImageProvider();
    const model = resolveImageModel(p);
    const check = ImageGen.canGenerate(p, model);
    if (!p) { el.textContent = '请添加 OpenAI 兼容服务商并填写 API Key'; el.className = 'ig-provider warn'; }
    else if (!check.ok) { el.textContent = (p.name || '服务商') + ' · ' + check.reason; el.className = 'ig-provider warn'; }
    else { el.textContent = '将使用：' + p.name + ' · ' + model; el.className = 'ig-provider'; }
    const btn = $('#ig-generate');
    if (btn) btn.disabled = !!igRunning || !check.ok;
  }
  function renderImageGenResults() {
    const box = $('#ig-results'); if (!box) return;
    box.innerHTML = '';
    if (!igResults.length) {
      box.innerHTML = '<div class="ig-empty">生成的图片会出现在这里</div>';
      return;
    }
    igResults.forEach((src, idx) => {
      const card = document.createElement('div'); card.className = 'ig-card';
      const img = document.createElement('img'); img.src = src; img.alt = '生成图片 ' + (idx + 1);
      img.onclick = () => openViewer(src);
      const actions = document.createElement('div'); actions.className = 'ig-actions';
      const save = document.createElement('button'); save.type = 'button'; save.textContent = '保存';
      save.onclick = () => saveGeneratedImage(src);
      const toChat = document.createElement('button'); toChat.type = 'button'; toChat.textContent = '插入对话';
      toChat.onclick = () => insertImageToChat(src, $('#ig-prompt').value.trim());
      actions.appendChild(save); actions.appendChild(toChat);
      card.appendChild(img); card.appendChild(actions);
      box.appendChild(card);
    });
  }
  function setImageGenStatus(text, cls) {
    const el = $('#ig-status'); if (!el) return;
    el.textContent = text || '';
    el.className = 'hint small' + (cls ? ' ' + cls : '');
  }
  let igProgressTimer = null;
  function clearImageGenProgressTimer() {
    if (igProgressTimer) { clearInterval(igProgressTimer); igProgressTimer = null; }
  }
  function setImageGenProgressVisible(on) {
    const box = $('#ig-progress');
    if (!box) return;
    if (on) box.removeAttribute('hidden');
    else box.setAttribute('hidden', '');
  }
  function updateImageGenProgressUI(elapsedMs, flags) {
    const stage = ImageGen.progressStage(elapsedMs, flags || {});
    const textEl = $('#ig-progress-text');
    const elEl = $('#ig-progress-elapsed');
    if (textEl) textEl.textContent = stage.text;
    if (elEl) elEl.textContent = ImageGen.formatElapsed(elapsedMs);
    setImageGenStatus(stage.text, 'busy');
  }
  function beginImageGenProgress() {
    clearImageGenProgressTimer();
    setImageGenProgressVisible(true);
    const startedAt = Date.now();
    const flags = { httpStarted: false, receiving: false };
    updateImageGenProgressUI(0, flags);
    igProgressTimer = setInterval(() => updateImageGenProgressUI(Date.now() - startedAt, flags), 400);
    return {
      startedAt,
      flags,
      markHttp() { flags.httpStarted = true; updateImageGenProgressUI(Date.now() - startedAt, flags); },
      markReceiving() { flags.receiving = true; updateImageGenProgressUI(Date.now() - startedAt, flags); },
      stop() { clearImageGenProgressTimer(); setImageGenProgressVisible(false); },
    };
  }
  function saveGeneratedImage(src) {
    if (!src) return;
    if (bridge && bridge.saveImage) { bridge.saveImage(src); toast('正在保存…'); }
    else {
      const a = document.createElement('a'); a.href = src; a.download = 'ai-chat-' + Date.now() + '.png'; a.click();
      toast('已开始下载');
    }
  }
  function insertImageToChat(src, prompt) {
    if (!conv) newConv();
    const p = resolveImageProvider();
    const model = resolveImageModel(p);
    const user = { id: uid(), role: 'user', content: prompt || '（生图页插入）', imageGen: true, createdAt: Date.now() };
    const bot = { id: uid(), role: 'assistant', content: '', imageGen: true, images: [src],
      model: (model ? model + ' · 生成图片' : '生成图片'), createdAt: Date.now() };
    conv.messages.push(user, bot);
    if (conv.title === '新对话') conv.title = '🎨 ' + (prompt || '生图').slice(0, 20);
    saveConv(conv); renderMessages(); renderConvList();
    toast('已插入当前对话');
  }
  function stopImageGenPage() {
    if (!igRunning) return;
    try { igRunning.cancel && igRunning.cancel(); } catch (_) {}
    if (igRunning.progress) igRunning.progress.stop();
    igRunning = null;
    $('#ig-generate').style.display = '';
    $('#ig-stop').style.display = 'none';
    setImageGenProgressVisible(false);
    setImageGenStatus('已停止', '');
    refreshImageGenMeta();
  }
  function runImageGenPage() {
    if (igRunning) return;
    persistImageGenSelection();
    const prompt = ($('#ig-prompt').value || '').trim();
    if (!prompt) { toast('请输入图片描述'); return; }
    const p = resolveImageProvider();
    const model = resolveImageModel(p);
    const check = ImageGen.canGenerate(p, model);
    if (!check.ok) { toast(check.reason); refreshImageGenMeta(); return; }
    const size = ImageGen.normalizeSize($('#ig-size').value || settings.imageSize);
    settings.imageSize = size; saveSettings();
    let status = 0, raw = '';
    if (igRefs.length > 1) toast('当前仅使用第一张参考图');
    const req = authed(ImageGen.buildRequest(p, prompt, size, model, { images: igRefs.slice() }), p.id);
    const progress = beginImageGenProgress();
    $('#ig-generate').style.display = 'none';
    $('#ig-stop').style.display = '';
    const h = httpRequest(req, {
      onStatus: s => { status = s; progress.markHttp(); },
      onChunk: t => { raw += t; progress.markReceiving(); },
    });
    igRunning = { cancel: h.cancel, progress: progress };
    refreshImageGenMeta();
    h.promise.then(() => {
      if (!igRunning) return;
      if (status >= 400 || !status) { setImageGenStatus(Providers.parseError(status, raw), 'err'); return; }
      try {
        const imgs = ImageGen.parseResponse(raw);
        if (!imgs.length) { setImageGenStatus('未返回图片：' + raw.slice(0, 200), 'err'); return; }
        igResults = imgs.concat(igResults).slice(0, 24);
        renderImageGenResults();
        setImageGenStatus('已生成 ' + imgs.length + ' 张（' + model + ' · ' + ImageGen.formatElapsed(Date.now() - progress.startedAt) + '）', '');
        try {
          const obj = JSON.parse(raw);
          const u = Providers.normalizeUsage(p.type, obj.usage || obj.meta || null);
          if (u && conv) recordUsage({ usage: u, type: 'image', conv, provider: p, model: model, msgId: null, at: Date.now() });
        } catch (_) {}
      } catch (e) { setImageGenStatus('无法解析响应：' + raw.slice(0, 200), 'err'); }
    }).catch(e => { if (igRunning) setImageGenStatus('网络错误：' + e.message, 'err'); })
      .finally(() => {
        if (igRunning && igRunning.progress) igRunning.progress.stop();
        else { clearImageGenProgressTimer(); setImageGenProgressVisible(false); }
        igRunning = null;
        $('#ig-generate').style.display = '';
        $('#ig-stop').style.display = 'none';
        refreshImageGenMeta();
      });
  }
  function openImageGen(prefill) {
    fillImageSizeSelect(settings.imageSize);
    fillImageGenControls();
    if (typeof prefill === 'string' && prefill.trim()) $('#ig-prompt').value = prefill.trim();
    renderImageGenResults();
    clearImageGenProgressTimer();
    setImageGenProgressVisible(false);
    setImageGenStatus('', '');
    $('#page-imagegen').classList.add('show');
  }
  function closeImageGen() {
    if (igRunning) stopImageGenPage();
    persistImageGenSelection();
    $('#page-imagegen').classList.remove('show');
  }
  function openImageGenFromChat(anchorMsg) {
    const msgs = (conv && conv.messages) || [];
    let prompt = ImageGen.buildPromptFromMessages(msgs);
    if (!prompt && anchorMsg && String(anchorMsg.content || '').trim()) {
      prompt = '根据以下内容生成一张配图：\n' + String(anchorMsg.content).replace(/\s+/g, ' ').trim().slice(0, 500);
    }
    openImageGen(prompt || '');
    if (!prompt) toast('当前对话没有可用于生图的文字，请自行填写提示词');
  }
  function renderIgRefs() {
    const box = $('#ig-refs'); if (!box) return;
    box.innerHTML = '';
    igRefs.forEach((src, i) => {
      const t = document.createElement('div'); t.className = 'thumb';
      t.innerHTML = '<img src="' + src + '"><button class="rm" aria-label="移除">×</button>';
      t.querySelector('.rm').onclick = () => { igRefs.splice(i, 1); renderIgRefs(); };
      box.appendChild(t);
    });
  }
  if ($('#ig-pick-refs')) $('#ig-pick-refs').onclick = () => $('#ig-file').click();
  if ($('#ig-file')) $('#ig-file').onchange = async e => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const f of files) {
      try { igRefs.push(await compressImage(f)); } catch (err) { toast('图片读取失败'); }
    }
    renderIgRefs();
  };
  $('#ig-generate').onclick = () => runImageGenPage();
  $('#ig-stop').onclick = () => stopImageGenPage();
  if ($('#ig-provider-sel')) $('#ig-provider-sel').onchange = () => onImageGenProviderChange();
  if ($('#ig-model')) {
    $('#ig-model').addEventListener('change', () => persistImageGenSelection());
    $('#ig-model').addEventListener('blur', () => persistImageGenSelection());
  }

  function openUsage() {
    closeDrawer();
    if ($('#page-settings').classList.contains('show')) closeSettings();
    usRange = usRange || '30d'; usTab = usTab || 'day';
    renderUsagePage();
    $('#page-usage').classList.add('show');
  }
  function closeUsage() { $('#page-usage').classList.remove('show'); updateUsageSubtitle(); }
  function usageList() {
    const range = UsageStats.rangeOf(usRange, Date.now(), usCustom);
    return UsageStats.filterLog(usageState.log, range);
  }
  function renderUsagePage() {
    const box = $('#us-body'); if (!box) return;
    const list = usageList();
    const tot = UsageStats.sumList(list);
    const est = UsageStats.estimateCost(list, usageState.prices, usageState.priceMode);
    const ranges = [['today', '今天'], ['7d', '近7天'], ['30d', '近30天'], ['all', '全部'], ['custom', '自定义']];
    let html = '<div class="us-range">' + ranges.map(([k, t]) =>
      '<button type="button" class="chip' + (usRange === k ? ' active' : '') + '" data-ur="' + k + '">' + t + '</button>').join('') + '</div>';
    html += '<div class="us-cards">' +
      '<div class="us-card"><div class="us-k">总输入</div><div class="us-v">' + usFmtN(tot.prompt) + '</div></div>' +
      '<div class="us-card"><div class="us-k">总输出</div><div class="us-v">' + usFmtN(tot.completion) + '</div></div>' +
      '<div class="us-card"><div class="us-k">总 Token</div><div class="us-v">' + usFmtN(tot.total) + '</div><div class="us-s">' + tot.requests + ' 次请求</div></div>' +
      '<div class="us-card"><div class="us-k">缓存命中 / 未命中</div><div class="us-v" style="font-size:15px">' + usFmtN(tot.hit) + ' / ' + usFmtN(tot.miss) + '</div>' +
        '<div class="us-s">' + (tot.hit + tot.miss ? ('命中率 ' + Math.round(tot.hit / (tot.hit + tot.miss) * 1000) / 10 + '%') : '无缓存数据') + '</div></div>' +
      '<div class="us-card wide"><div class="us-k">估算花费</div><div class="us-v">' + usFmtUsd(est.cost) + '</div>' +
        '<div class="us-s">按当前价格表估算，仅供参考（DeepSeek 等）；非标价模型用「default」单价</div></div></div>';
    html += '<div class="us-price-note">价格：美元 / 百万 Token（高峰价）。可在下方「价格」里修改；若已在 RP 缓存插件里改过 DeepSeek 价格，启动时会自动同步。</div>';

    const tabs = [['day', '按天'], ['model', '按模型'], ['provider', '按服务商'], ['conv', '按对话'], ['recent', '最近请求'], ['prices', '价格']];
    html += '<div class="us-tabs">' + tabs.map(([k, t]) =>
      '<button type="button" class="chip' + (usTab === k ? ' active' : '') + '" data-ut="' + k + '">' + t + '</button>').join('') + '</div>';

    if (!list.length && usTab !== 'prices') {
      html += '<div class="us-empty">这段时间还没有用量记录。<br>发送对话后，服务商返回的 Token 会自动记在这里。<br>升级前已有的用量会在首次打开时回填一次。</div>';
    } else if (usTab === 'day') {
      const days = UsageStats.byDay(list, usRange === '7d' ? 7 : 30);
      const max = Math.max(1, ...days.map(d => d.total));
      html += '<div class="group-title">近 ' + days.length + ' 天</div><div class="group"><div class="us-bars">' +
        days.map(d => '<div class="us-bar" title="' + d.key + '：' + d.total + '"><i style="height:' + Math.max(2, Math.round(d.total / max * 90)) + 'px"></i><span>' + d.label.slice(3) + '</span></div>').join('') +
        '</div></div>';
      html += '<div class="group">' + days.filter(d => d.requests).reverse().map(d =>
        '<div class="us-row"><div style="flex:1"><div class="us-name">' + d.key + '</div><div class="us-meta">' + d.requests + ' 次 · 入 ' + usFmtN(d.prompt) + ' · 出 ' + usFmtN(d.completion) + '</div></div>' +
        '<div class="us-num">' + usFmtN(d.total) + '</div></div>').join('') + '</div>';
    } else if (usTab === 'model' || usTab === 'provider' || usTab === 'conv') {
      const groups = usTab === 'model' ? UsageStats.groupBy(list, e => e.model || '（未知模型）')
        : usTab === 'provider' ? UsageStats.groupBy(list, e => e.providerName || e.providerId || '（未知）')
        : UsageStats.groupBy(list, e => e.convTitle || e.convId || '（无标题）').slice(0, 30);
      const max = Math.max(1, ...groups.map(g => g.total));
      html += '<div class="group">' + groups.map(g => {
        const jump = usTab === 'conv' && g.items[0] && g.items[0].convId
          ? ' data-cid="' + esc(g.items[0].convId) + '"' : '';
        return '<div class="us-row us-jump"' + jump + '><div style="flex:1;min-width:0"><div class="us-name">' + esc(g.key) + '</div>' +
          '<div class="us-meta">' + g.requests + ' 次 · 入 ' + usFmtN(g.prompt) + ' · 出 ' + usFmtN(g.completion) +
          (g.hit ? ' · 缓存 ' + usFmtN(g.hit) : '') + '</div>' +
          '<div class="us-meter"><i style="width:' + Math.round(g.total / max * 100) + '%"></i></div></div>' +
          '<div class="us-num">' + usFmtN(g.total) + '</div></div>';
      }).join('') + '</div>';
    } else if (usTab === 'recent') {
      const recent = list.slice().reverse().slice(0, 50);
      html += '<div class="group us-recent">' + recent.map(e => {
        const when = new Date(e.at);
        const tstr = (when.getMonth() + 1) + '/' + when.getDate() + ' ' + String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
        return '<div class="us-r us-jump" data-cid="' + esc(e.convId || '') + '"><div class="us-rt"><span>' + esc(UsageStats.TYPE_CN[e.type] || e.type) + ' · ' + esc(e.model || '—') +
          '</span><span>' + usFmtN(e.prompt + e.completion) + '</span></div>' +
          '<div class="us-rd">' + tstr + ' · ' + esc(e.providerName || e.providerId || '') + ' · ' + esc(e.convTitle || '') +
          ' · 入 ' + usFmtN(e.prompt) + ' / 出 ' + usFmtN(e.completion) +
          (e.cache ? ' · 缓存 ' + usFmtN(e.hit) : '') + '</div></div>';
      }).join('') + '</div>';
    } else if (usTab === 'prices') {
      const prices = usageState.prices;
      const row = (id, label) => {
        const p = prices[id] || { hit: 0, miss: 0, out: 0 };
        return '<div class="price-row"><span title="' + esc(id) + '">' + esc(label) + '</span>' +
          '<input type="number" step="0.001" min="0" data-m="' + id + '" data-k="hit" value="' + p.hit + '">' +
          '<input type="number" step="0.001" min="0" data-m="' + id + '" data-k="miss" value="' + p.miss + '">' +
          '<input type="number" step="0.001" min="0" data-m="' + id + '" data-k="out" value="' + p.out + '"></div>';
      };
      html += '<div class="pl-set-title">价格（美元 / 百万 Token，高峰价）</div>' +
        '<div class="price-row head"><span>模型</span><span>缓存命中</span><span>未命中/输入</span><span>输出</span></div>' +
        row('deepseek-flash', 'deepseek-flash') + row('deepseek-v4-pro', 'deepseek-v4-pro') + row('default', '其他模型') +
        '<label class="field" style="margin-top:10px"><span>时段</span><select id="us-price-mode">' +
        '<option value="auto">自动（按请求时间判断高峰/非高峰）</option><option value="peak">按高峰价</option><option value="offpeak">按非高峰价（半价）</option></select></label>' +
        '<button class="chip-btn" id="us-price-reset" type="button" style="margin-top:8px">恢复默认价格</button>' +
        '<div class="hint" style="margin-top:10px">DeepSeek 非高峰为半价；「其他模型」的「未命中/输入」用作整段输入单价。估算仅供参考，以服务商账单为准。</div>';
    }
    box.innerHTML = html;

    box.querySelectorAll('[data-ur]').forEach(b => b.onclick = async () => {
      const k = b.dataset.ur;
      if (k === 'custom') {
        const from = await dialog({ title: '自定义起点', body: '开始日期（YYYY-MM-DD）', input: true, value: new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10), okText: '下一步' });
        if (from == null || !String(from).trim()) return;
        const to = await dialog({ title: '自定义终点', body: '结束日期（YYYY-MM-DD）', input: true, value: new Date().toISOString().slice(0, 10), okText: '确定' });
        if (to == null || !String(to).trim()) return;
        const a = Date.parse(String(from).trim() + 'T00:00:00'), b2 = Date.parse(String(to).trim() + 'T00:00:00');
        if (!a || !b2) { toast('日期格式不对'); return; }
        usCustom = { from: Math.min(a, b2), to: Math.max(a, b2) }; usRange = 'custom';
      } else { usRange = k; }
      renderUsagePage();
    });
    box.querySelectorAll('[data-ut]').forEach(b => b.onclick = () => { usTab = b.dataset.ut; renderUsagePage(); });
    box.querySelectorAll('.us-jump[data-cid]').forEach(el => el.onclick = () => {
      const id = el.getAttribute('data-cid'); if (!id) return;
      closeUsage(); openConv(id); closeDrawer();
    });
    if (usTab === 'prices') {
      const mode = box.querySelector('#us-price-mode');
      if (mode) { mode.value = usageState.priceMode || 'auto'; mode.onchange = e => { usageState.priceMode = e.target.value; saveUsageMeta(); renderUsagePage(); }; }
      box.querySelectorAll('.price-row input').forEach(inp => {
        inp.onchange = () => {
          const v = parseFloat(inp.value); if (isNaN(v) || v < 0) { inp.value = usageState.prices[inp.dataset.m][inp.dataset.k]; return; }
          usageState.prices[inp.dataset.m] = Object.assign({}, usageState.prices[inp.dataset.m], { [inp.dataset.k]: v });
          saveUsageMeta();
        };
      });
      const rst = box.querySelector('#us-price-reset');
      if (rst) rst.onclick = () => { usageState.prices = Object.assign({}, UsageStats.DEFAULT_PRICES); saveUsageMeta(); renderUsagePage(); toast('已恢复默认价格'); };
    }
  }
  async function usageMore() {
    actionSheet('用量统计', [
      { label: '导出 CSV（复制）', icon: ICON.copy, onClick: () => { copyText(UsageStats.toCSV(usageList())); toast('已复制 CSV'); } },
      { label: '导出 JSON（复制）', icon: ICON.copy, onClick: () => { copyText(UsageStats.toJSON(usageList())); toast('已复制 JSON'); } },
      { label: '清空统计', icon: ICON.trash, danger: true, onClick: async () => {
        const ok = await dialog({ title: '清空用量统计？', body: '将删除本地保存的全部用量记录（不会影响对话内容）。此操作不可撤销。', okText: '清空', danger: true });
        if (!ok) return;
        usageState = UsageStats.clear(usageState); saveUsageStats(); renderUsagePage(); updateUsageSubtitle(); toast('已清空');
      }},
    ]);
  }

  // ---------------- 启动 ----------------
  saveSettings();
  if (!Store.get('personas.json', null)) savePersonas();
  if (!Store.get('prompts.json', null)) savePrompts();
  $('#persona-count').textContent = personas.length + ' 助手 · ' + prompts.length + ' 提示词';
  $('#plugin-count').textContent = pluginSummaryShort(); $('#set-plugins-sub').textContent = pluginSummary();
  $('#template-count').textContent = templates.length + ' 个模板';
  if (!Store.get('templates.json', null)) saveTemplates();
  backfillUsageStats();
  updateBalanceSubtitle();
  if (!(convIndex.length && openConv(convIndex[0].id))) newConv();
  renderSearchChip();
  updateSendState();
})();
