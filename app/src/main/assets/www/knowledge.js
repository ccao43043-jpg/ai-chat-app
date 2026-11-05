/* 本地资料库（按世界隔离）：纯 CRUD + 关键词检索，可在 Node 单测里 require。
 * 存储键：knowledge_world_<worldId>.json；阶段 1 不注入请求。 */
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
   * 简单关键词检索：所有 token 都要命中（AND）；优先关键词字段 / 标题。
   * 返回 [{ categoryId, categoryName, entry, score }]，置顶优先。
   */
  function search(doc, query, opt) {
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
    listEntries,
    sortEntries,
    findCategory,
    findEntry,
    tokenize,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Knowledge = api;
})(typeof window !== 'undefined' ? window : globalThis);
