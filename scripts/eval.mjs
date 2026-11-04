#!/usr/bin/env node
// 用法：node scripts/eval.mjs [--write-baseline] [--verbose]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const core = require('./lib/eval-core.js');
const args = process.argv.slice(2);
const res = core.runAll();
const out = args.includes('--verbose') ? res : core.strip(res);
if (args.includes('--write-baseline')) {
  const s = core.strip(res);
  const base = { version: 1, gitBase: '537e856', memory: s.memory, summary: s.summary, cost: s.cost, render: s.render,
    gate: '记忆 pAt5/mrr/ndcgAt5、summary.factCoverage 不得低于本值；summary.hallucinationRate、cost.totalPromptTokens 不得高于本值（EPS=1e-9）' };
  fs.writeFileSync(new URL('../tests/golden/baseline.json', import.meta.url), JSON.stringify(base, null, 2) + '\n');
  console.error('baseline 已写入 tests/golden/baseline.json');
}
const fails = core.compare(res, core.loadBaseline());
console.log(JSON.stringify({ ...out, gate: { pass: fails.length === 0, failures: fails } }, null, 2));
process.exit(fails.length ? 1 : 0);
