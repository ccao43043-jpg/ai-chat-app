// 启动 Electron 端到端测试；没有显示器时自动套 xvfb-run
const { spawnSync } = require('child_process');
const path = require('path');
const electron = require('electron'); // 返回可执行文件路径
const main = path.join(__dirname, 'e2e-main.js');
const args = [main, '--no-sandbox'];
const useXvfb = process.platform === 'linux' && !process.env.DISPLAY;
const r = useXvfb
  ? spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x900x24', electron, ...args], { stdio: 'inherit' })
  : spawnSync(electron, args, { stdio: 'inherit' });
process.exit(r.status == null ? 1 : r.status);
