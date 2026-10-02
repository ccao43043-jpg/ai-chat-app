// 界面端到端测试：用本机 Chrome 加载页面，模拟原生桥（不访问网络），并截取浅色/深色截图到 docs/
// 运行：npm i && npm run test:ui
const puppeteer = require('puppeteer-core');
const path = require('path');
const assert = require('assert');
const DOCS = path.join(__dirname, '../docs');
const PAGE = 'file://' + path.join(__dirname, '../app/src/main/assets/www/index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// v0.1.0 时代保存的数据（用于验证升级迁移）
const OLD_SETTINGS = {
  providers: [
    { id: 'openai', presetId: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'], imageModel: 'gpt-image-1' },
    { id: 'deepseek', presetId: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-old-key', models: ['deepseek-chat', 'deepseek-reasoner'], imageModel: '' },
    { id: 'anthropic', presetId: 'anthropic', name: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'], imageModel: '' },
  ],
  systemPrompt: '', stream: true, temperature: '', maxTokens: '', imageSize: '1024x1024', lastProviderId: 'deepseek', lastModel: 'deepseek-chat',
};
const OLD_CONV = { id: 'oldc1', title: '旧对话', providerId: 'deepseek', model: 'deepseek-reasoner', systemPrompt: '',
  messages: [{ id: 'u1', role: 'user', content: '你好' }, { id: 'a1', role: 'assistant', content: '你好！有什么可以帮你？', model: 'deepseek-reasoner' }],
  createdAt: Date.now() - 864e5 * 2, updatedAt: Date.now() - 864e5 * 2 };

async function scenario(browser, theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 820, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: theme }]);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument((seed) => {
    const mem = Object.assign({}, seed); window.__mem = mem; window.__reqs = [];
    window.AndroidBridge = {
      storeGet: k => (k in mem ? mem[k] : null), storeSet: (k, v) => { mem[k] = v; return true; }, storeDelete: k => { delete mem[k]; },
      copy: t => { window.__copied = t; }, toast: () => {}, saveImage: () => {}, cancel: id => { window.__cancelled = id; },
      request: (id, method, url, headers, body) => {
        window.__reqs.push({ method, url, headers: JSON.parse(headers), body: body ? JSON.parse(body) : null });
        const H = window.__nativeHttp;
        if (method === 'GET' && /\/models/.test(url)) {
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] })); H.onEnd(id); }, 60);
          return;
        }
        if (url.includes('anthropic')) { setTimeout(() => { H.onStart(id, 401); H.onChunk(id, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'); H.onEnd(id); }, 50); return; }
        const text = '好的！下面是一个 **Python** 示例，读取文件并统计行数：\n\n```python\ndef count_lines(path):\n    with open(path, encoding="utf-8") as f:\n        return sum(1 for _ in f)\n\nprint(count_lines("notes.txt"))\n```\n\n| 方法 | 说明 |\n|---|---|\n| `open()` | 打开文件 |\n| `sum()` | 逐行计数 |\n\n> 提示：大文件也可以这样逐行处理，内存占用很低。\n';
        const sse = ['data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '用户想要一个简单的 Python 示例，我给出读取文件统计行数的代码。' } }] }) + '\n\n'];
        for (let i = 0; i < text.length; i += 6) sse.push('data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 6) } }] }) + '\n\n');
        sse.push('data: [DONE]\n\n');
        setTimeout(() => H.onStart(id, 200), 20);
        sse.forEach((c, i) => setTimeout(() => H.onChunk(id, c), 30 + i * 12));
        setTimeout(() => H.onEnd(id), 60 + sse.length * 12);
      },
    };
  }, { 'settings.json': JSON.stringify(OLD_SETTINGS), 'convs.json': JSON.stringify([{ id: 'oldc1', title: '旧对话', providerId: 'deepseek', model: 'deepseek-reasoner', updatedAt: OLD_CONV.updatedAt }]), 'conv_oldc1.json': JSON.stringify(OLD_CONV) });
  const shot = async name => { await sleep(450); await page.evaluate(() => document.querySelector('#toast').classList.remove('show')); await sleep(220); await page.screenshot({ path: path.join(DOCS, theme + '-' + name + '.png') }); };
  await page.goto(PAGE);
  await sleep(400);
  const r = {};

  // 1) 迁移检查
  r.migrated = await page.evaluate(() => {
    const s = JSON.parse(window.__mem['settings.json']); const c = JSON.parse(window.__mem['conv_oldc1.json']);
    const ds = s.providers.find(p => p.id === 'deepseek');
    return { models: ds.models, key: ds.apiKey, base: ds.baseUrl, conv: c.model, msgs: c.messages.length, pill: document.querySelector('#mp-model').textContent,
      openai: s.providers.find(p => p.id === 'openai').models[0], lastModel: s.lastModel };
  });
  assert.deepStrictEqual(r.migrated.models, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.strictEqual(r.migrated.key, 'sk-old-key');
  assert.strictEqual(r.migrated.conv, 'deepseek-flash');
  assert.strictEqual(r.migrated.msgs, 2);
  assert.strictEqual(r.migrated.pill, 'deepseek-flash');

  // 2) 新对话空状态
  await page.click('#btn-new');
  await shot('empty');
  assert.ok(await page.$('.suggest button'), '应显示建议卡片');

  // 3) 模型快速切换
  await page.click('#model-pill');
  await shot('model-menu');
  const items = await page.$$eval('#model-menu .pm-item', els => els.map(e => e.textContent.trim()));
  assert.ok(items.includes('deepseek-v4-pro'));
  await page.evaluate(() => [...document.querySelectorAll('#model-menu .pm-item')].find(e => e.textContent.trim() === 'deepseek-v4-pro').click());
  await sleep(300);
  assert.strictEqual(await page.$eval('#mp-model', e => e.textContent), 'deepseek-v4-pro');
  await page.click('#model-pill'); await sleep(250);
  await page.evaluate(() => [...document.querySelectorAll('#model-menu .pm-item')].find(e => e.textContent.trim() === 'deepseek-flash').click());
  await sleep(250);

  // 4) 发送 + 流式
  await page.click('.suggest button:nth-child(3)');
  await page.evaluate(() => { const i = document.querySelector('#input'); i.value = '给我一个 Python 示例'; i.dispatchEvent(new Event('input')); });
  await page.click('#btn-send');
  await sleep(250);
  r.stopShown = await page.$eval('#btn-send', e => e.classList.contains('stop'));
  assert.ok(r.stopShown, '生成中应显示停止按钮');
  await sleep(2600);
  await page.evaluate(() => { document.querySelector('#messages').scrollTop = 0; });
  await shot('chat');
  r.chat = await page.evaluate(() => ({ req: window.__reqs.filter(x => x.method === 'POST').pop(), code: !!document.querySelector('.code-block .hljs'), table: !!document.querySelector('.md table'), reasoning: !!document.querySelector('details.reasoning') }));
  assert.strictEqual(r.chat.req.url, 'https://api.deepseek.com/chat/completions');
  assert.strictEqual(r.chat.req.body.model, 'deepseek-flash');
  assert.strictEqual(r.chat.req.headers.Authorization, 'Bearer sk-old-key');
  assert.ok(r.chat.code && r.chat.table && r.chat.reasoning);
  await page.click('.code-head button');
  assert.ok((await page.evaluate(() => window.__copied)).includes('count_lines'));

  // 5) 设置 + 获取模型列表
  await page.click('#btn-menu'); await sleep(350);
  await shot('drawer');
  await page.click('#btn-settings'); await sleep(500);
  await shot('settings');
  await page.evaluate(() => [...document.querySelectorAll('.prov-item')].find(e => e.textContent.includes('DeepSeek')).click());
  await sleep(450);
  await shot('provider');
  await page.click('#pe-fetch'); await sleep(500);
  const fetchReq = await page.evaluate(() => window.__reqs.filter(x => x.method === 'GET').pop());
  assert.strictEqual(fetchReq.url, 'https://api.deepseek.com/models');
  await page.evaluate(() => [...document.querySelectorAll('#fetch-list .check-item')].find(e => e.textContent.includes('deepseek-v4-flash')).click());
  await shot('fetch-models');
  await page.click('#fetch-ok'); await sleep(300);
  await page.click('#pe-save'); await sleep(300);
  r.afterFetch = await page.evaluate(() => JSON.parse(window.__mem['settings.json']).providers.find(p => p.id === 'deepseek').models);
  assert.deepStrictEqual(r.afterFetch, ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash']);

  // 6) Claude：配置 Key，切换并验证错误提示
  await page.evaluate(() => [...document.querySelectorAll('.prov-item')].find(e => e.textContent.includes('Claude')).click());
  await sleep(400);
  await page.type('#pe-key', 'sk-ant-fake'); await page.click('#pe-save'); await sleep(300);
  await page.evaluate(() => window.onAndroidBack()); await sleep(450);
  await page.click('#model-pill'); await sleep(250);
  await page.evaluate(() => [...document.querySelectorAll('#model-menu .pm-item')].find(e => e.textContent.trim() === 'claude-opus-5-5').click());
  await sleep(200);
  await page.evaluate(() => { const i = document.querySelector('#input'); i.value = '再来一次'; i.dispatchEvent(new Event('input')); });
  await page.click('#btn-send'); await sleep(700);
  r.claude = await page.evaluate(() => ({ req: window.__reqs.filter(x => x.method === 'POST').pop(), err: (document.querySelector('.msg.error .err') || {}).textContent }));
  assert.strictEqual(r.claude.req.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(r.claude.req.body.model, 'claude-opus-5-5');
  assert.strictEqual(r.claude.req.body.messages.length, 3);
  assert.ok(r.claude.err.includes('401'));
  await shot('error');

  // 7) 抽屉中的对话管理（更多菜单）
  await page.click('#btn-menu'); await sleep(350);
  await page.click('.conv-item .ci-more'); await sleep(400);
  r.actions = await page.$$eval('#action-list .action-item', els => els.map(e => e.textContent.trim()));
  assert.deepStrictEqual(r.actions, ['重命名', '删除']);
  r.convCount = await page.$$eval('.conv-item', e => e.length);
  assert.strictEqual(r.convCount, 2);
  assert.deepStrictEqual(errors, []);
  await page.close();
  return r;
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try {
    for (const theme of ['light', 'dark']) {
      const r = await scenario(browser, theme);
      console.log('[' + theme + '] OK', JSON.stringify({ migrated: r.migrated, afterFetch: r.afterFetch, claudeErr: r.claude.err }));
    }
    console.log('UI E2E PASSED');
  } catch (e) { console.error('UI E2E FAILED:', e); process.exitCode = 1; }
  finally { await browser.close(); }
})();
