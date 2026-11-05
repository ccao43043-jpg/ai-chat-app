/**
 * cache-common.js — 缓存命中优化插件公共工具（Gemini gcache / MiniMax mmcache 共用的纯函数）。
 * Shared pure helpers for cache-hit optimisation plugins. No side effects, Node-testable.
 * 注意：gcache.js 为保持行为字节级等价，暂保留自身实现；新插件优先用这里。
 */
(function (root) {
  'use strict';
  /** FNV-1a 32 位哈希（十六进制），与 gcache.hash 算法一致 */
  function hash(str) {
    let h = 0x811c9dc5; const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  /** 由对话 id + 命名空间生成稳定 session_id（UUID 形状，≤256 字符）；同一对话恒定 */
  function sessionIdFor(convId, ns) {
    if (convId == null || convId === '') return '';
    const s = (ns ? ns + ':' : '') + String(convId);
    const h = [hash(s), hash('a' + s), hash('b' + s), hash('c' + s)].join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20, 32);
  }
  /** 粗略 Token 估算：CJK 1 字 ≈ 1 Token，其余 4 字符 ≈ 1 Token */
  function estTokens(s) { s = String(s || ''); const cjk = (s.match(/[\u3000-\u9fff\uff00-\uffef]/g) || []).length; return Math.ceil(cjk + (s.length - cjk) / 4); }
  const partsText = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => p && p.type === 'text' ? p.text : '[' + ((p && p.type) || '?') + ']').join('') : JSON.stringify(c == null ? '' : c);
  function lcpLen(a, b) { a = String(a || ''); b = String(b || ''); const n = Math.min(a.length, b.length); let i = 0; while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; }
  function lcpRatio(prev, cur) { cur = String(cur || ''); return cur.length ? lcpLen(prev, cur) / cur.length : 0; }
  function firstDiff(a, b) {
    const i = lcpLen(a, b);
    return { pos: i, before: String(a || '').slice(Math.max(0, i - 20), i + 40), after: String(b || '').slice(Math.max(0, i - 20), i + 40) };
  }
  /** 统一 usage（Providers.normalizeUsage 结果）→ { prompt, hit, write, pct, known } */
  function usageInfo(u) {
    if (!u || u.prompt == null) return null;
    const prompt = u.prompt | 0, hit = u.hit | 0, write = u.cacheWrite | 0;
    if (u.hit == null && !u.cacheSupported) return { prompt, hit: 0, write, pct: null, known: false };
    return { prompt, hit, write, pct: prompt ? Math.round(hit / prompt * 100) : 0 };
  }
  /** 滚动命中率（按 Token 加权），roll = [{prompt, hit, known}] */
  function rollingRate(roll) {
    const k = (roll || []).filter(r => r.known !== false && r.prompt > 0);
    if (!k.length) return null;
    const p = k.reduce((a, r) => a + r.prompt, 0), h = k.reduce((a, r) => a + r.hit, 0);
    return p ? Math.round(h / p * 100) : 0;
  }
  /** 成本估算（普通输入 Token 等价）；price = { read, write } 为相对输入价倍率 */
  function estimateCost(i, price) {
    if (!i || i.known === false) return null;
    const P = Object.assign({ read: 1, write: 1 }, price || {});
    const miss = Math.max(0, i.prompt - i.hit - i.write);
    const equiv = miss + i.hit * P.read + i.write * P.write;
    return { equiv: Math.round(equiv), saved: Math.round(i.prompt - equiv), pctSaved: i.prompt ? Math.round((i.prompt - equiv) / i.prompt * 100) : 0 };
  }
  /** 是否 OpenRouter 渠道（预设或域名），且为 OpenAI 兼容协议 */
  function isOpenRouterProvider(p) {
    p = p || {};
    if (p.type && p.type !== 'openai') return false;
    const forced = String(p.cacheAdapter || '').trim().toLowerCase();
    if (forced === 'none' || forced === 'openai-compat') return false;
    return forced === 'openrouter' || p.presetId === 'openrouter' || /openrouter\.ai/i.test(String(p.baseUrl || ''));
  }
  const api = { hash, sessionIdFor, estTokens, partsText, lcpLen, lcpRatio, firstDiff, usageInfo, rollingRate, estimateCost, isOpenRouterProvider };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CacheCommon = api;
})(typeof window !== 'undefined' ? window : globalThis);
