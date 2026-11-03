/* AI Chat 桌面版 —— Electron 主进程
 * 复用 Android 版的网页资源（app/src/main/assets/www），并在这里实现与 NativeBridge.java 相同的原生能力：
 * 网络请求（主进程发出，无 CORS，支持 SSE 流式）、本地文件存储、剪贴板、打开外部链接、读取内置资源、保存图片。
 * API Key 只存在本机用户数据目录，请求直接发往服务商；不写日志。
 */
'use strict';
const { app, BrowserWindow, ipcMain, protocol, net, shell, clipboard, dialog, Menu, nativeTheme, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_NAME = 'AI Chat';
const SCHEME = 'app';
const HOST = 'local';
const START_URL = `${SCHEME}://${HOST}/index.html`;
const WEB_DIR = path.join(__dirname, '..', 'web');
const DESKTOP_CSS = path.join(__dirname, 'desktop.css');

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('com.aichat.desktop');

// 测试 / 便携需要时可通过环境变量指定数据目录（默认：%APPDATA%\AI Chat）
if (process.env.AICHAT_USER_DATA) app.setPath('userData', path.resolve(process.env.AICHAT_USER_DATA));

// ---------------- 单实例 ----------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

let win = null;
let dataDir = null;

// ---------------- 本地静态资源（app://local/...） ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.bcmap': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

/** 给 index.html 打上桌面标记：<html class="desktop">、桌面样式表；把面向手机的两句说明改成「本机」 */
function patchIndexHtml(html) {
  return html
    .replace(/<html([^>]*)>/i, (m, attrs) => /class=/.test(attrs)
      ? m.replace(/class="([^"]*)"/, 'class="$1 desktop"')
      : `<html${attrs} class="desktop">`)
    .replace('</head>', '<link rel="stylesheet" href="/__desktop/desktop.css">\n</head>')
    .replace('请求由手机直接发往服务商', '请求由本机直接发往服务商')
    .replace('搜索请求同样由手机直接发出', '搜索请求同样由本机直接发出');
}

async function serveLocal(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response('Not found', { status: 404 });
  let rel = decodeURIComponent(url.pathname);
  let file;
  if (rel === '/__desktop/desktop.css') file = DESKTOP_CSS;
  else {
    if (rel === '/' || rel === '') rel = '/index.html';
    file = path.normalize(path.join(WEB_DIR, rel));
    if (file !== WEB_DIR && !file.startsWith(WEB_DIR + path.sep)) return new Response('Forbidden', { status: 403 });
  }
  try {
    let body = await fs.promises.readFile(file);
    const ext = path.extname(file).toLowerCase();
    if (file === path.join(WEB_DIR, 'index.html')) body = Buffer.from(patchIndexHtml(body.toString('utf8')), 'utf8');
    return new Response(body, { status: 200, headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' } });
  } catch (e) {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------- 存储（与 Android 一致：每个键一个文件，原子写入） ----------------
function storeFile(name) {
  const safe = String(name == null ? '' : name).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(dataDir, safe);
}
ipcMain.on('bridge:storeGet', (e, name) => {
  try { e.returnValue = fs.readFileSync(storeFile(name), 'utf8'); } catch (err) { e.returnValue = null; }
});
// v0.9.0：写临时文件 → 旧文件转 .bak（只留一份）→ 改名
ipcMain.on('bridge:storeSet', (e, name, value) => {
  const f = storeFile(name), tmp = f + '.tmp';
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, String(value == null ? '' : value), null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!/\.(jsonl|bak)$/.test(f) && fs.existsSync(f)) { try { fs.rmSync(f + '.bak', { force: true }); fs.renameSync(f, f + '.bak'); } catch (_) {} }
    fs.renameSync(tmp, f);
    e.returnValue = true;
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    e.returnValue = false;
  }
});
ipcMain.on('bridge:storeDelete', (e, name) => {
  try { fs.rmSync(storeFile(name), { force: true }); fs.rmSync(storeFile(name) + '.bak', { force: true }); } catch (_) {}
  e.returnValue = true;
});
ipcMain.on('bridge:storeExists', (e, name) => { e.returnValue = fs.existsSync(storeFile(name)); });
ipcMain.on('bridge:storeRename', (e, from, to) => {
  try { const a = storeFile(from), b = storeFile(to); if (!fs.existsSync(a)) { e.returnValue = false; return; } fs.renameSync(a, b); e.returnValue = true; }
  catch (_) { e.returnValue = false; }
});
ipcMain.on('bridge:storeList', e => {
  try { e.returnValue = JSON.stringify(fs.readdirSync(dataDir).filter(n => !n.endsWith('.tmp'))); } catch (_) { e.returnValue = '[]'; }
});
ipcMain.on('bridge:storeAppend', (e, name, text) => {
  try { fs.appendFileSync(storeFile(name), String(text == null ? '' : text), 'utf8'); e.returnValue = true; } catch (_) { e.returnValue = false; }
});

// ---------------- v0.9.0：密钥安全存储（safeStorage 加密，明文不回传页面） ----------------
const AUTH_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'x-subscription-token'];
function originOf(u) {
  try {
    const x = new URL(String(u || '').trim());
    if ((x.protocol !== 'http:' && x.protocol !== 'https:') || x.username || x.password || !x.hostname) return '';
    return x.protocol.slice(0, -1) + '://' + x.hostname.toLowerCase() + (x.port ? ':' + x.port : '');
  } catch (_) { return ''; }
}
const secretsFile = () => path.join(dataDir, '..', 'secrets.json');
let secretsCache = null;
function loadSecrets() {
  if (secretsCache) return secretsCache;
  try { secretsCache = JSON.parse(fs.readFileSync(secretsFile(), 'utf8')); } catch (_) { secretsCache = {}; }
  secretsCache.s = secretsCache.s || {}; secretsCache.o = secretsCache.o || {}; secretsCache.r = secretsCache.r || {};
  return secretsCache;
}
function saveSecrets() {
  const f = secretsFile(), tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(secretsCache), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(tmp, f);
}
function encSecret(v) {
  if (safeStorage.isEncryptionAvailable()) return 'e:' + safeStorage.encryptString(v).toString('base64');
  return 'p:' + Buffer.from(v, 'utf8').toString('base64'); // 系统无可用钥匙串时退化为仅文件权限保护
}
function decSecret(v) {
  try {
    if (v.startsWith('e:')) return safeStorage.decryptString(Buffer.from(v.slice(2), 'base64'));
    if (v.startsWith('p:')) return Buffer.from(v.slice(2), 'base64').toString('utf8');
  } catch (_) {}
  return null;
}
const validKind = k => k === 'provider_key' || k === 'search_key';
const regIdOf = (kind, id) => (kind === 'search_key' ? 'search:' + id : id);
const secretNameOf = rid => (rid.startsWith('search:') ? 'search_key:' + rid.slice(7) : 'provider_key:' + rid);
ipcMain.on('bridge:registerProvider', (e, id, baseUrl, authType) => {
  try {
    const S = loadSecrets(); id = String(id || ''); if (!id) { e.returnValue = 'error'; return; }
    S.r[id] = { baseUrl: String(baseUrl || ''), authType: String(authType || 'bearer') };
    const n = secretNameOf(id), bound = S.o[n], now = originOf(baseUrl);
    let res = 'ok';
    if (S.s[n] && bound && bound !== now) { delete S.s[n]; delete S.o[n]; res = 'cleared'; }
    saveSecrets(); e.returnValue = res;
  } catch (_) { e.returnValue = 'error'; }
});
ipcMain.on('bridge:setSecret', (e, kind, id, value) => {
  try {
    if (!validKind(kind)) { e.returnValue = false; return; }
    const S = loadSecrets(), rid = regIdOf(kind, String(id)), n = secretNameOf(rid);
    if (!value) { delete S.s[n]; delete S.o[n]; }
    else { S.s[n] = encSecret(String(value)); const r = S.r[rid]; const o = r && originOf(r.baseUrl); if (o) S.o[n] = o; }
    saveSecrets(); e.returnValue = true;
  } catch (_) { e.returnValue = false; }
});
ipcMain.on('bridge:hasSecret', (e, kind, id) => { e.returnValue = validKind(kind) && !!loadSecrets().s[kind + ':' + id]; });
ipcMain.on('bridge:deleteSecret', (e, kind, id) => {
  try { const S = loadSecrets(); delete S.s[kind + ':' + id]; delete S.o[kind + ':' + id]; saveSecrets(); } catch (_) {}
  e.returnValue = true;
});
ipcMain.on('bridge:clearSecrets', e => { try { const S = loadSecrets(); S.s = {}; S.o = {}; saveSecrets(); } catch (_) {} e.returnValue = true; });
ipcMain.on('bridge:requestForProvider', (e, id, providerId, method, url, headersJson, body, timeoutSec) => {
  const S = loadSecrets(); const r = S.r[String(providerId)];
  if (!r) { callPage(e.sender, 'onError', String(id), '服务商未登记'); return; }
  const allowed = originOf(r.baseUrl);
  if (!allowed || allowed !== originOf(url)) { callPage(e.sender, 'onError', String(id), '请求地址与服务商 Base URL 不一致，已拒绝'); return; }
  let h = {}; try { h = JSON.parse(headersJson || '{}') || {}; } catch (_) {}
  const clean = {}; Object.keys(h).forEach(k => { if (!AUTH_HEADERS.includes(k.toLowerCase())) clean[k] = h[k]; });
  const n = secretNameOf(String(providerId));
  const key = S.s[n] && (!S.o[n] || S.o[n] === allowed) ? decSecret(S.s[n]) : null;
  if (key) {
    if (r.authType === 'anthropic') clean['x-api-key'] = key;
    else if (r.authType === 'gemini') clean['x-goog-api-key'] = key;
    else if (r.authType === 'brave') clean['X-Subscription-Token'] = key;
    else clean.Authorization = 'Bearer ' + key;
  }
  doRequest(e.sender, String(id), method, url, JSON.stringify(clean), body, Number(timeoutSec) || 0, true);
});

// ---------------- 网络（主进程，Chromium 网络栈：跟随系统代理，无 CORS） ----------------
const requests = new Map(); // id -> { ctl, cancelled }

function callPage(wc, fn, ...args) {
  if (!wc || wc.isDestroyed()) return;
  const code = 'window.__nativeHttp&&window.__nativeHttp.' + fn + '(' + args.map(a => JSON.stringify(a)).join(',') + ')';
  wc.executeJavaScript(code).catch(() => {});
}

async function doRequest(wc, id, method, url, headersJson, body, timeoutSec, noRedirect) {
  const ctl = new AbortController();
  const st = { ctl, cancelled: false, timedOut: null };
  requests.set(id, st);
  const readTimeout = (timeoutSec > 0 ? timeoutSec : 300) * 1000;
  let timer = null;
  const arm = (ms, label) => { clearTimeout(timer); timer = setTimeout(() => { st.timedOut = label; ctl.abort(); }, ms); };
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('MalformedURLException: 只支持 http/https');
    let headers = {};
    if (headersJson) { try { headers = JSON.parse(headersJson) || {}; } catch (_) { headers = {}; } }
    const m = (method || 'GET').toUpperCase();
    const init = { method: m, headers, signal: ctl.signal, redirect: noRedirect ? 'manual' : 'follow', cache: 'no-store', credentials: 'omit' };
    if (body && m !== 'GET' && m !== 'HEAD') init.body = body;
    arm(30000 + readTimeout, 'SocketTimeoutException: 连接超时');
    const res = await net.fetch(u.toString(), init);
    if (st.cancelled) { callPage(wc, 'onEnd', id); return; }
    callPage(wc, 'onStart', id, res.status);
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      arm(readTimeout, 'SocketTimeoutException: 读取超时');
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (st.cancelled) { try { await reader.cancel(); } catch (_) {} break; }
        arm(readTimeout, 'SocketTimeoutException: 读取超时');
        const text = dec.decode(value, { stream: true });
        if (text) callPage(wc, 'onChunk', id, text);
      }
      if (!st.cancelled) { const rest = dec.decode(); if (rest) callPage(wc, 'onChunk', id, rest); }
    }
    callPage(wc, 'onEnd', id);
  } catch (e) {
    if (st.cancelled) callPage(wc, 'onEnd', id);
    else if (st.timedOut) callPage(wc, 'onError', id, st.timedOut);
    else {
      const name = e && e.name && e.name !== 'Error' && e.name !== 'TypeError' ? e.name + ': ' : '';
      callPage(wc, 'onError', id, name + ((e && e.message) || String(e)));
    }
  } finally {
    clearTimeout(timer);
    requests.delete(id);
  }
}

ipcMain.on('bridge:request', (e, id, method, url, headersJson, body, timeoutSec) => {
  doRequest(e.sender, String(id), method, url, headersJson, body, Number(timeoutSec) || 0);
});
ipcMain.on('bridge:cancel', (e, id) => {
  const st = requests.get(String(id));
  if (st) { st.cancelled = true; try { st.ctl.abort(); } catch (_) {} }
});

// ---------------- 杂项 ----------------
ipcMain.on('bridge:copy', (e, text) => { clipboard.writeText(String(text == null ? '' : text)); });

function isHttpUrl(u) { try { const p = new URL(String(u).trim()).protocol; return p === 'http:' || p === 'https:'; } catch (_) { return false; } }
ipcMain.on('bridge:openUrl', (e, url) => { if (url && isHttpUrl(url)) shell.openExternal(String(url).trim()).catch(() => {}); });

ipcMain.on('bridge:readAsset', (e, p) => {
  p = String(p || '');
  if (!p.startsWith('www/lib/cmaps/') || p.includes('..')) { e.returnValue = ''; return; }
  try { e.returnValue = fs.readFileSync(path.join(WEB_DIR, p.slice(4))).toString('base64'); } catch (_) { e.returnValue = ''; }
});

function toastPage(wc, text) { if (wc && !wc.isDestroyed()) wc.send('desktop:toast', String(text)); }

ipcMain.on('bridge:saveImage', async (e, src) => {
  const wc = e.sender;
  try {
    src = String(src || '');
    let bytes, mime = 'image/png';
    if (src.startsWith('data:')) {
      const comma = src.indexOf(',');
      const meta = src.substring(5, comma);
      mime = meta.split(';')[0] || mime;
      bytes = meta.includes(';base64') ? Buffer.from(src.substring(comma + 1), 'base64') : Buffer.from(decodeURIComponent(src.substring(comma + 1)), 'utf8');
    } else if (isHttpUrl(src)) {
      const res = await net.fetch(src);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ct = res.headers.get('content-type') || '';
      if (ct.startsWith('image/')) mime = ct.split(';')[0];
      bytes = Buffer.from(await res.arrayBuffer());
    } else throw new Error('不支持的图片地址');
    const ext = /jpe?g/.test(mime) ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png';
    const def = path.join(app.getPath('pictures'), 'AIChat_' + Date.now() + '.' + ext);
    const owner = BrowserWindow.fromWebContents(wc);
    const r = await dialog.showSaveDialog(owner, {
      title: '保存图片', defaultPath: def, buttonLabel: '保存',
      filters: [{ name: '图片', extensions: [ext] }, { name: '所有文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) { toastPage(wc, '已取消保存'); return; }
    await fs.promises.writeFile(r.filePath, bytes);
    toastPage(wc, '已保存：' + r.filePath);
  } catch (err) {
    toastPage(wc, '保存失败：' + (err && err.message || err));
  }
});

ipcMain.on('desktop:info', e => { e.returnValue = { version: app.getVersion(), platform: process.platform, dataDir }; });

// ---------------- 窗口 ----------------
function buildContextMenu(wc, params) {
  const t = [];
  const { editFlags, isEditable, selectionText, linkURL } = params;
  if (linkURL && isHttpUrl(linkURL)) {
    t.push({ label: '在浏览器中打开链接', click: () => shell.openExternal(linkURL).catch(() => {}) });
    t.push({ label: '复制链接地址', click: () => clipboard.writeText(linkURL) });
    t.push({ type: 'separator' });
  }
  if (isEditable) {
    t.push({ label: '撤销', role: 'undo', enabled: editFlags.canUndo });
    t.push({ label: '重做', role: 'redo', enabled: editFlags.canRedo });
    t.push({ type: 'separator' });
    t.push({ label: '剪切', role: 'cut', enabled: editFlags.canCut });
    t.push({ label: '复制', role: 'copy', enabled: editFlags.canCopy });
    t.push({ label: '粘贴', role: 'paste', enabled: editFlags.canPaste });
    t.push({ label: '全选', role: 'selectAll' });
  } else if (selectionText && selectionText.trim()) {
    t.push({ label: '复制', role: 'copy' });
  }
  while (t.length && t[t.length - 1].type === 'separator') t.pop();
  return t.length ? Menu.buildFromTemplate(t) : null;
}

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  win = new BrowserWindow({
    width: 1100, height: 760, minWidth: 420, minHeight: 560,
    title: APP_NAME,
    show: false,
    backgroundColor: dark ? '#0d0e12' : '#ffffff',
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => { if (!process.env.AICHAT_HIDDEN) win.show(); });

  const wc = win.webContents;
  // 外部链接一律交给系统默认浏览器（与 Android shouldOverrideUrlLoading 一致）
  wc.setWindowOpenHandler(({ url }) => { if (isHttpUrl(url)) shell.openExternal(url).catch(() => {}); return { action: 'deny' }; });
  wc.on('will-navigate', (ev, url) => {
    if (url.startsWith(`${SCHEME}://${HOST}/`)) return;
    ev.preventDefault();
    if (isHttpUrl(url)) shell.openExternal(url).catch(() => {});
  });
  wc.on('will-attach-webview', ev => ev.preventDefault());
  wc.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write' || perm === 'clipboard-read'));

  // 快捷键：缩放、开发者工具（不显示菜单栏）
  wc.on('before-input-event', (ev, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    if (input.key === 'F12' || (mod && input.shift && input.key.toLowerCase() === 'i')) { wc.toggleDevTools(); ev.preventDefault(); }
    else if (mod && (input.key === '=' || input.key === '+')) { wc.setZoomLevel(Math.min(wc.getZoomLevel() + 0.5, 4)); ev.preventDefault(); }
    else if (mod && input.key === '-') { wc.setZoomLevel(Math.max(wc.getZoomLevel() - 0.5, -3)); ev.preventDefault(); }
    else if (mod && input.key === '0') { wc.setZoomLevel(0); ev.preventDefault(); }
  });
  wc.on('context-menu', (ev, params) => { const m = buildContextMenu(wc, params); if (m) m.popup({ window: win }); });

  win.on('closed', () => {
    for (const st of requests.values()) { st.cancelled = true; try { st.ctl.abort(); } catch (_) {} }
    win = null;
  });
  win.loadURL(START_URL);
  return win;
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

app.whenReady().then(() => {
  dataDir = path.join(app.getPath('userData'), 'store');
  fs.mkdirSync(dataDir, { recursive: true });
  Menu.setApplicationMenu(null);
  protocol.handle(SCHEME, serveLocal);
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
