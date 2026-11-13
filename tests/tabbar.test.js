// v0.29.0：底部固定 Tab（聊天 / 生图）
// - 启动即绑定（含 v0.24 旧 settings 带 OpenRouter modelMeta._endpoints 的种子）
// - 切换双向、激活态、Android 返回键（生图 → 聊天；抽屉/其它页保持原有返回顺序）
// - 其它全屏页 / 抽屉 / 面板 / 键盘弹出时隐藏；安全区底部内边距；不遮挡 Composer
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const WWW = path.join(__dirname, '../app/src/main/assets/www');
const PAGE = 'file://' + path.join(WWW, 'index.html');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const SHOTS = process.env.TAB_SHOTS || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const V024_OR_MODEL = 'deepseek/deepseek-chat';
const V024_OR_SETTINGS = {
  providers: [
    { id: 'openrouter', presetId: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-test', models: [V024_OR_MODEL, 'openai/gpt-4o-mini', 'google/gemini-2.5-flash-image'], imageModel: '',
      modelMeta: {
        [V024_OR_MODEL]: { contextLength: 64000, price: { prompt: 0.3, completion: 1.2 }, priceIsFloor: true,
          _endpoints: [{ provider_name: 'DeepInfra', pricing: { prompt: '0.0000003', completion: '0.0000012' } }] },
      } },
  ],
  systemPrompt: '', stream: true, temperature: '', maxTokens: '', imageSize: '1024x1024',
  lastProviderId: 'openrouter', lastModel: V024_OR_MODEL,
};

function inject(opts) {
  const mem = Object.assign({}, opts.seed || {});
  window.__mem = mem; window.__pageErrors = [];
  window.addEventListener('error', e => window.__pageErrors.push(String(e.message || e.error || e)));
  window.addEventListener('unhandledrejection', e => window.__pageErrors.push('unhandledrejection: ' + String(e.reason)));
  const sec = {};
  window.AndroidBridge = {
    storeGet: k => (k in mem ? mem[k] : null), storeSet: (k, v) => { mem[k] = v; return true; },
    storeDelete: k => { delete mem[k]; }, storeExists: k => k in mem, storeList: () => JSON.stringify(Object.keys(mem)),
    storeRename: (a, b) => { if (!(a in mem)) return false; mem[b] = mem[a]; delete mem[a]; return true; },
    storeAppend: (k, t) => { mem[k] = (mem[k] || '') + t; return true; },
    copy() {}, toast() {}, saveImage() {}, cancel() {}, openUrl() {}, request() {},
    setSecret: (kind, id, v) => { if (!v) { delete sec[kind + ':' + id]; return true; } sec[kind + ':' + id] = v; return true; },
    hasSecret: (kind, id) => !!sec[kind + ':' + id], deleteSecret: (kind, id) => { delete sec[kind + ':' + id]; }, clearSecrets() {},
    registerProvider: () => 'ok',
  };
}

async function launch() {
  return puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-gpu'] });
}
async function open(browser, seed, viewport) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.setViewport(Object.assign({ width: 384, height: 792, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, viewport || {}));
  await page.evaluateOnNewDocument(inject, { seed });
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await sleep(500);
  return { page, errors };
}
const st = page => page.evaluate(() => {
  const r = s => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; };
  return {
    on: document.body.classList.contains('tabs-on'),
    barDisplay: getComputedStyle(document.getElementById('tabbar')).display,
    active: Array.from(document.querySelectorAll('#tabbar .tab-btn.active')).map(b => b.dataset.tab),
    selected: Array.from(document.querySelectorAll('#tabbar .tab-btn[aria-selected="true"]')).map(b => b.dataset.tab),
    ig: document.getElementById('page-imagegen').classList.contains('show'),
    drawer: document.getElementById('drawer').classList.contains('show'),
    settings: document.getElementById('page-settings').classList.contains('show'),
    bar: r('#tabbar'), composer: r('.composer'), send: r('#btn-send'), input: r('#input'), igPage: r('#page-imagegen'), igGen: r('#ig-generate'),
    vh: window.innerHeight, errs: window.__pageErrors || [],
  };
});
const tap = async (page, sel) => { await page.$eval(sel, el => el.click()); await sleep(420); };
const back = page => page.evaluate(() => window.onAndroidBack());

test('底部 Tab：启动绑定（含 v0.24 旧数据种子）、双向切换、激活态、返回键', async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip('无 Chrome'); return; }
  const browser = await launch();
  try {
    for (const seed of [{}, { 'settings.json': JSON.stringify(V024_OR_SETTINGS) }]) {
      const { page, errors } = await open(browser, seed);
      try {
        const bound = await page.evaluate(() => ({
          chat: typeof document.getElementById('tab-chat').onclick,
          ig: typeof document.getElementById('tab-imagegen').onclick,
          menu: typeof document.getElementById('btn-menu').onclick,
          init: (window.__diag && window.__diag.dump && (window.__diag.dump().match(/\[init\][^\n]*/g) || [])) || [],
        }));
        assert.equal(bound.chat, 'function', '启动后 #tab-chat 应已绑定');
        assert.equal(bound.ig, 'function', '启动后 #tab-imagegen 应已绑定');
        assert.equal(bound.menu, 'function');
        assert.ok(!bound.init.some(l => /tabbar/.test(l)), 'tabbar 初始化不应报错: ' + bound.init.join('|'));

        let s = await st(page);
        assert.ok(s.on && s.barDisplay === 'flex', '聊天主界面应显示 Tab');
        assert.deepEqual(s.active, ['chat']); assert.deepEqual(s.selected, ['chat']);
        assert.ok(s.composer.bottom <= s.bar.top + 0.5, 'Composer 不应被 Tab 遮挡: ' + JSON.stringify([s.composer, s.bar]));
        assert.ok(Math.abs(s.bar.bottom - s.vh) < 1, 'Tab 贴底');

        await tap(page, '#tab-imagegen');
        s = await st(page);
        assert.ok(s.ig, '点「生图」应打开 #page-imagegen'); assert.ok(s.on, '生图页 Tab 仍可见');
        assert.deepEqual(s.active, ['imagegen']); assert.deepEqual(s.selected, ['imagegen']);
        assert.ok(s.igPage.bottom <= s.bar.top + 0.5, '生图页内容不应被 Tab 遮挡');
        const ctl = await page.evaluate(() => ({ prov: document.getElementById('ig-provider-sel').options.length, size: document.getElementById('ig-size').options.length }));
        assert.ok(ctl.size > 0, '生图尺寸下拉应已填充');

        await tap(page, '#tab-chat');
        s = await st(page);
        assert.ok(!s.ig && s.on); assert.deepEqual(s.active, ['chat']);

        // 返回键：生图 → 聊天
        await tap(page, '#tab-imagegen');
        assert.equal(await back(page), true, '生图页返回键应被消费');
        await sleep(420); s = await st(page);
        assert.ok(!s.ig, '返回键应回到聊天'); assert.deepEqual(s.active, ['chat']);
        // 聊天主界面再按返回：不消费（交给系统退出）
        assert.equal(await back(page), false);

        // 生图页左上角返回按钮
        await tap(page, '#tab-imagegen');
        await tap(page, '#page-imagegen [data-back]');
        s = await st(page); assert.ok(!s.ig); assert.deepEqual(s.active, ['chat']);

        // 侧栏「生图」入口 → Tab 激活态同步
        await tap(page, '#btn-menu');
        s = await st(page); assert.ok(s.drawer && !s.on, '抽屉打开时隐藏 Tab');
        await page.$eval('#btn-imagegen-page', el => el.click()); await sleep(600);
        s = await st(page); assert.ok(s.ig && s.on); assert.deepEqual(s.active, ['imagegen'], '从侧栏打开生图也应激活生图 Tab');
        await back(page); await sleep(420);

        // 抽屉的返回键行为保持：先关抽屉
        await tap(page, '#btn-menu');
        assert.equal(await back(page), true); await sleep(300);
        s = await st(page); assert.ok(!s.drawer && s.on && !s.ig, '返回键先关抽屉，Tab 恢复');

        // 设置页：隐藏 Tab；返回后恢复
        await page.evaluate(() => { document.getElementById('btn-settings').click(); }); await sleep(600);
        s = await st(page); assert.ok(s.settings && !s.on, '设置页打开时隐藏 Tab');
        await back(page); await sleep(420);
        s = await st(page); assert.ok(!s.settings && s.on);

        // 模型菜单 / 模板面板：隐藏 Tab
        await tap(page, '#model-pill'); s = await st(page); assert.ok(!s.on, '模型菜单打开时隐藏 Tab');
        await back(page); await sleep(300); s = await st(page); assert.ok(s.on);
        await tap(page, '#btn-template'); s = await st(page); assert.ok(!s.on, '模板面板打开时隐藏 Tab');
        await back(page); await sleep(300); s = await st(page); assert.ok(s.on);

        // 键盘：kb-open 时隐藏
        await page.evaluate(() => document.body.classList.add('kb-open')); await sleep(80);
        s = await st(page); assert.ok(!s.on, '键盘弹出时隐藏 Tab');
        await page.evaluate(() => document.body.classList.remove('kb-open')); await sleep(80);
        s = await st(page); assert.ok(s.on);

        assert.deepEqual(errors.concat(s.errs), [], '无未捕获异常');
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});

test('底部 Tab：真实键盘（visualViewport 变矮）隐藏 Tab，Composer 贴底；安全区内边距', async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip('无 Chrome'); return; }
  const browser = await launch();
  try {
    const { page, errors } = await open(browser, { 'settings.json': JSON.stringify(V024_OR_SETTINGS) });
    try {
      // adjustResize：键盘弹出 = WebView 变矮
      await page.focus('#input');
      await page.setViewport({ width: 384, height: 792 - 300, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await sleep(300);
      let s = await st(page);
      assert.ok(!s.on, '视口变矮 300px（键盘）应隐藏 Tab');
      assert.ok(s.composer.bottom <= s.vh + 0.5 && s.send.bottom <= s.vh, '键盘弹出时发送按钮可见');
      await page.setViewport({ width: 384, height: 792, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
      await sleep(300);
      s = await st(page); assert.ok(s.on, '键盘收起后 Tab 恢复');

      // 安全区：模拟 34px 底部安全区
      await page.evaluate(() => document.documentElement.style.setProperty('--tab-safe', '34px')); await sleep(80);
      const g = await page.evaluate(() => {
        const bar = document.getElementById('tabbar'), cs = getComputedStyle(bar);
        const btn = document.getElementById('tab-chat').getBoundingClientRect();
        return { pb: cs.paddingBottom, h: bar.getBoundingClientRect().height, btnBottom: btn.bottom, vh: innerHeight, appPb: getComputedStyle(document.getElementById('app')).paddingBottom,
          composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top };
      });
      assert.equal(g.pb, '34px', 'Tab 底部应留出安全区');
      assert.equal(Math.round(g.h), 56 + 34);
      assert.ok(g.btnBottom <= g.vh - 34 + 0.5, '图标不应落进安全区');
      assert.equal(g.appPb, (56 + 34) + 'px');
      assert.ok(g.composerBottom <= g.barTop + 0.5, '安全区下 Composer 仍不被遮挡');
      if (SHOTS) {
        await page.evaluate(() => document.documentElement.style.removeProperty('--tab-safe'));
        await page.$eval('#input', el => el.blur());
        await sleep(200);
        await page.screenshot({ path: path.join(SHOTS, 'headless-chat-tab-384x792.png') });
        await page.$eval('#tab-imagegen', el => el.click()); await sleep(600);
        await page.screenshot({ path: path.join(SHOTS, 'headless-imagegen-tab-384x792.png') });
        await page.evaluate(() => document.documentElement.style.setProperty('--tab-safe', '34px')); await sleep(100);
        await page.screenshot({ path: path.join(SHOTS, 'headless-imagegen-tab-safearea34.png') });
      }
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  } finally { await browser.close(); }
});

test('底部 Tab（源码约束）：Tab 切走用 keepRunning 不打断生成；返回键路径仍停止；不复活 #home', async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip('无 Chrome'); return; }
  const src = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8');
  assert.match(src, /closeImageGen\(\{ keepRunning: true \}\)/, 'Tab 切换应以 keepRunning 关闭生图页');
  assert.match(src, /if \(igRunning && !\(opts && opts\.keepRunning\)\) stopImageGenPage\(\);/, '返回键路径仍停止生成');
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  assert.equal((html.match(/id="tabbar"/g) || []).length, 1, '仅一个 Tab 栏');
  assert.ok(!/id="bottom-nav"|id="home"/.test(html), '不复活 v0.22.0 已回退的 #home / bottom-nav');
});
