// 生成测试用 PDF（需要 puppeteer-core 与本机 Chrome）：node tests/fixtures/make-fixtures.js
const puppeteer = require('puppeteer-core');
const fs = require('fs'), path = require('path');
const D = __dirname;
(async () => {
  const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  const page = await b.newPage();
  // 1) 有文字层的两页 PDF（中英文）
  await page.setContent(`<html><body style="font-family:'Noto Sans CJK SC',sans-serif;font-size:16px">
    <h1>2026 年第三季度销售报告</h1><p>本季度总营收为 1280 万元，同比增长 23%。华东区贡献最大，占比 41%。</p>
    <p>Key takeaway: online channel grew 57% year over year.</p>
    <div style="page-break-after:always"></div>
    <h2>第二页：下季度计划</h2><p>计划在成都和西安新开两家门店，预算 300 万元。</p></body></html>`);
  fs.writeFileSync(path.join(D, 'sample-text.pdf'), await page.pdf({ format: 'A5' }));
  // 2) 只有图片、没有文字层的 PDF（模拟扫描件）
  await page.setContent(`<html><body style="margin:0"><canvas id="c" width="600" height="300"></canvas><script>
    const g=document.getElementById('c').getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,600,300);g.fillStyle='#000';g.font='40px sans-serif';g.fillText('扫描件 Scanned 文本',40,150);
    const img=new Image();img.src=document.getElementById('c').toDataURL('image/png');document.body.innerHTML='';document.body.appendChild(img);
  </script></body></html>`);
  await new Promise(r => setTimeout(r, 300));
  fs.writeFileSync(path.join(D, 'sample-scanned.pdf'), await page.pdf({ format: 'A5' }));
  await b.close();
  // 3) 使用预定义 CMap（UniGB-UCS2-H，非嵌入 STSong-Light）的 PDF —— 用于验证 cmaps 加载
  const hex = Buffer.from('你好世界，联网搜索测试', 'utf16le').swap16().toString('hex').toUpperCase();
  const content = 'BT /F1 24 Tf 40 700 Td <' + hex + '> Tj ET';
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>',
  ];
  let out = Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out = Buffer.concat([out, Buffer.from((i + 1) + ' 0 obj\n' + o + '\nendobj\n', 'latin1')]); });
  const x = out.length;
  let tail = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  tail += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + x + '\n%%EOF\n';
  fs.writeFileSync(path.join(D, 'sample-unigb.pdf'), Buffer.concat([out, Buffer.from(tail, 'latin1')]));
  console.log('ok');
})();
