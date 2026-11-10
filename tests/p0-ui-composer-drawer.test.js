// UI 4.1 / 4.2：Composer「+」菜单、模板 chip、顶栏用量、侧栏最近使用与折叠
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const www = (...p) => fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/www', ...p), 'utf8');

test('Composer：低频工具收进「+」菜单，主行保留常用项与模板 chip', () => {
  const h = www('index.html');
  const c = www('app.css');
  const j = www('app.js');
  assert.ok(h.includes('id="btn-composer-more"'), '有 + 按钮');
  assert.ok(h.includes('id="composer-more-menu"'));
  assert.ok(h.includes('id="btn-attach"') && h.includes('id="btn-template"') && h.includes('id="btn-search"'));
  assert.ok(h.includes('tool-overflow') && h.includes('id="btn-prompts"') && h.includes('id="btn-imagegen"'));
  assert.ok(h.includes('id="tpl-recent-row"'), '模板最近使用条');
  assert.ok(h.includes('class="tpl-caret"'), '模板 chip 有下拉提示');
  assert.ok(/\.composer-tools\s+\.tool-overflow\s*\{[^}]*display:\s*none/.test(c));
  assert.ok(j.includes('openComposerMore') && j.includes('renderTplRecentRow'));
  // 不回退主界面卡片化（已回退过的那套不应回来）
  assert.ok(!h.includes('home-cards') && !j.includes('renderHomeCards'));
});

test('模板 chip：展示更长名称 + title + 最近一条一键套用', () => {
  const j = www('app.js');
  assert.ok(j.includes('name.length > 8'));
  assert.ok(j.includes("b.title = name ? ('当前模板：'"));
  assert.ok(j.includes("className = 'tpl-mini'"));
  assert.ok(j.includes('applyTemplate(t)'));
});

test('侧栏：用量/余额前置到模型胶囊旁；世界/助手/模板最近使用且可折叠', () => {
  const h = www('index.html');
  const j = www('app.js');
  assert.ok(h.includes('id="usage-pill"') && h.includes('id="usage-menu"'));
  assert.ok(h.includes('id="drawer-recent"') && h.includes('id="drawer-sec-recent-btn"'));
  assert.ok(h.includes('id="drawer-sec-more-btn"') && h.includes('id="drawer-more"'));
  // 用量/余额仍保留入口（顶栏 + 侧栏账户行），但已移出「更多」网格
  const more = h.split('id="drawer-more"')[1].split('id="btn-usage"')[0];
  assert.ok(more.includes('id="btn-personas"') && more.includes('id="btn-worlds"') && more.includes('id="btn-templates"'));
  assert.ok(!more.includes('id="btn-usage"') && !more.includes('id="btn-balance"'));
  assert.ok(h.includes('id="btn-usage"') && h.includes('id="btn-balance"'));
  assert.ok(j.includes('recentWorlds') && j.includes('recentPersonas') && j.includes('renderDrawerChrome'));
  assert.ok(j.includes("toggleDrawerSec('recent')") && j.includes("toggleDrawerSec('more')"));
  assert.ok(j.includes("pushRecentSetting('recentWorlds'") && j.includes("pushRecentSetting('recentPersonas'"));
});

test('资料库入口不占主屏（4.3+ 设置 Tab / 快捷面板已在后续版本落地）', () => {
  const h = www('index.html');
  const j = www('app.js');
  // 资料库仍从世界页 / 插件进入，不作为 composer 主按钮
  assert.ok(!h.includes('id="btn-knowledge"'));
  assert.ok(!h.includes('home-cards') && !j.includes('renderHomeCards'));
});
