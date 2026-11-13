// 工作流 C · M3 golden 导出：retrieval-core / knowledge / affect / charcard / worlds / autochar。
// 用法：node tests/golden-export/exporters/c/m3-domain.mjs [--check] [模块…]
// 输出：app/src/test/resources/golden/<module>/<fn>.jsonl[.gz]，每行 {"in":[…],"out":…}
// 时间与随机数固定：Date.now() = NOW，Math.random() = 0.5（uid = NOW.toString(36) + 'i'）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const WWW = ROOT + '/app/src/main/assets/www';
const OUT = ROOT + '/app/src/test/resources/golden';
const CHECK = process.argv.includes('--check');
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('--'));
process.env.TZ = 'Asia/Shanghai';   // affect 的本地自然日（Kotlin 测试 Affect.zone 同值）
export const NOW = 1763000000000;
Date.now = () => NOW;
Math.random = () => 0.5;

// localeCompare 记录：JVM 单测没有 ICU（Android 上 JsCollate 用 android.icu），导出所有被比较过的字符串在 ICU 下的名次，测试时按名次比较
const _lc = String.prototype.localeCompare; const COLL = {};
String.prototype.localeCompare = function (o, loc) { const k = loc || 'default'; const set = COLL[k] = COLL[k] || new Set(); set.add(String(this)); set.add(String(o)); return _lc.call(this, o, loc); };
function writeCollation() {
  for (const [k, set] of Object.entries(COLL)) {
    const loc = k === 'default' ? undefined : k;
    const arr = [...set].sort((a, b) => _lc.call(a, b, loc));
    const ranks = {}; let r = 0;
    arr.forEach((x, i) => { if (i && _lc.call(arr[i - 1], x, loc) !== 0) r++; ranks[x] = r; });
    const p = ROOT + '/app/src/test/resources/collate/' + k + '.json';
    const body = JSON.stringify(ranks);
    if (CHECK) { if (!fs.existsSync(p) || fs.readFileSync(p, 'utf8') !== body) { console.error('不一致：' + p); process.exitCode = 1; } continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body);
  }
}
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let rnd = mulberry32(20261114);
const ri = n => Math.floor(rnd() * n);
const pick = a => a[ri(a.length)];
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const files = {};
const rec = (mod, fn, input, out) => { (files[mod + '/' + fn] = files[mod + '/' + fn] || []).push(JSON.stringify({ in: input, out: out === undefined ? null : out })); };
/** 抛错时记 {throws: message}；V8 的 JSON.parse 文案统一为 <JSON> */
const normErr = e => (e instanceof SyntaxError ? '<JSON>' : String(e && e.message || e)).replace(/(解析失败：)(?!非对象$).*$/s, '$1<JSON>');
const safe = f => { try { return f(); } catch (e) { return { throws: normErr(e) }; } };
const want = m => !ONLY.length || ONLY.includes(m);

const WORDS = ['艾琳', '张燕', '林雾', '旧矿', '钟楼', '密道', '账本', '北境', '守卫', '钥匙', '地图', '雨夜', 'Arthur', 'Mira', 'sword', 'castle_2', 'key', 'Map', '红色外套', '摩托车', '客厅', '二楼卧室', '咖啡馆', '学校', '码头', '车库'];
const PUNCT = ['，', '。', '、', ' ', '\n', '；', '|', '/', ',', '！', '\t', '  ', '\u3000'];
function phrase(n) { let s = ''; for (let i = 0; i < n; i++) s += pick(WORDS) + (rnd() < 0.6 ? pick(PUNCT) : ''); return s; }

// ───────── retrieval-core ─────────
if (want('retrieval')) {
  const RC = require(WWW + '/retrieval-core.js');
  const texts = ['', '中', 'ABC def_1 中文分词测试', '单 字 段 落', '😀表情和 English mixed 123', null, 0, 42, ['a', null, 'b'], 'İstanbul ǅ'];
  for (let i = 0; i < 60; i++) texts.push(phrase(1 + ri(8)));
  texts.forEach(t => { rec('retrieval', 'grams', [t, null], RC.grams(t)); rec('retrieval', 'grams', [t, 1], RC.grams(t, 1)); rec('retrieval', 'grams', [t, 3], RC.grams(t, 3)); });
  for (let i = 0; i < 80; i++) {
    const a = rnd() < 0.2 ? '' : phrase(1 + ri(6)), b = rnd() < 0.3 ? a + phrase(ri(3)) : phrase(1 + ri(6));
    rec('retrieval', 'jaccard3', [a, b], RC.jaccard3(a, b));
  }
  for (let k = 0; k < 40; k++) {
    const docs = []; const n = 1 + ri(9);
    for (let i = 0; i < n; i++) docs.push({ id: 'd' + i, updatedAt: ri(3), title: phrase(1 + ri(2)), keywords: rnd() < 0.7 ? [pick(WORDS), pick(WORDS)] : [], content: phrase(ri(12)) });
    const fields = pick([['title', 'keywords', 'content'], ['content'], null]);
    const weights = pick([{ title: 4, keywords: 3, content: 1 }, null, { title: 0, content: 2 }]);
    const q = phrase(1 + ri(3));
    const idx = RC.buildIndex(docs, fields);
    const scores = docs.map(d => RC.bm25f(idx, q, d, weights));
    const k1 = pick([null, 2]), b = pick([null, 0.3]);
    const p2 = phrase(2);
    const scores2 = docs.map(d => RC.bm25f(idx, RC.addQuery(RC.buildQuery(q, 2), p2, 0.3), d, weights, k1, b));
    rec('retrieval', 'bm25f', [docs, fields, weights, q, k1, b, p2], { scores, scores2, N: idx.N, avgLen: idx.avgLen, df: idx.df });
    const cands = docs.map((d, i) => ({ id: d.id, score: rnd() < 0.1 ? 0 : rnd(), text: rnd() < 0.3 && i ? docs[0].content : d.content }));
    const lam = pick([null, 0.5, 1, 0]), maxN = pick([null, 2, 0, 20]);
    rec('retrieval', 'mmr', [cands, lam, maxN], RC.mmr(cands, lam, null, maxN).map(x => x.id));
    const budget = pick([0, 10, 40, 120, -5, 33.7, 1000]);
    rec('retrieval', 'pickByBudget', [cands, budget], RC.pickByBudget(cands, null, budget));
  }
}

// ───────── knowledge ─────────
if (want('knowledge')) {
  require(WWW + '/retrieval-core.js');
  const K = require(WWW + '/knowledge.js');
  const mkEntry = i => {
    const e = { id: rnd() < 0.9 ? 'e' + i : undefined, title: rnd() < 0.1 ? '' : phrase(1 + ri(2)), content: phrase(ri(10)) + (rnd() < 0.2 ? '\r\n第二行' : ''),
      keywords: pick([[pick(WORDS), ' ' + pick(WORDS) + ' '], pick(WORDS) + '，' + pick(WORDS) + ' ' + pick(WORDS), [], undefined, [null, '', 'x']]), tags: pick([['tag1'], [], undefined, 'notarray']),
      pinned: rnd() < 0.15, updatedAt: ri(5) * 1000, createdAt: rnd() < 0.5 ? 0 : 100 };
    return e;
  };
  const mkDoc = () => {
    const cats = [];
    const ids = ['housing', 'inventory', 'actions', 'locations', 'other', 'custom-1', '人物'];
    const nc = ri(6);
    for (let c = 0; c < nc; c++) {
      const entries = []; const ne = ri(6);
      for (let i = 0; i < ne; i++) entries.push(mkEntry(c * 10 + i));
      cats.push({ id: rnd() < 0.9 ? ids[c] : '', name: pick(['住宅', '', ' 物品 ', '地点', 'Zeta', 'alpha', '甲', '乙']), order: pick([c, 5 - c, undefined, 'x', 2]), entries });
    }
    return { worldId: pick(['w1', ' w2 ', '', 'w3']), updatedAt: ri(9), categories: cats };
  };
  const docs = [null, {}, { worldId: 'w' }, 'str', { worldId: 'w', categories: [] }];
  for (let i = 0; i < 50; i++) docs.push(mkDoc());
  docs.forEach(d => {
    rec('knowledge', 'normalizeDoc', [clone(d), 'fallback'], K.normalizeDoc(clone(d), 'fallback'));
    rec('knowledge', 'exportJSON', [clone(d), true], K.exportJSON(clone(d)));
    rec('knowledge', 'exportJSON', [clone(d), false], K.exportJSON(clone(d), false));
    rec('knowledge', 'exportNdjson', [clone(d)], K.exportNdjson(clone(d)));
    rec('knowledge', 'exportMarkdown', [clone(d)], K.exportMarkdown(clone(d)));
    rec('knowledge', 'listEntries', [clone(d), null], K.listEntries(clone(d)));
    rec('knowledge', 'listEntries', [clone(d), 'housing'], K.listEntries(clone(d), 'housing'));
  });
  ['a, b，c、d  e', ['x', ' y ', null, 3], 5, null, ''].forEach(k => rec('knowledge', 'normalizeKeywords', [k], K.normalizeKeywords(k)));
  ['A b,c；d|e/f', '', null, '中文 查询，测试'].forEach(q => rec('knowledge', 'tokenize', [q], K.tokenize(q)));
  // 检索与注入
  for (let i = 0; i < 70; i++) {
    const d = K.normalizeDoc(mkDoc(), 'w');
    const q = rnd() < 0.1 ? '' : phrase(1 + ri(3));
    const opt = pick([{}, { limit: 3 }, { mode: 'legacy' }, { mode: 'legacy', limit: 2 }, { expand: { context: phrase(2), scene: phrase(1), l1: phrase(1) } }]);
    K.resetIndexCache(); rec('knowledge', 'search', [clone(d), q, opt], K.search(clone(d), q, opt));
    const sopt = pick([{}, { budget: 60 }, { budget: 5000, maxBudget: 300 }, { budget: -3 }, { budget: 200, lambda: 0.3, alreadyTexts: d.categories.length && d.categories[0].entries.length ? [d.categories[0].entries[0].title + '\n' + d.categories[0].entries[0].content] : [] }]);
    K.resetIndexCache(); rec('knowledge', 'selectForInject', [clone(d), q, sopt], K.selectForInject(clone(d), q, sopt));
  }
  // 注入文本
  const hitsList = [[], null, [{ categoryName: '地点', entry: { title: '钟楼', content: '城中心' } }, { categoryId: 'x', entry: { title: 'T' } }, { entry: {} }]];
  hitsList.forEach(h => rec('knowledge', 'renderInjection', [h], K.renderInjection(h)));
  const contents = ['', '正文', 'A\n[MEMORY_UPDATE]\nm1  \n[CURRENT_STATE]\ns', 'A\n[MEMORY_UPDATE]\nm1\n\n', 'A\n[MEMORY_UPDATE]\nm\n[X]\ny', 'pre  \n\n[CURRENT_STATE]\nnow', null];
  contents.forEach(c => ['', 'INJ'].forEach(inj => rec('knowledge', 'spliceIntoUserContent', [c, inj], K.spliceIntoUserContent(c, inj))));
  // CRUD
  for (let i = 0; i < 40; i++) {
    const d = K.normalizeDoc(mkDoc(), 'w'); const cat = d.categories[ri(d.categories.length)]; const ent = cat.entries[0];
    const op = pick(['addCategory', 'updateCategory', 'removeCategory', 'reorderCategories', 'addEntry', 'updateEntry', 'removeEntry', 'setPinned']);
    let args;
    switch (op) {
      case 'addCategory': args = [pick([{ name: '新分类' }, { id: 'housing' }, { id: 'zz', name: '  ' }, null])]; break;
      case 'updateCategory': args = [pick([cat.id, 'nope']), pick([{ name: ' 改名 ' }, { order: -1 }, { order: 99, name: '' }, null])]; break;
      case 'removeCategory': args = [pick([cat.id, 'nope'])]; break;
      case 'reorderCategories': args = [d.categories.map(c => c.id).reverse().slice(0, ri(4)).concat(['ghost'])]; break;
      case 'addEntry': args = [pick([cat.id, 'nope']), pick([{ title: ' 新 ', content: 'a\r\nb', keywords: 'k1,k2' }, { id: ent ? ent.id : 'e1' }, null])]; break;
      case 'updateEntry': args = [cat.id, ent ? ent.id : 'nope', pick([{ title: 'T2', content: 'c\r\n', keywords: ['z'], tags: ['t'], pinned: true }, { pinned: 'yes' }, null])]; break;
      case 'removeEntry': args = [cat.id, ent ? ent.id : 'nope']; break;
      case 'setPinned': args = [cat.id, ent ? ent.id : 'nope', rnd() < 0.5]; break;
    }
    const now = pick([5000, undefined]);
    rec('knowledge', 'crud', [op, clone(d), clone(args), now ?? null], safe(() => K[op](clone(d), ...clone(args), now)));
  }
  // 导入
  const imports = [
    '', '   ', 'random text', '{"categories":[{"id":"housing","entries":[{"title":"A","content":"x"}]}],"worldId":" w9 "}',
    '[{"id":"other","entries":[{"id":"e1","title":"T"}]}]', '[{"title":"a","category":"locations"},{"title":"b","categoryName":"新地方","pinned":"是"}]',
    '{"title":"one","content":"c","tags":"x, y"}', '{"title":"a"}\n{"title":"b","category_id":"actions"}\n// c\n# d\n', '{"a":1}\n[1]\n',
    '{"title":"a"}\n{bad json}\n', '\uFEFF## housing\n### 客厅\nkeywords: 沙发，电视\ntags: a b\npinned: yes\nid: e-x\n\n正文第一行\n\n第二段\n### 无元数据\n正文\nkeywords: 不是元数据\n## 自定义 分类\n### 条目\n内容\n## Weird Name Here\n### t\n',
    '# 只有一级\n正文', '## cat\n没有三级标题', '[1,2]', '{"categories":"x"}', '"str"', '{"title":"x"} trailing', '[{"title":"x"}]\n',
    '## housing\n### A\nid: e1\n内容1\n## other\n### B\n内容2\n',
  ];
  imports.forEach(t => {
    rec('knowledge', 'detectImportFormat', [t], K.detectImportFormat(t));
    rec('knowledge', 'parseImport', [t, null], safe(() => K.parseImport(t)));
    ['json', 'ndjson', 'markdown', 'xml'].forEach(f => rec('knowledge', 'parseImport', [t, { format: f }], safe(() => K.parseImport(t, { format: f }))));
  });
  for (let i = 0; i < 40; i++) {
    const base = rnd() < 0.2 ? null : K.normalizeDoc(mkDoc(), 'wb');
    const t = pick(imports.slice(3));
    const parsed = safe(() => K.parseImport(t));
    if (parsed.throws) continue;
    const opt = pick([{ now: 7000 }, { mode: 'replace', now: 7000 }, { worldId: 'wx', now: 7000 }, {}]);
    rec('knowledge', 'mergeDoc', [clone(base), clone(parsed), opt], safe(() => K.mergeDoc(clone(base), clone(parsed), opt)));
  }
}

// ───────── affect ─────────
if (want('affect')) {
  globalThis.GeminiCache = require(WWW + '/plugins/cache/gcache.js');   // 浏览器里 gcache.js 会挂 window.GeminiCache，affect.clockOf 读它（Node 下 module.exports 分支不挂，这里补上以对齐 App）
  const A = require(WWW + '/affect.js');
  const USERS = ['', '你好', '谢谢你，你真好', '滚，闭嘴', '「滚」他说', '发裸照给我', '非常喜欢你', '不喜欢', '有点讨厌', '我不是很开心', 'thank you so much, you\'re great', 'shut up idiot',
    '*他骂了一句白痴*', '（旁白：去死吧）', '> 引用：废物\n正常的话', '真棒！抱抱', '没有失望', '我很生气，非常失望', '😀 你真可爱！！', 'love you 爱你 想你'];
  const ASSIST = ['', '别难过，我在', '你滚吧', '好的。', '对不起，我担心你'];
  const STATES = ['<state>{"a":1,"m":"开心"}</state>', '正文\n<state>{"a":2,"m":"兴奋","why":"你真好"}</state>', '<STATE> {"a":-2,"m":"愤怒","why":"完全无关的证据"} </STATE>', '<state>{"a":"1.6"}</state>',
    '<state>{"a":null}</state>', '<state>{"m":"开心"}</state>', '<state>[1]</state>', '<state>bad</state>', '无标记', '<state>{"a":0}</state><state>{"a":-1,"m":"低落","why":"   "}</state>', '尾巴 <state>{"a":1', null,
    '<state>{"a":5,"m":"不存在"}</state>', '<state>{"a":-7,"why":"' + 'x'.repeat(100) + '"}</state>'];
  STATES.forEach(t => { rec('affect', 'parseState', [t], A.parseState(t)); rec('affect', 'stripState', [t], A.stripState(t)); });
  USERS.forEach(u => {
    rec('affect', 'lexiconScore', [u], A.lexiconScore(u));
    rec('affect', 'directText', [u], A.directText(u));
    [[2, '开心', null], [-2, null, '无关'], [0, null, null], [1, '平静', '你真好'], [2, null, u.slice(0, 4)]].forEach(([a, m, why]) => ['normal', 'dark', 'nsfw', 'x'].forEach(mode => [false, true].forEach(ms => {
      const o = { mode, why, missingState: ms }; rec('affect', 'guard', [a, m, u, o], A.guard(a, m, u, o)); })));
    ASSIST.forEach(t => [-2, -1, 0, 1, 2].forEach(a => [null, '低落', '开心'].forEach(m => rec('affect', 'checkConsistency', [t, a, m], A.checkConsistency(t, a, m)))));
    ['你真好', ' 滚 ', '谢 谢', '完全不相干', '', '！！'].forEach(w => { rec('affect', 'jaccard', [w, u], A.jaccard(w, u)); rec('affect', 'locateWhy', [w, u], A.locateWhy(w, u)); });
  });
  for (let x = -2.5; x <= 2.5; x += 0.125) { rec('affect', 'deltaFromA', [x], A.deltaFromA(x)); rec('affect', 'affToX', [(x + 2.5) / 5], A.affToX((x + 2.5) / 5)); }
  rec('affect', 'affToX', [null], A.affToX(null));
  for (let i = 0; i < 40; i++) {
    const vec = { val: rnd() * 2 - 1, aro: rnd() }, prev = pick([null, ...A.MOODS, 'x']);
    rec('affect', 'classify', [vec, prev], A.classify(vec, prev));
    const kf = pick([null, { x: rnd() * 4 - 2, K: rnd() }, { x: NaN }, {}]);
    const md = pick([null, ...A.MOODS]); rec('affect', 'vecStepKf', [vec, md, kf && JSON.parse(JSON.stringify(kf))], A.vecStepKf(vec, md, kf));
  }
  // 衰减
  const st0 = { v: 1, aff: 0.8, vec: { val: 0.6, aro: 0.7 }, mood: '兴奋', ts: NOW - 7200 * 1000, turn: 3 };
  [[st0, NOW, {}], [st0, NOW, { clock: 'turn', turn: 20 }], [st0, NOW, { clock: 'turn' }], [null, NOW, { clock: 'turn', turn: 5 }], [null, NOW, {}], [{ aff: null, ts: 0 }, NOW, {}], [{ vec: null, turn: 2 }, NOW, { clock: 'turn', turn: 1 }]]
    .forEach(([s, n, o]) => rec('affect', 'decay', [s, n, o], A.decay(s, n, o)));
  // KF / CUSUM 全序列 + step 链（wall / turn × kf / legacy）
  for (let k = 0; k < 24; k++) {
    let x = null, cu = null; const ys = [];
    for (let i = 0; i < 30; i++) ys.push(pick([2, 1.5, -2, -1, 0, 0.3, 3]) * (k % 2 ? 1 : -1) * (rnd() < 0.2 ? -1 : 1));
    const kfs = [], cus = [];
    ys.forEach(y => { x = A.kfUpdate(x, y, 0.3); kfs.push(x); cu = A.cusumUpdate(cu, x.x, 0.3); cus.push(cu); });
    rec('affect', 'kfCusumSeq', [ys], { kfs, cus });
  }
  for (let k = 0; k < 30; k++) {
    const opts = Object.assign(pick([{}, { clock: 'turn' }, { estimator: 'legacy' }, { estimator: 'legacy', clock: 'turn' }, { settings: { affectKf: false } }, { mode: 'dark' }, { conv: { affectEstimator: 'legacy' } }]));
    let prev = pick([null, undefined]); const steps = []; let t = NOW;
    for (let i = 0; i < 25; i++) {
      t += pick([1000, 60000, 3600000, 86400000, 5 * 86400000]);
      const raw = pick(STATES); const parsed = A.parseState(raw); const u = pick(USERS);
      const o = Object.assign({}, opts, { assistantText: pick(ASSIST) }, rnd() < 0.2 ? { turn: i * 2 } : {});
      const nx = A.step(prev, parsed, u, t, o);
      steps.push({ parsed, u, t, o, out: nx });
      prev = nx;
    }
    rec('affect', 'stepChain', [steps.map(s => ({ parsed: s.parsed, u: s.u, t: s.t, o: s.o }))], steps.map(s => s.out));
  }
  [null, { kf: { x: 0.123, P: 0.5 } }, { kf: { x: -1, P: 0.01 }, g: { yT: 1, yModel: 2, yLex: -0.5, w: 0.65, robust: true } }].forEach(s => rec('affect', 'formatKfHint', [s], A.formatKfHint(s)));
  [null, { cusum: { tier: 3, sp: 0.456 } }, { cusum: { dwell: 2, sm: 1 } }].forEach(s => rec('affect', 'formatCusumHint', [s], A.formatCusumHint(s)));
  [[null, null], [{ aff: 0.9, vec: { val: 0.5, aro: 0.5 }, mood: '开心', x: 1 }, null], [null, { mood: '低落' }], [{ aff: 0.9, vec: { val: 0.5, aro: 0.5 }, mood: '开心' }, { aff: 0.1, vec: { val: -0.6, aro: 0.15 } }], [{ mood: '平静' }, {}]]
    .forEach(([o, s]) => rec('affect', 'blendAffect', [o, s], A.blendAffect(o, s)));
  [null, {}, { affectMode: 'dark' }, { affectMode: 'bad', tags: ['NSFW'] }, { personaTags: ['暗黑'] }, { charCard: { tags: ['R18'] } }, { tags: 'dark' }, { tags: [null, 1] }].forEach(c => rec('affect', 'modeOf', [c], A.modeOf(c)));
  [[null, null], [{ affectClock: 'wall' }, { rp: {} }], [{}, { rp: {} }], [{}, { rp: { skipped: true } }], [{ plugins: { rpcache: {} } }, null], [{ systemPrompt: '【世界观】长设定\n【角色卡】x', messages: [] }, null], [{ personaId: 'p1' }, null]]
    .forEach(([c, m]) => rec('affect', 'clockOf', [c, m], A.clockOf(c, m)));
  [[null, null], [{ affectEstimator: 'legacy' }, null], [{ affectKf: false }, { affectEstimator: 'kf' }], [{}, { affectKf: false }], [{ affectEstimator: 'x' }, {}]].forEach(([c, s]) => rec('affect', 'estimatorOf', [c, s], A.estimatorOf(c, s)));
}

// ───────── 交给 B 的边界用例（审查 (f)）：providers.js parseAffordTokens / downgradeMaxTokens 的极端输入；C 不跑，B 在 net/ 补对照 ─────────
if (want('b-handoff')) {
  const P = require(WWW + '/providers.js');
  const texts = [null, undefined, '', 'null', 'can only afford 238793', 'You can only afford 0 tokens', 'CAN ONLY AFFORD\u00a0512', 'can only afford\u3000777', 'can only afford\u2028 9',
    'can only afford\ufeff10', 'can only afford\t\n 42 tokens', 'can only afford 99999999999999999999', 'can only afford 9007199254740993', 'can only afford 123456789012345678901234567890',
    'can only afford -5', 'can only afford 1e3', 'can only afford ١٢٣', '{"error":{"code":402,"message":"This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 2380."}}'];
  texts.forEach(t => { const r = P.parseAffordTokens(t); rec('b-handoff', 'parseAffordTokens', [t === undefined ? null : t], r); if (r != null) rec('b-handoff', 'downgradeMaxTokens', [r, null], P.downgradeMaxTokens(r)); });
  [[0, null], [-1, null], [null, null], ['300', null], [319, null], [320, null], [1e21, null], [500, { min: 600 }], [5000, { min: 0 }], [5000, { min: 1.9 }]].forEach(([a, o]) => rec('b-handoff', 'downgradeMaxTokens', [a, o], P.downgradeMaxTokens(a, o)));
}

// ───────── 写出 ─────────
if (!ONLY.length) writeCollation();
let total = 0, nfiles = 0, bad = 0;
for (const [k, lines] of Object.entries(files)) {
  const body = lines.join('\n') + '\n';
  const gz = body.length > 256 * 1024;
  const p = OUT + '/' + k + '.jsonl' + (gz ? '.gz' : '');
  total += lines.length; nfiles++;
  if (CHECK) { const old = fs.existsSync(p) ? (gz ? zlib.gunzipSync(fs.readFileSync(p)).toString() : fs.readFileSync(p, 'utf8')) : null; if (old !== body) { bad++; console.error('不一致：' + p); } continue; }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, gz ? zlib.gzipSync(body, { level: 9 }) : body);
}
console.log((CHECK ? '[check] ' : '') + nfiles + ' 个文件，' + total + ' 条向量' + (CHECK && bad ? '，' + bad + ' 个不一致' : ''));
if (CHECK && bad) process.exit(1);
