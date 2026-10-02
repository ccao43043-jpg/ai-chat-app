/* 文件解析：在手机本地从 PDF / Word / PowerPoint / Excel / 文本文件中提取文字（可在 Node 中测试） */
(function (root) {
  'use strict';

  const TEXT_EXTS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log',
    'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'go', 'rs', 'rb', 'php', 'swift', 'm', 'mm',
    'sh', 'bash', 'zsh', 'bat', 'ps1', 'sql', 'r', 'lua', 'dart', 'scala', 'vue', 'svelte', 'css', 'scss', 'less', 'gradle', 'properties', 'srt', 'vtt', 'tex', 'rst', 'org'];
  const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif'];
  const DEFAULT_FILE_MAX = 30000;   // 单个文件最多注入的字符数
  const DEFAULT_TOTAL_MAX = 80000;  // 一条消息所有文件合计上限

  function extOf(name) { const m = /\.([A-Za-z0-9]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }

  /** 判断文件类型：image | pdf | docx | pptx | xlsx | text | unsupported */
  function classifyFile(name, mime) {
    const ext = extOf(name); mime = String(mime || '').toLowerCase();
    if (mime.startsWith('image/') || IMAGE_EXTS.includes(ext)) return 'image';
    if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (ext === 'docx' || mime.includes('wordprocessingml')) return 'docx';
    if (ext === 'pptx' || mime.includes('presentationml')) return 'pptx';
    if (ext === 'xlsx' || mime.includes('spreadsheetml')) return 'xlsx';
    if (['doc', 'ppt', 'xls'].includes(ext)) return 'unsupported';
    if (TEXT_EXTS.includes(ext) || mime.startsWith('text/') || /json|xml|javascript|yaml|csv/.test(mime)) return 'text';
    return 'unknown'; // 尝试按文本读取
  }

  /** 解码文本：优先 UTF-8（含 BOM），失败则按 GB18030（兼容 GBK）解码 */
  function decodeText(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8[0] === 0xFF && u8[1] === 0xFE) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
    if (u8[0] === 0xFE && u8[1] === 0xFF) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be' };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8).replace(/^\uFEFF/, ''), encoding: 'utf-8' }; }
    catch (e) {
      try { return { text: new TextDecoder('gb18030').decode(u8), encoding: 'gb18030' }; }
      catch (e2) { return { text: new TextDecoder('utf-8').decode(u8), encoding: 'utf-8' }; }
    }
  }
  /** 粗略判断是否是二进制内容 */
  function looksBinary(text) {
    if (!text) return false;
    const sample = text.slice(0, 4000);
    let bad = 0;
    for (let i = 0; i < sample.length; i++) { const c = sample.charCodeAt(i); if (c === 0xFFFD || (c < 9) || (c > 13 && c < 32)) bad++; }
    return bad / sample.length > 0.08;
  }

  function decodeXmlEntities(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10))).replace(/&amp;/g, '&');
  }
  /** Word document.xml -> 文本（段落换行、制表符、换行符） */
  function docxXmlToText(xml) {
    const body = xml.replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<w:cr\/>/g, '\n');
    const paras = body.split(/<\/w:p>/);
    const out = paras.map(p => {
      let t = ''; const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|(\t)|(\n)/g; let m;
      while ((m = re.exec(p))) t += m[1] != null ? m[1] : (m[2] || m[3]);
      return decodeXmlEntities(t);
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  /** PowerPoint slideN.xml -> 文本 */
  function pptxXmlToText(xml) {
    return xml.split(/<\/a:p>/).map(p => { let t = ''; const re = /<a:t>([\s\S]*?)<\/a:t>/g; let m; while ((m = re.exec(p))) t += m[1]; return decodeXmlEntities(t); })
      .filter(s => s.trim()).join('\n');
  }

  function unzip(fflate, bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return fflate.unzipSync(u8);
  }
  const strFrom = (fflate, u8) => fflate.strFromU8(u8);

  function extractDocx(fflate, bytes) {
    const z = unzip(fflate, bytes);
    if (!z['word/document.xml']) throw new Error('不是有效的 Word（.docx）文件');
    let text = docxXmlToText(strFrom(fflate, z['word/document.xml']));
    // 脚注/尾注
    ['word/footnotes.xml', 'word/endnotes.xml'].forEach(n => { if (z[n]) { const t = docxXmlToText(strFrom(fflate, z[n])); if (t) text += '\n\n' + t; } });
    return text;
  }
  function extractPptx(fflate, bytes) {
    const z = unzip(fflate, bytes);
    const slides = Object.keys(z).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    if (!slides.length) throw new Error('不是有效的 PowerPoint（.pptx）文件');
    return slides.map((n, i) => '--- 第 ' + (i + 1) + ' 页 ---\n' + pptxXmlToText(strFrom(fflate, z[n]))).join('\n\n');
  }
  function colIndex(ref) { const m = /^([A-Z]+)/.exec(ref || ''); if (!m) return 0; let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }
  function extractXlsx(fflate, bytes, maxRows) {
    const z = unzip(fflate, bytes);
    const shared = [];
    if (z['xl/sharedStrings.xml']) {
      const xml = strFrom(fflate, z['xl/sharedStrings.xml']);
      (xml.match(/<si>[\s\S]*?<\/si>/g) || []).forEach(si => { let t = ''; const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g; let m; while ((m = re.exec(si))) t += m[1]; shared.push(decodeXmlEntities(t)); });
    }
    const names = [];
    if (z['xl/workbook.xml']) { const wb = strFrom(fflate, z['xl/workbook.xml']); const re = /<sheet [^>]*name="([^"]*)"/g; let m; while ((m = re.exec(wb))) names.push(decodeXmlEntities(m[1])); }
    const sheets = Object.keys(z).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));
    if (!sheets.length) throw new Error('不是有效的 Excel（.xlsx）文件');
    return sheets.map((n, si) => {
      const xml = strFrom(fflate, z[n]);
      const rows = (xml.match(/<row[\s\S]*?<\/row>/g) || []).slice(0, maxRows || 2000).map(row => {
        const cells = [];
        const re = /<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g; let m;
        while ((m = re.exec(row))) {
          const attrs = m[1], inner = m[2] || '';
          const r = /r="([A-Z]+\d+)"/.exec(attrs); const t = /t="(\w+)"/.exec(attrs);
          let v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
          if (t && t[1] === 's') v = shared[parseInt(v, 10)];
          else if (t && t[1] === 'inlineStr') v = ((/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)) || [])[1];
          v = v == null ? '' : decodeXmlEntities(String(v));
          cells[r ? colIndex(r[1]) : cells.length] = /[,"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }
        return Array.from(cells, c => c == null ? '' : c).join(',');
      });
      return '--- 工作表：' + (names[si] || ('Sheet' + (si + 1))) + ' ---\n' + rows.join('\n');
    }).join('\n\n');
  }

  /** PDF 字体常把“比/长/大”映射成康熙部首（U+2F00–U+2FDF）或部首补充字符，这里还原成常用汉字 */
  const RADICALS = '⻓长⻚页⻔门⻛风⻜飞⻝食⻢马⻥鱼⻦鸟⻰龙⻆角⻅见⻋车⻉贝⻨麦⻩黄⻬齐⻮齿⻳龟⻁虎⻄西⻘青⻙韦⻗雨⻈讠⻊足⻣骨⻤鬼⻧卤';
  function normalizeCjk(t) {
    return String(t).replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, ch => {
      const i = RADICALS.indexOf(ch);
      if (i >= 0 && i % 2 === 0) return RADICALS[i + 1];
      return ch.normalize('NFKC');
    });
  }

  /** 用 pdf.js 提取 PDF 文字。返回 {text, pages, scanned} */
  async function extractPdf(pdfjsLib, bytes, opts) {
    opts = opts || {};
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const params = { data, isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 };
    if (opts.CMapReaderFactory) { params.CMapReaderFactory = opts.CMapReaderFactory; params.cMapUrl = 'cmaps/'; params.cMapPacked = true; }
    if (opts.password) params.password = opts.password;
    let doc;
    try { doc = await pdfjsLib.getDocument(params).promise; }
    catch (e) {
      if (e && e.name === 'PasswordException') throw new Error('该 PDF 已加密，需要密码才能读取');
      throw new Error('无法解析 PDF：' + (e && e.message || e));
    }
    const maxPages = Math.min(doc.numPages, opts.maxPages || 300);
    const parts = [];
    let chars = 0;
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let t = '';
      tc.items.forEach(it => { if (typeof it.str === 'string') { t += it.str; if (it.hasEOL) t += '\n'; } });
      t = normalizeCjk(t).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      chars += t.replace(/\s/g, '').length;
      parts.push(t);
      if (opts.stopAfterChars && chars > opts.stopAfterChars) break;
    }
    const text = parts.map((t, i) => doc.numPages > 1 ? '--- 第 ' + (i + 1) + ' 页 ---\n' + t : t).join('\n\n');
    const scanned = chars < Math.max(10, 5 * parts.length);
    const result = { text: scanned ? '' : text, pages: doc.numPages, scanned, doc };
    return result;
  }

  /** 截断到上限 */
  function capText(text, max) {
    text = String(text || '');
    if (text.length <= max) return { text, truncated: false, total: text.length };
    return { text: text.slice(0, max), truncated: true, total: text.length };
  }

  /** 把文件内容拼进用户消息：files = [{name, text, truncated, total, pages}] */
  function buildFileContext(files, question, opts) {
    opts = opts || {};
    const totalMax = opts.totalMax || DEFAULT_TOTAL_MAX;
    let used = 0;
    const blocks = files.filter(f => f && f.text).map(f => {
      let body = f.text; let truncated = !!f.truncated;
      const remain = totalMax - used;
      if (body.length > remain) { body = body.slice(0, Math.max(0, remain)); truncated = true; }
      used += body.length;
      const meta = [f.pages ? f.pages + ' 页' : '', f.total ? f.total + ' 字符' : ''].filter(Boolean).join('，');
      return '【文件：' + f.name + '】' + (meta ? '（' + meta + '）' : '') + '\n' + body +
        (truncated ? '\n【注意：文件内容过长，以上仅为前 ' + body.length + ' 个字符，后续内容已截断】' : '') + '\n【文件结束：' + f.name + '】';
    });
    if (!blocks.length) return question || '';
    return '用户上传了以下文件，请基于文件内容回答：\n\n' + blocks.join('\n\n') + '\n\n' + (question ? '用户的问题：' + question : '请先概括这些文件的主要内容。');
  }

  function formatSize(n) { if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }

  const api = { TEXT_EXTS, DEFAULT_FILE_MAX, DEFAULT_TOTAL_MAX, extOf, classifyFile, decodeText, looksBinary, docxXmlToText, pptxXmlToText,
    extractDocx, extractPptx, extractXlsx, extractPdf, normalizeCjk, capText, buildFileContext, formatSize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Files = api;
})(typeof window !== 'undefined' ? window : globalThis);
