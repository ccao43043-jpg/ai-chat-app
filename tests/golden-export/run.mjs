#!/usr/bin/env node
// 生成 / 校验全部 golden 向量。
//   node tests/golden-export/run.mjs            重新生成 app/src/test/resources/golden/**
//   node tests/golden-export/run.mjs --check    只比对，不一致时退出码 1（CI 用：JS 参考实现被改动却没重新导出时报错）
//   node tests/golden-export/run.mjs convlog    只跑指定模块
// 新模块：在 exporters/ 下加 <module>.mjs，导出 default function (g: Golden) 并在 MODULES 里登记（B/C 补自己的模块）。
import { Golden, deterministic } from './lib.mjs';

const MODULES = {
  convlog: () => import('./exporters/convlog.mjs'),
  secure: () => import('./exporters/secure.mjs'),
  library: () => import('./exporters/library.mjs'),
  'c-cache': () => import('./exporters/c-cache.mjs'),     // C：js 语义 / cache-common / gcache / mmcache / pipeline
  'c-domain': () => import('./exporters/c-domain.mjs'),   // C：retrieval / knowledge / affect / charcard / worlds / autochar
};

const args = process.argv.slice(2);
const check = args.includes('--check');
const only = args.filter(a => !a.startsWith('--'));
const names = only.length ? only : Object.keys(MODULES);
let bad = [];
for (const name of names) {
  if (!MODULES[name]) { console.error('未知模块: ' + name); process.exit(2); }
  const mod = await MODULES[name]();
  const g = new Golden(name);
  deterministic(0x5eed, () => mod.default(g));
  const b = g.flush(check).concat(g.flushExtra(check));
  bad = bad.concat(b);
  console.log(`${check ? 'check' : 'write'} ${name}: ${g.count()} 条${b.length ? '（不一致: ' + b.join(', ') + '）' : ''}`);
}
if (check && bad.length) { console.error('golden 与 JS 参考实现不一致，请运行 node tests/golden-export/run.mjs 重新导出并检查差异'); process.exit(1); }
