/* 助手消息底部轻量状态条：命中率 / 节省 / Affect 档位。纯逻辑，可 Node require。 */
(function (root) {
  'use strict';
  function fmtUsdSmall(x) {
    if (x == null || x === '') return '';
    if (x === 0) return '$0';
    if (x < 0.0001) return '<$0.0001';
    return '$' + (x < 0.01 ? x.toFixed(4) : x < 1 ? x.toFixed(3) : x.toFixed(2));
  }
  /**
   * 组装状态条字段。
   * opt.cacheView：Providers.cacheView 的返回（rate / saved / savedEstimated）
   * opt.routeView：可选，routeView.hitRate（0–1）在 cacheView 无 rate 时兜底
   * opt.relation 或 opt.affect（需 Affect.relationOf）
   */
  function buildMsgStatus(opt) {
    opt = opt || {};
    const segs = [];
    const cv = opt.cacheView || null;
    let rate = cv && cv.rate != null ? cv.rate : null;
    if (rate == null && opt.routeView && opt.routeView.hitRate != null) {
      rate = Math.round(opt.routeView.hitRate * 1000) / 10;
    }
    if (rate != null) segs.push({ key: 'hit', text: '命中率 ' + rate + '%' });
    if (cv && cv.saved != null && cv.saved > 0) {
      segs.push({ key: 'saved', text: (cv.savedEstimated ? '约省 ' : '节省 ') + fmtUsdSmall(cv.saved) });
    }
    let rel = opt.relation || '';
    if (!rel && opt.affect) {
      const A = (typeof root !== 'undefined' && root.Affect) || (typeof globalThis !== 'undefined' && globalThis.Affect);
      if (A && typeof A.relationOf === 'function') rel = A.relationOf(opt.affect);
      else if (opt.affect.relation) rel = opt.affect.relation;
    }
    if (rel) segs.push({ key: 'affect', text: 'Affect ' + rel });
    return segs;
  }
  const api = { buildMsgStatus, fmtUsdSmall };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UiStatus = api;
})(typeof window !== 'undefined' ? window : globalThis);
