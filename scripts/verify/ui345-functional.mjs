#!/usr/bin/env node
/** UI 4.3 / 4.4 / 4.5 + 第 3 节打磨功能验证 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WWW = path.join(ROOT, 'app/src/main/assets/www');
const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(WWW, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(WWW, 'app.css'), 'utf8');
const U = require(path.join(WWW, 'ui-status.js'));
const R = require(path.join(WWW, 'rpcache.js'));
require(path.join(WWW, 'retrieval-core.js'));
const K = require(path.join(WWW, 'knowledge.js'));
const Affect = require(path.join(WWW, 'affect.js'));

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

// 4.3 设置 Tab
ok('UI.settings_tabs', ['providers', 'chat', 'advanced', 'data'].every(t =>
  html.includes('data-set-tab="' + t + '"') && html.includes('data-set-pane="' + t + '"')) && app.includes('function showSettingsTab'));
ok('UI.quick_panel', html.includes('id="rp-quick"') && html.includes('id="rpq-cache"') && html.includes('id="rpq-affect"') && html.includes('id="rpq-knowledge"') && html.includes('id="rpq-budget"') && app.includes('function openRpQuickPanel'));
ok('UI.model_pill_longpress', app.includes('(function bindModelPill()') && app.includes('openSheet()') && !/\(function bindModelPill\(\)[\s\S]{0,1200}usage-pill/.test(app));
ok('UI.params_and_diag', html.includes('id="set-showtopcost"') && html.includes('id="set-deferhl"') && html.includes('id="diag-panel"') && app.includes('function renderDiag') && app.includes('function noteLastDiag'));

// 4.4
const segs = U.buildMsgStatus({ cacheView: { rate: 50, saved: 0.01 }, relation: '熟悉' });
ok('UI.status_fields', segs.map(s => s.key).join(',') === 'hit,saved,affect' && segs[0].text.includes('命中率 50%'));
ok('UI.cont_hint', app.includes('回复已截断，点此继续生成') && /cont-hint/.test(css));
ok('UI.top_cost_optional', app.includes('showTopCost: true') && app.includes('settings.showTopCost !== false'));

// 4.5
ok('UI.longpress_menu', app.includes('function openMsgQuickMenu') && app.includes('pointerdown'));
ok('UI.edit_keep_scroll', app.includes('function patchMsgKeeping') && app.includes('savedScroll') && app.includes('patchMsgKeeping(m)'));
ok('UI.edit_btn_kept', app.includes("mkAct(ICON.edit, '编辑', () => editMsg(m))"));
ok('UI.event_delegate', app.includes('box._uiDelegated') && app.includes("closest('.act, .cont-hint')"));

// 第 3 节：已有不重做
ok('SEC3.diff_vscroll_kept', app.includes('RenderDiff.applyBlockDiff') && app.includes('VScroll.computeRange') && fs.existsSync(path.join(WWW, 'render-diff.js')) && fs.existsSync(path.join(WWW, 'vscroll.js')));
ok('SEC3.highlight_delay', app.includes('data-hl-pending') && app.includes('function flushHighlight') && app.includes('deferHighlight'));

// 静态层短路
R.resetLayerMemo();
let st = R.setBlock(R.syncBase(R.newState(), '你是RP助手'), 'world', '魔法世界', 1).state;
const t1 = R.staticText(st, '你是RP助手');
const h1 = R.staticHash(st, '你是RP助手');
const hits0 = R.staticShortCircuitHits();
ok('SEC3.static_reuse', R.staticText(st, '你是RP助手') === t1 && R.staticHash(st, '你是RP助手') === h1 && R.staticShortCircuitHits() > hits0);
ok('SEC3.static_hash', h1 === crypto.createHash('sha256').update(t1, 'utf8').digest('hex'));
st = R.setBlock(st, 'memory', '新记忆', 2).state;
ok('SEC3.static_ignore_memory', R.staticText(st, '你是RP助手') === t1);

// BM25F 惰性索引
let doc = K.emptyDoc('w-v');
doc = K.addEntry(doc, 'locations', { title: '王都', content: '北方的王都城墙高耸', keywords: ['王都'] });
K.resetIndexCache();
K.search(doc, '王都');
const i1 = K.getIndexCache();
K.search(doc, '城墙');
ok('SEC3.bm25_lazy', i1 && i1 === K.getIndexCache());

// Affect 轻量步进
const light = Affect.stepLight(null, '随便聊聊', Date.now());
ok('SEC3.affect_light', light && light.stateMissing && String(light.p || '').indexOf('missing_state') >= 0);

// 不回退主界面 / 资料库不占主屏 / 保留 4.1-4.2
ok('UI.no_home_cards', !html.includes('home-cards') && !html.includes('id="btn-knowledge"'));
ok('UI.kept_composer_drawer', html.includes('id="btn-composer-more"') && html.includes('id="usage-pill"') && html.includes('id="drawer-recent"'));

const failed = results.filter(x => !x.pass);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
if (failed.length) process.exit(1);
