/* 桌面版端到端测试（在 Electron 里运行）：
 * 启动本地 mock SSE 服务器 → 预置 DeepSeek 指向 mock → 加载真实主进程 src/main.js → 在页面里检查桥接、存储、流式、取消、错误、
 * 外链、剪贴板、保存图片，再用真实键盘事件发送一条消息并等待流式回复渲染，最后截图。
 * 运行：node test/e2e.js（会自动用 xvfb-run）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');
const { app, BrowserWindow, clipboard, shell, dialog, Menu } = electron;

const ROOT = path.resolve(__dirname, '..');
const SHOT = process.env.AICHAT_SHOT || path.resolve(ROOT, '../docs/windows-preview.png');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-e2e-'));
process.env.AICHAT_USER_DATA = userData;
const storeDir = path.join(userData, 'store');
fs.mkdirSync(storeDir, { recursive: true });

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log((ok ? '  ✔ ' : '  ✘ ') + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); };
const consoleErrors = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- mock SSE 服务器 ----------
const seen = [];
const REPLY = ['你好！我是 **桌面版** 的测试回复。', '\n\n已经通过主进程流式返回：\n\n', '1. 无 CORS 限制\n2. 支持 SSE 流式\n3. Key 只存本机\n\n',
  '```js\nconsole.log("AI Chat for Windows");\n```\n', '\n祝使用愉快 🎉'];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (req.url.startsWith('/raw-stream')) {
      const n = Number(new URL(req.url, 'http://x').searchParams.get('n') || 5);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      for (let i = 0; i < n; i++) { if (res.destroyed) return; res.write('data: 块' + i + '\n\n'); await sleep(150); }
      res.end('data: [DONE]\n\n');
      return;
    }
    if (req.url.startsWith('/status/')) { res.writeHead(Number(req.url.split('/')[2]), { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"鉴权失败（测试）"}}'); return; }
    if (req.url.endsWith('/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      for (const piece of REPLY) {
        // 按字符拆小块，模拟真实流式
        for (let i = 0; i < piece.length; i += 6) {
          res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { content: piece.slice(i, i + 6) } }] }) + '\n\n');
          await sleep(25);
        }
      }
      res.write('data: ' + JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 64, total_tokens: 184, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 120 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.writeHead(404); res.end('not found');
  });
});

// ---------- 预置设置（DeepSeek → mock） ----------
function seedSettings(port) {
  const Providers = require(path.join(ROOT, 'web/providers.js'));
  const providers = Providers.PRESETS.map(p => ({ id: p.presetId, presetId: p.presetId, name: p.name, type: p.type, baseUrl: p.baseUrl, apiKey: '', models: p.models.slice(), imageModel: p.imageModel || '' }));
  const ds = providers.find(p => p.id === 'deepseek');
  ds.baseUrl = 'http://127.0.0.1:' + port + '/v1';
  ds.apiKey = 'sk-e2e-local-test';
  fs.writeFileSync(path.join(storeDir, 'settings.json'), JSON.stringify({
    providers, systemPrompt: '', stream: true, temperature: '', maxTokens: '', imageSize: '1024x1024',
    lastProviderId: 'deepseek', lastModel: 'deepseek-flash', settingsVersion: Providers.SETTINGS_VERSION,
    search: { provider: 'tavily', keys: {}, urls: {}, count: 5, rewrite: false }, searchOn: false, removedPersonas: [],
  }));
}

// ---------- 打桩：外链 / 保存对话框 ----------
const opened = [];
// 剪贴板：Xvfb 下同进程读回 X11 剪贴板会阻塞，这里包装 writeText 记录调用（仍会真正写入）
const copied = [];
const origWrite = clipboard.writeText.bind(clipboard);
clipboard.writeText = (t, type) => { copied.push(t); return origWrite(t, type); };
shell.openExternal = async u => { opened.push(u); };
const savedImg = path.join(userData, 'saved.png');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: savedImg });

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  seedSettings(port);
  app.on('browser-window-created', (_e, win) => run(win, port).catch(err => { console.error(err); check('测试脚本异常', false, String(err && err.stack || err)); finish(); }));
  require(path.join(ROOT, 'src/main.js'));
});

async function run(win, port) {
  const wc = win.webContents;
  wc.on('console-message', e => { if (e.level === 'error') consoleErrors.push(e.message); });
  wc.on('render-process-gone', (_e, d) => check('渲染进程没有崩溃', false, d));
  wc.on('did-fail-load', (_e, code, desc, url) => consoleErrors.push('did-fail-load ' + code + ' ' + desc + ' ' + url));
  await new Promise(r => wc.once('did-finish-load', r));
  await sleep(800);
  const js = code => wc.executeJavaScript(code);
  const B = 'http://127.0.0.1:' + port;

  console.log('\n[窗口]');
  const [w, h] = win.getSize(); const [mw, mh] = win.getMinimumSize();
  check('窗口 1100x760，最小尺寸 420x560', w === 1100 && h === 760 && mw === 420 && mh === 560, { w, h, mw, mh });
  check('无应用菜单栏', Menu.getApplicationMenu() === null && !win.isMenuBarVisible());
  check('页面标题', (await js('document.title')) === 'AI Chat');
  check('html.desktop 标记 + 桌面样式已加载', await js(`document.documentElement.classList.contains('desktop') && [...document.styleSheets].some(s => (s.href||'').includes('__desktop/desktop.css'))`));
  check('说明文字改为「本机」', await js(`document.body.innerHTML.includes('请求由本机直接发往服务商') && !document.body.innerHTML.includes('请求由手机直接发往')`));
  check('宽窗口侧边栏常驻', await js(`(() => { const r = document.getElementById('drawer').getBoundingClientRect(); return r.left === 0 && r.width === 300 && getComputedStyle(document.getElementById('btn-menu')).visibility === 'hidden'; })()`));

  console.log('\n[桥接 API]');
  const keys = await js('Object.keys(window.AndroidBridge).sort()');
  const need = ['request', 'cancel', 'storeGet', 'storeSet', 'storeDelete', 'copy', 'openUrl', 'readAsset', 'toast', 'saveImage'];
  check('AndroidBridge 方法齐全', need.every(k => keys.includes(k)), keys);
  const st = await js(`(() => { const A = window.AndroidBridge; const o = {};
    o.set = A.storeSet('e2e_rt.json', JSON.stringify({ s: '中文 ✓ 🎉', n: 42 }));
    o.get = A.storeGet('e2e_rt.json');
    o.missing = A.storeGet('no-such-key.json');
    o.weird = A.storeSet('../evil/../name.json', '1');
    return o; })()`);
  check('storeSet 同步返回 true', st.set === true, st.set);
  check('storeGet 同步读回（UTF-8）', st.get === JSON.stringify({ s: '中文 ✓ 🎉', n: 42 }), st.get);
  check('不存在的键返回 null', st.missing === null, st.missing);
  check('数据落盘到用户数据目录', fs.readFileSync(path.join(storeDir, 'e2e_rt.json'), 'utf8').includes('中文'));
  check('键名被清洗，不能越出存储目录', fs.existsSync(path.join(storeDir, '.._evil_.._name.json')) && !fs.existsSync(path.join(userData, 'evil')));
  await js(`window.AndroidBridge.storeDelete('e2e_rt.json')`);
  check('storeDelete 生效', (await js(`window.AndroidBridge.storeGet('e2e_rt.json')`)) === null && !fs.existsSync(path.join(storeDir, 'e2e_rt.json')));
  const asset = await js(`[window.AndroidBridge.readAsset('www/lib/cmaps/Adobe-GB1-UCS2.bcmap').length, window.AndroidBridge.readAsset('www/../src/main.js'), window.AndroidBridge.readAsset('www/index.html')]`);
  check('readAsset 读取 CMap（base64），拒绝越界路径', asset[0] > 1000 && asset[1] === '' && asset[2] === '', asset.map(x => typeof x === 'number' ? x : x.length));

  // 原始流式：拦截 __nativeHttp 回调观察时间线
  const rawReq = (id, url, opts) => js(`new Promise(resolve => {
    const H = window.__nativeHttp, orig = Object.assign({}, H), ev = [], t0 = performance.now();
    const done = () => { Object.assign(H, orig); resolve(ev); };
    H.onStart = (i, s) => i === ${JSON.stringify(id)} ? ev.push(['start', s, performance.now() - t0]) : orig.onStart(i, s);
    H.onChunk = (i, t) => { if (i !== ${JSON.stringify(id)}) return orig.onChunk(i, t); ev.push(['chunk', t, performance.now() - t0]); ${opts && opts.cancel ? `if (ev.filter(e => e[0]==='chunk').length === 1) window.AndroidBridge.cancel(${JSON.stringify(id)});` : ''} };
    H.onEnd = i => { if (i !== ${JSON.stringify(id)}) return orig.onEnd(i); ev.push(['end', null, performance.now() - t0]); done(); };
    H.onError = (i, m) => { if (i !== ${JSON.stringify(id)}) return orig.onError(i, m); ev.push(['error', m, performance.now() - t0]); done(); };
    window.AndroidBridge.request(${JSON.stringify(id)}, ${JSON.stringify((opts && opts.method) || 'POST')}, ${JSON.stringify(url)}, JSON.stringify({ 'Content-Type': 'application/json', Authorization: 'Bearer sk-raw' }), ${JSON.stringify((opts && opts.body) || '{"q":"测试"}')}, ${(opts && opts.timeout) || 60});
    setTimeout(() => { ev.push(['timeout']); done(); }, 15000);
  })`);
  const ev = await rawReq('e2e-stream', B + '/raw-stream?n=6');
  const chunks = ev.filter(e => e[0] === 'chunk');
  const all = chunks.map(c => c[1]).join('');
  check('流式：onStart(200) → 多次 onChunk → onEnd', ev[0][0] === 'start' && ev[0][1] === 200 && ev[ev.length - 1][0] === 'end' && chunks.length >= 4, ev.map(e => e[0]));
  check('流式：逐块到达（未整体缓冲）', chunks.length >= 4 && chunks[chunks.length - 1][2] - chunks[0][2] > 500, chunks.map(c => Math.round(c[2])));
  check('流式：内容完整（中文不乱码）', all.includes('块0') && all.includes('块5') && all.includes('[DONE]'), all.length);
  const rawSeen = seen.find(s => s.url.startsWith('/raw-stream'));
  check('请求头 / 请求体原样发出', rawSeen && rawSeen.headers.authorization === 'Bearer sk-raw' && rawSeen.body === '{"q":"测试"}' && rawSeen.method === 'POST', rawSeen && { auth: rawSeen.headers.authorization, body: rawSeen.body });
  const evc = await rawReq('e2e-cancel', B + '/raw-stream?n=40', { cancel: true });
  check('cancel(id)：中途取消后回调 onEnd（与 Android 一致）', evc[evc.length - 1][0] === 'end' && evc.filter(e => e[0] === 'chunk').length < 10, evc.map(e => e[0]).join(','));
  const ev4 = await rawReq('e2e-401', B + '/status/401');
  check('HTTP 401：onStart(401) 并返回错误体', ev4[0][1] === 401 && ev4.some(e => e[0] === 'chunk' && e[1].includes('鉴权失败')), ev4.map(e => e[0] + ':' + (e[1] || '')));
  const deadPort = await new Promise(r => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const eve = await rawReq('e2e-err', 'http://127.0.0.1:' + deadPort + '/x');
  check('连接失败：onError(消息)', eve.length === 1 && eve[0][0] === 'error' && eve[0][1], eve[0]);
  const evg = await rawReq('e2e-get', B + '/status/204', { method: 'GET', body: '' });
  check('GET 请求可用', evg[0][0] === 'start' && evg[0][1] === 204 && evg[evg.length - 1][0] === 'end', evg.map(e => e[0] + ':' + (e[1] || '')));

  console.log('\n[杂项]');
  await js(`window.AndroidBridge.copy('复制测试 copy-ok')`); await sleep(200);
  check('copy 调用系统剪贴板 writeText', copied[copied.length - 1] === '复制测试 copy-ok', copied);
  await js(`window.AndroidBridge.openUrl('https://example.com/a?b=1'); window.AndroidBridge.openUrl('javascript:alert(1)'); window.AndroidBridge.openUrl('file:///etc/passwd'); window.open('https://example.org/', '_blank');`);
  await sleep(300);
  check('openUrl / window.open 只把 http(s) 交给系统浏览器', opened.length === 2 && opened[0] === 'https://example.com/a?b=1' && opened[1] === 'https://example.org/', opened);
  await js(`window.AndroidBridge.toast('桌面 toast 测试')`);
  check('toast 显示在页面', await js(`document.getElementById('toast').classList.contains('show') && document.getElementById('toast').textContent === '桌面 toast 测试'`));
  const png1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  await js(`window.AndroidBridge.saveImage(${JSON.stringify(png1x1)})`); await sleep(600);
  check('saveImage 通过保存对话框写出文件', fs.existsSync(savedImg) && fs.statSync(savedImg).size === 70 && (await js(`document.getElementById('toast').textContent`)).startsWith('已保存'), fs.existsSync(savedImg) && fs.statSync(savedImg).size);
  const bad = await js(`fetch('${B}/raw-stream?n=1').then(() => 'no-cors-block', e => 'blocked')`);
  check('页面自身 fetch 仍受 CORS 约束（只有桥接能跨域）', bad === 'blocked', bad);

  console.log('\n[界面：真实键盘发送 + 流式渲染]');
  await sleep(2600); // 等 toast 消失，保证截图干净
  check('模型切换器显示 DeepSeek', (await js(`document.getElementById('mp-provider').textContent + ' / ' + document.getElementById('mp-model').textContent`)).includes('DeepSeek'), await js(`document.getElementById('mp-provider').textContent + ' / ' + document.getElementById('mp-model').textContent`));
  await js(`document.getElementById('input').focus()`);
  wc.insertText('你好，介绍一下桌面版');
  await sleep(150);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Shift' });
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] });
  wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return', modifiers: ['shift'] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
  await sleep(150);
  check('Shift+Enter 换行不发送', (await js(`document.getElementById('input').value`)).includes('\n') && !seen.some(s => s.url.endsWith('/chat/completions')));
  wc.insertText('（第二行）');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  let mid = null;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    const s = await js(`(() => { const a = [...document.querySelectorAll('.msg.assistant')].pop(); return { text: a ? a.innerText : '', stop: document.getElementById('btn-send').classList.contains('stop') }; })()`);
    if (s.stop && s.text.length > 5 && !mid) mid = s;
    if (!s.stop && s.text.includes('祝使用愉快')) break;
  }
  const req = seen.find(s => s.url.endsWith('/chat/completions'));
  check('Enter 发送：请求到达 mock 服务器', !!req, req && req.url);
  check('请求带 Authorization（Key 来自本机设置）', req && req.headers.authorization === 'Bearer sk-e2e-local-test');
  let reqBody = {}; try { reqBody = JSON.parse(req.body); } catch (_) {}
  check('请求体：stream=true，消息为输入内容', reqBody.stream === true && JSON.stringify(reqBody.messages || []).includes('第二行'), { model: reqBody.model, stream: reqBody.stream });
  check('流式过程中界面逐步更新（停止按钮可见）', !!mid, mid && mid.text.slice(0, 40));
  const fin = await js(`(() => { const a = [...document.querySelectorAll('.msg.assistant')].pop(); return { html: a ? a.innerHTML : '', text: a ? a.innerText : '' }; })()`);
  check('回复完整渲染（Markdown 粗体 / 列表 / 代码块）', fin.text.includes('祝使用愉快') && fin.html.includes('<strong>') && fin.html.includes('<ol>') && fin.html.includes('<pre'), fin.text.slice(0, 80));
  await sleep(600);
  const convs = JSON.parse(fs.readFileSync(path.join(storeDir, 'convs.json'), 'utf8'));
  check('对话保存到本地磁盘', convs.length === 1 && fs.existsSync(path.join(storeDir, 'conv_' + convs[0].id + '.json')), convs.map(c => c.title));
  const usage = JSON.parse(fs.readFileSync(path.join(storeDir, 'usage-stats.json'), 'utf8'));
  check('用量统计记录了本次 usage', JSON.stringify(usage).includes('120') && (usage.log || []).length >= 1, (usage.log || []).length);
  check('Key 未出现在页面 DOM 中', !(await js(`document.documentElement.outerHTML.includes('sk-e2e-local-test')`)));

  // 截图（浅色）
  await js(`document.activeElement && document.activeElement.blur()`);
  await sleep(400);
  const img = await wc.capturePage();
  fs.mkdirSync(path.dirname(SHOT), { recursive: true });
  fs.writeFileSync(SHOT, img.toPNG());
  check('截图已保存', fs.statSync(SHOT).size > 10000, SHOT);

  // 额外截图：设置页、用量统计页、窄窗口（仅供人工检查，不入库）
  const extra = path.join(os.tmpdir(), 'aichat-e2e-shots'); fs.mkdirSync(extra, { recursive: true });
  const snap = async name => { await sleep(500); fs.writeFileSync(path.join(extra, name + '.png'), (await wc.capturePage()).toPNG()); };
  await js(`document.querySelector('#drawer [id*="settings"], #drawer .settings-btn, #btn-settings') && document.querySelector('#drawer [id*="settings"], #drawer .settings-btn, #btn-settings').click()`); await snap('settings');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await sleep(500);
  check('Esc = 返回（关闭设置页）', !(await js(`document.getElementById('page-settings').classList.contains('show')`)));
  await js(`document.getElementById('model-pill').click()`); await snap('model-menu');
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' }); await sleep(300);
  win.setSize(480, 820); await snap('narrow');
  check('窄窗口回到手机布局（侧边栏收起）', await js(`document.getElementById('drawer').getBoundingClientRect().right <= 0 && getComputedStyle(document.getElementById('btn-menu')).visibility === 'visible'`));
  win.setSize(1100, 760);
  console.log('  额外截图：' + extra);

  console.log('\n[控制台]');
  await js(`console.error('__e2e_probe__')`); await sleep(200);
  check('控制台错误捕获有效（探针）', consoleErrors.includes('__e2e_probe__'));
  consoleErrors.splice(consoleErrors.indexOf('__e2e_probe__'), 1);
  const relevant = consoleErrors.filter(m => !/Electron Security Warning/.test(m) && !/raw-stream\?n=1/.test(m)); // 后者是上面故意触发的 CORS 拦截
  check('无控制台错误', relevant.length === 0, relevant);
  finish();
}

function finish() {
  const failed = results.filter(r => !r.ok);
  console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 通过' + (failed.length ? '；失败：' + failed.map(f => f.name).join('、') : ''));
  try { fs.rmSync(userData, { recursive: true, force: true }); } catch (_) {}
  server.close();
  app.exit(failed.length ? 1 : 0);
}
setTimeout(() => { console.error('超时'); check('整体超时', false); finish(); }, 120000).unref();
