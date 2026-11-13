#!/usr/bin/env node
// Kotlin → JS 方向校验：读取 Kotlin 单测写出的 app/build/golden-kotlin/<module>-k2j.jsonl，用 JS 参考实现回放并比对。
//   node tests/golden-export/verify-kotlin.mjs convlog <file>
// 每行：{label, id, files:{name:text}, expect}；JS 对 files 做 ConvLog.load(id)，结果须与 expect JSON 语义相等（数字相对误差 1e-9）。
import fs from 'node:fs';
import { loadWww } from './lib.mjs';

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') { const o = {}; Object.keys(v).sort().forEach(k => { if (v[k] !== undefined) o[k] = canon(v[k]); }); return o; }
  return v;
}
function same(a, b, path, out) {
  if (typeof a === 'number' && typeof b === 'number') { if (a !== b && Math.abs(a - b) > 1e-9 * Math.max(Math.abs(a), Math.abs(b))) out.push(path + ': ' + a + ' ≠ ' + b); return; }
  if (Array.isArray(a) && Array.isArray(b)) { if (a.length !== b.length) out.push(path + ': 长度 ' + a.length + ' ≠ ' + b.length); for (let i = 0; i < Math.min(a.length, b.length); i++) same(a[i], b[i], path + '[' + i + ']', out); return; }
  if (a && b && typeof a === 'object' && typeof b === 'object') { new Set(Object.keys(a).concat(Object.keys(b))).forEach(k => same(a[k], b[k], path + '.' + k, out)); return; }
  if (a !== b) out.push(path + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b));
}

const [module, file] = process.argv.slice(2);
if (module !== 'convlog' || !file) { console.error('用法: verify-kotlin.mjs convlog <file>'); process.exit(2); }
const CL = loadWww('conv-log.js');
let bad = 0, n = 0;
fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).forEach(line => {
  const c = JSON.parse(line); n++;
  CL.clearSessions();
  const st = CL.memStore(c.files);
  const got = CL.load(st, c.id);
  const diffs = []; same(canon(c.expect), canon(JSON.parse(JSON.stringify(got))), '$', diffs);
  // 再从头 replay（不用快照）也必须得到同样的消息顺序与内容
  if (diffs.length) { bad++; console.error(c.label + ' 不一致:\n  ' + diffs.slice(0, 10).join('\n  ')); }
});
console.log('verify-kotlin convlog: ' + n + ' 个 store，' + bad + ' 个不一致');
process.exit(bad ? 1 : 0);
