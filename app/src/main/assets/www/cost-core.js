/* 统一成本引擎：共享价目 + costOf / priceFor + 真实账单 EWMA 对账。
 * 供 usage-stats / rpcache / 指标页共用同一份价目，避免千问等被 default 高估。
 * 纯逻辑，可在 Node 单测里 require。 */
(function (root) {
  'use strict';

  const CNY_PER_USD = 7.2;
  const DEFAULT_PEAK = { windows: '09:00-12:00,14:00-18:00', tz: 8, weekdays: true, off_factor: 0.5 };

  /** DeepSeek 官方价（美元 / 百万 Token，高峰）；非高峰为一半。 */
  const DEFAULT_PRICES = {
    'deepseek-flash': { hit: 0.006, miss: 0.3, out: 1.2, match: 'deepseek' },
    'deepseek-v4-pro': { hit: 0.044, miss: 1.32, out: 3.96, match: 'deepseek-v4-pro,deepseek-pro' },
  };

  // 千问：阿里云百炼中国站第一档（元 / 百万 Token）→ 美元；隐式命中 20%、显式命中 10%、创建 125%；peak:false
  const qp = (miss, out, match) => {
    const m = miss / CNY_PER_USD, r = v => Math.round(v * 1e5) / 1e5;
    return { hit: r(m * 0.2), hit_explicit: r(m * 0.1), write: r(m * 1.25), miss: r(m), out: r(out / CNY_PER_USD), match, peak: false, builtin: true };
  };
  const BUILTIN_PRICES = {
    'deepseek-flash': Object.assign({}, DEFAULT_PRICES['deepseek-flash'], { builtin: true }),
    'deepseek-v4-pro': Object.assign({}, DEFAULT_PRICES['deepseek-v4-pro'], { builtin: true }),
    'qwen3.8-max': qp(12, 36, 'qwen3.8-max,qwen3.7-max'),
    'qwen3.7-plus': qp(2, 8, 'qwen3.7-plus'),
    'qwen3.6-plus': qp(2, 12, 'qwen3.6-plus'),
    'qwen3.5-plus': qp(0.8, 4.8, 'qwen3.5-plus'),
    'qwen-plus': qp(0.8, 2, 'qwen-plus,qwen'),
    'qwen3.8-flash': qp(0.8, 2.7, 'qwen3.8-flash'),
    'qwen3.7-flash': qp(0.2, 0.8, 'qwen3.7-flash'),
    'qwen3.6-flash': qp(1.2, 7.2, 'qwen3.6-flash'),
    'qwen3.5-flash': qp(0.2, 2, 'qwen3.5-flash'),
    'qwen-flash': qp(0.15, 1.5, 'qwen-flash,qwen-turbo'),
    'qwen-max': qp(2.4, 9.6, 'qwen-max'),
    'qwen3-coder-flash': qp(1, 4, 'qwen3-coder-flash,qwen3-coder'),
    'qwen3-vl-plus': qp(1, 10, 'qwen3-vl-plus,qwen-vl'),
    'qwen-plus-character': qp(0.8, 2, 'qwen-plus-character,character'),
    'qwen-long': qp(0.5, 2, 'qwen-long'),
    'gemini-2.5-flash-lite': { hit: 0.025, miss: 0.10, out: 0.40, match: 'gemini-2.5-flash-lite,flash-lite', peak: false, builtin: true },
  };

  /** 用量页可编辑默认（含未知模型兜底 default） */
  const USAGE_DEFAULT_PRICES = Object.assign({}, DEFAULT_PRICES, {
    default: { hit: 0, miss: 0.5, out: 1.5 },
  });

  const EWMA_ALPHA = 0.3;
  const BIAS_ABS_THRESHOLD = 0.15;
  const BIAS_STREAK_MARK = 3;

  /** 有限数字（含数字字符串）→ number，否则 null */
  function finNum(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return isFinite(n) ? n : null;
  }
  const fin0 = v => { const n = finNum(v); return n == null ? 0 : n; };

  function priceForRules(model, prices, builtinOnly) {
    prices = prices || DEFAULT_PRICES;
    const m = String(model || '').toLowerCase();
    if (builtinOnly) {
      let b = null, bl = -1;
      Object.keys(prices).forEach(n => String(prices[n].match).split(',').forEach(k => {
        if (k && m.includes(k) && k.length > bl) { b = prices[n]; bl = k.length; }
      }));
      return b;
    }
    let best = null, bestLen = -1;
    Object.keys(prices).forEach(name => {
      const p = prices[name]; if (!p) return;
      const keys = String(p.match != null ? p.match : name).toLowerCase().split(/[,，\s]+/).filter(Boolean);
      keys.forEach(k => { if (m.includes(k) && k.length > bestLen) { best = p; bestLen = k.length; } });
    });
    if (best) return best;
    if (!m.includes('deepseek')) return null;
    return m.includes('pro') ? prices['deepseek-v4-pro'] || null : prices['deepseek-flash'] || null;
  }

  /** 用户价目优先，否则内置 BUILTIN；未知返回 null */
  function priceFor(model, prices) {
    return priceForRules(model, prices) || (model ? priceForRules(model, BUILTIN_PRICES, true) : null);
  }

  /** 用量页：priceFor + default 兜底（修千问等高估：先走 BUILTIN 再 default） */
  function priceForUsage(model, prices) {
    const p = priceFor(model, prices);
    if (p) return p;
    const bag = prices || USAGE_DEFAULT_PRICES;
    if (bag[model]) return bag[model];
    return bag.default || USAGE_DEFAULT_PRICES.default;
  }

  function parseWindows(str) {
    return String(str || '').split(/[,，;\s]+/).map(x => x.match(/^(\d{1,2}):?(\d{2})?-(\d{1,2}):?(\d{2})?$/)).filter(Boolean)
      .map(r => [(+r[1]) * 60 + (+(r[2] || 0)), (+r[3]) * 60 + (+(r[4] || 0))]).filter(w => w[0] >= 0 && w[1] <= 1440 && w[0] < w[1]);
  }

  function isPeak(at, peak) {
    const pk = Object.assign({}, DEFAULT_PEAK, peak || {});
    const d = new Date(at + (Number(pk.tz) || 0) * 3600e3);
    const day = d.getUTCDay(); const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (pk.weekdays && (day === 0 || day === 6)) return false;
    return parseWindows(pk.windows).some(w => mins >= w[0] && mins < w[1]);
  }

  function peakFactor(at, mode, peak) {
    const off = Object.assign({}, DEFAULT_PEAK, peak || {}).off_factor;
    const f = Number(off); const offF = isNaN(f) ? 0.5 : f;
    return mode === 'peak' ? 1 : mode === 'offpeak' ? offF : (isPeak(at, peak) ? 1 : offF);
  }

  const factorFor = (p, at, mode, peak) => (p && p.peak === false ? 1 : peakFactor(at, mode, peak));

  function scalePrice(p, scale) {
    if (!p || !(scale > 0) || scale === 1) return p;
    const s = scale, r = v => (v == null ? v : Math.round(v * s * 1e6) / 1e6);
    const out = Object.assign({}, p);
    ['hit', 'hit_explicit', 'write', 'miss', 'out'].forEach(k => { if (out[k] != null) out[k] = r(out[k]); });
    out.calibScale = scale;
    return out;
  }

  function priceForCalibrated(model, prices, calib) {
    const p = priceFor(model, prices);
    if (!p) return null;
    const c = calib && model && calib[model];
    if (!c || !(c.scale > 0)) return p;
    return scalePrice(p, c.scale);
  }

  function calibScale(calib, model) {
    const c = calib && model && calib[model];
    return (c && c.scale > 0) ? c.scale : 1;
  }

  /**
   * 把 OpenRouter endpoints 最低有效价同步进 CostCore/用量价目（miss/hit/out）。
   * 不另建价目表：只更新该模型条目，保留用户手改的其它字段。
   */
  function mergeFloorPrice(prices, model, floor, now) {
    if (!model || !floor) return prices || {};
    const bag = Object.assign({}, prices || {});
    const prev = bag[model] || {};
    const rec = Object.assign({}, prev);
    if (floor.prompt > 0) rec.miss = floor.prompt;
    if (floor.cacheRead > 0) rec.hit = floor.cacheRead;
    if (floor.completion > 0) rec.out = floor.completion;
    // v0.28.5：最低价只给了部分字段时，缺的 miss/hit/out 用旧条目或用量默认价补齐，避免 undefined × tokens = NaN
    const def = (bag.default && finNum(bag.default.miss) != null) ? bag.default : USAGE_DEFAULT_PRICES.default;
    if (finNum(rec.miss) == null) rec.miss = finNum(prev.miss) != null ? prev.miss : def.miss;
    if (finNum(rec.out) == null) rec.out = finNum(prev.out) != null ? prev.out : def.out;
    if (finNum(rec.hit) == null) rec.hit = finNum(prev.hit) != null ? prev.hit : (finNum(def.hit) != null ? def.hit : 0);
    rec.source = rec.source || 'openrouter-floor';
    rec.syncedAt = now || Date.now();
    bag[model] = rec;
    return bag;
  }

  /**
   * rpcache 形态：{ model, supported, timestamp, prompt_tokens, cache_hit_tokens, cache_miss_tokens,
   *   completion_tokens, cache_mode, cache_write_tokens }
   * → { actual, noCache, saved } 或 null
   */
  function costOf(e, prices, mode, peak, calib) {
    if (!e || e.supported === false) return null;
    const p0 = calib ? priceForCalibrated(e.model, prices, calib) : priceFor(e.model, prices);
    if (!p0) return null;
    const p = p0;
    const f0 = factorFor(p, e.timestamp, mode, peak);
    const f = isFinite(f0) ? f0 : 1;
    // v0.28.5：价目字段缺失/非数字一律按 0，避免一条坏价目把合计变成 NaN
    const miss = fin0(p.miss), out = fin0(p.out);
    const hitP = e.cache_mode === 'explicit' && finNum(p.hit_explicit) != null ? fin0(p.hit_explicit) : fin0(p.hit);
    const writeP = finNum(p.write) != null ? fin0(p.write) : miss;
    const write = fin0(e.cache_write_tokens) * Math.max(0, writeP - miss);
    const actual = (fin0(e.cache_hit_tokens) * hitP + fin0(e.cache_miss_tokens) * miss + write + fin0(e.completion_tokens) * out) / 1e6 * f;
    const noCache = (fin0(e.prompt_tokens) * miss + fin0(e.completion_tokens) * out) / 1e6 * f;
    return { actual, noCache, saved: noCache - actual };
  }

  /**
   * usage-stats 形态：{ model, at, prompt, completion, hit, miss, cache, write?, cacheMode? }
   * → 美元数字或 null
   */
  function costOfEntry(e, prices, mode, peak, calib) {
    if (!e) return null;
    const mapped = {
      model: e.model,
      supported: true,
      timestamp: e.at,
      prompt_tokens: e.prompt | 0,
      cache_hit_tokens: e.cache ? (e.hit | 0) : 0,
      cache_miss_tokens: e.cache ? (e.miss | 0) : (e.prompt | 0),
      completion_tokens: e.completion | 0,
      cache_write_tokens: e.write | 0,
      cache_mode: e.cacheMode || 'implicit',
    };
    // 用量页：未知模型走 default；已知（含千问 builtin）走统一价目
    const p = priceForUsage(e.model, prices);
    if (!p) return null;
    const usePrices = prices || USAGE_DEFAULT_PRICES;
    // 若 priceFor 命中 builtin/用户表，用 costOf；若仅 default 兜底，直接按 default 算
    const via = priceFor(e.model, usePrices);
    if (via) {
      const r = costOf(mapped, usePrices, mode, peak, calib);
      return r && isFinite(r.actual) ? r.actual : null;
    }
    const f0 = factorFor(p, e.at, mode, peak);
    const f = isFinite(f0) ? f0 : 1;
    const inCost = e.cache
      ? (fin0(e.hit) * fin0(p.hit) + fin0(e.miss) * fin0(p.miss))
      : (fin0(e.prompt) * (finNum(p.miss) != null ? fin0(p.miss) : fin0(p.in)));
    const outCost = fin0(e.completion) * fin0(p.out);
    const v = (inCost + outCost) / 1e6 * f;
    return isFinite(v) ? v : null;
  }

  /** D2：用真实 usage.cost 对账。bias=(est-actual)/actual；|bias|>15% 连续 streak 轮标记失真；scale EWMA(α=0.3) */
  function emptyCalib() { return {}; }

  function reconcile(calib, model, estimated, actual, opts) {
    opts = opts || {};
    const alpha = opts.alpha != null ? opts.alpha : EWMA_ALPHA;
    const thr = opts.threshold != null ? opts.threshold : BIAS_ABS_THRESHOLD;
    const mark = opts.streakMark != null ? opts.streakMark : BIAS_STREAK_MARK;
    const bag = Object.assign({}, calib || {});
    if (!model || !(actual > 0) || !(estimated > 0) || !isFinite(actual) || !isFinite(estimated)) return bag;
    const bias = (estimated - actual) / actual;
    const ratio = actual / estimated; // 乘到价目上：p ← p · ratio
    const prev = bag[model] || { scale: 1, biasEwma: 0, streak: 0, distorted: false, n: 0 };
    const scale = (prev.scale || 1) * (1 - alpha) + ratio * alpha;
    const biasEwma = (prev.biasEwma || 0) * (1 - alpha) + bias * alpha;
    const streak = Math.abs(bias) > thr ? (prev.streak | 0) + 1 : 0;
    const distorted = streak >= mark || (prev.distorted && Math.abs(biasEwma) > thr);
    bag[model] = {
      scale, biasEwma, streak, distorted,
      n: (prev.n | 0) + 1,
      lastBias: bias,
      lastEst: estimated,
      lastActual: actual,
      updatedAt: opts.now || Date.now(),
    };
    return bag;
  }

  function calibView(calib, model) {
    const c = calib && model && calib[model];
    if (!c) return null;
    return {
      model,
      scale: c.scale,
      biasEwma: c.biasEwma,
      biasPct: Math.round((c.biasEwma || 0) * 1000) / 10,
      streak: c.streak | 0,
      distorted: !!c.distorted,
      n: c.n | 0,
      lastBias: c.lastBias,
      lastEst: c.lastEst,
      lastActual: c.lastActual,
    };
  }

  function distortedModels(calib) {
    return Object.keys(calib || {}).filter(m => calib[m] && calib[m].distorted).map(m => calibView(calib, m));
  }

  const api = {
    CNY_PER_USD, DEFAULT_PEAK, DEFAULT_PRICES, BUILTIN_PRICES, USAGE_DEFAULT_PRICES,
    EWMA_ALPHA, BIAS_ABS_THRESHOLD, BIAS_STREAK_MARK,
    priceForRules, priceFor, priceForUsage, priceForCalibrated, scalePrice, calibScale, mergeFloorPrice, finNum,
    parseWindows, isPeak, peakFactor, factorFor,
    costOf, costOfEntry,
    emptyCalib, reconcile, calibView, distortedModels,
  };
  root.CostCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
