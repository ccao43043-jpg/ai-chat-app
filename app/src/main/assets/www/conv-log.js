/* 第五轮 C：会话追加式 op log + 周期快照 + replay / 最小同步
 * 存储：
 *   conv_<id>.json          旧格式全文（迁移后只读回退一个版本）或新会话的元数据指针（format=oplog-v1）
 *   conv_<id>.snap.json     快照 { upToLamport, messages, chapters, affect, ledger, worldRef, ... }
 *   conv_<id>.log.jsonl     快照之后的追加 op
 * 不改 worlds.json / knowledge_world_*.json。
 */
(function (root) {
  'use strict';

  const FORMAT = 'oplog-v1';
  const COMPACT_OPS = 200;
  const COMPACT_BYTES = 1024 * 1024;
  const DEVICE_FILE = 'device-id.json';

  const META_SKIP = {
    messages: 1, chapters: 1, affect: 1, affectBy: 1, ledger: 1,
    worldRef: 1, worldLog: 1, worldPending: 1,
    format: 1, tombstones: 1, stamps: 1, clock: 1, kb: 1, order: 1,
  };

  function snapshotKey(id) { return 'conv_' + id + '.snap.json'; }
  function logKey(id) { return 'conv_' + id + '.log.jsonl'; }
  function legacyKey(id) { return 'conv_' + id + '.json'; }

  function filesOf(id) {
    const base = legacyKey(id);
    return [base, base + '.bak', snapshotKey(id), snapshotKey(id) + '.bak', logKey(id)];
  }

  function isConvJsonName(name) {
    return /^conv_[^./]+\.json$/.test(name);
  }
  function isSnapName(name) {
    return /^conv_([^./]+)\.snap\.json$/.test(name);
  }
  function isLogName(name) {
    return /^conv_([^./]+)\.log\.jsonl$/.test(name);
  }
  function idFromName(name) {
    let m = /^conv_([^./]+)\.(snap\.json|log\.jsonl|json)$/.exec(name);
    return m ? m[1] : '';
  }

  function clone(v) {
    return v == null ? v : JSON.parse(JSON.stringify(v));
  }
  function equal(a, b) {
    if (a === b) return true;
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function nowMs() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  function getFflate() {
    if (root.fflate) return root.fflate;
    try { if (typeof require === 'function') return require('./lib/fflate.min.js'); } catch (e) { /* node path */ }
    try { if (typeof require === 'function') return require('./fflate.min.js'); } catch (e) { /* alt */ }
    return null;
  }
  function b64encode(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = ''; const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    return btoa(s);
  }
  function b64decode(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }
  function compressStr(s) {
    const f = getFflate();
    if (!f || s == null) return null;
    try {
      const z = f.zlibSync(f.strToU8(String(s)), { level: 6 });
      return b64encode(z);
    } catch (e) { return null; }
  }
  function decompressStr(z) {
    const f = getFflate();
    if (!f || !z) return '';
    try { return f.strFromU8(f.unzlibSync(b64decode(z))); } catch (e) { return ''; }
  }

  function packChapters(chapters) {
    const list = Array.isArray(chapters) ? chapters : [];
    if (list.length < 2) return list.map(ch => clone(ch));
    const last = list.length - 1;
    return list.map((ch, i) => {
      const c = clone(ch) || {};
      if (i === last || typeof c.content !== 'string' || !c.content) return c;
      const z = compressStr(c.content);
      if (!z || z.length >= c.content.length) return c;
      c.contentZ = z;
      c.content = '';
      return c;
    });
  }
  function unpackChapters(chapters) {
    return (Array.isArray(chapters) ? chapters : []).map(ch => {
      const c = clone(ch) || {};
      if (c.contentZ && !c.content) c.content = decompressStr(c.contentZ);
      delete c.contentZ;
      return c;
    });
  }

  function stampCmp(a, b) {
    const la = (a && a.lamport) | 0, lb = (b && b.lamport) | 0;
    if (la !== lb) return la > lb ? 1 : -1;
    const da = String((a && a.dev) || ''), db = String((b && b.dev) || '');
    if (da !== db) return da > db ? 1 : -1;
    return 0;
  }
  function stampOf(op) { return { lamport: (op && op.lamport) | 0, dev: String((op && op.dev) || '') }; }
  function wins(op, prev) { return !prev || stampCmp(stampOf(op), prev) >= 0; }
  /* 仅当 (lamport, dev) 无法分出先后（同 lamport、不同设备）且值不同时标 conflict；否则走 LWW */
  function isConflict(op, prevStamp, prevVal, nextVal) {
    if (!prevStamp || equal(prevVal, nextVal)) return false;
    if (stampOf(op).dev === prevStamp.dev) return false;
    if ((prevStamp.lamport | 0) !== ((op && op.lamport) | 0)) return false;
    return true;
  }

  function messageText(m) {
    const c = m && m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(p => (p && (p.text || p.content || '')) || '').join(' ');
    if (c && typeof c === 'object') return String(c.text || c.content || JSON.stringify(c));
    return String(c || '');
  }

  function extractChapters(conv) {
    const st = conv && conv.plugins && conv.plugins.rpcache && conv.plugins.rpcache.state;
    if (st && Array.isArray(st.chapters)) return st.chapters;
    if (Array.isArray(conv && conv.chapters)) return conv.chapters;
    return [];
  }
  function extractLedger(conv) {
    if (Array.isArray(conv && conv.ledger)) return conv.ledger;
    const mem = conv && conv.plugins && conv.plugins.rpmemory;
    if (mem && Array.isArray(mem.ledger)) return mem.ledger;
    if (mem && mem.state && Array.isArray(mem.state.ledger)) return mem.state.ledger;
    return [];
  }
  function extractMeta(conv) {
    const meta = {};
    if (!conv || typeof conv !== 'object') return meta;
    Object.keys(conv).forEach(k => { if (!META_SKIP[k]) meta[k] = clone(conv[k]); });
    if (meta.plugins && meta.plugins.rpcache && meta.plugins.rpcache.state && Array.isArray(meta.plugins.rpcache.state.chapters)) {
      const st = Object.assign({}, meta.plugins.rpcache.state);
      delete st.chapters;
      meta.plugins = Object.assign({}, meta.plugins, { rpcache: Object.assign({}, meta.plugins.rpcache, { state: st }) });
    }
    return meta;
  }

  function emptyState(id) {
    return {
      id: id,
      messages: [],
      chapters: [],
      affect: null,
      affectBy: null,
      ledger: [],
      worldRef: null,
      worldLog: [],
      worldPending: null,
      meta: { id: id, title: '新对话', messages: undefined },
      tombstones: { msg: {}, chapter: {}, ledger: {} },
      stamps: { msg: {}, chapter: {}, ledger: {}, affect: {}, worldRef: {}, worldLog: {}, meta: {}, order: null, kb: {}, affectBy: {} },
      order: [],
      kb: {},
      clock: 0,
    };
  }

  function idxOfMsg(state, id) {
    return state.messages.findIndex(m => m && m.id === id);
  }

  function applyConflict(target, field, prevVal, op) {
    const rec = { content: prevVal, lamport: (op.lamport) | 0, dev: String(op.dev || ''), field: field };
    if (target && typeof target === 'object' && !Array.isArray(target)) {
      const list = Array.isArray(target._conflicts) ? target._conflicts.slice() : [];
      list.push(rec);
      target._conflicts = list;
      target.conflict = true;
    }
    return rec;
  }

  function applyOp(state, op) {
    if (!op || !op.op) return state;
    if ((op.lamport | 0) > (state.clock | 0)) state.clock = op.lamport | 0;
    const p = op.payload || {};
    const st = stampOf(op);
    switch (op.op) {
      case 'msg.add': {
        const m = clone(p);
        if (!m || !m.id) break;
        if (state.tombstones.msg[m.id] && stampCmp(state.tombstones.msg[m.id], st) > 0) break;
        const i = idxOfMsg(state, m.id);
        const prevS = state.stamps.msg[m.id];
        if (i >= 0) {
          if (!wins(op, prevS)) break;
          if (isConflict(op, prevS, state.messages[i], m)) applyConflict(m, 'message', clone(state.messages[i]), op);
          state.messages[i] = m;
        } else {
          state.messages.push(m);
          if (!state.order.includes(m.id)) state.order.push(m.id);
        }
        state.stamps.msg[m.id] = st;
        delete state.tombstones.msg[m.id];
        break;
      }
      case 'msg.edit': {
        const id = p.id;
        if (!id) break;
        if (state.tombstones.msg[id] && stampCmp(state.tombstones.msg[id], st) > 0) break;
        if (!wins(op, state.stamps.msg[id])) break;
        const i = idxOfMsg(state, id);
        if (i < 0) {
          const neu = clone(p);
          if (!neu.id) neu.id = id;
          state.messages.push(neu);
          if (!state.order.includes(id)) state.order.push(id);
        } else {
          const prev = state.messages[i];
          const next = Object.assign({}, prev, clone(p));
          if (isConflict(op, state.stamps.msg[id], prev, next)) applyConflict(next, 'message', clone(prev), op);
          state.messages[i] = next;
        }
        state.stamps.msg[id] = st;
        break;
      }
      case 'msg.remove':
      case 'msg.delete': {
        const id = p.id;
        if (!id) break;
        const cur = state.stamps.msg[id] || state.tombstones.msg[id];
        if (cur && stampCmp(cur, st) > 0) break; // 更新的 add/edit 已胜出，删除不能回退
        state.messages = state.messages.filter(m => m.id !== id);
        state.order = state.order.filter(x => x !== id);
        state.tombstones.msg[id] = st;
        state.stamps.msg[id] = st;
        break;
      }
      case 'msg.reorder': {
        const ids = Array.isArray(p.ids) ? p.ids.slice() : [];
        if (!wins(op, state.stamps.order)) break;
        const map = {};
        state.messages.forEach(m => { map[m.id] = m; });
        const seen = new Set();
        const next = [];
        ids.forEach(id => { if (map[id] && !seen.has(id) && !state.tombstones.msg[id]) { next.push(map[id]); seen.add(id); } });
        state.messages.forEach(m => { if (!seen.has(m.id) && !state.tombstones.msg[m.id]) next.push(m); });
        state.messages = next;
        state.order = next.map(m => m.id);
        state.stamps.order = st;
        break;
      }
      case 'chapter.commit': {
        const ch = clone(p);
        const no = ch && (ch.no != null ? ch.no : ch.id);
        if (no == null) break;
        const key = String(no);
        if (state.tombstones.chapter[key] && stampCmp(state.tombstones.chapter[key], st) > 0) break;
        const i = state.chapters.findIndex(c => String(c.no != null ? c.no : c.id) === key);
        if (i >= 0) {
          if (!wins(op, state.stamps.chapter[key])) break;
          if (isConflict(op, state.stamps.chapter[key], state.chapters[i], ch)) {
            const loser = clone(state.chapters[i]);
            loser.conflict = true;
            ch.conflict = true;
            ch._conflicts = (ch._conflicts || []).concat([loser]);
            state.chapters.push(loser);
          }
          const j = state.chapters.findIndex(c => String(c.no != null ? c.no : c.id) === key && !c.conflict);
          if (j >= 0) state.chapters[j] = ch;
          else state.chapters[i] = ch;
        } else {
          state.chapters.push(ch);
        }
        state.stamps.chapter[key] = st;
        delete state.tombstones.chapter[key];
        break;
      }
      case 'chapter.edit': {
        const no = p.no != null ? p.no : p.id;
        if (no == null) break;
        const key = String(no);
        if (state.tombstones.chapter[key] && stampCmp(state.tombstones.chapter[key], st) > 0) break;
        if (!wins(op, state.stamps.chapter[key])) break;
        const i = state.chapters.findIndex(c => String(c.no != null ? c.no : c.id) === key && !c.conflict);
        if (i < 0) {
          state.chapters.push(clone(p));
        } else {
          const prev = state.chapters[i];
          const next = Object.assign({}, prev, clone(p));
          if (isConflict(op, state.stamps.chapter[key], prev, next)) {
            const loser = clone(prev);
            loser.conflict = true;
            next.conflict = true;
            next._conflicts = (next._conflicts || []).concat([loser]);
            state.chapters.push(loser);
          }
          state.chapters[i] = next;
        }
        state.stamps.chapter[key] = st;
        break;
      }
      case 'chapter.remove': {
        const no = p.no != null ? p.no : p.id;
        if (no == null) break;
        const key = String(no);
        const cur = state.stamps.chapter[key] || state.tombstones.chapter[key];
        if (cur && stampCmp(cur, st) > 0) break;
        state.chapters = state.chapters.filter(c => String(c.no != null ? c.no : c.id) !== key);
        state.tombstones.chapter[key] = st;
        state.stamps.chapter[key] = st;
        break;
      }
      case 'affect.set': {
        if (!wins(op, state.stamps.affect)) break;
        const prev = state.affect;
        const next = clone(p && p.affect !== undefined ? p.affect : p);
        if (isConflict(op, state.stamps.affect, prev, next) && next && typeof next === 'object') {
          next.conflict = true;
          next._conflicts = (next._conflicts || []).concat([clone(prev)]);
        }
        state.affect = next;
        state.stamps.affect = st;
        break;
      }
      case 'affect.by': {
        const cid = String(p.id || p.charId || '');
        if (!cid) break;
        if (!wins(op, state.stamps.affectBy[cid])) break;
        state.affectBy = state.affectBy || {};
        state.affectBy[cid] = clone(p.state || p.affect || p);
        state.stamps.affectBy[cid] = st;
        break;
      }
      case 'ledger.append': {
        const fact = clone(p.fact || p);
        if (!fact) break;
        const key = String(fact.id || fact.key || (fact.subject + '/' + fact.attribute + '/' + (fact.quote || '')));
        const prevS = state.stamps.ledger[key];
        const i = state.ledger.findIndex(f => String(f.id || f.key || (f.subject + '/' + f.attribute + '/' + (f.quote || ''))) === key);
        if (i < 0) {
          state.ledger.push(fact);
          state.stamps.ledger[key] = st;
        } else if (wins(op, prevS)) {
          if (isConflict(op, prevS, state.ledger[i], fact) && !equal(state.ledger[i], fact)) {
            /* 账本不可变追加：冲突时保留双方并标 conflict */
            const loser = Object.assign({}, clone(state.ledger[i]), { conflict: true });
            const neu = Object.assign({}, fact, { conflict: true });
            state.ledger[i] = loser;
            state.ledger.push(neu);
          } else {
            state.ledger[i] = fact;
          }
          state.stamps.ledger[key] = st;
        }
        break;
      }
      case 'worldRef.set': {
        if (!wins(op, state.stamps.worldRef)) break;
        state.worldRef = clone(p.worldRef !== undefined ? p.worldRef : p);
        state.stamps.worldRef = st;
        if (p.worldPending !== undefined) state.worldPending = clone(p.worldPending);
        break;
      }
      case 'worldLog.append': {
        const entry = clone(p.entry || p);
        if (!entry) break;
        const key = JSON.stringify(entry);
        const exists = (state.worldLog || []).some(e => JSON.stringify(e) === key);
        if (!exists) state.worldLog = (state.worldLog || []).concat([entry]);
        break;
      }
      case 'meta.set': {
        const patch = clone(p.patch || p);
        if (!patch || typeof patch !== 'object') break;
        state.meta = state.meta || {};
        Object.keys(patch).forEach(k => {
          if (META_SKIP[k] || k === 'id' && !patch[k]) return;
          const ps = (state.stamps.meta[k]);
          if (ps && stampCmp(ps, st) > 0) return;
          state.meta[k] = patch[k];
          state.stamps.meta[k] = st;
        });
        break;
      }
      case 'kb.upsert': {
        const worldId = String(p.worldId || '');
        const entry = clone(p.entry || p);
        if (!worldId || !entry || !entry.id) break;
        const k = worldId + '/' + entry.id;
        if (!wins(op, state.stamps.kb[k])) break;
        state.kb[worldId] = state.kb[worldId] || {};
        const prev = state.kb[worldId][entry.id];
        if (prev && isConflict(op, state.stamps.kb[k], prev, entry)) {
          entry.conflict = true;
          entry._conflicts = (entry._conflicts || []).concat([Object.assign({}, prev, { conflict: true })]);
        }
        state.kb[worldId][entry.id] = entry;
        state.stamps.kb[k] = st;
        break;
      }
      default:
        break;
    }
    return state;
  }

  function replay(snapshot, ops) {
    const state = stateFromSnapshot(snapshot);
    const upTo = (snapshot && snapshot.upToLamport) | 0;
    (ops || []).forEach(op => {
      if (!op) return;
      if ((op.lamport | 0) <= upTo) return;
      applyOp(state, op);
    });
    return state;
  }

  function stateFromSnapshot(snap) {
    if (!snap) return emptyState('');
    const id = snap.id || (snap.meta && snap.meta.id) || '';
    const state = emptyState(id);
    state.clock = (snap.upToLamport | 0) || (snap.clock | 0);
    state.messages = clone(snap.messages) || [];
    state.chapters = unpackChapters(snap.chapters || []);
    state.affect = snap.affect != null ? clone(snap.affect) : null;
    state.affectBy = snap.affectBy ? clone(snap.affectBy) : null;
    state.ledger = clone(snap.ledger) || [];
    state.worldRef = snap.worldRef ? clone(snap.worldRef) : null;
    state.worldLog = clone(snap.worldLog) || [];
    state.worldPending = snap.worldPending != null ? clone(snap.worldPending) : null;
    state.meta = Object.assign({}, extractMeta({ id: id }), clone(snap.meta) || {});
    state.meta.id = id;
    if (snap.tombstones) state.tombstones = clone(snap.tombstones);
    if (snap.stamps) state.stamps = Object.assign(state.stamps, clone(snap.stamps));
    state.order = Array.isArray(snap.order) ? snap.order.slice() : state.messages.map(m => m.id);
    if (snap.kb) state.kb = clone(snap.kb);
    if ((snap.clock | 0) > state.clock) state.clock = snap.clock | 0;
    return state;
  }

  function takeSnapshot(state, packed) {
    const chapters = packed ? packChapters(state.chapters) : clone(state.chapters);
    return {
      format: FORMAT,
      upToLamport: state.clock | 0,
      messages: clone(state.messages),
      chapters: chapters,
      affect: clone(state.affect),
      ledger: clone(state.ledger),
      worldRef: clone(state.worldRef),
      affectBy: clone(state.affectBy),
      worldLog: clone(state.worldLog),
      worldPending: clone(state.worldPending),
      meta: clone(state.meta),
      id: state.id,
      tombstones: clone(state.tombstones),
      stamps: clone(state.stamps),
      order: (state.order || []).slice(),
      kb: clone(state.kb),
      clock: state.clock | 0,
    };
  }

  function cleanEntity(x) {
    if (!x || typeof x !== 'object') return x;
    const o = Array.isArray(x) ? x.map(cleanEntity) : Object.assign({}, x);
    if (!Array.isArray(o)) {
      delete o._conflicts;
      /* 保留 conflict 标记以便 UI 可见，导出旧格式时再剥掉 */
    }
    return o;
  }

  function toConv(state, opt) {
    opt = opt || {};
    const conv = Object.assign({ id: state.id }, clone(state.meta) || {});
    conv.id = state.id;
    conv.messages = clone(state.messages) || [];
    conv.worldRef = state.worldRef ? clone(state.worldRef) : (conv.worldRef || undefined);
    if (state.worldLog && state.worldLog.length) conv.worldLog = clone(state.worldLog);
    if (state.worldPending) conv.worldPending = clone(state.worldPending);
    if (state.affect != null) conv.affect = clone(state.affect);
    if (state.affectBy) conv.affectBy = clone(state.affectBy);
    if (state.ledger && state.ledger.length) conv.ledger = clone(state.ledger);
    const chapters = unpackChapters(state.chapters);
    if (chapters && chapters.length) {
      conv.plugins = conv.plugins || {};
      conv.plugins.rpcache = conv.plugins.rpcache || {};
      conv.plugins.rpcache.state = Object.assign({}, conv.plugins.rpcache.state || {}, { chapters: chapters });
    }
    if (opt.legacy) {
      delete conv.format;
      stripConflictMarks(conv);
    } else {
      conv.format = FORMAT;
    }
    return conv;
  }

  function stripConflictMarks(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) { node.forEach(stripConflictMarks); return node; }
    delete node._conflicts;
    delete node.conflict;
    Object.keys(node).forEach(k => {
      if (node[k] && typeof node[k] === 'object') stripConflictMarks(node[k]);
    });
    return node;
  }

  function ensureDev(store) {
    let rec = store.get(DEVICE_FILE, null);
    if (typeof rec === 'string') rec = { dev: rec };
    if (!rec || !rec.dev) {
      rec = { dev: 'dev-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8) };
      try { store.set(DEVICE_FILE, rec); } catch (e) { /* ignore */ }
    }
    return rec.dev;
  }

  function readOps(store, id) {
    const items = store.readJsonl(logKey(id));
    return Array.isArray(items) ? items.filter(Boolean) : [];
  }

  function hasOplog(store, id) {
    if (store.exists) {
      if (store.exists(snapshotKey(id)) || store.exists(logKey(id))) return true;
    } else {
      if (store.raw && (store.raw(snapshotKey(id)) != null || store.raw(logKey(id)) != null)) return true;
    }
    const snap = store.get(snapshotKey(id), null);
    return !!(snap && snap.format === FORMAT);
  }

  function isLegacyConv(obj) {
    return !!(obj && typeof obj === 'object' && obj.id && obj.format !== FORMAT);
  }

  /* 首次加载旧格式 → snapshot(upTo=0) + 全量 op，保留原 conv_*.json 只读回退 */
  function convToOps(conv, dev) {
    const ops = [];
    let lamport = 0;
    const next = payload => { lamport += 1; return { lamport: lamport, dev: dev, op: payload.op, payload: payload.payload }; };
    const meta = extractMeta(conv);
    if (Object.keys(meta).length) ops.push(next({ op: 'meta.set', payload: { patch: meta } }));
    (conv.messages || []).forEach(m => { if (m && m.id) ops.push(next({ op: 'msg.add', payload: clone(m) })); });
    if ((conv.messages || []).length) ops.push(next({ op: 'msg.reorder', payload: { ids: conv.messages.map(m => m.id) } }));
    extractChapters(conv).forEach(ch => ops.push(next({ op: 'chapter.commit', payload: clone(ch) })));
    if (conv.affect != null) ops.push(next({ op: 'affect.set', payload: { affect: clone(conv.affect) } }));
    if (conv.affectBy) {
      Object.keys(conv.affectBy).forEach(cid => ops.push(next({ op: 'affect.by', payload: { id: cid, state: clone(conv.affectBy[cid]) } })));
    }
    extractLedger(conv).forEach(f => ops.push(next({ op: 'ledger.append', payload: { fact: clone(f) } })));
    if (conv.worldRef) ops.push(next({ op: 'worldRef.set', payload: { worldRef: clone(conv.worldRef), worldPending: conv.worldPending || null } }));
    (conv.worldLog || []).forEach(e => ops.push(next({ op: 'worldLog.append', payload: { entry: clone(e) } })));
    return ops;
  }

  function writePointer(store, conv) {
    const ptr = {
      format: FORMAT,
      id: conv.id,
      title: conv.title || '新对话',
      providerId: conv.providerId || '',
      model: conv.model || '',
      updatedAt: conv.updatedAt || Date.now(),
      createdAt: conv.createdAt,
    };
    if (conv.personaName) { ptr.personaName = conv.personaName; ptr.personaEmoji = conv.personaEmoji; }
    store.set(legacyKey(conv.id), ptr);
  }

  function migrateLegacy(store, conv, dev) {
    const id = conv.id;
    const ops = convToOps(conv, dev || ensureDev(store));
    const snap = {
      format: FORMAT,
      upToLamport: 0,
      messages: [],
      chapters: [],
      affect: null,
      ledger: [],
      worldRef: null,
      id: id,
      meta: { id: id },
    };
    store.set(snapshotKey(id), snap);
    if (ops.length) store.writeJsonl(logKey(id), ops);
    else store.writeJsonl(logKey(id), []);
    /* 原 conv_<id>.json 原样保留，作为只读回退 */
    return { snapshot: snap, ops: ops, migrated: true };
  }

  function compactState(store, state) {
    const snap = takeSnapshot(state, true);
    if (store.set(snapshotKey(state.id), snap) === false) return false;
    store.writeJsonl(logKey(state.id), []);
    return true;
  }

  const sessionsByStore = new WeakMap();
  const sessions = { // 测试用：clearSessions 可清空所有已登记 store
    _list: [],
    get(id) { return null; },
  };

  function sessionMap(store) {
    let m = sessionsByStore.get(store);
    if (!m) { m = new Map(); sessionsByStore.set(store, m); sessions._list.push(m); }
    return m;
  }

  function attachSession(store, id, state, extra) {
    const s = {
      store: store,
      id: id,
      dev: (extra && extra.dev) || ensureDev(store),
      state: state,
      last: toConv(state),
      logCount: (extra && extra.logCount) | 0,
      logBytes: (extra && extra.logBytes) | 0,
    };
    sessionMap(store).set(id, s);
    return s;
  }

  function measureLog(ops) {
    let bytes = 0;
    (ops || []).forEach(o => { bytes += JSON.stringify(o).length + 1; });
    return { count: (ops || []).length, bytes: bytes };
  }

  function loadState(store, id) {
    if (hasOplog(store, id)) {
      const snap = store.get(snapshotKey(id), null) || { format: FORMAT, upToLamport: 0, messages: [], chapters: [], affect: null, ledger: [], worldRef: null, id: id };
      const ops = readOps(store, id);
      const state = replay(snap, ops);
      state.id = id;
      const m = measureLog(ops.filter(o => o && (o.lamport | 0) > ((snap.upToLamport) | 0)));
      return { state: state, logCount: m.count, logBytes: m.bytes, from: 'oplog' };
    }
    const legacy = store.get(legacyKey(id), null);
    if (legacy && legacy.format === FORMAT && !legacy.messages) {
      const state = emptyState(id);
      state.meta = Object.assign(state.meta, extractMeta(legacy));
      return { state: state, logCount: 0, logBytes: 0, from: 'pointer' };
    }
    if (legacy && isLegacyConv(legacy)) {
      const dev = ensureDev(store);
      migrateLegacy(store, legacy, dev);
      const ops = readOps(store, id);
      const snap = store.get(snapshotKey(id), null);
      let state = replay(snap, ops);
      state.id = id;
      /* 迁移后立即压缩，避免首次冷启动 replay 全量 op */
      compactState(store, state);
      const again = store.get(snapshotKey(id), null);
      state = stateFromSnapshot(again);
      return { state: state, logCount: 0, logBytes: 0, from: 'migrated', migrated: true };
    }
    return null;
  }

  function load(store, id) {
    const r = loadState(store, id);
    if (!r) return null;
    attachSession(store, id, r.state, { logCount: r.logCount, logBytes: r.logBytes });
    return toConv(r.state);
  }

  function loadMeta(store, id) {
    const snap = store.get(snapshotKey(id), null);
    if (snap) {
      const meta = Object.assign({ id: id }, snap.meta || {});
      if (snap.worldRef) meta.worldRef = snap.worldRef;
      return {
        id: id,
        title: meta.title || '未命名对话',
        providerId: meta.providerId || '',
        model: meta.model || '',
        updatedAt: +meta.updatedAt || 0,
        personaName: meta.personaName,
        personaEmoji: meta.personaEmoji,
      };
    }
    const legacy = store.get(legacyKey(id), null);
    if (legacy && legacy.id) {
      return {
        id: legacy.id,
        title: legacy.title || '未命名对话',
        providerId: legacy.providerId || '',
        model: legacy.model || '',
        updatedAt: +legacy.updatedAt || +legacy.createdAt || 0,
        personaName: legacy.personaName,
        personaEmoji: legacy.personaEmoji,
      };
    }
    return null;
  }

  function listConvIds(store) {
    const names = (store.list && store.list()) || [];
    const ids = new Set();
    names.forEach(n => {
      const id = idFromName(n);
      if (id) ids.add(id);
    });
    return Array.from(ids);
  }

  function removeFiles(store, id) {
    filesOf(id).forEach(n => { try { store.del(n); } catch (e) { /* ignore */ } });
    sessionMap(store).delete(id);
  }

  function maybeCompact(session) {
    if (session.logCount >= COMPACT_OPS || session.logBytes >= COMPACT_BYTES) {
      if (compactState(session.store, session.state) !== false) {
        session.logCount = 0;
        session.logBytes = 0;
      }
    }
  }

  function push(store, id, partial, opt) {
    opt = opt || {};
    let s = sessionMap(store).get(id);
    if (!s) {
      const r = loadState(store, id);
      const state = r ? r.state : emptyState(id);
      s = attachSession(store, id, state, r ? { logCount: r.logCount, logBytes: r.logBytes } : null);
    }
    const clock = Math.max(s.state.clock | 0, (opt.lamport | 0)) + (opt.keepLamport ? 0 : 1);
    const op = {
      lamport: opt.keepLamport && opt.lamport != null ? (opt.lamport | 0) : clock,
      dev: opt.dev || s.dev,
      op: partial.op,
      payload: partial.payload,
    };
    applyOp(s.state, op);
    const ok = store.append(logKey(id), op);
    const line = JSON.stringify(op).length + 1;
    s.logCount += 1;
    s.logBytes += line;
    if (opt.compact !== false) maybeCompact(s);
    s.lastDirty = true;
    return { op: op, ok: ok !== false, conv: null };
  }

  function importBatch(store, id, ops, opt) {
    opt = opt || {};
    let s = sessionMap(store).get(id);
    if (!s) {
      const r = loadState(store, id) || { state: emptyState(id), logCount: 0, logBytes: 0 };
      s = attachSession(store, id, r.state, r);
    }
    const applied = [];
    const seen = new Set();
    readOps(store, id).forEach(o => { if (o) seen.add(o.lamport + '\0' + o.dev + '\0' + o.op); });
    const incoming = (ops || []).slice().sort((a, b) => stampCmp(a, b) || String(a.op).localeCompare(String(b.op)));
    incoming.forEach(op => {
      if (!op || !op.op) return;
      const key = ((op.lamport) | 0) + '\0' + String(op.dev || '') + '\0' + op.op;
      if (seen.has(key)) return;
      seen.add(key);
      applyOp(s.state, op);
      store.append(logKey(id), op);
      s.logCount += 1;
      s.logBytes += JSON.stringify(op).length + 1;
      applied.push(op);
    });
    if (opt.compact !== false) maybeCompact(s);
    s.lastDirty = true;
    return { applied: applied, conv: null, state: s.state };
  }

  function stateToOps(state) {
    const ops = [];
    const pushOp = (st, op, payload) => {
      const stamp = st || { lamport: 0, dev: '' };
      ops.push({ lamport: stamp.lamport | 0, dev: String(stamp.dev || ''), op: op, payload: payload });
    };
    const meta = state.meta || {};
    const metaKeys = Object.keys(meta).filter(k => k !== 'id' && !META_SKIP[k]);
    if (metaKeys.length) {
      const patch = {};
      let stamp = { lamport: 0, dev: '' };
      metaKeys.forEach(k => {
        patch[k] = clone(meta[k]);
        if (state.stamps.meta[k] && stampCmp(state.stamps.meta[k], stamp) > 0) stamp = state.stamps.meta[k];
      });
      pushOp(stamp, 'meta.set', { patch: patch });
    }
    (state.messages || []).forEach(m => {
      if (m && m.id) pushOp(state.stamps.msg[m.id], 'msg.add', clone(m));
    });
    if ((state.order || []).length) pushOp(state.stamps.order, 'msg.reorder', { ids: state.order.slice() });
    Object.keys(state.tombstones.msg || {}).forEach(id => {
      pushOp(state.tombstones.msg[id], 'msg.remove', { id: id });
    });
    (state.chapters || []).forEach(ch => {
      const key = String(ch.no != null ? ch.no : ch.id);
      pushOp(state.stamps.chapter[key], 'chapter.commit', clone(ch));
    });
    Object.keys(state.tombstones.chapter || {}).forEach(key => {
      pushOp(state.tombstones.chapter[key], 'chapter.remove', { no: key });
    });
    if (state.affect != null) pushOp(state.stamps.affect, 'affect.set', { affect: clone(state.affect) });
    if (state.affectBy) {
      Object.keys(state.affectBy).forEach(cid => pushOp(state.stamps.affectBy[cid], 'affect.by', { id: cid, state: clone(state.affectBy[cid]) }));
    }
    (state.ledger || []).forEach(f => {
      const key = String(f.id || f.key || JSON.stringify(f));
      pushOp(state.stamps.ledger[key], 'ledger.append', { fact: clone(f) });
    });
    if (state.worldRef) pushOp(state.stamps.worldRef, 'worldRef.set', { worldRef: clone(state.worldRef), worldPending: clone(state.worldPending) || null });
    (state.worldLog || []).forEach(e => pushOp({ lamport: state.clock | 0, dev: '' }, 'worldLog.append', { entry: clone(e) }));
    Object.keys(state.kb || {}).forEach(wid => {
      Object.keys(state.kb[wid] || {}).forEach(eid => {
        pushOp(state.stamps.kb[wid + '/' + eid], 'kb.upsert', { worldId: wid, entry: clone(state.kb[wid][eid]) });
      });
    });
    return ops.sort((a, b) => stampCmp(a, b) || String(a.op).localeCompare(String(b.op)));
  }

  function exportBatch(store, id, sinceLamport) {
    const since = sinceLamport | 0;
    if (!hasOplog(store, id)) return [];
    const snap = store.get(snapshotKey(id), null);
    const upTo = (snap && snap.upToLamport) | 0;
    const tail = readOps(store, id).filter(o => o && (o.lamport | 0) > Math.max(since, since < upTo ? upTo : since));
    if (since < upTo && snap) {
      /* 对端落后于快照：用快照内原始 stamp（含墓碑）导出等价 op，不得重发新 lamport */
      const r = loadState(store, id);
      const catchup = stateToOps(r.state).filter(o => (o.lamport | 0) > since);
      const seen = new Set(catchup.map(o => (o.lamport | 0) + '\0' + o.dev + '\0' + o.op));
      tail.forEach(o => {
        const k = (o.lamport | 0) + '\0' + o.dev + '\0' + o.op;
        if (!seen.has(k)) { catchup.push(o); seen.add(k); }
      });
      return catchup.sort((a, b) => stampCmp(a, b) || String(a.op).localeCompare(String(b.op)));
    }
    return readOps(store, id).filter(o => o && (o.lamport | 0) > since);
  }

  function diff(prev, next) {
    const ops = [];
    prev = prev || { messages: [], id: next && next.id };
    next = next || { messages: [] };
    const pMeta = extractMeta(prev);
    const nMeta = extractMeta(next);
    const patch = {};
    const keys = new Set(Object.keys(pMeta).concat(Object.keys(nMeta)));
    keys.forEach(k => {
      if (k === 'id') return;
      if (!equal(pMeta[k], nMeta[k])) patch[k] = nMeta[k] === undefined ? null : clone(nMeta[k]);
    });
    if (Object.keys(patch).length) ops.push({ op: 'meta.set', payload: { patch: patch } });

    const pMsg = {};
    (prev.messages || []).forEach(m => { if (m && m.id) pMsg[m.id] = m; });
    const nMsg = {};
    (next.messages || []).forEach(m => { if (m && m.id) nMsg[m.id] = m; });
    Object.keys(pMsg).forEach(id => {
      if (!nMsg[id]) ops.push({ op: 'msg.remove', payload: { id: id } });
    });
    (next.messages || []).forEach(m => {
      if (!m || !m.id) return;
      if (!pMsg[m.id]) ops.push({ op: 'msg.add', payload: clone(m) });
      else if (!equal(pMsg[m.id], m)) ops.push({ op: 'msg.edit', payload: clone(m) });
    });
    const pIds = (prev.messages || []).filter(m => nMsg[m.id]).map(m => m.id);
    const nIds = (next.messages || []).map(m => m.id);
    if (!equal(pIds, nIds.filter(id => pMsg[id] || nMsg[id])) && nIds.length) {
      const sameSet = pIds.length === nIds.length && pIds.every(id => nIds.includes(id));
      if (!equal(pIds, nIds) && (nIds.length > 1 || sameSet || pIds.length)) {
        ops.push({ op: 'msg.reorder', payload: { ids: nIds } });
      }
    }

    const pCh = extractChapters(prev);
    const nCh = extractChapters(next);
    const pChMap = {};
    pCh.forEach(c => { const k = String(c.no != null ? c.no : c.id); pChMap[k] = c; });
    const nChMap = {};
    nCh.forEach(c => { const k = String(c.no != null ? c.no : c.id); nChMap[k] = c; });
    Object.keys(pChMap).forEach(k => { if (!nChMap[k]) ops.push({ op: 'chapter.remove', payload: { no: pChMap[k].no != null ? pChMap[k].no : pChMap[k].id } }); });
    nCh.forEach(c => {
      const k = String(c.no != null ? c.no : c.id);
      if (!pChMap[k]) ops.push({ op: 'chapter.commit', payload: clone(c) });
      else if (!equal(pChMap[k], c)) ops.push({ op: 'chapter.edit', payload: clone(c) });
    });

    if (!equal(prev.affect, next.affect) && (next.affect != null || prev.affect != null)) {
      ops.push({ op: 'affect.set', payload: { affect: next.affect != null ? clone(next.affect) : null } });
    }
    const pBy = prev.affectBy || {}, nBy = next.affectBy || {};
    Object.keys(nBy).forEach(cid => {
      if (!equal(pBy[cid], nBy[cid])) ops.push({ op: 'affect.by', payload: { id: cid, state: clone(nBy[cid]) } });
    });

    const pLed = extractLedger(prev), nLed = extractLedger(next);
    const pLedMap = {};
    pLed.forEach(f => { pLedMap[String(f.id || f.key || JSON.stringify(f))] = f; });
    nLed.forEach(f => {
      const k = String(f.id || f.key || JSON.stringify(f));
      if (!equal(pLedMap[k], f)) ops.push({ op: 'ledger.append', payload: { fact: clone(f) } });
    });

    if (!equal(prev.worldRef, next.worldRef) || !equal(prev.worldPending, next.worldPending)) {
      if (next.worldRef || prev.worldRef) ops.push({ op: 'worldRef.set', payload: { worldRef: clone(next.worldRef) || null, worldPending: clone(next.worldPending) || null } });
    }
    const pLog = prev.worldLog || [], nLog = next.worldLog || [];
    const pSet = new Set(pLog.map(e => JSON.stringify(e)));
    nLog.forEach(e => { const k = JSON.stringify(e); if (!pSet.has(k)) ops.push({ op: 'worldLog.append', payload: { entry: clone(e) } }); });

    return ops;
  }

  function commit(store, conv, opt) {
    opt = opt || {};
    if (!conv || !conv.id) return conv;
    let s = sessionMap(store).get(conv.id);
    if (!s || s.store !== store) {
      const r = loadState(store, conv.id);
      if (r) s = attachSession(store, conv.id, r.state, r);
      else {
        /* 新会话：snapshot(upTo=0) + 由当前状态生成的全量 op，不写整份正文 */
        const dev = ensureDev(store);
        const snap = { format: FORMAT, upToLamport: 0, messages: [], chapters: [], affect: null, ledger: [], worldRef: null, id: conv.id, meta: { id: conv.id } };
        store.set(snapshotKey(conv.id), snap);
        store.writeJsonl(logKey(conv.id), []);
        writePointer(store, conv);
        s = attachSession(store, conv.id, emptyState(conv.id), { dev: dev });
        s.last = { id: conv.id, messages: [] };
      }
    }
    if (s.lastDirty || !s.last) s.last = toConv(s.state);
    s.lastDirty = false;
    const ops = diff(s.last, conv);
    if (ops.length) {
      const existing = readOps(store, conv.id) || [];
      const applied = [];
      ops.forEach(partial => {
        s.state.clock = (s.state.clock | 0) + 1;
        const op = { lamport: s.state.clock, dev: s.dev, op: partial.op, payload: partial.payload };
        applyOp(s.state, op);
        applied.push(op);
      });
      store.writeJsonl(logKey(conv.id), existing.concat(applied));
      applied.forEach(op => {
        s.logCount += 1;
        s.logBytes += JSON.stringify(op).length + 1;
      });
    }
    maybeCompact(s);
    s.last = toConv(s.state);
    /* 新会话更新元数据指针；已迁移旧文件保持只读 */
    const existing = store.get(legacyKey(conv.id), null);
    if (!existing || existing.format === FORMAT) writePointer(store, s.last);
    return s.last;
  }

  function exportLegacy(store, id) {
    const r = loadState(store, id);
    if (!r) {
      const legacy = store.get(legacyKey(id), null);
      return legacy && legacy.format !== FORMAT ? clone(legacy) : null;
    }
    return toConv(r.state, { legacy: true });
  }

  function exportLegacyJSON(store, id) {
    const c = exportLegacy(store, id);
    return c ? JSON.stringify(c, null, 2) : '';
  }

  function search(conv, query) {
    const t0 = nowMs();
    const q = String(query || '').trim().toLowerCase();
    const hits = [];
    if (!q) return { hits: hits, ms: nowMs() - t0 };
    if ((conv.title || '').toLowerCase().includes(q)) hits.push({ type: 'title', id: conv.id });
    (conv.messages || []).forEach((m, i) => {
      if (messageText(m).toLowerCase().includes(q) || String(m.role || '').toLowerCase() === q) {
        hits.push({ type: 'message', id: m.id, index: i });
      }
    });
    return { hits: hits, ms: nowMs() - t0 };
  }

  /* 两个内存 store / 两端会话：按 (lamport, dev) 合并且 LWW */
  function mergeStores(storeA, storeB, id) {
    const a = exportBatch(storeA, id, 0);
    const b = exportBatch(storeB, id, 0);
    importBatch(storeA, id, b);
    importBatch(storeB, id, a);
    return { a: load(storeA, id), b: load(storeB, id) };
  }

  function memStore(init) {
    const files = Object.assign({}, init || {});
    const api = {
      raw(n) { return Object.prototype.hasOwnProperty.call(files, n) ? files[n] : null; },
      rawSet(n, s) { files[n] = s; return true; },
      get(n, d) {
        const v = api.raw(n);
        if (v == null) return d;
        try { return JSON.parse(v); } catch (e) { return d; }
      },
      set(n, v) { return api.rawSet(n, JSON.stringify(v)); },
      del(n) { delete files[n]; },
      exists(n) { return api.raw(n) != null; },
      append(n, obj) {
        const line = (typeof obj === 'string' ? obj : JSON.stringify(obj)) + (typeof obj === 'string' && obj.endsWith('\n') ? '' : '\n');
        files[n] = (files[n] || '') + line;
        return true;
      },
      readJsonl(n) {
        const v = api.raw(n);
        if (v == null || v === '') return null;
        const items = [];
        String(v).split('\n').forEach(line => {
          if (!line) return;
          try { items.push(JSON.parse(line)); } catch (e) { /* skip */ }
        });
        return items;
      },
      writeJsonl(n, items) {
        const body = (items || []).map(x => JSON.stringify(x)).join('\n') + ((items || []).length ? '\n' : '');
        return api.rawSet(n, body);
      },
      list() { return Object.keys(files); },
      rename(from, to) { if (!Object.prototype.hasOwnProperty.call(files, from)) return false; files[to] = files[from]; delete files[from]; return true; },
      _files: files,
    };
    return api;
  }

  function clearSessions() { sessions._list.forEach(m => m.clear()); sessions._list.length = 0; }

  const api = {
    FORMAT, COMPACT_OPS, COMPACT_BYTES, DEVICE_FILE,
    snapshotKey, logKey, legacyKey, filesOf, isConvJsonName, isSnapName, isLogName, idFromName,
    clone, stampCmp, messageText,
    packChapters, unpackChapters, compressStr, decompressStr,
    applyOp, replay, convToOps, diff, extractChapters, extractLedger, extractMeta,
    takeSnapshot, stateFromSnapshot, toConv, exportLegacyConv: toConv,
    ensureDev, migrateLegacy, compactState, hasOplog,
    load, loadMeta, loadState, listConvIds, removeFiles, writePointer,
    push, commit, importBatch, exportBatch, stateToOps, mergeStores, exportLegacy, exportLegacyJSON,
    search, memStore, clearSessions, attachSession,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ConvLog = api;
})(typeof window !== 'undefined' ? window : globalThis);
