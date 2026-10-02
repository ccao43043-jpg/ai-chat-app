// 界面端到端测试：用本机 Chrome 加载页面，模拟原生桥（不访问网络），并截取浅色/深色截图到 docs/
// 运行：npm i && npm run test:ui
const puppeteer = require('puppeteer-core');
const path = require('path');
const assert = require('assert');
const DOCS = path.join(__dirname, '../docs');
const FIX = path.join(__dirname, 'fixtures');
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
      openUrl: u => { window.__opened = u; },
      readAsset: p => { // 模拟原生：同步读取 assets 并返回 base64
        window.__assets = (window.__assets || []).concat(p);
        const x = new XMLHttpRequest(); x.open('GET', p.replace(/^www\//, ''), false); x.overrideMimeType('text/plain; charset=x-user-defined'); x.send();
        let bin = ''; for (let i = 0; i < x.responseText.length; i++) bin += String.fromCharCode(x.responseText.charCodeAt(i) & 0xff);
        return btoa(bin);
      },
      request: (id, method, url, headers, body) => {
        window.__reqs.push({ method, url, headers: JSON.parse(headers), body: body ? JSON.parse(body) : null });
        const H = window.__nativeHttp;
        if (method === 'GET' && /\/models/.test(url)) {
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] })); H.onEnd(id); }, 60);
          return;
        }
        if (url.startsWith('https://api.tavily.com/')) {
          const results = [
            { title: '2026 年诺贝尔物理学奖揭晓', url: 'https://www.nobelprize.org/prizes/physics/2026/summary/', content: '瑞典皇家科学院宣布将 2026 年诺贝尔物理学奖授予三位在量子材料领域做出开创性贡献的科学家。', score: 0.92 },
            { title: '诺奖解读：量子材料为何重要', url: 'https://news.example.com/nobel-2026-physics', content: '获奖研究揭示了拓扑量子态在室温下的稳定机制，为低功耗电子器件铺平道路。', score: 0.88 },
            { title: 'Nobel Prize in Physics 2026 - Press release', url: 'https://www.example.org/press/physics-2026', content: 'The Royal Swedish Academy of Sciences has decided to award the Nobel Prize in Physics 2026 ...', score: 0.8 },
          ];
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ query: JSON.parse(body).query, results, response_time: 0.8 })); H.onEnd(id); }, 120);
          return;
        }
        if (url.includes('anthropic')) { setTimeout(() => { H.onStart(id, 401); H.onChunk(id, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'); H.onEnd(id); }, 50); return; }
        const msgs = (JSON.parse(body || '{}').messages || []);
        const lastU = msgs.filter(m => m.role === 'user').pop();
        const uc = lastU ? (typeof lastU.content === 'string' ? lastU.content : JSON.stringify(lastU.content)) : '';
        const sys = (msgs.find(m => m.role === 'system') || {}).content || '';
        let text = '好的！下面是一个 **Python** 示例，读取文件并统计行数：\n\n```python\ndef count_lines(path):\n    with open(path, encoding="utf-8") as f:\n        return sum(1 for _ in f)\n\nprint(count_lines("notes.txt"))\n```\n\n| 方法 | 说明 |\n|---|---|\n| `open()` | 打开文件 |\n| `sum()` | 逐行计数 |\n\n> 提示：大文件也可以这样逐行处理，内存占用很低。\n';
        if (uc.includes('联网搜索结果')) text = '根据最新消息，**2026 年诺贝尔物理学奖**授予了三位在量子材料领域做出开创性贡献的科学家 [1]。\n\n获奖研究主要揭示了拓扑量子态在室温下的稳定机制，有望带来更低功耗的电子器件 [2][3]。\n\n- 颁奖机构：瑞典皇家科学院 [1]\n- 研究方向：量子材料、拓扑物态 [2]\n';
        else if (uc.includes('【文件：')) text = '我阅读了你上传的两个文件，要点如下：\n\n**《2026 年第三季度销售报告》**\n- 本季度总营收 **1280 万元**，同比增长 23%\n- 华东区贡献最大，占比 41%；线上渠道同比增长 57%\n- 下季度计划在成都、西安新开两家门店，预算 300 万元\n\n**会议纪要**\n- Q4 主推线上渠道，预算增加 15%（负责人：王磊，10 月 20 日前提交方案）\n\n> 结论：营收为 1280 万元，线上渠道是增长主力。';
        else if (sys.includes('专业翻译')) text = 'The weather is really nice today — shall we go for a walk in the park?';
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
  await page.evaluate(() => window.onAndroidBack()); await sleep(300);

  const setInput = v => page.evaluate(v => { const i = document.querySelector('#input'); i.value = v; i.dispatchEvent(new Event('input')); }, v);
  const lastPost = () => page.evaluate(() => window.__reqs.filter(x => x.method === 'POST' && !x.url.includes('tavily')).pop());
  const pickModel = name => page.evaluate(n => [...document.querySelectorAll('#model-menu .pm-item')].find(e => e.textContent.trim() === n).click(), name);

  // 8) 助手库：从抽屉进入，内置 8 个助手
  await page.click('#btn-personas'); await sleep(550);
  r.personaCards = await page.$$eval('#persona-grid .persona-card:not(.add) .pcard-name', els => els.map(e => e.textContent));
  assert.strictEqual(r.personaCards.length, 8);
  assert.ok(r.personaCards.includes('翻译官') && r.personaCards.includes('心理倾听'));
  await shot('personas');
  // 编辑页
  await page.evaluate(() => [...document.querySelectorAll('.persona-card')].find(e => e.textContent.includes('代码助手')).querySelector('.ci-more').click());
  await sleep(350);
  r.personaActions = await page.$$eval('#action-list .action-item', els => els.map(e => e.textContent.trim()));
  assert.deepStrictEqual(r.personaActions, ['开始对话', '编辑', '复制一份', '删除']);
  await page.evaluate(() => [...document.querySelectorAll('#action-list .action-item')].find(e => e.textContent.includes('复制')).click());
  await sleep(400);
  r.dupCount = await page.$$eval('#persona-grid .persona-card:not(.add)', e => e.length);
  assert.strictEqual(r.dupCount, 9);
  await page.evaluate(() => [...document.querySelectorAll('.persona-card')].find(e => e.textContent.includes('代码助手（副本）')).querySelector('.ci-more').click());
  await sleep(350);
  await page.evaluate(() => [...document.querySelectorAll('#action-list .action-item')].find(e => e.textContent.includes('编辑')).click());
  await sleep(500);
  await page.evaluate(() => { const n = document.querySelector('#ps-name'); n.value = 'Kotlin 专家'; document.querySelector('#ps-temp').value = '0.1'; });
  await page.select('#ps-provider', 'deepseek'); await sleep(150);
  await page.evaluate(() => [...document.querySelectorAll('#ps-models .chip')].find(e => e.textContent === 'deepseek-v4-pro').click());
  await shot('persona-edit');
  await page.click('#ps-save'); await sleep(450);
  r.savedPersona = await page.evaluate(() => JSON.parse(window.__mem['personas.json']).find(p => p.name === 'Kotlin 专家'));
  assert.strictEqual(r.savedPersona.model, 'deepseek-v4-pro');
  assert.strictEqual(r.savedPersona.temperature, 0.1);
  // 从「翻译官」开始对话
  await page.evaluate(() => [...document.querySelectorAll('.persona-card')].find(e => e.textContent.includes('翻译官')).click());
  await sleep(500);
  r.personaHeader = await page.$eval('#mp-provider', e => e.textContent);
  assert.ok(r.personaHeader.includes('翻译官'), r.personaHeader);
  await page.click('#model-pill'); await sleep(250); await pickModel('deepseek-flash'); await sleep(250);
  await setInput('今天天气真好，我们去公园散步吧');
  await page.click('#btn-send'); await sleep(1600);
  r.personaReq = await lastPost();
  assert.strictEqual(r.personaReq.body.messages[0].role, 'system');
  assert.ok(r.personaReq.body.messages[0].content.includes('专业翻译'));
  assert.strictEqual(r.personaReq.body.temperature, 0.3);
  r.personaBot = await page.$eval('.msg.assistant:last-child .bot-name', e => e.textContent);
  assert.ok(r.personaBot.includes('翻译官'));
  await shot('persona-chat');

  // 9) 提示词库：插入到输入框
  await page.click('#btn-new'); await sleep(300);
  await page.click('#btn-prompts'); await sleep(450);
  r.promptCount = await page.$$eval('#prompt-list .prompt-item', e => e.length);
  assert.ok(r.promptCount >= 6);
  await shot('prompts');
  await page.evaluate(() => [...document.querySelectorAll('#prompt-list .prompt-item')].find(e => e.textContent.includes('润色')).click());
  await sleep(300);
  r.inserted = await page.$eval('#input', e => e.value);
  assert.ok(r.inserted.startsWith('请帮我润色'));
  await setInput('');

  // 10) 联网搜索：配置 Tavily Key -> 开启「联网」-> 引用与来源卡片
  await page.click('#btn-search'); await sleep(400); // 未配置时弹出引导
  r.searchGuide = await page.$eval('#dialog-title', e => e.textContent);
  assert.ok(r.searchGuide.includes('联网搜索'));
  await page.click('#dialog-ok'); await sleep(700);
  r.ssProvider = await page.$eval('#ss-provider', e => e.value);
  assert.strictEqual(r.ssProvider, 'tavily');
  await page.type('#ss-key', 'tvly-test-key');
  await page.evaluate(() => document.querySelector('#ss-key').dispatchEvent(new Event('change')));
  await page.evaluate(() => document.querySelector('#search-settings').scrollIntoView());
  await shot('search-settings');
  await page.evaluate(() => window.onAndroidBack()); await sleep(450);
  await page.click('#btn-search'); await sleep(250);
  assert.ok(await page.$eval('#btn-search', e => e.classList.contains('active')));
  await setInput('2026 年诺贝尔物理学奖颁给了谁？');
  await page.click('#btn-send'); await sleep(80);
  r.searching = await page.$eval('.msg.assistant:last-child', e => e.textContent);
  assert.ok(r.searching.includes('正在联网搜索'), r.searching);
  await sleep(2200);
  r.tavilyReq = await page.evaluate(() => window.__reqs.filter(x => x.url.includes('tavily')).pop());
  assert.strictEqual(r.tavilyReq.url, 'https://api.tavily.com/search');
  assert.strictEqual(r.tavilyReq.method, 'POST');
  assert.strictEqual(r.tavilyReq.headers.Authorization, 'Bearer tvly-test-key');
  assert.strictEqual(r.tavilyReq.body.query, '2026 年诺贝尔物理学奖颁给了谁？');
  assert.strictEqual(r.tavilyReq.body.max_results, 5);
  r.searchChat = await lastPost();
  const injected = r.searchChat.body.messages[r.searchChat.body.messages.length - 1].content;
  assert.ok(injected.includes('[1] 2026 年诺贝尔物理学奖揭晓') && injected.includes('https://news.example.com/nobel-2026-physics') && injected.includes('用户问题：2026 年诺贝尔物理学奖颁给了谁？'));
  r.srcCards = await page.$$eval('.msg.assistant:last-child .src-card', e => e.length);
  r.cites = await page.$$eval('.msg.assistant:last-child .md .cite', e => e.map(x => x.textContent));
  assert.strictEqual(r.srcCards, 3);
  assert.deepStrictEqual(r.cites, ['1', '2', '3', '1', '2']);
  await page.click('.msg.assistant:last-child .md .cite');
  assert.strictEqual(await page.evaluate(() => window.__opened), 'https://www.nobelprize.org/prizes/physics/2026/summary/');
  await page.click('.msg.assistant:last-child .src-card:nth-child(2)');
  assert.strictEqual(await page.evaluate(() => window.__opened), 'https://news.example.com/nobel-2026-physics');
  r.savedSources = await page.evaluate(() => { const c = JSON.parse(window.__mem['convs.json'])[0]; const conv = JSON.parse(window.__mem['conv_' + c.id + '.json']); return conv.messages[1].sources.length; });
  assert.strictEqual(r.savedSources, 3);
  await page.evaluate(() => { document.querySelector('#messages').scrollTop = 0; });
  await shot('search');
  await page.click('#btn-search'); await sleep(200); // 关闭联网

  // 11) 文件对话：PDF + Markdown
  await page.click('#btn-new'); await sleep(300);
  const fileInput = await page.$('#file-input');
  await fileInput.uploadFile(path.join(FIX, 'sample-text.pdf'), path.join(FIX, 'notes.md'));
  await page.waitForFunction(() => document.querySelectorAll('#attach-preview .file-chip').length === 2 && !document.querySelector('#attach-preview .file-chip.loading'), { timeout: 15000 });
  r.chips = await page.$$eval('#attach-preview .file-chip', els => els.map(e => e.textContent));
  assert.ok(r.chips[0].includes('sample-text.pdf') && r.chips[0].includes('2 页'), r.chips[0]);
  await setInput('这份报告里本季度营收是多少？会议决定了什么？');
  await page.click('#btn-send'); await sleep(2600);
  r.fileReq = await lastPost();
  const fc = r.fileReq.body.messages[r.fileReq.body.messages.length - 1].content;
  assert.ok(fc.includes('【文件：sample-text.pdf】') && fc.includes('1280 万元') && fc.includes('同比增长 23%'), fc.slice(0, 300));
  assert.ok(fc.includes('【文件：notes.md】') && fc.includes('王磊'));
  assert.ok(fc.includes('用户的问题：这份报告里本季度营收是多少？'));
  r.msgChips = await page.$$eval('.msg.user .file-chip', e => e.length);
  assert.strictEqual(r.msgChips, 2);
  await page.evaluate(() => { document.querySelector('#messages').scrollTop = 0; });
  await shot('file-chat');

  // 12) 使用预定义 CMap 的中文 PDF + 扫描版 PDF
  await page.click('#btn-new'); await sleep(300);
  await (await page.$('#file-input')).uploadFile(path.join(FIX, 'sample-unigb.pdf'));
  await page.waitForFunction(() => document.querySelector('#attach-preview .file-chip') && !document.querySelector('#attach-preview .file-chip.loading'), { timeout: 15000 });
  r.cmapAssets = await page.evaluate(() => window.__assets || []);
  assert.ok(r.cmapAssets.includes('www/lib/cmaps/UniGB-UCS2-H.bcmap'), JSON.stringify(r.cmapAssets));
  await page.click('#attach-preview .thumb.doc .rm'); await sleep(150);
  await (await page.$('#file-input')).uploadFile(path.join(FIX, 'sample-scanned.pdf'));
  await page.waitForFunction(() => document.querySelector('#dialog-mask').classList.contains('show'), { timeout: 15000 });
  r.scanDialog = await page.evaluate(() => document.querySelector('#dialog-title').textContent + '|' + document.querySelector('#dialog-body').textContent);
  assert.ok(r.scanDialog.includes('扫描版') && r.scanDialog.includes('转成图片'), r.scanDialog);
  await shot('scanned-pdf');
  await page.click('#dialog-ok'); await sleep(200);
  r.scanThumbs = await page.$$eval('#attach-preview img', e => e.length);
  assert.strictEqual(r.scanThumbs, 1);
  await page.click('#attach-preview .thumb.doc .rm'); await sleep(150);
  assert.strictEqual(await page.$$eval('#attach-preview .thumb', e => e.length), 0);

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
