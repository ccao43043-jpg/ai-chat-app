/* 本地日期 / 时间（纯函数，可在 Node 中测试）
 * v0.21.3：搜索「今天」、模板宏、Hybrid 摘要 at、每轮「现在是…」统一走这里；禁止用 toISOString().slice(0,10)（那是 UTC 日期）。
 * timeZone 省略 = 运行环境本地时区（手机一般即 Asia/Shanghai）；传入 IANA 名（如 'Asia/Shanghai'）则按该时区计算。 */
(function (root) {
  'use strict';
  const p2 = x => String(x).padStart(2, '0');
  function parts(now, timeZone) {
    const d = now == null ? new Date() : (now instanceof Date ? now : new Date(now));
    if (timeZone) {
      try {
        const o = {};
        new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).forEach(x => { o[x.type] = x.value; });
        return { y: o.year, m: o.month, d: o.day, H: o.hour === '24' ? '00' : o.hour, M: o.minute };
      } catch (e) { /* 不支持的时区 → 回退本地 */ }
    }
    return { y: String(d.getFullYear()), m: p2(d.getMonth() + 1), d: p2(d.getDate()), H: p2(d.getHours()), M: p2(d.getMinutes()) };
  }
  /** YYYY-MM-DD（本地或指定时区） */
  function localDateStr(now, timeZone) { const x = parts(now, timeZone); return x.y + '-' + x.m + '-' + x.d; }
  /** HH:mm（本地或指定时区） */
  function localTimeStr(now, timeZone) { const x = parts(now, timeZone); return x.H + ':' + x.M; }
  /** 时区显示名：Asia/Shanghai → 北京时间；其他返回 IANA 名或 UTC±hh:mm */
  function zoneLabel(now, timeZone) {
    let z = timeZone;
    if (!z) { try { z = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { z = ''; } }
    if (/^(Asia\/(Shanghai|Chongqing|Harbin|Urumqi)|PRC)$/.test(z || '')) return '北京时间';
    if (z) return z;
    const d = now == null ? new Date() : new Date(now), off = -d.getTimezoneOffset(), s = off >= 0 ? '+' : '-', a = Math.abs(off);
    return 'UTC' + s + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
  }
  /** 每轮动态段：「[现在] 现在是 2026-11-05 00:06（北京时间）」——只进本轮 user 消息，不进固定前缀 */
  function nowLine(now, timeZone) {
    return '[现在] 现在是 ' + localDateStr(now, timeZone) + ' ' + localTimeStr(now, timeZone) + '（' + zoneLabel(now, timeZone) + '，现实时间，仅供参考）';
  }
  /** 固定 system 里的稳定文案标记：出现它的对话每轮注入 nowLine */
  const NOW_MARKER = '本轮动态信息';
  const api = { localDateStr, localTimeStr, zoneLabel, nowLine, NOW_MARKER };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TimeUtil = api;
})(typeof window !== 'undefined' ? window : globalThis);
