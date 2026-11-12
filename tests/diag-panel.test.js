// 诊断面板：HTML 在任何脚本之前即可看到按钮；diag.js 先于业务脚本加载，记录错误与点击。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const WWW = path.join(__dirname, '../app/src/main/assets/www');
const PAGE = 'file://' + path.join(WWW, 'index.html');
const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = p => fs.readFileSync(p, 'utf8');

test('index.html 在业务脚本之前包含诊断按钮，且 diag.js 为第一个脚本', () => {
  const html = R(path.join(WWW, 'index.html'));
  const toggleAt = html.indexOf('id="diag-toggle"');
  const firstScript = html.search(/<script\s+src=/);
  const diagSrc = html.search(/<script\s+src="diag\.js">/);
  const markedSrc = html.search(/<script\s+src="lib\/marked\.umd\.js">/);
  const appSrc = html.search(/<script\s+src="app\.js">/);
  assert.ok(toggleAt > 0, '应有 #diag-toggle');
  assert.ok(diagSrc > 0, '应引入 diag.js');
  assert.ok(toggleAt < firstScript, '诊断按钮 HTML 必须出现在任何 script 之前');
  assert.equal(diagSrc, firstScript, 'diag.js 必须是第一个脚本');
  assert.ok(diagSrc < markedSrc && markedSrc < appSrc, 'diag.js 应在 marked / app.js 之前');
  assert.ok(fs.existsSync(path.join(WWW, 'diag.js')), 'diag.js 文件存在');
  assert.match(R(path.join(WWW, 'diag.js')), /window\.onerror|addEventListener\('error'/);
  assert.match(R(path.join(WWW, 'diag.js')), /unhandledrejection/);
  assert.match(R(path.join(WWW, 'diag.js')), /console\.(error|warn)|hookLevel\('error'\)/);
  assert.match(R(path.join(WWW, 'diag.js')), /elementFromPoint/);
  assert.match(R(path.join(WWW, 'diag.js')), /pointerdown/);
  assert.match(R(path.join(WWW, 'diag.js')), /handlerRan/);
  assert.match(R(path.join(WWW, 'diag.js')), /\[init\]/);
});

test('诊断面板可打开并记录点击、错误与 [init] / 覆盖层信息', async (t) => {
  if (!fs.existsSync(CHROME)) { t.skip('未找到 Chrome（' + CHROME + '）'); return; }
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--allow-file-access-from-files', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 820, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(() => {
      const mem = {};
      window.AndroidBridge = {
        storeGet: k => (k in mem ? mem[k] : null),
        storeSet: (k, v) => { mem[k] = v; return true; },
        storeDelete: k => { delete mem[k]; },
        storeExists: k => k in mem,
        storeList: () => JSON.stringify(Object.keys(mem)),
        storeRename: () => false,
        storeAppend: (k, t) => { mem[k] = (mem[k] || '') + t; return true; },
        copy() { window.__copied = arguments[0]; return true; },
        toast() {}, saveImage() {}, cancel() {}, openUrl() {},
        setSecret() { return true; }, hasSecret() { return false; },
        deleteSecret() {}, clearSecrets() {}, request() {},
        registerProvider: () => 'ok',
      };
    });
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(600);

    const visible = await page.$eval('#diag-root', root => {
      const el = document.getElementById('diag-toggle');
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const rz = getComputedStyle(root).zIndex;
      return { w: r.width, h: r.height, z: rz, pe: cs.pointerEvents, text: (el.textContent || '').trim() };
    });
    assert.ok(visible.w >= 24 && visible.h >= 24, '诊断按钮应可见');
    assert.ok(Number(visible.z) >= 10000, '诊断根节点 z-index 应非常高，当前=' + visible.z);
    assert.equal(visible.text, '诊');

    await page.$eval('#diag-toggle', el => el.click());
    await sleep(100);
    assert.ok(await page.$eval('#diag-box', el => el.open), '点击「诊」应打开面板');

    const meta = await page.$eval('#diag-meta', el => el.textContent || '');
    assert.match(meta, /v0\.28\.4/);
    assert.match(meta, /ua=/);
    assert.match(meta, /viewport=/);
    assert.match(meta, /dpr=/);
    assert.match(meta, /covers/);

    const log0 = await page.$eval('#diag-log', el => el.textContent || '');
    assert.match(log0, /diagnostic panel ready/);

    const box = await page.$eval('#btn-menu', el => {
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await sleep(250);
    const log1 = await page.$eval('#diag-log', el => el.textContent || '');
    assert.match(log1, /\[tap\].*(pointerdown|click) @/);
    assert.match(log1, /(?:fromPoint|via)=.*#btn-menu/);
    assert.match(log1, /handlerRan=true/, '侧栏按钮的 onclick 应被记为已执行');
    assert.ok(await page.$eval('#drawer', el => el.classList.contains('show')), '侧栏仍应能打开');

    await page.evaluate(() => { console.warn('diag-warn-test'); console.error('diag-error-test'); });
    await sleep(50);
    const log2 = await page.$eval('#diag-log', el => el.textContent || '');
    assert.match(log2, /\[warn\].*diag-warn-test/);
    assert.match(log2, /\[error\].*diag-error-test/);

    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent('error', {
        message: 'diag-onerror-test', filename: 'diag-test.js', lineno: 7, colno: 1,
        error: new Error('diag-onerror-test'),
      }));
    });
    await sleep(50);
    const log3 = await page.$eval('#diag-log', el => el.textContent || '');
    assert.match(log3, /\[onerror\].*diag-onerror-test/);

    await page.evaluate(() => {
      window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', {
        promise: Promise.resolve(),
        reason: new Error('diag-reject-test'),
      }));
    });
    await sleep(50);
    const log4 = await page.$eval('#diag-log', el => el.textContent || '');
    assert.match(log4, /\[unhandledrejection\].*diag-reject-test/);

    const copied = await page.evaluate(async () => {
      const btn = document.getElementById('diag-copy');
      btn.click();
      await new Promise(r => setTimeout(r, 50));
      return window.__copied || window.__diag.dump();
    });
    assert.match(copied, /v0\.28\.4/);
    assert.match(copied, /\[tap\]/);
    assert.ok(copied.length > 80, '复制内容应包含元信息与日志');
  } finally {
    await browser.close();
  }
});
