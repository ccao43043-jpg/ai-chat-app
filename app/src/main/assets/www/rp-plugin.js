/* 内置插件：RP 缓存优化器 V3（DeepSeek / 千问；钩子 + 界面）与 Token 用量显示。依赖 plugins.js、rpcache.js
 * 设计文档：docs/plugins/deepseek-rp-cache-design-v1.md */
(function () {
  'use strict';
  const R = window.RPCache;
  const reg = window.Plugins.registry;
  const ID = 'rpcache';
  const pct = v => (v == null ? '—' : (v * 100).toFixed(v >= 0.9995 || v === 0 ? 0 : 1) + '%');
  const fmtN = n => (n == null ? '—' : n >= 1e8 ? (n / 1e8).toFixed(2) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(n >= 1e5 ? 1 : 2).replace(/\.?0+$/, '') + '万' : String(Math.round(n)));
  const ver = n => '第 ' + (n | 0) + ' 版';
  const reqNo = id => String(id || '').replace(/^req_/, '#');
  const num = n => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
  const fmtUsd = v => (v == null ? '—' : '$' + (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(3)));
  const tone = r => (r == null ? 'info' : r >= 0.7 ? 'ok' : r >= 0.3 ? 'warn' : 'bad');
  const fmtTime = t => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const SRC = { auto: '自动', manual: '手动生成', edit: '手动编辑', rollback: '回滚', merge: '合并', migrated: '旧版迁移' };

  const normalized = new WeakSet();
  /** 会话数据；状态只在第一次读取时补齐字段，之后保持同一个对象（界面持有的引用不会失效） */
  function data(conv) {
    const d = reg.convData(conv, ID);
    if (!d.state || !normalized.has(d.state)) { d.state = R.normalizeState(d.state); normalized.add(d.state); }
    return d;
  }
  function cfg(host) {
    const c = reg.config(host.settings(), ID);
    c.prices = c.prices && Object.keys(c.prices).length ? Object.assign({}, c.prices) : Object.assign({}, R.DEFAULT_PRICES);
    // 旧版本保存的价格没有 match 字段：补上默认匹配规则
    Object.keys(R.DEFAULT_PRICES).forEach(k => { if (c.prices[k] && c.prices[k].match == null) c.prices[k] = Object.assign({}, c.prices[k], { match: R.DEFAULT_PRICES[k].match }); });
    c.priceMode = c.priceMode || 'auto';
    c.auto_mode = c.auto_mode || 'rp'; // V3：rp = RP 类对话自动启用 · cache = 支持缓存的服务商上所有对话 · off = 只手动
    c.peak = Object.assign({}, R.DEFAULT_PEAK, c.peak || {});
    return c;
  }
  // v0.9.0：请求日志改为追加式 rplog_<id>.jsonl；旧 rplog_<id>.json 首次读取时迁移
  const logKey = conv => 'rplog_' + conv.id + '.jsonl';
  const oldLogKey = conv => 'rplog_' + conv.id + '.json';
  const logCache = new Map(); // convId → { logs, lines, prompts }（lines / prompts = 磁盘上的行数 / 含完整 prompt 的行数）
  const countPrompts = list => list.reduce((n, e) => n + (e && e.prompt ? 1 : 0), 0);
  const compactLogs = list => (list.length ? R.appendLog(list.slice(0, -1), list[list.length - 1]) : []);
  function loadLogs(host, conv) {
    const st = host.store;
    if (!st.append || !st.readJsonl) return st.get(oldLogKey(conv), []) || []; // 旧宿主（测试桩）：整文件 JSON
    const c = logCache.get(conv.id); if (c) return c.logs;
    let items = st.readJsonl(logKey(conv)), lines;
    if (items == null) {
      const old = st.get(oldLogKey(conv), null);
      items = Array.isArray(old) ? old : [];
      lines = -1; // 需要写出 jsonl
    } else lines = items.length;
    const logs = compactLogs(items);
    const ent = { logs, lines: logs.length, prompts: countPrompts(logs) };
    if (st.writeJsonl && (lines !== logs.length || countPrompts(items) !== ent.prompts)) {
      if (lines !== -1 || items.length) st.writeJsonl(logKey(conv), logs);
      if (lines === -1 && st.del) st.del(oldLogKey(conv));
    }
    logCache.set(conv.id, ent);
    return logs;
  }
  function saveLogAppend(host, conv, logs, entry) {
    const st = host.store;
    if (!st.append || !st.readJsonl) { st.set(oldLogKey(conv), logs); return; }
    const ent = logCache.get(conv.id) || { lines: 0, prompts: 0 };
    ent.logs = logs; ent.lines++; if (entry.prompt) ent.prompts++;
    // 只追加一行；磁盘上多出的旧行 / 旧 prompt 超过阈值时才整体压缩重写
    if (ent.lines > R.LOG_LIMIT_RP + 50 || ent.prompts > R.PROMPT_KEEP + 10) { st.writeJsonl(logKey(conv), logs); ent.lines = logs.length; ent.prompts = countPrompts(logs); }
    else st.append(logKey(conv), entry);
    logCache.set(conv.id, ent);
  }
  function clearLogs(host, conv) {
    logCache.delete(conv.id);
    if (host.store.writeJsonl) host.store.writeJsonl(logKey(conv), []); else host.store.set(oldLogKey(conv), []);
  }
  const providerOf = (host, conv) => (host.provider ? host.provider(conv) : null) || null;
  /** 服务商适用性。DeepSeek / 千问 → 适用；其他服务商默认「不适用」（请求不改写），可在面板中强制启用 */
  function applicability(host, conv, provider, model) {
    const p = provider || providerOf(host, conv);
    const m = model != null ? model : conv.model;
    const cap = R.capability(p, m);
    const ok = cap.auto;
    const forced = !ok && !!data(conv).state.settings.force_enable;
    return { ok, forced, effective: ok || forced, provider: p, model: m, cap, claude: !!(p && p.type === 'anthropic') };
  }
  /** V3：像不像角色扮演对话（用于自动启用） */
  const RP_WORDS = /角色扮演|扮演|role\s*-?play|\bRP\b|人设|世界观|角色卡|跑团|NPC|剧情|你是[^。\n]{0,20}(角色|少女|少年|骑士|魔法)/i;
  function rpLike(conv) {
    const d = conv.plugins && conv.plugins[ID];
    const st = d && d.state;
    if (st && ((st.blocks || []).some(b => b.content) || (st.chapters || []).length)) return true; // 已经在用分层设定 / 章节
    if (/character/i.test(conv.model || '')) return true;
    if (RP_WORDS.test(String(conv.systemPrompt || '').slice(0, 4000))) return true;
    const fu = (conv.messages || []).find(m => m.role === 'user' && !m.error); // v0.7.4：首条消息写的是角色 / 世界设定也算
    return !!(fu && RP_WORDS.test(String(fu.content || '').slice(0, 4000)));
  }
  /** v0.7.4：首条消息自动提取设定（全局 + 本对话两级开关，默认开启） */
  const extractOn = (host, conv) => reg.config(host.settings(), ID).auto_extract !== false && data(conv).state.settings.auto_extract !== false;
  function firstUserText(conv) {
    const us = (conv.messages || []).filter(m => m.role === 'user' && !m.error && !m.imageGen);
    return us.length ? { text: String(us[0].rpSent != null ? us[0].rpSent : us[0].content || ''), count: us.length } : { text: '', count: 0 };
  }
  const BLOCK_CN = id => (R.BLOCK_DEFS.find(d => d.id === id) || {}).title || id;
  /** 调用模型提取首条消息里的设定，只填空白块；失败只提示，不影响聊天
   *  v0.7.5：60 秒超时、支持时用 JSON 模式、解析失败重试一次；跳过正在编辑的块；提示里可「查看 / 撤销」 */
  const EXTRACT_TIMEOUT = 60000;
  /** 编辑器仍在页面上才算「正在编辑」 */
  function editingId(conv) { const e = plugin._editing; return e && e.conv === conv && (!e.ta || e.ta.isConnected !== false) ? e.id : null; }
  /** 后台任务完成后刷新面板；正在编辑时不重绘（避免冲掉未保存的输入） */
  function rerender(host, conv) { if (plugin._box && host.conv() === conv && !editingId(conv)) plugin._render(); }
  function extractErrText(e) {
    const m = String(e && e.message || e || '');
    if (/超时|timeout/i.test(m)) return '请求超时（' + EXTRACT_TIMEOUT / 1000 + ' 秒），可稍后在「分层设定」里手动提取';
    if (/JSON|解析/.test(m)) return '模型两次都没有返回可解析的 JSON，可换个模型后手动提取';
    return m.slice(0, 80) || '未知错误';
  }
  async function autoExtract(host, conv, text, manual) {
    const d = data(conv);
    d.state.autoExtract = Object.assign({}, manual ? d.state.autoExtract : null, { at: Date.now(), status: 'running', manual: !!manual });
    rerender(host, conv);
    const opts = { maxTokens: 2048, model: d.state.settings.summary_model || undefined, usageType: 'extract', timeoutMs: EXTRACT_TIMEOUT, jsonMode: true, conv };
    try {
      let fields = R.parseExtract(await host.callModel(R.buildExtractPrompt(text), opts));
      if (!fields) fields = R.parseExtract(await host.callModel(R.buildExtractPrompt(text) + '\n\n注意：上次输出无法解析。这次只输出一个合法的 JSON 对象，不要任何解释或代码块标记。', opts));
      if (!fields) throw new Error('模型没有返回可解析的 JSON');
      const ed = editingId(conv); // 用户正在编辑的块不动
      const skipped = ed && fields[ed] ? [ed] : [];
      if (ed) delete fields[ed];
      const st = data(conv).state;
      const before = {}; R.EXTRACT_FIELDS.forEach(k => { before[k] = R.getBlock(st, k).content; });
      const r = R.fillEmptyBlocks(st, fields, Date.now());
      const dd = data(conv);
      const snap = {}; r.filled.forEach(k => { snap[k] = { before: before[k], after: R.getBlock(r.state, k).content }; });
      dd.state = Object.assign({}, r.state, { autoExtract: { at: Date.now(), status: 'done', filled: r.filled, skipped, snapshot: snap, manual: !!manual } }); normalized.add(dd.state);
      host.saveConv(conv); if (host.conv() === conv) host.refresh && host.refresh();
      if (r.filled.length) host.toast('已根据首条消息填充 RP 设定：' + r.filled.map(BLOCK_CN).join('、'), [
        { label: '查看', onClick: () => host.openPanel(ID, 'blocks') },
        { label: '撤销', onClick: () => { const n = undoExtract(host, conv); host.toast(n ? '已撤销本次自动填充（' + n + ' 个块）' : '内容已被修改，没有可撤销的块'); } }]);
      else if (manual) host.toast(Object.keys(fields).length ? '没有空白的设定块需要填充（已填写的内容不会被覆盖）' : '首条消息里没有提取到设定');
      rerender(host, conv);
      return r.filled;
    } catch (e) {
      const dd = data(conv); dd.state.autoExtract = { at: Date.now(), status: 'error', error: extractErrText(e), manual: !!manual };
      host.saveConv(conv);
      host.toast('提取 RP 设定失败：' + extractErrText(e));
      rerender(host, conv);
      return null;
    }
  }
  /** v0.7.6/0.7.7：把「角色卡生成助手 / 精修」等输出的【世界观】【角色卡】…分段导入分层设定（可撤销）；opening 单独提示 */
  const SECTION_KEYS = ['world', 'character', 'rules', 'format', 'fewshot', 'prohibit', 'style'];
  function importSections(host, conv, text, opt) {
    opt = opt || {};
    const fields = typeof text === 'object' && text && text.world != null ? text : R.parseSections(text);
    if (!fields) { host.toast('没有找到【世界观】【角色卡】这样的分段标题（至少 2 段）'); return null; }
    const d = data(conv); const before = {}; SECTION_KEYS.forEach(k => { before[k] = R.getBlock(d.state, k).content; });
    let st = d.state, filled = [], overwritten = [];
    if (opt.overwrite) {
      SECTION_KEYS.forEach(k => {
        if (!fields[k]) return;
        const r = R.setBlock(st, k, fields[k], Date.now());
        if (r.changed) { st = r.state; filled.push(k); if (before[k]) overwritten.push(k); }
      });
    } else {
      const r = R.fillEmptyBlocks(st, fields, Date.now(), SECTION_KEYS);
      st = r.state; filled = r.filled;
    }
    const skipped = SECTION_KEYS.filter(k => fields[k] && before[k] && !opt.overwrite && filled.indexOf(k) < 0);
    const snap = {}; filled.forEach(k => { snap[k] = { before: before[k], after: R.getBlock(st, k).content }; });
    d.state = Object.assign({}, st, { autoExtract: { at: Date.now(), status: 'done', filled, skipped, snapshot: snap, manual: true, source: 'sections', opening: fields.opening || '' } }); normalized.add(d.state);
    host.saveConv(conv); host.refresh && host.refresh();
    const acts = [];
    if (filled.length) acts.push({ label: '撤销', onClick: () => { const n = undoExtract(host, conv); host.toast(n ? '已撤销导入（' + n + ' 个块）' : '内容已被修改，没有可撤销的块'); } });
    if (fields.opening) acts.push({ label: '复制开场白', onClick: () => { try { navigator.clipboard.writeText(fields.opening); host.toast('开场白已复制'); } catch (e) { host.toast(fields.opening.slice(0, 80)); } } });
    if (skipped.length && !opt.overwrite) acts.push({ label: '覆盖已有', onClick: () => importSections(host, conv, fields, { overwrite: true }) });
    if (filled.length) host.toast((opt.overwrite ? '已覆盖导入：' : '已导入分段设定：') + filled.map(BLOCK_CN).join('、') + (skipped.length && !opt.overwrite ? '（已跳过：' + skipped.map(BLOCK_CN).join('、') + '）' : '') + (fields.opening ? ' · 含开场白' : ''), acts);
    else if (fields.opening) host.toast('分层设定块都已有内容；开场白可单独复制', acts);
    else host.toast('对应的块都已有内容，没有覆盖', skipped.length ? [{ label: '覆盖已有', onClick: () => importSections(host, conv, fields, { overwrite: true }) }] : null);
    rerender(host, conv);
    return filled;
  }
  /** 撤销最近一次提取：只恢复仍是自动填充内容的块（用户之后改过的保留），返回恢复的块数 */
  function undoExtract(host, conv) {
    const d = data(conv); const ax = d.state.autoExtract;
    if (!ax || !ax.snapshot) return 0;
    let st = d.state, n = 0;
    Object.keys(ax.snapshot).forEach(k => {
      const s0 = ax.snapshot[k];
      if (R.getBlock(st, k).content !== s0.after) return;
      const r = R.setBlock(st, k, s0.before || '', Date.now()); if (r.changed) { st = r.state; n++; }
    });
    d.state = Object.assign({}, st, { autoExtract: Object.assign({}, ax, { status: 'undone', snapshot: null }) }); normalized.add(d.state);
    host.saveConv(conv); if (host.conv() === conv) host.refresh && host.refresh();
    rerender(host, conv);
    return n;
  }
  /** V3：自动启用判断（只在对话里没有手动开 / 关时调用） */
  function autoActive(conv, settings, host) {
    if (!host) return false;
    const c = reg.config(settings, ID); const mode = c.auto_mode || 'rp';
    if (mode === 'off') return false;
    const cap = R.capability(providerOf(host, conv), conv.model);
    if (!cap.auto) return false; // 不支持缓存 / 未验证的服务商：默认绝不改写请求
    return mode === 'cache' ? true : rpLike(conv);
  }
  /** V3：运行时自动策略（预算、缓存策略、空闲 / 命中率） */
  function envFor(host, conv, ap, logs, now) {
    now = now || Date.now();
    const c = cfg(host); const s = data(conv).state.settings;
    const p = ap.provider || {};
    const meta = p.modelMeta && p.modelMeta[ap.model];
    const cap = ap.cap || R.capability(p, ap.model);
    const rt = R.runtimeEnv(logs, now, cap);
    const strat = R.chooseStrategy(cap, s.cache_mode, rt.gapMedian);
    const model = s.summary_model || ap.model;
    return Object.assign({}, rt, { cap, budget: R.autoBudget(cap, ap.model, meta), strategy: strat.strategy, strategyWhy: strat.why,
      provider: p.presetId || p.id || '', model: ap.model, modality: 'text',
      calibMeta: { provider: p.presetId || p.id || '', model: ap.model, modality: 'text' },
      cost: { model: ap.model, summaryModel: model, prices: c.prices, mode: c.priceMode, peak: c.peak, at: now } });
  }
  /** V3：千问显式缓存断点：system 末尾（固定设定 + 记忆 + 章节）与稳定历史末尾；不足 1024 Token 的前缀不加，最多 4 个 */
  function placeMarkers(a, p, cap) {
    const ex = cap.explicit || { maxMarkers: 4, minTokens: 1024 };
    const k = p.calib || 1;
    const sysTok = p.tokens.static + p.tokens.memory + p.tokens.summary;
    const marks = { system: false, systemSplit: null, history: -1, count: 0 };
    if (sysTok >= ex.minTokens) { marks.system = true; marks.count++; }
    // C-2：summary|memory 交界再打一个断点（static+summary 稳定前缀够长、memory 非空、且仍留一个给历史）
    const stableTok = p.tokens.static + p.tokens.summary;
    const reserveHist = p.hist.length ? 1 : 0;
    if (marks.system && p.tokens.memory > 0 && stableTok >= ex.minTokens && marks.count + 1 + reserveHist <= ex.maxMarkers && p.stablePrefix
      && a.system && a.system.indexOf(p.stablePrefix) === 0 && a.system.length > p.stablePrefix.length) {
      marks.systemSplit = p.stablePrefix.length; marks.count++;
    }
    if (p.hist.length && sysTok + p.tokens.history >= ex.minTokens && marks.count < ex.maxMarkers) {
      const i = p.hist.length - 1; a.messages[i]._cache = true; marks.history = i; marks.count++;
    }
    return marks;
  }
  const effectiveFor = (host, conv) => applicability(host, conv).effective;

  /**
   * 请求项：用户消息「冻结」首次发送的内容（含当时的联网搜索 / 文件内容），以后每轮逐字节一致；动态状态不写入历史。
   * V2：重新生成最后一条回复时默认也沿用冻结的原文（不会因为重新搜索而改变）；开启「重新生成时刷新」才更新。
   */
  function toItems(ctx, refresh) {
    const info = { reused: false };
    const items = ctx.messages.map(m => {
      const src = m._src || {};
      let content = m.content || '';
      if (m.role === 'user') {
        if (src.rpSent == null || (src === ctx.lastUser && refresh)) src.rpSent = content;
        else { if (src === ctx.lastUser && src.rpSent !== content) info.reused = true; content = src.rpSent; }
      }
      return { id: src.id, role: m.role, content, images: m.images, _src: src };
    });
    return { items, info };
  }
  /** 不发请求时，用与发送相同的消息展开（宿主 requestItems）估算，界面数字与实际发送对齐 */
  function convItems(conv, host) {
    const base = host && host.requestItems ? host.requestItems(conv)
      : conv.messages.filter(m => !m.error && !m.imageGen && !m.pending).map(m => ({ role: m.role, content: m.content, images: m.images, _src: m }));
    return base.map(m => { const src = m._src || m; return { id: src.id, role: m.role, content: m.role === 'user' && src.rpSent != null ? src.rpSent : m.content, images: m.images }; });
  }
  function planConv(conv, host) { return planConvAuto(conv, host).p; }
  function costOpts(host, conv) { const c = cfg(host); return { model: conv.model, prices: c.prices, mode: c.priceMode, peak: c.peak, at: Date.now() }; }
  function planConvAuto(conv, host) {
    const d = data(conv); const ap = applicability(host, conv);
    const env = ap.effective ? envFor(host, conv, ap, loadLogs(host, conv)) : null;
    return { p: R.plan(d.state, conv.systemPrompt, convItems(conv, host), env), env, ap };
  }
  const costText = r => (r.usd != null ? '约 ' + fmtUsd(r.usd) : '≈' + fmtN(r.callIn + r.callOut + r.rebuild) + ' Token');

  /** 生成下一章（只总结本批新移出的旧对话）或合并全部章节；保存为冻结章节 */
  async function makeSummary(host, conv, p, source, setCancel, forceMerge) {
    const st = p.st;
    if (!p.batch.length && !forceMerge) throw new Error('没有可摘要的旧对话（最近 ' + st.settings.summary.keep_recent_turns + ' 轮始终保留原文）');
    const merge = forceMerge || p.needConsolidate;
    const chapters = R.chaptersOf(st);
    const memory = R.getBlock(st, 'memory').content;
    const prompt = merge ? R.buildConsolidatePrompt({ chapters, memory, batch: p.batch }) : R.buildSummaryPrompt({ chapters, memory, batch: p.batch });
    const text = await host.callModel(prompt, { maxTokens: 4096, model: st.settings.summary_model || undefined, setCancel });
    const r = R.parseSummary(text);
    if (!r.ok) {
      const miss = (r.critMissing && r.critMissing.length ? r.critMissing : r.missing) || [];
      throw new Error('模型返回的摘要格式不完整（缺少 ' + miss.join(' / ') + (r.quality != null ? '，质量 ' + r.quality : '') + '）');
    }
    const ids = p.batch.map(m => m.id).filter(Boolean);
    const sourceFp = R.chapterSourceFp(p.batch, ids);
    const o = { content: r.text, coveredIds: ids, at: Date.now(), source: merge ? 'merge' : source, rounds: p.batchRounds, atRound: p.rounds, sourceFp, quality: r.quality, parsed: r, batch: p.batch };
    if (merge) {
      const merged = R.consolidate(st, o);
      if (merged && merged.ok === false) throw new Error('章节合并被拒绝：' + (merged.reason || 'invalid') + (r.critMissing && r.critMissing.length ? '（缺 ' + r.critMissing.join('/') + '）' : ''));
      const state = (merged && merged.state) ? merged.state : merged;
      return { state, no: R.activeSummary(state).no, count: ids.length, missing: r.missing, quality: r.quality, sourceFp, merged: true, mergedCount: chapters.length };
    }
    const committed = R.commitChapter(st, o);
    if (!committed.ok) throw new Error('章节提交被拒绝：' + (committed.reason || 'invalid') + (r.critMissing && r.critMissing.length ? '（缺 ' + r.critMissing.join('/') + '）' : ''));
    return { state: committed.state, no: R.activeSummary(committed.state).no, count: ids.length, missing: r.missing, quality: r.quality, sourceFp, merged: false, mergedCount: 0 };
  }

  let coverMemo = { key: null, set: null };
  function coveredSet(st) {
    const ch = R.chaptersOf(st); const key = ch.map(c => c.no + ':' + c.coveredIds.length).join(',') || '-';
    if (coverMemo.key !== key) coverMemo = { key, set: new Set(R.coveredIds(st)) };
    return coverMemo.set;
  }

  const plugin = reg.register({
    id: ID, icon: '🎭', name: 'RP 缓存优化器（DeepSeek / 千问）', version: '3.6.0', perConversation: true, defaultEnabled: true, autoActive,
    desc: '长篇角色扮演专用的上下文构建器（默认对 DeepSeek、千问生效，RP 类对话自动启用；千问自动加显式缓存断点，预算按模型自动推导）：固定设定 → 长期记忆 → 冻结章节（只追加）→ 对话历史 → 记忆增量 → 当前状态 → 本轮输入；超出阈值自动追加章节，逐层指纹诊断与缓存命中监控。',
    hooks: {
      async onBeforeRequest(ctx, host) {
        const ap = applicability(host, ctx.conv, ctx.provider, ctx.model);
        if (!ap.effective) { ctx.meta.rp = { skipped: true }; return ctx; } // 不适用：请求逐字节不变
        const d = data(ctx.conv);
        // v0.7.5：首轮请求发出的同时后台提取设定（与第一条回复并行；重新生成不会重复触发）
        const fu = firstUserText(ctx.conv);
        if (fu.count === 1 && !d.state.autoExtract && extractOn(host, ctx.conv) && R.shouldAutoExtract(fu.text) && host.callModel) {
          plugin._lastExtract = autoExtract(host, ctx.conv, fu.text, false);
        }
        const base = ctx.systemPrompt;
        let st = R.syncBase(d.state, base);
        const ti = toItems(ctx, st.settings.refresh_on_regen);
        let items = ti.items;
        // v0.12：冷路径 — 修改世界书后勾选「立即重建」时完整重排冻结
        if (st.loreNeedsRebuild && typeof R.rebuildLore === 'function') {
          const rb = R.rebuildLore(st, items, Date.now(), { convId: ctx.conv && ctx.conv.id });
          st = rb.state || rb;
          host.toast('世界书已按新设定重建冻结片段（缓存可能未命中一次）');
        }
        // 热路径：触发条目首次触发 → 冻结到本轮用户消息末尾（不重排已冻结）；概率种子=convId+anchorId+entryId
        const fl = R.fireLore(st, items, Date.now(), { convId: ctx.conv && ctx.conv.id });
        if (!fl.fired.length && fl.state && fl.state.loreTrace) st = Object.assign({}, st, { loreTrace: fl.state.loreTrace }); // A4：未触发也保留 trace
        if (fl.fired.length) { st = fl.state; host.toast('世界书触发：' + fl.fired.map(r => r.name).join('、') + '（已冻结进本轮消息，之后位置固定）'); }
        if (ti.info.reused) host.toast('沿用这条消息首次发送的原文（含当时的联网 / 文件内容），以保持缓存；可在「预算设置」开启「重新生成时刷新」');
        const logs0 = loadLogs(host, ctx.conv);
        const env = envFor(host, ctx.conv, ap, logs0);
        let p = R.plan(st, base, items, env);
        const overBudget = p.overBudget;
        let summaryNo = 0, summaryReason = null, summaryError = null, summaryMerged = false, summaryCost = null;
        if (p.needSummary) {
          summaryReason = p.summaryReason;
          summaryCost = R.summaryCost(p, Object.assign(costOpts(host, ctx.conv), { warm: env.warm, model: st.settings.summary_model || ctx.model }));
          ctx.setStatus && ctx.setStatus(p.needConsolidate ? '章节过长，正在合并章节…' : '正在生成章节摘要…');
          try {
            const r = await makeSummary(host, ctx.conv, p, 'auto', ctx.setCancel);
            st = r.state; summaryNo = r.no; summaryMerged = r.merged;
            host.toast((r.merged ? '已把 ' + r.mergedCount + ' 个章节合并为 ' : '已追加章节 ') + R.slabel(r.no) + '（' + r.count + ' 条旧消息写入摘要，原文保留）· 额外花费' + costText(summaryCost));
          } catch (e) {
            summaryError = String(e && e.message || e);
            host.toast('章节摘要生成失败：' + summaryError);
          }
          ctx.setStatus && ctx.setStatus(null);
          p = R.plan(st, base, items, env);
        }
        let trimmedNow = false;
        if (p.overBudget) {
          // v0.16：摘要失败/超预算 → 临时裁剪，不得永久推进历史窗口
          const tmp = R.temporaryTrimPlan(st, p, { reason: summaryError ? 'summary_failed' : 'over_budget_temp', error: summaryError });
          st = tmp.state; p = tmp.plan; trimmedNow = true;
          host.toast('上下文超出预算，本轮临时只发送约 ' + fmtN(p.tokens.history) + ' Token 历史（窗口未永久裁剪，原文保留；摘要成功后会恢复）');
        }
        d.state = st; normalized.add(st);
        const a = R.assemble(p);
        let marks = null;
        if (ap.claude && ap.forced) {
          // Claude：system + 稳定历史末尾断点；providers.js 再按块数向前补历史锚点（总数 ≤ 4）
          ctx.opts = Object.assign({}, ctx.opts, { cacheControl: true });
          if (p.hist.length) a.messages[p.hist.length - 1]._cache = true;
        } else if (env.cap.vendor === 'qwen' && env.strategy === 'explicit') {
          // 千问显式缓存（DeepSeek 不走这里，请求结构与 v0.4 相同）
          marks = placeMarkers(a, p, env.cap);
          if (marks.count) ctx.opts = Object.assign({}, ctx.opts, { cacheControl: true, cacheSystem: marks.system, cacheSystemSplit: marks.systemSplit });
        }
        ctx.systemPrompt = a.system; ctx.messages = a.messages;
        if (R.buildSystemSegments) ctx.meta.rpSegments = R.buildSystemSegments(st, base); // v0.21.3 P6：结构化分层交给 gcache
        const fp = R.fingerprints(p, base);
        const prev = logs0[logs0.length - 1] || null;
        ctx.meta.rp = {
          fp, diag: R.diagnose(prev, fp, p.hist), tokens: p.tokens, overBudget, staticCause: st.pendingStaticCause || null, historyCause: st.pendingHistoryCause || null, trimmed: p.trimmed, trimmedNow,
          summaryNo, summaryReason, summaryError, summaryMerged, summaryCost, forced: ap.forced,
          cacheMode: env.strategy, marks, autoInfo: { vendor: env.cap.vendor, strategy: env.strategy, budget: p.settings.auto_budget !== false ? env.budget.source : 'manual',
            max_context: p.settings.max_context, trigger: p.settings.summary.trigger_tokens, idle: env.idleSec != null ? Math.round(env.idleSec) : null, cold: env.cold, adaptive: p.auto ? p.auto.why : null },
          prompt: st.settings.save_prompt ? { system: a.system, messages: a.messages.map(m => ({ role: m.role, content: m.content })) } : null,
        };
        if (summaryNo || trimmedNow) host.saveConv(ctx.conv);
        return ctx;
      },
      onAfterResponse(result, ctx, host) {
        if (!result.ok || !ctx.meta.rp || ctx.meta.rp.skipped) return;
        const info = ctx.meta.rp; const d = data(ctx.conv);
        const logs0 = loadLogs(host, ctx.conv);
        d.state.seq = (d.state.seq | 0) + 1;
        const entry = R.makeLogEntry({ request_id: 'req_' + String(d.state.seq).padStart(4, '0'), at: Date.now(), usage: result.usage, model: ctx.model,
          provider: ctx.provider.presetId || ctx.provider.id, fp: info.fp, diag: info.diag, tokens: info.tokens, summaryNo: info.summaryNo, summaryReason: info.summaryReason,
          summaryError: info.summaryError, summaryMerged: info.summaryMerged, summaryCost: info.summaryCost,
          staticCause: info.diag.static === 'CHANGED' ? info.staticCause : null, historyCause: info.diag.history === 'CHANGED' ? info.historyCause : null, overBudget: info.overBudget, trimmed: info.trimmed, msgId: result.bot && result.bot.id, prev: logs0[logs0.length - 1] || null,
          savePrompt: d.state.settings.save_prompt, prompt: info.prompt, cacheMode: info.cacheMode, autoInfo: info.autoInfo,
          loreEditedButFrozen: !!(d.state && d.state.loreEditedWhileFrozen) });
        let st = d.state;
        if (st.pendingStaticCause || st.pendingHistoryCause) st = Object.assign({}, st, { pendingStaticCause: null, pendingHistoryCause: null });
        // V2：用真实输入 Token 校准本地估算
        if (result.usage && result.usage.prompt) st = R.calibrate(st, info.tokens.raw_total, result.usage.prompt, { provider: (ctx.provider && (ctx.provider.presetId || ctx.provider.id)) || '', model: ctx.model || '', modality: 'text' });
        if (st !== d.state) { d.state = st; normalized.add(st); }
        const logs = R.appendLog(logs0, entry);
        saveLogAppend(host, ctx.conv, logs, entry);
        const an = R.detectAnomaly(logs);
        if (result.bot) result.bot.rpCache = { rate: entry.hit_rate, hit: entry.cache_hit_tokens, miss: entry.cache_miss_tokens, prompt: entry.prompt_tokens,
          supported: entry.supported, anomaly: an.anomaly, summaryNo: entry.summary_no, merged: entry.summary_merged, reason: entry.reason, req: entry.request_id };
        d.lastAnomaly = an.anomaly ? { at: entry.timestamp, avg: an.avg, current: an.current, causes: an.causes, changed: an.changed } : null;
        if (an.anomaly) host.toast('⚠ 缓存命中率骤降（' + pct(an.avg) + ' → ' + pct(an.current) + '），点消息上的徽章查看原因');
      },
      messageBadges(msg, conv, host) {
        if (msg.role !== 'assistant' || !msg.rpCache) return [];
        const c = msg.rpCache; const out = [];
        if (!c.supported) out.push({ text: '缓存 不支持统计', tone: 'info', title: '该服务商未返回缓存字段', action: () => host.openPanel(ID, 'monitor') });
        else out.push({ text: (c.anomaly ? '⚠ ' : '') + '缓存 ' + pct(c.rate), tone: c.anomaly ? 'bad' : tone(c.rate), title: '缓存命中 ' + c.hit + ' / 输入 ' + c.prompt + ' Token · ' + (c.reason || ''),
          action: () => host.openPanel(ID, 'monitor') });
        if (c.summaryNo) out.push({ text: (c.merged ? '📚 合并 ' : '📚 章节 ') + R.slabel(c.summaryNo), tone: 'info', title: c.merged ? '本次请求前合并了全部章节' : '本次请求前追加了新章节', action: () => host.openPanel(ID, 'summary') });
        return out;
      },
      headerBadges(conv, host) {
        // 顶栏只保留命中率（不适用 / 强制 / 章节 / 即将摘要等杂项不再显示）
        const ap = applicability(host, conv);
        if (!ap.effective) return [];
        const logs = loadLogs(host, conv); const last = logs[logs.length - 1];
        if (!last || !last.supported || last.hit_rate == null) return [];
        // E1：预算细线——上一轮输入 Token / 上下文预算上限
        const st0 = data(conv).state, cap = (st0 && st0.settings && st0.settings.max_context) || 0, used = last.prompt_tokens || last.est_tokens || 0;
        return [{ text: '命中 ' + pct(last.hit_rate), tone: tone(last.hit_rate), title: '缓存命中率（点击查看监控）', action: () => host.openPanel(ID, 'monitor'), kind: 'hit', budget: cap > 0 && used > 0 ? { used, cap } : null }];
      },
      messageState(msg, conv, host) {
        if (host && !effectiveFor(host, conv)) return null; // 不适用时完全不影响界面（不变灰、不冻结）
        const st = data(conv).state;
        const cov = coveredSet(st);
        if (cov.has(msg.id)) {
          const elig = conv.messages.filter(m => cov.has(m.id));
          const isLast = elig[elig.length - 1] === msg;
          const ch = R.chaptersOf(st);
          return { dim: true, label: isLast ? '↑ 以上 ' + elig.length + ' 条已写入章节 ' + ch.map(c => R.slabel(c.no)).join('、') + '，不再发送（原文保留）' : '' };
        }
        if (!st.window.startId) return null;
        const elig = conv.messages.filter(m => !m.error && !m.imageGen && !m.pending && !cov.has(m.id));
        const i = elig.findIndex(m => m.id === st.window.startId);
        const j = elig.indexOf(msg);
        if (i > 0 && j >= 0 && j < i) return { dim: true, light: true, label: j === i - 1 ? '↑ 以上超出预算，暂不发送（原文保留，建议开启自动摘要）' : '' };
        return null;
      },
    },

    // ---------------- 插件设置（全局：价格 / 高峰时段，V2 可增删改） ----------------
    renderSettings(box, host) {
      const c = cfg(host);
      const names = Object.keys(c.prices);
      const row = id => '<div class="price-row" data-row="' + host.esc(id) + '"><span><input type="text" class="pr-match" data-m="' + host.esc(id) + '" value="' + host.esc(c.prices[id].match != null ? c.prices[id].match : id) + '" title="模型名包含任一关键词即使用此价格（逗号分隔，越长越优先）"></span>' +
        ['hit', 'miss', 'out'].map(k => '<input type="number" step="0.001" min="0" data-m="' + host.esc(id) + '" data-k="' + k + '" value="' + c.prices[id][k] + '">').join('') +
        '<button class="chip-btn pr-del" data-m="' + host.esc(id) + '" type="button" title="删除">×</button></div>';
      box.innerHTML = '<label class="field"><span>自动启用<small>只对支持缓存的服务商（DeepSeek / 千问）生效；对话里手动开 / 关始终优先</small></span><select id="rp-auto-mode">' +
        '<option value="rp">角色扮演类对话自动启用（推荐）</option><option value="cache">支持缓存的服务商上所有对话</option><option value="off">关闭（只手动启用）</option></select></label>' +
        '<label class="field inline"><span>首条消息自动提取设定<small>对话第一轮回复后，额外调用一次模型，把首条消息里的角色 / 世界观 / 规则填进空白的分层设定（不覆盖已填写内容）</small></span><input type="checkbox" class="switch" id="rp-auto-extract"' + (c.auto_extract !== false ? ' checked' : '') + '></label>' +
        '<div class="pl-set-title">价格（美元 / 百万 Token，高峰价），用于估算节省 / 额外花费</div>' +
        '<div class="price-row head"><span>模型关键词</span><span>缓存命中</span><span>未命中</span><span>输出</span><span></span></div>' +
        names.map(row).join('') +
        '<button class="chip-btn" id="rp-price-add" type="button">＋ 添加价格规则</button>' +
        '<label class="field" style="margin-top:10px"><span>时段</span><select id="rp-price-mode"><option value="auto">自动（按请求时间判断高峰/非高峰）</option><option value="peak">按高峰价</option><option value="offpeak">按非高峰价</option></select></label>' +
        '<label class="field"><span>高峰时段<small>逗号分隔，例如 09:00-12:00,14:00-18:00</small></span><input type="text" id="rp-peak-win" value="' + host.esc(c.peak.windows) + '"></label>' +
        '<label class="field"><span>时区偏移（小时）<small>北京时间为 8</small></span><input type="number" id="rp-peak-tz" step="0.5" value="' + c.peak.tz + '"></label>' +
        '<label class="field"><span>非高峰价格倍数<small>例如 0.5 = 半价</small></span><input type="number" id="rp-peak-off" step="0.05" min="0" max="1" value="' + c.peak.off_factor + '"></label>' +
        '<label class="field inline"><span>仅工作日有高峰<small>周六日全天按非高峰（节假日未计入）</small></span><input type="checkbox" class="switch" id="rp-peak-wd"' + (c.peak.weekdays ? ' checked' : '') + '></label>' +
        '<div class="hint small">默认价格来自 DeepSeek 官方定价页（2026-10 核对），官方调价时可在这里修改。没有匹配规则的模型自动使用内置价格表（含千问各模型，按 1 美元 ≈ ' + R.CNY_PER_USD + ' 元换算，千问不分高峰）。</div>' +
        '<button class="chip-btn" id="rp-price-reset" type="button">恢复默认价格与时段</button>';
      box.querySelector('#rp-price-mode').value = c.priceMode;
      box.querySelector('#rp-auto-mode').value = c.auto_mode;
      box.querySelector('#rp-auto-mode').onchange = e => { reg.config(host.settings(), ID).auto_mode = e.target.value; c.auto_mode = e.target.value; host.saveSettings(); host.refresh && host.refresh(); };
      box.querySelector('#rp-auto-extract').onchange = e => { reg.config(host.settings(), ID).auto_extract = e.target.checked; host.saveSettings(); };
      const save = () => host.saveSettings();
      box.querySelectorAll('input[data-k]').forEach(inp => inp.addEventListener('change', () => {
        const v = parseFloat(inp.value); if (isNaN(v) || v < 0) { inp.value = c.prices[inp.dataset.m][inp.dataset.k]; return; }
        c.prices[inp.dataset.m] = Object.assign({}, c.prices[inp.dataset.m], { [inp.dataset.k]: v }); save();
      }));
      box.querySelectorAll('input.pr-match').forEach(inp => inp.addEventListener('change', () => {
        c.prices[inp.dataset.m] = Object.assign({}, c.prices[inp.dataset.m], { match: inp.value.trim() }); save();
      }));
      box.querySelectorAll('.pr-del').forEach(b => b.onclick = () => { delete c.prices[b.dataset.m]; reg.config(host.settings(), ID).prices = c.prices; save(); this.renderSettings(box, host); });
      box.querySelector('#rp-price-add').onclick = () => {
        let n = 1; while (c.prices['custom-' + n]) n++;
        c.prices['custom-' + n] = { hit: 0, miss: 0, out: 0, match: '' }; save(); this.renderSettings(box, host);
      };
      box.querySelector('#rp-price-mode').onchange = e => { c.priceMode = e.target.value; save(); };
      box.querySelector('#rp-peak-win').onchange = e => {
        if (!R.parseWindows(e.target.value).length && e.target.value.trim()) { host.toast('格式不对，例如 09:00-12:00,14:00-18:00'); e.target.value = c.peak.windows; return; }
        c.peak.windows = e.target.value.trim(); save();
      };
      box.querySelector('#rp-peak-tz').onchange = e => { const v = parseFloat(e.target.value); if (!isNaN(v)) { c.peak.tz = v; save(); } };
      box.querySelector('#rp-peak-off').onchange = e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0 && v <= 1) { c.peak.off_factor = v; save(); } };
      box.querySelector('#rp-peak-wd').onchange = e => { c.peak.weekdays = e.target.checked; save(); };
      box.querySelector('#rp-price-reset').onclick = () => { c.prices = Object.assign({}, R.DEFAULT_PRICES); c.peak = Object.assign({}, R.DEFAULT_PEAK); save(); this.renderSettings(box, host); host.toast('已恢复默认价格与时段'); };
    },

    // ---------------- 对话面板 ----------------
    panel: { tab: 'blocks', view: null, busy: null },
    onBack() { if (this.panel.view) { this.panel.view = null; this._render(); return true; } return false; },
    renderPanel(box, host, tab) {
      this._box = box; this._host = host;
      if (tab) { this.panel.tab = tab; this.panel.view = null; }
      this._render();
    },
    _render() {
      const box = this._box, host = this._host, conv = host.conv();
      if (!box || !conv) return;
      const on = reg.isActive(ID, host.settings(), conv);
      box.innerHTML = '';
      const head = document.createElement('div'); head.className = 'group form';
      const autoOn = on && reg.isAutoActive(ID, host.settings(), conv, host);
      head.innerHTML = '<label class="field inline"><span>在本对话启用 RP 缓存优化' + (autoOn ? ' <span class="rb-tag soft" id="rp-auto-tag">自动</span>' : '') +
        '<small>' + (autoOn ? (rpLike(conv) ? '已自动启用：识别为角色扮演对话，且服务商支持上下文缓存（手动关闭后以手动为准）' : '已自动启用：插件设置为「支持缓存的服务商上所有对话」（手动关闭后以手动为准）') : '每个对话是独立会话：设定 / 记忆 / 摘要 / 历史 / 状态 / 统计互不影响') + '</small></span><input type="checkbox" class="switch" id="rp-on"' + (on ? ' checked' : '') + '></label>';
      box.appendChild(head);
      head.querySelector('#rp-on').onchange = e => {
        if (!reg.isGloballyEnabled(ID, host.settings())) { reg.setGlobal(host.settings(), ID, true); host.saveSettings(); }
        reg.setForConversation(conv, ID, e.target.checked); data(conv); host.saveConv(conv); host.refresh();
        host.toast(e.target.checked ? '已启用 RP 缓存优化' : '已关闭 RP 缓存优化（设定与摘要保留）'); this._render();
      };
      if (!on) {
        const tip = document.createElement('div'); tip.className = 'hint'; tip.style.marginTop = '12px';
        tip.innerHTML = '开启后，本对话的每次请求按固定的结构组织：<br><b>L1 固定设定</b>（世界观 / 角色卡 / 规则…）→ <b>L2 长期记忆</b> → <b>L3 章节</b>（冻结、只追加）→ <b>L4 对话历史</b>（只追加）→ 最后一条用户消息：<b>L6 本轮输入</b> + 记忆增量 + <b>L5 当前状态</b>。<br>' +
          '稳定内容在前、动态内容在后，让 DeepSeek / 千问的上下文缓存尽可能命中。历史超出阈值时自动追加章节，原始消息永远保留在本地。默认只对 DeepSeek、千问生效；角色扮演类对话会自动开启。';
        box.appendChild(tip);
        return;
      }
      const ap = applicability(host, conv);
      if (!ap.ok) {
        const na = document.createElement('div'); na.className = 'group form'; na.id = 'rp-na';
        na.innerHTML = '<div class="rp-suggest"><b>不适用</b>：当前服务商「' + host.esc((ap.provider && ap.provider.name) || '未知') + '」/ 模型「' + host.esc(ap.model || '') + '」不是 DeepSeek / 千问（' + host.esc(ap.cap.label) + '）。' +
          '默认情况下插件<b>不改写</b>这个对话的请求，设定 / 章节保留，切回 DeepSeek / 千问后继续生效。</div>' +
          '<label class="field inline"><span>仍然在此服务商上启用<small>OpenAI 等会自动按前缀缓存；Claude 会自动加 cache_control 断点（system + 稳定历史末尾）；其他服务商可能没有缓存</small></span><input type="checkbox" class="switch" id="rp-force"' + (ap.forced ? ' checked' : '') + '></label>';
        box.appendChild(na);
        na.querySelector('#rp-force').onchange = e => {
          data(conv).state.settings.force_enable = e.target.checked; host.saveConv(conv); host.refresh();
          host.toast(e.target.checked ? '已在当前服务商上强制启用 RP 缓存优化' : '已恢复默认：非 DeepSeek / 千问不改写请求'); this._render();
        };
        if (!ap.forced) return;
      }
      if (this.panel.view) { this.panel.view(box); return; }
      const seg = document.createElement('div'); seg.className = 'seg in-body';
      [['blocks', '分层设定'], ['summary', '章节摘要'], ['monitor', '缓存监控'], ['health', '上下文体检'], ['opts', '预算设置']].forEach(([k, t]) => {
        const b = document.createElement('button'); b.textContent = t; b.dataset.tab = k; if (k === this.panel.tab) b.className = 'active';
        b.onclick = () => { this.panel.tab = k; this._render(); };
        seg.appendChild(b);
      });
      box.appendChild(seg);
      const body = document.createElement('div'); box.appendChild(body);
      ({ blocks: this._blocks, summary: this._summary, monitor: this._monitor, health: this._health, opts: this._opts })[this.panel.tab].call(this, body, conv, host);
    },

    // ----- 分层设定 -----
    _blocks(body, conv, host) {
      const d = data(conv); const st = d.state; const p = planConv(conv, host);
      const base = R.canonicalize(conv.systemPrompt);
      const layer = (no, title, sub) => { const el = document.createElement('div'); el.className = 'layer-head'; el.innerHTML = '<span class="lh-no">' + no + '</span><span class="lh-t">' + title + '</span><span class="lh-sub">' + sub + '</span>'; body.appendChild(el); };
      const card = (title, meta, preview, fp, onClick, cls) => {
        const el = document.createElement('button'); el.className = 'rp-block' + (cls ? ' ' + cls : '');
        el.innerHTML = '<div class="rb-top"><span class="rb-title">' + host.esc(title) + '</span>' + meta + '</div>' +
          '<div class="rb-prev">' + (preview ? host.esc(preview.slice(0, 90)) : '<span class="muted">（空，不会发送）</span>') + '</div>' +
          (fp ? '<div class="rb-fp">指纹 ' + fp.slice(0, 12) + '…</div>' : '');
        if (onClick) el.onclick = onClick;
        body.appendChild(el);
      };
      const edit = id => () => { this.panel.view = box => this._editBlock(box, conv, host, id); this._render(); };
      const blockCard = id => {
        const b = R.getBlock(st, id); const def = R.BLOCK_DEFS.find(x => x.id === id);
        card(def.title, '<span class="rb-tag soft" title="发送给模型时的分段标记">[' + def.tag + ']</span><span class="rb-ver">' + ver(b.version) + '</span>', b.content, b.content ? R.sha256(b.content) : '', edit(id));
      };
      const tip = document.createElement('div'); tip.className = 'hint';
      tip.textContent = '请求按 L1 → L6 的固定顺序组装。只有内容真正改变时版本号才会 +1；插件不会改写你已填写的设定（首条消息自动提取只填空白块）。越靠前的层越稳定，修改它会让其后的缓存全部重建。方括号里的英文（如 [WORLD]）是发送给模型的分段标记，保持不变以稳定缓存。';
      body.appendChild(tip);
      // v0.7.5：系统提示词与角色卡 / 世界观内容重复时提醒（同一段设定发送两遍浪费 Token）
      const sysC = R.canonicalize(conv.systemPrompt || '');
      const dup = sysC.length >= 30 && ['character', 'world'].find(k => { const c = R.getBlock(st, k).content; return c && (c.includes(sysC.slice(0, 60)) || sysC.includes(c.slice(0, 60))); });
      if (dup) { const w = document.createElement('div'); w.className = 'hint'; w.style.color = 'var(--warn, #d08a00)';
        w.textContent = '⚠ 对话系统提示词与「' + BLOCK_CN(dup) + '」内容重复，同一段设定会发送两遍。建议只保留一处（例如清空系统提示词，保留分层设定）。'; body.appendChild(w); }
      // v0.7.8：角色卡 Skill 一键启用 + 分段导入
      const found = R.findSectionMessage(conv.messages, 8);
      const skillOn = !!(conv.templateId === 't-rp-cardgen' || /角色卡 Skill/.test(conv.templateName || ''));
      const tg = document.createElement('div'); tg.className = 'rp-suggest'; tg.id = 'rp-tpl-guide';
      tg.innerHTML = '<b>角色卡 Skill：</b>无需填写变量。点下方启用后，在聊天里直接发一句想法或贴旧设定；AI 会输出【世界观】【角色卡】等 8 段。之后可说「精修一下」「加秘密」「改性格」，会基于上一版重出完整分段，再导入到分层设定。' +
        ' <button class="chip-btn accent" id="rp-card-skill" type="button"' + (skillOn ? ' disabled' : '') + '>' + (skillOn ? '角色卡 Skill 使用中' : '启用角色卡 Skill') + '</button>' +
        (found ? ' <button class="chip-btn accent" id="rp-import-sections" type="button">导入分段设定</button>' +
          '<div class="hint small" style="margin:4px 0 0">将导入世界观 / 角色卡 / RP规则 / 输出格式 / 示例对白 / 禁止事项 / 写作风格（只填空白块；已有内容可再点「覆盖已有」）。开场白可复制，不写入块。</div>' : '');
      body.appendChild(tg);
      const sb = tg.querySelector('#rp-card-skill');
      if (sb && !skillOn) sb.onclick = async () => {
        if (host.applyCardSkill) await host.applyCardSkill();
        else host.toast('请在模板列表选择「角色卡 Skill」');
        this._render();
      };
      const ib = tg.querySelector('#rp-import-sections'); if (ib) ib.onclick = () => { importSections(host, conv, found.fields); };
      const fu = firstUserText(conv); const ax = st.autoExtract;
      if (fu.text) {
        const ex = document.createElement('div'); ex.className = 'rp-suggest'; ex.id = 'rp-extract';
        ex.innerHTML = (ax && ax.status === 'done' ? '✓ 已从首条消息提取设定' + (ax.filled && ax.filled.length ? '：' + ax.filled.map(x => host.esc(BLOCK_CN(x))).join('、') : '（没有空白块需要填充）') +
            (ax.skipped && ax.skipped.length ? '（' + ax.skipped.map(x => host.esc(BLOCK_CN(x))).join('、') + ' 正在编辑，已跳过）' : '') +
            (ax.snapshot && ax.filled && ax.filled.length ? ' <button class="chip-btn" id="rp-extract-undo" type="button">撤销本次填充</button>' : '')
          : ax && ax.status === 'undone' ? '已撤销上次自动填充'
          : ax && ax.status === 'running' ? '<span class="spin"></span>正在从首条消息提取设定…' : ax && ax.status === 'error' ? '首条消息提取失败：' + host.esc(ax.error || '') : '可以从首条消息（角色 / 故事背景）自动提取设定') +
 (R.shouldAutoExtract(fu.text) ? '' : '<div class="hint small" style="margin:4px 0 0">首条消息较短或不像设定，不会自动提取；需要时可手动提取。</div>') +
          ' <button class="chip-btn accent" id="rp-extract-btn" type="button"' + (ax && ax.status === 'running' ? ' disabled' : '') + '>从首条消息提取</button>' +
          '<div class="hint small" style="margin:4px 0 0">只填写空白的块，已有内容不会被覆盖；会额外调用一次模型。' + (extractOn(host, conv) ? '' : '（本对话 / 全局已关闭自动提取）') + '</div>';
        body.appendChild(ex);
        ex.querySelector('#rp-extract-btn').onclick = async e => { e.target.disabled = true; e.target.textContent = '提取中…'; await autoExtract(host, conv, fu.text, true); this._render(); };
        const ub = ex.querySelector('#rp-extract-undo'); if (ub) ub.onclick = () => { const n = undoExtract(host, conv); host.toast(n ? '已撤销本次自动填充（' + n + ' 个块）' : '内容已被修改，没有可撤销的块'); this._render(); };
      }
      layer('L1', '固定设定', R.verLabel('static', st.staticVersion) + ' · ≈' + fmtN(p.tokens.static) + ' Token');
      card('对话系统提示词 / 助手设定', '<span class="rb-tag soft">来自对话</span>', base, base ? R.sha256(base) : '',
        () => host.dialog({ title: '对话系统提示词 / 助手设定', body: (base || '（空）') + '\n\n这是本对话的系统提示词（或所选助手的设定），作为 L1 固定设定的第一部分。可在顶部模型菜单 →「本对话系统提示词」或「提示词模板」中修改；修改后固定设定版本 +1。', okText: '知道了', info: true }), 'base');
      R.STATIC_DEFS.forEach(def => blockCard(def.id));
      { const lore = st.lore || []; const nc = lore.filter(e => e.mode === 'constant').length; const act = R.activeFired(st, convItems(conv, host)).length;
        card('世界书', '<span class="rb-tag soft">常驻 ' + nc + ' · 触发 ' + (lore.length - nc) + ' · 已冻结 ' + act + '</span>', st.loreText || '', '', () => { this.panel.view = box => this._editLore(box, conv, host); this._render(); });
        const lt = st.loreTrace; // A4：最近一轮触发 trace
        if (lt && lt.items && lt.items.length) {
          const d = document.createElement('details'); d.className = 'rp-lore-trace';
          const fired = lt.items.filter(x => x.status === 'fired').length;
          d.innerHTML = '<summary class="hint small">世界书触发 trace（第 ' + lt.turn + ' 轮：触发 ' + fired + ' · 未触发 ' + (lt.items.length - fired) + '）</summary>' +
            lt.items.map(x => '<div class="kv"><span>' + host.esc(x.name) + '</span><b class="' + (x.status === 'fired' ? 'good' : x.reason === 'no_key' ? '' : 'bad') + '">' + (x.status === 'fired' ? '✓ ' : '✗ ') + host.esc((R.LORE_REASON && R.LORE_REASON[x.reason]) || x.reason) + '</b></div>').join('');
          body.appendChild(d);
        } }
      layer('L2', '长期记忆', R.verLabel('memory', R.getBlock(st, 'memory').version) + ' · ≈' + fmtN(p.tokens.memory) + ' Token');
      blockCard('memory');
      const chs = R.chaptersOf(st);
      layer('L3', '章节摘要（只追加）', chs.length ? chs.length + ' 章 · ≈' + fmtN(p.tokens.summary) + ' / ' + fmtN(p.cap) + ' Token' : '尚未生成');
      if (!chs.length) card('章节摘要', '<span class="rb-tag t-memory">自动</span>', '', '', () => { this.panel.tab = 'summary'; this._render(); });
      chs.forEach(c => card('章节 ' + R.slabel(c.no), '<span class="rb-tag t-memory">' + (SRC[c.source] || c.source) + '</span>', c.content, c.hash, () => { this.panel.tab = 'summary'; this._render(); }));
      layer('L4', '对话历史', p.hist.filter(m => m.role === 'user').length + ' 轮 · ≈' + fmtN(p.tokens.history) + ' Token · 只追加');
      layer('L4+', '记忆增量', R.verLabel('delta', R.getBlock(st, 'delta').version) + ' · ≈' + fmtN(p.tokens.delta) + ' Token · 在历史之后');
      blockCard('delta');
      if (R.getBlock(st, 'delta').content) {
        const mb = document.createElement('button'); mb.className = 'ghost-btn'; mb.id = 'rp-merge-delta'; mb.textContent = '把记忆增量合并进长期记忆';
        mb.onclick = () => this.mergeDelta(conv, host);
        body.appendChild(mb);
      }
      layer('L5', '当前状态', R.verLabel('state', R.getBlock(st, 'state').version) + ' · 在本轮输入之后');
      blockCard('state');
      layer('L6', '本轮输入', '最后一条用户消息的开头');
      const prev = document.createElement('button'); prev.className = 'ghost-btn'; prev.id = 'rp-preview'; prev.textContent = '预览请求结构';
      prev.onclick = () => {
        const a = R.assemble(p); const n = a.messages.length;
        const ROLE = { user: '用户', assistant: 'AI', system: '系统' };
        const txt = '── 系统消息 ──\n' + (a.system || '（空）') + '\n\n── 对话历史 ' + p.hist.length + ' 条（原样，以下为最后 2 条）──\n' +
          p.hist.slice(-2).map(m => (ROLE[m.role] || m.role) + '：' + String(m.content).slice(0, 60)).join('\n') + '\n\n── 最后一条用户消息 ──\n' + R.finalUserContent(st, '（你的下一条输入）') +
          '\n\n共 ' + (n + 1) + ' 条消息 · 估算 ' + fmtN(p.tokens.total) + ' Token\n（方括号里的英文标记会原样发送给模型）';
        host.dialog({ title: '请求结构预览', body: txt, okText: '关闭', info: true });
      };
      body.appendChild(prev);
    },
    async mergeDelta(conv, host) {
      const d = data(conv); const p = planConv(conv, host);
      const c = R.mergeDeltaCost(p, costOpts(host, conv));
      const ok = await host.dialog({ title: '合并记忆增量？', body: '会把记忆增量追加到长期记忆末尾（长期记忆 +1 版），并清空增量。\n\n' +
        '代价：长期记忆位于前缀靠前位置，之后的章节与对话历史（≈' + fmtN(c.rebuild) + ' Token）下一轮需要重新建立缓存' + (c.usd != null ? '，约多花 ' + fmtUsd(c.usd) : '') + '。\n建议等增量攒得比较多、或者开始新章节时再合并。', okText: '合并' });
      if (!ok) return;
      const r = R.mergeDelta(d.state, Date.now());
      if (!r.changed) { host.toast('记忆增量为空'); return; }
      d.state = r.state; normalized.add(r.state); host.saveConv(conv); host.refresh(); host.toast('已合并进长期记忆（' + R.verLabel('memory', R.getBlock(r.state, 'memory').version) + '）'); this._render();
    },

    _editLore(box, conv, host) {
      const d = data(conv);
      const ls = (d.state.settings && d.state.settings.lore) || (R.DEFAULT_SETTINGS.lore) || {};
      box.innerHTML = '<div class="rp-edit-head"><button class="chip-btn" id="lo-back">‹ 返回</button><span class="rb-title">世界书（ST 语义）</span></div>' +
        '<div class="hint">每条以「## 名称 | 关键词1, 关键词2」开头，下一行起是内容。可选行内标记：<code>*</code> 常驻、<code>key2:副键</code>、<code>depth:N</code>、<code>prob:0-100</code>、<code>prio:N</code>、<code>norec</code>。<br>' +
        '<b>常驻</b>进 L1 固定设定（有预算兜底）；<b>触发</b>按 scanDepth 扫描，首次命中冻结到用户消息末尾（热路径不重排）。冷路径（章节边界 / 手动重建 / 下方开关）可完整重排。</div>' +
        '<div class="group form"><textarea id="lo-text" rows="14" placeholder="## 王都 | 王都, 王城\n王都位于……\n\n## 世界基本法则 | *\n魔法需要代价……\n\n## 暗线 | 密谋 key2:密室 depth:4 prob:80\n……"></textarea>' +
        '<label class="field inline"><span>修改设定后立即重建上下文<small>清空已冻结的世界书片段并冷路径重排；关闭则保持缓存，诊断会提示 loreEditedButFrozen</small></span><input type="checkbox" class="switch" id="lo-rebuild"' + (ls.rebuildOnEdit ? ' checked' : '') + '></label>' +
        '<div class="btn-row"><button class="pill-btn" id="lo-cancel">关闭</button><button class="pill-btn primary" id="lo-save">保存</button></div></div>' +
        '<div class="group-title">扫描与预算</div><div class="group form">' +
        '<label class="field"><span>扫描深度 scanDepth<small>最近 N 条消息（含本轮）；默认 2 ≈ 旧「本轮+上一条」</small></span><input id="lo-depth" type="number" min="1" max="50" value="' + (ls.scanDepth != null ? ls.scanDepth : 2) + '"></label>' +
        '<label class="field"><span>递归深度<small>0=关闭；被激活条目的内容再参与扫描</small></span><input id="lo-rec" type="number" min="0" max="10" value="' + (ls.recursionDepth != null ? ls.recursionDepth : 0) + '"></label>' +
        '<label class="field"><span>触发预算占比<small>相对上下文上限，默认 0.25</small></span><input id="lo-bp" type="number" min="0.05" max="0.8" step="0.05" value="' + (ls.budgetPct != null ? ls.budgetPct : 0.25) + '"></label>' +
        '<label class="field"><span>常驻预算占比<small>兜底防撑爆，默认 0.15</small></span><input id="lo-cbp" type="number" min="0.05" max="0.5" step="0.05" value="' + (ls.constantBudgetPct != null ? ls.constantBudgetPct : 0.15) + '"></label>' +
        '<div class="btn-row"><button class="chip-btn" id="lo-rebuild-now" type="button">立即重建世界书冻结</button></div></div>';
      const ta = box.querySelector('#lo-text'); ta.value = d.state.loreText || '';
      const back = () => { this.panel.view = null; this._render(); };
      box.querySelector('#lo-back').onclick = back; box.querySelector('#lo-cancel').onclick = back;
      const applyLoreSettings = () => {
        const st0 = d.state.settings || (d.state.settings = {});
        const lore = Object.assign({}, st0.lore || R.DEFAULT_SETTINGS.lore);
        lore.rebuildOnEdit = box.querySelector('#lo-rebuild').checked;
        lore.scanDepth = Math.max(1, parseInt(box.querySelector('#lo-depth').value, 10) || 2);
        lore.recursionDepth = Math.max(0, parseInt(box.querySelector('#lo-rec').value, 10) || 0);
        lore.budgetPct = Math.min(0.8, Math.max(0.05, parseFloat(box.querySelector('#lo-bp').value) || 0.25));
        lore.constantBudgetPct = Math.min(0.5, Math.max(0.05, parseFloat(box.querySelector('#lo-cbp').value) || 0.15));
        st0.lore = lore;
      };
      box.querySelector('#lo-save').onclick = () => {
        applyLoreSettings();
        let st = R.setLore(d.state, ta.value);
        if (st.settings && st.settings.lore && st.settings.lore.rebuildOnEdit && typeof R.rebuildLore === 'function') {
          // setLore 已按开关处理；此处再确保标志清晰
        }
        d.state = st; normalized.add(st); host.saveConv(conv); host.refresh();
        const tip = st.loreNeedsRebuild ? '（将在下轮冷路径重建）' : (st.loreEditedWhileFrozen ? '（历史冻结保留，诊断可见）' : '');
        host.toast('世界书已保存：' + st.lore.length + ' 条' + tip); back();
      };
      box.querySelector('#lo-rebuild-now').onclick = () => {
        applyLoreSettings();
        let st = R.setLore(d.state, ta.value);
        if (typeof R.rebuildLore === 'function') {
          const r = R.rebuildLore(st, conv.messages || [], Date.now(), { convId: conv && conv.id });
          st = r.state || r;
        }
        d.state = st; normalized.add(st); host.saveConv(conv); host.refresh();
        host.toast('已重建世界书冻结片段'); back();
      };
    },
    _editBlock(box, conv, host, id) {
      const d = data(conv); const b = R.getBlock(d.state, id); const def = R.BLOCK_DEFS.find(x => x.id === id);
      const warn = def.layer === 'L1' ? '修改固定设定会让全部缓存重建，建议攒到一起再改。保存后为' + R.verLabel('static', d.state.staticVersion + 1) + '。'
        : def.layer === 'L2' ? '长期记忆只放稳定事实；修改会让章节与历史的缓存全部重建。新近的事实建议写进「记忆增量」（不破坏前缀），攒多了再合并。保存后为' + R.verLabel('memory', b.version + 1) + '。'
        : def.type === 'delta' ? '记忆增量放在对话历史之后，每轮修改都不影响前面的缓存（只多发送这一小段）。增量超过约 1500 Token 时建议合并进长期记忆。'
        : '当前状态放在最后一条用户消息末尾，每轮修改都不影响历史缓存。旧的状态不会留在历史里。';
      box.innerHTML = '';
      plugin._editing = { conv, id }; // v0.7.5：后台提取跳过正在编辑的块
      const wrap = document.createElement('div');
      wrap.innerHTML = '<div class="rp-edit-head"><button class="chip-btn" id="rb-back">‹ 返回</button><span class="rb-title">' + def.layer + ' · ' + host.esc(def.title) + '</span><span class="rb-ver">' + ver(b.version) + '</span></div>' +
        '<div class="hint">' + host.esc(def.hint) + '<br><span class="muted">' + host.esc(warn) + '</span></div>' +
        '<div class="group form"><textarea id="rb-text" rows="12" placeholder="在这里输入' + host.esc(def.title) + '…"></textarea>' +
        '<div class="rb-meta" id="rb-meta"></div>' +
        ((id === 'character' || id === 'world' || R.BLOCK_TEMPLATES[id]) ? '<div class="btn-row" style="justify-content:flex-start">' +
          (R.BLOCK_TEMPLATES[id] ? '<button class="chip-btn" id="rb-from-tpl" type="button">＋ 从模板填充</button>' : '') +
          ((id === 'character' || id === 'world') ? '<button class="chip-btn" id="rb-import-sys" type="button">＋ 插入对话系统提示词 / 助手设定</button>' +
          (firstUserText(conv).text ? '<button class="chip-btn" id="rb-import-first" type="button">＋ 插入首条消息原文</button>' : '') : '') + '</div>' : '') +
        '<div class="btn-row"><button class="pill-btn" id="rb-cancel">取消</button><button class="pill-btn primary" id="rb-save">保存</button></div></div>' +
        '<div class="group-title">版本历史</div><div class="group" id="rb-hist"></div>';
      box.appendChild(wrap);
      const ta = wrap.querySelector('#rb-text'); ta.value = b.content; plugin._editing.ta = ta;
      const meta = () => {
        const c = R.canonicalize(ta.value);
        wrap.querySelector('#rb-meta').textContent = c.length + ' 字 · 约 ' + R.estimateTokens(c) + ' Token · 指纹 ' + R.sha256(c).slice(0, 12) + '…' + (c === b.content ? ' · 未修改' : ' · 保存后为' + ver(b.version + 1));
      };
      ta.addEventListener('input', meta); meta();
      const ins = t => { t = R.canonicalize(t); if (!t) { host.toast('内容为空'); return; } ta.value = ta.value.trim() ? ta.value.replace(/\s+$/, '') + '\n\n' + t : t; meta(); };
      const bt = wrap.querySelector('#rb-from-tpl'); if (bt) bt.onclick = () => { ins(R.BLOCK_TEMPLATES[id]); ta.focus(); };
      const bs = wrap.querySelector('#rb-import-sys'); if (bs) bs.onclick = () => ins(conv.systemPrompt);
      const bf = wrap.querySelector('#rb-import-first'); if (bf) bf.onclick = () => ins(firstUserText(conv).text);
      if (host.expandTextarea) host.expandTextarea(ta, def.layer + ' · ' + def.title, '全屏编辑完成后回到这里，点「保存」才会生效。' + warn);
      const back = () => { plugin._editing = null; this.panel.view = null; this._render(); };
      wrap.querySelector('#rb-back').onclick = back; wrap.querySelector('#rb-cancel').onclick = back;
      wrap.querySelector('#rb-save').onclick = () => {
        const r = R.setBlock(d.state, id, ta.value, Date.now());
        if (!r.changed) { host.toast('内容没有变化（仅空白/换行差异），版本保持' + ver(b.version)); back(); return; }
        d.state = r.state; host.saveConv(conv); host.refresh();
        host.toast(def.title + ' 已更新为' + ver(R.getBlock(r.state, id).version)); back();
      };
      const hist = wrap.querySelector('#rb-hist');
      if (!b.history.length) hist.innerHTML = '<div class="conv-empty">还没有历史版本</div>';
      b.history.slice().reverse().forEach(h => {
        const el = document.createElement('div'); el.className = 'prov-item hist-row';
        el.innerHTML = '<span class="rb-ver">' + ver(h.version) + '</span><div class="pi-main"><div class="pi-name">' + host.esc((h.content || '（空）').slice(0, 40)) + '</div><div class="pi-sub">' +
          (h.at ? fmtTime(h.at) + ' · ' : '') + h.content.length + ' 字 · 指纹 ' + h.hash.slice(0, 10) + '…</div></div><button class="chip-btn accent">恢复</button>';
        el.querySelector('button').onclick = async () => {
          const ok = await host.dialog({ title: '恢复到' + ver(h.version) + '？', body: '会以' + ver(h.version) + '的内容生成新版本（' + ver(b.version + 1) + '），当前内容保留在历史中。', okText: '恢复' });
          if (!ok) return;
          const r = R.setBlock(d.state, id, null, Date.now(), h.version);
          if (!r.changed) { host.toast('与当前内容相同，无需恢复'); return; }
          d.state = r.state; host.saveConv(conv); host.refresh();
          host.toast('已恢复为' + ver(h.version) + '的内容（新版本：' + ver(R.getBlock(r.state, id).version) + '）'); this._editBlock(box, conv, host, id);
        };
        hist.appendChild(el);
      });
    },

    // ----- 章节摘要（V2：只追加的章节） -----
    _summary(body, conv, host) {
      const d = data(conv); const st = d.state; const p = planConv(conv, host); const sum = st.settings.summary;
      const chs = R.chaptersOf(st);
      const unTok = Math.round(R.estimateItems(p.unsummarized) * p.calib);
      const kv = (k, v, cls) => '<div class="kv' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>';
      const est = R.summaryCost(Object.assign({}, p, { batch: p.batch }), costOpts(host, conv));
      let html = '<div class="hint">章节是「冻结快照」，<b>只追加</b>：每次只把最新移出的旧对话写成新的一章，接在前面的章节之后一起发送，' +
        '之前的章节逐字不变，所以缓存从新章节处才重新建立。章节合计超过 ' + num(p.cap) + ' Token 时，下一次摘要会把全部章节合并成一章（缓存重建一次）。被摘要的旧消息仍在聊天里（变灰），只是不再发送。</div>';
      html += '<div class="group form kv-box">' +
        kv('自动摘要', sum.enabled ? '开启' : '关闭', sum.enabled ? 'ok' : '') +
        kv('未摘要的对话历史', '≈' + num(unTok) + ' / ' + num(sum.trigger_tokens) + ' Token') +
        kv('可摘要的旧轮数', p.batchRounds + ' 轮（需 ≥ ' + sum.min_new_turns + '，保留最近 ' + sum.keep_recent_turns + ' 轮原文）') +
        kv('距上一章', chs.length ? p.sinceLast + ' 轮（最小间隔 ' + p.minGap + ' 轮）' : '—', p.summaryBlocked === 'interval' ? 'bad' : '') +
        kv('章节合计', '≈' + num(p.chapterTokens) + ' / ' + num(p.cap) + ' Token', p.chapterTokens >= p.cap ? 'bad' : '') +
        kv('上下文预算', '≈' + num(p.tokens.total) + ' / ' + num(p.limit) + ' Token', p.overBudget ? 'bad' : '') +
        kv('已摘要消息', R.coveredIds(st).length + ' 条') + '</div>';
      if (p.needSummary) html += '<div class="rp-suggest" id="rp-next-sum">下次发送时会先自动' + (p.needConsolidate ? '<b>合并全部 ' + chs.length + ' 个章节</b>' : '追加章节 ' + R.slabel(st.chapterSeq + 1)) +
        '（' + ({ budget: '超出上下文预算', cold: '缓存已过期，趁重建摘要', adaptive: '自适应：' + ((p.auto && p.auto.why) || '成本回本') }[p.summaryReason] || '达到摘要阈值') + '）。预计额外花费' + costText(est) + '：摘要调用 ≈' + fmtN(est.callIn) + ' 输入 + ' + fmtN(est.callOut) + ' 输出，缓存重建 ≈' + fmtN(est.rebuild + (est.merge ? est.chapterTokens : 0)) + ' Token。</div>';
      else if (p.summaryBlocked === 'interval') html += '<div class="rp-suggest">已达到摘要阈值，但距上一章只有 ' + p.sinceLast + ' 轮（最小间隔 ' + p.minGap + ' 轮），暂不摘要，避免频繁重建缓存。超出上下文预算时仍会立即摘要。</div>';
      else if (chs.length > 1 && p.chapterTokens >= p.cap * 0.8) html += '<div class="rp-suggest">章节合计接近上限，下一次摘要可能会合并全部章节（缓存重建一次）。</div>';
      if (this.panel.busy) html += '<div class="rp-status"><span class="spin"></span>' + host.esc(this.panel.busy) + '</div>';
      html += '<div class="btn-row"><button class="pill-btn primary" id="rp-sum-now"' + (this.panel.busy ? ' disabled' : '') + '>立即追加章节</button>' +
        (chs.length > 1 ? '<button class="pill-btn" id="rp-sum-merge"' + (this.panel.busy ? ' disabled' : '') + '>合并全部章节</button>' : '') + '</div>';
      html += '<div class="group-title">当前发送的章节（按顺序）</div>';
      if (!chs.length) html += '<div class="group"><div class="conv-empty">还没有章节</div></div>';
      chs.forEach(c => {
        html += '<button class="rp-block rp-chapter" data-no="' + c.no + '"><div class="rb-top"><span class="rb-title">章节 ' + R.slabel(c.no) + '</span><span class="rb-tag t-memory">' + (SRC[c.source] || c.source) + '</span>' +
          '<span class="rb-ver">' + fmtN(R.estimateTokens(c.content)) + ' Token</span></div><div class="rb-prev">' + host.esc(c.content.slice(0, 120)) + '</div>' +
          '<div class="rb-fp">' + fmtTime(c.editedAt || c.at) + ' · 覆盖 ' + c.coveredIds.length + ' 条' + (c.mergedFrom ? ' · 合并自 ' + c.mergedFrom.map(R.slabel).join('、') : '') + ' · 指纹 ' + c.hash.slice(0, 12) + '… · 点击查看 / 编辑</div></button>';
      });
      if (chs.length) html += '<button class="ghost-btn danger" id="rp-sum-undo">撤销最后一章</button>';
      if ((st.archive || []).length) html += '<div class="group-title">存档（被合并 / 撤销的章节，只读）</div><div class="group" id="rp-sum-arch"></div>';
      body.innerHTML = html;
      body.querySelector('#rp-sum-now').onclick = () => this.manualSummary(conv, host, false);
      const mg = body.querySelector('#rp-sum-merge'); if (mg) mg.onclick = () => this.manualSummary(conv, host, true);
      body.querySelectorAll('.rp-chapter').forEach(el => el.onclick = () => { const no = +el.dataset.no; this.panel.view = box => this._summaryView(box, conv, host, no); this._render(); });
      const undo = body.querySelector('#rp-sum-undo');
      if (undo) undo.onclick = async () => {
        const last = chs[chs.length - 1];
        const ok = await host.dialog({ title: '撤销章节 ' + R.slabel(last.no) + '？', body: (last.mergedFrom ? '会恢复被合并的原章节。' : '它覆盖的 ' + last.coveredIds.length + ' 条消息会重新以原文发送。') + '章节内容保存在存档里。', okText: '撤销', danger: true });
        if (!ok) return;
        const r = R.removeLastChapter(d.state, Date.now());
        d.state = r.state; normalized.add(r.state); host.saveConv(conv); host.refresh(); host.toast('已撤销章节 ' + R.slabel(last.no)); this._render();
      };
      const ar = body.querySelector('#rp-sum-arch');
      if (ar) st.archive.slice().reverse().forEach(a => {
        const el = document.createElement('div'); el.className = 'prov-item hist-row';
        el.innerHTML = '<span class="rb-ver">' + R.slabel(a.no) + '</span><div class="pi-main"><div class="pi-name">' + host.esc(a.content.slice(0, 40)) + '</div><div class="pi-sub">' +
          (a.archivedWhy === 'merge' ? '已合并' : '已撤销') + ' · ' + fmtTime(a.archivedAt) + ' · 覆盖 ' + a.coveredIds.length + ' 条</div></div>';
        el.onclick = () => host.dialog({ title: '章节 ' + R.slabel(a.no) + '（存档）', body: a.content, okText: '关闭', info: true });
        ar.appendChild(el);
      });
    },
    async manualSummary(conv, host, merge) {
      const p = planConv(conv, host);
      if (!merge && !p.batch.length) { host.toast('最近不足 ' + p.st.settings.summary.keep_recent_turns + ' 轮，没有可摘要的旧对话（可在「预算设置」调小保留轮数）'); return; }
      const est = R.summaryCost(p, Object.assign(costOpts(host, conv), { merge: !!merge }));
      const model = p.st.settings.summary_model || conv.model;
      const ok = await host.dialog({ title: merge ? '合并全部章节？' : '追加新章节？',
        body: (merge ? '将把 ' + R.chaptersOf(p.st).length + ' 个章节' + (p.batch.length ? '和 ' + p.batch.length + ' 条较早的消息' : '') + '交给 ' + model + ' 合并成一章。合并后章节之后的缓存会重建一次。'
          : '将把 ' + p.batch.length + ' 条较早的消息（' + p.batchRounds + ' 轮）交给 ' + model + ' 写成新的一章，之前的章节保持不变。') +
          '\n\n预计额外花费' + costText(est) + '（一次额外的模型调用 + 缓存重建）。原始消息不会删除。', okText: merge ? '合并' : '生成' });
      if (!ok) return;
      this.panel.busy = merge ? '正在合并章节…' : '正在生成章节…'; this.panel.tab = 'summary'; this.panel.view = null; this._render();
      try {
        const r = await makeSummary(host, conv, p, 'manual', null, !!merge);
        const d = data(conv); d.state = r.state; normalized.add(r.state); host.saveConv(conv); host.refresh();
        host.toast((r.merged ? '已合并为章节 ' : '已追加章节 ') + R.slabel(r.no) + (r.missing.length ? '（缺少 ' + r.missing.join('/') + '，可手动补充）' : ''));
        this.panel.busy = null;
        this.panel.view = box => this._summaryView(box, conv, host, r.no);
      } catch (e) {
        this.panel.busy = null;
        host.dialog({ title: '摘要生成失败', body: String(e && e.message || e), okText: '知道了', info: true });
      }
      if (host.conv() === conv) this._render();
    },
    _summaryView(box, conv, host, no) {
      const d = data(conv); const chs = R.chaptersOf(d.state);
      const act = chs.find(c => c.no === no) || chs[chs.length - 1];
      if (!act) { this.panel.view = null; this._render(); return; }
      const idx = chs.indexOf(act); const after = chs.length - idx - 1;
      box.innerHTML = '<div class="rp-edit-head"><button class="chip-btn" id="sv-back">‹ 返回</button><span class="rb-title">L3 · 章节 ' + R.slabel(act.no) + '</span><span class="rb-tag t-memory">' + (SRC[act.source] || act.source) + '</span></div>' +
        '<div class="hint">按「知识边界」格式保存。请检查角色是否「知道了不该知道的事」。修改这一章会让它' + (after ? '及之后 ' + after + ' 章' : '') + '和对话历史的缓存重建一次。</div>' +
        '<div class="sum-legend" id="sv-legend"><div class="sl-t">段落标题对照（标题保持英文发送给模型，请勿翻译）</div>' + R.SUMMARY_SECTIONS.map(k => '<span class="sl-item"><code>' + k + '</code>' + R.SUMMARY_SECTION_CN[k] + '</span>').join('') + '</div>' +
        '<div class="group form"><textarea id="sv-text" rows="16"></textarea><div class="rb-meta" id="sv-meta"></div>' +
        '<div class="btn-row"><button class="pill-btn" id="sv-cancel">关闭</button><button class="pill-btn" id="sv-errata" title="不改写这一章：把补充 / 更正写进记忆增量（历史之后），缓存不重建">追加勘误（不破坏缓存）</button><button class="pill-btn primary" id="sv-save">保存修改</button></div></div>' +
        '<div class="hint small">覆盖 ' + act.coveredIds.length + ' 条消息 · ' + fmtTime(act.at) + (act.mergedFrom ? ' · 合并自 ' + act.mergedFrom.map(R.slabel).join('、') : '') + '</div>' +
        ((act.history || []).length ? '<div class="group-title">这一章的历史版本</div><div class="group" id="sv-hist"></div>' : '');
      const ta = box.querySelector('#sv-text'); ta.value = act.content;
      const meta = () => { const c = R.canonicalize(ta.value); box.querySelector('#sv-meta').textContent = c.length + ' 字 · 约 ' + R.estimateTokens(c) + ' Token' + (c === act.content ? ' · 未修改' : ' · 已修改'); };
      ta.addEventListener('input', meta); meta();
      if (host.expandTextarea) host.expandTextarea(ta, 'L3 · 章节 ' + R.slabel(act.no), '全屏编辑完成后回到这里，点「保存修改」。段落标题：' + R.SUMMARY_SECTIONS.map(k => k + '=' + R.SUMMARY_SECTION_CN[k]).join('，') + '（标题保持英文）。');
      const back = () => { this.panel.view = null; this._render(); };
      box.querySelector('#sv-back').onclick = back; box.querySelector('#sv-cancel').onclick = back;
      const saveText = text => {
        const r = R.editChapter(d.state, act.no, text, Date.now());
        if (!r.changed) { host.toast('内容没有变化'); return false; }
        d.state = r.state; normalized.add(r.state); host.saveConv(conv); host.refresh(); host.toast('章节 ' + R.slabel(act.no) + ' 已保存'); return true;
      };
      box.querySelector('#sv-save').onclick = () => {
        if (!R.canonicalize(ta.value)) { host.toast('章节不能为空'); return; }
        saveText(ta.value); back();
      };
      box.querySelector('#sv-errata').onclick = async () => {
        const t = await host.dialog({ title: '章节 ' + R.slabel(act.no) + ' 勘误', body: '补充遗漏或更正错误（不改写这一章，写进记忆增量，前缀缓存不变）：', input: true, value: '', okText: '追加' });
        if (!t || !String(t).trim()) return;
        const r = R.addErratum(d.state, act.no, t, Date.now());
        d.state = r.state; normalized.add(r.state); host.saveConv(conv); host.refresh(); host.toast('勘误已写入记忆增量（位于对话历史之后，前缀缓存不变）'); back();
      };
      const hl = box.querySelector('#sv-hist');
      if (hl) act.history.slice().reverse().forEach(h => {
        const el = document.createElement('div'); el.className = 'prov-item hist-row';
        el.innerHTML = '<div class="pi-main"><div class="pi-name">' + host.esc(h.content.slice(0, 40)) + '</div><div class="pi-sub">' + (SRC[h.source] || h.source || '') + ' · ' + fmtTime(h.at) + '</div></div><button class="chip-btn accent">恢复</button>';
        el.querySelector('button').onclick = async () => {
          const ok = await host.dialog({ title: '恢复这个版本？', body: '当前内容会保存在历史版本里。', okText: '恢复' });
          if (ok && saveText(h.content)) back();
        };
        hl.appendChild(el);
      });
    },

    // ----- 缓存监控（第 22 / 24 / 39 节） -----
    _health(body, conv, host) {
      const d = data(conv); const st = d.state; const p = planConv(conv, host);
      const tok = p.tokens || {};
      const lore = (st.loreFired || []).slice(-8);
      const ls = (R.loreStateOf && R.loreStateOf(st)) || { turn: 0, entries: {} };
      const stickyN = Object.keys(ls.entries || {}).filter(id => (ls.entries[id].stickyUntil | 0) > (ls.turn | 0)).length;
      const cdN = Object.keys(ls.entries || {}).filter(id => (ls.entries[id].cooldownUntil | 0) > (ls.turn | 0)).length;
      const card = document.createElement('div'); card.className = 'rp-health';
      card.innerHTML =
        '<div class="layer-head"><span class="lh-no">体检</span><span class="lh-t">上下文简化体检</span><span class="lh-sub">只读摘要</span></div>' +
        '<div class="rp-block"><div class="rb-top"><span class="rb-title">Token 占用</span></div>' +
        '<div class="rb-prev">合计约 ' + (tok.total || 0) + ' · 预算 ' + ((st.settings && st.settings.max_context) || '—') +
        (p.overBudget ? ' · <b style="color:#f66">超预算</b>' : ' · 正常') + '</div></div>' +
        '<div class="rp-block"><div class="rb-top"><span class="rb-title">分层指纹</span></div>' +
        '<div class="rb-prev">' + (R.LAYERS || []).map(k => R.LAYER_TITLES[k] + ' ' + ((p.fp && p.fp[k]) ? String(p.fp[k]).slice(0, 8) : '—')).join(' · ') + '</div></div>' +
        '<div class="rp-block"><div class="rb-top"><span class="rb-title">世界书状态机</span></div>' +
        '<div class="rb-prev">回合 ' + (ls.turn | 0) + ' · sticky 中 ' + stickyN + ' · cooldown 中 ' + cdN +
        ' · 冻结 ' + ((st.loreFired || []).length) + ' 条</div></div>' +
        (lore.length ? '<div class="rp-block"><div class="rb-top"><span class="rb-title">最近触发</span></div><div class="rb-prev">' +
          lore.map(x => host.esc(x.name || x.entryId)).join('、') + '</div></div>' : '') +
        (st.loreEditedWhileFrozen ? '<div class="rp-block"><div class="rb-prev">⚠ 世界书已编辑但冻结未重建（可到世界书卡片点重建）</div></div>' : '');
      body.appendChild(card);
    },

    _monitor(body, conv, host) {
      const c = cfg(host);
      const logs = loadLogs(host, conv);
      const s = R.stats(logs, c.prices, c.priceMode, undefined, c.peak);
      const an = R.detectAnomaly(logs);
      const last = s.last;
      const kv = (k, v, cls) => '<div class="kv' + (cls ? ' ' + cls : '') + '"><span>' + k + '</span><b>' + v + '</b></div>';
      let html = '';
      if (an.anomaly) {
        html += '<div class="rp-alert"><b>⚠ 缓存命中率骤降</b><div>最近平均 ' + pct(an.avg) + ' → 本次 ' + pct(an.current) + '</div><div class="ra-sub">可能原因：</div><ol>' +
          an.causes.map(x => '<li>' + host.esc(x) + '</li>').join('') + '</ol></div>';
      }
      html += '<div class="group-title">本次请求' + (last ? ' · 请求编号 ' + reqNo(last.request_id) : '') + '</div><div class="group form kv-box">';
      if (!last) html += '<div class="muted" style="padding:8px 0">还没有请求记录。发送一条消息后这里会显示服务商返回的真实用量。</div>';
      else {
        html += last.supported ? '<div class="hit-big ' + tone(last.hit_rate) + '">' + pct(last.hit_rate) + '<small>命中率</small></div>'
          : '<div class="muted" style="padding:8px 0">该服务商没有返回缓存命中数据（不支持统计）。目前 DeepSeek、千问、OpenAI、Claude 会返回缓存命中数据。</div>';
        html += '<div class="diag">' + R.LAYERS.map(k => { const v = (last.diag || {})[k] || '—'; return '<div class="dg-row" title="' + R.LAYER_EN[k] + ' ' + v + '"><span>' + R.LAYER_TITLES[k] + '</span><b class="dg-' + v.toLowerCase() + '">' + R.diagLabel(v) + '</b></div>'; }).join('') + '</div>';
        html += '<div class="dg-reason"><span>原因：</span>' + (last.reasons || [last.reason]).map(r => host.esc(r)).join('；') + '</div>';
        html += kv('是否发生摘要', last.summary_happened ? (last.summary_merged ? '合并 · ' : '追加 · ') + R.slabel(last.summary_no) + (last.summary_cost ? '（估算额外 ' + costText(last.summary_cost) + '）' : '') : last.summary_error ? '失败：' + host.esc(last.summary_error.slice(0, 30)) : '否') +
          kv('是否超预算', last.over_budget ? '是' : '否', last.over_budget ? 'bad' : '') +
          kv('输入 Token', num(last.prompt_tokens)) + (last.supported ? kv('缓存命中', num(last.cache_hit_tokens), 'ok') + kv('未命中', num(last.cache_miss_tokens), 'bad') : '') +
          kv('输出 Token', num(last.completion_tokens));
      }
      html += '</div>';
      if (last && last.layer_tokens) {
        const lt = last.layer_tokens; const tot = R.LAYERS.reduce((n, k) => n + (lt[k] || 0), 0) || 1;
        html += '<div class="group-title">上下文构成（本地估算 Token）</div><div class="group form kv-box ctx-break">' +
          R.LAYERS.map(k => '<div class="cb-row"><span>' + R.LAYER_TITLES[k] + '</span><i style="width:' + Math.max(1, Math.round((lt[k] || 0) / tot * 100)) + '%" class="cb-' + k + '"></i><b>' + num(lt[k] || 0) + '</b></div>').join('') + '</div>';
      }
      html += '<div class="group-title">今日</div><div class="group form kv-box">' +
        kv('今日请求', s.today.requests) + kv('输入 Token', num(s.today.prompt)) + kv('缓存命中', num(s.today.hit), 'ok') + kv('未命中', num(s.today.miss), 'bad') + kv('命中率', pct(s.today.rate)) + '</div>';
      html += '<div class="group-title">本会话</div><div class="group form kv-box">' +
        '<div class="miss-big"><span>平均每次请求未命中 Token</span><b>' + num(s.avgMiss) + '</b><small>比命中率更能反映实际花费</small></div>' +
        kv('请求次数', s.requests + (s.supported < s.requests ? '（有统计 ' + s.supported + '）' : '')) + kv('平均命中率', pct(s.avgRate)) + kv('总命中率（按 Token 计）', pct(s.total.rate)) +
        kv('最高 / 最低', pct(s.max) + ' / ' + pct(s.min)) + kv('连续命中次数', s.streak) + kv('章节摘要次数', s.summaries) +
        kv('估算已节省', s.priced ? fmtUsd(s.saved) : '—（没有匹配的价格）', 'ok') + '</div>';
      html += '<div class="group-title">最近 ' + s.last20.length + ' 次</div><div class="group form kv-box">' +
        '<div class="mini-chart">' + (s.last20.length ? s.last20.map(r => '<i class="' + (r.supported ? tone(r.rate) : 'na') + '" style="height:' + (r.supported ? Math.max(4, Math.round(r.rate * 100)) : 4) + '%"></i>').join('') : '<span class="muted">暂无数据</span>') + '</div>' +
        '<div class="l20">' + s.last20.slice().reverse().map(r => '<div class="l20-row"><span class="l20-n">#' + r.n + '</span><b class="tone-t-' + (r.supported ? tone(r.rate) : 'info') + '">' + (r.supported ? pct(r.rate) : '—') + '</b><span class="l20-m">未命中 ' + fmtN(r.miss) + '</span><span class="l20-r">' + (r.summary ? '📚 ' : '') + host.esc(r.reason || '') + '</span></div>').join('') + '</div></div>';
      html += '<div class="hint" style="margin-top:12px">DeepSeek / 千问隐式缓存由服务端尽力而为（千问显式缓存在 5 分钟内确定命中），插件只能让前缀更稳定，不能保证 100% 命中。上下文各层 Token 为本地估算；日志默认只保存统计、指纹、时间、模型和请求编号。</div>' +
        '<button class="ghost-btn danger" id="rp-clear-log">清空本会话统计</button>';
      body.innerHTML = html;
      body.querySelector('#rp-clear-log').onclick = async () => {
        const ok = await host.dialog({ title: '清空统计？', body: '只删除本对话的缓存统计记录，不影响聊天内容。', okText: '清空', danger: true });
        if (!ok) return; clearLogs(host, conv); this._render();
      };
    },

    // ----- 预算设置（每个会话独立） -----
    _opts(body, conv, host) {
      const d = data(conv); const s0 = d.state.settings;
      const pa = planConvAuto(conv, host); const env = pa.env;
      const s = pa.p.settings || s0; // 自动预算时显示推导出的数值
      const n = (id, label, v, step, hint) => '<label class="field"><span>' + label + (hint ? '<small>' + hint + '</small>' : '') + '</span><input id="' + id + '" type="number" min="0" step="' + (step || 1) + '" value="' + v + '" inputmode="numeric"></label>';
      const srcCN = { meta: '模型列表接口', table: '内置窗口表', default: '未知模型（默认 64K）', 'deepseek-default': 'DeepSeek（沿用原有默认值）' };
      const pr = env ? R.priceFor(env.cost.model, env.cost.prices) : null;
      const autoBox = env ? '<div class="group-title">自动策略</div><div class="group form" id="rp-auto">' +
        '<div class="kv"><span>缓存能力</span><b>' + host.esc(env.cap.label) + '</b></div>' +
        '<div class="kv"><span>当前策略</span><b id="rp-strategy">' + ({ explicit: '显式缓存（自动断点）', implicit: '隐式缓存（自动前缀）', none: '无缓存' }[env.strategy] || env.strategy) + '</b></div>' +
        '<div class="hint small" style="margin:0 0 6px">' + host.esc(env.strategyWhy) + '</div>' +
        (env.cap.kind === 'explicit' && env.cap.vendor === 'qwen' ? '<label class="field"><span>千问缓存方式<small>自动：连续对话用显式缓存（命中 10%），间隔常超过 4 分钟改用隐式缓存（命中 20%，无创建费）</small></span><select id="rp-cache-mode"><option value="auto">自动</option><option value="explicit">总是显式缓存</option><option value="implicit">总是隐式缓存</option></select></label>' : '') +
        '<div class="kv"><span>上下文窗口</span><b>' + num(env.budget.window) + (env.budget.tier ? '（价格第一档 ≤ ' + num(env.budget.tier) + '）' : '') + ' · 来源：' + (srcCN[env.budget.source] || env.budget.source) + '</b></div>' +
        '<div class="kv"><span>价格</span><b>' + (pr ? (pr.builtin ? '内置价格表' : '你的价格规则') + '「' + host.esc(String(pr.match || '').split(',')[0]) + '」' : '未匹配（只按固定阈值）') + '</b></div>' +
        '<div class="kv"><span>近期命中率 / 空闲</span><b>' + pct(env.hitRate) + ' / ' + (env.idleSec == null ? '—' : Math.round(env.idleSec / 60) + ' 分钟') + (env.cold ? '（缓存可能已过期）' : '') + '</b></div>' +
        '<label class="field inline"><span>预算按模型自动推导<small>上限 = 窗口、价格第一档、200K 三者取最小 × 0.8，摘要阈值 30%，章节上限 12%；手动修改下面任一预算即关闭</small></span><input type="checkbox" class="switch" id="rp-auto-budget"' + (s0.auto_budget !== false ? ' checked' : '') + '></label>' +
        '<label class="field inline"><span>自适应摘要时机<small>缓存过期时提前摘要（重建免费）；达到阈值 70% 后按「几轮回本」决定；关闭则只按固定阈值</small></span><input type="checkbox" class="switch" id="rp-auto-sum"' + (s0.auto_summary !== false ? ' checked' : '') + '></label>' +
        (pa.p.auto ? '<div class="hint small" style="margin:0">自适应判断：' + host.esc(pa.p.auto.why || '—') + '</div>' : '') + '</div>' : '';
      body.innerHTML = '<div class="hint">固定设定 + 长期记忆 + 章节摘要 + 对话历史 + 当前状态 + 本轮输入 + 输出预留 + 安全余量 ≤ 上下文上限。默认按模型自动推导（不是官方阈值），也可每个对话单独手动设置。</div>' + autoBox +
        '<div class="group-title">Token 预算' + (env && s0.auto_budget !== false ? '（自动）' : '') + '</div><div class="group form">' +
        n('rp-maxctx', '上下文上限', s.max_context, 1000, '一次请求最多使用的 Token 数（含输出预留和安全余量）') +
        n('rp-reserve', '输出预留', s.output_reserve, 1000, '给模型回复留出的 Token，不会被历史占用') +
        n('rp-margin', '安全余量', s.safety_margin, 500, 'Token 为本地估算，留一点余量防止超出模型上限') + '</div>' +
        '<div class="group-title">章节摘要</div><div class="group form">' +
        '<label class="field inline"><span>超过阈值自动生成摘要<small>关闭后，超出预算时只能一次性截断较早的历史</small></span><input type="checkbox" class="switch" id="rp-sum-on"' + (s.summary.enabled ? ' checked' : '') + '></label>' +
        n('rp-trigger', '触发摘要的历史长度', s.summary.trigger_tokens, 1000, '未摘要的对话历史超过这么多 Token 时，生成下一版章节摘要') +
        n('rp-minnew', '至少新增轮数', s.summary.min_new_turns, 1, '除保留的最近几轮外，至少还要有这么多轮旧对话才会摘要，避免频繁摘要') +
        n('rp-keep', '保留最近轮数', s.summary.keep_recent_turns, 1, '最近这几轮始终发送原文，不写进摘要') +
        n('rp-mingap', '摘要最小间隔（轮）', s.summary.min_interval_turns, 1, '距上一章不足这么多轮时，即使达到阈值也先不摘要（超预算除外）') +
        n('rp-cap', '章节合计上限', s.summary.chapter_cap_tokens, 1000, '全部章节超过这么多 Token 时，下一次摘要改为合并全部章节（缓存重建一次）') +
        '<label class="field"><span>摘要所用模型<small>留空 = 与对话相同；可以填更便宜的模型</small></span><input id="rp-summodel" type="text" placeholder="例如 deepseek-flash" value="' + host.esc(s.summary_model || '') + '"></label>' +
        '<div class="hint small" style="margin:0">超出上下文上限时会立即摘要，不受以上条件限制。</div></div>' +
        '<div class="group-title">设定提取</div><div class="group form">' +
        '<label class="field inline"><span>首条消息自动提取设定<small>首轮发送时并行提取（首条消息 ≥80 字且含角色 / 世界观 / 设定等词），把首条消息里的角色 / 世界观 / 规则填进空白的分层设定</small></span><input type="checkbox" class="switch" id="rp-extract-on"' + (s0.auto_extract !== false ? ' checked' : '') + '></label></div>' +
        '<div class="group-title">冻结与估算</div><div class="group form">' +
        '<label class="field inline"><span>重新生成时刷新冻结的用户消息<small>默认关闭：重新生成最后一条回复时沿用首次发送的原文（含当时的联网 / 文件内容），保持缓存</small></span><input type="checkbox" class="switch" id="rp-refresh"' + (s.refresh_on_regen ? ' checked' : '') + '></label>' +
        '<label class="field inline"><span>修改世界书后立即重建上下文<small>与世界书编辑页同一开关；开启后清空冻结并冷路径重排</small></span><input type="checkbox" class="switch" id="rp-lore-rebuild"' + ((s.lore && s.lore.rebuildOnEdit) ? ' checked' : '') + '></label>' +
        '<div class="kv"><span>Token 估算校准系数</span><b>× ' + (d.state.calib || 1).toFixed(2) + (d.state.calibN ? '（已按 ' + d.state.calibN + ' 次真实用量校准）' : '（尚未校准）') + '</b></div>' +
        '<button class="chip-btn" id="rp-calib-reset" type="button">重置校准</button></div>' +
        '<div class="group-title">调试</div><div class="group form">' +
        '<label class="field inline"><span>保存完整提示词<small>默认关闭：日志只保存 Token 统计、指纹、时间、模型和请求编号</small></span><input type="checkbox" class="switch" id="rp-saveprompt"' + (s.save_prompt ? ' checked' : '') + '></label></div>' +
        '<button class="ghost-btn" id="rp-reset-win">重置截断起点</button><div class="hint small">截断起点：摘要关闭且超出预算时，从哪条消息开始发送历史。重置后会重新计算。</div>';
      if (body.querySelector('#rp-cache-mode')) {
        body.querySelector('#rp-cache-mode').value = s0.cache_mode || 'auto';
        body.querySelector('#rp-cache-mode').onchange = e => { data(conv).state.settings.cache_mode = e.target.value; host.saveConv(conv); this._render(); };
      }
      if (body.querySelector('#rp-auto-budget')) body.querySelector('#rp-auto-budget').onchange = e => {
        const st2 = data(conv).state.settings;
        if (!e.target.checked && env) { // 关闭自动：把当前推导值写成手动初值
          const b = env.budget; Object.assign(st2, { max_context: b.max_context, output_reserve: b.output_reserve, safety_margin: b.safety_margin });
          st2.summary = Object.assign({}, st2.summary, { trigger_tokens: b.trigger_tokens, chapter_cap_tokens: b.chapter_cap_tokens });
        }
        if (e.target.checked) { // 重新开启自动：清除手动覆盖
          const D = R.DEFAULT_SETTINGS; Object.assign(st2, { max_context: D.max_context, output_reserve: D.output_reserve, safety_margin: D.safety_margin });
          st2.summary = Object.assign({}, st2.summary, { trigger_tokens: D.summary.trigger_tokens, chapter_cap_tokens: D.summary.chapter_cap_tokens });
        }
        st2.auto_budget = e.target.checked; host.saveConv(conv); host.refresh(); this._render();
      };
      if (body.querySelector('#rp-auto-sum')) body.querySelector('#rp-auto-sum').onchange = e => { data(conv).state.settings.auto_summary = e.target.checked; host.saveConv(conv); host.refresh(); this._render(); };
      const BUDGET_IDS = ['#rp-maxctx', '#rp-reserve', '#rp-margin', '#rp-trigger', '#rp-cap'];
      const save = ev => {
        const s = data(conv).state.settings;
        const manualBudget = !!(ev && ev.target && BUDGET_IDS.some(id => ev.target.matches(id)));
        if (manualBudget && s.auto_budget !== false && env) { // 手动改预算 → 关闭自动预算（以当前推导值为初值，再应用这次修改）
          const b = env.budget; Object.assign(s, { max_context: b.max_context, output_reserve: b.output_reserve, safety_margin: b.safety_margin });
          s.summary = Object.assign({}, s.summary, { trigger_tokens: b.trigger_tokens, chapter_cap_tokens: b.chapter_cap_tokens });
        }
        if (manualBudget) s.auto_budget = false;
        const g = (id, min, def) => { const v = parseInt(body.querySelector(id).value, 10); return isNaN(v) ? def : Math.max(min, v); };
        const keepAuto = s.auto_budget !== false && !!env; // 自动预算时，改其他选项不把推导值写成手动值
        const old = s.summary || {};
        if (!keepAuto) { s.max_context = g('#rp-maxctx', 4000, 100000); s.output_reserve = g('#rp-reserve', 0, 12000); s.safety_margin = g('#rp-margin', 0, 2000); }
        s.summary = { enabled: body.querySelector('#rp-sum-on').checked, trigger_tokens: keepAuto ? old.trigger_tokens : g('#rp-trigger', 1000, 30000), min_new_turns: g('#rp-minnew', 1, 15), keep_recent_turns: g('#rp-keep', 1, 20),
          min_interval_turns: g('#rp-mingap', 0, 10), chapter_cap_tokens: keepAuto ? old.chapter_cap_tokens : g('#rp-cap', 1000, 12000) };
        s.refresh_on_regen = body.querySelector('#rp-refresh').checked;
        s.lore = Object.assign({}, s.lore || R.DEFAULT_SETTINGS.lore, { rebuildOnEdit: body.querySelector('#rp-lore-rebuild').checked });
        s.summary_model = body.querySelector('#rp-summodel').value.trim();
        host.saveConv(conv); host.refresh();
      };
      body.querySelector('#rp-extract-on').onchange = e => { data(conv).state.settings.auto_extract = e.target.checked; host.saveConv(conv); };
      body.querySelectorAll('input:not(#rp-saveprompt):not(#rp-auto-budget):not(#rp-auto-sum):not(#rp-extract-on)').forEach(i => i.addEventListener('change', save));
      body.querySelector('#rp-saveprompt').onchange = async e => {
        if (e.target.checked) {
          const ok = await host.dialog({ title: '开启完整提示词日志？', body: '日志可能包含角色卡、私密剧情、API 请求内容，请谨慎使用。\n\n日志只保存在本机（不会上传），可随时在「缓存监控」中清空。', okText: '仍然开启', danger: true });
          if (!ok) { e.target.checked = false; return; }
        }
        data(conv).state.settings.save_prompt = e.target.checked; host.saveConv(conv);
        host.toast(e.target.checked ? '已开启完整提示词日志' : '已关闭完整提示词日志');
      };
      body.querySelector('#rp-calib-reset').onclick = () => { const d2 = data(conv); d2.state = Object.assign({}, d2.state, { calib: 1, calibN: 0 }); normalized.add(d2.state); host.saveConv(conv); host.toast('已重置校准系数'); this._render(); };
      body.querySelector('#rp-reset-win').onclick = () => { data(conv).state.window = { startId: null, startOrdinal: 0 }; host.saveConv(conv); host.refresh(); host.toast('已重置截断起点'); };
    },
  });
  plugin._internals = { toItems, makeSummary, planConv, planConvAuto, loadLogs, applicability, convItems, rpLike, autoActive, envFor, placeMarkers, autoExtract, firstUserText, undoExtract, importSections };

  // 第二个内置插件：Token 用量显示（演示通用钩子；对所有对话生效，可在对话中关闭）
  reg.register({
    id: 'usage', icon: '📊', name: 'Token 用量显示', version: '1.0.0', perConversation: false, defaultEnabled: false,
    desc: '在每条回复上显示本次请求的输入 / 输出 Token 数（服务商返回用量数据时）。',
    hooks: {
      messageBadges(msg) {
        if (msg.role !== 'assistant' || !msg.usage || msg.usage.prompt == null) return [];
        return [{ text: '输入 ' + fmtN(msg.usage.prompt) + ' · 输出 ' + fmtN(msg.usage.completion || 0), tone: 'info', title: '输入 ' + msg.usage.prompt + ' Token / 输出 ' + (msg.usage.completion || 0) + ' Token' }];
      },
    },
  });
})();
