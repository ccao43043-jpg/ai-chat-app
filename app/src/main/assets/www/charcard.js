/* Character Card V2：PNG tEXt `chara` 导入/导出（独立模块，可在 Node 中测试）
 * 规格：https://github.com/malfoyslastname/character-card-spec-v2
 * 映射到本应用 persona + 世界书文本（RPCache.parseLore / loreToText）。
 */
(function (root) {
  'use strict';

  const SPEC = 'chara_card_v2';
  const SPEC_VERSION = '2.0';

  // ---- CRC32（PNG chunk） ----
  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function u8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }
  function concat(parts) {
    const n = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(n); let o = 0;
    parts.forEach(p => { out.set(p, o); o += p.length; });
    return out;
  }
  function be32(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }
  function readBe32(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
  function strBytes(s) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 255;
    return out;
  }
  function bytesToStr(b) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(b);
    let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s;
  }
  function b64encode(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8').toString('base64');
    if (typeof btoa !== 'undefined') {
      const bytes = strBytes(str);
      let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    throw new Error('no base64 encoder');
  }
  function b64decode(b64) {
    if (typeof Buffer !== 'undefined') return Buffer.from(String(b64).replace(/\s+/g, ''), 'base64').toString('utf8');
    if (typeof atob !== 'undefined') {
      const bin = atob(String(b64).replace(/\s+/g, ''));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return bytesToStr(bytes);
    }
    throw new Error('no base64 decoder');
  }

  const PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  function isPng(bytes) {
    const b = u8(bytes);
    if (b.length < 8) return false;
    for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false;
    return true;
  }

  /** 遍历 PNG chunk；返回 {type, data, offset, length}[] */
  function listChunks(bytes) {
    const b = u8(bytes);
    if (!isPng(b)) throw new Error('不是有效的 PNG 文件');
    const out = [];
    let i = 8;
    while (i + 12 <= b.length) {
      const len = readBe32(b, i);
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      const data = b.subarray(i + 8, i + 8 + len);
      out.push({ type, data, offset: i, length: len });
      i += 12 + len;
      if (type === 'IEND') break;
    }
    return out;
  }

  /** 读取 tEXt / zTXt 中 keyword === 'chara' 的值（base64 字符串） */
  function extractCharaRaw(bytes) {
    const chunks = listChunks(bytes);
    for (const ch of chunks) {
      if (ch.type !== 'tEXt' && ch.type !== 'zTXt') continue;
      const d = ch.data;
      let nul = -1;
      for (let i = 0; i < d.length; i++) if (d[i] === 0) { nul = i; break; }
      if (nul < 0) continue;
      const key = bytesToStr(d.subarray(0, nul));
      if (key !== 'chara') continue;
      if (ch.type === 'tEXt') return bytesToStr(d.subarray(nul + 1));
      // zTXt：compression method + compressed data（method 0 = zlib）— 浏览器可选用 fflate；Node 用 zlib
      const method = d[nul + 1];
      const compressed = d.subarray(nul + 2);
      if (method !== 0) throw new Error('不支持的 zTXt 压缩方式');
      if (typeof require !== 'undefined') {
        try {
          const zlib = require('zlib');
          return zlib.inflateSync(Buffer.from(compressed)).toString('utf8');
        } catch (_) { /* fallthrough */ }
      }
      if (root.fflate && root.fflate.unzlibSync) {
        return bytesToStr(root.fflate.unzlibSync(compressed));
      }
      throw new Error('需要 zlib/fflate 才能解析 zTXt chara');
    }
    return null;
  }

  function parseCardObject(obj) {
    if (!obj || typeof obj !== 'object') throw new Error('角色卡 JSON 无效');
    // 兼容裸 data / V1 扁平结构
    if (obj.spec === SPEC || obj.spec === 'chara_card_v3' || (obj.data && typeof obj.data === 'object')) {
      return { spec: obj.spec || SPEC, spec_version: obj.spec_version || SPEC_VERSION, data: obj.data || {} };
    }
    if (obj.name || obj.description || obj.personality) {
      return { spec: SPEC, spec_version: SPEC_VERSION, data: obj };
    }
    throw new Error('无法识别的角色卡结构');
  }

  /** 从 PNG bytes 或 JSON 字符串 / 对象解析角色卡 */
  function parseCard(input) {
    if (input == null) throw new Error('空输入');
    if (typeof input === 'object' && !(input instanceof Uint8Array) && !(input.buffer && input.byteLength != null && !Array.isArray(input))) {
      if (input instanceof ArrayBuffer) input = new Uint8Array(input);
      else if (ArrayBuffer.isView && ArrayBuffer.isView(input) && !(input instanceof DataView)) input = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else return parseCardObject(input);
    }
    if (typeof input === 'string') {
      const t = input.trim();
      if (t.startsWith('{')) return parseCardObject(JSON.parse(t));
      // 可能是纯 base64 chara
      try { return parseCardObject(JSON.parse(b64decode(t))); } catch (_) { throw new Error('无法解析角色卡文本'); }
    }
    const bytes = u8(input);
    if (isPng(bytes)) {
      const raw = extractCharaRaw(bytes);
      if (!raw) throw new Error('PNG 中没有 tEXt/zTXt chara 块（不是 Character Card）');
      return parseCardObject(JSON.parse(b64decode(raw)));
    }
    // 尝试当 UTF-8 JSON
    try { return parseCardObject(JSON.parse(bytesToStr(bytes))); } catch (_) {}
    throw new Error('无法识别的角色卡文件');
  }

  /** ST character_book.entries → 本应用 lore 文本 */
  function bookToLoreText(book) {
    if (!book) return '';
    const entries = Array.isArray(book) ? book : (book.entries || []);
    const lines = [];
    entries.forEach((e, i) => {
      if (!e || e.enabled === false) return;
      const name = String(e.comment || e.name || ('条目' + (i + 1))).trim() || ('条目' + (i + 1));
      const content = String(e.content || '').replace(/\r\n?/g, '\n').trim();
      if (!content) return;
      const constant = !!(e.constant || e.forceConstant);
      const keys = [].concat(e.key || e.keys || []).map(k => String(k).trim()).filter(Boolean);
      const sec = [].concat(e.keysecondary || e.secondary_keys || e.secondaryKeys || []).map(k => String(k).trim()).filter(Boolean);
      const attrs = [];
      if (e.priority != null) attrs.push('priority=' + (e.priority | 0));
      if (e.order != null) attrs.push('order=' + (e.order | 0));
      if (e.probability != null && e.probability !== 100) attrs.push('prob=' + Number(e.probability));
      if (e.scanDepth != null || e.scan_depth != null) attrs.push('depth=' + ((e.scanDepth != null ? e.scanDepth : e.scan_depth) | 0));
      if (sec.length) {
        attrs.push('sec=' + sec.join(','));
        const logic = e.selectiveLogic != null ? e.selectiveLogic : (e.secondaryLogic || e.secondary_logic);
        // ST: 0=AND_ANY, 1=NOT_ALL, 2=NOT_ANY, 3=AND_ALL
        const map = { 0: 'AND_ANY', 1: 'NOT_ALL', 2: 'NOT_ANY', 3: 'AND_ALL', AND_ANY: 'AND_ANY', AND_ALL: 'AND_ALL', NOT_ANY: 'NOT_ANY', NOT_ALL: 'NOT_ALL' };
        if (logic != null && map[logic]) attrs.push('secLogic=' + map[logic]);
      }
      if (e.sticky) attrs.push('sticky=' + (e.sticky | 0));
      if (e.cooldown) attrs.push('cooldown=' + (e.cooldown | 0));
      if (e.delay) attrs.push('delay=' + (e.delay | 0));
      if (e.useRegex || e.regex) attrs.push('regex=1');
      if (e.caseSensitive) attrs.push('case=1');
      if (e.matchWholeWords || e.wholeWord) attrs.push('whole=1');
      let head;
      if (constant || (!keys.length && !e.keys)) head = '## ' + name + ' | *';
      else head = '## ' + name + ' | ' + keys.join(', ');
      if (attrs.length) head += ' | ' + attrs.join(';');
      lines.push(head + '\n' + content);
    });
    return lines.join('\n\n');
  }

  /** lore 条目 → ST character_book.entries */
  function loreEntriesToBook(entries, meta) {
    const list = (entries || []).map((e, i) => {
      const out = {
        keys: e.mode === 'constant' ? [] : (e.keys || []).slice(),
        content: e.content || '',
        extensions: {},
        enabled: true,
        insertion_order: e.order != null ? e.order : i,
        case_sensitive: !!e.caseSensitive,
        name: e.name || '',
        priority: e.priority != null ? e.priority : 100,
        id: i,
        comment: e.name || '',
        selective: !!(e.secondaryKeys && e.secondaryKeys.length),
        secondary_keys: (e.secondaryKeys || []).slice(),
        constant: e.mode === 'constant',
        position: 'before_char',
        probability: e.probability != null ? e.probability : 100,
      };
      if (e.secondaryLogic) {
        const map = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };
        out.selectiveLogic = map[e.secondaryLogic] != null ? map[e.secondaryLogic] : 0;
      }
      if (e.useRegex) out.useRegex = true;
      if (e.scanDepth != null) out.scanDepth = e.scanDepth;
      if (e.sticky) out.sticky = e.sticky;
      if (e.cooldown) out.cooldown = e.cooldown;
      if (e.delay) out.delay = e.delay;
      return out;
    });
    return Object.assign({ name: (meta && meta.name) || '', entries: list }, meta || {});
  }

  function joinParts(parts) {
    return parts.filter(Boolean).join('\n\n');
  }

  /** V2 data → 本应用 persona 字段（含 loreText / firstMes 等扩展） */
  function cardToPersona(card, opts) {
    const c = parseCardObject(card).data || {};
    const name = String(c.name || '未命名角色').trim() || '未命名角色';
    const desc = String(c.creator_notes || c.description || '').trim().slice(0, 120);
    const blocks = [];
    if (c.description) blocks.push('【角色描述】\n' + String(c.description).trim());
    if (c.personality) blocks.push('【性格】\n' + String(c.personality).trim());
    if (c.scenario) blocks.push('【场景】\n' + String(c.scenario).trim());
    if (c.mes_example) blocks.push('【对话示例】\n' + String(c.mes_example).trim());
    if (c.system_prompt) blocks.push('【系统提示】\n' + String(c.system_prompt).trim());
    if (c.post_history_instructions) blocks.push('【历史后指令】\n' + String(c.post_history_instructions).trim());
    let systemPrompt = joinParts(blocks);
    if (!systemPrompt && c.first_mes) systemPrompt = '你将扮演「' + name + '」。保持角色一致。';
    const loreText = bookToLoreText(c.character_book);
    const emoji = (opts && opts.emoji) || '🎭';
    return {
      emoji,
      name,
      desc: desc || (String(c.description || '').trim().slice(0, 80)),
      systemPrompt: systemPrompt || ('你将扮演「' + name + '」。'),
      loreText,
      firstMes: String(c.first_mes || '').trim(),
      alternateGreetings: Array.isArray(c.alternate_greetings) ? c.alternate_greetings.map(String) : [],
      mesExample: String(c.mes_example || '').trim(),
      cardSpec: SPEC,
      cardRaw: c,
      temperature: '',
      builtin: false,
    };
  }

  /** persona（+ 可选 lore 列表）→ V2 card 对象 */
  function personaToCard(persona, loreEntries) {
    const p = persona || {};
    const raw = p.cardRaw || {};
    const loreText = p.loreText || '';
    let entries = loreEntries;
    if (!entries && loreText && root.RPCache && typeof root.RPCache.parseLore === 'function') {
      entries = root.RPCache.parseLore(loreText);
    } else if (!entries && loreText) {
      // 轻量回退：只按 ## 头解析成 trigger/constant（无 ST 高级字段）
      entries = String(loreText).split(/\n(?=##\s)/).map((block, i) => {
        const m = /^##\s*(.+?)\s*(?:\|\s*(.*))?[\n\r]([\s\S]*)$/.exec(block.trim());
        if (!m) return null;
        const keysRaw = (m[2] || '').trim();
        const constant = keysRaw === '*' || keysRaw === '';
        return {
          name: m[1].trim(),
          mode: constant ? 'constant' : 'trigger',
          keys: constant ? [] : keysRaw.split(/[,，、|;]/)[0].split(/[,，、]/).map(k => k.trim()).filter(Boolean),
          content: (m[3] || '').trim(),
          secondaryKeys: [],
          order: i,
        };
      }).filter(Boolean);
    }
    const data = {
      name: p.name || raw.name || '未命名',
      description: raw.description || p.desc || '',
      personality: raw.personality || '',
      scenario: raw.scenario || '',
      first_mes: p.firstMes || raw.first_mes || '',
      mes_example: p.mesExample || raw.mes_example || '',
      creator_notes: raw.creator_notes || p.desc || '',
      system_prompt: raw.system_prompt || '',
      post_history_instructions: raw.post_history_instructions || '',
      alternate_greetings: p.alternateGreetings || raw.alternate_greetings || [],
      tags: raw.tags || [],
      creator: raw.creator || '',
      character_version: raw.character_version || '',
      extensions: Object.assign({}, raw.extensions || {}, { aichat_system_prompt: p.systemPrompt || '' }),
      character_book: loreEntriesToBook(entries || [], { name: (p.name || '') + ' lore' }),
    };
    // 若原始卡没有拆开 description，把 systemPrompt 放进 description 以便 ST 可读
    if (!data.description && p.systemPrompt) data.description = p.systemPrompt;
    if (!data.system_prompt && p.systemPrompt && data.description !== p.systemPrompt) data.system_prompt = p.systemPrompt;
    return { spec: SPEC, spec_version: SPEC_VERSION, data };
  }

  function makeChunk(type, data) {
    const typeB = strBytes(type);
    const len = be32(data.length);
    const body = concat([typeB, data]);
    const crc = be32(crc32(body));
    return concat([len, body, crc]);
  }

  /** 极简 1×1 PNG（灰点）作导出底图 */
  function minimalPng() {
    // 预计算的合法 1x1 RGBA PNG
    const hex = '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082';
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  /** 把 card 写入 PNG（替换已有 chara，或插入到 IEND 前） */
  function writeCardToPng(card, basePng) {
    const obj = card.spec ? card : { spec: SPEC, spec_version: SPEC_VERSION, data: card };
    const payload = strBytes(b64encode(JSON.stringify(obj)));
    const textData = concat([strBytes('chara'), new Uint8Array([0]), payload]);
    const charaChunk = makeChunk('tEXt', textData);
    const base = basePng ? u8(basePng) : minimalPng();
    if (!isPng(base)) throw new Error('底图不是 PNG');
    const chunks = listChunks(base);
    const kept = [];
    for (const ch of chunks) {
      if (ch.type === 'tEXt' || ch.type === 'zTXt') {
        let nul = -1;
        for (let i = 0; i < ch.data.length; i++) if (ch.data[i] === 0) { nul = i; break; }
        const key = nul >= 0 ? bytesToStr(ch.data.subarray(0, nul)) : '';
        if (key === 'chara') continue; // 去掉旧的
      }
      if (ch.type === 'IEND') continue;
      kept.push(base.subarray(ch.offset, ch.offset + 12 + ch.length));
    }
    const iend = makeChunk('IEND', new Uint8Array(0));
    return concat([PNG_SIG].concat(kept).concat([charaChunk, iend]));
  }

  /** 便捷：从 File/Blob 读 ArrayBuffer（浏览器） */
  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(rd.result);
      rd.onerror = () => reject(rd.error || new Error('读取失败'));
      rd.readAsArrayBuffer(file);
    });
  }

  const api = {
    SPEC, SPEC_VERSION, isPng, listChunks, extractCharaRaw, parseCard, parseCardObject,
    bookToLoreText, loreEntriesToBook, cardToPersona, personaToCard, writeCardToPng, minimalPng,
    readFileAsArrayBuffer, b64encode, b64decode,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CharCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
