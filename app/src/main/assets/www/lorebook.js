/* 世界书（Lorebook）—— 纯函数，可在 Node 中测试
 * 条目：{ id, title, keywords[], content, enabled, sticky }
 * sticky = 常驻（始终注入）；其余条目在最近消息命中关键词时注入系统提示词 */
(function (root) {
  'use strict';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  function splitKeys(k) {
    const arr = Array.isArray(k) ? k : String(k || '').split(/[,，、\n]+/);
    return arr.map(x => String(x).trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 30);
  }
  function normalize(e) {
    e = e || {};
    const content = String(e.content || '');
    return {
      id: e.id || 'lb-' + uid(),
      title: String(e.title || e.comment || '').trim() || content.trim().slice(0, 12) || '未命名条目',
      keywords: splitKeys(e.keywords != null ? e.keywords : e.key || e.keys),
      content,
      enabled: e.enabled !== false,
      sticky: !!(e.sticky || e.constant),
    };
  }
  function upsert(list, e) {
    const n = normalize(e); const i = list.findIndex(x => x.id === n.id);
    const out = list.slice(); if (i >= 0) out[i] = n; else out.unshift(n); return out;
  }
  const remove = (list, id) => list.filter(x => x.id !== id);
  const toggle = (list, id, field) => list.map(x => (x.id === id ? Object.assign({}, x, { [field || 'enabled']: !x[field || 'enabled'] }) : x));

  /** mode: all | sticky | enabled | keyword */
  function filter(list, mode, query) {
    const q = String(query || '').trim().toLowerCase();
    return (list || []).filter(e => {
      if (mode === 'sticky' && !e.sticky) return false;
      if (mode === 'enabled' && !e.enabled) return false;
      if (mode === 'keyword' && (e.sticky || !e.keywords.length)) return false;
      if (!q) return true;
      return e.title.toLowerCase().includes(q) || e.content.toLowerCase().includes(q) || e.keywords.some(k => k.toLowerCase().includes(q));
    });
  }

  /** 返回本轮需要注入的条目（已启用 & 有内容 & 常驻或关键词命中 text） */
  function match(list, text) {
    const t = String(text || '').toLowerCase();
    return (list || []).filter(e => e.enabled && e.content.trim() &&
      (e.sticky || e.keywords.some(k => k && t.includes(k.toLowerCase()))));
  }
  function buildBlock(entries) {
    if (!entries.length) return '';
    return '【世界书】\n' + entries.map(e => '## ' + e.title + '\n' + e.content.trim()).join('\n\n');
  }
  /** 把命中的条目拼到系统提示词后面；没有命中时原样返回 */
  function inject(systemPrompt, list, text) {
    const block = buildBlock(match(list, text));
    if (!block) return { systemPrompt: systemPrompt || '', entries: [] };
    const sp = String(systemPrompt || '').trim();
    return { systemPrompt: sp ? sp + '\n\n' + block : block, entries: match(list, text) };
  }
  /** 从最近几条消息里取扫描文本 */
  function scanText(messages, depth) {
    return (messages || []).filter(m => m && (m.role === 'user' || m.role === 'assistant'))
      .slice(-(depth || 4)).map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
  }

  // 导入：本应用格式 {entries:[...]} / 数组 / SillyTavern 世界书 {entries:{0:{key,content,comment,constant,disable}}}
  function importJSON(text, list) {
    let data;
    try { data = JSON.parse(String(text || '').replace(/^\uFEFF/, '')); } catch (e) { throw new Error('不是有效的 JSON'); }
    let arr = Array.isArray(data) ? data : data && data.entries ? data.entries : data && data.data && data.data.character_book ? data.data.character_book.entries : null;
    if (arr && !Array.isArray(arr)) arr = Object.keys(arr).map(k => arr[k]);
    if (!arr) throw new Error('没有找到世界书条目');
    let out = list.slice(); let added = 0, skipped = 0;
    arr.forEach(x => {
      if (!x || typeof x !== 'object' || !String(x.content || '').trim()) { skipped++; return; }
      const n = normalize({ title: x.title || x.comment || x.name, keywords: x.keywords || x.key || x.keys, content: x.content,
        sticky: x.sticky || x.constant, enabled: x.enabled !== false && !x.disable });
      delete n.id; n.id = 'lb-' + uid();
      if (out.some(e => e.title === n.title && e.content === n.content)) { skipped++; return; }
      out.push(n); added++;
    });
    return { list: out, added, skipped };
  }
  const exportJSON = list => JSON.stringify({ format: 'ai-chat-lorebook', version: 1, entries: list }, null, 2);

  const api = { normalize, splitKeys, upsert, remove, toggle, filter, match, buildBlock, inject, scanText, importJSON, exportJSON };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Lorebook = api;
})(typeof window !== 'undefined' ? window : globalThis);
