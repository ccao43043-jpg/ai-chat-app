// 请求核心粗测：600 条消息（约 600KB 中英混合），plan + fingerprints + diagnose(APPEND)，预热后稳态平均
const R = require('../../app/src/main/assets/www/rpcache.js');
function mk(n) {
  const items = []; const seg = '在那遥远的地方 there is a castle 123，骑士们正在集结。';
  for (let i = 0; i < n; i++) items.push({ id: 'm' + i, role: i % 2 ? 'assistant' : 'user', content: (seg.repeat(30) + i) });
  return items;
}
function core(st, items, prevFp) {
  const p = R.plan(st, '你是RP助手', items);
  const fp = R.fingerprints(p, '你是RP助手');
  const d = prevFp ? R.diagnose(prevFp, fp, p.hist) : null;
  return { p, fp, d };
}
function run(N = 600, iters = 30) {
  const st = R.normalizeState(null); st.settings.summary.enabled = false; st.settings.max_context = 10e6;
  const all = mk(N + 2);
  const prev = core(st, all.slice(0, N - 1)).fp;
  for (let i = 0; i < 5; i++) core(st, all.slice(0, N + 1), prev);
  const t0 = process.hrtime.bigint();
  let d; for (let i = 0; i < iters; i++) d = core(st, all.slice(0, N + 1), prev).d;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
  return { ms, diag: d && d.history, bytes: JSON.stringify(all).length };
}
module.exports = { run, mk, core };
if (require.main === module) console.log(run());
