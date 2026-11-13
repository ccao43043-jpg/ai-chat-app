// golden 导出公共工具（D 所有）。确定性：固定 Date.now / Math.random，输出 JSONL，每行 {"in":[…],"out":…}
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const WWW = path.join(ROOT, 'app/src/main/assets/www');
export const OUT = path.join(ROOT, 'app/src/test/resources/golden');
export const FIXED_NOW = 1700000000000;
const require = createRequire(import.meta.url);

/** 每次调用都重新加载模块（清 require 缓存），避免模块级状态（会话缓存等）跨用例泄漏 */
export function loadWww(rel) {
  const p = path.join(WWW, rel);
  delete require.cache[require.resolve(p)];
  return require(p);
}

/** mulberry32：可复现的伪随机 */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: arr => arr[Math.floor(next() * arr.length)],
    chance: p => next() < p,
  };
}

/** 在固定时钟 / 随机数下执行 fn（golden 期间全局替换，结束恢复） */
export function deterministic(seed, fn) {
  const realNow = Date.now, realRandom = Math.random;
  const r = rng(seed);
  Date.now = () => FIXED_NOW;
  Math.random = r.next;
  try { return fn(); } finally { Date.now = realNow; Math.random = realRandom; }
}

/** 收集一个模块的所有用例：cases.add(fn, inArgs, out) → golden/<module>/<fn>.jsonl */
export class Golden {
  constructor(module) { this.module = module; this.files = new Map(); }
  add(fn, input, out) {
    const line = JSON.stringify({ in: input, out: out === undefined ? null : out });
    if (!this.files.has(fn)) this.files.set(fn, []);
    this.files.get(fn).push(line);
  }
  /** 写盘或比对；返回不一致的文件列表 */
  flush(check) {
    const dir = path.join(OUT, this.module);
    const bad = [];
    if (!check) fs.mkdirSync(dir, { recursive: true });
    for (const [fn, lines] of this.files) {
      const file = path.join(dir, fn + '.jsonl');
      const body = lines.join('\n') + '\n';
      if (check) {
        const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (cur !== body) bad.push(path.relative(ROOT, file));
      } else fs.writeFileSync(file, body);
    }
    return bad;
  }
  /** 额外产物（非 golden 向量，如 builtins.json）：[absPath, content] */
  flushExtra(check) {
    const bad = [];
    for (const [file, body] of (this.extraFiles || [])) {
      if (check) { if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) bad.push(path.relative(ROOT, file)); }
      else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
    }
    return bad;
  }
  count() { let n = 0; for (const l of this.files.values()) n += l.length; return n; }
}
