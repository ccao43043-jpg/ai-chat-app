#!/usr/bin/env node
/** 第五轮 E 功能验证：漂移检测 / 三路合并 / 冲突保留 + _pending / 一键回滚 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WWW = path.join(ROOT, 'app/src/main/assets/www');
const W = require(path.join(WWW, 'worlds.js'));
const RPCache = require(path.join(WWW, 'rpcache.js'));

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

function world(blocks) {
  return W.normalizeWorld({ id: 'w-e', name: '验收世界', blocks });
}
function open(wd, at) {
  return W.applyWorldToConversation({
    id: 'c-e', title: 't', messages: [], plugins: {}, systemPrompt: 's',
  }, wd, RPCache, at || 1).conv;
}
function edit(conv, id, text, at) {
  const st = RPCache.setBlock(conv.plugins.rpcache.state, id, text, at).state;
  return Object.assign({}, conv, { plugins: { rpcache: Object.assign({}, conv.plugins.rpcache, { state: st }) } });
}
function bump(wd, blocks) {
  return W.upsert([wd], Object.assign({}, wd, { blocks: Object.assign({}, wd.blocks, blocks) }))[0];
}

const v1 = world({ world: '南方', character: '侦探', rules: '不替玩家决定' });
let conv = open(v1, 1000);
const v2 = bump(v1, { world: '北方', character: '侦探（模板改）' });

// E1 老对话（无 worldRef）100% 检出漂移
const legacy = { id: 'c-old', worldId: v1.id, plugins: conv.plugins };
const rOld = W.detectDrift(legacy, v2, W.getConvBlocks(legacy, RPCache));
ok('E.drift_legacy_100', rOld.ids.includes('world') && rOld.ids.includes('character') && !rOld.ids.includes('rules'),
  'ids=' + rOld.ids.join(','));

// E1b 有 worldRef 的对话同样检出
const rNew = W.detectDrift(conv, v2, W.getConvBlocks(conv, RPCache));
ok('E.drift_ref_100', rNew.ids.includes('world') && rNew.ids.includes('character') && !rNew.ids.includes('rules'),
  'ids=' + rNew.ids.join(','));

// E2 三路合并 + 本地 0 丢失
conv = edit(conv, 'character', '侦探（左撇子）', 2000);
const synced = W.applySyncToConversation(conv, v2, RPCache, { mode: 'merge', at: 3000 });
const after = W.getConvBlocks(synced.conv, RPCache);
ok('E.merge_take_theirs', after.world === '北方', after.world);
ok('E.merge_conflict_keep_current', after.character === '侦探（左撇子）', after.character);
ok('E.merge_pending', synced.conv.worldPending.character === '侦探（模板改）', JSON.stringify(synced.conv.worldPending));
ok('E.merge_zero_loss', after.character.includes('左撇子'));

const m1 = W.merge3('a', 'a', 'b');
const m2 = W.merge3('a', 'b', 'b');
const m3 = W.merge3('a', 'c', 'a');
const m4 = W.merge3('a', 'c', 'b');
ok('E.merge3_branches', m1.action === 'takeTheirs' && m2.action === 'unchanged' && m3.action === 'keepCurrent' && m4.action === 'conflict' && m4._pending === 'b' && m4.content === 'c');

// E3 一键回滚任意一次同步
const v3 = bump(v2, { world: '极北', rules: '新规则' });
const s2 = W.applySyncToConversation(synced.conv, v3, RPCache, { mode: 'merge', at: 4000 });
ok('E.log_two_syncs', s2.conv.worldLog.length === 2, String(s2.conv.worldLog.length));
const rolled = W.rollbackWorldLog(s2.conv, RPCache, { index: 0, at: 5000 });
const rb = W.getConvBlocks(rolled.conv, RPCache);
ok('E.rollback_any', rolled.conv.worldLog.length === 0 && rb.world === '南方' && rb.character === '侦探（左撇子）' && rb.rules === '不替玩家决定',
  JSON.stringify({ world: rb.world, character: rb.character, rules: rb.rules, log: rolled.conv.worldLog.length }));

const overwrite = W.applySyncToConversation(conv, v2, RPCache, { mode: 'overwrite', at: 6000 });
const ov = W.getConvBlocks(overwrite.conv, RPCache);
const rolledOv = W.rollbackWorldLog(overwrite.conv, RPCache, { at: 7000 });
ok('E.overwrite_then_rollback', ov.character === '侦探（模板改）' && W.getConvBlocks(rolledOv.conv, RPCache).character === '侦探（左撇子）');

// 跑专项单测（可重复）
const t = spawnSync('node', ['--test', 'tests/world-merge.test.js', 'tests/worlds.test.js'], { cwd: ROOT, encoding: 'utf8' });
const okLine = (t.stdout || '').match(/# (ok|fail|passed|tests).*/g) || [];
const failed = t.status !== 0;
ok('E.unit_tests', !failed, (t.stdout || t.stderr || '').split('\n').filter(l => /^(# |not ok|ok |1\.\.)/.test(l)).slice(-8).join(' | '));

const failedN = results.filter(r => !r.pass).length;
console.log('\n' + results.length + ' checks, ' + (results.length - failedN) + ' passed, ' + failedN + ' failed');
process.exit(failedN ? 1 : 0);
