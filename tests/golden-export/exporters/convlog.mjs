// conv-log.js（oplog-v1）golden：纯函数 + 带 store 的 load / commit 场景。
// Kotlin 对照：app/src/test/java/com/aichat/app/data/convlog/ConvLogGoldenTest.kt
import { loadWww, rng } from '../lib.mjs';

const DEV_FILE = JSON.stringify({ dev: 'dev-golden-a' });
const TEXTS = ['你好', '雨夜的港口，灯塔在闪。', 'Hello **world**\n\n```js\nconsole.log(1)\n```', '引号 "quote" \\ 反斜杠\t制表', '😀 emoji 与 \u0001 控制符',
  '长段落：' + '霓虹在积水里碎成千万片。'.repeat(4), '', '1e21', '<script>x</script>'];
const NUMS = [0, 1, -1, 0.5, 0.000123, 1e-7, 123456789012, 1e21, 3.14159, 2 / 3, 100];

function makeGen(seed) {
  const r = rng(seed);
  let n = 0;
  const uid = p => p + (++n).toString(36) + r.int(0, 999);
  const text = () => r.pick(TEXTS) + (r.chance(0.5) ? ' #' + r.int(0, 99) : '');
  const usage = () => ({ prompt: r.int(10, 9000), completion: r.int(1, 2000), hit: r.int(0, 8000), miss: r.int(0, 500), costUsd: r.pick(NUMS), source: 'api', raw: { x: r.pick(NUMS) } });
  const message = (role) => {
    const m = { id: uid('m'), role: role || r.pick(['user', 'assistant']), content: text(), createdAt: 1700000000000 + r.int(0, 1e6) };
    if (m.role === 'assistant' && r.chance(0.5)) m.usage = usage();
    if (r.chance(0.2)) { m.versions = [{ content: text(), createdAt: 1 }, null]; m.vi = 1; }
    if (r.chance(0.15)) m.images = ['data:image/png;base64,iVBORw0KGgo='];
    if (r.chance(0.1)) m.pluginStatus = { rpcache: { hitRate: r.pick(NUMS) } };
    if (r.chance(0.1)) m.truncated = true;
    if (r.chance(0.1)) m.reasoning = text();
    return m;
  };
  const chapter = no => ({ no, title: '第' + no + '章', content: '章节正文 ' + no + '：' + '风从海上来，带着盐和铁锈的味道。'.repeat(r.int(1, 10)), hash: 'h' + r.int(0, 1e6), turns: [r.int(0, 9), r.int(10, 20)] });
  const fact = () => ({ id: r.chance(0.7) ? uid('f') : undefined, subject: r.pick(['主角', '侦探', '船长']), attribute: r.pick(['职业', '伤势', '心情']), quote: text().slice(0, 12), validFromTurn: r.int(0, 50) });
  return { r, uid, text, usage, message, chapter, fact };
}

function legacyConv(gen, id, opts) {
  const { r } = gen;
  const c = { id, title: gen.text().slice(0, 10) || '新对话', providerId: r.pick(['deepseek', 'openrouter', 'gemini']), model: r.pick(['deepseek-chat', 'google/gemini-2.5-flash']),
    createdAt: 1690000000000, updatedAt: 1690000100000 + r.int(0, 1e5), systemPrompt: r.chance(0.5) ? gen.text() : undefined,
    temperature: r.chance(0.3) ? r.pick([0.7, 1, '']) : undefined, messages: [] };
  const nm = (opts && opts.messages) != null ? opts.messages : r.int(0, 12);
  for (let i = 0; i < nm; i++) c.messages.push(gen.message(i % 2 ? 'assistant' : 'user'));
  if (r.chance(0.6)) c.plugins = { rpcache: { enabled: true, state: { chapters: Array.from({ length: r.int(0, 4) }, (_, i) => gen.chapter(i + 1)), lastHit: r.pick(NUMS) } }, affect: { enabled: r.chance(0.5) } };
  if (r.chance(0.5)) c.affect = { mood: r.pick(['calm', 'angry']), a: r.pick(NUMS), kf: { x: [0.1, 0.2], P: [[1, 0], [0, 1]] } };
  if (r.chance(0.3)) c.affectBy = { 'char-1': { v: r.pick(NUMS) }, 'char-2': { v: r.pick(NUMS) } };
  if (r.chance(0.5)) c.ledger = Array.from({ length: r.int(1, 4) }, () => gen.fact());
  if (r.chance(0.5)) { c.worldRef = { id: 'w-rain', version: r.int(1, 5), blockHash: { world: 'abc' } }; c.worldPending = r.chance(0.3) ? { version: 9 } : null; }
  if (r.chance(0.4)) c.worldLog = [{ at: 150, fromVersion: 1, toVersion: 2, mode: 'merge' }];
  if (r.chance(0.3)) { c.personaName = '侦探'; c.personaEmoji = '🕵️'; }
  if (r.chance(0.2)) c.kb = { w1: { e1: { id: 'e1' } } };
  if (r.chance(0.2)) c['10'] = 'numeric-key'; // JS 键顺序：数组下标键排前
  c.unknownFutureField = { nested: [1, { deep: true }] };
  return JSON.parse(JSON.stringify(c));
}

/** 模拟 app 里对 conv 的一次编辑（直接改对象，再 commit） */
function mutate(gen, conv) {
  const { r } = gen;
  const msgs = conv.messages;
  const k = r.int(0, 13);
  if (k <= 3 || !msgs.length) msgs.push(gen.message());
  else if (k === 4) msgs[r.int(0, msgs.length - 1)].content = gen.text();
  else if (k === 5) msgs.splice(r.int(0, msgs.length - 1), 1);
  else if (k === 6) { const m = msgs[r.int(0, msgs.length - 1)]; m.versions = [{ content: m.content }, null]; m.vi = 1; m.content = gen.text(); }
  else if (k === 7) { if (msgs.length > 1) { const i = r.int(0, msgs.length - 2); [msgs[i], msgs[i + 1]] = [msgs[i + 1], msgs[i]]; } }
  else if (k === 8) { conv.plugins = conv.plugins || {}; conv.plugins.rpcache = conv.plugins.rpcache || {}; const st = conv.plugins.rpcache.state = conv.plugins.rpcache.state || {}; st.chapters = st.chapters || []; st.chapters.push(gen.chapter(st.chapters.length + 1)); }
  else if (k === 9) { const ch = conv.plugins && conv.plugins.rpcache && conv.plugins.rpcache.state && conv.plugins.rpcache.state.chapters; if (ch && ch.length) { if (r.chance(0.3)) ch.splice(0, 1); else ch[ch.length - 1].content += '（修订）'; } else conv.title = gen.text().slice(0, 8); }
  else if (k === 10) conv.affect = r.chance(0.2) ? null : { mood: r.pick(['calm', 'tense']), a: r.pick(NUMS) };
  else if (k === 11) { conv.ledger = (conv.ledger || []).concat([gen.fact()]); }
  else if (k === 12) { conv.worldRef = { id: 'w-' + r.int(0, 3), version: r.int(1, 9) }; conv.worldLog = (conv.worldLog || []).concat([{ at: r.int(0, 1e6), toVersion: conv.worldRef.version }]); }
  else { conv.title = gen.text().slice(0, 8); conv.model = r.pick(['a', 'b']); if (r.chance(0.3)) delete conv.systemPrompt; conv.updatedAt = 1700000000000 + r.int(0, 1e6); }
}

/** 生成两设备交错的 op 序列（含同 lamport 冲突、墓碑、乱序） */
function opStream(gen, len) {
  const { r } = gen;
  const ids = [], chNos = [1, 2, 3], ops = [];
  let lam = 0;
  for (let i = 0; i < len; i++) {
    const dev = r.pick(['dev-a', 'dev-b']);
    if (r.chance(0.7)) lam++;
    const lamport = r.chance(0.1) ? Math.max(1, lam - r.int(1, 3)) : lam;
    const k = r.int(0, 16);
    let op;
    if (k <= 3 || !ids.length) { const m = gen.message(); ids.push(m.id); op = { op: 'msg.add', payload: m }; }
    else if (k === 4) { const id = r.pick(ids); op = { op: 'msg.add', payload: Object.assign(gen.message(), { id }) }; }
    else if (k === 5) op = { op: 'msg.edit', payload: { id: r.pick(ids), content: gen.text() } };
    else if (k === 6) op = { op: r.pick(['msg.remove', 'msg.delete']), payload: { id: r.pick(ids) } };
    else if (k === 7) { const s = ids.slice(); s.sort(() => r.next() - 0.5); op = { op: 'msg.reorder', payload: { ids: s.concat(['ghost']) } }; }
    else if (k === 8) op = { op: 'chapter.commit', payload: gen.chapter(r.pick(chNos)) };
    else if (k === 9) op = { op: 'chapter.edit', payload: { no: r.pick(chNos), title: gen.text().slice(0, 6) } };
    else if (k === 10) op = { op: 'chapter.remove', payload: { no: r.pick(chNos) } };
    else if (k === 11) op = { op: 'affect.set', payload: r.chance(0.5) ? { affect: { mood: r.pick(['a', 'b']), v: r.pick(NUMS) } } : { mood: 'raw' } };
    else if (k === 12) op = { op: 'affect.by', payload: { id: r.pick(['c1', 'c2']), state: { v: r.pick(NUMS) } } };
    else if (k === 13) op = { op: 'ledger.append', payload: { fact: Object.assign(gen.fact(), r.chance(0.5) ? { id: 'f-shared' } : {}) } };
    else if (k === 14) op = r.chance(0.5) ? { op: 'worldRef.set', payload: { worldRef: { id: 'w', version: r.int(1, 4) }, worldPending: r.chance(0.5) ? null : { v: 1 } } } : { op: 'worldLog.append', payload: { entry: { at: r.int(0, 5) } } };
    else if (k === 15) op = { op: 'meta.set', payload: { patch: { title: gen.text().slice(0, 6), model: r.pick(['x', 'y']), id: r.chance(0.2) ? '' : undefined, messages: 'skip-me' } } };
    else op = { op: 'kb.upsert', payload: { worldId: r.pick(['w1', 'w2']), entry: { id: r.pick(['e1', 'e2']), text: gen.text().slice(0, 6) } } };
    ops.push(Object.assign({ lamport, dev }, JSON.parse(JSON.stringify(op))));
  }
  if (r.chance(0.3)) ops.push({ op: 'unknown.op', lamport: lam + 1, dev: 'dev-a', payload: {} });
  if (r.chance(0.3)) ops.push(null, { lamport: 1 });
  return ops;
}

function filesOf(st) { const out = {}; Object.keys(st._files).sort().forEach(k => { out[k] = st._files[k]; }); return out; }

export default function (g) {
  const CL = loadWww('conv-log.js');
  const fresh = init => { CL.clearSessions(); return CL.memStore(Object.assign({ 'device-id.json': DEV_FILE }, init || {})); };

  // ---- 1. 纯函数 ----
  for (let s = 0; s < 40; s++) {
    const gen = makeGen(1000 + s);
    const conv = legacyConv(gen, 'c' + s);
    g.add('extractMeta', [conv], CL.extractMeta(conv));
    g.add('convToOps', [conv, 'dev-x'], CL.convToOps(conv, 'dev-x'));
    const ops = opStream(gen, gen.r.int(1, 60));
    const snap = s % 3 === 0 ? null : CL.takeSnapshot(CL.replay(null, CL.convToOps(conv, 'dev-0')), false);
    const state = CL.replay(snap, ops);
    g.add('replay', [snap, ops], state);
    g.add('toConv', [state, false], CL.toConv(state));
    g.add('toConv', [state, true], CL.toConv(JSON.parse(JSON.stringify(state)), { legacy: true }));
    g.add('takeSnapshot', [state], CL.takeSnapshot(state, false));
    g.add('stateFromSnapshot', [CL.takeSnapshot(state, false)], CL.stateFromSnapshot(CL.takeSnapshot(state, false)));
    g.add('stateToOps', [state], CL.stateToOps(state));
    // diff：随机编辑前后
    const prev = JSON.parse(JSON.stringify(conv));
    const next = JSON.parse(JSON.stringify(conv));
    for (let i = 0; i < gen.r.int(1, 6); i++) mutate(gen, next);
    g.add('diff', [prev, next], CL.diff(prev, next));
    g.add('diff', [null, next], CL.diff(null, next));
    g.add('stampCmp', [ops[0], ops[ops.length - 1]], CL.stampCmp(ops[0], ops[ops.length - 1]));
  }
  // 解压兼容：JS 压缩产物必须能被 Kotlin 解出
  ['', '短', '第一章：雨夜。很长的章节正文。'.repeat(20), '😀'.repeat(100) + 'abc'].forEach(t => {
    const z = CL.compressStr(t);
    g.add('decompressStr', [z], CL.decompressStr(z));
  });
  g.add('packChapters', [[{ no: 1, content: '老章一'.repeat(50) }, { no: 2, content: '' }, { no: 3, content: '当前章' }]],
    CL.unpackChapters(CL.packChapters([{ no: 1, content: '老章一'.repeat(50) }, { no: 2, content: '' }, { no: 3, content: '当前章' }])));

  // ---- 2. load：旧格式迁移 / 指针 / 快照 + 日志 ----
  for (let s = 0; s < 25; s++) {
    const gen = makeGen(2000 + s);
    const id = 'L' + s;
    const conv = legacyConv(gen, id);
    const init = { [CL.legacyKey(id)]: JSON.stringify(conv) };
    if (s % 5 === 1) { // 已是 oplog：快照 + 尾部日志
      const st0 = fresh(init); CL.load(st0, id);
      const c = CL.load(st0, id); for (let i = 0; i < 5; i++) { mutate(gen, c); CL.commit(st0, c); }
      Object.assign(init, st0._files);
    }
    if (s % 5 === 2) { init[CL.legacyKey(id)] = JSON.stringify({ format: 'oplog-v1', id, title: '指针', providerId: 'p', model: 'm', updatedAt: 5 }); }
    if (s % 5 === 3) { delete init[CL.legacyKey(id)]; init[CL.logKey(id)] = opStream(gen, 30).filter(Boolean).map(o => JSON.stringify(o)).join('\n') + '\n'; }
    const st = fresh(init);
    const before = filesOf(st);
    const out = CL.load(st, id);
    g.add('load', [before, id], { conv: out, files: filesOf(st), meta: CL.loadMeta(st, id), ids: CL.listConvIds(st), legacy: CL.exportLegacy(st, id) });
  }

  // ---- 3. commit 序列（新会话 / 旧格式会话；长序列触发 200 op 压缩） ----
  for (let s = 0; s < 12; s++) {
    const gen = makeGen(3000 + s);
    const id = 'K' + s;
    const steps = s === 0 ? 230 : gen.r.int(1, 25);
    const legacy = s % 2 === 1;
    const start = legacy ? legacyConv(gen, id) : { id, title: '新对话', providerId: 'deepseek', model: 'deepseek-chat', createdAt: 1700000000000, updatedAt: 1700000000000, messages: [] };
    const init = legacy ? { [CL.legacyKey(id)]: JSON.stringify(start) } : {};
    const st = fresh(init);
    const before = filesOf(st);
    let conv = legacy ? CL.load(st, id) : JSON.parse(JSON.stringify(start));
    const seq = [], results = [];
    for (let i = 0; i < steps; i++) {
      if (s === 0 && i > 8) { // 长序列：只做小改动，保持体积，专测 200 op 压缩
        const k = gen.r.int(0, 3);
        if (k === 0) conv.title = 'T' + i; else if (k === 1) conv.affect = { v: i };
        else if (k === 2 && conv.messages.length) conv.messages[0].content = 'edit ' + i; else conv.updatedAt = 1700000000000 + i;
      } else mutate(gen, conv);
      const input = JSON.parse(JSON.stringify(conv));
      seq.push(input);
      const res = CL.commit(st, input);
      results.push(s === 0 && i % 50 !== 0 && i !== steps - 1 ? null : res);
      conv = JSON.parse(JSON.stringify(input));
    }
    CL.clearSessions();
    g.add('commit', [before, id, legacy, seq], { results, files: filesOf(st), reload: CL.load(st, id) });
  }
}
