// 工作流 C · M3 golden 导出：retrieval-core / knowledge / affect / charcard / worlds / autochar。
// 用法：node tests/golden-export/c-m3-domain.mjs [--check] [模块…]
// 输出：app/src/test/resources/golden/<module>/<fn>.jsonl[.gz]，每行 {"in":[…],"out":…}
// 时间与随机数固定：Date.now() = NOW，Math.random() = 0.5（uid = NOW.toString(36) + 'i'）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WWW = ROOT + '/app/src/main/assets/www';
const OUT = ROOT + '/app/src/test/resources/golden';
const CHECK = process.argv.includes('--check');
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('--'));
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
