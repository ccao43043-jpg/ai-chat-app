/* 提示词模板（切换「本对话的系统提示词」）—— 纯函数，可在 Node 中测试
 * 区别：模板 = 替换当前对话的系统提示词；⚡ 提示词库 = 把文字插入输入框；助手 = 新建带设定 / 模型 / 温度的对话 */
(function (root) {
  'use strict';
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const clone = o => JSON.parse(JSON.stringify(o));

  const BUILTIN_TEMPLATES = [
    { id: 't-general', emoji: '💬', name: '通用助手', tags: ['常用'], pinned: true,
      content: '你是一个乐于助人、知识渊博的 AI 助手。\n- 用简体中文回答，除非用户使用其他语言；\n- 先给结论，再展开必要的细节；\n- 不确定的信息要明确说明，不要编造；\n- 适当使用 Markdown（列表、表格、代码块）让回答更清晰。' },
    { id: 't-concise', emoji: '⚡', name: '简洁回答', tags: ['常用'], pinned: true,
      content: '请用最简洁的方式回答：\n- 直接给出答案，不要寒暄、不要复述问题；\n- 能用一句话说清的不用两句；\n- 只有在用户追问时才展开解释。' },
    { id: 't-translate', emoji: '🌐', name: '中英互译', tags: ['语言'],
      content: '你是一名专业翻译。用户输入中文时翻译成地道的英文；输入其他语言时翻译成流畅自然的简体中文。\n保留原文的语气、格式和专有名词，只输出译文，不要解释。' },
    { id: 't-polish', emoji: '✍️', name: '润色改写', tags: ['写作'],
      content: '你是一名中文写作编辑。用户发来的每一段文字都需要润色：保持原意，使表达更准确、通顺、有节奏感，删去空话套话。\n先给出润色后的全文，再用 2–4 个要点说明主要改动。' },
    { id: 't-rp-narrator', emoji: '🎭', name: 'RP 叙事风格', tags: ['角色扮演'],
      content: '你是一名沉浸式角色扮演的叙事者，扮演{{角色名}}，世界背景：{{世界背景}}。\n- 以第三人称描写环境、动作与神态，对话用引号；\n- 只描写{{角色名}}和 NPC 的言行，绝不替玩家决定行动或心理；\n- NPC 只知道自己应该知道的信息；\n- 每次回复 150–300 字，结尾留下可以继续互动的钩子。' },
    { id: 't-coder', emoji: '💻', name: '代码审查', tags: ['编程'],
      content: '你是一名资深工程师，负责审查用户发来的代码（主要语言：{{编程语言}}）。\n按「严重问题 / 潜在风险 / 可读性与风格」三类列出问题，每条给出修改建议和示例代码。最后给出修改后的完整代码。' },
    { id: 't-tutor', emoji: '🎓', name: '苏格拉底导师', tags: ['学习'],
      content: '你是一位苏格拉底式导师。不要直接给出答案，而是通过一连串循序渐进的问题引导用户自己想明白；每次只问一个问题，根据用户的回答调整难度。用户明确说「告诉我答案」时再给出完整解答。' },
    { id: 't-role', emoji: '🧑‍💼', name: '以某种身份回答', tags: ['常用'],
      content: '请以{{身份}}的身份和专业视角回答我的问题，语气{{语气}}。' },
  ];

  function normalizeTemplate(t) {
    t = t || {};
    const tags = Array.isArray(t.tags) ? t.tags : String(t.tags || '').split(/[,，、\s]+/);
    return {
      id: t.id || 't-' + uid(), name: String(t.name || '').trim() || String(t.content || '').trim().slice(0, 12) || '未命名模板',
      emoji: String(t.emoji || '').trim().slice(0, 4), content: String(t.content || ''),
      tags: tags.map(x => String(x).trim()).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 8),
      pinned: !!t.pinned, builtin: !!t.builtin,
    };
  }
  const defaultTemplates = () => BUILTIN_TEMPLATES.map(t => normalizeTemplate(Object.assign(clone(t), { builtin: true })));
  /** 新版本新增的内置模板补进来（用户删掉的不再出现） */
  function mergeBuiltins(list, removedIds) {
    const out = (list || []).map(normalizeTemplate);
    const removed = new Set(removedIds || []);
    defaultTemplates().forEach(b => { if (!removed.has(b.id) && !out.some(x => x.id === b.id)) out.push(b); });
    return out;
  }
  function upsert(list, t) {
    const n = normalizeTemplate(t); const i = list.findIndex(x => x.id === n.id);
    if (i < 0) return [n].concat(list);
    const out = list.slice(); out[i] = Object.assign({}, list[i], n, { builtin: list[i].builtin }); return out;
  }
  function duplicate(list, id) {
    const i = list.findIndex(x => x.id === id); if (i < 0) return list;
    const c = Object.assign(clone(list[i]), { id: 't-' + uid(), name: list[i].name + '（副本）', builtin: false, pinned: false });
    const out = list.slice(); out.splice(i + 1, 0, c); return out;
  }
  const remove = (list, id) => list.filter(x => x.id !== id);
  function move(list, id, dir) {
    const i = list.findIndex(x => x.id === id); const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= list.length) return list;
    const out = list.slice(); const t = out[i]; out[i] = out[j]; out[j] = t; return out;
  }
  function togglePin(list, id) { return list.map(x => (x.id === id ? Object.assign({}, x, { pinned: !x.pinned }) : x)); }
  const allTags = list => list.reduce((a, t) => { t.tags.forEach(g => { if (a.indexOf(g) < 0) a.push(g); }); return a; }, []);
  /** 搜索（名称 / 内容 / 标签）+ 标签筛选；收藏在前，其余保持用户排列的顺序 */
  function filter(list, o) {
    o = o || {}; const q = String(o.query || '').trim().toLowerCase();
    const hit = t => (!o.tag || t.tags.indexOf(o.tag) >= 0) && (!q || t.name.toLowerCase().includes(q) || t.content.toLowerCase().includes(q) || t.tags.some(g => g.toLowerCase().includes(q)));
    const res = list.filter(hit);
    return res.filter(t => t.pinned).concat(res.filter(t => !t.pinned));
  }
  function pushRecent(recent, id, max) { return [id].concat((recent || []).filter(x => x !== id)).slice(0, max || 5); }
  const recentOf = (list, recent) => (recent || []).map(id => list.find(t => t.id === id)).filter(Boolean);

  // ---------------- 变量 {{变量名}} ----------------
  const VAR_RE = /\{\{\s*([^{}\n]{1,30}?)\s*\}\}/g;
  function variables(content) { const out = []; String(content || '').replace(VAR_RE, (m, n) => { if (out.indexOf(n) < 0) out.push(n); return m; }); return out; }
  /** 用填写的值替换变量；没填的保留原样，便于用户之后在系统提示词里手动修改 */
  function fill(content, values) {
    values = values || {};
    return String(content || '').replace(VAR_RE, (m, n) => (values[n] != null && String(values[n]).trim() !== '' ? String(values[n]).trim() : m));
  }

  // ---------------- 导入 / 导出 ----------------
  const FORMAT = 'ai-chat-templates';
  function exportJSON(list) {
    return JSON.stringify({ format: FORMAT, version: 1, templates: list.map(t => ({ name: t.name, emoji: t.emoji, content: t.content, tags: t.tags, pinned: t.pinned })) }, null, 2);
  }
  /** 导入：接受本应用导出的格式，或模板数组；名称和内容都相同的跳过；导入的模板一律作为新的自定义模板 */
  function importJSON(text, list) {
    let data;
    try { data = JSON.parse(String(text || '').replace(/^\uFEFF/, '')); } catch (e) { throw new Error('不是有效的 JSON'); }
    const arr = Array.isArray(data) ? data : data && Array.isArray(data.templates) ? data.templates : null;
    if (!arr) throw new Error('没有找到模板列表（需要 {"templates": [...]} 或数组）');
    let out = list.slice(); let added = 0, skipped = 0;
    arr.forEach(x => {
      if (!x || typeof x !== 'object' || !String(x.content || x.systemPrompt || x.prompt || '').trim()) { skipped++; return; }
      const n = normalizeTemplate({ name: x.name || x.title, emoji: x.emoji, content: x.content || x.systemPrompt || x.prompt, tags: x.tags, pinned: x.pinned });
      if (out.some(t => t.name === n.name && t.content === n.content)) { skipped++; return; }
      out.push(n); added++;
    });
    return { list: out, added, skipped };
  }

  /** 助手也可以当模板套用（只替换系统提示词，不改模型和温度） */
  function fromPersona(p) { return normalizeTemplate({ id: 'persona:' + p.id, name: p.name, emoji: p.emoji, content: p.systemPrompt, tags: ['助手'] }); }

  /** 把模板应用到对话：返回新的系统提示词与标记（不修改传入对象） */
  function applyToConv(conv, tpl, values) {
    if (!tpl) return { systemPrompt: '', templateId: null, templateName: null, templateEmoji: null };
    return { systemPrompt: fill(tpl.content, values), templateId: tpl.id, templateName: tpl.name, templateEmoji: tpl.emoji || '' };
  }

  const api = { BUILTIN_TEMPLATES, normalizeTemplate, defaultTemplates, mergeBuiltins, upsert, duplicate, remove, move, togglePin, allTags, filter,
    pushRecent, recentOf, variables, fill, exportJSON, importJSON, fromPersona, applyToConv, FORMAT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Templates = api;
})(typeof window !== 'undefined' ? window : globalThis);
