/* 全局 Token 用量统计（v0.3.5）。纯函数模块，无 DOM 依赖。
 * 持久化结构 usage-stats.json：{ version, backfilled, log:[...], prices, priceMode }
 * 每条记录：输入/输出/缓存命中与未命中、模型、服务商、对话、时间、类型（chat/image/summary）。
 */
(function (root) {
  'use strict';

  const CostCore = root.CostCore || (typeof require === 'function' ? require('./cost-core.js') : null);
  if (!CostCore) throw new Error('UsageStats requires cost-core.js');

  const VERSION = 1;
  const LOG_LIMIT = 5000;
  /** 可编辑默认价目（与 CostCore 同源；含 default 兜底）。千问等走 CostCore.BUILTIN。 */
  const DEFAULT_PRICES = Object.assign({}, CostCore.USAGE_DEFAULT_PRICES);
  // 实际会优先合并 RP 插件里用户改过的价格；未知非 builtin 模型才用 default

  const TYPE_CN = { chat: '对话', image: '图片', summary: '摘要' };

  function emptyState() {
    return { version: VERSION, backfilled: false, log: [], prices: Object.assign({}, DEFAULT_PRICES), priceMode: 'auto', calib: CostCore.emptyCalib() };
  }
  function normalize(raw) {
    const s = Object.assign(emptyState(), raw || {});
    s.prices = Object.assign({}, DEFAULT_PRICES, s.prices || {});
    if (!Array.isArray(s.log)) s.log = [];
    if (!['auto', 'peak', 'offpeak'].includes(s.priceMode)) s.priceMode = 'auto';
    if (!s.calib || typeof s.calib !== 'object') s.calib = CostCore.emptyCalib();
    s.version = VERSION;
    return s;
  }

  function makeEntry(o) {
    const u = o.usage || {};
    const prompt = u.prompt | 0, completion = u.completion | 0;
    const cache = !!u.cacheSupported;
    const hit = cache ? (u.hit | 0) : 0;
    const miss = cache ? (u.miss != null ? u.miss | 0 : Math.max(0, prompt - hit)) : prompt;
    const at = o.at || Date.now();
    const type = o.type || 'chat';
    const msgId = o.msgId || '';
    const key = o.key || ('l:' + at + ':' + msgId + ':' + prompt + ':' + completion + ':' + type);
    const actualCost = (typeof u.cost === 'number' && isFinite(u.cost)) ? u.cost
      : (typeof o.actualCost === 'number' && isFinite(o.actualCost) ? o.actualCost : null);
    return {
      id: o.id || ('u_' + at.toString(36) + '_' + Math.random().toString(36).slice(2, 8)),
      at, type, prompt, completion, hit, miss, cache,
      model: o.model || '', providerId: o.providerId || '', providerName: o.providerName || '',
      convId: o.convId || '', convTitle: o.convTitle || '', msgId, key,
      actualCost,
    };
  }

  /** 追加一条；按 key 去重；超出上限删最旧。返回新 state（不修改入参）。 */
  function record(state, entry) {
    const s = normalize(state);
    if (!entry || entry.prompt == null) return s;
    if (s.log.some(e => e.key === entry.key)) return s;
    const log = s.log.concat([entry]);
    while (log.length > LOG_LIMIT) log.shift();
    return Object.assign({}, s, { log });
  }

  function clear(state) {
    const s = normalize(state);
    return Object.assign({}, s, { log: [], backfilled: true });
  }

  /** 高峰判定与 rpcache / CostCore 同源（可配 peak 窗口） */
  function isPeak(at, peak) { return CostCore.isPeak(at, peak); }
  function priceFor(model, prices) { return CostCore.priceForUsage(model, prices || DEFAULT_PRICES); }
  /** 单条估算花费（美元）。与 rpcache.costOf 共用 CostCore 价目。 */
  function costOf(e, prices, mode, peak, calib) {
    return CostCore.costOfEntry(e, prices || DEFAULT_PRICES, mode, peak, calib);
  }
  /** D2：用真实 actualCost 对账，写回 state.calib */
  function reconcileEntry(state, entry, mode, peak) {
    const s = normalize(state);
    if (!entry || entry.actualCost == null || !(entry.actualCost > 0)) return s;
    const est = costOf(entry, s.prices, mode || s.priceMode, peak, null); // 未校准价估算，避免反馈环
    if (!(est > 0)) return s;
    const calib = CostCore.reconcile(s.calib, entry.model, est, entry.actualCost, { now: entry.at });
    return Object.assign({}, s, { calib });
  }

  function dayKey(at, tzOffsetMin) {
    // 用本地日历日（或指定偏移）归桶
    const d = new Date(at);
    if (tzOffsetMin != null) {
      const x = new Date(d.getTime() + tzOffsetMin * 60000);
      return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + String(x.getUTCDate()).padStart(2, '0');
    }
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  function monthKey(at) {
    const d = new Date(at);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  /** 日期范围：{ from, to } 毫秒，含两端当天。preset: today|7d|30d|all|custom */
  function rangeOf(preset, now, custom) {
    now = now == null ? Date.now() : now;
    const startOfDay = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const endOfDay = t => { const d = new Date(t); d.setHours(23, 59, 59, 999); return d.getTime(); };
    if (preset === 'today') return { from: startOfDay(now), to: endOfDay(now) };
    if (preset === '7d') return { from: startOfDay(now - 6 * 864e5), to: endOfDay(now) };
    if (preset === '30d') return { from: startOfDay(now - 29 * 864e5), to: endOfDay(now) };
    if (preset === 'custom' && custom) return { from: startOfDay(custom.from), to: endOfDay(custom.to) };
    return { from: 0, to: endOfDay(now) }; // all
  }

  function filterLog(log, range) {
    if (!range) return (log || []).slice();
    return (log || []).filter(e => e.at >= range.from && e.at <= range.to);
  }

  function sumList(list) {
    let prompt = 0, completion = 0, hit = 0, miss = 0, requests = 0, cachedReqs = 0;
    (list || []).forEach(e => {
      prompt += e.prompt | 0; completion += e.completion | 0;
      hit += e.hit | 0; miss += e.miss | 0; requests++;
      if (e.cache) cachedReqs++;
    });
    return { prompt, completion, total: prompt + completion, hit, miss, requests, cachedReqs };
  }

  function groupBy(list, keyFn) {
    const map = new Map();
    (list || []).forEach(e => {
      const k = keyFn(e) || '（未知）';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(e);
    });
    return [...map.entries()].map(([key, items]) => Object.assign({ key }, sumList(items), { items }))
      .sort((a, b) => b.total - a.total);
  }

  function byDay(list, days, now) {
    now = now == null ? Date.now() : now;
    const n = days || 30;
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const t = now - i * 864e5;
      const k = dayKey(t);
      const items = (list || []).filter(e => dayKey(e.at) === k);
      out.push(Object.assign({ key: k, label: k.slice(5) }, sumList(items)));
    }
    return out;
  }

  function estimateCost(list, prices, mode, peak, calib) {
    let cost = 0, priced = 0, actualSum = 0, actualN = 0;
    (list || []).forEach(e => {
      const c = costOf(e, prices, mode, peak, calib);
      if (c != null) { cost += c; priced++; }
      if (e && typeof e.actualCost === 'number' && e.actualCost > 0) { actualSum += e.actualCost; actualN++; }
    });
    return { cost, priced, total: (list || []).length, actualSum, actualN };
  }

  /** 从对话消息（含版本分支）收集带 usage 的条目；keysSeen 用于去重。 */
  function collectFromMessages(msgs, meta, keysSeen, out) {
    meta = meta || {};
    keysSeen = keysSeen || new Set();
    out = out || [];
    (msgs || []).forEach(m => {
      if (m && m.usage && m.usage.prompt != null && !m.pending && !m.error) {
        const type = m.imageGen ? 'image' : 'chat';
        const key = 'bf:' + (m.id || '') + ':' + (m.createdAt || 0) + ':' + (m.usage.prompt | 0) + ':' + ((m.usage.completion || 0) | 0) + ':' + type;
        if (!keysSeen.has(key)) {
          keysSeen.add(key);
          out.push(makeEntry({
            usage: m.usage, at: m.createdAt || meta.updatedAt || Date.now(), type,
            model: (m.model || meta.model || '').replace(/\s·.*$/, ''), // 「model · 生成图片」去掉后缀
            providerId: meta.providerId || '', providerName: meta.providerName || '',
            convId: meta.convId || '', convTitle: meta.convTitle || '',
            msgId: m.id || '', key,
          }));
        }
      }
      if (m && Array.isArray(m.versions)) {
        m.versions.forEach(snap => {
          if (!snap) return;
          const fake = Object.assign({ id: m.id, role: m.role }, snap);
          delete fake.tail;
          collectFromMessages([fake], meta, keysSeen, out);
          if (snap.tail && snap.tail.length) collectFromMessages(snap.tail, meta, keysSeen, out);
        });
      }
    });
    return out;
  }

  /**
   * 一次性回填：扫描所有对话。已 backfilled 则原样返回。
   * convs: [{ id, title, providerId, providerName, model, updatedAt, messages }]
   */
  function backfill(state, convs) {
    const s = normalize(state);
    if (s.backfilled) return s;
    const keysSeen = new Set(s.log.map(e => e.key));
    const added = [];
    (convs || []).forEach(c => {
      collectFromMessages(c.messages, {
        convId: c.id, convTitle: c.title, providerId: c.providerId,
        providerName: c.providerName, model: c.model, updatedAt: c.updatedAt,
      }, keysSeen, added);
    });
    // 按时间排序后追加
    added.sort((a, b) => a.at - b.at);
    let log = s.log.slice();
    added.forEach(e => { log.push(e); });
    while (log.length > LOG_LIMIT) log.shift();
    return Object.assign({}, s, { log, backfilled: true });
  }

  /** 日/月桶（从当前 log 现算，便于展示） */
  function buckets(list) {
    const daily = {}, monthly = {};
    (list || []).forEach(e => {
      const d = dayKey(e.at), m = monthKey(e.at);
      daily[d] = sumList((daily[d] && daily[d]._items ? daily[d]._items : []).concat([e]));
      daily[d]._items = (daily[d]._items || []).concat([e]);
      monthly[m] = sumList((monthly[m] && monthly[m]._items ? monthly[m]._items : []).concat([e]));
      monthly[m]._items = (monthly[m]._items || []).concat([e]);
    });
    Object.keys(daily).forEach(k => { delete daily[k]._items; });
    Object.keys(monthly).forEach(k => { delete monthly[k]._items; });
    return { daily, monthly };
  }

  function toCSV(list) {
    const header = ['时间', '类型', '模型', '服务商', '对话', '输入', '输出', '缓存命中', '未命中', '有缓存字段'];
    const rows = (list || []).map(e => [
      new Date(e.at).toISOString(), TYPE_CN[e.type] || e.type, e.model, e.providerName || e.providerId,
      (e.convTitle || '').replace(/"/g, '""'), e.prompt, e.completion, e.hit, e.miss, e.cache ? '是' : '否',
    ]);
    return [header].concat(rows).map(r => r.map(c => '"' + String(c) + '"').join(',')).join('\n');
  }
  function toJSON(list) { return JSON.stringify(list || [], null, 2); }

  const api = {
    VERSION, LOG_LIMIT, DEFAULT_PRICES, TYPE_CN,
    emptyState, normalize, makeEntry, record, clear,
    isPeak, priceFor, costOf, reconcileEntry, dayKey, monthKey, rangeOf, filterLog,
    sumList, groupBy, byDay, estimateCost, collectFromMessages, backfill, buckets,
    toCSV, toJSON,
    distortedModels: (calib) => CostCore.distortedModels(calib),
    calibView: CostCore.calibView,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UsageStats = api;
})(typeof window !== 'undefined' ? window : globalThis);
