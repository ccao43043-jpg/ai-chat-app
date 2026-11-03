// v0.9.0：CSP / 密钥不进页面 / 损坏配置恢复 / JSONL / 流式 Markdown 切分
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../app/src/main/assets/www/secure.js');
const WWW = path.join(__dirname, '..', 'app/src/main/assets/www');

test('URL 白名单：只允许与 Base URL 同源', () => {
  assert.ok(S.isUrlAllowed('https://api.deepseek.com/user/balance', 'https://api.deepseek.com/v1'));
  assert.ok(S.isUrlAllowed('https://API.openai.com:443/v1/chat', 'https://api.openai.com/v1'));
  assert.ok(!S.isUrlAllowed('https://evil.com/v1/chat', 'https://api.openai.com/v1'));
  assert.ok(!S.isUrlAllowed('https://api.openai.com.evil.com/v1', 'https://api.openai.com/v1'));
  assert.ok(!S.isUrlAllowed('https://api.openai.com@evil.com/v1', 'https://api.openai.com/v1'));
  assert.ok(!S.isUrlAllowed('http://api.openai.com/v1', 'https://api.openai.com/v1'), '协议不同');
  assert.ok(!S.isUrlAllowed('https://api.openai.com:8443/v1', 'https://api.openai.com/v1'), '端口不同');
  assert.ok(!S.isUrlAllowed('file:///etc/passwd', 'https://api.openai.com'));
  assert.ok(!S.isUrlAllowed('', ''));
  assert.strictEqual(S.originOf('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
});

test('认证方式与认证头剥离', () => {
  assert.strictEqual(S.authTypeFor('provider_key', 'anthropic'), 'anthropic');
  assert.strictEqual(S.authTypeFor('provider_key', 'gemini'), 'gemini');
  assert.strictEqual(S.authTypeFor('provider_key', 'openai'), 'bearer');
  assert.strictEqual(S.authTypeFor('search_key', 'brave'), 'brave');
  const h = S.stripAuthHeaders({ Authorization: 'Bearer x', 'X-Api-Key': 'a', 'x-goog-api-key': 'g', 'X-Subscription-Token': 't', 'Content-Type': 'application/json' });
  assert.deepStrictEqual(h, { 'Content-Type': 'application/json' });
});

test('设置迁移：剥离明文密钥', () => {
  const st = { providers: [{ id: 'a', apiKey: ' sk-1 ' }, { id: 'b', apiKey: '' }, { id: 'c' }],
    search: { provider: 'tavily', keys: { tavily: 'tv', brave: '' }, urls: {} } };
  const r = S.stripSecrets(st);
  assert.ok(r.changed);
  assert.deepStrictEqual(r.secrets, [{ kind: 'provider_key', id: 'a', value: 'sk-1' }, { kind: 'search_key', id: 'tavily', value: 'tv' }]);
  assert.ok(!JSON.stringify(st).includes('sk-1') && !JSON.stringify(st).includes('"tv"'));
  assert.strictEqual(st.providers[0].hasKey, true);
  assert.ok(!('apiKey' in st.providers[1]));
  assert.deepStrictEqual(st.search.hasKeys, { tavily: true });
  assert.ok(!S.stripSecrets(st).changed, '第二次无变化');
});

test('索引重建 / 损坏文件名 / JSONL', () => {
  const idx = S.rebuildIndex([{ id: 'x', title: 'A', updatedAt: 1 }, null, { id: 'y', updatedAt: 5, personaName: 'P' }, { nope: 1 }]);
  assert.deepStrictEqual(idx.map(m => m.id), ['y', 'x']);
  assert.strictEqual(idx[0].title, '未命名对话');
  assert.strictEqual(S.corruptName('settings.json', 123), 'settings.json.corrupt-123');
  const p = S.parseJsonl('{"a":1}\n{bad\n\n{"a":2}\n');
  assert.deepStrictEqual(p.items, [{ a: 1 }, { a: 2 }]); assert.strictEqual(p.bad, 1);
  assert.strictEqual(S.toJsonl([{ a: 1 }]), '{"a":1}\n'); assert.strictEqual(S.toJsonl([]), '');
});

test('流式 Markdown 切分：代码块内 / 列表 / 末行不切', () => {
  const t1 = '第一段\n\n第二段\n\n正在写';
  const r1 = S.splitStableMarkdown(t1);
  assert.strictEqual(r1.head + r1.tail, t1);
  assert.strictEqual(r1.head, '第一段\n\n', '下一行还是最后一行（可能没写完）时不切');
  const t2 = '```js\na\n\nb\n\nc';
  assert.strictEqual(S.splitStableMarkdown(t2).head, '', '未闭合代码块内不切');
  const t3 = '```\na\n\n```\n\n段落\n\n尾\n写';
  assert.strictEqual(S.splitStableMarkdown(t3).head, '```\na\n\n```\n\n段落\n\n');
  const t4 = '- a\n\n- b\n\n尾';
  assert.ok(!S.splitStableMarkdown(t4).head.endsWith('- a\n\n'), '列表项之间不切');
  assert.strictEqual(S.splitStableMarkdown('只有一行').head, '');
  // 切分后分别解析 == 整体解析（常见文本）
  const { marked } = require('../app/src/main/assets/www/lib/marked.umd.js');
  const t5 = '# 标题\n\n一段 **粗体**\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n1. x\n2. y\n\n最后';
  const sp = S.splitStableMarkdown(t5);
  assert.ok(sp.head.length > 0);
  assert.strictEqual(marked.parse(sp.head) + marked.parse(sp.tail), marked.parse(t5));
});

function loadStore(files) {
  const src = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8');
  const a = src.indexOf('  const storeIssues = [];'), b = src.indexOf('  // ---------------- 密钥');
  assert.ok(a > 0 && b > a);
  const bridge = {
    storeGet: n => (n in files ? files[n] : null),
    storeSet: (n, v) => { if (n in files && !/\.(jsonl|bak)$/.test(n)) files[n + '.bak'] = files[n]; files[n] = v; return true; },
    storeDelete: n => { delete files[n]; },
    storeExists: n => n in files,
    storeRename: (x, y) => { if (!(x in files)) return false; files[y] = files[x]; delete files[x]; return true; },
    storeList: () => JSON.stringify(Object.keys(files)),
    storeAppend: (n, t) => { files[n] = (files[n] || '') + t; return true; },
  };
  return new Function('bridge', 'Secure', 'localStorage', src.slice(a, b) + '\nreturn { Store, storeIssues };')(bridge, S, null);
}

test('Store：损坏 JSON 改名保留并从 .bak 恢复，不静默覆盖', () => {
  const files = { 'settings.json': '{"a":1', 'settings.json.bak': '{"a":0}', 'x.json': '{oops' };
  const { Store, storeIssues } = loadStore(files);
  assert.deepStrictEqual(Store.get('settings.json', null), { a: 0 });
  assert.strictEqual(files['settings.json'], '{"a":0}');
  assert.ok(Object.keys(files).some(n => /^settings\.json\.corrupt-\d+$/.test(n) && files[n] === '{"a":1'));
  assert.strictEqual(Store.get('x.json', 'D'), 'D');
  assert.ok(!('x.json' in files), '没有 .bak 时不写默认值覆盖');
  assert.ok(Object.keys(files).some(n => n.startsWith('x.json.corrupt-')));
  assert.strictEqual(storeIssues.length, 2);
  Store.append('l.jsonl', { a: 1 }); Store.append('l.jsonl', { a: 2 });
  assert.deepStrictEqual(Store.readJsonl('l.jsonl'), [{ a: 1 }, { a: 2 }]);
  assert.strictEqual(Store.readJsonl('none.jsonl'), null);
});

test('页面不再持有明文 Key；CSP 已启用', () => {
  const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(csp, 'CSP meta');
  assert.match(csp[1], /script-src 'self'(;|$)/); assert.match(csp[1], /connect-src 'self'(;|$)/); assert.match(csp[1], /object-src 'none'/);
  assert.ok(html.indexOf('secure.js') < html.indexOf('app.js'));
  assert.ok(!/<script>/.test(html) && !/\son[a-z]+="/.test(html), '无内联脚本 / 内联事件');
  const app = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8');
  assert.ok(!/\.apiKey\s*=(?!=)/.test(app.replace(/apiKey: useStored/, '')), 'app.js 不再给 apiKey 赋值');
  assert.ok(!/ss\.keys\[/.test(app), '搜索 Key 不再写入设置');
});
