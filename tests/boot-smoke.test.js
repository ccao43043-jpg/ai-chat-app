// 启动冒烟：无头 Chrome 加载 www/index.html，确认无未捕获异常，关键按钮点击有反应。
// 发版前必跑（已纳入 npm test）。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const WWW = path.join(__dirname, '../app/src/main/assets/www');
const PAGE = 'file://' + path.join(WWW, 'index.html');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OLD_SETTINGS = {
  providers: [
    { id: 'openai', presetId: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', models: ['gpt-4o-mini', 'gpt-4o'], imageModel: 'gpt-image-1' },
    { id: 'deepseek', presetId: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-old-key', models: ['deepseek-chat', 'deepseek-reasoner'], imageModel: '' },
  ],
  systemPrompt: '', stream: true, temperature: '', maxTokens: '', imageSize: '1024x1024',
  lastProviderId: 'deepseek', lastModel: 'deepseek-chat',
};
const OLD_CONV = {
  id: 'oldc1', title: '旧对话', providerId: 'deepseek', model: 'deepseek-reasoner', systemPrompt: '',
  messages: [
    { id: 'u1', role: 'user', content: '你好' },
    { id: 'a1', role: 'assistant', content: '你好！', model: 'deepseek-reasoner', createdAt: 1, usage: { prompt: 12, completion: 8, hit: 0, miss: 12, cacheSupported: true } },
  ],
  createdAt: 1, updatedAt: 1,
};

// v0.24.x 旧数据：OpenRouter 服务商编辑页刷新最低价后，modelMeta 里落盘了 _endpoints（v0.26.0 起启动时会同步进用量价目）。
// v0.28.3 及以前：syncPricesFromProviderMeta 在 saveUsageMeta 声明前调用 → TDZ ReferenceError，主界面点击全失效。
const V024_OR_MODEL = 'deepseek/deepseek-chat';
const V024_OR_SETTINGS = {
  providers: [
    { id: 'openrouter', presetId: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: '', models: [V024_OR_MODEL, 'openai/gpt-4o-mini'], imageModel: '',
      modelMeta: {
        [V024_OR_MODEL]: { contextLength: 64000, price: { prompt: 0.3, completion: 1.2 }, priceIsFloor: true,
          _endpoints: [
            { provider_name: 'DeepInfra', pricing: { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.00000003' } },
            { provider_name: 'Novita', pricing: { prompt: '0.0000004', completion: '0.0000013' } },
          ] },
        'openai/gpt-4o-mini': { contextLength: 128000, endpoints: [{ provider_name: 'OpenAI', pricing: { prompt: '0.00000015', completion: '0.0000006' } }] },
      } },
  ],
  systemPrompt: '', stream: true, temperature: '', maxTokens: '', imageSize: '1024x1024',
  lastProviderId: 'openrouter', lastModel: V024_OR_MODEL,
};

function injectBridge(opts) {
  return (opts) => {
    const mem = Object.assign({}, opts.seed || {});
    window.__mem = mem;
    window.__pageErrors = [];
    window.addEventListener('error', e => {
      window.__pageErrors.push(String(e.message || e.error || e) + (e.filename ? ' @' + e.filename + ':' + e.lineno : ''));
    });
    window.addEventListener('unhandledrejection', e => {
      window.__pageErrors.push('unhandledrejection: ' + String((e.reason && e.reason.stack) || e.reason));
    });
    const sec = window.__secrets = {}, reg = {};
    const bridge = {
      storeGet: k => (k in mem ? mem[k] : null),
      storeSet: (k, v) => { mem[k] = v; return true; },
      storeDelete: k => { delete mem[k]; },
      storeExists: k => k in mem,
      storeList: () => JSON.stringify(Object.keys(mem)),
      storeRename: (a, b) => { if (!(a in mem)) return false; mem[b] = mem[a]; delete mem[a]; return true; },
      storeAppend: (k, t) => { mem[k] = (mem[k] || '') + t; return true; },
      copy() {}, toast() {}, saveImage() {}, cancel() {}, openUrl() {},
      setSecret: (kind, id, v) => { if (!v) { delete sec[kind + ':' + id]; return true; } sec[kind + ':' + id] = v; return true; },
      hasSecret: (kind, id) => !!sec[kind + ':' + id],
      deleteSecret: (kind, id) => { delete sec[kind + ':' + id]; },
      clearSecrets() { Object.keys(sec).forEach(k => delete sec[k]); },
      request() {},
    };
    if (opts.bridge === 'complete') {
      bridge.registerProvider = (id, base, type) => { reg[id] = { base, type }; return 'ok'; };
    } else if (opts.bridge === 'throws') {
      bridge.registerProvider = () => { throw new Error('registerProvider boom'); };
    }
    // opts.bridge === 'incomplete'：有 setSecret 但无 registerProvider（旧/残缺宿主）
    window.AndroidBridge = bridge;
  };
}

async function openPage(browser, opts) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.setViewport(Object.assign({ width: 390, height: 820, isMobile: true, hasTouch: true }, opts.viewport || {}));
  if (opts.bridge !== 'none') await page.evaluateOnNewDocument(injectBridge(opts), opts);
  else {
    await page.evaluateOnNewDocument(() => {
      window.__pageErrors = [];
      window.addEventListener('error', e => window.__pageErrors.push(String(e.message || e.error || e)));
      window.addEventListener('unhandledrejection', e => window.__pageErrors.push(String(e.reason)));
    });
  }
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(500);
  const winErr = await page.evaluate(() => window.__pageErrors || []);
  return { page, errors: errors.concat(winErr) };
}

async function closeOverlays(page) {
  await page.evaluate(() => {
    const rm = (id, cls) => { const n = document.getElementById(id); if (n) { n.classList.remove('show', 'open'); if (cls) n.hidden = true; } };
    rm('drawer'); rm('drawer-mask');
    rm('model-menu'); const mm = document.getElementById('model-menu'); if (mm) mm.classList.remove('show');
    const um = document.getElementById('usage-menu'); if (um) { um.hidden = true; um.classList.remove('show'); }
    const more = document.getElementById('composer-more-menu'); if (more) { more.hidden = true; more.classList.remove('show'); }
    rm('tpl-sheet'); rm('tpl-mask');
    rm('page-settings'); rm('dialog-mask');
    const toast = document.getElementById('toast'); if (toast) toast.classList.remove('show');
  });
  await sleep(80);
}

async function tap(page, sel) {
  const ok = await page.$eval(sel, el => { el.click(); return true; });
  assert.ok(ok, '找不到 ' + sel);
  await sleep(200);
}

// v0.28.5：JS 贴边定位的弹层必须完整落在视口内（旧版 .popover.show 的 translate(-50%) 会把用量弹层左半截推出屏幕）
async function assertPopoverOnScreen(page, sel, label) {
  await sleep(300); // 等开场动画结束
  const g = await page.$eval(sel, el => {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const btns = Array.from(el.querySelectorAll('button')).map(b => {
      const br = b.getBoundingClientRect();
      return { text: (b.textContent || '').trim(), left: br.left, right: br.right, top: br.top, bottom: br.bottom, w: br.width, h: br.height };
    });
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw, vh, transform: getComputedStyle(el).transform, btns };
  });
  const info = label + ' ' + JSON.stringify({ left: g.left, right: g.right, top: g.top, bottom: g.bottom, vw: g.vw, transform: g.transform });
  assert.ok(g.left >= 8 - 0.5, label + ' 左边缘应 ≥ 8px：' + info);
  assert.ok(g.right <= g.vw - 8 + 0.5, label + ' 右边缘不应超出视口：' + info);
  assert.ok(g.top >= 0 && g.bottom <= g.vh + 0.5, label + ' 上下不应超出视口：' + info);
  g.btns.forEach(b => {
    assert.ok(b.w > 0 && b.h > 0, label + ' 按钮「' + b.text + '」应可见');
    assert.ok(b.left >= 0 && b.right <= g.vw && b.left >= g.left - 0.5 && b.right <= g.right + 0.5, label + ' 按钮「' + b.text + '」不应被裁到屏幕外：' + JSON.stringify(b) + ' ' + info);
  });
  return g;
}

async function assertClicksWork(page) {
  // 侧栏
  await tap(page, '#btn-menu');
  assert.ok(await page.$eval('#drawer', el => el.classList.contains('show')), '点击侧栏按钮应打开抽屉');
  await closeOverlays(page);

  // 选择模型
  await tap(page, '#model-pill');
  assert.ok(await page.$eval('#model-menu', el => el.classList.contains('show')), '点击「选择模型」应打开模型菜单');
  await closeOverlays(page);

  // 用量
  await tap(page, '#usage-pill');
  assert.ok(await page.$eval('#usage-menu', el => !el.hidden && el.classList.contains('show')), '点击用量应打开用量菜单');
  await assertPopoverOnScreen(page, '#usage-menu', '用量弹层');
  await closeOverlays(page);

  // 新对话
  await tap(page, '#btn-new');
  const afterNew = await page.evaluate(() => ({
    errs: window.__pageErrors || [],
    hasEmpty: !!document.querySelector('#messages .empty, #messages .setup-card, #empty-setup'),
  }));
  assert.deepEqual(afterNew.errs, [], '新对话不应产生未捕获异常');
  await closeOverlays(page);

  // Composer +
  await tap(page, '#btn-composer-more');
  assert.ok(await page.$eval('#composer-more-menu', el => !el.hidden && el.classList.contains('show')), '点击 Composer + 应打开更多工具');
  await assertPopoverOnScreen(page, '#composer-more-menu', '更多工具弹层');
  await closeOverlays(page);

  // 模板
  await tap(page, '#btn-template');
  assert.ok(await page.$eval('#tpl-sheet', el => el.classList.contains('show')), '点击模板应打开模板面板');
  await closeOverlays(page);

  // 发送：先写入输入框以启用按钮，点击后应有反馈且不抛错
  await page.evaluate(() => {
    const i = document.getElementById('input');
    i.value = 'hello';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(80);
  const sendEnabled = await page.$eval('#btn-send', el => !el.disabled);
  assert.ok(sendEnabled, '输入文字后发送按钮应启用（updateSendState）');
  await tap(page, '#btn-send');
  const afterSend = await page.evaluate(() => ({
    errs: window.__pageErrors || [],
    toast: !!(document.getElementById('toast') && document.getElementById('toast').classList.contains('show')),
    settings: !!(document.getElementById('page-settings') && document.getElementById('page-settings').classList.contains('show')),
    modelMenu: !!(document.getElementById('model-menu') && document.getElementById('model-menu').classList.contains('show')),
    sheet: !!(document.getElementById('sheet') && document.getElementById('sheet').classList.contains('show')),
    userMsg: !!document.querySelector('#messages .msg.user, #messages .msg[data-role="user"]'),
    input: (document.getElementById('input') && document.getElementById('input').value) || '',
  }));
  assert.deepEqual(afterSend.errs, [], '发送不应产生未捕获异常');
  assert.ok(afterSend.toast || afterSend.settings || afterSend.modelMenu || afterSend.sheet || afterSend.userMsg || afterSend.input !== 'hello',
    '发送应有提示、打开设置/模型，或开始发消息');
}

function chromeAvailable() {
  return fs.existsSync(CHROME);
}

test('启动冒烟：完整桥 / 残缺桥 / 抛错 / 迁移 / 空服务商，无未捕获异常且关键按钮可点', async (t) => {
  if (!chromeAvailable()) { t.skip('未找到 Chrome（' + CHROME + '），无法跑界面冒烟'); return; }
  assert.ok(fs.existsSync(path.join(WWW, 'index.html')));
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-gpu'],
  });
  const cases = [
    { name: 'fresh-complete', bridge: 'complete', seed: {} },
    { name: 'fresh-incomplete', bridge: 'incomplete', seed: {} },
    { name: 'register-throws', bridge: 'throws', seed: {} },
    { name: 'no-bridge', bridge: 'none' },
    { name: 'empty-providers', bridge: 'complete', seed: { 'settings.json': JSON.stringify({ providers: [], lastProviderId: '', lastModel: '' }) } },
    { name: 'providers-null', bridge: 'complete', seed: { 'settings.json': JSON.stringify({ providers: null, lastModel: 'x' }) } },
    { name: 'no-models', bridge: 'complete', seed: { 'settings.json': JSON.stringify({ providers: [{ id: 'openai', presetId: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk', models: [], imageModel: '' }], lastProviderId: 'openai', lastModel: '' }) } },
    { name: 'migrate-old', bridge: 'complete', seed: {
      'settings.json': JSON.stringify(OLD_SETTINGS),
      'convs.json': JSON.stringify([{ id: 'oldc1', title: '旧对话', providerId: 'deepseek', model: 'deepseek-reasoner', updatedAt: 1 }]),
      'conv_oldc1.json': JSON.stringify(OLD_CONV),
    } },
    { name: 'v024-openrouter-endpoints', bridge: 'complete', seed: { 'settings.json': JSON.stringify(V024_OR_SETTINGS) } },
  ];
  try {
    for (const c of cases) {
      const { page, errors } = await openPage(browser, c);
      try {
        const snap = await page.evaluate(() => ({
          ver: (document.getElementById('about-ver') && document.getElementById('about-ver').textContent) || '',
          mp: (document.getElementById('mp-model') && document.getElementById('mp-model').textContent) || '',
          igSel: !!document.getElementById('ig-model-sel'),
        }));
        assert.equal(errors.length, 0, c.name + ' 未捕获异常: ' + errors.join(' | '));
        assert.ok(snap.ver && !snap.ver.includes('选择模型'), c.name + ' 关于页版本应已写入');
        assert.notEqual(snap.mp, '选择模型', c.name + ' 模型胶囊不应停留在 HTML 占位（说明 boot 未跑完）');
        assert.ok(snap.igSel, '生图页模型下拉应存在');
        await assertClicksWork(page);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

test('启动回归（v0.28.4）：v0.24 旧 settings 带 OpenRouter modelMeta._endpoints，无 TDZ ReferenceError，最低价写入用量价目，按钮已绑定', async (t) => {
  if (!chromeAvailable()) { t.skip('未找到 Chrome（' + CHROME + '），无法跑界面冒烟'); return; }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-gpu'],
  });
  try {
    let seed = { 'settings.json': JSON.stringify(V024_OR_SETTINGS) };
    for (const launch of [1, 2]) { // 第二次启动：确认价目已落盘、不会每次启动重抛
      const { page, errors } = await openPage(browser, { bridge: 'complete', seed });
      try {
        const st = await page.evaluate(() => ({
          errs: window.__pageErrors || [],
          menuOnclick: typeof document.getElementById('btn-menu').onclick,
          newOnclick: typeof document.getElementById('btn-new').onclick,
          mp: (document.getElementById('mp-model') && document.getElementById('mp-model').textContent) || '',
          meta: window.__mem['usage-stats-meta.json'] || null,
          mem: Object.assign({}, window.__mem),
          initIssues: (window.__diag && window.__diag.dump && (window.__diag.dump().match(/\[init\][^\n]*/g) || [])) || [],
        }));
        const all = errors.concat(st.errs);
        assert.equal(all.length, 0, '第 ' + launch + ' 次启动未捕获异常: ' + all.join(' | '));
        assert.ok(!all.some(e => /ReferenceError|before initialization/.test(e)), '不应有 TDZ ReferenceError');
        assert.ok(!st.initIssues.some(l => /syncPrices/.test(l)), '价目同步不应记 [init] 错误: ' + st.initIssues.join(' | '));
        assert.equal(st.menuOnclick, 'function', '#btn-menu 应已绑定 onclick');
        assert.equal(st.newOnclick, 'function', '#btn-new 应已绑定 onclick');
        assert.notEqual(st.mp, '选择模型', '模型胶囊不应停留在 HTML 占位');
        assert.ok(st.meta, 'syncUsagePricesFromEndpoints 应调用 saveUsageMeta 写入 usage-stats-meta.json');
        const prices = JSON.parse(st.meta).prices || {};
        assert.ok(prices[V024_OR_MODEL], '最低价应同步进用量价目: ' + st.meta);
        await assertClicksWork(page);
        seed = st.mem;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
});

// v0.28.5：小米 2410DPN6CC 实机视口 384x792（dpr 3.75）。旧版用量弹层右对齐却仍套 translate(-50%)，
// 「今日花费 / 用量详情」跑到屏幕左外侧；部分 OpenRouter 最低价（缺 hit/out）让用量页「估算花费」显示 $NaN。
const PARTIAL_MODEL = 'vendor/partial-floor-model';
function nanSeed() {
  const now = Date.now();
  const meta = { version: 1, backfilled: true, priceMode: 'auto', calib: {},
    prices: { [PARTIAL_MODEL]: { miss: 0.3, source: 'openrouter-floor', syncedAt: now } } }; // 缺 hit / out
  const line = e => JSON.stringify(e);
  const log = [
    { id: 'u1', key: 'k1', at: now - 60000, type: 'chat', prompt: 4000, completion: 600, hit: 3000, miss: 1000, cache: true, model: PARTIAL_MODEL, providerId: 'openrouter', actualCost: 0.002 },
    { id: 'u2', key: 'k2', at: now - 30000, type: 'chat', prompt: 1200, completion: 300, hit: 0, miss: 1200, cache: false, model: 'deepseek-chat', providerId: 'deepseek' },
  ];
  return {
    'settings.json': JSON.stringify(V024_OR_SETTINGS),
    'usage-stats-meta.json': JSON.stringify(meta),
    'usage-stats.jsonl': log.map(line).join('\n') + '\n',
  };
}

test('窄屏回归（v0.28.5）：384x792 下用量弹层 / 更多工具完整在屏内；部分价目不让估算花费变 $NaN', async (t) => {
  if (!chromeAvailable()) { t.skip('未找到 Chrome（' + CHROME + '），无法跑界面冒烟'); return; }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-gpu'],
  });
  try {
    const { page, errors } = await openPage(browser, { bridge: 'complete', seed: nanSeed(), viewport: { width: 384, height: 792, deviceScaleFactor: 3.75 } });
    try {
      assert.equal(errors.length, 0, '未捕获异常: ' + errors.join(' | '));
      assert.equal(await page.evaluate(() => window.innerWidth), 384);

      await tap(page, '#usage-pill');
      assert.ok(await page.$eval('#usage-menu', el => !el.hidden && el.classList.contains('show')), '点击用量应打开用量菜单');
      const g = await assertPopoverOnScreen(page, '#usage-menu', '用量弹层(384)');
      const texts = g.btns.map(b => b.text);
      assert.ok(texts.includes('用量详情') && texts.includes('账户余额'), '应有 用量详情 / 账户余额 按钮: ' + texts.join(','));
      const menuText = await page.$eval('#usage-menu', el => el.textContent);
      assert.match(menuText, /今日花费/);
      assert.doesNotMatch(menuText, /NaN/, '用量弹层不应出现 NaN: ' + menuText);
      // 「今日花费」标签本身也必须在屏内
      const k = await page.$eval('#usage-menu .um-k', el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right }; });
      assert.ok(k.left >= 8 - 0.5, '「今日花费」标签应在屏内: ' + JSON.stringify(k));
      const pillText = await page.$eval('#usage-pill', el => el.textContent + ' ' + (el.title || ''));
      assert.doesNotMatch(pillText, /NaN/, '用量胶囊不应出现 NaN: ' + pillText);

      // 进入用量详情：估算花费不应是 $NaN
      await page.$eval('#um-open-usage', el => el.click());
      await sleep(300);
      const usage = await page.$eval('#page-usage', el => ({ show: el.classList.contains('show'), text: el.textContent }));
      assert.ok(usage.show, '点击「用量详情」应打开用量统计页');
      assert.match(usage.text, /估算花费/);
      assert.doesNotMatch(usage.text, /NaN/, '用量统计页不应出现 $NaN: ' + usage.text.slice(0, 400));
      await page.evaluate(() => document.getElementById('page-usage').classList.remove('show'));
      await closeOverlays(page);

      await tap(page, '#btn-composer-more');
      assert.ok(await page.$eval('#composer-more-menu', el => !el.hidden && el.classList.contains('show')), '点击 Composer + 应打开更多工具');
      await assertPopoverOnScreen(page, '#composer-more-menu', '更多工具弹层(384)');
      await closeOverlays(page);

      const errs = await page.evaluate(() => window.__pageErrors || []);
      assert.deepEqual(errs, [], '操作过程中不应有未捕获异常');
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
});
