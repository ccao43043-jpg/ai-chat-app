// v0.28.6：v0.28.3 临时诊断浮动按钮（「诊」/ diag.js）已移除；设置里的「本轮请求数据」面板保留。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const WWW = path.join(__dirname, '../app/src/main/assets/www');
const R = p => fs.readFileSync(p, 'utf8');

test('index.html 不再包含 v0.28.3 临时诊断浮动按钮与 diag.js', () => {
  const html = R(path.join(WWW, 'index.html'));
  assert.ok(!/id="diag-root"/.test(html), '不应有 #diag-root');
  assert.ok(!/id="diag-toggle"/.test(html), '不应有 #diag-toggle');
  assert.ok(!/id="diag-box"/.test(html), '不应有 #diag-box');
  assert.ok(!/id="diag-log"|id="diag-copy"|id="diag-meta"/.test(html), '不应有诊断日志 / 复制按钮');
  assert.ok(!/#diag-root|#diag-box|#diag-log/.test(html), '不应残留诊断浮层 CSS');
  assert.ok(!/<script\s+src="diag\.js">/.test(html), '不应引入 diag.js');
  assert.ok(!fs.existsSync(path.join(WWW, 'diag.js')), 'diag.js 文件应已删除');
  const firstScript = html.match(/<script\s+src="([^"]+)">/);
  assert.ok(firstScript, '应有脚本');
  assert.equal(firstScript[1], 'lib/marked.umd.js', '第一个脚本应为 marked');
});

test('设置中的「本轮请求数据」面板保留（唯一 #diag-panel + #diag-body）', () => {
  const html = R(path.join(WWW, 'index.html'));
  const panels = html.match(/id="diag-panel"/g) || [];
  assert.equal(panels.length, 1, '应恰好一个 #diag-panel');
  assert.match(html, /<div class="group" id="diag-panel"><div id="diag-body" class="diag-body">暂无本轮请求数据。/);
  assert.match(R(path.join(WWW, 'app.css')), /\.diag-body\s*\{/);
  assert.match(R(path.join(WWW, 'app.js')), /diag-body/);
});
