/* 统一检索内核：grams / buildIndex / bm25f / mmr / pickByBudget。
 * rpmemory 与 knowledge 复用；纯逻辑，可 Node require。 */
(function (root) {
  'use strict';

  /** term 切分：中文 bigram（单字段落保留单字），英文/数字 \w+ */
  function grams(text, n) {
    const out = [], str = String(text || '').toLowerCase();
    const N = n == null ? 2 : n;
    (str.match(/[a-z0-9_]+/g) || []).forEach(w => out.push(w));
    (str.match(/[\u4e00-\u9fff]+/g) || []).forEach(seg => {
      if (seg.length === 1) out.push(seg);
      else if (N <= 1) { for (let i = 0; i < seg.length; i++) out.push(seg[i]); }
      else for (let i = 0; i < seg.length - (N - 1); i++) out.push(seg.slice(i, i + N));
    });
    return out;
  }
  const terms = grams; // 别名

  function buildIndex(docs, fields, prev) {
    const fs = fields && fields.length ? fields : ['text'];
    const sig = (docs || []).map(d => d.id + ':' + (d.updatedAt || 0)).join('|') + '#' + fs.join(',');
    if (prev && prev.sig === sig) return prev;
    const idx = { df: {}, postings: {}, len: {}, avgLen: {}, tf: {}, N: (docs || []).length, sig, fields: fs };
    const sum = {}; fs.forEach(f => { sum[f] = 0; });
    (docs || []).forEach(d => {
      const tf = {}, seen = new Set(); idx.len[d.id] = {};
      fs.forEach(f => {
        const raw = d[f];
        const arr = Array.isArray(raw) ? grams(raw.join(' ')) : grams(raw);
        idx.len[d.id][f] = arr.length; sum[f] += arr.length; tf[f] = {};
        arr.forEach(t => { tf[f][t] = (tf[f][t] || 0) + 1; seen.add(t); });
      });
      idx.tf[d.id] = tf;
      seen.forEach(t => { idx.df[t] = (idx.df[t] || 0) + 1; (idx.postings[t] = idx.postings[t] || []).push(d.id); });
    });
    fs.forEach(f => { idx.avgLen[f] = docs && docs.length ? sum[f] / docs.length || 1 : 1; });
    return idx;
  }

  const idf = (idx, t) => {
    const df = idx.df[t] || 0;
    return Math.log(1 + (idx.N - df + 0.5) / (df + 0.5));
  };

  /** 带权查询：string → Map，或直接 Map */
  function buildQuery(query, weight) {
    const Q = query instanceof Map ? query : new Map();
    if (!(query instanceof Map)) {
      const w = weight == null ? 1 : weight;
      grams(query).forEach(t => Q.set(t, (Q.get(t) || 0) + w));
    }
    return Q;
  }

  function addQuery(Q, text, weight) {
    const w = weight == null ? 1 : weight;
    grams(text).forEach(t => Q.set(t, (Q.get(t) || 0) + w));
    return Q;
  }

  /**
   * BM25F：weights = { field: w }；k1/b 可配。
   */
  function bm25f(idx, queryTerms, doc, weights, k1, b) {
    const K1 = k1 == null ? 1.2 : k1;
    const B = b == null ? 0.75 : b;
    const W = weights || {};
    const fs = idx.fields || Object.keys(W);
    const tf = idx.tf[doc.id]; if (!tf) return 0;
    const Q = queryTerms instanceof Map ? queryTerms : buildQuery(queryTerms);
    let s = 0;
    Q.forEach((qw, t) => {
      if (!idx.df[t]) return;
      const i = idf(idx, t);
      fs.forEach(f => {
        const wf = W[f] != null ? W[f] : 1;
        if (!wf) return;
        const n = tf[f] && tf[f][t]; if (!n) return;
        const L = idx.len[doc.id][f] / (idx.avgLen[f] || 1);
        s += qw * wf * i * (n * (K1 + 1)) / (n + K1 * (1 - B + B * L));
      });
    });
    return s;
  }

  /** 3-gram Jaccard（中文按字符；英文按词近似用字符） */
  function charGrams3(s) {
    const t = String(s || '').toLowerCase().replace(/\s+/g, '');
    const g = new Set();
    for (let i = 0; i < t.length - 2; i++) g.add(t.slice(i, i + 3));
    return g;
  }
  function jaccard3(a, b) {
    const A = charGrams3(a), B = charGrams3(b);
    if (!A.size && !B.size) return 1;
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach(x => { if (B.has(x)) inter++; });
    return inter / (A.size + B.size - inter);
  }

  /**
   * MMR：cands = [{ id, score, text, ... }]；sim(a,b) 默认 jaccard3(text)
   * 返回按加入顺序的子集（最多 maxN）。
   */
  function mmr(cands, lambda, sim, maxN) {
    const lam = lambda == null ? 0.7 : lambda;
    const simFn = sim || ((a, b) => jaccard3(a.text || '', b.text || ''));
    const limit = maxN == null ? (cands || []).length : maxN;
    const left = (cands || []).slice();
    const S = [];
    while (left.length && S.length < limit) {
      let best = null, bv = -Infinity;
      left.forEach(x => {
        const red = S.length ? Math.max(...S.map(y => simFn(x, y))) : 0;
        const v = lam * (x.score || 0) - (1 - lam) * red;
        if (v > bv) { bv = v; best = x; }
      });
      if (!best) break;
      left.splice(left.indexOf(best), 1);
      S.push(best);
    }
    return S;
  }

  /**
   * 按 token 预算挑选；tokenOf(c) 返回消耗；超预算跳过继续找更短的。
   */
  function pickByBudget(cands, tokenOf, budget) {
    let left = Math.max(0, budget | 0);
    const out = [];
    const tokFn = tokenOf || (c => Math.ceil(String(c.text || c.content || '').length * 0.7) + 6);
    for (const c of cands || []) {
      const t = tokFn(c);
      if (t > left) continue;
      left -= t;
      out.push(Object.assign({}, c, { tokens: t }));
    }
    return out;
  }

  const api = {
    grams, terms, buildIndex, buildQuery, addQuery, bm25f, idf,
    charGrams3, jaccard3, mmr, pickByBudget,
  };
  root.RetrievalCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
