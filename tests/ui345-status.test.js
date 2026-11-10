// UI 4.3–4.5 + 第 3 节：状态条字段、设置 Tab、快捷面板、长按/编辑、热路径打磨
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const www = (...p) => fs.readFileSync(path.join(root, 'app/src/main/assets/www', ...p), 'utf8');
const U = require(path.join(root, 'app/src/main/assets/www/ui-status.js'));

test('状态条字段：命中率 / 节省 / Affect 档位', () => {
  const segs = U.buildMsgStatus({
    cacheView: { rate: 42.5, saved: 0.012, savedEstimated: false },
    relation: '亲近',
  });
  assert.strictEqual(segs.map(s => s.key).join(','), 'hit,saved,affect');
  assert.ok(segs[0].text.includes('命中率 42.5%'));
  assert.ok(segs[1].text.startsWith('节省 '));
  assert.strictEqual(segs[2].text, 'Affect 亲近');
  const est = U.buildMsgStatus({ cacheView: { rate: 10, saved: 0.2, savedEstimated: true } });
  assert.ok(est.find(s => s.key === 'saved').text.startsWith('约省 '));
  const viaRoute = U.buildMsgStatus({ routeView: { hitRate: 0.333 } });
  assert.strictEqual(viaRoute[0].text, '命中率 33.3%');
  assert.deepStrictEqual(U.buildMsgStatus({}), []);
});

test('设置页分段 Tab + 关键参数 + 轻量诊断 + 快捷面板 DOM', () => {
  const h = www('index.html');
  const c = www('app.css');
  const j = www('app.js');
  assert.ok(h.includes('id="settings-tabs"'));
  ['providers', 'chat', 'advanced', 'data'].forEach(t => {
    assert.ok(h.includes('data-set-tab="' + t + '"'), 'tab ' + t);
    assert.ok(h.includes('data-set-pane="' + t + '"'), 'pane ' + t);
  });
  assert.ok(h.includes('id="set-showtopcost"') && h.includes('id="set-deferhl"'));
  assert.ok(h.includes('id="diag-panel"') && h.includes('id="diag-body"'));
  assert.ok(h.includes('id="rp-quick"') && h.includes('id="rpq-cache"') && h.includes('id="rpq-affect"') && h.includes('id="rpq-knowledge"') && h.includes('id="rpq-budget"'));
  assert.ok(j.includes('function showSettingsTab') && j.includes('function openRpQuickPanel') && j.includes('function applyRpQuick'));
  assert.ok(/\.settings-tabs/.test(c) && /\.msg-status/.test(c) && /\.cont-hint/.test(c));
  // 资料库入口不占主屏
  assert.ok(!h.includes('id="btn-knowledge"'));
  assert.ok(!h.includes('home-cards') && !j.includes('renderHomeCards'));
});

test('模型胶囊长按进编辑，不绑定到用量 pill', () => {
  const j = www('app.js');
  const h = www('index.html');
  assert.ok(j.includes('function bindModelPill') || j.includes('bindModelPill'));
  assert.ok(j.includes('openSheet()'));
  // 长按只挂在 model-pill
  const bind = j.slice(j.indexOf('(function bindModelPill()'), j.indexOf('})();', j.indexOf('(function bindModelPill()')) + 5);
  assert.ok(bind.includes("$('#model-pill')") || bind.includes('bindModelPill'));
  assert.ok(bind.includes('openSheet()'));
  assert.ok(!bind.includes('usage-pill'));
  assert.ok(h.includes('id="model-pill"') && h.includes('id="usage-pill"'));
});

test('助手状态条 / 续写提示 / 长按菜单 / 编辑保持滚动与局部更新', () => {
  const j = www('app.js');
  assert.ok(j.includes('function appendMsgStatus') && j.includes('UiStatus.buildMsgStatus'));
  assert.ok(j.includes('function appendContinueHint') && j.includes('回复已截断，点此继续生成'));
  assert.ok(j.includes('function openMsgQuickMenu') && j.includes('快捷操作'));
  assert.ok(j.includes('function patchMsgKeeping') && j.includes('box.scrollTop = box.scrollTop + (el.getBoundingClientRect().top - top)'));
  assert.ok(j.includes('savedScroll') && j.includes('patchMsgKeeping(m)'));
  // 不重做生成结束补齐编辑按钮（仍按原条件追加编辑）
  assert.ok(j.includes("mkAct(ICON.edit, '编辑', () => editMsg(m))"));
  assert.ok(j.includes('box._uiDelegated') && j.includes("closest('.act, .cont-hint')"));
  assert.ok(j.includes('data-hl-pending') && j.includes('function flushHighlight') && j.includes('requestIdleCallback'));
});

test('顶栏可选成本：showTopCost 关闭时胶囊只显示「用量」', () => {
  const j = www('app.js');
  assert.ok(j.includes('showTopCost: true') && j.includes('settings.showTopCost !== false'));
  assert.ok(j.includes("costEl.textContent = (showCost && u.requests) ? fmtUsdShort(u.cost) : '用量'"));
});

test('第 3 节：块级差分与虚拟滚动已有，不重做', () => {
  assert.ok(fs.existsSync(path.join(root, 'app/src/main/assets/www/render-diff.js')));
  assert.ok(fs.existsSync(path.join(root, 'app/src/main/assets/www/vscroll.js')));
  const j = www('app.js');
  assert.ok(j.includes('RenderDiff.applyBlockDiff') && j.includes('VScroll.computeRange'));
});

test('第 3 节热路径：静态层短路、BM25F 惰性索引、Affect 轻量步进', () => {
  const R = require(path.join(root, 'app/src/main/assets/www/rpcache.js'));
  R.resetLayerMemo();
  let st = R.newState();
  st = R.setBlock(st, 'world', '这是一个魔法世界。', 1).state;
  st = R.syncBase(st, '你是RP助手');
  const t1 = R.staticText(st, '你是RP助手');
  const h1 = R.staticHash(st, '你是RP助手');
  const hits0 = R.staticShortCircuitHits();
  const t2 = R.staticText(st, '你是RP助手');
  const h2 = R.staticHash(st, '你是RP助手');
  assert.strictEqual(t1, t2);
  assert.strictEqual(h1, h2);
  assert.ok(R.staticShortCircuitHits() > hits0, '二次调用应命中静态层缓存');
  const crypto = require('node:crypto');
  assert.strictEqual(h1, crypto.createHash('sha256').update(t1, 'utf8').digest('hex'));
  // 改 L2 记忆不应改变 static 文本
  st = R.setBlock(st, 'memory', '一条新记忆', 2).state;
  assert.strictEqual(R.staticText(st, '你是RP助手'), t1);

  require(path.join(root, 'app/src/main/assets/www/retrieval-core.js'));
  const K = require(path.join(root, 'app/src/main/assets/www/knowledge.js'));
  let doc = K.emptyDoc('w-ui345');
  doc = K.addEntry(doc, 'locations', { title: '王都', content: '北方的王都城墙高耸', keywords: ['王都'] });
  K.resetIndexCache();
  const a = K.search(doc, '王都');
  const idx1 = K.getIndexCache();
  const b = K.search(doc, '城墙');
  const idx2 = K.getIndexCache();
  assert.ok(a.length || b.length);
  assert.strictEqual(idx1, idx2, '同一文档重复检索应复用惰性索引');
  assert.ok(idx1 && idx1.sig);

  const Affect = require(path.join(root, 'app/src/main/assets/www/affect.js'));
  const now = Date.now();
  const full = Affect.step(null, { a: 1, m: '喜悦', why: '谢谢你' }, '谢谢你帮我', now);
  const light = Affect.stepLight(null, '普通的一句闲聊', now);
  assert.ok(light && light.stateMissing);
  assert.ok(!light.p || light.p.indexOf('missing_state') >= 0);
  assert.ok(full && full.kf, '有观测时仍走 KF');
  assert.ok(light.kf && full.kf);
});
