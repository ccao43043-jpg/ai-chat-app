// 工作流 C：把 exporters/c/m2-cache.mjs 挂到 run.mjs（独立子进程运行：它自己固定时间 / 随机数，并写多个 golden/<module>/ 目录）。
// 单独运行：node tests/golden-export/exporters/c/m2-cache.mjs [--check]
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'c', 'm2-cache.mjs');
export default function () {
  const args = [script].concat(process.argv.includes('--check') ? ['--check'] : []);
  process.stdout.write(execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));   // 不一致时子进程退出码 1 → 抛错，run.mjs 以非 0 退出
}
