// 文件文字提取：PDF（使用 APK 内置的 pdf.js 与 CMap）、Word、PowerPoint、Excel、文本
const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const W = path.join(__dirname, '../app/src/main/assets/www/');
const FIX = path.join(__dirname, 'fixtures');
const F = require(W + 'files.js');
const fflate = require(W + 'lib/fflate.min.js');

// Node 中没有 canvas，pdf.js 会打印 polyfill 警告，这里静默
const warn = console.warn, log = console.log;
console.warn = () => {}; console.log = (...a) => { if (!String(a[0]).startsWith('Warning')) log(...a); };
const pdfjs = require(W + 'lib/pdf.min.js');
globalThis.pdfjsWorker = require(W + 'lib/pdf.worker.min.js');
console.warn = warn;
const cmapReads = [];
class CMapFactory { async fetch({ name }) { cmapReads.push(name); return { cMapData: new Uint8Array(fs.readFileSync(W + 'lib/cmaps/' + name + '.bcmap')), compressionType: 1 }; } }
const readPdf = name => F.extractPdf(pdfjs, new Uint8Array(fs.readFileSync(path.join(FIX, name))), { CMapReaderFactory: CMapFactory });

test('文件类型识别', () => {
  assert.strictEqual(F.classifyFile('a.PDF', ''), 'pdf');
  assert.strictEqual(F.classifyFile('photo.jpg', ''), 'image');
  assert.strictEqual(F.classifyFile('x', 'image/png'), 'image');
  assert.strictEqual(F.classifyFile('报告.docx', ''), 'docx');
  assert.strictEqual(F.classifyFile('s.pptx', ''), 'pptx');
  assert.strictEqual(F.classifyFile('t.xlsx', ''), 'xlsx');
  assert.strictEqual(F.classifyFile('old.doc', ''), 'unsupported');
  ['main.py', 'App.kt', 'data.csv', 'conf.json', 'README.md', 'notes.txt'].forEach(n => assert.strictEqual(F.classifyFile(n, ''), 'text', n));
  assert.strictEqual(F.classifyFile('LICENSE', ''), 'unknown');
});

test('PDF：提取中英文文字（两页，含页码标记，康熙部首还原）', async () => {
  const r = await readPdf('sample-text.pdf');
  assert.strictEqual(r.pages, 2);
  assert.strictEqual(r.scanned, false);
  assert.ok(r.text.includes('--- 第 1 页 ---') && r.text.includes('--- 第 2 页 ---'));
  assert.ok(r.text.includes('2026 年第三季度销售报告'));
  assert.ok(r.text.includes('同比增长 23%'), r.text);
  assert.ok(r.text.includes('第二页：下季度计划'));
  assert.ok(r.text.includes('Key takeaway: online channel grew 57%'));
  assert.ok(!/[\u2E80-\u2FDF]/.test(r.text), '不应残留部首字符');
  r.doc.destroy();
});

test('PDF：使用预定义 CMap（UniGB-UCS2-H）的中文 PDF', async () => {
  const r = await readPdf('sample-unigb.pdf');
  assert.strictEqual(r.text, '你好世界，联网搜索测试');
  assert.ok(cmapReads.includes('UniGB-UCS2-H'));
  r.doc.destroy();
});

test('PDF：扫描件（无文字层）被识别', async () => {
  const r = await readPdf('sample-scanned.pdf');
  assert.strictEqual(r.scanned, true);
  assert.strictEqual(r.text, '');
  assert.strictEqual(r.pages, 1);
  r.doc.destroy();
});

test('PDF：损坏文件给出中文错误', async () => {
  await assert.rejects(F.extractPdf(pdfjs, new TextEncoder().encode('not a pdf'), {}), /无法解析 PDF/);
});

test('Word / PowerPoint / Excel 提取', () => {
  const S = s => fflate.strToU8(s);
  const docx = fflate.zipSync({
    '[Content_Types].xml': S('<Types/>'),
    'word/document.xml': S('<w:document><w:body><w:p><w:r><w:t>第一段：</w:t></w:r><w:r><w:t xml:space="preserve">项目 &amp; 预算</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>换行</w:t></w:r></w:p></w:body></w:document>'),
  });
  assert.strictEqual(F.extractDocx(fflate, docx), '第一段：项目 & 预算\nA\tB\n换行');
  assert.throws(() => F.extractDocx(fflate, fflate.zipSync({ 'a.txt': S('x') })), /docx/);

  const pptx = fflate.zipSync({
    'ppt/slides/slide2.xml': S('<p:sld><a:p><a:r><a:t>第二页标题</a:t></a:r></a:p></p:sld>'),
    'ppt/slides/slide1.xml': S('<p:sld><a:p><a:r><a:t>封面</a:t></a:r></a:p><a:p><a:r><a:t>副标题</a:t></a:r></a:p></p:sld>'),
  });
  const pt = F.extractPptx(fflate, pptx);
  assert.ok(pt.indexOf('封面') < pt.indexOf('第二页标题'), pt);
  assert.ok(pt.includes('副标题'));

  const xlsx = fflate.zipSync({
    'xl/workbook.xml': S('<workbook><sheets><sheet name="销售" sheetId="1"/></sheets></workbook>'),
    'xl/sharedStrings.xml': S('<sst><si><t>城市</t></si><si><t>营收</t></si><si><t>成都</t></si></sst>'),
    'xl/worksheets/sheet1.xml': S('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>300</v></c></row></sheetData></worksheet>'),
  });
  const xt = F.extractXlsx(fflate, xlsx);
  assert.ok(xt.includes('销售'), xt);
  assert.ok(xt.includes('城市') && xt.includes('成都') && xt.includes('300'), xt);
});

test('文本解码：UTF-8 / BOM / GBK，二进制检测', () => {
  assert.strictEqual(F.decodeText(new Uint8Array([0xEF, 0xBB, 0xBF, 0xE4, 0xBD, 0xA0])).text, '你');
  const gbk = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3]); // “你好” GBK
  const d = F.decodeText(gbk);
  assert.strictEqual(d.encoding, 'gb18030');
  assert.strictEqual(d.text, '你好');
  assert.strictEqual(F.looksBinary('普通文本\nhello'), false);
  assert.strictEqual(F.looksBinary('\u0000\u0001\u0002\u0003abc'), true);
});

test('注入文件内容：文件名标题、单文件截断提示、总长度上限', () => {
  const c = F.capText('a'.repeat(100), 40);
  assert.deepStrictEqual([c.text.length, c.truncated, c.total], [40, true, 100]);
  const ctx = F.buildFileContext([
    { name: '报告.pdf', text: '营收 1280 万', pages: 2, total: 9 },
    { name: '长文.txt', text: c.text, truncated: true, total: 100 },
  ], '营收多少？');
  assert.ok(ctx.includes('【文件：报告.pdf】（2 页，9 字符）\n营收 1280 万\n【文件结束：报告.pdf】'));
  assert.ok(ctx.includes('【文件：长文.txt】') && ctx.includes('后续内容已截断'));
  assert.ok(ctx.endsWith('用户的问题：营收多少？'));
  const big = F.buildFileContext([{ name: 'a', text: 'x'.repeat(50) }, { name: 'b', text: 'y'.repeat(50) }], '', { totalMax: 70 });
  assert.ok(big.includes('前 20 个字符'), '总上限截断');
  assert.ok(big.endsWith('请先概括这些文件的主要内容。'));
  assert.strictEqual(F.buildFileContext([], '仅问题'), '仅问题');
  assert.strictEqual(F.formatSize(1536), '1.5 KB');
});

test('takeInputFiles 在清空 input.value 前拷贝实时 FileList（v0.6.7 上传无反应回归）', () => {
  const Files = require('../app/src/main/assets/www/files.js');
  const live = [{ name: 'a.pdf' }, { name: 'b.txt' }];
  const input = { get files() { return live; }, set value(v) { if (v === '') live.length = 0; } };
  const got = Files.takeInputFiles(input);
  assert.strictEqual(got.length, 2);
  assert.strictEqual(got[0].name, 'a.pdf');
  assert.deepStrictEqual(Files.takeInputFiles(null), []);
});
