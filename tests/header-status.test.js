// 顶栏状态精简：只暴露命中率 + 心情；模板/记忆/RP 杂项不进 headerBadges
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const www = (...p) => fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/www', ...p), 'utf8');

test('renderConvBar 只合成命中率与心情，不再 unshift 模板徽章', () => {
  const s = www('app.js');
  assert.ok(s.includes("raw.find(b => b.plugin === 'rpcache'"));
  assert.ok(s.includes("raw.find(b => b.plugin === 'affect' && b.kind === 'mood')"));
  assert.ok(s.includes('status-strip'));
  assert.ok(!/badges\.unshift\(\{[^}]*templateName/.test(s) && !s.includes("cls: 'tpl'"));
});

test('rp / rpmemory / affect / gcache 顶栏契约', () => {
  const rp = www('rp-plugin.js');
  assert.ok(rp.includes("kind: 'hit'"));
  assert.ok(!rp.includes('🎭 RP · 不适用'));
  assert.ok(!rp.includes("text: '📚 '"));
  assert.ok(!rp.includes('即将自动摘要'));
  const rm = www('rpmemory.js');
  assert.ok(rm.includes('headerBadges() { return []; }'));
  const af = www('affect.js');
  assert.ok(af.includes("kind: 'mood'"));
  assert.ok(af.includes("s.mood + ' · ' + rel"));  // A6：档位文本化 relation
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'app/src/main/assets/www', 'liveliness.js')));
  assert.ok(!www('index.html').includes('liveliness') && www('index.html').includes('affect.js'));
  const gc = www('gcache.js');
  assert.ok(gc.includes('headerBadges(conv, host)'));
  assert.ok(gc.includes("kind: 'hit'"));
});

test('紧凑状态条 CSS 约 32px', () => {
  const c = www('app.css');
  assert.ok(/\.status-strip\s*\{[^}]*height:\s*32px/.test(c));
});
