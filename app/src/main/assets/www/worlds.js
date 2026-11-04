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

  function emptyBlocks() {
    const o = {};
    BLOCK_IDS.forEach(id => { o[id] = ''; });
    return o;
  }

  function normalizeBlocks(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = emptyBlocks();
    BLOCK_IDS.forEach(id => { out[id] = String(src[id] != null ? src[id] : '').replace(/\r\n/g, '\n'); });
    return out;
  }

  function normalizeWorld(w) {
    w = w || {};
    return {
      id: w.id || 'w-' + uid(),
      emoji: String(w.emoji || '🌍').trim().slice(0, 4) || '🌍',
      name: String(w.name || '').trim() || '未命名世界',
      desc: String(w.desc || '').trim(),
      greeting: String(w.greeting || '').replace(/\r\n/g, '\n').trim(),
      blocks: normalizeBlocks(w.blocks),
      updatedAt: w.updatedAt || 0,
      createdAt: w.createdAt || 0,
    };
  }

  function defaultWorlds() { return []; }

  function upsert(list, item) {
    const n = normalizeWorld(item);
    const now = Date.now();
    if (!n.createdAt) n.createdAt = now;
    n.updatedAt = now;
    const i = (list || []).findIndex(x => x.id === n.id);
    const out = (list || []).slice();
    if (i >= 0) out[i] = Object.assign({}, list[i], n, { createdAt: list[i].createdAt || n.createdAt });
    else out.push(n);
    return out;
  }

  function duplicate(list, id) {
    const src = (list || []).find(x => x.id === id);
    if (!src) return list || [];
    const copy = normalizeWorld(Object.assign({}, JSON.parse(JSON.stringify(src)), {
      id: 'w-' + uid(), name: src.name + '（副本）', createdAt: 0, updatedAt: 0,
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
        plugins,
      }),
      changed: applied.changed,
    };
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

  const api = {
    BLOCK_IDS, BLOCK_META, emptyBlocks, normalizeBlocks, normalizeWorld,
    defaultWorlds, upsert, duplicate, remove,
    WORLD_START_TEMPLATE_ID, immersiveFields, conversationFromWorld, applyWorldToState, applyWorldToConversation, greetingMessage, filledBlockCount,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Worlds = api;
})(typeof window !== 'undefined' ? window : globalThis);
