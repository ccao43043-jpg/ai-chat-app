// 用 headless Chrome 把 SVG 渲染成各尺寸 PNG
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');
const D = __dirname, RES = path.join(D, '../app/src/main/res');
const bg = fs.readFileSync(path.join(D, 'icon-bg.svg'), 'utf8');
const fg = fs.readFileSync(path.join(D, 'icon-fg.svg'), 'utf8');
const mono = fs.readFileSync(path.join(D, 'icon-mono.svg'), 'utf8');
const strip = s => s.replace(/<svg[^>]*>/, '').replace('</svg>', '');
// 合成图：背景 + 前景（前景按自适应图标的视觉比例放大 ~1.12）
function composite(shape) {
  const clip = shape === 'circle' ? '<clipPath id="c"><circle cx="54" cy="54" r="54"/></clipPath>' : '<clipPath id="c"><rect x="0" y="0" width="108" height="108" rx="24"/></clipPath>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"><defs>${clip}</defs><g clip-path="url(#c)"><svg viewBox="0 0 108 108" width="108" height="108">${strip(bg)}</svg><g transform="translate(54 54) scale(1.18) translate(-54 -54)"><svg viewBox="0 0 108 108" width="108" height="108">${strip(fg)}</svg></g></g></svg>`;
}
const dens = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
(async () => {
  const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await b.newPage();
  async function render(svg, size, out) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg style="display:block;width:${size}px;height:${size}px" `)}</body></html>`;
    await page.setContent(html);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  for (const [d, s] of Object.entries(dens)) {
    const dir = path.join(RES, 'mipmap-' + d);
    await render(bg, Math.round(108 * s), path.join(dir, 'ic_launcher_background.png'));
    await render(fg, Math.round(108 * s), path.join(dir, 'ic_launcher_foreground.png'));
    await render(mono, Math.round(108 * s), path.join(dir, 'ic_launcher_monochrome.png'));
    await render(composite('rounded'), Math.round(48 * s), path.join(dir, 'ic_launcher.png'));
    await render(composite('circle'), Math.round(48 * s), path.join(dir, 'ic_launcher_round.png'));
  }
  await render(composite('rounded'), 512, path.join(D, '../docs/icon-512.png'));
  await render(composite('circle'), 512, path.join(D, 'icon-round-512.png'));
  // 应用内 logo
  fs.writeFileSync(path.join(D, '../app/src/main/assets/www/logo.svg'), composite('rounded'));
  await b.close();
})();
