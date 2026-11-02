/* v0.8.1：RP 模板首条消息 → 确认后自动生成角色卡（移植自 fork ai-chat v4.1.2 plugins/rp_basic/autoGenerateCharacter.js）
 * fork 用 runSchemaRole + character.schema.json5 生成 st|char；本应用没有该依赖，改用「角色卡 Skill」同一套 8 段格式提示词约束输出，
 * 再用 RPCache.parseSections 解析 → 写入本对话的分层设定（= 绑定到本对话的角色卡）；RP 插件对本对话不生效时，追加到本对话系统提示词。
 * 纯逻辑放这里（可在 node 测试），界面与调用在 app.js。依赖 rpcache.js（可选）。 */
(function (root) {
  'use strict';
  const RP_TEMPLATE_IDS = ['t-rp-immersive', 't-rp-narrator', 't-rp-longform'];
  const SKIP_IDS = ['t-rp-cardgen'];
  const R = () => root.RPCache || (typeof require === 'function' ? require('./rpcache.js') : null);

  /** 当前对话套用的是不是 RP 模板（内置三套，或标签含「角色扮演」的自定义模板；角色卡 Skill 本身除外） */
  function isRpTemplate(conv, templates) {
    const id = conv && conv.templateId; if (!id || SKIP_IDS.indexOf(id) >= 0) return false;
    if (RP_TEMPLATE_IDS.indexOf(id) >= 0) return true;
    const t = (templates || []).find(x => x.id === id);
    return !!(t && !t.skill && (t.tags || []).some(g => /角色扮演|RP/i.test(g)));
  }
  /** 对话里已经有角色卡：分层设定的角色块有内容，或系统提示词里已填了角色设定 / 角色卡段（三套内置 RP 模板的填写位置各不相同） */
  function hasCharacter(conv) {
    const st = conv && conv.plugins && conv.plugins.rpcache && conv.plugins.rpcache.state;
    if (st && (st.blocks || []).some(b => b && b.id === 'character' && String(b.content || '').trim())) return true;
    if (conv && conv.autoChar && conv.autoChar.status === 'done') return true;
    const sp = String((conv && conv.systemPrompt) || '');
    const filled = v => v && !/\{\{/.test(v) && v.trim().length >= 2;
    let m;
    if (/^\s*-\s*设定：\s*[^\s{]/m.test(sp)) return true;                                   // 沉浸式：- 设定：xxx
    if (/【角色卡】\s*\n\s*[^\s【]/.test(sp)) return true;                                    // 已追加的角色卡段
    if ((m = sp.match(/【主要角色】\s*\n([^\n]+)/)) && /[：:]\s*[^\s{]/.test(m[1]) && filled(m[1].split(/[：:]/).slice(1).join(':'))) return true; // 叙事：名字：设定
    if ((m = sp.match(/主要角色[：:]\s*([^\n]+)/)) && /——\s*[^\s{]/.test(m[1])) return true;  // 长篇：主要角色：名字——设定
    if ((m = sp.match(/【(?:角色设定|人物设定|人设)】\s*\n([^\n【]+)/)) && filled(m[1])) return true;
    return false;
  }
  /** 设置：autoCharMode = auto（v0.8.4 起默认，直接生成）| ask（先询问）| off；兼容旧 autoCharGen=false */
  function mode(settings) {
    if (!settings) return 'auto';
    if (settings.autoCharGen === false) return 'off';
    return ['ask', 'auto', 'off'].indexOf(settings.autoCharMode) >= 0 ? settings.autoCharMode : 'auto';
  }
  /** 是否在这次发送前询问 / 生成：首条用户消息 + RP 模板 + 尚无角色卡 + 本对话没问过 */
  function shouldOffer(conv, templates, settings) {
    if (!conv || mode(settings) === 'off') return false;
    if (conv.autoChar && conv.autoChar.asked) return false;
    const us = (conv.messages || []).filter(m => m.role === 'user' && !m.error && !m.imageGen);
    if (us.length !== 1 || !String(us[0].content || '').trim()) return false;
    if ((conv.messages || []).some(m => m.role === 'assistant' && !m.error && String(m.content || '').trim())) return false; // 已有助手回复（如导入的开场白）
    return isRpTemplate(conv, templates) && !hasCharacter(conv);
  }
  /** 首条消息本身就是分段角色卡（用户贴了现成设定）→ 直接用，不再调用模型 */
  function fromUserText(text) { const f = parse(text); return f && f.character ? f : null; }
  const FORMAT = '【世界观】\n【角色卡】\n【RP规则】\n【输出格式】\n【示例对白】\n【禁止事项】\n【写作风格】\n【开场白】';
  /** 生成提示词：优先复用「角色卡 Skill」模板内容（同一套字段约束），否则用内置简版 */
  function buildPrompt(firstText, systemPrompt, skillContent) {
    const rules = skillContent && String(skillContent).trim() ? String(skillContent).trim()
      : '你是角色卡生成器。把用户的想法整理成可直接角色扮演的完整设定，信息不足时合理补全，角色卡写具体可扮演的细节（姓名、年龄性别、外貌、身份、背景经历、性格优缺点、说话方式、喜好禁忌、秘密、人物关系、与用户的关系、目标动机）。';
    const story = '\n6. 一次到位：【世界观】除了时代、地点、势力与规则，还要写「- 主线剧情：」（核心冲突、阶段走向、伏笔）和「- 当前局势：」（故事从哪里开始）；【角色卡】写主角之外再列出 2–4 个重要配角 / NPC（姓名、身份、与主角关系、动机）；【RP规则】写明用户扮演的身份；所有内容写成成品，不留任何 {{变量}}、「待定」或需要用户填写的空位。';
    return rules + '\n\n---\n下面是一场角色扮演的设定上下文，请据此直接输出完整 8 段设定。\n硬性要求：\n1. 每段以单独一行的【标题】开头，标题字面与下列完全一致，按顺序输出，不要加序号、不要用 Markdown 标题或代码块；\n2. 段内用「- 」列表；【角色卡】第一行写「- 姓名：xxx」；\n3. 用户首条消息里已经给出的名字、身份、关系、场景必须原样保留，只补全缺失部分，不要改写用户的设定；\n4. 【开场白】写一段符合当前 RP 模板文风、以角色口吻展开的开场；\n5. 不要寒暄、不要解释、不要提问，直接从【世界观】开始输出。' + story + '\n' + FORMAT +
      (systemPrompt ? '\n\n【当前 RP 模板（系统提示词，供参考，保持一致）】\n' + String(systemPrompt).slice(0, 6000) : '') +
      '\n\n【用户首条消息】\n' + String(firstText || '').slice(0, 6000);
  }
  const HEAD_WORDS = '世界观|世界背景|背景设定|世界设定|角色卡|角色设定|人物设定|RP ?规则|扮演规则|规则|输出格式|回复格式|示例对白|示例对话|对白示例|禁止事项|写作风格|文风|开场白|开场';
  /** 把模型常见的“变体标题”统一成【标题】：`1. 世界观`、`一、角色卡`、`**角色卡**`、`[角色卡]`、`角色卡：`、`### 【角色卡】` 等；去掉思考块和代码围栏 */
  const PLOT_HEAD = /^\s{0,3}(?:#{1,4}\s*)?(?:\*\*)?\s*[【\[［]\s*(?:主线)?(?:剧情|剧情大纲|故事大纲|主线|故事线)\s*[】\]］]\s*(?:\*\*)?\s*$/;
  function normalize(raw) {
    let t = String(raw || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');
    t = t.replace(/\r\n?/g, '\n').replace(/^\s*```[a-z0-9]*\s*$/gim, '');
    const re = new RegExp('^\\s{0,3}(?:#{1,4}\\s*)?(?:(?:\\d{1,2}|[一二三四五六七八九十]{1,2})\\s*[.、)）．]\\s*)?(?:\\*\\*|__)?\\s*[【\\[［〔]?\\s*(' + HEAD_WORDS + ')\\s*[】\\]］〕]?\\s*(?:\\*\\*|__)?\\s*(?:[：:]\\s*(?:\\*\\*)?)?\\s*(.*)$', 'i');
    // 【剧情】段没有单独的分层块：并入【世界观】（parseSections 会把重名段拼接）
    t = t.split('\n').map(line => (PLOT_HEAD.test(line) ? '【世界观】\n- 主线剧情：' : line)).join('\n');
    return t.split('\n').map(line => {
      const m = line.match(re); if (!m) return line;
      const rest = (m[2] || '').replace(/^\*\*\s*/, '');
      // 「规则：不许 OOC」这种正文行也会匹配：只有标题带括号 / 加粗 / # / 序号，或行尾无正文时才当标题
      const marked = /[【\[［〔#]|\*\*|__|^\s*(?:\d|[一二三四五六七八九十])/.test(line.slice(0, line.indexOf(m[1]) + 1));
      if (!marked && rest) return line;
      return '【' + m[1].replace(/\s+/g, ' ') + '】' + (rest ? ' ' + rest : '');
    }).join('\n').trim();
  }
  /** 解析模型输出 → { world, character, …, opening }；必须含角色卡段。容错：标题变体、思考块、只有角色卡一段 */
  function parse(raw) {
    const r = R(); if (!r || !r.parseSections) return null;
    const t = normalize(raw);
    let f = r.parseSections(t);
    if (!f) { // parseSections 至少要 2 段；只有【角色卡】一段时也接受
      const m = t.match(/【(?:角色卡|角色设定|人物设定)】([\s\S]*?)(?=\n\s*【|$)/);
      if (m && m[1].trim().length >= 20) f = { character: m[1].trim() };
    }
    if (!f || !f.character) {
      // 没有任何标题，但整段明显是人物介绍（含姓名 / 性格等）→ 整段当角色卡
      const plain = t.replace(/^【[^】]*】.*$/gm, '').trim();
      if (!/【/.test(t) && plain.length >= 40 && /(姓名|名字)[：:]/.test(plain) && /(性格|外貌|身份|背景)/.test(plain)) return { character: plain };
      return null;
    }
    return f;
  }
  const TITLES = { world: '世界观', character: '角色卡', rules: 'RP规则', format: '输出格式', fewshot: '示例对白', prohibit: '禁止事项', style: '写作风格' };
  /** RP 插件不生效时：拼成追加到系统提示词的文本 */
  function toPromptAppend(fields) {
    return '\n\n=== 自动生成的角色卡 ===\n' + Object.keys(TITLES).filter(k => fields[k]).map(k => '【' + TITLES[k] + '】\n' + fields[k]).join('\n\n');
  }
  function charName(fields) {
    const c = String(fields && fields.character || '').replace(/\*\*|__/g, '');
    const m = c.match(/(?:姓名|名字|角色名|名称)\s*[：:]\s*([^\n，,（(、；;/|]{1,20})/);
    return m ? m[1].trim().replace(/[。.\s]+$/, '') : '';
  }
  /** 生成后清理系统提示词里没填的 {{变量}}：{{角色名}} → 角色名，{{用户名}} → 你；整行只剩空变量的行删掉，其余空变量去掉 */
  function fillLeftovers(sp, fields) {
    const name = charName(fields);
    let t = String(sp || '');
    if (name) t = t.replace(/\{\{\s*(?:角色名|角色|char)\s*\}\}/gi, name);
    t = t.replace(/\{\{\s*(?:用户名|用户|user)\s*\}\}/gi, '你');
    t = t.split('\n').filter(l => !/^\s*(?:-\s*)?(?:[^{}\n：:]{1,16}[：:]\s*)?\{\{[^{}]*\}\}\s*$/.test(l)).join('\n');
    t = t.replace(/\{\{\s*[^{}|]+\|([^{}]+)\}\}/g, '$1').replace(/\{\{[^{}]*\}\}/g, '');
    // 删完变空的【分段】标题
    const lines = t.split('\n'); const isHead = l => /^【[^】]+】\s*$/.test(l);
    t = lines.filter((l, i) => { if (!isHead(l)) return true; for (let j = i + 1; j < lines.length; j++) { if (isHead(lines[j])) return false; if (lines[j].trim()) return true; } return false; }).join('\n');
    return t.replace(/\n{3,}/g, '\n\n');
  }
  const api = { RP_TEMPLATE_IDS, isRpTemplate, hasCharacter, mode, shouldOffer, fromUserText, buildPrompt, normalize, parse, toPromptAppend, charName, fillLeftovers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AutoChar = api;
})(typeof window !== 'undefined' ? window : globalThis);
