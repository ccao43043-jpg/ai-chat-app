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
    const f = factorFor(p, e.timestamp, mode, peak);
    const hitP = e.cache_mode === 'explicit' && p.hit_explicit != null ? p.hit_explicit : p.hit;
    const write = (e.cache_write_tokens || 0) * Math.max(0, (p.write != null ? p.write : p.miss) - p.miss);
    const actual = ((e.cache_hit_tokens || 0) * hitP + (e.cache_miss_tokens || 0) * p.miss + write + (e.completion_tokens || 0) * p.out) / 1e6 * f;
    const noCache = ((e.prompt_tokens || 0) * p.miss + (e.completion_tokens || 0) * p.out) / 1e6 * f;
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
      return r ? r.actual : null;
    }
    const f = factorFor(p, e.at, mode, peak);
    const inCost = e.cache
      ? (e.hit * (p.hit || 0) + e.miss * (p.miss || 0))
      : (e.prompt * (p.miss != null ? p.miss : (p.in || 0)));
    const outCost = e.completion * (p.out || 0);
    return (inCost + outCost) / 1e6 * f;
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
    priceForRules, priceFor, priceForUsage, priceForCalibrated, scalePrice,
    parseWindows, isPeak, peakFactor, factorFor,
    costOf, costOfEntry,
    emptyCalib, reconcile, calibView, distortedModels,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CostCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
