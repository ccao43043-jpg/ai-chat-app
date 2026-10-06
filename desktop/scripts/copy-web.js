// 构建 / 运行前把 Android 的网页资源（唯一来源）复制到 desktop/web/，桌面版不另外维护一份。
// web/ 已加入 .gitignore。
const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '../../app/src/main/assets/www');
const DST = path.resolve(__dirname, '../web');

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error('找不到网页资源：' + SRC);
  process.exit(1);
}
fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });
let n = 0;
(function count(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? count(path.join(d, e.name)) : n++; })(DST);
console.log('已复制网页资源 ' + n + ' 个文件：' + path.relative(process.cwd(), SRC) + ' -> ' + path.relative(process.cwd(), DST));
