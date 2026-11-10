/* 本地资料库（按世界隔离）：纯 CRUD + 关键词检索，可在 Node 单测里 require。
 * 存储键：knowledge_world_<worldId>.json；阶段 2：BM25F 检索 + 可选注入。 */
(function (root) {
  'use strict';

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const DEFAULT_CATEGORY_DEFS = [
    { id: 'housing', name: '住宅布局', order: 0 },
    { id: 'inventory', name: '物品/衣服/车辆', order: 1 },
    { id: 'actions', name: '做过的事', order: 2 },
    { id: 'locations', name: '地点', order: 3 },
    { id: 'other', name: '其他', order: 4 },
  ];

  function storeKey(worldId) {
    return 'knowledge_world_' + String(worldId || '').trim() + '.json';
  }

  function emptyCategories() {
    return DEFAULT_CATEGORY_DEFS.map(d => ({
      id: d.id,
      name: d.name,
      order: d.order,
      entries: [],
    }));
  }

  function normalizeKeywords(raw) {
    if (Array.isArray(raw)) {
      return raw.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    }
    if (typeof raw === 'string') {
      return raw.split(/[,，、\s]+/).map(s => s.trim()).filter(Boolean);
    }
    return [];
  }

  function normalizeTags(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
  }

  function normalizeEntry(e, now) {
    e = e || {};
    const t = now || Date.now();
    return {
      id: e.id || ('e-' + uid()),
      title: String(e.title == null ? '' : e.title).trim(),
      content: String(e.content == null ? '' : e.content).replace(/\r\n/g, '\n'),
      keywords: normalizeKeywords(e.keywords),
      tags: normalizeTags(e.tags),
      pinned: !!e.pinned,
      updatedAt: e.updatedAt || 0,
      createdAt: e.createdAt || 0,
      _now: undefined,
    };
  }

  function normalizeCategory(c, idx) {
    c = c || {};
    const entries = Array.isArray(c.entries) ? c.entries.map(e => {
      const n = normalizeEntry(e);
      delete n._now;
      return n;
    }) : [];
    return {
      id: String(c.id || ('cat-' + uid())).trim() || ('cat-' + uid()),
      name: String(c.name == null ? '' : c.name).trim() || '未命名分类',
      order: typeof c.order === 'number' && isFinite(c.order) ? c.order : (idx | 0),
      entries,
    };
  }

  function emptyDoc(worldId) {
    return {
      worldId: String(worldId || ''),
      updatedAt: 0,
      categories: emptyCategories(),
    };
  }

  function normalizeDoc(raw, worldId) {
    const wid = String((raw && raw.worldId) || worldId || '').trim();
    if (!wid) return emptyDoc('');
    if (!raw || typeof raw !== 'object') return emptyDoc(wid);
    let cats = Array.isArray(raw.categories) ? raw.categories.map(normalizeCategory) : [];
    if (!cats.length) cats = emptyCategories();
    cats.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh'));
    cats.forEach((c, i) => { c.order = i; });
    return {
      worldId: wid,
      updatedAt: raw.updatedAt || 0,
      categories: cats,
    };
  }

  function touch(doc, now) {
    doc.updatedAt = now || Date.now();
    return doc;
  }

  function cloneDoc(doc) {
    return JSON.parse(JSON.stringify(doc));
  }

  function findCategory(doc, categoryId) {
    return (doc.categories || []).find(c => c.id === categoryId) || null;
  }

  function findEntry(doc, categoryId, entryId) {
    const cat = findCategory(doc, categoryId);
    if (!cat) return null;
    const entry = (cat.entries || []).find(e => e.id === entryId) || null;
    return entry ? { category: cat, entry } : null;
  }

  function sortEntries(list) {
    return (list || []).slice().sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.title).localeCompare(String(b.title), 'zh');
    });
  }

  /** 读取；不存在则返回带默认分类的空文档（不写盘） */
  function load(store, worldId) {
    const wid = String(worldId || '').trim();
    if (!wid) return emptyDoc('');
    const key = storeKey(wid);
    const raw = store && store.get ? store.get(key, null) : null;
    if (!raw) return emptyDoc(wid);
    return normalizeDoc(raw, wid);
  }

  function save(store, doc) {
    if (!store || !store.set) throw new Error('store 不可用');
    const n = normalizeDoc(doc, doc && doc.worldId);
    if (!n.worldId) throw new Error('缺少 worldId');
    store.set(storeKey(n.worldId), n);
    return n;
  }

  function ensure(store, worldId, now) {
    const wid = String(worldId || '').trim();
    if (!wid) throw new Error('缺少 worldId');
    const key = storeKey(wid);
    const raw = store.get(key, null);
    if (raw) return normalizeDoc(raw, wid);
    const doc = touch(emptyDoc(wid), now || Date.now());
    return save(store, doc);
  }

  function addCategory(doc, patch, now) {
    const d = cloneDoc(normalizeDoc(doc, doc.worldId));
    const t = now || Date.now();
    const cat = normalizeCategory(Object.assign({}, patch, {
      id: (patch && patch.id) || ('cat-' + uid()),
      order: d.categories.length,
      entries: [],
    }), d.categories.length);
    if (d.categories.some(c => c.id === cat.id)) throw new Error('分类 id 已存在：' + cat.id);
    d.categories.push(cat);
    return touch(d, t);
  }

  function updateCategory(doc, categoryId, patch, now) {
    const d = cloneDoc(normalizeDoc(doc, doc.worldId));
    const cat = findCategory(d, categoryId);
    if (!cat) throw new Error('分类不存在：' + categoryId);
    if (patch && patch.name != null) cat.name = String(patch.name).trim() || cat.name;
    if (patch && typeof patch.order === 'number' && isFinite(patch.order)) cat.order = patch.order;
    d.categories.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh'));
    d.categories.forEach((c, i) => { c.order = i; });
    return touch(d, now || Date.now());
  }

  function removeCategory(doc, categoryId, now) {
    const d = cloneDoc(normalizeDoc(doc, doc.worldId));
    const before = d.categories.length;
    d.categories = d.categories.filter(c => c.id !== categoryId);
    if (d.categories.length === before) throw new Error('分类不存在：' + categoryId);
    d.categories.forEach((c, i) => { c.order = i; });
    return touch(d, now || Date.now());
  }

  /** orderedIds：完整或不完整的 id 列表；未出现的分类排到末尾保持相对顺序 */
  function reorderCategories(doc, orderedIds, now) {
    const d = cloneDoc(normalizeDoc(doc, doc.worldId));
    const map = new Map(d.categories.map(c => [c.id, c]));
    const out = [];
    (orderedIds || []).forEach(id => {
      if (map.has(id)) { out.push(map.get(id)); map.delete(id); }
    });
    d.categories.forEach(c => { if (map.has(c.id)) out.push(c); });
    out.forEach((c, i) => { c.order = i; });
    d.categories = out;
    return touch(d, now || Date.now());
  }

  function addEntry(doc, categoryId, patch, now) {
    const d = cloneDoc(normalizeDoc(doc, doc.worldId));
    const cat = findCategory(d, categoryId);
    if (!cat) throw new Error('分类不存在：' + categoryId);
    const t = now || Date.now();
    const entry = normalizeEntry(Object.assign({}, patch, {
      id: (patch && patch.id) || ('e-' + uid()),
      createdAt: (patch && patch.createdAt) || t,
      updatedAt: t,
    }), t);
    delete entry._now;
    if (cat.entries.some(e => e.id === entry.id)) throw new Error('条目 id 已存在：' + entry.id);
    cat.entries.push(entry);
    return touch(d, t);
  }

  function updateEntry(doc, categoryId, entryId, patch, now) {
    const d = cloneDoc(normalizeDoc(doc, doc.worldId));
    const hit = findEntry(d, categoryId, entryId);
    if (!hit) throw new Error('条目不存在：' + entryId);
    const t = now || Date.now();
    const e = hit.entry;
    if (patch) {
      if (patch.title != null) e.title = String(patch.title).trim();
      if (patch.content != null) e.content = String(patch.content).replace(/\r\n/g, '\n');
      if (patch.keywords != null) e.keywords = normalizeKeywords(patch.keywords);
      if (patch.tags != null) e.tags = normalizeTags(patch.tags);
      if (typeof patch.pinned === 'boolean') e.pinned = patch.pinned;
    }
    e.updatedAt = t;
    if (!e.createdAt) e.createdAt = t;
    return touch(d, t);
  }

  function removeEntry(doc, categoryId, entryId, now) {
    const d = cloneDoc(normalizeDoc(doc, doc.worldId));
    const cat = findCategory(d, categoryId);
    if (!cat) throw new Error('分类不存在：' + categoryId);
    const before = cat.entries.length;
    cat.entries = cat.entries.filter(e => e.id !== entryId);
    if (cat.entries.length === before) throw new Error('条目不存在：' + entryId);
    return touch(d, now || Date.now());
  }

  function setPinned(doc, categoryId, entryId, pinned, now) {
    return updateEntry(doc, categoryId, entryId, { pinned: !!pinned }, now);
  }

  function tokenize(q) {
    return String(q || '')
      .toLowerCase()
      .split(/[\s,，、;；|/]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function entryHaystack(e) {
    return [
      e.title || '',
      e.content || '',
      (e.keywords || []).join(' '),
      (e.tags || []).join(' '),
    ].join('\n').toLowerCase();
  }

  /**
   * 检索：默认 BM25F（title/keywords/tags/content 加权）+ 置顶加权；
   * opt.mode==='legacy' 时回退子串 AND。
   * 返回 [{ categoryId, categoryName, entry, score }]
   */
  function searchLegacy(doc, query, opt) {
    const d = normalizeDoc(doc, doc && doc.worldId);
    const tokens = tokenize(query);
    const limit = (opt && opt.limit) || 50;
    const out = [];
    d.categories.forEach(cat => {
      (cat.entries || []).forEach(entry => {
        const hay = entryHaystack(entry);
        let score = 0;
        if (tokens.length) {
          let ok = true;
          tokens.forEach(tok => {
            if (hay.indexOf(tok) < 0) ok = false;
            else {
              const kwHit = (entry.keywords || []).some(k => String(k).toLowerCase().indexOf(tok) >= 0);
              const titleHit = String(entry.title || '').toLowerCase().indexOf(tok) >= 0;
              score += kwHit ? 5 : titleHit ? 3 : 1;
            }
          });
          if (!ok) return;
        } else {
          score = entry.pinned ? 1 : 0;
        }
        if (entry.pinned) score += 10;
        out.push({ categoryId: cat.id, categoryName: cat.name, entry, score });
      });
    });
    out.sort((a, b) => b.score - a.score || (b.entry.updatedAt || 0) - (a.entry.updatedAt || 0));
    return out.slice(0, limit);
  }

  const KB_WEIGHTS = { title: 4.0, keywords: 3.0, tags: 2.0, content: 1.0 };
  const KB_FIELDS = ['title', 'keywords', 'tags', 'content'];

  function core() {
    return (typeof root !== 'undefined' && root.RetrievalCore) || (typeof globalThis !== 'undefined' && globalThis.RetrievalCore) || null;
  }

  function flattenEntries(doc) {
    const d = normalizeDoc(doc, doc && doc.worldId);
    const out = [];
    d.categories.forEach(cat => {
      (cat.entries || []).forEach(entry => {
        out.push({
          id: entry.id,
          title: entry.title || '',
          keywords: entry.keywords || [],
          tags: entry.tags || [],
          content: entry.content || '',
          pinned: !!entry.pinned,
          updatedAt: entry.updatedAt || 0,
          categoryId: cat.id,
          categoryName: cat.name,
          categoryOrder: cat.order | 0,
          entry,
        });
      });
    });
    return out;
  }

  // 惰性索引：同一文档签名命中时复用 buildIndex 的 prev 短路
  let _kbIndex = null;
  function searchBM25(doc, query, opt) {
    const RC = core();
    if (!RC) return searchLegacy(doc, query, opt);
    const limit = (opt && opt.limit) || 50;
    const docs = flattenEntries(doc);
    if (!docs.length) return [];
    const idx = RC.buildIndex(docs, KB_FIELDS, (opt && opt.index) || _kbIndex);
    _kbIndex = idx;
    if (opt && opt.onIndex) opt.onIndex(idx);
    const Q = RC.buildQuery(query || '');
    if (opt && opt.expand) {
      if (opt.expand.context) RC.addQuery(Q, opt.expand.context, 0.3);
      if (opt.expand.scene) RC.addQuery(Q, opt.expand.scene, 0.3);
      if (opt.expand.l1) RC.addQuery(Q, opt.expand.l1, 0.2);
    }
    // 重加权：主查询 0.5 已在 buildQuery(1) 里，这里把主查询再乘 0.5 等价于报告的 0.5/0.3/0.2
    // 简化：主 query 权重保持 1，expand 已按比例加
    const scored = docs.map(d => {
      let s = RC.bm25f(idx, Q, d, KB_WEIGHTS);
      if (d.pinned) s += 1e6; // 置顶无条件优先（仍受后续预算约束）
      return { categoryId: d.categoryId, categoryName: d.categoryName, entry: d.entry, score: s, _doc: d };
    }).filter(x => x.score > 0 || (x.entry && x.entry.pinned));
    scored.sort((a, b) => b.score - a.score || (a._doc.categoryOrder - b._doc.categoryOrder) || ((b.entry.updatedAt || 0) - (a.entry.updatedAt || 0)));
    return scored.slice(0, limit).map(({ categoryId, categoryName, entry, score }) => ({ categoryId, categoryName, entry, score }));
  }

  function search(doc, query, opt) {
    const mode = (opt && opt.mode) || 'bm25';
    if (mode === 'legacy') return searchLegacy(doc, query, opt);
    return searchBM25(doc, query, opt);
  }

  /**
   * 阶段 2 注入选型：BM25 top20 → pinned 入列 → 3-gram 去重 → MMR → token 预算。
   * opt: { budget=400, maxBudget=1200, alreadyTexts=[], expand, lambda }
   * 返回 { hits:[{entry,categoryId,categoryName,score,tokens}], trace }
   */
  function selectForInject(doc, query, opt) {
    const o = opt || {};
    let budget = o.budget != null ? o.budget | 0 : 400;
    const maxB = o.maxBudget != null ? o.maxBudget | 0 : 1200;
    if (budget > maxB) budget = maxB;
    if (budget < 0) budget = 0;
    const RC = core();
    const raw = search(doc, query, Object.assign({}, o, { limit: 20, mode: 'bm25' }));
    const dropped = [];
    const already = (o.alreadyTexts || []).map(String);
    const cands = [];
    // pinned 无条件入列（仍受预算）
    const d = normalizeDoc(doc, doc && doc.worldId);
    const pinned = [];
    d.categories.forEach(cat => {
      (cat.entries || []).forEach(e => {
        if (e.pinned) pinned.push({ categoryId: cat.id, categoryName: cat.name, entry: e, score: 1e6 });
      });
    });
    const seen = new Set();
    function consider(h, reasonIfDup) {
      if (!h || !h.entry || seen.has(h.entry.id)) return;
      const text = (h.entry.title || '') + '\n' + (h.entry.content || '');
      if (RC) {
        for (const a of already) {
          if (RC.jaccard3(text, a) > 0.6) {
            dropped.push({ id: h.entry.id, reason: 'dup' });
            return;
          }
        }
        for (const c of cands) {
          const ct = (c.entry.title || '') + '\n' + (c.entry.content || '');
          if (RC.jaccard3(text, ct) > 0.6) {
            dropped.push({ id: h.entry.id, reason: 'dup' });
            return;
          }
        }
      }
      seen.add(h.entry.id);
      cands.push({
        id: h.entry.id,
        score: h.score || 0,
        text,
        categoryId: h.categoryId,
        categoryName: h.categoryName,
        entry: h.entry,
      });
    }
    pinned.forEach(p => consider(p));
    raw.forEach(h => {
      if (h.score <= 0 && !(h.entry && h.entry.pinned)) {
        dropped.push({ id: h.entry.id, reason: 'lowscore' });
        return;
      }
      consider(h);
    });
    // 归一化分数供 MMR
    const maxS = Math.max(1e-9, ...cands.map(c => c.score));
    cands.forEach(c => { c.score = c.score / maxS; });
    let ranked = cands;
    if (RC && cands.length) ranked = RC.mmr(cands, o.lambda != null ? o.lambda : 0.7, null, cands.length);
    const tokenOf = c => Math.ceil(String(c.entry.content || '').length * 0.7) + Math.ceil(String(c.entry.title || '').length * 0.5) + 8;
    const picked = RC ? RC.pickByBudget(ranked, tokenOf, budget) : ranked.slice(0, 5);
    // 被预算丢掉的
    const pickIds = new Set(picked.map(x => x.id || (x.entry && x.entry.id)));
    ranked.forEach(c => {
      if (!pickIds.has(c.id)) dropped.push({ id: c.id, reason: 'budget' });
    });
    // 按 category order 稳定排序
    picked.sort((a, b) => {
      const ao = (a.entry && a.categoryId) || a.categoryId;
      const bo = (b.entry && b.categoryId) || b.categoryId;
      const ca = d.categories.find(c => c.id === (a.categoryId));
      const cb = d.categories.find(c => c.id === (b.categoryId));
      return ((ca && ca.order) || 0) - ((cb && cb.order) || 0) || String(a.entry.title||'').localeCompare(String(b.entry.title||''));
    });
    const hits = picked.map(c => ({
      entry: c.entry,
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      score: c.score,
      tokens: c.tokens != null ? c.tokens : tokenOf(c),
    }));
    const tokens = hits.reduce((s, h) => s + (h.tokens || 0), 0);
    return {
      hits,
      trace: { hitIds: hits.map(h => h.entry.id), tokens, dropped, budget },
    };
  }

  function renderInjection(hits) {
    if (!hits || !hits.length) return '';
    const lines = hits.map(h => {
      const tag = h.categoryName || h.categoryId || '资料';
      const title = (h.entry && h.entry.title) || '';
      const body = (h.entry && h.entry.content) || '';
      return '- [' + tag + '] ' + title + (body ? '：' + body : '');
    });
    return '[LOCAL_KNOWLEDGE]（本地资料库 · 仅供参考，不要逐字复述）\n' + lines.join('\n');
  }

  /** 把 LOCAL_KNOWLEDGE 插到 MEMORY_UPDATE 与 CURRENT_STATE 之间；若无锚点则追加到末尾 */
  function spliceIntoUserContent(content, inj) {
    if (!inj) return content;
    const s = String(content || '');
    const stateAt = s.indexOf('[CURRENT_STATE]');
    if (stateAt >= 0) {
      return s.slice(0, stateAt).replace(/\s*$/, '') + '\n\n' + inj + '\n\n' + s.slice(stateAt);
    }
    const memAt = s.indexOf('[MEMORY_UPDATE]');
    if (memAt >= 0) {
      // 找到 MEMORY_UPDATE 块末尾（下一 [ 或结尾）
      const after = s.indexOf('\n[', memAt + 1);
      if (after < 0) return s.replace(/\s*$/, '') + '\n\n' + inj;
      return s.slice(0, after).replace(/\s*$/, '') + '\n\n' + inj + s.slice(after);
    }
    return (s ? s + '\n\n' : '') + inj;
  }

  function listEntries(doc, categoryId) {
    const d = normalizeDoc(doc, doc && doc.worldId);
    if (categoryId) {
      const cat = findCategory(d, categoryId);
      return cat ? sortEntries(cat.entries) : [];
    }
    const all = [];
    d.categories.forEach(cat => {
      (cat.entries || []).forEach(e => all.push(Object.assign({ categoryId: cat.id, categoryName: cat.name }, e)));
    });
    return sortEntries(all);
  }


  function slugifyCatId(name) {
    const s = String(name || '').trim().toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '')
      .slice(0, 48);
    return s || ('cat-' + uid());
  }

  function parseBoolish(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return !!v;
    const s = String(v == null ? '' : v).trim().toLowerCase();
    if (!s) return false;
    return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === '是' || s === '真';
  }

  /** 自动探测：json（整库）> ndjson/jsonl > markdown；失败返回 unknown */
  function detectImportFormat(text) {
    const s = String(text || '').replace(/^\uFEFF/, '').trim();
    if (!s) return 'empty';
    if (s[0] === '{') {
      try {
        const o = JSON.parse(s);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          if (Array.isArray(o.categories)) return 'json';
          if (o.title != null || o.content != null || o.categoryId != null || o.category != null) return 'ndjson';
        }
      } catch (_) { /* fallthrough */ }
    }
    if (s[0] === '[') {
      try {
        const a = JSON.parse(s);
        if (Array.isArray(a)) {
          if (a.length && a[0] && typeof a[0] === 'object' && Array.isArray(a[0].entries)) return 'json';
          return 'ndjson';
        }
      } catch (_) { /* fallthrough */ }
    }
    const lines = s.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
    if (lines.length) {
      let ok = 0;
      const sample = lines.slice(0, 30);
      sample.forEach(line => {
        try {
          const o = JSON.parse(line);
          if (o && typeof o === 'object' && !Array.isArray(o)) ok++;
        } catch (_) { /* skip */ }
      });
      if (ok > 0 && ok >= Math.ceil(sample.length * 0.7)) return 'ndjson';
    }
    if (/^#{1,3}\s+\S/m.test(s)) return 'markdown';
    return 'unknown';
  }

  function entryFromRaw(raw) {
    raw = raw || {};
    const catId = String(raw.categoryId || raw.category_id || '').trim();
    const catName = String(raw.categoryName || raw.category_name || '').trim();
    const categoryHint = catId || (raw.category != null ? String(raw.category).trim() : '');
    const entry = normalizeEntry({
      id: raw.id,
      title: raw.title,
      content: raw.content,
      keywords: raw.keywords,
      tags: typeof raw.tags === 'string' ? normalizeKeywords(raw.tags) : raw.tags,
      pinned: raw.pinned != null ? parseBoolish(raw.pinned) : false,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    });
    delete entry._now;
    return {
      categoryId: catId || '',
      categoryName: catName,
      categoryHint,
      entry,
    };
  }

  function parseJsonImport(text) {
    const s = String(text || '').replace(/^\uFEFF/, '').trim();
    const o = JSON.parse(s);
    if (Array.isArray(o)) {
      // 分类数组或条目数组
      if (o.length && o[0] && Array.isArray(o[0].entries)) {
        return { format: 'json', worldId: '', categories: o.map(normalizeCategory), entries: [] };
      }
      const entries = o.map(entryFromRaw);
      return { format: 'ndjson', worldId: '', categories: [], entries };
    }
    if (!o || typeof o !== 'object') throw new Error('JSON 根节点必须是对象或数组');
    if (Array.isArray(o.categories)) {
      return {
        format: 'json',
        worldId: String(o.worldId || '').trim(),
        categories: o.categories.map(normalizeCategory),
        entries: [],
        updatedAt: o.updatedAt || 0,
      };
    }
    // 单条条目对象
    return { format: 'ndjson', worldId: '', categories: [], entries: [entryFromRaw(o)] };
  }

  function parseNdjsonImport(text) {
    const s = String(text || '').replace(/^\uFEFF/, '').trim();
    // 也接受 JSON 数组
    if (s[0] === '[') {
      const a = JSON.parse(s);
      if (!Array.isArray(a)) throw new Error('NDJSON 数组根节点无效');
      return { format: 'ndjson', worldId: '', categories: [], entries: a.map(entryFromRaw) };
    }
    if (s[0] === '{' && !/\n/.test(s)) {
      // 可能是整库 JSON 被误判；若含 categories 则转交
      try {
        const o = JSON.parse(s);
        if (o && Array.isArray(o.categories)) return parseJsonImport(s);
        return { format: 'ndjson', worldId: '', categories: [], entries: [entryFromRaw(o)] };
      } catch (_) { /* fallthrough to lines */ }
    }
    const entries = [];
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t || t.startsWith('//') || t.startsWith('#')) return;
      try {
        const o = JSON.parse(t);
        if (o && typeof o === 'object' && !Array.isArray(o)) entries.push(entryFromRaw(o));
        else throw new Error('非对象');
      } catch (e) {
        throw new Error('NDJSON 第 ' + (i + 1) + ' 行解析失败：' + (e && e.message || e));
      }
    });
    if (!entries.length) throw new Error('NDJSON 没有有效条目');
    return { format: 'ndjson', worldId: '', categories: [], entries };
  }

  function parseMarkdownImport(text) {
    const s = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (!s.trim()) throw new Error('Markdown 为空');
    const lines = s.split('\n');
    let curCatId = '';
    let curCatName = '';
    let curTitle = '';
    let curMeta = { keywords: [], tags: [], pinned: false, id: '' };
    let body = [];
    const entries = [];
    const categoriesMeta = [];

    function flushEntry() {
      if (!curTitle && !body.some(l => String(l).trim())) {
        curTitle = ''; curMeta = { keywords: [], tags: [], pinned: false, id: '' }; body = [];
        return;
      }
      const content = body.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
      entries.push(entryFromRaw({
        id: curMeta.id || undefined,
        categoryId: curCatId,
        categoryName: curCatName,
        category: curCatId || curCatName,
        title: curTitle,
        content,
        keywords: curMeta.keywords,
        tags: curMeta.tags,
        pinned: curMeta.pinned,
      }));
      curTitle = '';
      curMeta = { keywords: [], tags: [], pinned: false, id: '' };
      body = [];
    }

    function parseCatHeader(rest) {
      const t = rest.trim();
      const m = t.match(/^([A-Za-z][\w-]*)\s+(.+)$/);
      if (m) return { id: m[1], name: m[2].trim() };
      if (/^[A-Za-z][\w-]*$/.test(t)) {
        const def = DEFAULT_CATEGORY_DEFS.find(d => d.id === t);
        return { id: t, name: def ? def.name : t };
      }
      return { id: '', name: t };
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const h2 = line.match(/^##\s+(.+)$/);
      const h3 = line.match(/^###\s+(.+)$/);
      if (h2) {
        flushEntry();
        const c = parseCatHeader(h2[1]);
        curCatId = c.id || slugifyCatId(c.name);
        curCatName = c.name || c.id;
        if (!categoriesMeta.some(x => x.id === curCatId)) {
          categoriesMeta.push({ id: curCatId, name: curCatName });
        }
        continue;
      }
      if (h3) {
        flushEntry();
        curTitle = h3[1].trim();
        curMeta = { keywords: [], tags: [], pinned: false, id: '' };
        body = [];
        continue;
      }
      if (curTitle) {
        const meta = line.match(/^(keywords|tags|pinned|id)\s*[:：]\s*(.*)$/i);
        if (meta && !body.some(l => String(l).trim())) {
          const key = meta[1].toLowerCase();
          const val = meta[2].trim();
          if (key === 'keywords') curMeta.keywords = normalizeKeywords(val);
          else if (key === 'tags') curMeta.tags = normalizeKeywords(val);
          else if (key === 'pinned') curMeta.pinned = parseBoolish(val);
          else if (key === 'id') curMeta.id = val;
          continue;
        }
        body.push(line);
      }
    }
    flushEntry();
    if (!entries.length) throw new Error('Markdown 没有解析到条目（需要 ### 标题）');
    return {
      format: 'markdown',
      worldId: '',
      categories: categoriesMeta.map((c, i) => normalizeCategory({ id: c.id, name: c.name, order: i, entries: [] }, i)),
      entries,
    };
  }

  /**
   * 解析导入文本。返回 { format, worldId, categories, entries, stats? }
   * format 可强制指定 'json'|'ndjson'|'markdown'；默认自动探测。
   */
  function parseImport(text, opt) {
    const forced = opt && opt.format;
    let format = forced || detectImportFormat(text);
    if (format === 'empty') throw new Error('内容为空');
    if (format === 'unknown') throw new Error('无法识别格式（支持原生 JSON / NDJSON / 紧凑 Markdown）');
    if (format === 'json') return parseJsonImport(text);
    if (format === 'ndjson') return parseNdjsonImport(text);
    if (format === 'markdown') return parseMarkdownImport(text);
    throw new Error('不支持的格式：' + format);
  }

  function ensureCategory(doc, categoryId, categoryName, now) {
    let id = String(categoryId || '').trim();
    let name = String(categoryName || '').trim();
    if (!id && name) {
      const byName = doc.categories.find(c => c.name === name);
      if (byName) return byName;
      id = slugifyCatId(name);
    }
    if (!id) id = 'other';
    let cat = findCategory(doc, id);
    if (cat) {
      if (name && cat.name !== name && !DEFAULT_CATEGORY_DEFS.some(d => d.id === id)) {
        // 保留已有名；若传入名且当前是占位则可更新
        if (!cat.name || cat.name === id) cat.name = name;
      }
      return cat;
    }
    // 未知 id：优先 other；若带了可读名称则自动建分类
    if (!name && id !== 'other' && !DEFAULT_CATEGORY_DEFS.some(d => d.id === id)) {
      const other = findCategory(doc, 'other');
      if (other) return other;
    }
    const def = DEFAULT_CATEGORY_DEFS.find(d => d.id === id);
    name = name || (def ? def.name : id);
    const next = addCategory(doc, { id, name }, now);
    Object.assign(doc, { categories: next.categories, updatedAt: next.updatedAt });
    return findCategory(doc, id);
  }

  function findEntryAnywhere(doc, entryId) {
    if (!entryId) return null;
    for (const cat of doc.categories || []) {
      const entry = (cat.entries || []).find(e => e.id === entryId);
      if (entry) return { category: cat, entry };
    }
    return null;
  }

  /**
   * 将 parseImport 结果合并进 base。
   * mode: 'merge'（默认，同 id 覆盖、无 id 新建）| 'replace'（先清空条目再导入；分类保留默认并吸收导入分类）
   * 返回 { doc, added, updated, categoriesCreated }
   */
  function mergeDoc(base, parsed, opt) {
    const mode = (opt && opt.mode) === 'replace' ? 'replace' : 'merge';
    const now = (opt && opt.now) || Date.now();
    const worldId = String((opt && opt.worldId) || (base && base.worldId) || (parsed && parsed.worldId) || '').trim();
    let doc = cloneDoc(normalizeDoc(base || emptyDoc(worldId), worldId));
    if (!doc.worldId && worldId) doc.worldId = worldId;

    let added = 0, updated = 0, categoriesCreated = 0;

    if (mode === 'replace') {
      doc.categories.forEach(c => { c.entries = []; });
      // 若整库 JSON 带分类，用导入分类结构替换（保留空默认被覆盖的语义）
      if (parsed && Array.isArray(parsed.categories) && parsed.categories.length && !(parsed.entries && parsed.entries.length)) {
        const incoming = parsed.categories.map(normalizeCategory);
        // 合并默认分类定义：导入优先
        const map = new Map();
        emptyCategories().forEach(c => map.set(c.id, c));
        incoming.forEach(c => {
          const prev = map.get(c.id);
          if (prev) map.set(c.id, Object.assign({}, prev, c, { entries: (c.entries || []).map(e => {
            const n = normalizeEntry(e, now);
            delete n._now;
            if (!e.createdAt) n.createdAt = now;
            if (!e.updatedAt) n.updatedAt = now;
            return n;
          }) }));
          else map.set(c.id, c);
        });
        doc.categories = Array.from(map.values());
        doc.categories.sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh'));
        doc.categories.forEach((c, i) => { c.order = i; });
        added = doc.categories.reduce((n, c) => n + (c.entries || []).length, 0);
        return { doc: touch(doc, now), added, updated: 0, categoriesCreated: 0, mode, format: parsed && parsed.format };
      }
    }

    // 先吸收分类元数据
    (parsed.categories || []).forEach(c => {
      const before = doc.categories.length;
      ensureCategory(doc, c.id, c.name, now);
      if (doc.categories.length > before) categoriesCreated++;
    });

    // 整库 JSON 的 entries 在 categories 内
    const flat = [];
    (parsed.categories || []).forEach(c => {
      (c.entries || []).forEach(e => {
        flat.push({
          categoryId: c.id,
          categoryName: c.name,
          categoryHint: c.id,
          entry: normalizeEntry(e, now),
        });
      });
    });
    (parsed.entries || []).forEach(row => flat.push(row));

    flat.forEach(row => {
      const e = row.entry || normalizeEntry(row, now);
      delete e._now;
      let hintId = String(row.categoryId || '').trim();
      let hintName = String(row.categoryName || '').trim();
      if (!hintId && row.categoryHint) {
        const h = String(row.categoryHint).trim();
        if (findCategory(doc, h) || DEFAULT_CATEGORY_DEFS.some(d => d.id === h) || /^[A-Za-z][\w-]*$/.test(h)) hintId = h;
        else hintName = hintName || h;
      }
      const beforeCats = doc.categories.length;
      let cat = ensureCategory(doc, hintId, hintName, now);
      if (doc.categories.length > beforeCats) categoriesCreated++;

      if (e.id) {
        const hit = findEntryAnywhere(doc, e.id);
        if (hit) {
          // 同 id 覆盖；若分类不同则移到目标分类
          if (hit.category.id !== cat.id) {
            hit.category.entries = hit.category.entries.filter(x => x.id !== e.id);
            const merged = Object.assign({}, hit.entry, e, {
              id: e.id,
              createdAt: hit.entry.createdAt || e.createdAt || now,
              updatedAt: now,
            });
            const n = normalizeEntry(merged, now);
            delete n._now;
            cat.entries.push(n);
          } else {
            Object.assign(hit.entry, {
              title: e.title,
              content: e.content,
              keywords: e.keywords,
              tags: e.tags,
              pinned: e.pinned,
              updatedAt: now,
            });
            if (!hit.entry.createdAt) hit.entry.createdAt = e.createdAt || now;
          }
          updated++;
          return;
        }
      }
      const newE = normalizeEntry(Object.assign({}, e, {
        id: e.id || ('e-' + uid()),
        createdAt: e.createdAt || now,
        updatedAt: now,
      }), now);
      delete newE._now;
      // 避免偶然 id 冲突（同分类）
      if (cat.entries.some(x => x.id === newE.id)) newE.id = 'e-' + uid();
      cat.entries.push(newE);
      added++;
    });

    return { doc: touch(doc, now), added, updated, categoriesCreated, mode, format: parsed && parsed.format };
  }

  function exportJSON(doc, pretty) {
    const d = normalizeDoc(doc, doc && doc.worldId);
    const out = {
      worldId: d.worldId,
      updatedAt: d.updatedAt,
      categories: d.categories.map(c => ({
        id: c.id,
        name: c.name,
        order: c.order,
        entries: (c.entries || []).map(e => ({
          id: e.id,
          title: e.title,
          content: e.content,
          keywords: e.keywords || [],
          tags: e.tags || [],
          pinned: !!e.pinned,
          createdAt: e.createdAt || 0,
          updatedAt: e.updatedAt || 0,
        })),
      })),
    };
    return pretty === false ? JSON.stringify(out) : JSON.stringify(out, null, 2);
  }

  /** 高密度：每行一条 entry */
  function exportNdjson(doc) {
    const d = normalizeDoc(doc, doc && doc.worldId);
    const lines = [];
    d.categories.forEach(c => {
      (c.entries || []).forEach(e => {
        const row = {
          categoryId: c.id,
          title: e.title,
          content: e.content,
        };
        if (e.keywords && e.keywords.length) row.keywords = e.keywords;
        if (e.tags && e.tags.length) row.tags = e.tags;
        if (e.pinned) row.pinned = true;
        if (e.id) row.id = e.id;
        lines.push(JSON.stringify(row));
      });
    });
    return lines.join('\n') + (lines.length ? '\n' : '');
  }

  function exportMarkdown(doc) {
    const d = normalizeDoc(doc, doc && doc.worldId);
    const parts = [];
    d.categories.forEach(c => {
      if (!(c.entries || []).length) return;
      parts.push('## ' + c.id + ' ' + c.name);
      parts.push('');
      (c.entries || []).forEach(e => {
        parts.push('### ' + (e.title || '未命名'));
        if (e.keywords && e.keywords.length) parts.push('keywords: ' + e.keywords.join(', '));
        if (e.tags && e.tags.length) parts.push('tags: ' + e.tags.join(', '));
        if (e.pinned) parts.push('pinned: true');
        if (e.id) parts.push('id: ' + e.id);
        parts.push('');
        parts.push(e.content || '');
        parts.push('');
      });
    });
    return parts.join('\n').replace(/\n+$/, '\n');
  }

  const api = {
    DEFAULT_CATEGORY_DEFS,
    storeKey,
    emptyDoc,
    emptyCategories,
    normalizeDoc,
    normalizeCategory,
    normalizeEntry,
    normalizeKeywords,
    load,
    save,
    ensure,
    addCategory,
    updateCategory,
    removeCategory,
    reorderCategories,
    addEntry,
    updateEntry,
    removeEntry,
    setPinned,
    search,
    searchLegacy,
    searchBM25,
    selectForInject, getIndexCache: () => _kbIndex, resetIndexCache: () => { _kbIndex = null; },
    renderInjection,
    spliceIntoUserContent,
    KB_WEIGHTS,
    listEntries,
    sortEntries,
    findCategory,
    findEntry,
    tokenize,
    detectImportFormat,
    parseImport,
    mergeDoc,
    exportJSON,
    exportNdjson,
    exportMarkdown,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Knowledge = api;
})(typeof window !== 'undefined' ? window : globalThis);
