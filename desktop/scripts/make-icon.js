// 用 Electron 离屏渲染应用内 logo.svg（与 Android 图标同一设计：靛蓝底 + 白色聊天气泡），
// 生成 resources/icon.png（512）与 resources/icon.ico（16–256 多尺寸，PNG 压缩条目）。
// 运行：npx electron scripts/make-icon.js   （无显示器时：xvfb-run -a npx electron scripts/make-icon.js）
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG = fs.readFileSync(path.resolve(__dirname, '../../app/src/main/assets/www/logo.svg'), 'utf8');
const OUT = path.resolve(__dirname, '../resources');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256];

function buildIco(images) { // images: [{size, png:Buffer}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + dir.length;
  images.forEach((im, i) => {
    const o = i * 16;
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o);
    dir.writeUInt8(im.size >= 256 ? 0 : im.size, o + 1);
    dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(im.png.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += im.png.length;
  });
  return Buffer.concat([header, dir, ...images.map(im => im.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 512, height: 512, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  async function render(size) {
    win.setContentSize(size, size);
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">${SVG.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`;
    await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
    await new Promise(r => setTimeout(r, 150));
    const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    return img.resize({ width: size, height: size, quality: 'best' }).toPNG();
  }
  fs.mkdirSync(OUT, { recursive: true });
  const big = await render(512);
  fs.writeFileSync(path.join(OUT, 'icon.png'), big);
  const imgs = [];
  for (const s of SIZES) imgs.push({ size: s, png: await render(s) });
  fs.writeFileSync(path.join(OUT, 'icon.ico'), buildIco(imgs));
  console.log('icon.png / icon.ico 已生成：', SIZES.join(','));
  app.quit();
});
