#!/usr/bin/env node
/** 第五轮 C 功能验证：迁移 / 导出旧格式 / replay 压缩 / 双端 fuzz / 性能门禁 / 5.4 golden */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WWW = path.join(ROOT, 'app/src/main/assets/www');
const CL = require(path.join(WWW, 'conv-log.js'));
const core = require(path.join(ROOT, 'scripts/lib/eval-core.js'));

const results = [];
function ok(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

function store() { return CL.memStore(); }
function msg(id, role, content) { return { id, role, content, createdAt: 1 }; }
function liveIds(c) { return (c.messages || []).map(m => m.id); }

CL.clearSessions();
const legacy = {
  id: 'c-e', title: '验收', providerId: 'p', model: 'm',
  messages: [msg('u1', 'user', '你好'), msg('a1', 'assistant', '雨港')],
  worldRef: { id: 'w-rain', version: 2, blockHash: { world: 'x' }, syncedAt: 1 },
  worldLog: [{ at: 1, toVersion: 2, mode: 'merge' }],
  plugins: { rpcache: { state: { chapters: [{ no: 1, content: '第一章正文' }] } } },
};
const st = store();
st.set('worlds.json', [{ id: 'w-rain', name: '雨港' }]);
st.set('knowledge_world_w-rain.json', { worldId: 'w-rain', entries: [{ id: 'e1' }] });
st.set(CL.legacyKey(legacy.id), legacy);
const loaded = CL.load(st, legacy.id);
ok('C.migrate_roundtrip', loaded && liveIds(loaded).join() === 'u1,a1' && loaded.worldRef.id === 'w-rain' && CL.extractChapters(loaded)[0].content === '第一章正文',
  loaded && liveIds(loaded).join());
const raw = st.get(CL.legacyKey(legacy.id));
ok('C.legacy_readonly', raw && !raw.format && raw.messages.length === 2 && raw.title === '验收');
ok('C.worlds_kb_untouched', st.get('worlds.json')[0].name === '雨港' && st.get('knowledge_world_w-rain.json').entries[0].id === 'e1');
const exp = CL.exportLegacy(st, legacy.id);
ok('C.export_legacy', exp && !exp.format && liveIds(exp).join() === 'u1,a1' && exp.worldRef.id === 'w-rain');

CL.clearSessions();
const st2 = store();
CL.commit(st2, { id: 'c2', title: 't', messages: [], providerId: 'p', model: 'm' });
for (let i = 0; i < 201; i++) CL.push(st2, 'c2', { op: 'msg.add', payload: msg('m' + i, 'user', 'b' + i) });
CL.clearSessions();
const re = CL.load(st2, 'c2');
const logLen = (st2.readJsonl(CL.logKey('c2')) || []).length;
ok('C.compact_replay', re.messages.length === 201 && logLen < 200 && st2.get(CL.snapshotKey('c2')).upToLamport >= 200,
  'msgs=' + re.messages.length + ' log=' + logLen);

// fuzz 3 trials (full 8 are in unit tests)
let fuzzOk = true;
let seed = 20261110;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
const rand = n => Math.floor(rnd() * n);
for (let trial = 0; trial < 3 && fuzzOk; trial++) {
  CL.clearSessions();
  const a = store(); const b = store();
  a.set(CL.DEVICE_FILE, { dev: 'dev-a' });
  b.set(CL.DEVICE_FILE, { dev: 'dev-b' });
  const id = 'fz' + trial;
  CL.commit(a, { id, title: 'f', messages: [], providerId: 'p', model: 'm' });
  CL.importBatch(b, id, CL.exportBatch(a, id, 0));
  let seq = 0;
  const act = (side, prefix) => {
    for (let i = 0; i < 40; i++) {
      const live = liveIds(CL.load(side, id));
      const roll = rand(10);
      if (roll < 6 || live.length < 2) {
        CL.push(side, id, { op: 'msg.add', payload: msg(prefix + '-' + (++seq), 'user', 't') });
      } else if (roll < 8) {
        CL.push(side, id, { op: 'msg.edit', payload: { id: live[rand(live.length)], content: 'e' + i } });
      } else if (live.length >= 2) {
        CL.push(side, id, { op: 'msg.remove', payload: { id: live[rand(live.length)] } });
      }
    }
  };
  act(a, 'a'); act(b, 'b');
  const union = CL.exportBatch(a, id, 0).concat(CL.exportBatch(b, id, 0));
  const truth = store();
  CL.clearSessions();
  CL.importBatch(truth, id, union);
  const expect = liveIds(CL.load(truth, id)).slice().sort().join();
  const merged = CL.mergeStores(a, b, id);
  const idsA = liveIds(merged.a).slice().sort().join();
  const idsB = liveIds(merged.b).slice().sort().join();
  if (idsA !== idsB || idsA !== expect) fuzzOk = false;
}
ok('C.fuzz_noloss', fuzzOk, fuzzOk ? '3 trials' : 'failed');

// perf
CL.clearSessions();
const pst = store();
const messages = Array.from({ length: 10000 }, (_, i) => msg('m' + i, i % 2 ? 'assistant' : 'user', '第' + i + '条 UNIQUE-' + (i === 4242 ? 'NEEDLE' : i)));
CL.commit(pst, { id: 'p10k', title: '万条', providerId: 'p', model: 'm', messages });
CL.clearSessions();
let t0 = performance.now();
const p10 = CL.load(pst, 'p10k');
const cold = performance.now() - t0;
const writes = [];
for (let i = 0; i < 20; i++) {
  const w0 = performance.now();
  CL.push(pst, 'p10k', { op: 'msg.add', payload: msg('w' + i, 'user', 'x' + i) }, { compact: false });
  writes.push(performance.now() - w0);
}
const wMax = Math.max(...writes);
t0 = performance.now();
const found = CL.search(p10, 'UNIQUE-NEEDLE');
const sMs = performance.now() - t0;
ok('C.perf_cold_lt_300ms', p10.messages.length === 10000 && cold < 300, cold.toFixed(2) + 'ms');
ok('C.perf_write_lt_5ms', wMax < 5, wMax.toFixed(3) + 'ms');
ok('C.perf_search_lt_50ms', found.hits.some(h => h.id === 'm4242') && sMs < 50, sMs.toFixed(2) + 'ms');

const ev = core.evalOplog();
ok('C.golden_oplog', ev.passRate === 1, 'passRate=' + ev.passRate + ' n=' + ev.n + (ev.per.filter(x => !x.pass).map(x => x.id + ':' + x.fail).join(';') || ''));

const packed = CL.packChapters([{ no: 1, content: '雨夜港湾的旧事。'.repeat(80) }, { no: 2, content: '当前' }]);
ok('C.chapter_fflate', packed[0].contentZ && CL.unpackChapters(packed)[0].content.includes('雨夜') && packed[1].content === '当前');

const unit = spawnSync(process.execPath, ['--test', 'tests/conv-log.test.js'], { cwd: ROOT, encoding: 'utf8' });
ok('C.unit_tests', unit.status === 0, unit.status === 0 ? 'tests/conv-log.test.js' : (unit.stderr || unit.stdout).slice(-400));

const failed = results.filter(r => !r.pass);
console.log('\n' + (failed.length ? 'FAILED ' + failed.length + '/' + results.length : 'ALL PASSED ' + results.length + '/' + results.length));
process.exit(failed.length ? 1 : 0);
