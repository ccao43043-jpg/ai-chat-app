const test = require('node:test');
const assert = require('node:assert');
const B = require('../app/src/main/assets/www/balance.js');
const P = require('../app/src/main/assets/www/providers.js');

test('supportInfo：仅核实过的服务商可查询', () => {
  assert.ok(B.supportInfo('deepseek').supported);
  assert.ok(B.supportInfo('siliconflow').supported);
  assert.ok(B.supportInfo('moonshot').supported);
  assert.ok(B.supportInfo('openrouter').supported);
  assert.ok(!B.supportInfo('openai').supported);
  assert.ok(!B.supportInfo('qwen').supported);
  assert.ok(!B.supportInfo('zhipu').supported);
  assert.ok(!B.supportInfo('xiaomi').supported);
  assert.ok(!B.supportInfo('anthropic').supported);
  assert.ok(B.supportInfo('deepseek').consoleUrl.includes('deepseek'));
});

test('buildBalanceRequest：DeepSeek / SiliconFlow / Moonshot / OpenRouter', () => {
  const ds = B.buildBalanceRequest({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-ds' });
  assert.deepStrictEqual(ds, {
    url: 'https://api.deepseek.com/user/balance', method: 'GET',
    headers: { Authorization: 'Bearer sk-ds', Accept: 'application/json' },
  });
  // 用户残留 /v1 时仍打到根路径
  assert.strictEqual(B.buildBalanceRequest({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k' }).url,
    'https://api.deepseek.com/user/balance');

  const sf = B.buildBalanceRequest({ presetId: 'siliconflow', baseUrl: 'https://api.siliconflow.cn/v1', apiKey: 'sk-sf' });
  assert.strictEqual(sf.url, 'https://api.siliconflow.cn/v1/user/info');

  const ms = B.buildBalanceRequest({ presetId: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', apiKey: 'sk-ms' });
  assert.strictEqual(ms.url, 'https://api.moonshot.cn/v1/users/me/balance');

  const or = B.buildBalanceRequest({ presetId: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' });
  assert.strictEqual(or.url, 'https://openrouter.ai/api/v1/key');

  assert.strictEqual(B.buildBalanceRequest({ presetId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk' }), null);
  assert.strictEqual(B.buildBalanceRequest({ presetId: 'deepseek', baseUrl: 'https://api.deepseek.com', apiKey: '' }), null);
});

test('parse DeepSeek balance', () => {
  const body = JSON.stringify({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
  });
  const r = B.parseBalanceResponse('deepseek', 200, body);
  assert.ok(r.ok);
  assert.strictEqual(r.primary.text, '¥110.00');
  assert.ok(r.details.some(d => d.label.includes('赠送')));
});

test('parse SiliconFlow / Moonshot / OpenRouter', () => {
  const sf = B.parseBalanceResponse('siliconflow', 200, JSON.stringify({
    code: 20000, status: true, data: { totalBalance: '88.88', chargeBalance: '80.00', balance: '8.88', status: 'normal' },
  }));
  assert.ok(sf.ok);
  assert.strictEqual(sf.primary.text, '¥88.88');

  const ms = B.parseBalanceResponse('moonshot', 200, JSON.stringify({
    code: 0, status: true, data: { available_balance: 49.5, voucher_balance: 46.5, cash_balance: 3 },
  }));
  assert.ok(ms.ok);
  assert.ok(ms.primary.text.includes('49.5'));

  const or = B.parseBalanceResponse('openrouter', 200, JSON.stringify({
    data: { limit: 100, limit_remaining: 74.5, usage: 25.5, usage_daily: 1.2, is_free_tier: false },
  }));
  assert.ok(or.ok);
  assert.ok(or.primary.text.includes('74.5'));
});

test('401 / 不支持 / 无 Key 错误清晰且不含 key', () => {
  const e = B.parseBalanceResponse('deepseek', 401, '{"error":{"message":"Invalid"}}');
  assert.ok(!e.ok);
  assert.ok(e.error.includes('401') || e.error.includes('无效'));
  assert.ok(!JSON.stringify(e).includes('sk-'));

  const u = B.parseBalanceResponse('openai', 200, '{}');
  assert.ok(u.unsupported);
  assert.ok(u.consoleUrl);
});

test('小米 MiMo 预设：OpenAI 兼容请求', () => {
  const pr = P.PRESETS.find(p => p.presetId === 'xiaomi');
  assert.ok(pr);
  assert.strictEqual(pr.baseUrl, 'https://api.xiaomimimo.com/v1');
  assert.ok(pr.models.includes('mimo-v2.6-flash') && pr.models.includes('mimo-v2.6-pro'));
  const r = P.buildChatRequest(Object.assign({ apiKey: 'sk-mimo' }, pr), 'mimo-v2.6-flash',
    [{ role: 'user', content: 'hi' }], '', { stream: true });
  assert.strictEqual(r.url, 'https://api.xiaomimimo.com/v1/chat/completions');
  assert.strictEqual(r.headers.Authorization, 'Bearer sk-mimo');
  const b = JSON.parse(r.body);
  assert.strictEqual(b.model, 'mimo-v2.6-flash');
  assert.strictEqual(b.stream, true);
});
