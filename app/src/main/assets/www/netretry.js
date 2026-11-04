/* v0.15.0 A6：网络失败分类 + 指数退避重试（纯函数，可在 Node 中测试）。
 * 只在「还没收到任何正文」时重试，避免流式输出重复；用户停止 / 4xx（除 408/409/425/429）不重试。 */
(function (root) {
  'use strict';
  const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524, 529]);
  /** 分类：{ kind, retry, label } */
  function classify(status, raw, err) {
    status = Number(status) || 0;
    const t = String(raw || '') + ' ' + String((err && err.message) || err || '');
    if (status === 0) {
      if (/timeout|timed out|超时/i.test(t)) return { kind: 'timeout', retry: true, label: '请求超时' };
      if (/abort|cancel/i.test(t)) return { kind: 'aborted', retry: false, label: '已取消' };
      return { kind: 'network', retry: true, label: '网络连接失败' };
    }
    if (status === 429) return { kind: 'rate_limit', retry: true, label: '请求过于频繁（429）' };
    if (status === 401 || status === 403) return { kind: 'auth', retry: false, label: '鉴权失败（' + status + '）' };
    if (/context.{0,20}(length|window)|maximum context|too many tokens|insufficient.{0,10}(quota|balance)|余额不足/i.test(t)) return { kind: 'fatal', retry: false, label: '不可重试错误（' + status + '）' };
    if (RETRY_STATUS.has(status)) return { kind: status >= 500 ? 'server' : 'transient', retry: true, label: '服务端暂时不可用（' + status + '）' };
    if (status >= 400) return { kind: 'client', retry: false, label: '请求错误（' + status + '）' };
    return { kind: 'ok', retry: false, label: '' };
  }
  /** 退避：base × 2^attempt，429 起步更长；±20% 抖动；上限 cap */
  function backoff(attempt, kind, rnd) {
    const base = kind === 'rate_limit' ? 2000 : 800, cap = 15000;
    const r = typeof rnd === 'number' ? rnd : Math.random();
    return Math.round(Math.min(cap, base * Math.pow(2, Math.max(0, attempt | 0))) * (0.8 + 0.4 * r));
  }
  const MAX_RETRIES = 2;
  /** 是否重试：分类允许 + 未超次数 + 未收到正文 + 未被停止 */
  function shouldRetry(c, attempt, gotDelta, stopped) {
    return !!(c && c.retry && !gotDelta && !stopped && attempt < MAX_RETRIES);
  }
  const api = { classify, backoff, shouldRetry, MAX_RETRIES, RETRY_STATUS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NetRetry = api;
})(typeof window !== 'undefined' ? window : globalThis);
