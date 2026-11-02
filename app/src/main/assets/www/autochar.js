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
  /** 对话里已经有角色卡：分层设定的角色块有内容，或系统提示词里已填了角色设定 / 角色卡段 */
  function hasCharacter(conv) {
    const st = conv && conv.plugins && conv.plugins.rpcache && conv.plugins.rpcache.state;
    if (st && (st.blocks || []).some(b => b && b.id === 'character' && String(b.content || '').trim())) return true;
    const sp = String((conv && conv.systemPrompt) || '');
    return /^\s*-\s*设定：\s*\S/m.test(sp) || /【角色卡】\s*\n\s*[^\s【]/.test(sp) || !!(conv && conv.autoChar && conv.autoChar.status === 'done');
  }
  /** 是否在这次发送前询问：首条用户消息 + RP 模板 + 尚无角色卡 + 本对话没问过 */
  function shouldOffer(conv, templates, settings) {
    if (!conv || (settings && settings.autoCharGen === false)) return false;
    if (conv.autoChar && conv.autoChar.asked) return false;
    const us = (conv.messages || []).filter(m => m.role === 'user' && !m.error && !m.imageGen);
    if (us.length !== 1 || !String(us[0].content || '').trim()) return false;
    return isRpTemplate(conv, templates) && !hasCharacter(conv);
  }
  const FORMAT = '【世界观】\n【角色卡】\n【RP规则】\n【输出格式】\n【示例对白】\n【禁止事项】\n【写作风格】\n【开场白】';
  /** 生成提示词：优先复用「角色卡 Skill」模板内容（同一套字段约束），否则用内置简版 */
  function buildPrompt(firstText, systemPrompt, skillContent) {
    const rules = skillContent && String(skillContent).trim() ? String(skillContent).trim()
      : '你是角色卡生成器。把用户的想法整理成可直接角色扮演的完整设定，信息不足时合理补全，角色卡写具体可扮演的细节（姓名、年龄性别、外貌、身份、背景经历、性格优缺点、说话方式、喜好禁忌、秘密、人物关系、与用户的关系、目标动机）。';
    return rules + '\n\n---\n下面是一场角色扮演的设定上下文，请据此直接输出完整 8 段设定（标题字面完全一致，段内用「- 」列表；不要寒暄、不要解释、不要提问）：\n' + FORMAT +
      (systemPrompt ? '\n\n【当前 RP 模板（系统提示词，供参考，保持一致）】\n' + String(systemPrompt).slice(0, 6000) : '') +
      '\n\n【用户首条消息】\n' + String(firstText || '').slice(0, 6000);
  }
  /** 解析模型输出 → { world, character, …, opening }；必须含角色卡段 */
  function parse(raw) {
    const r = R(); const f = r && r.parseSections ? r.parseSections(raw) : null;
    return f && f.character ? f : null;
  }
  const TITLES = { world: '世界观', character: '角色卡', rules: 'RP规则', format: '输出格式', fewshot: '示例对白', prohibit: '禁止事项', style: '写作风格' };
  /** RP 插件不生效时：拼成追加到系统提示词的文本 */
  function toPromptAppend(fields) {
    return '\n\n=== 自动生成的角色卡 ===\n' + Object.keys(TITLES).filter(k => fields[k]).map(k => '【' + TITLES[k] + '】\n' + fields[k]).join('\n\n');
  }
  function charName(fields) {
    const m = String(fields && fields.character || '').match(/姓名\s*[：:]\s*([^\n，,（(]{1,20})/);
    return m ? m[1].trim() : '';
  }
  const api = { RP_TEMPLATE_IDS, isRpTemplate, hasCharacter, shouldOffer, buildPrompt, parse, toPromptAppend, charName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.AutoChar = api;
})(typeof window !== 'undefined' ? window : globalThis);
