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
        const B = JSON.parse(body || '{}');
        const msgs = (B.messages || []);
        // 章节摘要（非流式）
        if (!B.stream && msgs.length === 1 && String(msgs[0].content).includes('章节摘要记录员')) {
          window.__summaryReqs = (window.__summaryReqs || []).concat([B]);
          const sm = 'FACTS:\n- 曹含森在王都西区的旧书店找到了失踪商人留下的账本\n- 张燕答应与曹含森一起调查北方商会\n\nCHARACTER_KNOWLEDGE:\n- 张燕：只知道失踪案与北方商人有关，不知道账本的存在\n- 书店老板：见过失踪商人最后一面\n\nPLAYER_KNOWLEDGE:\n- 玩家知道账本里记录了商会的秘密交易\n\nSECRET:\n- 曹含森拥有特殊魔法能力（对张燕保密）\n\nUNRESOLVED:\n- 真正的幕后组织尚未确认\n\nRELATIONSHIPS:\n- 曹含森 ↔ 张燕：合作，信任度上升\n\nOBJECTS:\n- 失踪商人的账本（曹含森持有）\n\nLOCATION:\n- 王都西区：夜间戒严';
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ choices: [{ message: { role: 'assistant', content: sm }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 300, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 900 } })); H.onEnd(id); }, 700);
          return;
        }
        const lastU = msgs.filter(m => m.role === 'user').pop();
        const uc = lastU ? (typeof lastU.content === 'string' ? lastU.content : JSON.stringify(lastU.content)) : '';
        const sys = (msgs.find(m => m.role === 'system') || {}).content || '';
        let text = '好的！下面是一个 **Python** 示例，读取文件并统计行数：\n\n```python\ndef count_lines(path):\n    with open(path, encoding="utf-8") as f:\n        return sum(1 for _ in f)\n\nprint(count_lines("notes.txt"))\n```\n\n| 方法 | 说明 |\n|---|---|\n| `open()` | 打开文件 |\n| `sum()` | 逐行计数 |\n\n> 提示：大文件也可以这样逐行处理，内存占用很低。\n';
        if (uc.includes('联网搜索结果')) text = '根据最新消息，**2026 年诺贝尔物理学奖**授予了三位在量子材料领域做出开创性贡献的科学家 [1]。\n\n获奖研究主要揭示了拓扑量子态在室温下的稳定机制，有望带来更低功耗的电子器件 [2][3]。\n\n- 颁奖机构：瑞典皇家科学院 [1]\n- 研究方向：量子材料、拓扑物态 [2]\n';
        else if (uc.includes('【文件：')) text = '我阅读了你上传的两个文件，要点如下：\n\n**《2026 年第三季度销售报告》**\n- 本季度总营收 **1280 万元**，同比增长 23%\n- 华东区贡献最大，占比 41%；线上渠道同比增长 57%\n- 下季度计划在成都、西安新开两家门店，预算 300 万元\n\n**会议纪要**\n- Q4 主推线上渠道，预算增加 15%（负责人：王磊，10 月 20 日前提交方案）\n\n> 结论：营收为 1280 万元，线上渠道是增长主力。';
        else if (sys.includes('专业翻译')) text = 'The weather is really nice today — shall we go for a walk in the park?';
        const rp = sys.includes('[WORLD]');
        if (rp) text = '（烛光在走廊尽头摇曳）张燕压低声音：“' + uc.slice(-12) + '……你确定要这么做？北方商会的人今晚一定会来。”她把斗篷拉紧，目光扫过旧书店斑驳的木门。' +
          '远处传来巡夜卫兵整齐的脚步声，石板路上积着薄薄的雨水，倒映着摇晃的灯笼。书店老板缩在柜台后，假装整理一摞发黄的旧书，手却一直在发抖。你注意到他的袖口沾着一点墨迹，和账本上的字迹颜色一模一样。'.repeat(3);
        if (uc.includes('版本测试')) { window.__verN = (window.__verN || 0) + 1; text = '版本回复 ' + window.__verN + '：' + (rp ? text.slice(0, 80) : '好的，这是第 ' + window.__verN + ' 次生成的回答。'); }
        // 模拟 DeepSeek 前缀缓存：与之前请求的最长公共前缀（按 64 token 粒度）
        const ser = JSON.stringify(msgs);
        let lcp = 0;
        (window.__prompts = window.__prompts || []).forEach(q => { let i = 0; const n = Math.min(q.length, ser.length); while (i < n && q.charCodeAt(i) === ser.charCodeAt(i)) i++; lcp = Math.max(lcp, i); });
        window.__prompts.push(ser);
        const ptok = Math.ceil(ser.length / 1.5), hit = Math.min(ptok, Math.floor(lcp / 1.5 / 64) * 64);
        const usage = { prompt_tokens: ptok, completion_tokens: Math.ceil(text.length / 1.5), total_tokens: ptok + Math.ceil(text.length / 1.5), prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: ptok - hit };
        const sse = rp ? [] : ['data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '用户想要一个简单的 Python 示例，我给出读取文件统计行数的代码。' } }] }) + '\n\n'];
        const step = rp ? 24 : 6;
        for (let i = 0; i < text.length; i += step) {
          const lastChunk = i + step >= text.length;
          const o = { choices: [{ index: 0, delta: { content: text.slice(i, i + step) }, finish_reason: lastChunk ? 'stop' : null }] };
          if (lastChunk && url.includes('deepseek') && B.stream_options && B.stream_options.include_usage) o.usage = usage; // DeepSeek：usage 在最后一个内容块上
          sse.push('data: ' + JSON.stringify(o) + '\n\n');
        }
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
  assert.deepStrictEqual(r.chat.req.body.stream_options, { include_usage: true }, 'DeepSeek 流式请求附带 include_usage');
  r.chatUsage = await page.evaluate(() => { const c = JSON.parse(window.__mem['convs.json'])[0]; return JSON.parse(window.__mem['conv_' + c.id + '.json']).messages[1].usage; });
  assert.strictEqual(r.chatUsage.source, 'deepseek'); assert.ok(r.chatUsage.prompt > 0 && r.chatUsage.miss > 0, JSON.stringify(r.chatUsage));
  assert.strictEqual(await page.$$eval('.mbadge', e => e.length), 0, '未开启插件时没有徽章');
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


  // 13) 插件：DeepSeek RP 缓存优化器 V1
  const rpConv = () => page.evaluate(() => { for (const k of Object.keys(window.__mem)) if (k.startsWith('conv_')) { const c = JSON.parse(window.__mem[k]); if (c.plugins && c.plugins.rpcache && c.plugins.rpcache.enabled) return c; } return null; });
  const rpLogs = async () => { const c = await rpConv(); return JSON.parse(await page.evaluate(k => window.__mem[k] || '[]', 'rplog_' + c.id + '.json')); };
  const waitIdle = () => page.waitForFunction(() => !document.querySelector('#btn-send').classList.contains('stop'), { timeout: 20000 });
  const panelClick = sel => page.evaluate(s => document.querySelector('#pp-body ' + s).click(), sel);
  const openBlock = t => page.evaluate(t => [...document.querySelectorAll('#pp-body .rp-block')].find(e => e.querySelector('.rb-title').textContent === t).click(), t);
  const typeBlock = v => page.evaluate(v => { const t = document.querySelector('#rb-text'); t.value = v; t.dispatchEvent(new Event('input')); }, v);
  const tab = k => page.evaluate(k => document.querySelector('#pp-body .seg button[data-tab="' + k + '"]').click(), k);
  // 面板里不应残留英文界面文字（允许：品牌 / 模型名、Token、RP，以及发送给模型的全大写标记如 [WORLD]、FACTS）
  const ALLOW_EN = new Set(['Token', 'DeepSeek', 'RP', 'OpenAI', 'Claude', 'NPC']);
  const englishLeft = () => page.evaluate(() => {
    const c = document.querySelector('#pp-body').cloneNode(true);
    c.querySelectorAll('.rb-prev, textarea, .l20-r').forEach(e => e.remove()); // 用户自己写的设定 / 摘要内容
    document.body.appendChild(c); const t = c.innerText; c.remove();
    return t.replace(/指纹 [0-9a-f]+…?/g, '');
  }).then(t => {
    const words = (t.match(/[A-Za-z][A-Za-z_\-]*[A-Za-z0-9]|\bv\d+/g) || []);
    return [...new Set(words.filter(w => !ALLOW_EN.has(w) && !/^[A-Z][A-Z0-9_]+$/.test(w) && !/^deepseek/.test(w)))];
  });
  const closePanels = async () => { for (let i = 0; i < 4 && await page.evaluate(() => document.querySelector('#page-plugin.show,#page-plugins.show') != null); i++) { await page.evaluate(() => window.onAndroidBack()); await sleep(350); } };
  const sendRP = async t => { await setInput(t); await page.click('#btn-send'); await sleep(200); await waitIdle(); await sleep(250); return lastPost(); };

  await page.click('#btn-new'); await sleep(300);
  await page.click('#model-pill'); await sleep(250); await pickModel('deepseek-flash'); await sleep(250);
  await page.click('#btn-menu'); await sleep(350);
  r.pluginRow = await page.$eval('#plugin-count', e => e.textContent);
  assert.ok(r.pluginRow.includes('2 个内置插件'), r.pluginRow);
  await page.click('#btn-plugins'); await sleep(650);
  r.pluginCards = await page.$$eval('#plugin-list .plugin-card .plc-name', els => els.map(e => e.textContent));
  assert.ok(r.pluginCards[0].startsWith('DeepSeek RP 缓存优化器') && r.pluginCards[1].startsWith('Token 用量显示'), JSON.stringify(r.pluginCards));
  await page.evaluate(() => document.querySelectorAll('#plugin-list .plugin-card')[0].querySelector('.plc-set').click()); await sleep(200);
  r.priceInputs = await page.$$eval('#plugin-list input[data-m]', e => e.map(x => x.value));
  assert.deepStrictEqual(r.priceInputs, ['0.006', '0.3', '1.2', '0.044', '1.32', '3.96']);
  await shot('plugins');
  await page.evaluate(() => document.querySelectorAll('#plugin-list .plugin-card')[0].querySelector('.plc-open').click()); await sleep(500);
  assert.ok(await page.$eval('#page-plugin', e => e.classList.contains('show')));
  await page.click('#rp-on'); await sleep(300);
  r.tabs = await page.$$eval('#pp-body .seg button', e => e.map(x => x.textContent));
  assert.deepStrictEqual(r.tabs, ['分层设定', '章节摘要', '缓存监控', '预算设置']);
  r.layers = await page.$$eval('#pp-body .layer-head .lh-no', e => e.map(x => x.textContent));
  assert.deepStrictEqual(r.layers, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']);
  // 编辑 L1 / L2 / L5
  const blocks = [['世界观', '这是一个剑与魔法的世界。王都分为东西两区，西区夜间戒严。\r\n北方商会垄断了盐与铁的贸易。'], ['角色卡', '张燕：22 岁，王都巡夜队副队长，谨慎、嘴硬心软。\n曹含森（玩家）：23 岁，旧书店常客。'],
    ['RP 规则', '1. NPC 不能读取玩家内心\n2. NPC 只知道自己应该知道的信息\n3. 不替玩家决定行动\n4. 保持人物性格连续'], ['示例对白', ('玩家：我走进酒馆，环顾四周。\n角色：（酒馆里人声嘈杂，壁炉里的火噼啪作响）张燕靠在吧台边，抬眼看了你一下，又低头转着手里的酒杯：“这么晚还出来？西区可不太平。”\n\n').repeat(6)], ['长期记忆', '张燕尚不知道曹含森拥有特殊魔法能力。\n任务：调查北方商会失踪事件。'],
    ['当前动态状态', 'Location: 王都西区\nTime: 21:40\nHP: 82/100\nZhangYan_Affection: 37']];
  for (const [t, v] of blocks) { await openBlock(t); await sleep(250); await typeBlock(v); await page.click('#rb-save'); await sleep(250); }
  // 只改空白：版本不变
  await openBlock('世界观'); await sleep(250);
  await typeBlock('这是一个剑与魔法的世界。王都分为东西两区，西区夜间戒严。   \n北方商会垄断了盐与铁的贸易。\n\n\n\n\n\n');
  r.wsMeta = await page.$eval('#rb-meta', e => e.textContent);
  assert.ok(r.wsMeta.includes('未修改'), r.wsMeta);
  await page.click('#rb-save'); await sleep(250);
  // 真正修改：v2，历史中可恢复 v1
  await openBlock('世界观'); await sleep(250);
  await typeBlock('这是一个剑与魔法的世界。王都分为东西两区，西区夜间戒严。\n北方商会垄断了盐与铁的贸易，暗中豢养刺客。');
  await page.click('#rb-save'); await sleep(250);
  let st = (await rpConv()).plugins.rpcache.state;
  r.versions = Object.fromEntries(st.blocks.map(b => [b.id, b.version]));
  assert.strictEqual(r.versions.world, 2, JSON.stringify(r.versions)); assert.strictEqual(r.versions.character, 1); assert.strictEqual(r.versions.state, 1);
  assert.strictEqual(st.staticVersion, 5);
  assert.ok(!st.blocks.find(b => b.id === 'world').content.includes('\r'), 'CRLF 已规范化');
  await page.evaluate(() => { document.querySelector('#page-plugin .page-body').scrollTop = 0; });
  await shot('rp-blocks');
  r.blocksEn = await englishLeft(); assert.deepStrictEqual(r.blocksEn, [], '分层设定 ' + JSON.stringify(r.blocksEn));
  r.layerHeads = await page.$$eval('#pp-body .layer-head .lh-t', e => e.map(x => x.textContent));
  assert.deepStrictEqual(r.layerHeads, ['固定设定', '长期记忆', '章节摘要（冻结）', '对话历史', '当前状态', '本轮输入']);
  assert.ok((await page.$eval('#pp-body', e => e.textContent)).includes('固定设定 第 5 版'));
  await openBlock('世界观'); await sleep(300);
  r.hist = await page.$$eval('#rb-hist .hist-row .rb-ver', e => e.map(x => x.textContent));
  assert.deepStrictEqual(r.hist, ['第 1 版']);
  assert.deepStrictEqual(await englishLeft(), [], '分层设定编辑页');
  await shot('rp-block-editor');
  await page.click('#rb-back'); await sleep(250);
  await closePanels();

  // 发送几轮：L1→L2 在 system，L5+L6 在最后一条用户消息，历史前缀逐字节稳定
  r.badge = await page.$eval('#conv-bar', e => e.textContent);
  assert.ok(r.badge.includes('RP'), r.badge);
  const rq = [];
  rq.push(await sendRP('我推开旧书店的门，低声问老板：失踪的商人最后来过这里吗？'));
  rq.push(await sendRP('我拿出那本账本给张燕看。'));
  // 修改动态状态（L5）：不影响历史缓存
  await page.click('#conv-bar .hbadge'); await sleep(450); await tab('blocks'); await sleep(200);
  await openBlock('当前动态状态'); await sleep(250); await typeBlock('Location: 王都西区 · 旧书店\nTime: 22:05\nHP: 82/100\nZhangYan_Affection: 41'); await page.click('#rb-save'); await sleep(250);
  await closePanels();
  rq.push(await sendRP('我们从后门离开，沿着运河往北走。'));
  rq.push(await sendRP('我问张燕：你相信商会会长吗？'));
  rq.forEach((q, i) => {
    const m = q.body.messages;
    assert.strictEqual(m[0].role, 'system');
    const sys = m[0].content;
    const order = ['[WORLD]', '[CHARACTER]', '[RP_RULES]', '[LONG_TERM_MEMORY]'].map(t => sys.indexOf(t));
    assert.ok(order.every((x, j) => x > (j ? order[j - 1] : -1)), '系统提示词分层顺序 ' + order);
    assert.ok(!sys.includes('[CURRENT_STATE]') && !sys.includes('HP:'), '状态不在 system');
    assert.ok(m[m.length - 1].content.startsWith('[CURRENT_STATE]\nLocation: 王都西区') && m[m.length - 1].content.includes('\n\n[USER_INPUT]\n'), '状态 + 输入在最后');
    m.slice(1, -1).forEach(x => assert.ok(!x.content.includes('[CURRENT_STATE]'), '历史中不保留旧状态'));
    assert.deepStrictEqual(q.body.stream_options, { include_usage: true });
    if (i) {
      const prev = rq[i - 1].body.messages; const k = prev.length - 1;
      assert.deepStrictEqual(m.slice(0, k), prev.slice(0, k), '第 ' + (i + 1) + ' 轮的前缀与上一轮完全一致');
      assert.strictEqual(m[k].content, prev[k].content.split('\n\n[USER_INPUT]\n')[1], '上一轮输入以原文进入历史');
    }
  });
  let logs = await rpLogs();
  assert.strictEqual(logs.length, 4);
  assert.deepStrictEqual(logs[3].diag, { static: 'SAME', memory: 'SAME', summary: 'SAME', state: 'SAME', input: 'CHANGED', history: 'APPEND' });
  assert.strictEqual(logs[2].diag.state, 'CHANGED'); assert.strictEqual(logs[2].diag.history, 'APPEND');
  assert.ok(logs[3].hit_rate > 0.7, 'hit ' + logs[3].hit_rate);
  assert.strictEqual(logs[3].reason, '正常动态更新');
  assert.ok(!JSON.stringify(logs).includes('账本'), '日志默认不含 Prompt 文本');
  r.mbadges = await page.$$eval('.msg.assistant .mbadge', e => e.map(x => x.textContent));
  assert.strictEqual(r.mbadges.length, 4); assert.ok(r.mbadges[3].startsWith('缓存 '), r.mbadges[3]);
  await page.evaluate(() => [...document.querySelectorAll('.msg.assistant .mbadge')].pop().click()); await sleep(500);
  r.diagUi = await page.$$eval('#pp-body .dg-row', e => e.map(x => x.textContent));
  assert.deepStrictEqual(r.diagUi, ['固定设定未变', '长期记忆未变', '章节摘要未变', '对话历史追加', '当前状态未变', '本轮输入已改动']);
  r.monKv = await page.$$eval('#pp-body .kv span', e => e.map(x => x.textContent));
  ['输入 Token', '缓存命中', '未命中', '输出 Token', '今日请求', '命中率', '平均命中率', '最高 / 最低'].forEach(k => assert.ok(r.monKv.includes(k), k + ' ' + JSON.stringify(r.monKv)));
  assert.ok((await page.$eval('#pp-body', e => e.textContent)).includes('请求编号 #0004'));
  assert.ok((await page.$eval('#pp-body .dg-reason', e => e.textContent)).startsWith('原因：'));
  r.monEn = await englishLeft(); assert.deepStrictEqual(r.monEn, [], '缓存监控 ' + JSON.stringify(r.monEn));
  assert.ok((await page.$eval('#pp-body .dg-reason', e => e.textContent)).includes('正常动态更新'));
  assert.ok(await page.$('#pp-body .miss-big'));
  await shot('rp-monitor');

  // 修改角色卡（L1）→ 命中率骤降 → 异常提示 + Static CHANGED
  await tab('blocks'); await sleep(200);
  await openBlock('角色卡'); await sleep(250); await typeBlock('张燕：22 岁，王都巡夜队副队长，谨慎、嘴硬心软，左手有旧伤。\n曹含森（玩家）：23 岁，旧书店常客。'); await page.click('#rb-save'); await sleep(250);
  await closePanels();
  await sendRP('我注意到张燕的左手在发抖。');
  logs = await rpLogs();
  const la = logs[logs.length - 1];
  assert.strictEqual(la.diag.static, 'CHANGED'); assert.ok(la.hit_rate < 0.3, 'rate ' + la.hit_rate);
  assert.ok(la.reasons.includes('角色卡 / 世界观等永久锚点被修改'));
  r.anomBadge = await page.evaluate(() => [...document.querySelectorAll('.msg.assistant .mbadge')].pop().textContent);
  assert.ok(r.anomBadge.startsWith('⚠'), r.anomBadge + ' ' + JSON.stringify(logs.map(x => x.hit_rate)));
  await page.evaluate(() => [...document.querySelectorAll('.msg.assistant .mbadge')].pop().click()); await sleep(500);
  r.alert = await page.$eval('#pp-body .rp-alert', e => e.textContent);
  assert.ok(r.alert.includes('缓存命中率骤降') && r.alert.includes('固定设定指纹变化'), r.alert);
  assert.deepStrictEqual(await englishLeft(), [], '异常提示');
  await shot('rp-anomaly');

  // 预算设置：调低摘要阈值 → 下一轮自动生成章节摘要 #001
  await tab('opts'); await sleep(250);
  r.optLabels = await page.$$eval('#pp-body .field > span', e => e.map(x => x.firstChild.textContent));
  ['上下文上限', '输出预留', '安全余量', '触发摘要的历史长度', '至少新增轮数', '保留最近轮数', '保存完整提示词', '超过阈值自动生成摘要'].forEach(k => assert.ok(r.optLabels.includes(k), k + ' ' + JSON.stringify(r.optLabels)));
  assert.ok(await page.$$eval('#pp-body .field > span small', e => e.length) >= 8, '每项都有中文说明');
  r.optEn = await englishLeft(); assert.deepStrictEqual(r.optEn, [], '预算设置 ' + JSON.stringify(r.optEn));
  await page.evaluate(() => { document.querySelector('#page-plugin .page-body').scrollTop = 0; });
  await shot('rp-budget');
  await page.evaluate(() => { const set = (id, v) => { const i = document.querySelector(id); i.value = v; i.dispatchEvent(new Event('change')); }; set('#rp-trigger', 1000); set('#rp-minnew', 2); set('#rp-keep', 2); });
  st = (await rpConv()).plugins.rpcache.state;
  assert.deepStrictEqual(st.settings.summary, { enabled: true, trigger_tokens: 1000, min_new_turns: 2, keep_recent_turns: 2 });
  assert.strictEqual(st.settings.max_context, 100000); assert.strictEqual(st.settings.save_prompt, false);
  await closePanels();
  await setInput('我们在运河边停下，我把账本的事告诉了张燕。'); await page.click('#btn-send'); await sleep(250);
  r.sumStatus = await page.$eval('.msg.assistant:last-child', e => e.textContent);
  assert.ok(r.sumStatus.includes('正在生成章节摘要…'), r.sumStatus);
  await waitIdle(); await sleep(300);
  const sumReq = await page.evaluate(() => (window.__summaryReqs || []).slice(-1)[0]);
  assert.ok(sumReq && sumReq.stream === false && sumReq.model === 'deepseek-flash');
  const sp = sumReq.messages[0].content;
  ['FACTS:', 'CHARACTER_KNOWLEDGE:', 'PLAYER_KNOWLEDGE:', 'SECRET:', 'UNRESOLVED:', 'RELATIONSHIPS:', 'OBJECTS:', 'LOCATION:'].forEach(k => assert.ok(sp.includes(k), k));
  assert.ok(sp.includes('失踪的商人最后来过这里吗'), '最旧一批对话进入摘要');
  const afterSum = await lastPost();
  const am = afterSum.body.messages;
  assert.ok(am[0].content.includes('[CHAPTER_SUMMARY #001]\nFACTS:'), '摘要在 system（L3）');
  assert.ok(am[0].content.indexOf('[LONG_TERM_MEMORY]') < am[0].content.indexOf('[CHAPTER_SUMMARY #001]'));
  assert.strictEqual(am.filter(x => x.role === 'user').length, 3, '保留最近 2 轮 + 当前输入');
  assert.ok(!am.some(x => x.content.includes('失踪的商人最后来过这里吗')), '被摘要的消息不再发送');
  const c13 = await rpConv();
  assert.strictEqual(c13.messages.length, 12, '原始消息全部保留');
  st = c13.plugins.rpcache.state;
  assert.strictEqual(st.summaries.length, 1); assert.strictEqual(st.summaries[0].coveredIds.length, 6);
  logs = await rpLogs();
  assert.strictEqual(logs[logs.length - 1].summary_happened, true); assert.strictEqual(logs[logs.length - 1].diag.summary, 'CHANGED');
  r.dim = await page.$$eval('.msg.dim', e => e.length);
  assert.strictEqual(r.dim, 6);
  r.dimLabel = await page.$$eval('.msg.dim .msg-state', e => e.map(x => x.textContent).filter(Boolean));
  assert.ok(r.dimLabel[0].includes('章节摘要 #001') && r.dimLabel[0].includes('原文保留'), JSON.stringify(r.dimLabel));
  r.sumBadges = await page.$$eval('.msg.assistant .mbadge', e => e.map(x => x.textContent));
  assert.ok(r.sumBadges.includes('📚 摘要 #001'));
  await page.evaluate(() => { const ms = document.querySelector('#messages'); const d = [...document.querySelectorAll('.msg.dim')].pop(); ms.scrollTop = d.offsetTop - 420; });
  await shot('rp-chat');
  // 下一轮：摘要冻结，前缀稳定，不再调用摘要
  await sendRP('张燕点点头：“明天一早去商会。”');
  const nx = (await lastPost()).body.messages;
  assert.strictEqual(nx[0].content, am[0].content);
  assert.deepStrictEqual(nx.slice(0, am.length - 1), am.slice(0, am.length - 1));
  assert.strictEqual(await page.evaluate(() => window.__summaryReqs.length), 1);
  logs = await rpLogs();
  assert.strictEqual(logs[logs.length - 1].diag.summary, 'SAME'); assert.strictEqual(logs[logs.length - 1].diag.history, 'APPEND');
  // 摘要页：查看 / 编辑（生成新快照 #002）/ 版本列表 / 回滚
  await page.click('#conv-bar .hbadge:nth-child(2)'); await sleep(500);
  r.sumTab = await page.$eval('#pp-body .seg button.active', e => e.textContent);
  assert.strictEqual(r.sumTab, '章节摘要');
  await panelClick('#rp-sum-cur'); await sleep(300);
  r.svText = await page.$eval('#sv-text', e => e.value);
  assert.ok(r.svText.startsWith('FACTS:'), '保存的摘要文本保持英文段落标题');
  r.legend = await page.$eval('#sv-legend', e => e.textContent);
  assert.ok(r.legend.includes('FACTS') && r.legend.includes('已发生的事实') && r.legend.includes('PLAYER_KNOWLEDGE') && r.legend.includes('玩家知道的'), r.legend);
  await shot('rp-summary');
  await page.evaluate(() => { const t = document.querySelector('#sv-text'); t.value = t.value.replace('信任度上升', '信任度明显上升'); t.dispatchEvent(new Event('input')); });
  await page.click('#sv-save'); await sleep(300);
  r.sumHist = await page.$$eval('#rp-sum-hist .hist-row .rb-ver', e => e.map(x => x.textContent));
  assert.deepStrictEqual(r.sumHist, ['#001']);
  await page.evaluate(() => document.querySelector('#rp-sum-hist .hist-row button').click()); await sleep(350);
  await page.click('#dialog-ok'); await sleep(350);
  st = (await rpConv()).plugins.rpcache.state;
  assert.deepStrictEqual(st.summaries.map(x => [x.no, x.source]), [[1, 'auto'], [2, 'edit'], [3, 'rollback']]);
  assert.strictEqual(st.summaries[2].content, st.summaries[0].content);
  await shot('rp-summary-versions');
  // 调试开关：save_prompt 需确认警告
  await tab('opts'); await sleep(250);
  await page.click('#rp-saveprompt'); await sleep(350);
  r.spWarn = await page.$eval('#dialog-body', e => e.textContent);
  assert.ok(r.spWarn.includes('日志可能包含角色卡、私密剧情、API 请求内容，请谨慎使用'));
  await page.click('#dialog-cancel'); await sleep(300);
  assert.strictEqual(await page.$eval('#rp-saveprompt', e => e.checked), false);
  await closePanels();
  // 关闭插件后请求恢复普通结构
  await page.click('#model-pill'); await sleep(250);
  r.toolItem = await page.$$eval('#model-menu .pm-item.tool', e => e.map(x => x.textContent));
  assert.ok(r.toolItem.some(t => t.includes('RP 缓存优化（已开启）')), JSON.stringify(r.toolItem));
  await page.evaluate(() => [...document.querySelectorAll('#model-menu .pm-item.tool')].find(e => e.textContent.includes('RP 缓存优化')).click()); await sleep(500);
  await page.click('#rp-on'); await sleep(300);
  await closePanels();
  await sendRP('普通消息');
  const plain = (await lastPost()).body.messages;
  assert.ok(!plain.some(x => x.content.includes('[WORLD]') || x.content.includes('[CURRENT_STATE]')), '关闭后不再注入');
  assert.strictEqual(plain[plain.length - 1].content, '普通消息');

  // 14) 提示词模板：快速切换系统提示词（与 ⚡ 提示词库 / 助手区分）
  const tplStore = () => page.evaluate(() => JSON.parse(window.__mem['templates.json'] || '[]'));
  const tqPick = name => page.evaluate(n => [...document.querySelectorAll('#tq-list .tpl-item')].find(e => e.querySelector('.pi-t').textContent.includes(n)).click(), name);
  const curConv = () => page.evaluate(() => { const ids = JSON.parse(window.__mem['convs.json']); return JSON.parse(window.__mem['conv_' + ids[0].id + '.json']); });
  const actionClick = t => page.evaluate(t => [...document.querySelectorAll('#action-list .action-item')].find(e => e.textContent.includes(t)).click(), t);
  const tmRows = () => page.$$eval('#tm-list .tm-row .pi-name', e => e.map(x => x.textContent));
  const tmMore = name => page.evaluate(n => [...document.querySelectorAll('#tm-list .tm-row')].find(e => e.querySelector('.pi-name').textContent.startsWith(n)).querySelector('.ci-more').click(), name);
  r.tplBuiltin = await tplStore();
  assert.strictEqual(r.tplBuiltin.length, 8, '首次启动写入 8 个内置模板');
  await page.click('#btn-new'); await sleep(300);
  assert.strictEqual(await page.$eval('#tpl-chip-label', e => e.textContent), '模板');
  await page.click('#btn-template'); await sleep(450);
  assert.ok(await page.$eval('#tpl-sheet', e => e.classList.contains('show')));
  r.tqItems = await page.$$eval('#tq-list .tpl-item .pi-t', e => e.map(x => x.textContent));
  assert.ok(r.tqItems[0].includes('通用助手') && r.tqItems[1].includes('简洁回答'), '收藏在前 ' + JSON.stringify(r.tqItems.slice(0, 3)));
  assert.ok(r.tqItems.some(t => t.includes('翻译官')), '助手可以当模板套用');
  assert.ok((await page.$eval('#tpl-sheet', e => e.textContent)).includes('替换本对话的系统提示词'));
  await shot('templates');
  await tqPick('简洁回答'); await sleep(350);
  assert.ok(!(await page.$eval('#tpl-sheet', e => e.classList.contains('show'))), '点一下立即应用并关闭');
  assert.strictEqual(await page.$eval('#tpl-chip-label', e => e.textContent), '简洁回答');
  r.tplBadge = await page.$eval('#conv-bar .hbadge.tpl', e => e.textContent);
  assert.ok(r.tplBadge.includes('简洁回答'), r.tplBadge);
  await setInput('什么是 TCP？'); await page.click('#btn-send'); await sleep(200); await waitIdle(); await sleep(250);
  const concise = r.tplBuiltin.find(t => t.id === 't-concise').content;
  r.tplReq = await lastPost();
  assert.deepStrictEqual(r.tplReq.body.messages[0], { role: 'system', content: concise });
  let cc = await curConv();
  assert.strictEqual(cc.templateId, 't-concise'); assert.strictEqual(cc.systemPrompt, concise);
  await shot('template-chat');
  r.toolsRow = await page.$$eval('.composer-tools > *', els => els.filter(e => e.offsetWidth).map(e => { const b = e.getBoundingClientRect(); return [Math.round(b.top + b.height / 2), Math.round(b.right), e.scrollWidth <= e.clientWidth + 1]; }));
  assert.ok(r.toolsRow.every(x => Math.abs(x[0] - r.toolsRow[0][0]) <= 2 && x[2]), '输入栏工具保持一行 ' + JSON.stringify(r.toolsRow));
  assert.ok(r.toolsRow[r.toolsRow.length - 1][1] <= 390, '发送按钮不溢出');
  // 变量：以某种身份回答 → 填写 {{身份}} {{语气}}
  await page.click('#conv-bar .hbadge.tpl'); await sleep(450);
  assert.ok((await page.$eval('#tq-cur', e => e.textContent)).includes('简洁回答'));
  assert.ok(await page.$eval('#tq-list .tpl-item.current .tpl-cur', e => e.textContent === '使用中'));
  await tqPick('以某种身份回答'); await sleep(400);
  assert.ok(await page.$eval('#tv-mask', e => e.classList.contains('show')));
  r.tvFields = await page.$$eval('#tv-fields input', e => e.map(x => x.dataset.var));
  assert.deepStrictEqual(r.tvFields, ['身份', '语气']);
  await page.evaluate(() => { const [a, b] = document.querySelectorAll('#tv-fields input'); a.value = '资深律师'; a.dispatchEvent(new Event('input')); b.value = '严谨'; b.dispatchEvent(new Event('input')); });
  await sleep(150);
  assert.ok((await page.$eval('#tv-preview', e => e.textContent)).includes('资深律师'));
  await shot('template-vars');
  await page.click('#tv-ok'); await sleep(400);
  await setInput('合同违约怎么办？'); await page.click('#btn-send'); await sleep(200); await waitIdle(); await sleep(250);
  r.varReq = await lastPost();
  assert.strictEqual(r.varReq.body.messages[0].content, '请以资深律师的身份和专业视角回答我的问题，语气严谨。');
  assert.ok(r.varReq.body.messages.some(m => m.role === 'assistant'), '历史保留');
  r.recent = await page.evaluate(() => JSON.parse(window.__mem['settings.json']).recentTemplates);
  assert.deepStrictEqual(r.recent, ['t-role', 't-concise']);
  // 助手当模板
  await page.click('#btn-template'); await sleep(400);
  r.recentSec = await page.$$eval('#tq-list .tq-sec', e => e.map(x => x.textContent));
  assert.strictEqual(r.recentSec[0], '最近使用');
  await tqPick('翻译官'); await sleep(350);
  cc = await curConv();
  assert.ok(cc.systemPrompt.includes('专业翻译') && String(cc.templateId).startsWith('persona:') && cc.templateName === '翻译官', JSON.stringify(cc.templateId));
  // 清空
  await page.click('#btn-template'); await sleep(400);
  await page.click('#tq-clear'); await sleep(350);
  cc = await curConv();
  assert.strictEqual(cc.systemPrompt, ''); assert.ok(!cc.templateId);
  assert.strictEqual(await page.$('#conv-bar .hbadge.tpl'), null);
  assert.strictEqual(await page.$eval('#tpl-chip-label', e => e.textContent), '模板');
  // ⚡ 提示词库仍然是插入输入框（不改系统提示词）
  await page.click('#btn-prompts'); await sleep(400);
  assert.ok((await page.$eval('#prompt-sheet', e => e.textContent)).includes('插入文字到输入框'));
  await page.evaluate(() => [...document.querySelectorAll('#prompt-list .prompt-item')].find(e => e.textContent.includes('润色')).click()); await sleep(300);
  assert.ok((await page.$eval('#input', e => e.value)).startsWith('请帮我润色'));
  assert.strictEqual((await curConv()).systemPrompt, '');
  await setInput('');

  // 管理页：新建 / 编辑 / 复制 / 收藏 / 排序 / 删除 / 导入导出 / 默认模板
  await page.click('#btn-menu'); await sleep(350);
  assert.ok((await page.$eval('#template-count', e => e.textContent)).includes('8 个模板'));
  await page.click('#btn-templates'); await sleep(550);
  assert.ok(await page.$eval('#page-templates', e => e.classList.contains('show')));
  assert.strictEqual((await tmRows()).length, 8);
  await page.click('#tm-new'); await sleep(450);
  await page.evaluate(() => { const set = (id, v) => { const i = document.querySelector(id); i.value = v; i.dispatchEvent(new Event('input')); };
    set('#te-emoji', '🦉'); set('#te-name', '小红书文案'); set('#te-tags', '写作, 营销'); set('#te-content', '你是小红书爆款文案写手，主题是{{主题}}，多用 emoji 和短句。'); });
  await sleep(150);
  assert.ok((await page.$eval('#te-vars', e => e.textContent)).includes('{{主题}}'));
  await shot('template-edit');
  await page.click('#te-save'); await sleep(450);
  r.rows = await tmRows();
  assert.strictEqual(r.rows.length, 9);
  let ts = await tplStore();
  assert.strictEqual(ts[0].name, '小红书文案'); assert.deepStrictEqual(ts[0].tags, ['写作', '营销']); assert.strictEqual(ts[0].emoji, '🦉');
  // 编辑（点行）
  await page.evaluate(() => [...document.querySelectorAll('#tm-list .tm-row')].find(e => e.textContent.includes('小红书文案')).click()); await sleep(400);
  assert.strictEqual(await page.$eval('#te-title', e => e.textContent), '编辑模板');
  await page.evaluate(() => { document.querySelector('#te-name').value = '小红书爆款'; });
  await page.click('#te-save'); await sleep(400);
  ts = await tplStore(); assert.strictEqual(ts.length, 9); assert.strictEqual(ts[0].name, '小红书爆款');
  // 复制
  await tmMore('小红书爆款'); await sleep(350);
  r.tmActions = await page.$$eval('#action-list .action-item', e => e.map(x => x.textContent.trim()));
  assert.deepStrictEqual(r.tmActions, ['应用到当前对话', '编辑', '复制一份', '上移', '下移', '设为新对话默认', '删除']);
  await actionClick('复制一份'); await sleep(400);
  ts = await tplStore(); assert.strictEqual(ts[1].name, '小红书爆款（副本）');
  // 下移
  await tmMore('小红书爆款（副本）'); await sleep(350); await actionClick('下移'); await sleep(350);
  ts = await tplStore(); assert.strictEqual(ts[2].name, '小红书爆款（副本）');
  // 收藏 → 排到前面（收藏区）
  await page.evaluate(() => [...document.querySelectorAll('#tm-list .tm-row')].find(e => e.querySelector('.pi-name').textContent === '中英互译').querySelector('.tm-pin').click()); await sleep(300);
  ts = await tplStore(); assert.strictEqual(ts.find(t => t.id === 't-translate').pinned, true);
  r.rows = await tmRows();
  assert.ok(r.rows.indexOf('中英互译') < r.rows.indexOf('小红书爆款'), '收藏的排在前面 ' + JSON.stringify(r.rows));
  // 标签筛选 + 搜索
  await page.evaluate(() => [...document.querySelectorAll('#tm-tags .chip')].find(e => e.textContent === '营销').click()); await sleep(250);
  assert.deepStrictEqual(await tmRows(), ['小红书爆款', '小红书爆款（副本）']);
  await page.evaluate(() => [...document.querySelectorAll('#tm-tags .chip')].find(e => e.textContent === '全部').click()); await sleep(200);
  await page.evaluate(() => { const i = document.querySelector('#tm-search'); i.value = '翻译'; i.dispatchEvent(new Event('input')); }); await sleep(200);
  assert.deepStrictEqual(await tmRows(), ['中英互译']);
  await page.evaluate(() => { const i = document.querySelector('#tm-search'); i.value = ''; i.dispatchEvent(new Event('input')); }); await sleep(200);
  await shot('template-manage');
  // 删除副本 + 删除内置「代码审查」
  await tmMore('小红书爆款（副本）'); await sleep(350); await actionClick('删除'); await sleep(350); await page.click('#dialog-ok'); await sleep(400);
  await tmMore('代码审查'); await sleep(350); await actionClick('删除'); await sleep(350);
  assert.ok((await page.$eval('#dialog-body', e => e.textContent)).includes('内置模板删除后不会再自动出现'));
  await page.click('#dialog-ok'); await sleep(400);
  ts = await tplStore(); assert.strictEqual(ts.length, 8); assert.ok(!ts.some(t => t.id === 't-coder'));
  assert.deepStrictEqual(await page.evaluate(() => JSON.parse(window.__mem['settings.json']).removedTemplates), ['t-coder']);
  // 导出 / 导入
  await page.click('#tm-more'); await sleep(350); await actionClick('导出全部'); await sleep(300);
  r.exported = await page.evaluate(() => JSON.parse(window.__copied));
  assert.strictEqual(r.exported.format, 'ai-chat-templates'); assert.strictEqual(r.exported.templates.length, 8);
  await page.click('#tm-more'); await sleep(350); await actionClick('粘贴 JSON 导入'); await sleep(350);
  await page.evaluate(() => { document.querySelector('#dialog-input').value = JSON.stringify({ templates: [{ name: '周报助手', emoji: '📈', content: '把我的要点整理成周报：本周完成、问题、下周计划。' }, { name: '中英互译', content: 'dup' }].concat(JSON.parse(window.__copied).templates.slice(0, 2)) }); });
  await page.click('#dialog-ok'); await sleep(450);
  ts = await tplStore(); assert.strictEqual(ts.length, 10, '新增 2 个（同名不同内容也算新），重复的 2 个跳过');
  assert.ok(ts.some(t => t.name === '周报助手'));
  await page.click('#tm-more'); await sleep(350); await actionClick('粘贴 JSON 导入'); await sleep(350);
  await page.evaluate(() => { document.querySelector('#dialog-input').value = '{broken'; }); await page.click('#dialog-ok'); await sleep(450);
  assert.strictEqual(await page.$eval('#dialog-title', e => e.textContent), '导入失败');
  await page.click('#dialog-ok'); await sleep(300);
  // 设为新对话默认（含变量的不允许）
  await tmMore('小红书爆款'); await sleep(350); await actionClick('设为新对话默认'); await sleep(300);
  assert.ok(!(await page.evaluate(() => JSON.parse(window.__mem['settings.json']).defaultTemplateId)));
  await tmMore('润色改写'); await sleep(350); await actionClick('设为新对话默认'); await sleep(300);
  assert.strictEqual(await page.evaluate(() => JSON.parse(window.__mem['settings.json']).defaultTemplateId), 't-polish');
  assert.ok((await page.$$eval('#tm-list .tm-row .pi-name', e => e.map(x => x.textContent))).some(t => t === '润色改写新对话默认'));
  await page.evaluate(() => window.onAndroidBack()); await sleep(400);
  assert.ok(!(await page.$eval('#page-templates', e => e.classList.contains('show'))));
  await page.click('#btn-new'); await sleep(350);
  assert.ok((await page.$eval('#conv-bar .hbadge.tpl', e => e.textContent)).includes('润色改写'));
  await setInput('这句话帮我改一下：我们公司产品非常的好用'); await page.click('#btn-send'); await sleep(200); await waitIdle(); await sleep(250);
  assert.strictEqual((await lastPost()).body.messages[0].content, r.tplBuiltin.find(t => t.id === 't-polish').content);
  // 设置页里也能改默认模板
  await page.click('#btn-menu'); await sleep(350); await page.click('#btn-settings'); await sleep(500);
  assert.strictEqual(await page.$eval('#set-deftpl', e => e.value), 't-polish');
  r.defOpts = await page.$$eval('#set-deftpl option', e => e.map(x => x.textContent));
  assert.ok(!r.defOpts.some(t => t.includes('小红书')), '含变量的模板不在默认列表');
  await page.select('#set-deftpl', ''); await sleep(200);
  assert.strictEqual(await page.evaluate(() => JSON.parse(window.__mem['settings.json']).defaultTemplateId), null);
  await page.evaluate(() => window.onAndroidBack()); await sleep(400);

  // RP 插件：切换模板 = 显式的 L1 静态更新（确认警告 + 监控原因）
  await page.click('#btn-menu'); await sleep(350);
  const rpMeta = await page.evaluate(() => { for (const k of Object.keys(window.__mem)) if (k.startsWith('conv_')) { const c = JSON.parse(window.__mem[k]); if (c.plugins && c.plugins.rpcache) return { id: c.id, title: c.title }; } return null; });
  const rpIdx = await page.evaluate(() => JSON.parse(window.__mem['convs.json']).findIndex(c => { const x = JSON.parse(window.__mem['conv_' + c.id + '.json']); return x.plugins && x.plugins.rpcache; }));
  await page.evaluate(i => document.querySelectorAll('.conv-item')[i].click(), rpIdx); await sleep(500);
  assert.ok(!(await page.$eval('#drawer', e => e.classList.contains('show'))));
  assert.strictEqual(await page.$eval('#mp-model', e => e.textContent), 'deepseek-flash', rpMeta.title);
  await page.click('#model-pill'); await sleep(250);
  r.tplTool = await page.$$eval('#model-menu .pm-item.tool', e => e.map(x => x.textContent));
  assert.ok(r.tplTool.some(t => t.includes('提示词模板')), JSON.stringify(r.tplTool));
  await page.evaluate(() => [...document.querySelectorAll('#model-menu .pm-item.tool')].find(e => e.textContent.includes('RP 缓存优化')).click()); await sleep(500);
  await page.click('#rp-on'); await sleep(300);
  await closePanels();
  assert.ok(await rpConv(), 'RP 已重新开启');
  const rpBefore = (await rpConv()).plugins.rpcache.state.staticVersion;
  await sendRP('我们回到旧书店。');
  assert.strictEqual((await rpLogs()).slice(-1)[0].diag.static, 'SAME');
  await page.click('#model-pill'); await sleep(250);
  await page.evaluate(() => [...document.querySelectorAll('#model-menu .pm-item.tool')].find(e => e.textContent.includes('提示词模板')).click()); await sleep(450);
  assert.ok(await page.$eval('#tpl-sheet', e => e.classList.contains('show')));
  assert.ok((await page.$eval('#tq-cur', e => e.textContent)).length > 0);
  await tqPick('简洁回答'); await sleep(400);
  r.rpWarn = await page.$eval('#dialog-body', e => e.textContent);
  assert.ok(r.rpWarn.includes('切换提示词会改变固定前缀，下一轮缓存命中率会下降一次'), r.rpWarn);
  await shot('template-rp-warn');
  // 取消 → 不变
  await page.click('#dialog-cancel'); await sleep(300);
  assert.strictEqual((await rpConv()).plugins.rpcache.state.staticVersion, rpBefore);
  await page.click('#btn-template'); await sleep(400);
  await tqPick('简洁回答'); await sleep(400);
  await page.click('#dialog-ok'); await sleep(400);
  let rst = (await rpConv()).plugins.rpcache.state;
  assert.strictEqual(rst.staticVersion, rpBefore + 1, '新的 static 版本');
  assert.deepStrictEqual([rst.pendingStaticCause.kind, rst.pendingStaticCause.name], ['template', '简洁回答']);
  const rq14 = await sendRP('张燕看着我。');
  assert.ok(rq14.body.messages[0].content.includes(concise), 'L1 中包含新模板');
  assert.ok(rq14.body.messages[0].content.includes('[WORLD]'), 'RP 分层仍在');
  let lg = (await rpLogs()).slice(-1)[0];
  assert.strictEqual(lg.diag.static, 'CHANGED');
  assert.ok(lg.reasons.some(x => x.includes('切换了提示词模板「简洁回答」')), JSON.stringify(lg.reasons));
  rst = (await rpConv()).plugins.rpcache.state;
  assert.ok(!rst.pendingStaticCause, '发送成功后清除原因'); assert.strictEqual(rst.staticVersion, rpBefore + 1);
  await page.evaluate(() => [...document.querySelectorAll('.msg.assistant .mbadge')].pop().click()); await sleep(500);
  r.tplReason = await page.$eval('#pp-body .dg-reason', e => e.textContent);
  assert.ok(r.tplReason.includes('切换了提示词模板'), r.tplReason);
  await shot('template-rp-monitor');
  await closePanels();
  await sendRP('继续。');
  lg = (await rpLogs()).slice(-1)[0];
  assert.strictEqual(lg.diag.static, 'SAME', '下一轮恢复');

  // 15) 全屏编辑器：编辑消息（小屏 + 模拟键盘）、AI 回复编辑、RP 交互、其他长文本框
  const edInfo = () => page.evaluate(() => { const e = document.querySelector('#editor'), t = document.querySelector('#ed-text'), b = document.querySelector('#ed-bar');
    const er = e.getBoundingClientRect(), tr = t.getBoundingClientRect(), br = b.getBoundingClientRect();
    return { show: e.classList.contains('show'), vh: window.innerHeight, edTop: er.top, edH: er.height, taH: tr.height, barTop: br.top, barBottom: br.bottom, value: t.value, sel: [t.selectionStart, t.selectionEnd], focused: document.activeElement === t,
      btns: [...b.querySelectorAll('button')].map(x => x.textContent), hint: document.querySelector('#ed-hint').textContent, warn: document.querySelector('#ed-hint').classList.contains('warn'),
      count: document.querySelector('#ed-count').textContent, dirty: document.querySelector('#ed-count').classList.contains('dirty'), scrollable: t.scrollHeight > t.clientHeight, font: parseFloat(getComputedStyle(t).fontSize), kb: document.body.classList.contains('kb-open') }; });
  const edSet = v => page.evaluate(v => { const t = document.querySelector('#ed-text'); t.value = v; t.dispatchEvent(new Event('input')); }, v);
  const msgEdit = (role, fromEnd) => page.evaluate((role, k) => { const l = [...document.querySelectorAll('.msg.' + role)]; l[l.length - 1 - k].querySelector('.act[aria-label="编辑"]').click(); }, role, fromEnd || 0);
  await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(400);
  assert.ok(await rpConv(), '在 RP 对话中测试');
  const msgsBefore = (await rpConv()).messages;
  const lastUser = msgsBefore.filter(m => m.role === 'user').pop();
  await msgEdit('user'); await sleep(450);
  let ei = await edInfo();
  assert.ok(ei.show && ei.focused, '编辑器打开并聚焦');
  assert.strictEqual(ei.value, lastUser.content);
  assert.deepStrictEqual(ei.sel, [lastUser.content.length, lastUser.content.length], '光标在末尾');
  assert.deepStrictEqual(ei.btns, ['取消', '保存', '保存并重新发送']);
  assert.ok(ei.hint.includes('之后的 1 条消息保留在旧版本里') && ei.hint.includes('RP 缓存优化') && ei.warn, ei.hint);
  assert.ok(ei.taH >= 0.6 * ei.vh, '文本框至少 60% 视口高度 ' + ei.taH + '/' + ei.vh);
  assert.ok(ei.font >= 16, 'font ' + ei.font);
  assert.strictEqual(Math.round(ei.edH), 640); assert.ok(ei.barBottom <= 640);
  const longText = Array.from({ length: 40 }, (_, i) => '第 ' + (i + 1) + ' 段：我推开旧书店的门，烛光摇曳，张燕跟在我身后，手按在剑柄上。我们沿着书架一排排地找，终于在最里面的角落发现了那本账本。').join('\n');
  await edSet(longText);
  ei = await edInfo();
  assert.strictEqual(ei.count, Array.from(longText).length + ' 字'); assert.ok(ei.dirty && ei.scrollable);
  await page.evaluate(() => { const t = document.querySelector('#ed-text'); t.setSelectionRange(t.value.length, t.value.length); t.scrollTop = t.scrollHeight; });
  await shot('edit-message');
  // 模拟键盘弹出（adjustResize：WebView 高度变小）
  await page.setViewport({ width: 360, height: 330, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(500);
  ei = await edInfo();
  assert.ok(ei.show && ei.kb, 'kb-open');
  assert.strictEqual(Math.round(ei.edH), 330, '编辑器高度跟随可视区域');
  assert.ok(ei.barBottom <= 330 && ei.barTop > 200, '按钮固定在键盘上方 ' + JSON.stringify([ei.barTop, ei.barBottom]));
  assert.ok(ei.taH >= 150, '键盘弹出后仍有足够编辑空间 ' + ei.taH);
  assert.ok(ei.value === longText, '内容不丢失');
  await shot('edit-message-kb');
  await page.setViewport({ width: 360, height: 640, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(400);
  assert.ok(!(await edInfo()).kb);
  // 取消（有修改 → 确认放弃）
  await page.click('#ed-cancel'); await sleep(350);
  assert.strictEqual(await page.$eval('#dialog-title', e => e.textContent), '放弃修改？');
  await page.click('#dialog-cancel'); await sleep(300);
  assert.ok((await edInfo()).show, '选择继续编辑');
  await page.evaluate(() => window.onAndroidBack()); await sleep(350);
  await page.click('#dialog-ok'); await sleep(450);
  assert.ok(!(await edInfo()).show);
  assert.deepStrictEqual((await rpConv()).messages.map(m => m.content), msgsBefore.map(m => m.content), '取消后不变');
  // 保存（不重发）：只改这条，RP 冻结原文作废
  await msgEdit('user'); await sleep(400);
  await edSet('我注意到张燕的左手在发抖，于是轻声问她：伤还疼吗？'); await page.click('#ed-save'); await sleep(450);
  let rc = await rpConv();
  assert.strictEqual(rc.messages.length, msgsBefore.length);
  const editedU = rc.messages.filter(m => m.role === 'user').pop();
  assert.strictEqual(editedU.content, '我注意到张燕的左手在发抖，于是轻声问她：伤还疼吗？'); assert.ok(editedU.edited && editedU.rpSent == null);
  // AI 回复编辑
  await msgEdit('assistant', 1); await sleep(400);
  ei = await edInfo();
  assert.deepStrictEqual(ei.btns, ['取消', '保存']); assert.ok(ei.hint.includes('AI 回复') || ei.hint.includes('回复'), ei.hint);
  assert.ok(ei.warn, 'RP 对话中提示历史前缀变化');
  await edSet('（已编辑的回复）张燕点点头，把斗篷拉紧。'); await page.click('#ed-save'); await sleep(450);
  rc = await rpConv();
  const ai = rc.messages.filter(m => m.role === 'assistant');
  assert.strictEqual(ai[ai.length - 2].content, '（已编辑的回复）张燕点点头，把斗篷拉紧。');
  assert.ok((await page.$$eval('.msg.assistant .md', e => e.map(x => x.textContent))).some(t => t.includes('（已编辑的回复）')), '界面已更新');
  const q15 = await sendRP('我们走吧。');
  const qm = q15.body.messages;
  assert.ok(qm.some(m => m.role === 'assistant' && m.content === '（已编辑的回复）张燕点点头，把斗篷拉紧。'), '编辑后的回复进入上下文');
  assert.ok(qm.some(m => m.role === 'user' && m.content === '我注意到张燕的左手在发抖，于是轻声问她：伤还疼吗？'), '编辑后的用户消息进入上下文');
  let lg15 = (await rpLogs()).slice(-1)[0];
  assert.strictEqual(lg15.diag.history, 'CHANGED'); assert.strictEqual(lg15.diag.static, 'SAME');
  assert.ok(lg15.reasons.some(x => x.includes('历史被修改')), JSON.stringify(lg15.reasons));
  await sendRP('继续前进。');
  { const l = (await rpLogs()).slice(-1)[0]; assert.ok(l.diag.history === 'APPEND' || l.summary_happened, '下一轮恢复（或触发了摘要）'); assert.ok(!l.reasons.some(x => x.includes('历史被修改')), JSON.stringify(l.reasons)); }
  // 保存并重新发送
  const nBefore = (await rpConv()).messages.length;
  await msgEdit('user', 1); await sleep(400);
  assert.ok((await edInfo()).hint.includes('之后的 3 条消息保留在旧版本里'));
  await edSet('我们换条路，往东走。'); await page.click('#ed-resend'); await sleep(200); await waitIdle(); await sleep(300);
  rc = await rpConv();
  assert.strictEqual(rc.messages.length, nBefore - 2);
  assert.strictEqual(rc.messages[rc.messages.length - 2].content, '我们换条路，往东走。');
  assert.ok((await lastPost()).body.messages.pop().content.endsWith('[USER_INPUT]\n我们换条路，往东走。'));
  { const l = (await rpLogs()).slice(-1)[0]; assert.ok(l.summary_happened || l.reasons.some(x => x.includes('编辑并重新发送了较早的消息')), JSON.stringify(l.reasons)); }
  assert.strictEqual(rc.messages[rc.messages.length - 2].versions.length, 2, '编辑重发开出新分支');
  // RP 分层设定：全屏编辑后仍需点「保存」才生效（显式更新路径不变）
  const stBefore = JSON.stringify((await rpConv()).plugins.rpcache.state.blocks);
  await page.evaluate(() => [...document.querySelectorAll('#conv-bar .hbadge')].find(e => !e.classList.contains('tpl')).click()); await sleep(450); await tab('blocks'); await sleep(200);
  await openBlock('当前动态状态'); await sleep(300);
  await page.evaluate(() => document.querySelector('#pp-body .ta-expand').click()); await sleep(400);
  ei = await edInfo();
  assert.ok(ei.show && ei.hint.includes('点「保存」才会生效'), ei.hint);
  assert.deepStrictEqual(ei.btns, ['取消', '完成']);
  await edSet(ei.value + '\nWeather: 小雨'); await page.click('#ed-ok'); await sleep(350);
  assert.ok((await page.$eval('#rb-text', e => e.value)).endsWith('Weather: 小雨'));
  assert.ok((await page.$eval('#rb-meta', e => e.textContent)).includes('保存后为第 '));
  await page.click('#rb-cancel'); await sleep(300);
  assert.strictEqual(JSON.stringify((await rpConv()).plugins.rpcache.state.blocks), stBefore, '未保存则不改变');
  await closePanels();
  // 模板编辑页的全屏编辑
  await page.click('#btn-menu'); await sleep(350); await page.click('#btn-templates'); await sleep(500);
  await page.click('#tm-new'); await sleep(450);
  await page.evaluate(() => document.querySelector('#page-template .ta-expand').click()); await sleep(400);
  ei = await edInfo();
  assert.strictEqual(await page.$eval('#ed-title', e => e.textContent), '模板 · 系统提示词');
  await edSet('你是一名{{职业}}。\n' + '请分点作答。\n'.repeat(30)); await page.click('#ed-ok'); await sleep(350);
  assert.ok((await page.$eval('#te-content', e => e.value)).startsWith('你是一名{{职业}}'));
  assert.ok((await page.$eval('#te-vars', e => e.textContent)).includes('{{职业}}'), '写回后触发 input');
  await page.evaluate(() => window.onAndroidBack()); await sleep(350);
  await page.evaluate(() => window.onAndroidBack()); await sleep(400);
  // 输入框内容较长时出现全屏编辑
  assert.ok(!(await page.$eval('#btn-expand-input', e => e.offsetWidth)));
  await setInput('第一行\n第二行\n第三行\n第四行\n第五行\n第六行');
  assert.ok(await page.$eval('#btn-expand-input', e => e.offsetWidth) > 0);
  await page.click('#btn-expand-input'); await sleep(400);
  assert.deepStrictEqual((await edInfo()).btns, ['取消', '完成', '发送']);
  await edSet('改好的输入'); await page.click('#ed-ok'); await sleep(300);
  assert.strictEqual(await page.$eval('#input', e => e.value), '改好的输入');
  await setInput('');
  await page.setViewport({ width: 390, height: 820, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); await sleep(300);

  // 16) 回复版本 / 对话分支
  const msgAt = (i, sel) => page.evaluate((i, sel) => { const e = document.querySelectorAll('#messages > .msg')[i]; const x = e && (sel ? e.querySelector(sel) : e); return x ? x.textContent : null; }, i, sel);
  const msgCount = () => page.$$eval('#messages > .msg', e => e.length);
  const clickIn = (i, sel) => page.evaluate((i, sel) => document.querySelectorAll('#messages > .msg')[i].querySelector(sel).click(), i, sel);
  const curC = () => page.evaluate(() => { const ids = JSON.parse(window.__mem['convs.json']); return JSON.parse(window.__mem['conv_' + ids[0].id + '.json']); });
  const sendT = async t => { await setInput(t); await page.click('#btn-send'); await sleep(200); await waitIdle(); await sleep(300); };
  const regenAt = async i => { await clickIn(i, '.act[aria-label="重新生成"], .act[aria-label="从这里重新生成"]'); await sleep(300); };
  await page.click('#btn-new'); await sleep(300);
  await page.click('#model-pill'); await sleep(250); await pickModel('deepseek-flash'); await sleep(250);
  await sendT('版本测试：介绍一下你自己');
  assert.strictEqual(await msgAt(1, '.vs-label'), null, '只有一个版本时不显示切换器');
  const req0 = (await lastPost()).body;
  await regenAt(1); await waitIdle(); await sleep(300);
  assert.strictEqual(await msgCount(), 2, '重新生成不新增消息');
  assert.strictEqual(await msgAt(1, '.vs-label'), '2 / 2');
  assert.ok((await msgAt(1, '.md')).startsWith('版本回复 2'));
  assert.deepStrictEqual((await lastPost()).body.messages, req0.messages, '重新生成的请求不含旧版本');
  await shot('versions');
  await clickIn(1, '.vs-prev'); await sleep(300);
  assert.strictEqual(await msgAt(1, '.vs-label'), '1 / 2'); assert.ok((await msgAt(1, '.md')).startsWith('版本回复 1'));
  assert.ok(await page.evaluate(() => document.querySelectorAll('#messages > .msg')[1].querySelector('.vs-prev').disabled));
  let cv = await curC();
  assert.strictEqual(cv.messages[1].vi, 0); assert.strictEqual(cv.messages[1].versions.length, 2); assert.ok(cv.messages[1].versions[1].content.startsWith('版本回复 2'));
  // 继续对话：只发送选中的版本
  await sendT('版本测试：继续');
  let q = (await lastPost()).body.messages;
  assert.ok(q.some(m => m.role === 'assistant' && m.content.startsWith('版本回复 1')) && !q.some(m => m.content.startsWith('版本回复 2')), JSON.stringify(q.map(m => m.content.slice(0, 8))));
  assert.ok(!JSON.stringify(q).includes('versions'));
  // 持久化：切到别的对话再回来
  const vcId = cv.id;
  await page.click('#btn-new'); await sleep(300);
  await page.click('#btn-menu'); await sleep(350);
  await page.evaluate(() => document.querySelectorAll('.conv-item')[0].click()); await sleep(500);
  assert.strictEqual((await curC()).id, vcId);
  assert.strictEqual(await msgAt(1, '.vs-label'), '1 / 2', '重新打开后版本与选择保留');
  // 较早回复：切换版本 → 后续对话切到对应分支（版本 2 之后还没有对话）
  await clickIn(1, '.vs-next'); await sleep(400);
  assert.strictEqual(await msgCount(), 2, '版本 2 的分支只有到这里');
  await clickIn(1, '.vs-prev'); await sleep(400);
  assert.strictEqual(await msgCount(), 4, '切回版本 1，后面的 2 条对话回来了');
  assert.ok((await msgAt(3, '.md')).startsWith('版本回复 3'));
  // 从较早的回复重新生成 → 新分支 3/3
  await regenAt(1);
  assert.ok((await page.$eval('#dialog-body', e => e.textContent)).includes('之后的 2 条对话保留在旧版本里'));
  await page.click('#dialog-ok'); await sleep(200); await waitIdle(); await sleep(300);
  assert.strictEqual(await msgCount(), 2); assert.strictEqual(await msgAt(1, '.vs-label'), '3 / 3');
  await sendT('版本测试：第三分支的问题');
  assert.strictEqual(await msgCount(), 4);
  q = (await lastPost()).body.messages.map(m => m.content);
  assert.ok(q[1].startsWith('版本回复 4') && !q.some(c => c.includes('继续')), JSON.stringify(q));
  await clickIn(1, '.vs-label'); await sleep(350);
  r.verMenu = await page.$$eval('#action-list .action-item', e => e.map(x => x.textContent.trim()));
  assert.ok(r.verMenu[0].startsWith('切换到第 1 个') && r.verMenu.includes('只保留当前版本（第 3 个）') && r.verMenu.includes('删除当前版本'), JSON.stringify(r.verMenu));
  await shot('version-menu');
  await page.evaluate(() => [...document.querySelectorAll('#action-list .action-item')].find(e => e.textContent.startsWith('切换到第 1 个')).click()); await sleep(450);
  assert.strictEqual(await msgAt(1, '.vs-label'), '1 / 3'); assert.ok((await msgAt(2, '.bubble')).includes('继续'));
  // 删除版本 2（非当前）：菜单只能删当前，先切到 2 再删
  await clickIn(1, '.vs-next'); await sleep(400);
  await clickIn(1, '.vs-label'); await sleep(350);
  await page.evaluate(() => [...document.querySelectorAll('#action-list .action-item')].find(e => e.textContent === '删除当前版本').click()); await sleep(350);
  assert.ok((await page.$eval('#dialog-title', e => e.textContent)).includes('删除第 2 个版本'));
  await page.click('#dialog-ok'); await sleep(400);
  assert.strictEqual(await msgAt(1, '.vs-label'), '1 / 2'); assert.strictEqual(await msgCount(), 4);
  cv = await curC(); assert.strictEqual(cv.messages[1].versions.length, 2);
  // 编辑并重新发送用户消息 → 用户消息上的分支 ‹ 1/2 ›
  await msgEdit('user', 0); await sleep(400);
  assert.ok((await edInfo()).hint.includes('新分支'));
  await edSet('版本测试：换个问法继续'); await page.click('#ed-resend'); await sleep(200); await waitIdle(); await sleep(300);
  assert.strictEqual(await msgCount(), 4);
  assert.strictEqual(await msgAt(2, '.vs-label'), '2 / 2', '用户消息有两个版本');
  assert.ok((await msgAt(2, '.bubble')).includes('换个问法'));
  await clickIn(2, '.vs-prev'); await sleep(400);
  assert.ok((await msgAt(2, '.bubble')).includes('版本测试：继续')); assert.ok((await msgAt(3, '.md')).startsWith('版本回复 3'), '原分支的回复回来了');
  await shot('branch');
  // 只保留当前版本
  await clickIn(1, '.vs-label'); await sleep(350);
  await page.evaluate(() => [...document.querySelectorAll('#action-list .action-item')].find(e => e.textContent.startsWith('只保留当前版本')).click()); await sleep(350);
  await page.click('#dialog-ok'); await sleep(400);
  assert.strictEqual(await msgAt(1, '.vs-label'), null);
  assert.ok(!('versions' in (await curC()).messages[1]));
  // 迁移：v0.1 的旧对话，重新生成后旧回复成为第 1 个版本
  await page.click('#btn-menu'); await sleep(350);
  await page.evaluate(() => [...document.querySelectorAll('.conv-item')].find(e => e.textContent.includes('旧对话')).click()); await sleep(500);
  const oldC = () => page.evaluate(() => JSON.parse(window.__mem['conv_oldc1.json']));
  const oldReply = (await oldC()).messages[1].content;
  assert.strictEqual(await msgAt(1, '.vs-label'), null, '迁移：旧消息是单版本');
  await regenAt(1); await waitIdle(); await sleep(300);
  cv = await oldC();
  assert.strictEqual(cv.title, '旧对话'); assert.strictEqual(cv.messages.length, 2);
  assert.strictEqual(cv.messages[1].versions[0].content, oldReply); assert.strictEqual(cv.messages[1].vi, 1);
  await clickIn(1, '.vs-prev'); await sleep(300);
  assert.strictEqual((await oldC()).messages[1].content, oldReply);

  // RP：重新生成最后一条（无警告，请求逐字节一致）；切换较早回复（警告 + 监控原因）
  await page.click('#btn-menu'); await sleep(350);
  await page.evaluate(() => { const ids = JSON.parse(window.__mem['convs.json']); const i = ids.findIndex(c => { const x = JSON.parse(window.__mem['conv_' + c.id + '.json']); return x.plugins && x.plugins.rpcache && x.plugins.rpcache.enabled; }); document.querySelectorAll('.conv-item')[i].click(); });
  await sleep(500);
  assert.ok(await rpConv());
  await sendRP('版本测试：我们去码头。');
  const rpBody = (await lastPost()).body;
  let n = await msgCount();
  await regenAt(n - 1);
  assert.ok(!(await page.$eval('#dialog-mask', e => e.classList.contains('show'))), '重新生成最后一条：没有警告');
  await waitIdle(); await sleep(300);
  assert.strictEqual(JSON.stringify((await lastPost()).body), JSON.stringify(rpBody), 'RP：重新生成的请求与原请求逐字节一致');
  assert.strictEqual(await msgAt(n - 1, '.vs-label'), '2 / 2');
  r.rpBadge2 = await msgAt(n - 1, '.mbadge');
  assert.ok(r.rpBadge2 && r.rpBadge2.includes('缓存'), '每个版本有自己的缓存统计 ' + r.rpBadge2);
  await clickIn(n - 1, '.vs-prev'); await sleep(300);
  assert.ok(!(await page.$eval('#dialog-mask', e => e.classList.contains('show'))), '切换最后一条：没有警告');
  assert.ok((await msgAt(n - 1, '.mbadge')).includes('缓存'));
  let logs16 = await rpLogs();
  await sendRP('版本测试：上船。');
  logs16 = await rpLogs();
  assert.strictEqual(logs16.slice(-1)[0].diag.history, 'APPEND', '切换最后一条回复不影响历史');
  // 切换较早回复 → 警告
  await clickIn(n - 1, '.vs-next'); await sleep(350);
  r.verWarn = await page.$eval('#dialog-body', e => e.textContent);
  assert.ok(r.verWarn.includes('切换较早回复的版本会改变对话历史，下一轮缓存命中率会下降一次'), r.verWarn);
  await shot('version-rp-warn');
  await page.click('#dialog-cancel'); await sleep(300);
  assert.strictEqual(await msgAt(n - 1, '.vs-label'), '1 / 2', '取消后不变');
  await clickIn(n - 1, '.vs-next'); await sleep(350); await page.click('#dialog-ok'); await sleep(400);
  assert.strictEqual(await msgAt(n - 1, '.vs-label'), '2 / 2'); assert.strictEqual(await msgCount(), n, '版本 2 之后还没有对话');
  const sel = (await rpConv()).messages[n - 1].content;
  const rq16 = await sendRP('版本测试：换一条路。');
  const hm = rq16.body.messages.filter(m => m.role === 'assistant').map(m => m.content);
  assert.ok(hm.includes(sel), '发送选中的版本');
  logs16 = await rpLogs();
  const l16 = logs16.slice(-1)[0];
  assert.ok(l16.diag.history === 'CHANGED' || l16.summary_happened, JSON.stringify(l16.diag));
  assert.ok(!l16.summary_happened && l16.diag.history === 'CHANGED' && l16.reasons.some(x => x.includes('切换了较早回复的版本')), JSON.stringify(l16.reasons));
  // 已写入章节摘要的消息：不能重新生成 / 切换
  r.dimRegen = await page.$$eval('#messages > .msg.dim .act[aria-label="从这里重新生成"]', e => e.length);
  assert.strictEqual(r.dimRegen, 0);

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
