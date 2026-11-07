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
  const base = { version: 2, gitBase: 'c9d8873', memory: s.memory, summary: s.summary, cost: s.cost, render: s.render, routing: s.routing, knowledge: s.knowledge, affect: s.affect,
    gate: '记忆/知识 pAt5/mrr/ndcgAt5、summary.factCoverage、routing.passRate、affect.directionAgree 不得低于本值；summary.hallucinationRate、cost.totalPromptTokens、routing.avgSwitches/totalEffCost、affect.oscillationRate 不得高于本值；affect 为合成基线待人工 MAE' };
  fs.writeFileSync(new URL('../tests/golden/baseline.json', import.meta.url), JSON.stringify(base, null, 2) + '\n');
  console.error('baseline 已写入 tests/golden/baseline.json');
}
const fails = core.compare(res, core.loadBaseline());
console.log(JSON.stringify({ ...out, gate: { pass: fails.length === 0, failures: fails } }, null, 2));
process.exit(fails.length ? 1 : 0);
