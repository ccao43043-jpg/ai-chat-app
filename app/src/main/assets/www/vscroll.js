/* 虚拟滚动纯函数（v0.13.1）。无 DOM 依赖，便于单测。 */
(function (root) {
  function safeH(h, fallback) { h = Number(h); return (isFinite(h) && h > 0) ? h : (fallback || 1); }
  // heights: 每条消息高度（实测或估算）；返回渲染窗口与上下 spacer 高度
  function computeRange(heights, scrollTop, viewH, overscan) {
    const n = heights.length;
    if (!n) return { start: 0, end: 0, topH: 0, bottomH: 0 };
    viewH = safeH(viewH, 600); overscan = Math.max(0, Number(overscan) || 0);
    scrollTop = Number(scrollTop); if (!isFinite(scrollTop) || scrollTop < 0) scrollTop = 0;
    const from = Math.max(0, scrollTop - viewH * overscan);
    const budget = viewH * (1 + 2 * overscan) + 80;
    let start = n - 1, topH = 0, acc = 0;
    for (let i = 0; i < n; i++) { const h = safeH(heights[i]); if (acc + h > from) { start = i; break; } acc += h; }
    for (let i = 0; i < start; i++) topH += safeH(heights[i]);
    let end = start; acc = 0;
    while (end < n) { acc += safeH(heights[end]); end++; if (acc >= budget) break; }
    end = Math.min(n, Math.max(end, start + 1));
    let bottomH = 0; for (let i = end; i < n; i++) bottomH += safeH(heights[i]);
    return { start, end, topH, bottomH };
  }
  // 当前已渲染窗口是否仍覆盖「视口 + 半屏余量」；覆盖则不必重建（滞回，避免滚动中反复重建）
  function windowCovers(last, heights, scrollTop, viewH) {
    if (!last || last.empty || !(last.end > last.start) || last.end > heights.length) return false;
    viewH = safeH(viewH, 600);
    let top = 0; for (let i = 0; i < last.start; i++) top += safeH(heights[i]);
    let bot = top; for (let i = last.start; i < last.end; i++) bot += safeH(heights[i]);
    const atStart = last.start === 0, atEnd = last.end === heights.length;
    return (atStart || scrollTop - viewH * 0.5 >= top) && (atEnd || scrollTop + viewH * 1.5 <= bot);
  }
  // v0.15.0 P0-1：内容签名——内容 / 推理 / 图片 / 版本 / 错误 / 状态任一变化即令实测高度缓存失效
  function hashStr(t) { t = String(t || ''); let h = 2166136261; const step = t.length > 4096 ? Math.ceil(t.length / 4096) : 1; for (let i = 0; i < t.length; i += step) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
  function contentSig(m) {
    if (!m) return '';
    const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return [c.length, hashStr(c), (m.reasoning || '').length, (m.images || []).length, (m.files || []).length, m.vi | 0, m.versions ? m.versions.length : 0,
      m.error ? 1 : 0, m.pending ? 1 : 0, m.searching ? 1 : 0, (m.sources || []).length, m.edited ? 1 : 0, m.genStatus ? 1 : 0].join(':');
  }
  // P0-1：分段估计高度（未实测时）：段落 / 行折行 / 代码块 / 列表 / 图片分别计
  function estimateHeight(m, width) {
    if (!m) return 140;
    const cpl = Math.max(14, Math.floor((Number(width) > 0 ? width : 360) / 15)); // 每行约多少字
    const text = typeof m.content === 'string' ? m.content : '';
    let h = 64; // 头像 / 操作栏 / 边距
    let inCode = false;
    text.split('\n').forEach(line => {
      if (/^\s*```/.test(line)) { inCode = !inCode; h += inCode ? 28 : 12; return; }
      if (inCode) { h += 19; return; }
      if (!line.trim()) { h += 10; return; }
      const lh = /^#{1,3}\s/.test(line) ? 30 : 24;
      h += Math.max(1, Math.ceil(line.length / cpl)) * lh;
    });
    if (m.reasoning) h += 44;
    if (m.images && m.images.length) h += Math.ceil(m.images.length / 2) * 200;
    if (m.files && m.files.length) h += m.files.length * 48;
    if (m.sources && m.sources.length) h += 40;
    if (m.error) h += 60;
    return Math.min(4000, Math.max(72, Math.round(h)));
  }
  // P0-1：高度缓存（签名失效）
  function createHeightCache() {
    const map = new Map();
    return {
      get(m) { const e = m && m.id && map.get(m.id); return e && e.sig === contentSig(m) ? e.h : null; },
      set(m, h) { if (m && m.id && h > 0) map.set(m.id, { h, sig: contentSig(m) }); },
      drop(id) { map.delete(id); }, clear() { map.clear(); }, size() { return map.size; },
    };
  }
  // P0-1：上方插入 / 重测补偿——高度变化发生在视口上方时，scrollTop 应同步平移 delta
  function scrollCompensation(elTop, viewTop, oldH, newH) {
    const d = Number(newH) - Number(oldH);
    if (!isFinite(d) || !d) return 0;
    return Number(elTop) < Number(viewTop) ? d : 0;
  }
  const api = { computeRange, windowCovers, safeH, contentSig, estimateHeight, createHeightCache, scrollCompensation, hashStr };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VScroll = api;
})(typeof window !== 'undefined' ? window : globalThis);
