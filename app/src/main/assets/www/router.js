/* 路由 × 缓存亲和：按 (model, upstream) 维护命中率 Beta 后验，用有效成本选上游。
 * 有效价 p_eff = h·p_hit + (1−h)·p_miss；滞回 + 熔断；OpenRouter 用 provider.order。
 * 纯逻辑，可在 Node 单测里 require。 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    priorA: 6,
    priorB: 4,
    minObs: 5,
    defaultH: 0.5,
    dwell: 8,
    switchMargin: 0.97, // best 必须比 current 便宜到 score < cur*0.97 才考虑切
    zPessimistic: 1.28, // ~10% 悲观分位
    failBreak: 3,       // 连续失败熔断
    enabled: true,
    latencyWeight: 0.15, // 延迟维：相对 ref 的偏离按此权重乘进有效分
    latencyRefMs: 2000,
    latEwmaAlpha: 0.3,
    // v0.28.7：空闲粘滞。OpenRouter 官方 sticky 空闲 60 分钟过期、缓存只在那一家上游；
    // 空闲超过此值回来时，只要 current 仍可用且未熔断，就不因「略便宜 / 延迟略好 / 缓存大概已过期」切走，
    // 除非别家有效分便宜到 cur × idleSwitchMargin 以下（默认要便宜一半）。
    stickyIdleMs: 60 * 60 * 1000,
    idleSwitchMargin: 0.5,
  };

  function settingsOf(cfg) {
    const o = Object.assign({}, DEFAULTS, cfg || {});
    o.minObs = Math.max(0, o.minObs | 0);
    o.dwell = Math.max(1, o.dwell | 0);
    o.failBreak = Math.max(1, o.failBreak | 0);
    o.enabled = o.enabled !== false;
    return o;
  }

  /** 悲观命中率分位（Beta 均值 − z·σ） */
  function hitQuantile(a, b, z) {
    const A = Math.max(1e-9, a), B = Math.max(1e-9, b);
    const n = A + B;
    const mean = A / n;
    const var_ = (A * B) / (n * n * (n + 1));
    const h = mean - (z != null ? z : DEFAULTS.zPessimistic) * Math.sqrt(Math.max(0, var_));
    return Math.max(0, Math.min(0.95, h));
  }

  function effectivePrice(pMiss, pHit, h) {
    const pm = Number(pMiss), ph = Number(pHit);
    if (!isFinite(pm)) return Infinity;
    const hit = isFinite(ph) ? ph : pm; // 无缓存折扣时 hit=miss
    const hh = Math.max(0, Math.min(0.95, Number(h) || 0));
    return hh * hit + (1 - hh) * pm;
  }

  function scaleAmount(v, scale) {
    const sl = Number(scale);
    if (!(sl > 0) || sl === 1) return v;
    const n = Number(v);
    return isFinite(n) ? n * sl : v;
  }

  /** 把已有 EWMA 对账 scale 接到路由候选价上（用量页同一份 calib，不再另建对账）。 */
  function applyCalibScale(list, calib, model) {
    const c = calib && model && calib[model];
    const scale = c && c.scale > 0 ? c.scale : 1;
    return (Array.isArray(list) ? list : []).map(x => {
      if (!x) return x;
      const sl = (x.scale > 0 ? x.scale : scale);
      if (!(sl > 0) || sl === 1) return Object.assign({}, x, { calibScale: sl > 0 ? sl : 1 });
      return Object.assign({}, x, {
        pMiss: scaleAmount(x.pMiss, sl),
        pHit: x.pHit != null ? scaleAmount(x.pHit, sl) : x.pHit,
        calibScale: sl,
      });
    });
  }

  function latencyOf(priceItem, stats) {
    const fromPrice = priceItem && Number(priceItem.latencyMs);
    if (fromPrice > 0) return fromPrice;
    const ew = stats && Number(stats.latEwma);
    return ew > 0 ? ew : 0;
  }

  /** 有效分 = 校准后有效价 × 延迟因子。无延迟观测时退回 pe，旧单测行为不变。 */
  function effectiveScore(pe, latencyMs, opts) {
    if (!isFinite(pe)) return pe;
    const cfg = settingsOf(opts);
    const lat = Number(latencyMs);
    if (!(lat > 0) || !(cfg.latencyWeight > 0)) return pe;
    const ref = cfg.latencyRefMs > 0 ? cfg.latencyRefMs : DEFAULTS.latencyRefMs;
    const factor = 1 + cfg.latencyWeight * (lat / ref - 1);
    return pe * Math.max(0.7, Math.min(1.8, factor));
  }

  function emptyUpstream() {
    return { a: DEFAULTS.priorA, b: DEFAULTS.priorB, obs: 0, lastAt: 0, fails: 0, latEwma: 0, latN: 0 };
  }

  /** 确保 router 状态树：{ [model]: { current, lastSwitchAt, upstreams: { [slug]: stats } } } */
  function ensureModel(state, model) {
    const s = state || {};
    if (!s[model]) s[model] = { current: null, lastSwitchAt: 0, upstreams: {} };
    if (!s[model].upstreams) s[model].upstreams = {};
    return s[model];
  }

  function ensureUpstream(modelState, slug) {
    if (!modelState.upstreams[slug]) modelState.upstreams[slug] = emptyUpstream();
    return modelState.upstreams[slug];
  }

  /**
   * D3：每请求 1 份证据（勿把 token 数当样本数）。
   * hitTokens/promptTokens → h=hit/prompt，α += w·h，β += w·(1−h)；与 rpcache.hitPosterior 同构。
   * w 默认 1；opts.infoWeight 时按 prompt 规模有界加权（0.5..2）。
   * 也可传 { hit: bool } 简化（整轮命中/未命中）。
   */
  function evidenceWeight(promptTokens, opts) {
    opts = opts || {};
    if (!opts.infoWeight) return 1;
    const pt = Math.max(0, Number(promptTokens) || 0);
    const ref = opts.refTokens > 0 ? opts.refTokens : 8000;
    const w = Math.log2(1 + pt) / Math.log2(1 + ref);
    return Math.max(0.5, Math.min(2, w));
  }
  function observe(state, model, slug, obs, now, opts) {
    const ms = ensureModel(state, model);
    const u = ensureUpstream(ms, slug);
    const at = now || Date.now();
    if (obs && typeof obs.hitTokens === 'number' && typeof obs.promptTokens === 'number' && obs.promptTokens > 0) {
      const hit = Math.max(0, Math.min(obs.promptTokens, obs.hitTokens));
      const h = hit / obs.promptTokens;
      const w = evidenceWeight(obs.promptTokens, opts || (obs && obs.weightOpts) || null);
      u.a += w * h;
      u.b += w * (1 - h);
      u.obs += 1;
    } else if (obs && typeof obs.hit === 'boolean') {
      const w = evidenceWeight(1, opts || null);
      if (obs.hit) u.a += w; else u.b += w;
      u.obs += 1;
    }
    u.lastAt = at;
    if (obs && obs.ok === false) u.fails = (u.fails | 0) + 1;
    else if (obs && obs.ok !== false) u.fails = 0;
    if (obs && Number(obs.latencyMs) > 0) {
      const alpha = (opts && opts.latEwmaAlpha != null) ? opts.latEwmaAlpha : DEFAULTS.latEwmaAlpha;
      const lat = Number(obs.latencyMs);
      u.latEwma = (u.latN > 0 && u.latEwma > 0) ? (u.latEwma * (1 - alpha) + lat * alpha) : lat;
      u.latN = (u.latN | 0) + 1;
    }
    ms.current = slug;
    return state;
  }

  function markFail(state, model, slug, now) {
    return observe(state, model, slug, { ok: false }, now);
  }

  function switchCost(curPe, bestPe, prefixTokens, pMissCur, pHitCur) {
    // C_switch ≈ P · (p_miss − p_hit) / 1e6；缺价时用 pe 差的保守估计
    const P = Math.max(0, prefixTokens | 0);
    let delta;
    if (isFinite(pMissCur) && isFinite(pHitCur)) delta = Math.max(0, pMissCur - pHitCur);
    else delta = Math.max(0, (curPe || 0) - (bestPe || 0)) * 2; // 粗估
    return P * delta / 1e6;
  }

  /**
   * price: [{ slug, pMiss, pHit, ok? }]
   * stats: router[model] 或完整 state+model
   * current: 当前 slug
   * prefixTokens: 前缀长度
   * opts: settingsOf 覆盖
   */
  function chooseUpstream(price, stats, current, prefixTokens, opts) {
    const cfg = settingsOf(opts);
    if (!cfg.enabled) return current || (price && price[0] && price[0].slug) || null;
    const list = Array.isArray(price) ? price : [];
    const ups = (stats && stats.upstreams) || {};
    const scored = [];
    for (const x of list) {
      if (!x || !x.slug) continue;
      if (x.ok === false) continue;
      const st = ups[x.slug] || emptyUpstream();
      if ((st.fails | 0) >= cfg.failBreak) continue; // 熔断
      let h;
      if ((st.obs | 0) >= cfg.minObs) h = hitQuantile(st.a, st.b, cfg.zPessimistic);
      else h = cfg.defaultH; // 冷启动默认 h
      const pe = effectivePrice(x.pMiss, x.pHit != null ? x.pHit : x.pMiss, h);
      const lat = latencyOf(x, st);
      const score = effectiveScore(pe, lat, cfg);
      scored.push({
        slug: x.slug,
        pe,
        score,
        latencyMs: lat,
        h,
        obs: st.obs | 0,
        pMiss: Number(x.pMiss),
        pHit: x.pHit != null ? Number(x.pHit) : Number(x.pMiss),
        cold: (st.obs | 0) < cfg.minObs,
        calibScale: x.calibScale,
      });
    }
    if (!scored.length) return current || null;
    // 参与比价：至少 minObs；若全员冷启动则维持现状（或返回第一个）
    const ripe = scored.filter(x => !x.cold);
    if (!ripe.length) return current || scored[0].slug;
    ripe.sort((a, b) => a.score - b.score || a.pe - b.pe || a.slug.localeCompare(b.slug));
    const best = ripe[0];
    if (!current) return best.slug;
    const cur = ripe.find(x => x.slug === current) || scored.find(x => x.slug === current);
    if (!cur) return best.slug;
    if (best.slug === current) return current;
    // v0.28.7：长时间空闲后优先回到上次成功的上游（缓存只在那一家），只有大幅更便宜才切
    const curSt = ups[current];
    const now = cfg.now != null ? Number(cfg.now) : Date.now();
    const idleMs = cfg.idleMs != null ? Number(cfg.idleMs) : (curSt && curSt.lastAt > 0 ? Math.max(0, now - curSt.lastAt) : 0);
    if (cfg.stickyIdleMs > 0 && idleMs >= cfg.stickyIdleMs && !(curSt && (curSt.fails | 0) > 0)) {
      const m = cfg.idleSwitchMargin > 0 ? cfg.idleSwitchMargin : DEFAULTS.idleSwitchMargin;
      return best.score < cur.score * m ? best.slug : current;
    }
    // 滞回：更优（有效分含延迟）且省下的钱 × 驻留轮数 > 切换成本
    if (!(best.score < cur.score * cfg.switchMargin)) return current;
    const savedPerTurn = Math.max(0, prefixTokens | 0) * (cur.pe - best.pe) / 1e6;
    const cost = switchCost(cur.pe, best.pe, prefixTokens, cur.pMiss, cur.pHit);
    if (savedPerTurn * cfg.dwell > cost) return best.slug;
    // 表价几乎持平（差 ≤ 1-switchMargin）时，延迟维有效分优势允许切换
    const peClose = Math.abs(cur.pe - best.pe) <= Math.max(1e-9, cur.pe * (1 - cfg.switchMargin));
    if (peClose) return best.slug;
    return current;
  }

  /** 构造 OpenRouter provider 字段 */
  function buildProviderField(chosenSlug, opts) {
    const cfg = settingsOf(opts);
    if (!cfg.enabled || !chosenSlug) {
      // 回退：旧行为 sort:price
      return { sort: 'price' };
    }
    return {
      order: [chosenSlug],
      allow_fallbacks: true,
      require_parameters: true,
    };
  }

  /** 面板摘要 */
  function panelView(modelState, priceMap) {
    const ms = modelState || {};
    const slug = ms.current || null;
    const st = slug && ms.upstreams ? ms.upstreams[slug] : null;
    let pe = null, h = null;
    if (slug && priceMap && priceMap[slug]) {
      const p = priceMap[slug];
      h = st && (st.obs | 0) >= DEFAULTS.minObs ? hitQuantile(st.a, st.b) : DEFAULTS.defaultH;
      pe = effectivePrice(p.pMiss, p.pHit != null ? p.pHit : p.pMiss, h);
    } else if (st) {
      h = (st.obs | 0) >= DEFAULTS.minObs ? hitQuantile(st.a, st.b) : DEFAULTS.defaultH;
    }
    const lat = st && st.latEwma > 0 ? st.latEwma : (priceMap && slug && priceMap[slug] && priceMap[slug].latencyMs) || 0;
    const score = pe != null ? effectiveScore(pe, lat, null) : null;
    return {
      upstream: slug,
      effectivePrice: pe,
      effectiveScore: score,
      latencyMs: lat || null,
      hitRate: h,
      lastSwitchAt: ms.lastSwitchAt || 0,
      obs: st ? (st.obs | 0) : 0,
      calibScale: priceMap && slug && priceMap[slug] && priceMap[slug].calibScale,
    };
  }

  function recordSwitch(state, model, from, to, now) {
    const ms = ensureModel(state, model);
    if (from !== to) ms.lastSwitchAt = now || Date.now();
    ms.current = to;
    return state;
  }

  /** 回放序列：每步 { prices, hitTokens?, promptTokens?, hit?, ok? } → 选 slug，累计有效成本与切换次数 */
  function replay(steps, opts) {
    const cfg = settingsOf(opts);
    const state = {};
    const model = (opts && opts.model) || 'm';
    let current = null;
    let switches = 0;
    let effCost = 0;
    const prefixTokens = (opts && opts.prefixTokens) || 20000;
    const trail = [];
    for (const step of steps || []) {
      const chosen = chooseUpstream(step.prices, ensureModel(state, model), current, step.prefixTokens != null ? step.prefixTokens : prefixTokens, cfg);
      if (current && chosen && chosen !== current) {
        switches++;
        recordSwitch(state, model, current, chosen, step.at);
      } else if (!current && chosen) {
        recordSwitch(state, model, null, chosen, step.at);
      }
      current = chosen;
      const p = (step.prices || []).find(x => x.slug === chosen) || (step.prices || [])[0];
      if (p) {
        const st = ensureUpstream(ensureModel(state, model), chosen);
        const h = (st.obs | 0) >= cfg.minObs ? hitQuantile(st.a, st.b) : cfg.defaultH;
        const pe = effectivePrice(p.pMiss, p.pHit != null ? p.pHit : p.pMiss, h);
        const tok = step.promptTokens != null ? step.promptTokens : prefixTokens;
        effCost += tok * pe / 1e6;
      }
      if (chosen) {
        observe(state, model, chosen, {
          hitTokens: step.hitTokens,
          promptTokens: step.promptTokens != null ? step.promptTokens : prefixTokens,
          hit: step.hit,
          ok: step.ok,
        }, step.at);
      }
      trail.push(chosen);
    }
    return { trail, switches, effCost, state, current };
  }

  const api = {
    DEFAULTS, settingsOf, hitQuantile, effectivePrice, effectiveScore, applyCalibScale, scaleAmount, latencyOf,
    emptyUpstream, ensureModel, ensureUpstream,
    observe, evidenceWeight, markFail, switchCost, chooseUpstream, buildProviderField, panelView, recordSwitch, replay,
  };
  root.Router = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
