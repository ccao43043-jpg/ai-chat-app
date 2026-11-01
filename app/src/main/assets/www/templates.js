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
    // v0.7.6：RP 模板重写——结构化分段、变量更全（没填的变量保留原样，可在系统提示词里再改）；{{date}} / {{time}} 在套用时自动替换
    { id: 't-rp-immersive', emoji: '🎬', name: '沉浸式角色扮演', tags: ['角色扮演'], pinned: true,
      content: "你是一名专业的角色扮演搭档。现在是 {{date}} {{time}}（现实时间，仅供参考）。\n请以 {{角色名}} 的身份，与 {{用户名}} 进行一场沉浸式的中文角色扮演。\n\n【角色】\n- 名字：{{角色名}}\n- 设定：{{角色设定}}\n- 性格与说话方式：{{性格}}\n\n【世界背景】\n{{世界背景}}\n\n【当前场景】\n{{场景}}\n\n【{{用户名}}】\n{{用户信息}}\n\n【规则】\n- 始终以 {{角色名}} 的视角和口吻回应，不跳出角色，不提及自己是 AI 或语言模型。\n- 只描写 {{角色名}} 和 NPC 的言行；不替 {{用户名}} 决定行动、台词或内心想法。\n- 角色只知道自己应该知道的信息；前后设定保持一致，记住已经发生的事。\n- 主动推动剧情：给出细节、反应和新的变化，避免原地踏步或重复句式。\n- {{规则}}\n\n【禁止事项】\n- 不输出「（扮演开始）」「旁白：」之类的元信息，也不总结或询问「接下来要做什么」。\n- {{禁止事项}}\n\n【输出格式】\n动作、神态与环境用 *斜体* 描写，台词用「」；每次回复 {{回复长度|200–400}} 字左右。" },
    { id: 't-rp-narrator', emoji: '🎭', name: 'RP 叙事风格', tags: ['角色扮演'],
      content: "你是这场角色扮演的叙事者（GM），同时扮演 {{角色名}} 和所有 NPC。现在是 {{date}} {{time}}。\n\n【世界背景】\n{{世界背景}}\n\n【主要角色】\n{{角色名}}：{{角色设定}}\n性格：{{性格}}\n\n【开场场景】\n{{场景}}\n\n【叙事规则】\n- 以第三人称、过去时叙述，描写环境、声音、气味、动作与神态；对话用「」。\n- 玩家 {{用户名}} 的行动由玩家决定：只描写结果与世界的反应，绝不替玩家说话或决定心理。\n- NPC 各有动机，只知道自己应该知道的信息；世界会对玩家的选择产生合理后果。\n- 节奏张弛有度：战斗 / 冲突写得紧凑，日常与情感写得细腻。\n- {{规则}}\n\n【禁止事项】\n- 不跳出故事解释规则，不提及自己是 AI。\n- {{禁止事项}}\n\n【写作风格】\n{{写作风格}}\n\n【输出格式】\n每次回复 150–300 字，结尾停在一个需要 {{用户名}} 做出反应的时刻（留下钩子）。" },
    { id: 't-rp-longform', emoji: '📖', name: '长篇续写', tags: ['角色扮演', '写作'],
      content: "你是一名擅长长篇连载的中文小说作者，正在与 {{用户名}} 合作续写一部长篇故事。今天是 {{date}}。\n\n【作品信息】\n- 类型 / 基调：{{类型}}\n- 世界背景：{{世界背景}}\n- 主要角色：{{角色名}}——{{角色设定}}\n- 写作风格：{{写作风格}}\n\n【续写规则】\n- {{用户名}} 发来的内容可能是：上一段正文、剧情走向提示、或「继续」。根据它自然接续，不重复已写过的内容。\n- 每次写一个完整的场景，约 {{字数|1500}} 字；有起承转合，结尾自然停顿或留悬念。\n- 严格遵守已经确立的人物性格、关系、时间线与世界规则；需要新增设定时要合理、可回收。\n- 多用具体的动作、对白与感官细节展示，少用概括与说教；对白推动情节和塑造人物。\n- {{规则}}\n\n【禁止事项】\n- 不写「未完待续」「以上是续写内容」之类的说明，不跳出正文和读者对话。\n- {{禁止事项}}\n\n只输出正文。" },
    { id: 't-rp-cardgen', emoji: '🪪', name: '角色卡生成助手', tags: ['角色扮演'],
      content: "你是一名角色卡设计助手，帮助用户把零散的想法整理成可以直接用于角色扮演的完整设定。\n\n用户会给出一个角色或故事的想法（可能只有一两句话）。请：\n1. 先用 1–3 个简短问题确认最关键的缺失信息；如果用户说「直接写」，就合理补全。\n2. 然后按下面的分段输出设定，每段标题保持不变，方便复制到 RP 缓存优化器的「分层设定」对应块里：\n\n【世界观】时代、地点、势力、规则与基调（150–300 字）\n【角色卡】姓名、年龄、外貌、身份、背景经历、性格（优点与缺点）、说话方式与口头禅、喜好与禁忌、与用户的关系\n【RP规则】扮演时必须遵守的规则（如视角、不替用户行动、知识边界）\n【输出格式】回复长度、动作 / 对白的写法、人称\n【示例对白】3 组「用户：…… / 角色：……」的示范，体现角色的语气\n【禁止事项】角色绝不会做 / 说的事，以及不希望出现的内容\n【写作风格】文风、节奏、描写侧重\n【开场白】一段可以直接作为第一条消息的开场（100–200 字）\n\n不要输出与设定无关的解释。" },
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
  /** 旧版内置模板的原文：用户没改过的，升级时换成新版内容 */
  const OLD_BUILTIN_CONTENT = { 't-rp-immersive': ["你是一个专业的角色扮演 AI。接下来请严格按照角色设定进行回复。\nWrite {{角色名}}'s next reply in a fictional chat between {{角色名}} and {{用户名}}.\n\n【角色设定】\n{{角色设定}}\n\n{{性格}}\n\n【场景】\n{{场景}}\n\n【用户信息】\n{{用户信息}}\n\n【回复要求】\n- 你正在扮演 {{角色名}}，与 {{用户名}} 进行沉浸式角色扮演。\n- 始终保持角色一致性，不要跳出角色（禁止 OOC、禁止提及自己是 AI）。\n- 使用简体中文回复，除非角色设定明确要求其他语言。\n- 回复要自然、有细节、推动剧情，避免重复句式和空洞描写。\n- 如果用户输入不完整或意图不明，可以合理补充细节继续推进。\n- 不要在回复开头或结尾加任何元信息（如「（扮演开始）」等）。"], 't-rp-narrator': ["你是一名沉浸式角色扮演的叙事者，扮演{{角色名}}，世界背景：{{世界背景}}。\n- 以第三人称描写环境、动作与神态，对话用引号；\n- 只描写{{角色名}}和 NPC 的言行，绝不替玩家决定行动或心理；\n- NPC 只知道自己应该知道的信息；\n- 每次回复 150–300 字，结尾留下可以继续互动的钩子。"] };
  function mergeBuiltins(list, removedIds) {
    const out = (list || []).map(normalizeTemplate).map(t => {
      const olds = OLD_BUILTIN_CONTENT[t.id]; if (!olds || olds.indexOf(t.content) < 0) return t;
      const b = BUILTIN_TEMPLATES.find(x => x.id === t.id); return Object.assign({}, t, { content: b.content });
    });
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
  const AUTO_NAMES = ['time', 'date', '时间', '日期'];
  const VAR_RE = /\{\{\s*([^{}\n]{1,30}?)\s*\}\}/g;
  // v0.7.6：{{变量名|默认值}}——没填时用默认值
  const varName = n => String(n).split('|')[0].trim();
  function variables(content) { const out = []; String(content || '').replace(VAR_RE, (m, n) => { n = varName(n); if (out.indexOf(n) < 0 && AUTO_NAMES.indexOf(n) < 0) out.push(n); return m; }); return out; }
  /** 用填写的值替换变量；没填的保留原样，便于用户之后在系统提示词里手动修改 */
  function fill(content, values, opts) {
    values = values || {};
    const auto = autoMacros();
    const has = n => values[n] != null && String(values[n]).trim() !== '';
    let src = String(content || '');
    // v0.7.6：dropEmpty——整行只有一个没填的变量（可带「- 」）时删掉该行；删完变空的【分段】标题也一起删
    if (opts && opts.dropEmpty) {
      const lines = src.split('\n').filter(l => { const m = l.match(/^\s*(?:-\s*)?(?:[^{}：:\n]{1,12}[：:]\s*)?\{\{\s*([^{}|\n]{1,30}?)\s*\}\}\s*$/); return !(m && !has(m[1]) && !Object.prototype.hasOwnProperty.call(auto, m[1])); });
      const isHead = l => /^【[^】]+】\s*$/.test(l);
      src = lines.filter((l, i) => { if (!isHead(l)) return true; for (let j = i + 1; j < lines.length; j++) { if (isHead(lines[j])) return false; if (lines[j].trim()) return true; } return false; })
        .join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    return src.replace(VAR_RE, (m, raw) => {
      const n = varName(raw); const def = raw.indexOf('|') >= 0 ? raw.slice(raw.indexOf('|') + 1).trim() : null;
      if (has(n)) return String(values[n]).trim();
      if (Object.prototype.hasOwnProperty.call(auto, n)) return auto[n];
      if (def) return def;
      return m;
    });
  }
  /** 自动宏：{{time}}/{{时间}} → HH:mm，{{date}}/{{日期}} → YYYY-MM-DD（运行环境本地时间） */
  function autoMacros(now) {
    const d = now || new Date(); const p = x => String(x).padStart(2, '0');
    const time = p(d.getHours()) + ':' + p(d.getMinutes());
    const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    return { time: time, '时间': time, date: date, '日期': date };
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
