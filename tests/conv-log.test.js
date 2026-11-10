// 第五轮 C：追加式 op log + 快照 replay + 迁移/逃生口 + 双端 fuzz + 性能门禁
const test = require('node:test');
const assert = require('node:assert');
const CL = require('../app/src/main/assets/www/conv-log.js');

function store() { return CL.memStore(); }
function msg(id, role, content, extra) {
  return Object.assign({ id, role, content, createdAt: 1 }, extra || {});
}
function legacyConv(overrides) {
  return Object.assign({
    id: 'c1', title: '雨港侦探', providerId: 'deepseek', model: 'm',
    systemPrompt: '你是助手', createdAt: 100, updatedAt: 200,
    messages: [msg('u1', 'user', '你好'), msg('a1', 'assistant', '你好，侦探')],
    worldRef: { id: 'w-rain', version: 2, blockHash: { world: 'abc' }, syncedAt: 200 },
    worldLog: [{ at: 150, fromVersion: 1, toVersion: 2, mode: 'merge' }],
    affect: { mood: 'calm', a: 0.2 },
    ledger: [{ id: 'f1', subject: '主角', attribute: '职业', quote: '侦探', validFromTurn: 1 }],
    plugins: { rpcache: { enabled: true, state: { chapters: [{ no: 1, content: '第一章：雨夜。很长的章节正文。'.repeat(20), hash: 'h1' }] } } },
  }, overrides || {});
}
function liveIds(conv) { return (conv.messages || []).map(m => m.id); }

test('migrate：旧格式 → snapshot(upTo=0) + 全量 op，原文件只读保留；replay 一致', () => {
  CL.clearSessions();
  const st = store();
  const conv = legacyConv();
  st.set(CL.legacyKey(conv.id), conv);
  const loaded = CL.load(st, conv.id);
  assert.ok(loaded);
  assert.strictEqual(loaded.title, '雨港侦探');
  assert.deepStrictEqual(liveIds(loaded), ['u1', 'a1']);
  assert.strictEqual(loaded.messages[1].content, '你好，侦探');
  assert.ok(loaded.worldRef && loaded.worldRef.version === 2);
  assert.strictEqual((loaded.worldLog || []).length, 1);
  assert.strictEqual(loaded.affect.mood, 'calm');
  assert.strictEqual(loaded.ledger[0].id, 'f1');
  const ch = CL.extractChapters(loaded);
  assert.strictEqual(ch.length, 1);
  assert.ok(ch[0].content.includes('第一章'));
  const raw = st.get(CL.legacyKey(conv.id));
  assert.strictEqual(raw.format, undefined);
  assert.strictEqual(raw.messages.length, 2);
  assert.strictEqual(raw.title, '雨港侦探');
  const snap = st.get(CL.snapshotKey(conv.id));
  assert.strictEqual(snap.format, CL.FORMAT);
  assert.ok(snap.upToLamport > 0);
  assert.strictEqual((st.readJsonl(CL.logKey(conv.id)) || []).length, 0);
});

test('导出为旧格式逃生口：剥离 format，保留 messages / worldRef / worldLog / 章节', () => {
  CL.clearSessions();
  const st = store();
  st.set(CL.legacyKey('c1'), legacyConv());
  CL.load(st, 'c1');
  const out = CL.exportLegacy(st, 'c1');
  assert.ok(out && !out.format);
  assert.strictEqual(out.id, 'c1');
  assert.strictEqual(out.title, '雨港侦探');
  assert.deepStrictEqual(liveIds(out), ['u1', 'a1']);
  assert.strictEqual(out.worldRef.id, 'w-rain');
  assert.strictEqual(out.worldLog.length, 1);
  assert.ok(CL.extractChapters(out)[0].content.includes('第一章'));
  assert.ok(!('contentZ' in (CL.extractChapters(out)[0] || {})));
  const parsed = JSON.parse(CL.exportLegacyJSON(st, 'c1'));
  assert.strictEqual(parsed.format, undefined);
  assert.strictEqual(parsed.messages.length, 2);
});

test('旧格式迁移 100%：多样本（空会话 / 单条 / 无 worldRef / 多章节）均可往返', () => {
  const samples = [
    { id: 's0', title: '空', messages: [], providerId: 'p', model: 'm' },
    { id: 's1', title: '单条', messages: [msg('u', 'user', 'hi')], systemPrompt: 'sys' },
    legacyConv({ id: 's2' }),
    legacyConv({ id: 's3', worldRef: undefined, worldLog: undefined, affect: undefined, ledger: undefined }),
    legacyConv({
      id: 's4',
      messages: Array.from({ length: 30 }, (_, i) => msg('m' + i, i % 2 ? 'assistant' : 'user', 't' + i)),
      plugins: { rpcache: { state: { chapters: [
        { no: 1, content: '老章一' }, { no: 2, content: '老章二' }, { no: 3, content: '当前章' },
      ] } } },
    }),
  ];
  let ok = 0;
  samples.forEach(c => {
    CL.clearSessions();
    const st = store();
    st.set(CL.legacyKey(c.id), c);
    const exp = CL.exportLegacy(st, c.id);
    assert.strictEqual(exp.id, c.id);
    assert.deepStrictEqual(liveIds(exp), liveIds(c));
    assert.strictEqual(exp.title, c.title);
    assert.strictEqual(CL.extractChapters(exp).length, CL.extractChapters(c).length);
    if (c.worldRef) assert.strictEqual(exp.worldRef.id, c.worldRef.id);
    ok++;
  });
  assert.strictEqual(ok, samples.length);
});

test('写：push 只追加 jsonl，不整份序列化 messages；读：snapshot + 尾部 replay', () => {
  CL.clearSessions();
  const st = store();
  CL.commit(st, { id: 'c2', title: '新对话', messages: [], providerId: 'p', model: 'm' });
  assert.ok(st.get(CL.snapshotKey('c2')));
  const ptr = st.get(CL.legacyKey('c2'));
  assert.strictEqual(ptr.format, CL.FORMAT);
  assert.ok(!ptr.messages);
  CL.push(st, 'c2', { op: 'msg.add', payload: msg('u1', 'user', 'hello') });
  CL.push(st, 'c2', { op: 'meta.set', payload: { patch: { title: '第一句' } } });
  const log = st.readJsonl(CL.logKey('c2')) || [];
  assert.ok(log.some(o => o.op === 'msg.add' && o.payload.id === 'u1'));
  assert.ok(!st.get(CL.legacyKey('c2')).messages);
  CL.clearSessions();
  const re = CL.load(st, 'c2');
  assert.strictEqual(re.title, '第一句');
  assert.strictEqual(re.messages[0].content, 'hello');
});

test('压缩：每 200 op 打快照，日志截断；老章节可 fflate 压缩', () => {
  CL.clearSessions();
  const st = store();
  CL.commit(st, { id: 'c3', title: 't', messages: [], providerId: 'p', model: 'm' });
  for (let i = 0; i < 201; i++) {
    CL.push(st, 'c3', { op: 'msg.add', payload: msg('m' + i, i % 2 ? 'assistant' : 'user', 'body-' + i) });
  }
  const log = st.readJsonl(CL.logKey('c3')) || [];
  const snap = st.get(CL.snapshotKey('c3'));
  assert.ok(snap.upToLamport >= 200, '应至少打过一次快照, upTo=' + snap.upToLamport);
  assert.ok(log.length < 200, 'compact should truncate log, got ' + log.length);
  const combined = (snap.messages || []).length + log.filter(o => o && o.op === 'msg.add').length;
  assert.ok(combined >= 201, 'snapshot+尾部应覆盖 201 条, got ' + combined);
  CL.clearSessions();
  const re = CL.load(st, 'c3');
  assert.strictEqual(re.messages.length, 201);
  assert.strictEqual(re.messages[200].id, 'm200');

  const long = '雨夜港湾的旧事。'.repeat(80);
  const packed = CL.packChapters([
    { no: 1, content: long },
    { no: 2, content: long },
    { no: 3, content: '当前章较短' },
  ]);
  assert.ok(packed[0].contentZ && packed[0].content === '');
  assert.ok(packed[1].contentZ);
  assert.strictEqual(packed[2].content, '当前章较短');
  const unpacked = CL.unpackChapters(packed);
  assert.strictEqual(unpacked[0].content, long);
  assert.ok(!unpacked[0].contentZ);
  assert.strictEqual(unpacked[2].content, '当前章较短');
});

test('worldRef / worldLog 与 worlds.json、knowledge_world_*.json 互不干扰', () => {
  CL.clearSessions();
  const st = store();
  st.set('worlds.json', [{ id: 'w-rain', version: 2, name: '雨港' }]);
  st.set('knowledge_world_w-rain.json', { worldId: 'w-rain', entries: [{ id: 'e1', title: '别墅' }] });
  st.set(CL.legacyKey('c1'), legacyConv());
  const c = CL.load(st, 'c1');
  c.title = '改名';
  CL.commit(st, c);
  assert.strictEqual(st.get('worlds.json')[0].name, '雨港');
  assert.strictEqual(st.get('knowledge_world_w-rain.json').entries[0].id, 'e1');
  assert.strictEqual(CL.load(st, 'c1').worldRef.id, 'w-rain');
});

test('最小同步：消息 LWW；章节/账本冲突保留双方；传输单元为 op 批次', () => {
  CL.clearSessions();
  const a = store();
  const b = store();
  a.set(CL.DEVICE_FILE, { dev: 'android-a' });
  b.set(CL.DEVICE_FILE, { dev: 'android-b' });
  const base = { id: 'cx', title: '同步', messages: [msg('u1', 'user', '起手')], providerId: 'p', model: 'm' };
  CL.commit(a, base);
  CL.importBatch(b, 'cx', CL.exportBatch(a, 'cx', 0));
  CL.clearSessions();
  CL.push(a, 'cx', { op: 'msg.add', payload: msg('a-only', 'assistant', 'A 的回复') });
  CL.push(b, 'cx', { op: 'msg.add', payload: msg('b-only', 'assistant', 'B 的回复') });
  CL.push(a, 'cx', { op: 'msg.edit', payload: msg('u1', 'user', '起手（A 改）') });
  CL.push(b, 'cx', { op: 'msg.edit', payload: msg('u1', 'user', '起手（B 改）') });
  CL.push(a, 'cx', { op: 'chapter.commit', payload: { no: 1, content: '章-A' } });
  CL.push(b, 'cx', { op: 'chapter.commit', payload: { no: 1, content: '章-B' } });
  CL.push(a, 'cx', { op: 'ledger.append', payload: { fact: { id: 'f1', quote: 'A事实' } } });
  CL.push(b, 'cx', { op: 'ledger.append', payload: { fact: { id: 'f2', quote: 'B事实' } } });
  assert.ok(CL.exportBatch(a, 'cx', 0).length && CL.exportBatch(b, 'cx', 0).length);
  const merged = CL.mergeStores(a, b, 'cx');
  const idsA = new Set(liveIds(merged.a));
  const idsB = new Set(liveIds(merged.b));
  assert.ok(idsA.has('u1') && idsA.has('a-only') && idsA.has('b-only'), 'A 合并后应有全部消息 ' + [...idsA]);
  assert.deepStrictEqual([...idsA].sort(), [...idsB].sort());
  const chA = CL.extractChapters(merged.a);
  const chTexts = chA.map(c => c.content);
  assert.ok(chTexts.some(t => t && t.includes('章-A')) && chTexts.some(t => t && t.includes('章-B')),
    '章节冲突应保留双方 ' + JSON.stringify(chTexts));
  const led = merged.a.ledger || [];
  assert.ok(led.some(f => f.id === 'f1') && led.some(f => f.id === 'f2'));
});

test('双端并发编辑 fuzz：合并后无消息丢失', () => {
  let seed = 0xC0FFEE;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0x100000000; };
  const rand = n => Math.floor(rnd() * n);

  for (let trial = 0; trial < 8; trial++) {
    CL.clearSessions();
    const a = store();
    const b = store();
    a.set(CL.DEVICE_FILE, { dev: 'dev-a' });
    b.set(CL.DEVICE_FILE, { dev: 'dev-b' });
    const id = 'fuzz' + trial;
    CL.commit(a, { id, title: 'fuzz', messages: [], providerId: 'p', model: 'm' });
    CL.importBatch(b, id, CL.exportBatch(a, id, 0));
    let seq = 0;
    function act(st, prefix) {
      for (let i = 0; i < 60; i++) {
        const live = liveIds(CL.load(st, id));
        const roll = rand(10);
        if (roll < 6 || live.length < 2) {
          const mid = prefix + '-' + (++seq) + '-t' + trial;
          CL.push(st, id, { op: 'msg.add', payload: msg(mid, seq % 2 ? 'assistant' : 'user', 't-' + mid) });
        } else if (roll < 8) {
          const mid = live[rand(live.length)];
          CL.push(st, id, { op: 'msg.edit', payload: { id: mid, content: 'edit-' + prefix + '-' + i } });
        } else if (live.length >= 2) {
          CL.push(st, id, { op: 'msg.remove', payload: { id: live[rand(live.length)] } });
        }
        if (i === 30) {
          const other = st === a ? b : a;
          CL.importBatch(other, id, CL.exportBatch(st, id, 0));
        }
      }
    }
    act(a, 'a');
    act(b, 'b');
    const unionOps = CL.exportBatch(a, id, 0).concat(CL.exportBatch(b, id, 0));
    const truth = store();
    truth.set(CL.DEVICE_FILE, { dev: 'truth' });
    CL.clearSessions();
    CL.importBatch(truth, id, unionOps);
    const expect = new Set(liveIds(CL.load(truth, id)));
    const merged = CL.mergeStores(a, b, id);
    const idsA = new Set(liveIds(merged.a));
    const idsB = new Set(liveIds(merged.b));
    assert.deepStrictEqual([...idsA].sort(), [...idsB].sort(), 'trial ' + trial + ' 两端最终不一致');
    assert.deepStrictEqual([...idsA].sort(), [...expect].sort(), 'trial ' + trial + ' 合并结果与全集 replay 不一致，发生丢失或多余');
  }
});

test('性能门禁：10k 消息冷启动 < 300ms、单条写入 < 5ms、搜索 < 50ms', () => {
  CL.clearSessions();
  const st = store();
  const id = 'p10k';
  const messages = [];
  for (let i = 0; i < 10000; i++) {
    messages.push(msg('m' + i, i % 2 ? 'assistant' : 'user', '第' + i + '条消息内容，雨港的夜晚很长。关键词 UNIQUE-' + (i === 4242 ? 'NEEDLE' : i)));
  }
  const conv = { id, title: '万条会话', providerId: 'p', model: 'm', messages };
  const tMig0 = performance.now();
  CL.commit(st, conv);
  const tMig1 = performance.now();
  CL.clearSessions();
  const t0 = performance.now();
  const loaded = CL.load(st, id);
  const cold = performance.now() - t0;
  assert.strictEqual(loaded.messages.length, 10000);
  assert.ok(cold < 300, '冷启动 ' + cold.toFixed(2) + 'ms >= 300ms（含首次迁移/压缩 ' + (tMig1 - tMig0).toFixed(2) + 'ms）');

  const writes = [];
  for (let i = 0; i < 20; i++) {
    const w0 = performance.now();
    CL.push(st, id, { op: 'msg.add', payload: msg('w' + i, 'user', '追加' + i) }, { compact: false });
    writes.push(performance.now() - w0);
  }
  const wMax = Math.max.apply(null, writes);
  const wAvg = writes.reduce((a, b) => a + b, 0) / writes.length;
  assert.ok(wMax < 5, '单条写入最大 ' + wMax.toFixed(3) + 'ms >= 5ms（均 ' + wAvg.toFixed(3) + 'ms）');

  const s0 = performance.now();
  const found = CL.search(loaded, 'UNIQUE-NEEDLE');
  const sMs = performance.now() - s0;
  assert.ok(found.hits.some(h => h.id === 'm4242'), '搜索未命中 UNIQUE-NEEDLE');
  assert.ok(sMs < 50 && found.ms < 50, '搜索 ' + sMs.toFixed(2) + 'ms / 内部 ' + found.ms.toFixed(2) + 'ms >= 50ms');
  console.log('[perf] cold=' + cold.toFixed(2) + 'ms writeMax=' + wMax.toFixed(3) + 'ms writeAvg=' + wAvg.toFixed(3) + 'ms search=' + sMs.toFixed(2) + 'ms');
});

test('kb.upsert 只存在会话 op 侧，不改 knowledge_world 文件', () => {
  CL.clearSessions();
  const st = store();
  st.set('knowledge_world_w1.json', { worldId: 'w1', entries: [{ id: 'e0', title: '原' }] });
  CL.commit(st, { id: 'ck', title: 'k', messages: [], providerId: 'p', model: 'm' });
  CL.push(st, 'ck', { op: 'kb.upsert', payload: { worldId: 'w1', entry: { id: 'e1', title: '新条目' } } });
  assert.strictEqual(st.get('knowledge_world_w1.json').entries.length, 1);
  assert.strictEqual(st.get('knowledge_world_w1.json').entries[0].id, 'e0');
});
