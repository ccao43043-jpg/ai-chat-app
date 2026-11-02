// v0.8.3：首回合自动角色卡端到端（模拟原生桥，不访问网络）。运行：node tests/autochar-e2e.js
// 场景：A 询问→生成（模型第一次输出带序号/加粗的变体标题）→写入系统提示词→继续回复；B 生成中点停止→跳过并继续回复；C 失败兜底
const puppeteer = require('puppeteer-core'); const path = require('path'); const assert = require('assert');
const PAGE = 'file://' + path.join(__dirname, '../app/src/main/assets/www/index.html');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SET = { providers: [{ id: 'deepseek', presetId: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', models: ['deepseek-chat'], imageModel: '' }],
  systemPrompt: '', stream: true, lastProviderId: 'deepseek', lastModel: 'deepseek-chat' };
const CARD = '1. 世界观\n- 雨夜的古堡\n2. **角色卡**\n- **姓名**：艾琳\n- 性格：冷淡、骄傲\n3. RP规则\n- 不替用户行动\n4. 开场白\n*烛火摇曳*「你终于来了。」';
async function run(browser, mode) {
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  const conv = { id: 'c1', title: '新对话', providerId: 'deepseek', model: 'deepseek-chat', templateId: 't-rp-immersive',
    systemPrompt: '请以 {{角色名}} 的身份，与 {{用户名}} 进行角色扮演。\n\n【规则】\n- 不跳出角色\n- {{规则}}', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  await page.evaluateOnNewDocument((seed, mode, CARD) => {
    const mem = Object.assign({}, seed); window.__mem = mem; window.__reqs = [];
    window.AndroidBridge = { storeGet: k => (k in mem ? mem[k] : null), storeSet: (k, v) => { mem[k] = v; return true; }, storeDelete: k => { delete mem[k]; },
      copy() {}, toast() {}, saveImage() {}, cancel: id => { window.__cancelled = (window.__cancelled || 0) + 1; }, openUrl() {}, readAsset: () => '',
      request: (id, method, url, headers, body) => {
        const H = window.__nativeHttp; const B = JSON.parse(body || '{}'); window.__reqs.push(B);
        if (method === 'GET') { setTimeout(() => { H.onStart(id, 200); H.onChunk(id, '{"data":[]}'); H.onEnd(id); }, 20); return; }
        if (!B.stream) { // 角色卡生成（非流式）
          if (mode === 'cancel') return; // 一直不返回，等用户点停止
          if (mode === 'fail') { setTimeout(() => { H.onStart(id, 500); H.onChunk(id, '{"error":{"message":"overloaded"}}'); H.onEnd(id); }, 50); return; }
          setTimeout(() => { H.onStart(id, 200); H.onChunk(id, JSON.stringify({ choices: [{ message: { content: CARD } }] })); H.onEnd(id); }, 300); return;
        }
        setTimeout(() => { H.onStart(id, 200); H.onChunk(id, 'data: ' + JSON.stringify({ choices: [{ delta: { content: '「欢迎。」' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); H.onEnd(id); }, 50);
      } };
  }, { 'settings.json': JSON.stringify(SET), 'convs.json': JSON.stringify([{ id: 'c1', title: '新对话', updatedAt: conv.updatedAt }]), 'conv_c1.json': JSON.stringify(conv) }, mode, CARD);
  await page.goto(PAGE); await sleep(800);
  await page.evaluate(() => { const i = document.querySelector('.conv-item'); if (i) i.click(); }); await sleep(300);
  await page.type('#input', '我想和吸血鬼伯爵在雨夜古堡相遇'); await page.click('#btn-send'); await sleep(300);
  const dlg = await page.evaluate(() => document.querySelector('#dialog-mask').classList.contains('show') && document.querySelector('#dialog-title').textContent);
  assert.equal(dlg, '生成角色卡？', mode + ': 应弹出询问');
  await page.click('#dialog-ok'); await sleep(200);
  if (mode === 'cancel') {
    assert.ok(await page.evaluate(() => document.querySelector('#btn-send').classList.contains('stop')), '生成中显示停止键');
    await page.click('#btn-send'); await sleep(200);
  }
  await sleep(900);
  const c = await page.evaluate(() => JSON.parse(window.__mem['conv_c1.json']));
  const toast = await page.evaluate(() => document.querySelector('#toast').textContent);
  const r = { mode, status: c.autoChar && c.autoChar.status, name: c.autoChar && c.autoChar.name, replies: c.messages.filter(m => m.role === 'assistant').length, toast, errors };
  if (mode === 'ok') { r.sp = c.systemPrompt; assert.equal(r.status, 'done'); assert.equal(r.name, '艾琳'); assert.ok(r.sp.includes('请以 艾琳 的身份') && !/\{\{/.test(r.sp) && (c.autoChar.target === 'system' ? r.sp.includes('【角色卡】') : (c.plugins.rpcache.state.blocks.find(b => b.id === 'character') || {}).content.includes('艾琳')), r.sp); r.target = c.autoChar.target; }
  if (mode === 'cancel') assert.equal(r.status, 'cancelled');
  if (mode === 'fail') assert.equal(r.status, 'error');
  assert.equal(r.replies, 1, mode + ': 之后应继续正常回复');
  assert.ok(!(await page.evaluate(() => document.querySelector('#btn-send').classList.contains('stop'))), '结束后恢复发送键');
  assert.deepEqual(errors, []);
  await page.close(); return r;
}
(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  try { for (const m of ['ok', 'cancel', 'fail']) console.log(JSON.stringify(await run(browser, m))); console.log('AUTOCHAR E2E OK'); }
  catch (e) { console.error('AUTOCHAR E2E FAILED:', e); process.exitCode = 1; } finally { await browser.close(); }
})();
