/* 结构化记忆（v0.11.0）：每 N 轮自动调用模型从最近对话中提取事实 / 事件 / 关系 / 细节，
 * 存成可编辑条目（按角色卡隔离，本地持久化 rp-memory.json），请求时只按关键词相关性注入少量条目。
 * 缓存友好：不改系统提示词 / L1–L3 前缀，只在最后一条用户消息末尾追加 [MEMORY_RECALL]（与 [STATE] / [MEMORY_UPDATE] 同属动态层）。
 * 提取失败只记录错误，不打断聊天。
 */
(function (root) {
  'use strict';
  const TYPES = ['fact', 'event', 'relation', 'detail'];
  const TYPE_CN = { fact: '事实', event: '事件', relation: '关系', detail: '细节' };
  const DEFAULTS = { interval: 20, window: 40, maxInject: 8, minScore: 1 };
  const FILE = 'rp-memory.json';

  const textOf = c => Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : String(c || '');
  const charKey = conv => conv && conv.personaId ? 'persona:' + conv.personaId : 'conv:' + (conv && conv.id);
  const norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  function appendToContent(c, add) {
    if (Array.isArray(c)) { const a = c.map(x => Object.assign({}, x)); a.push({ type: 'text', text: add }); return a; }
    return (c ? c + '\n\n' : '') + add;
  }
  function settingsOf(cfg) {
    const o = Object.assign({}, DEFAULTS, cfg || {});
    o.interval = Math.max(5, Math.min(200, o.interval | 0 || DEFAULTS.interval));
    o.maxInject = Math.max(0, Math.min(50, o.maxInject | 0));
    o.window = Math.max(o.interval, Math.min(200, o.window | 0 || DEFAULTS.window));
    return o;
  }

  /** 自动关键词：英文单词 + 中文词（不截断成长词的前 2 字；长段保留 2/3/4 字滑窗） */
  function autoKeywords(text) {
    const t = String(text || ''); const out = new Set();
    (t.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []).forEach(w => out.add(w.toLowerCase()));
    (t.match(/[\u4e00-\u9fff]{2,}/g) || []).forEach(seg => {
      if (seg.length <= 4) { out.add(seg); return; }
      // 长中文段：保留完整 4 字前缀 + 2/3/4 字滑窗，避免只剩无意义的前两字
      out.add(seg.slice(0, 4));
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i <= seg.length - n; i++) out.add(seg.slice(i, i + n));
      }
    });
    return [...out].slice(0, 16);
  }

  function buildExtractPrompt(turns, existing) {
    const conv = turns.map(m => (m.role === 'user' ? '用户' : '角色') + '：' + textOf(m.content).slice(0, 2000)).join('\n');
    const ex = (existing || []).slice(-40).map(e => '- [' + e.type + '] ' + e.text).join('\n');
    return '你是角色扮演对话的记忆整理器。从下面的最近对话中提取之后仍然重要的信息，输出 JSON 数组，不要输出其他内容。\n' +
      '每个元素：{"type":"fact|event|relation|detail","text":"一句话、第三人称、具体","keywords":["人名/地名/物品等 1-5 个"]}\n' +
      'fact=稳定事实（身份、设定、喜好）；event=发生的事件；relation=人物关系变化；detail=以后可能用到的细节（约定、物品、伏笔）。\n' +
      '只记录新的或有变化的信息；已有记忆里已经有的不要重复；最多 12 条；没有就输出 []。\n\n' +
      (ex ? '===== 已有记忆 =====\n' + ex + '\n\n' : '') + '===== 最近对话 =====\n' + conv;
  }

  /** 宽松解析模型输出：去代码块、截取第一个 JSON 数组 / 对象；也接受「- [类型] 文本」行格式 */
  function parseExtraction(raw) {
    let s = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    let arr = null;
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) { try { arr = JSON.parse(s.slice(a, b + 1)); } catch (e) { arr = null; } }
    if (!arr) { try { const o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); arr = o.items || o.memories || o.entries || null; } catch (e) { arr = null; } }
    if (!Array.isArray(arr)) {
      arr = s.split('\n').map(l => /^\s*[-*]\s*\[(\w+|[\u4e00-\u9fff]+)\]\s*(.+)$/.exec(l)).filter(Boolean).map(m => ({ type: m[1], text: m[2] }));
    }
    const rev = { 事实: 'fact', 事件: 'event', 关系: 'relation', 细节: 'detail' };
    return arr.filter(x => x && (typeof x === 'string' || x.text)).map(x => {
      if (typeof x === 'string') x = { text: x };
      let type = String(x.type || 'detail').toLowerCase(); type = rev[x.type] || type; if (!TYPES.includes(type)) type = 'detail';
      const text = String(x.text).trim().slice(0, 300);
      let kw = Array.isArray(x.keywords) ? x.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, 8) : [];
      if (!kw.length) kw = autoKeywords(text);
      return { type, text, keywords: kw };
    }).filter(x => x.text);
  }

  function bigrams(s) { const n = norm(s), g = new Set(); for (let i = 0; i < n.length - 1; i++) g.add(n.slice(i, i + 2)); return g; }
  function similarity(a, b) {
    const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
    let i = 0; A.forEach(x => { if (B.has(x)) i++; }); return i / Math.min(A.size, B.size);
  }
  /** 粗去重 / 合并：同类型且相似度 ≥0.8（或互相包含）视为同一条，保留更长文本、合并关键词 */
  function mergeEntries(list, incoming, at, src) {
    const out = (list || []).map(e => Object.assign({}, e)); let added = 0, merged = 0;
    let seq = out.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    (incoming || []).forEach(n => {
      const nn = norm(n.text);
      const hit = out.find(e => e.type === n.type && (norm(e.text) === nn || norm(e.text).includes(nn) || nn.includes(norm(e.text)) || similarity(e.text, n.text) >= 0.8));
      if (hit) {
        if (n.text.length > hit.text.length && !hit.edited) hit.text = n.text;
        hit.keywords = [...new Set([...(hit.keywords || []), ...(n.keywords || [])])].slice(0, 10);
        hit.updatedAt = at; merged++;
      } else {
        seq++; out.push({ id: 'm' + seq + '_' + (at % 100000), seq, type: n.type, text: n.text, keywords: n.keywords || [], createdAt: at, updatedAt: at, source: src || 'auto', pinned: false });
        added++;
      }
    });
    return { list: out, added, merged };
  }

  /** 相关性：关键词命中（权重 2，含中文子串互含）+ 文本 bigram 重叠；置顶条目始终注入。结果按 seq 排序，保证同一组条目注入文本稳定 */
  function selectRelevant(list, query, o) {
    o = settingsOf(o); const q = String(query || ''), qn = norm(q), qg = bigrams(q);
    // 查询侧也抽中文关键词，避免长句 norm 后关键词被「吃掉」匹配
    const qKeys = new Set(autoKeywords(q).map(norm).filter(Boolean));
    const scored = (list || []).filter(e => !e.disabled).map(e => {
      let s = 0;
      (e.keywords || []).forEach(k => {
        const kn = norm(k); if (!kn) return;
        if (qn.includes(kn) || kn.includes(qn) && qn.length >= 2) s += 2;
        else if ([...qKeys].some(qk => qk.includes(kn) || kn.includes(qk))) s += 2;
      });
      let ov = 0; bigrams(e.text).forEach(g => { if (qg.has(g)) ov++; }); s += Math.min(3, ov / 3);
      return { e, s: e.pinned ? 1e9 : s };
    }).filter(x => x.s >= o.minScore);
    scored.sort((a, b) => b.s - a.s || (b.e.seq || 0) - (a.e.seq || 0));
    return scored.slice(0, o.maxInject).map(x => x.e).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  }
  function renderInjection(entries) {
    if (!entries || !entries.length) return '';
    return '[MEMORY_RECALL]（相关记忆，只作参考，不要复述）\n' + entries.map(e => '- [' + (TYPE_CN[e.type] || e.type) + '] ' + e.text).join('\n');
  }
  /** 到了提取点？turns = 当前对话的用户轮数 */
  const shouldExtract = (turns, lastTurn, interval) => turns - (lastTurn | 0) >= interval;
  function toMemoryText(entries) { return entries.map(e => '- [' + (TYPE_CN[e.type] || e.type) + '] ' + e.text).join('\n'); }

  const RPMemory = { TYPES, TYPE_CN, DEFAULTS, FILE, settingsOf, autoKeywords, buildExtractPrompt, parseExtraction, similarity, mergeEntries, selectRelevant, renderInjection, shouldExtract, toMemoryText, charKey, textOf };

  // ---------------- 插件 ----------------
  const reg = root.Plugins && root.Plugins.registry;
  if (reg) {
    const ID = 'rpmemory';
    let cache = null; const running = new Set();
    const loadAll = host => cache || (cache = host.store.get(FILE, null) || {});
    const saveAll = (host, m) => { cache = m; host.store.set(FILE, m); };
    const bucket = (host, key) => { const all = loadAll(host); return (all[key] = all[key] || { entries: [], lastError: '' }); };
    const cfgOf = host => settingsOf(reg.config(host.settings(), ID));
    const userTurns = conv => (conv.messages || []).filter(m => m.role === 'user' && !m.error).length;

    async function extract(conv, host, manual) {
      const key = charKey(conv); if (running.has(key)) return { skipped: true };
      running.add(key);
      const o = cfgOf(host), cd = reg.convData(conv, ID), b = bucket(host, key);
      try {
        const msgs = (conv.messages || []).filter(m => (m.role === 'user' || m.role === 'assistant') && !m.error && !m.pending && !m.imageGen).slice(-o.window * 2);
        if (!msgs.length) return { added: 0 };
        const raw = await host.callModel(buildExtractPrompt(msgs, b.entries), { conv, usageType: 'memory', maxTokens: 2048 });
        const items = parseExtraction(raw);
        const r = mergeEntries(b.entries, items, Date.now(), manual ? 'manual' : 'auto');
        b.entries = r.list; b.lastError = ''; b.lastAt = Date.now();
        cd.lastTurn = userTurns(conv); host.saveConv(conv);
        saveAll(host, loadAll(host));
        return r;
      } catch (e) {
        b.lastError = String(e && e.message || e); saveAll(host, loadAll(host));
        cd.lastTurn = userTurns(conv); host.saveConv(conv); // 失败也推进，避免每轮重试烧钱；可手动重试
        if (manual) throw e; return { error: b.lastError };
      } finally { running.delete(key); }
    }
    RPMemory._extract = extract; RPMemory._reset = () => { cache = null; };

    reg.register({
      id: ID, icon: '🧠', name: '结构化记忆', version: '1.0.0', perConversation: false, defaultEnabled: false,
      desc: '每 N 轮（默认 20）自动用当前模型从最近对话提取事实 / 事件 / 关系变化 / 细节，存成可编辑条目（按角色卡跨对话共享，否则按对话）。请求时只按关键词相关性注入少量条目到最后一条消息末尾，不改系统提示词与缓存前缀；可一键写入 RP 缓存「记忆增量」再合并进长期记忆。提取失败不影响聊天。',
      hooks: {
        onBeforeRequest(ctx, host) {
          const msgs = ctx.messages || []; let idx = -1;
          for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { idx = i; break; }
          if (idx < 0) return ctx;
          const b = loadAll(host)[charKey(ctx.conv)]; if (!b || !b.entries.length) return ctx;
          const q = msgs.slice(Math.max(0, idx - 2), idx + 1).map(m => textOf(m.content)).join('\n');
          const sel = selectRelevant(b.entries, q, cfgOf(host)); const inj = renderInjection(sel);
          if (!inj) return ctx;
          msgs[idx] = Object.assign({}, msgs[idx], { content: appendToContent(msgs[idx].content, inj) });
          ctx.messages = msgs; ctx.meta.rpmemory = { ids: sel.map(e => e.id) };
          return ctx;
        },
        onAfterResponse(result, ctx, host) {
          if (!result || !result.ok || !ctx.conv) return;
          const o = cfgOf(host), cd = reg.convData(ctx.conv, ID);
          if (shouldExtract(userTurns(ctx.conv), cd.lastTurn, o.interval)) Promise.resolve().then(() => extract(ctx.conv, host, false)).then(r => { if (r && r.added && host.isCurrent(ctx.conv)) host.refresh(); }).catch(() => {});
        },
        headerBadges(conv, host) {
          const b = loadAll(host)[charKey(conv)]; if (!b || !b.entries.length) return [];
          return [{ text: '🧠' + b.entries.length, tone: b.lastError ? 'warn' : 'info', title: '结构化记忆 ' + b.entries.length + ' 条' + (b.lastError ? '（上次提取失败：' + b.lastError + '）' : ''), action: () => host.openPanel(ID) }];
        },
      },
      renderSettings(box, host) {
        const c = reg.config(host.settings(), ID), o = settingsOf(c);
        box.innerHTML = '<label class="hint">每多少轮自动提取一次 <input type="number" class="rm-int" min="5" max="200" value="' + o.interval + '"></label><br>' +
          '<label class="hint">每次注入最多条数 <input type="number" class="rm-max" min="0" max="50" value="' + o.maxInject + '"></label>';
        box.querySelector('.rm-int').onchange = e => { c.interval = +e.target.value; host.saveSettings(); };
        box.querySelector('.rm-max').onchange = e => { c.maxInject = +e.target.value; host.saveSettings(); };
      },
      renderPanel(box, host) {
        const conv = host.conv(); if (!conv) { box.innerHTML = '<div class="hint">请先打开一个对话</div>'; return; }
        const key = charKey(conv), b = bucket(host, key), o = cfgOf(host), cd = reg.convData(conv, ID), esc = host.esc;
        const left = Math.max(0, o.interval - (userTurns(conv) - (cd.lastTurn | 0)));
        const save = () => { saveAll(host, loadAll(host)); host.refresh(); };
        box.innerHTML = '<div class="hint">绑定：' + esc(conv.personaName ? '角色卡「' + conv.personaName + '」（跨对话共享）' : '本对话') + ' · ' + b.entries.length + ' 条 · 距下次自动提取 ' + left + ' 轮' +
          (b.lastError ? '<br>⚠ 上次提取失败：' + esc(b.lastError) : '') + '</div>' +
          '<div><button class="chip-btn accent rm-run">立即提取</button> <button class="chip-btn rm-add">新增条目</button> <button class="chip-btn rm-merge">选中写入记忆增量</button></div>' +
          b.entries.map((e, i) => '<div class="rm-item" data-i="' + i + '" style="border-top:1px solid var(--line,#ddd);padding:6px 0">' +
            '<label><input type="checkbox" class="rm-sel"> </label><select class="rm-type">' + TYPES.map(t => '<option value="' + t + '"' + (t === e.type ? ' selected' : '') + '>' + TYPE_CN[t] + '</option>').join('') + '</select> ' +
            '<label class="hint"><input type="checkbox" class="rm-pin"' + (e.pinned ? ' checked' : '') + '>置顶</label> <label class="hint"><input type="checkbox" class="rm-off"' + (e.disabled ? ' checked' : '') + '>停用</label> ' +
            '<button class="chip-btn danger rm-del">删除</button>' +
            '<textarea class="rm-text" rows="2" style="width:100%">' + esc(e.text) + '</textarea>' +
            '<input class="rm-kw" style="width:100%" placeholder="关键词，逗号分隔" value="' + esc((e.keywords || []).join(', ')) + '"></div>').join('');
        const item = el => b.entries[+el.closest('.rm-item').dataset.i];
        box.querySelectorAll('.rm-item').forEach(row => {
          const e = item(row);
          row.querySelector('.rm-type').onchange = ev => { e.type = ev.target.value; e.edited = true; save(); };
          row.querySelector('.rm-pin').onchange = ev => { e.pinned = ev.target.checked; save(); };
          row.querySelector('.rm-off').onchange = ev => { e.disabled = ev.target.checked; save(); };
          row.querySelector('.rm-text').onchange = ev => { e.text = ev.target.value.trim(); e.edited = true; e.updatedAt = Date.now(); save(); };
          row.querySelector('.rm-kw').onchange = ev => { e.keywords = ev.target.value.split(/[,，、\s]+/).filter(Boolean); e.edited = true; save(); };
          row.querySelector('.rm-del').onclick = () => { b.entries.splice(b.entries.indexOf(e), 1); save(); this.renderPanel(box, host); };
        });
        box.querySelector('.rm-add').onclick = () => { const r = mergeEntries(b.entries, [{ type: 'fact', text: '（新条目，请编辑）', keywords: [] }], Date.now(), 'manual'); b.entries = r.list; save(); this.renderPanel(box, host); };
        box.querySelector('.rm-run').onclick = async () => {
          host.toast('正在提取…');
          try { const r = await extract(conv, host, true); host.toast(r.skipped ? '正在提取中' : '新增 ' + (r.added || 0) + ' 条，合并 ' + (r.merged || 0) + ' 条'); } catch (e) { host.toast('提取失败：' + (e.message || e)); }
          this.renderPanel(box, host);
        };
        box.querySelector('.rm-merge').onclick = () => {
          const sel = [...box.querySelectorAll('.rm-item')].filter(r => r.querySelector('.rm-sel').checked).map(item);
          if (!sel.length) { host.toast('请先勾选条目'); return; }
          const R = root.RPCache; if (!R) { host.toast('未加载 RP 缓存模块'); return; }
          const d = reg.convData(conv, 'rpcache'); const st = d.state ? R.normalizeState(d.state) : R.newState();
          const cur = R.getBlock(st, 'delta').content;
          d.state = R.setBlock(st, 'delta', (cur ? cur + '\n' : '') + toMemoryText(sel), Date.now()).state;
          host.saveConv(conv); host.refresh();
          host.toast('已写入 RP「记忆增量」（不破坏缓存）；在 RP 面板点「合并进长期记忆」即可固化');
        };
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = RPMemory;
  else root.RPMemory = RPMemory;
})(typeof window !== 'undefined' ? window : globalThis);
