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
    switchMargin: 0.97, // best 必须比 current 便宜到 pe < cur*0.97 才考虑切
    zPessimistic: 1.28, // ~10% 悲观分位
    failBreak: 3,       // 连续失败熔断
    enabled: true,
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

  function emptyUpstream() {
    return { a: DEFAULTS.priorA, b: DEFAULTS.priorB, obs: 0, lastAt: 0, fails: 0 };
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
      scored.push({
        slug: x.slug,
        pe,
        h,
        obs: st.obs | 0,
        pMiss: Number(x.pMiss),
        pHit: x.pHit != null ? Number(x.pHit) : Number(x.pMiss),
        cold: (st.obs | 0) < cfg.minObs,
      });
    }
    if (!scored.length) return current || null;
    // 参与比价：至少 minObs；若全员冷启动则维持现状（或返回第一个）
    const ripe = scored.filter(x => !x.cold);
    if (!ripe.length) return current || scored[0].slug;
    ripe.sort((a, b) => a.pe - b.pe || a.slug.localeCompare(b.slug));
    const best = ripe[0];
    if (!current) return best.slug;
    const cur = ripe.find(x => x.slug === current) || scored.find(x => x.slug === current);
    if (!cur) return best.slug;
    if (best.slug === current) return current;
    // 滞回：更便宜且省下的钱 × 驻留轮数 > 切换成本
    if (!(best.pe < cur.pe * cfg.switchMargin)) return current;
    const savedPerTurn = Math.max(0, prefixTokens | 0) * (cur.pe - best.pe) / 1e6;
    const cost = switchCost(cur.pe, best.pe, prefixTokens, cur.pMiss, cur.pHit);
    if (savedPerTurn * cfg.dwell > cost) return best.slug;
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
    return {
      upstream: slug,
      effectivePrice: pe,
      hitRate: h,
      lastSwitchAt: ms.lastSwitchAt || 0,
      obs: st ? (st.obs | 0) : 0,
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
    DEFAULTS, settingsOf, hitQuantile, effectivePrice, emptyUpstream, ensureModel, ensureUpstream,
    observe, evidenceWeight, markFail, switchCost, chooseUpstream, buildProviderField, panelView, recordSwitch, replay,
  };
  root.Router = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
