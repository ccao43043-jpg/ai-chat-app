// v0.21.4 回归：重新打开同一对话（条数不变）后，用户消息「编辑 → 保存」必须生效（世界对话报告）。原脚手架取自 ui-e2e.js
// 界面端到端测试：用本机 Chrome 加载页面，模拟原生桥（不访问网络），并截取浅色/深色截图到 docs/
// 运行：npm i && npm run test:ui
const puppeteer = require('puppeteer-core');
const path = require('path');
const assert = require('assert');
const DOCS = process.env.SHOTS_DIR || path.join(__dirname, '../docs'); // SHOTS_DIR：截图输出到别处（不覆盖 docs/）
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
  messages: [{ id: 'u1', role: 'user', content: '你好' }, { id: 'a1', role: 'assistant', content: '你好！有什么可以帮你？', model: 'deepseek-reasoner', createdAt: Date.now() - 864e5 * 2, usage: { prompt: 12, completion: 8, hit: 0, miss: 12, cacheSupported: true } }],
  createdAt: Date.now() - 864e5 * 2, updatedAt: Date.now() - 864e5 * 2 };

async function scenario(browser, theme) { const seed0 = global.seed;
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
      // v0.9.0：模拟原生安全存储 + 按服务商注入认证（与 NativeBridge.java 同规则）
      ...(() => {
        const sec = window.__secrets = {}, reg = window.__reg = {}, bound = {};
        const origin = u => { try { const x = new URL(u); if (x.username || !/^https?:$/.test(x.protocol)) return ''; return x.protocol + '//' + x.host.toLowerCase(); } catch (e) { return ''; } };
        const nameOf = rid => rid.startsWith('search:') ? 'search_key:' + rid.slice(7) : 'provider_key:' + rid;
        return {
          storeExists: k => k in mem, storeList: () => JSON.stringify(Object.keys(mem)),
          storeRename: (a, b) => { if (!(a in mem)) return false; mem[b] = mem[a]; delete mem[a]; return true; },
          storeAppend: (k, t) => { mem[k] = (mem[k] || '') + t; return true; },
          registerProvider: (id, base, type) => { reg[id] = { base, type }; const n = nameOf(id); if (sec[n] && bound[n] && bound[n] !== origin(base)) { delete sec[n]; return 'cleared'; } return 'ok'; },
          setSecret: (kind, id, v) => { const rid = kind === 'search_key' ? 'search:' + id : id; const n = kind + ':' + id; if (!v) { delete sec[n]; return true; } sec[n] = v; if (reg[rid]) bound[n] = origin(reg[rid].base); return true; },
          hasSecret: (kind, id) => !!sec[kind + ':' + id], deleteSecret: (kind, id) => { delete sec[kind + ':' + id]; },
          clearSecrets: () => { Object.keys(sec).forEach(k => delete sec[k]); },
          requestForProvider: (id, pid, method, url, headers, body, t) => {
            const r = reg[pid]; const H = window.__nativeHttp;
            if (!r || !origin(url) || origin(url) !== origin(r.base)) { window.__rejected = (window.__rejected || []).concat([url]); setTimeout(() => H.onError(id, '请求地址与服务商 Base URL 不一致，已拒绝'), 0); return; }
            const h = JSON.parse(headers); if (Object.keys(h).some(k => /^(authorization|x-api-key|x-goog-api-key|x-subscription-token)$/i.test(k))) window.__leakedAuth = true;
            const key = sec[nameOf(pid)];
            if (key) { if (r.type === 'anthropic') h['x-api-key'] = key; else if (r.type === 'gemini') h['x-goog-api-key'] = key; else if (r.type === 'brave') h['X-Subscription-Token'] = key; else h.Authorization = 'Bearer ' + key; }
            window.AndroidBridge.request(id, method, url, JSON.stringify(h), body, t);
          },
        };
      })(),
      request: (id, method, url, headers, body) => {
        window.__reqs.push({ method, url, headers: JSON.parse(headers), body: body ? JSON.parse(body) : null, raw: body || '' });
        const H = window.__nativeHttp;
        if (method === 'GET' && /\/models/.test(url)) {
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }, { id: 'deepseek-v4-flash' }] })); H.onEnd(id); }, 60);
          return;
        }
        // 余额查询
        if (method === 'GET' && /\/user\/balance/.test(url)) {
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '66.60', granted_balance: '6.60', topped_up_balance: '60.00' }] })); H.onEnd(id); }, 80);
          return;
        }
        if (method === 'GET' && /\/user\/info/.test(url)) {
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ code: 20000, status: true, data: { totalBalance: '12.34', chargeBalance: '10.00', balance: '2.34', status: 'normal' } })); H.onEnd(id); }, 80);
          return;
        }
        if (method === 'GET' && /\/users\/me\/balance/.test(url)) {
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ code: 0, status: true, data: { available_balance: 20.5, voucher_balance: 10, cash_balance: 10.5 } })); H.onEnd(id); }, 80);
          return;
        }
        if (method === 'GET' && /openrouter\.ai\/api\/v1\/key$/.test(url)) {
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ data: { limit: 50, limit_remaining: 33.3, usage: 16.7, usage_daily: 1.1 } })); H.onEnd(id); }, 80);
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
        // 千问：usage 在单独的最后一块（choices 为空），缓存字段在 prompt_tokens_details
        if (url.includes('dashscope') && B.stream_options && B.stream_options.include_usage) {
          const marked = (body || '').includes('cache_control');
          sse.push('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: ptok, completion_tokens: usage.completion_tokens, prompt_tokens_details: Object.assign({ cached_tokens: hit }, marked ? { cache_creation_input_tokens: Math.max(0, ptok - hit) } : {}) } }) + '\n\n');
        }
        sse.push('data: [DONE]\n\n');
        setTimeout(() => H.onStart(id, 200), 20);
        sse.forEach((c, i) => setTimeout(() => H.onChunk(id, c), 30 + i * 12));
        setTimeout(() => H.onEnd(id), 60 + sse.length * 12);
      },
    };
  }, seed0);
  await page.goto(PAGE); await sleep(800);
  return { page, errors };
}
// v0.21.6：「没有编辑按钮」——生成期间建的用户气泡没有编辑按钮，结束后不重建。覆盖：发送 → 等回复 → 编辑按钮存在 → 保存 → 离开再回来仍是新内容；世界对话与普通对话同路径
const userEditBtn = (page, idx) => page.evaluate(i => { const us = [...document.querySelectorAll('.msg.user')]; const u = i == null ? us[us.length - 1] : us[i]; return !!(u && [...u.querySelectorAll('.actions button')].find(b => b.title === '编辑')); }, idx);
const TITLES = { wc1: '🌍 测试', nc1: '普通' };
const openConvItem = (page, id) => page.evaluate(t => { [...document.querySelectorAll('.conv-item')].find(e => e.querySelector('.ci-title').textContent === t).click(); }, TITLES[id]);
async function sendAndWait(page, text) {
  await page.evaluate(t => { const i = document.querySelector('#input'); i.value = t; i.dispatchEvent(new Event('input')); document.querySelector('#btn-send').click(); }, text);
  for (let k = 0; k < 100; k++) { await sleep(100); if (await page.evaluate(() => !document.querySelector('#btn-send').classList.contains('stop') && !document.querySelector('.msg .typing'))) break; }
  await sleep(300);
}
async function editLastUser(page, text) {
  await page.evaluate(() => { const us = [...document.querySelectorAll('.msg.user')]; [...us[us.length - 1].querySelectorAll('.actions button')].find(b => b.title === '编辑').click(); });
  await sleep(200);
  await page.evaluate(t => { document.querySelector('#ed-text').value = t; document.querySelector('#ed-save').click(); }, text);
  await sleep(300);
}
const lastUserText = page => page.evaluate(() => { const us = [...document.querySelectorAll('.msg.user .bubble')]; return us[us.length - 1].textContent; });
const storedUsers = (page, id) => page.evaluate(id => JSON.parse(window.__mem['conv_' + id + '.json']).messages.filter(m => m.role === 'user').map(m => m.content), id);

(async () => {
  const W = { id: 'wc1', title: '🌍 测试', providerId: 'deepseek', model: 'deepseek-chat', systemPrompt: '', worldId: 'w1', worldName: '测试', worldEmoji: '🌍',
    // 长 RP 对话（> 40 条走虚拟滚动窗口路径，用户现场即长对话）
    messages: [{ id: 'g1', role: 'assistant', content: '开场白', createdAt: 1 }].concat(...Array.from({ length: 30 }, (_, i) => [{ id: 'u' + i, role: 'user', content: i ? '第' + i + '句' : '我的原话', createdAt: 2 + i * 2 }, { id: 'a' + i, role: 'assistant', content: '回复' + i, createdAt: 3 + i * 2 }])),
    plugins: { rpcache: { enabled: true } }, createdAt: 1, updatedAt: 5 };
  const N = { id: 'nc1', title: '普通', providerId: 'deepseek', model: 'deepseek-chat', systemPrompt: '', messages: [{ id: 'nu1', role: 'user', content: '普通原话', createdAt: 1 }, { id: 'na1', role: 'assistant', content: '普通回复', createdAt: 2 }], createdAt: 1, updatedAt: 4 };
  global.seed = { 'settings.json': JSON.stringify(OLD_SETTINGS), 'convs.json': JSON.stringify([{ id: 'wc1', title: '🌍 测试', updatedAt: 5 }, { id: 'nc1', title: '普通', updatedAt: 4 }]), 'conv_wc1.json': JSON.stringify(W), 'conv_nc1.json': JSON.stringify(N) };
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const { page, errors } = await scenario(browser, 'dark');
  for (const id of ['wc1', 'nc1']) {
    await openConvItem(page, id); await sleep(400);
    // 1. 已有消息：直接编辑（不离开）
    assert.ok(await userEditBtn(page), id + ' 已有用户消息应有编辑按钮');
    // 2. 新发一条，回复结束后必须出现编辑按钮（v0.21.4 回归点）
    await sendAndWait(page, id + ' 新发的话');
    assert.ok(await userEditBtn(page), id + ' 刚发出的用户消息应有编辑按钮');
    await editLastUser(page, id + ' 改过');
    assert.strictEqual(await lastUserText(page), id + ' 改过');
    // 3. 离开再回来，仍是新内容且可再编辑
    await openConvItem(page, id === 'wc1' ? 'nc1' : 'wc1'); await sleep(300);
    await openConvItem(page, id); await sleep(400);
    assert.strictEqual(await lastUserText(page), id + ' 改过');
    assert.ok(await userEditBtn(page), id + ' 重开后应有编辑按钮');
    await editLastUser(page, id + ' 再改');
    await openConvItem(page, id === 'wc1' ? 'nc1' : 'wc1'); await sleep(300);
    await openConvItem(page, id); await sleep(400);
    assert.strictEqual(await lastUserText(page), id + ' 再改');
    assert.strictEqual((await storedUsers(page, id)).pop(), id + ' 再改');
  }
  assert.deepStrictEqual(errors, []);
  await browser.close(); console.log('edit-msg e2e OK');
})().catch(e => { console.error(e); process.exit(1); });
