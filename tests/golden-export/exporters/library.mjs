// personas.js / templates.js：内置数据导出（→ app/src/main/resources/aichat/builtins.json）+ mergeBuiltins golden
import fs from 'node:fs';
import path from 'node:path';
import { loadWww, ROOT, rng } from '../lib.mjs';

export const BUILTINS = path.join(ROOT, 'app/src/main/resources/aichat/builtins.json');

export function builtinsJson() {
  const P = loadWww('personas.js'), T = loadWww('templates.js');
  const src = fs.readFileSync(path.join(ROOT, 'app/src/main/assets/www/templates.js'), 'utf8');
  // OLD_BUILTIN_CONTENT 未导出：在沙箱里取出字面量
  const m = /const OLD_BUILTIN_CONTENT = (\{[\s\S]*?\n  \});/.exec(src);
  const old = m ? Function('return ' + m[1])() : {};
  return JSON.stringify({ personas: P.defaultPersonas(), prompts: P.defaultPrompts(), templates: T.defaultTemplates(),
    oldTemplateContent: old, retiredTemplates: T.RETIRED_BUILTINS }, null, 1) + '\n';
}

export default function (g) {
  const P = loadWww('personas.js'), T = loadWww('templates.js');
  g.extraFiles = g.extraFiles || [];
  g.extraFiles.push([BUILTINS, builtinsJson()]);
  const r = rng(77);
  const bt = T.defaultTemplates();
  for (let s = 0; s < 12; s++) {
    // 模板：用户列表 = 部分内置（有的改过）+ 自定义 + 退役 id
    const list = bt.filter(() => r.chance(0.6)).map(t => r.chance(0.3) ? Object.assign({}, t, { content: t.content + '（改）' }) : t);
    list.push({ id: 't-user-' + s, name: '我的', emoji: '', content: 'x', tags: ['a'], pinned: false, builtin: false, skill: false });
    if (r.chance(0.5)) list.push({ id: 't-rp-narrator', name: '旧', emoji: '', content: r.chance(0.5) ? 'custom' : 'zz', tags: [], pinned: false, builtin: true, skill: false });
    const removed = bt.filter(() => r.chance(0.2)).map(t => t.id);
    const norm = list.map(T.normalizeTemplate);
    g.add('mergeTemplates', [norm, removed], T.mergeBuiltins(norm, removed));
    const pl = P.defaultPersonas().filter(() => r.chance(0.5)).concat([{ id: 'p-u' + s, emoji: '🤖', name: 'u', desc: '', systemPrompt: '', providerId: '', model: '', temperature: '', builtin: false }]);
    const prem = P.BUILTIN_PERSONAS.filter(() => r.chance(0.3)).map(p => p.id);
    g.add('mergePersonas', [pl, prem], P.mergeBuiltins(pl, prem));
  }
}
