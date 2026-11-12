/* 世界模板（L1 设定库）：纯函数，可在 Node 中测试。块 id 与 RPCache.STATIC_DEFS 对齐。 */
(function (root) {
  'use strict';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /** 与 rpcache.js STATIC_DEFS 的 id 顺序一致 */
  const BLOCK_IDS = ['world', 'character', 'rules', 'format', 'fewshot', 'prohibit', 'style'];

  const BLOCK_META = {
    world: {
      title: '世界观',
      hint: '世界背景、地点、势力、魔法/科技规则。几乎不改。',
      placeholder: '例：星际联邦与边缘殖民星并存；超光速航行受跃迁门限制…',
    },
    character: {
      title: '角色卡',
      hint: '角色身份、性格、说话方式、人物关系。可写必须遵守的情感/语气（如：必须温柔回应、必须称呼对方为…）。',
      placeholder: '例：林晚，28 岁，私家侦探。口吻克制带干幽默。必须：对搭档保持信任与关心；吃醋时用玩笑掩饰。',
    },
    rules: {
      title: 'RP 规则',
      hint: '例如：NPC 不能读取玩家内心；NPC 只知道自己应该知道的信息；不替玩家决定行动。',
      placeholder: '例：不替玩家做决定；NPC 不知玩家内心独白；第三人称叙述…',
    },
    format: {
      title: '输出格式',
      hint: '回复格式、长度、人称、是否带动作描写等。',
      placeholder: '例：第三人称；动作放 *星号*；对白用中文引号；每轮 200–400 字…',
    },
    fewshot: {
      title: '示例对白',
      hint: '几段示例对话（Few-shot），展示期望文风。可写高兴/吃醋/紧张等情感对白样例。',
      placeholder: '例：\n用户：今天好累。\n角色：*把热茶推过去* 「先喝一口。我听着。」\n（吃醋）「……那家店人很多吗？你看起来挺开心。」',
    },
    prohibit: {
      title: '禁止事项',
      hint: '绝对不能出现的内容或行为。可写禁止的情感/互动（如：禁止无故冷淡、禁止突然分手、禁止 Orth 崩坏）。',
      placeholder: '例：禁止 Orth；禁止无铺垫的重大人设崩坏；禁止突然冷暴力或无故消失…',
    },
    style: {
      title: '写作风格',
      hint: '固定写作风格、语气、节奏。',
      placeholder: '例：偏文学短句；氛围感强；少形容词堆砌…',
    },
  };

  /** 与 rpcache.canonicalize 对齐，保证块 hash 与写入 RP 缓存后的内容一致 */
  function canonBlock(text) {
    let s = String(text == null ? '' : text);
    s = s.replace(/^\uFEFF/, '');
    s = s.replace(/\r\n?/g, '\n');
    s = s.replace(/[ \t\u00A0]+$/gm, '');
    s = s.replace(/\n{5,}/g, '\n\n\n');
    s = s.replace(/^\n+/, '').replace(/\n+$/, '');
    return s;
  }

  function hashBlock(text) {
    const s = canonBlock(text);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = Math.imul(h2 ^ c, 0x01000193);
    }
    return ('00000000' + (h1 >>> 0).toString(16)).slice(-8)
      + ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
  }

  function blockHashMap(blocks) {
    const src = blocks && typeof blocks === 'object' ? blocks : {};
    const out = {};
    BLOCK_IDS.forEach(id => { out[id] = hashBlock(src[id] || ''); });
    return out;
  }

  function normalizeChangelog(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map(e => ({
      version: (e && e.version) | 0,
      at: (e && e.at) || 0,
      note: String((e && e.note) || ''),
    })).filter(e => e.version > 0);
  }

  function emptyBlocks() {
    const o = {};
    BLOCK_IDS.forEach(id => { o[id] = ''; });
    return o;
  }

  function normalizeBlocks(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = emptyBlocks();
    BLOCK_IDS.forEach(id => { out[id] = canonBlock(src[id] != null ? src[id] : ''); });
    return out;
  }

  function normalizeWorld(w) {
    w = w || {};
    const blocks = normalizeBlocks(w.blocks);
    const blockHash = blockHashMap(blocks);
    let version = w.version | 0;
    if (version < 1) version = 1;
    let changelog = normalizeChangelog(w.changelog);
    if (!changelog.length) {
      changelog = [{ version, at: w.updatedAt || w.createdAt || 0, note: '创建' }];
    }
    return {
      id: w.id || 'w-' + uid(),
      emoji: String(w.emoji || '🌍').trim().slice(0, 4) || '🌍',
      name: String(w.name || '').trim() || '未命名世界',
      desc: String(w.desc || '').trim(),
      greeting: String(w.greeting || '').replace(/\r\n/g, '\n').trim(),
      blocks,
      blockHash,
      version,
      changelog,
      updatedAt: w.updatedAt || 0,
      createdAt: w.createdAt || 0,
    };
  }

  function defaultWorlds() { return []; }

  function blocksChanged(a, b) {
    const ha = (a && a.blockHash) || blockHashMap(a && a.blocks);
    const hb = (b && b.blockHash) || blockHashMap(b && b.blocks);
    return BLOCK_IDS.some(id => ha[id] !== hb[id]);
  }

  function upsert(list, item, note) {
    const n = normalizeWorld(item);
    const now = Date.now();
    if (!n.createdAt) n.createdAt = now;
    n.updatedAt = now;
    const i = (list || []).findIndex(x => x.id === n.id);
    const out = (list || []).slice();
    if (i >= 0) {
      const prev = normalizeWorld(list[i]);
      if (blocksChanged(prev, n)) {
        n.version = (prev.version || 1) + 1;
        n.changelog = (prev.changelog || []).concat([{ version: n.version, at: now, note: note || '更新设定' }]);
      } else {
        n.version = prev.version || 1;
        n.changelog = prev.changelog && prev.changelog.length ? prev.changelog : n.changelog;
        n.blockHash = prev.blockHash;
      }
      out[i] = Object.assign({}, list[i], n, { createdAt: list[i].createdAt || n.createdAt });
    } else {
      n.version = 1;
      n.changelog = [{ version: 1, at: now, note: note || '创建' }];
      out.push(n);
    }
    return out;
  }

  function duplicate(list, id) {
    const src = (list || []).find(x => x.id === id);
    if (!src) return list || [];
    const copy = normalizeWorld(Object.assign({}, JSON.parse(JSON.stringify(src)), {
      id: 'w-' + uid(), name: src.name + '（副本）', createdAt: 0, updatedAt: 0,
      version: 1, changelog: [],
    }));
    const i = list.indexOf(src);
    const out = list.slice();
    out.splice(i + 1, 0, copy);
    return out;
  }

  function remove(list, id) { return (list || []).filter(x => x.id !== id); }

  /** 世界开聊默认套用的内置模板 id */
  const WORLD_START_TEMPLATE_ID = 't-rp-immersive';

  /**
   * 解析内置沉浸式模板字段（templateId / Name / Emoji / fill 后的 systemPrompt）。
   * TemplatesApi 可显式传入；浏览器下回退到 root.Templates。
   */
  function immersiveFields(TemplatesApi) {
    const T = TemplatesApi || root.Templates;
    if (!T || typeof T.applyToConv !== 'function') return {};
    const list = typeof T.defaultTemplates === 'function' ? T.defaultTemplates()
      : (T.BUILTIN_TEMPLATES || []).map(t => (T.normalizeTemplate ? T.normalizeTemplate(Object.assign({}, t, { builtin: true })) : t));
    const tpl = (list || []).find(t => t && t.id === WORLD_START_TEMPLATE_ID);
    if (!tpl) return {};
    return T.applyToConv({}, tpl);
  }

  /**
   * 由世界模板生成新建对话字段（不含 messages）。
   * 自动套用内置「沉浸式 RP（全自动）」模板（含 date/time fill）。
   * 第四参 TemplatesApi 可选（Node 单测传入）；浏览器用全局 Templates。
   */
  function conversationFromWorld(world, providers, fallback, TemplatesApi) {
    const w = normalizeWorld(world);
    const fb = fallback || {};
    const prov = fb.providerId && (providers || []).find(x => x.id === fb.providerId);
    const providerId = prov ? prov.id : (fb.providerId || '');
    const model = fb.model || (prov && (prov.models || [])[0]) || '';
    return Object.assign({
      providerId, model,
      worldId: w.id, worldName: w.name, worldEmoji: w.emoji,
      title: (w.emoji + ' ' + w.name).trim(),
    }, immersiveFields(TemplatesApi));
  }

  /**
   * 将世界各 L1 块写入 RP 状态。setBlock 形如 RPCache.setBlock。
   * 返回最终 state（以及是否至少有一块发生变更）。
   */
  function applyWorldToState(state, world, at, setBlock) {
    if (typeof setBlock !== 'function') throw new Error('需要 setBlock');
    const w = normalizeWorld(world);
    let st = state;
    let any = false;
    BLOCK_IDS.forEach(id => {
      const r = setBlock(st, id, w.blocks[id] || '', at);
      st = r.state;
      if (r.changed) any = true;
    });
    return { state: st, changed: any };
  }

  /**
   * 为对话准备「启用 RP + 写入块」后的 plugins.rpcache 片段。
   * 调用方：newConv 后 Object.assign 字段，再合并此结果到 conv.plugins。
   */
  function applyWorldToConversation(conv, world, RPCache, at) {
    if (!conv || !RPCache) throw new Error('需要 conv 与 RPCache');
    const w = normalizeWorld(world);
    const t = at || Date.now();
    const plugins = Object.assign({}, conv.plugins || {});
    const data = Object.assign({}, plugins.rpcache || {});
    data.enabled = true;
    let st = data.state ? RPCache.normalizeState(data.state) : RPCache.newState();
    const applied = applyWorldToState(st, w, t, RPCache.setBlock);
    data.state = applied.state;
    // system/base：沿用对话现有 systemPrompt（newConv 已写入全局设定），显式 sync 一次以便 static 指纹一致
    if (typeof RPCache.syncBase === 'function') {
      data.state = RPCache.syncBase(data.state, conv.systemPrompt || '');
    }
    plugins.rpcache = data;
    return {
      conv: Object.assign({}, conv, {
        worldId: w.id, worldName: w.name, worldEmoji: w.emoji,
        worldRef: makeWorldRef(w, t),
        worldPending: {},
        plugins,
      }),
      changed: applied.changed,
    };
  }


  function makeWorldRef(world, at) {
    const w = normalizeWorld(world);
    return {
      id: w.id,
      version: w.version,
      blockHash: Object.assign({}, w.blockHash),
      syncedAt: at || Date.now(),
    };
  }

  function normalizeWorldRef(ref) {
    if (!ref || typeof ref !== 'object') return null;
    const blockHash = {};
    const src = ref.blockHash && typeof ref.blockHash === 'object' ? ref.blockHash : {};
    BLOCK_IDS.forEach(id => {
      if (src[id] != null && src[id] !== '') blockHash[id] = String(src[id]);
    });
    return {
      id: String(ref.id || ''),
      version: ref.version | 0,
      blockHash,
      syncedAt: ref.syncedAt || 0,
    };
  }

  function getConvBlocks(conv, RPCache) {
    const out = emptyBlocks();
    const st = conv && conv.plugins && conv.plugins.rpcache && conv.plugins.rpcache.state;
    if (!st || !RPCache || typeof RPCache.getBlock !== 'function') return out;
    BLOCK_IDS.forEach(id => {
      const b = RPCache.getBlock(st, id);
      out[id] = b && b.content != null ? String(b.content) : '';
    });
    return out;
  }

  function normalizePending(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    BLOCK_IDS.forEach(id => {
      if (raw[id] != null && String(raw[id]).length) out[id] = canonBlock(raw[id]);
    });
    return out;
  }

  /**
   * 三路合并：base = 对话同步时的模板块，current = 对话当前块，theirs = 新模板块。
   * 冲突时保留 current，theirs 写入 _pending。
   */
  function merge3(base, current, theirs) {
    const b = canonBlock(base);
    const c = canonBlock(current);
    const t = canonBlock(theirs);
    if (c === b) return { content: t, action: 'takeTheirs' };
    if (c === t) return { content: c, action: 'unchanged' };
    if (b === t) return { content: c, action: 'keepCurrent' };
    return { content: c, action: 'conflict', _pending: t };
  }

  /**
   * 按块分类。worldRef 缺失（老对话）时，无法还原 base：current==theirs 视为无需变更，否则保守标为冲突。
   */
  function classifyBlock(id, current, theirs, worldRef) {
    const c = canonBlock(current);
    const t = canonBlock(theirs);
    const ref = normalizeWorldRef(worldRef);
    const refHash = ref && ref.blockHash ? ref.blockHash[id] : undefined;
    const hasBase = refHash != null;
    const curHash = hashBlock(c);
    const theirsHash = hashBlock(t);
    const drifted = !hasBase || refHash !== theirsHash;
    if (!hasBase) {
      if (c === t) return { id, action: 'unchanged', content: c, drifted: false, locallyEdited: false };
      return { id, action: 'conflict', content: c, _pending: t, drifted: true, locallyEdited: true };
    }
    const currentEqualsBase = curHash === refHash;
    const currentEqualsTheirs = curHash === theirsHash;
    const baseEqualsTheirs = refHash === theirsHash;
    if (currentEqualsTheirs) return { id, action: 'unchanged', content: c, drifted: !baseEqualsTheirs, locallyEdited: !currentEqualsBase };
    if (currentEqualsBase) return { id, action: 'takeTheirs', content: t, drifted: !baseEqualsTheirs, locallyEdited: false };
    if (baseEqualsTheirs) return { id, action: 'keepCurrent', content: c, drifted: false, locallyEdited: true };
    return { id, action: 'conflict', content: c, _pending: t, drifted: true, locallyEdited: true };
  }

  function detectDrift(conv, world, currentBlocks) {
    const w = normalizeWorld(world);
    const blocks = currentBlocks || (conv && conv._blocks) || emptyBlocks();
    const ref = normalizeWorldRef(conv && conv.worldRef);
    const classified = BLOCK_IDS.map(id => classifyBlock(id, blocks[id], w.blocks[id], ref));
    const ids = classified.filter(x => x.drifted).map(x => x.id);
    const drift = {};
    ids.forEach(id => { drift[id] = true; });
    return {
      drift,
      ids,
      classified,
      world: w,
      ref,
      stale: ids.length > 0 || !ref || ref.version !== w.version || (ref.id && ref.id !== w.id),
    };
  }

  function blockTitle(id) {
    return (BLOCK_META[id] && BLOCK_META[id].title) || id;
  }

  /** 「模板已更新到 v4：世界观、禁止事项 2 块有新内容；角色卡你本地改过，将保留」 */
  function formatDriftMessage(report, world) {
    const w = world || (report && report.world) || {};
    const ver = w.version | 0;
    const list = (report && report.classified) || [];
    const fresh = list.filter(x => x.action === 'takeTheirs');
    const kept = list.filter(x => x.action === 'conflict' || (x.locallyEdited && x.drifted));
    const parts = ['模板已更新到 v' + ver];
    const bits = [];
    if (fresh.length) {
      bits.push(fresh.map(x => blockTitle(x.id)).join('、') + ' ' + fresh.length + ' 块有新内容');
    }
    if (kept.length) {
      bits.push(kept.map(x => blockTitle(x.id)).join('、') + (kept.length === 1 ? '块' : '') + '你本地改过，将保留');
    }
    if (!bits.length && report && report.ids && report.ids.length) {
      bits.push(report.ids.map(blockTitle).join('、') + ' 有变更');
    }
    return parts[0] + (bits.length ? '：' + bits.join('；') : '');
  }

  function snapshotBlocks(blocks, ids) {
    const src = blocks || {};
    const out = {};
    (ids || BLOCK_IDS).forEach(id => { out[id] = canonBlock(src[id] || ''); });
    return out;
  }

  /**
   * 规划一次同步。mode:
   *   merge     — 仅同步未改动的块（冲突保留 current，theirs 进 _pending）
   *   overwrite — 全部覆盖为新模板
   *   skip      — 不同步
   */
  function planSync(conv, world, currentBlocks, mode) {
    const w = normalizeWorld(world);
    const blocks = currentBlocks || emptyBlocks();
    const report = detectDrift(Object.assign({}, conv, { worldRef: conv && conv.worldRef }), w, blocks);
    const m = mode || 'merge';
    const nextBlocks = Object.assign({}, blocks);
    const pending = normalizePending(conv && conv.worldPending);
    const changed = [];
    if (m === 'skip') {
      return {
        mode: 'skip',
        world: w,
        report,
        nextBlocks,
        pending,
        changed,
        message: formatDriftMessage(report, w),
        worldRef: conv && conv.worldRef ? normalizeWorldRef(conv.worldRef) : null,
        skipVersion: w.version,
      };
    }
    report.classified.forEach(row => {
      if (m === 'overwrite') {
        if (canonBlock(blocks[row.id] || '') !== canonBlock(w.blocks[row.id] || '')) changed.push(row.id);
        nextBlocks[row.id] = w.blocks[row.id] || '';
        delete pending[row.id];
        return;
      }
      // merge
      if (row.action === 'takeTheirs') {
        nextBlocks[row.id] = row.content;
        delete pending[row.id];
        changed.push(row.id);
      } else if (row.action === 'conflict') {
        nextBlocks[row.id] = row.content;
        pending[row.id] = row._pending;
      } else {
        nextBlocks[row.id] = row.content;
        if (row.action !== 'unchanged') delete pending[row.id];
      }
    });
    return {
      mode: m,
      world: w,
      report,
      nextBlocks,
      pending,
      changed,
      message: formatDriftMessage(report, w),
      worldRef: makeWorldRef(w, 0),
      skipVersion: undefined,
    };
  }

  function applyBlockMap(conv, blocks, RPCache, at, ids) {
    const plugins = Object.assign({}, conv.plugins || {});
    const data = Object.assign({}, plugins.rpcache || {});
    data.enabled = true;
    let st = data.state ? RPCache.normalizeState(data.state) : RPCache.newState();
    let any = false;
    const targets = ids || BLOCK_IDS;
    targets.forEach(id => {
      const r = RPCache.setBlock(st, id, blocks[id] || '', at);
      st = r.state;
      if (r.changed) any = true;
    });
    if (typeof RPCache.syncBase === 'function') {
      st = RPCache.syncBase(st, conv.systemPrompt || '');
    }
    data.state = st;
    plugins.rpcache = data;
    return { plugins, changed: any, state: st };
  }

  function applySyncToConversation(conv, world, RPCache, opts) {
    if (!conv || !RPCache) throw new Error('需要 conv 与 RPCache');
    opts = opts || {};
    const mode = opts.mode || 'merge';
    const t = opts.at || Date.now();
    const w = normalizeWorld(world);
    const current = getConvBlocks(conv, RPCache);
    const plan = planSync(conv, w, current, mode);
    const beforeRef = normalizeWorldRef(conv.worldRef);
    const beforePending = normalizePending(conv.worldPending);
    if (mode === 'skip') {
      const log = {
        at: t,
        from: beforeRef ? beforeRef.version : 0,
        to: w.version,
        blocks: [],
        mode: 'skip',
        before: { worldRef: beforeRef, blocks: snapshotBlocks(current, []), pending: beforePending },
        after: { worldRef: beforeRef, blocks: snapshotBlocks(current, []), pending: beforePending },
      };
      return {
        conv: Object.assign({}, conv, {
          worldId: w.id, worldName: w.name, worldEmoji: w.emoji,
          worldSkipVersion: w.version,
          worldLog: (conv.worldLog || []).concat([log]),
        }),
        plan,
        changed: false,
      };
    }
    const ids = mode === 'overwrite' ? BLOCK_IDS.slice() : plan.changed.concat(Object.keys(plan.pending));
    const uniqueIds = BLOCK_IDS.filter(id => ids.indexOf(id) >= 0 || plan.changed.indexOf(id) >= 0);
    const applied = applyBlockMap(conv, plan.nextBlocks, RPCache, t, mode === 'overwrite' ? BLOCK_IDS : uniqueIds);
    const nextRef = makeWorldRef(w, t);
    const log = {
      at: t,
      from: beforeRef ? beforeRef.version : 0,
      to: w.version,
      blocks: mode === 'overwrite' ? BLOCK_IDS.slice() : plan.changed.slice(),
      mode,
      before: {
        worldRef: beforeRef,
        blocks: snapshotBlocks(current, BLOCK_IDS),
        pending: beforePending,
        skipVersion: conv.worldSkipVersion || 0,
      },
      after: {
        worldRef: nextRef,
        blocks: snapshotBlocks(plan.nextBlocks, BLOCK_IDS),
        pending: plan.pending,
      },
    };
    return {
      conv: Object.assign({}, conv, {
        worldId: w.id, worldName: w.name, worldEmoji: w.emoji,
        worldRef: nextRef,
        worldPending: plan.pending,
        worldSkipVersion: 0,
        worldLog: (conv.worldLog || []).concat([log]),
        plugins: applied.plugins,
      }),
      plan,
      changed: applied.changed || plan.changed.length > 0,
    };
  }

  /** 采用某块的 _pending（模板方可选用），保留审计 */
  function applyPendingBlock(conv, blockId, RPCache, at) {
    if (!conv || !RPCache) throw new Error('需要 conv 与 RPCache');
    const pending = normalizePending(conv.worldPending);
    if (!pending[blockId]) return { conv, changed: false };
    const t = at || Date.now();
    const current = getConvBlocks(conv, RPCache);
    const next = Object.assign({}, current, { [blockId]: pending[blockId] });
    const rest = Object.assign({}, pending);
    delete rest[blockId];
    const applied = applyBlockMap(conv, next, RPCache, t, [blockId]);
    const ref = normalizeWorldRef(conv.worldRef) || { id: conv.worldId || '', version: 0, blockHash: {}, syncedAt: t };
    const nextRef = Object.assign({}, ref, {
      blockHash: Object.assign({}, ref.blockHash, { [blockId]: hashBlock(next[blockId]) }),
      syncedAt: t,
    });
    const log = {
      at: t,
      from: ref.version,
      to: ref.version,
      blocks: [blockId],
      mode: 'pending',
      before: { worldRef: ref, blocks: snapshotBlocks(current, [blockId]), pending: pending },
      after: { worldRef: nextRef, blocks: snapshotBlocks(next, [blockId]), pending: rest },
    };
    return {
      conv: Object.assign({}, conv, {
        worldRef: nextRef,
        worldPending: rest,
        worldLog: (conv.worldLog || []).concat([log]),
        plugins: applied.plugins,
      }),
      changed: true,
    };
  }

  /**
   * 回滚到某次同步之前（同时撤销该次及之后的同步）。
   * logIndex 默认最后一条。
   */
  function rollbackWorldLog(conv, RPCache, opts) {
    if (!conv || !RPCache) throw new Error('需要 conv 与 RPCache');
    const log = Array.isArray(conv.worldLog) ? conv.worldLog : [];
    if (!log.length) return { conv, changed: false, reason: 'empty' };
    const idx = opts && opts.index != null ? opts.index : log.length - 1;
    if (idx < 0 || idx >= log.length) return { conv, changed: false, reason: 'index' };
    const entry = log[idx];
    const t = (opts && opts.at) || Date.now();
    const current = getConvBlocks(conv, RPCache);
    const before = entry.before || {};
    const restoreBlocks = Object.assign({}, current, before.blocks || {});
    const ids = Object.keys(before.blocks || {});
    const applied = applyBlockMap(conv, restoreBlocks, RPCache, t, ids.length ? ids : BLOCK_IDS);
    return {
      conv: Object.assign({}, conv, {
        worldRef: before.worldRef || null,
        worldPending: normalizePending(before.pending),
        worldSkipVersion: before.skipVersion || 0,
        worldLog: log.slice(0, idx),
        plugins: applied.plugins,
      }),
      changed: true,
      entry,
    };
  }

  function shouldShowDrift(conv, world, currentBlocks) {
    const report = detectDrift(conv, world, currentBlocks);
    const pending = normalizePending(conv && conv.worldPending);
    const hasPending = Object.keys(pending).length > 0;
    if (!report.ids.length && !hasPending) return Object.assign({ show: false, pending }, report);
    const skip = conv && conv.worldSkipVersion;
    const ver = report.world.version;
    if (skip && skip === ver && !hasPending) {
      return Object.assign({ show: false, skipped: true, pending }, report);
    }
    return Object.assign({ show: true, pending }, report);
  }

  function greetingMessage(world, conv, now, idFn) {
    const g = normalizeWorld(world).greeting;
    if (!g || !conv || (conv.messages && conv.messages.length)) return null;
    return { id: idFn ? idFn() : 'm-' + uid(), role: 'assistant', content: g, model: conv.model, createdAt: now || Date.now() };
  }

  function filledBlockCount(world) {
    const b = normalizeWorld(world).blocks;
    return BLOCK_IDS.filter(id => (b[id] || '').trim()).length;
  }

  /* ---------- v0.28.7：一键粘贴完整设定 → 拆到各块；当前世界 → 一段分节全文 ---------- */
  /** 与「角色卡 Skill」/ AutoChar 输出一致的标题字面 */
  const SECTION_TITLES = { world: '世界观', character: '角色卡', rules: 'RP规则', format: '输出格式', fewshot: '示例对白', prohibit: '禁止事项', style: '写作风格' };
  const KEEP_MARK = '\u2063'; // 不可见分隔符：保护正文里的小标题不被 parseSections 当成段落切断
  const KNOWN_HEAD = /^(世界观|世界背景|背景设定|世界设定|角色卡|角色设定|人物设定|角色|RP ?规则|规则|扮演规则|输出格式|回复格式|格式|示例对白|示例对话|对白示例|禁止事项|禁止|写作风格|文风|风格|开场白|开场|开场旁白|精修说明|说明|备注)$/i;
  function protectSubheads(text) {
    return String(text || '').split('\n').map(line => {
      const m = line.match(/^\s*(?:#+\s*)?(?:\*\*)?【([^】]{1,12})】/) || line.match(/^\s{0,3}#{1,3}\s+([^\n]{1,12})\s*$/);
      if (m && !KNOWN_HEAD.test(m[1].trim())) return KEEP_MARK + line;
      return line;
    }).join('\n');
  }
  function unprotect(s) { return String(s || '').split(KEEP_MARK).join(''); }
  function pickParsers(parsers) {
    const p = parsers || {};
    const rp = p.RPCache || p.rpcache || (p.parseSections ? p : null) || root.RPCache || null;
    const ac = p.AutoChar || p.autochar || root.AutoChar || null;
    return { rp, ac };
  }
  /**
   * 解析粘贴的完整设定 → { blocks, greeting, name, fields }；少于 2 个可导入块返回 null（同 RPCache.parseSections）。
   * parsers：{ RPCache, AutoChar }（AutoChar 可选，用于容错标题 / 思考块 / 取姓名）。
   */
  function parseWorldSections(text, parsers) {
    const { rp, ac } = pickParsers(parsers);
    if (!rp || typeof rp.parseSections !== 'function') return null;
    let t = String(text || '');
    if (!t.trim()) return null;
    if (ac && typeof ac.normalize === 'function') t = ac.normalize(t);
    const raw = rp.parseSections(protectSubheads(t));
    if (!raw) return null;
    const fields = {};
    Object.keys(raw).forEach(k => { const v = canonBlock(unprotect(raw[k])); if (v) fields[k] = v; });
    const blocks = {};
    BLOCK_IDS.forEach(id => { if (fields[id]) blocks[id] = fields[id]; });
    if (Object.keys(blocks).length < 2) return null;
    let name = '';
    if (ac && typeof ac.charName === 'function') name = ac.charName(fields) || '';
    else {
      const m = String(fields.character || '').replace(/\*\*|__/g, '').match(/(?:姓名|名字|角色名)\s*[：:]\s*([^\n，,（(、；;/|]{1,20})/);
      name = m ? m[1].trim().replace(/[。.\s]+$/, '') : '';
    }
    return { blocks, greeting: fields.opening || '', name, fields };
  }
  const isBlank = v => !String(v == null ? '' : v).trim();
  /**
   * 把解析结果写进世界（表单值）：overwrite=false 只填空的块 / 开场白 / 名称；true 覆盖所有解析到的项。
   * 只处理解析到的键，不会清空其它字段。→ { world, filled, skipped, greetingFilled, nameFilled }
   */
  function applySectionsToWorld(world, parsed, opts) {
    const overwrite = !!(opts && opts.overwrite);
    const src = world && typeof world === 'object' ? world : {};
    const out = Object.assign({}, src, { blocks: Object.assign({}, src.blocks || {}) });
    const filled = [], skipped = [];
    let greetingFilled = false, nameFilled = false, greetingSkipped = false, nameSkipped = false;
    if (!parsed || !parsed.blocks) return { world: out, filled, skipped, greetingFilled, nameFilled, greetingSkipped, nameSkipped };
    BLOCK_IDS.forEach(id => {
      const v = parsed.blocks[id];
      if (isBlank(v)) return;
      if (!overwrite && !isBlank(out.blocks[id])) { if (canonBlock(out.blocks[id]) !== canonBlock(v)) skipped.push(id); return; }
      if (canonBlock(out.blocks[id]) === canonBlock(v)) return;
      out.blocks[id] = v; filled.push(id);
    });
    if (!isBlank(parsed.greeting)) {
      if (!overwrite && !isBlank(out.greeting)) { if (String(out.greeting).trim() !== String(parsed.greeting).trim()) greetingSkipped = true; }
      else if (String(out.greeting || '').trim() !== String(parsed.greeting).trim()) { out.greeting = parsed.greeting; greetingFilled = true; }
    }
    if (!isBlank(parsed.name)) {
      if (!overwrite && !isBlank(out.name)) { if (String(out.name).trim() !== String(parsed.name).trim()) nameSkipped = true; }
      else if (String(out.name || '').trim() !== String(parsed.name).trim()) { out.name = parsed.name; nameFilled = true; }
    }
    return { world: out, filled, skipped, greetingFilled, nameFilled, greetingSkipped, nameSkipped };
  }
  /** 当前世界 → 一段【世界观】【角色卡】…【开场白】全文；空块省略 */
  function formatWorldSections(world) {
    const w = world && typeof world === 'object' ? world : {};
    const b = w.blocks || {};
    const parts = [];
    BLOCK_IDS.forEach(id => { const v = canonBlock(b[id]); if (v.trim()) parts.push('【' + SECTION_TITLES[id] + '】\n' + v); });
    const g = canonBlock(w.greeting);
    if (g.trim()) parts.push('【开场白】\n' + g);
    return parts.join('\n\n');
  }
  function sectionTitle(id) { return id === 'opening' ? '开场白' : (SECTION_TITLES[id] || id); }

  const api = {
    BLOCK_IDS, BLOCK_META, emptyBlocks, normalizeBlocks, normalizeWorld,
    defaultWorlds, upsert, duplicate, remove, blocksChanged,
    canonBlock, hashBlock, blockHashMap, makeWorldRef, normalizeWorldRef,
    getConvBlocks, normalizePending, merge3, classifyBlock, detectDrift,
    formatDriftMessage, planSync, applySyncToConversation, applyPendingBlock,
    rollbackWorldLog, shouldShowDrift, blockTitle,
    WORLD_START_TEMPLATE_ID, immersiveFields, conversationFromWorld, applyWorldToState, applyWorldToConversation, greetingMessage, filledBlockCount,
    SECTION_TITLES, parseWorldSections, applySectionsToWorld, formatWorldSections, sectionTitle,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Worlds = api;
})(typeof window !== 'undefined' ? window : globalThis);
