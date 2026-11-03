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
  const api = { computeRange, windowCovers, safeH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VScroll = api;
})(typeof window !== 'undefined' ? window : globalThis);
