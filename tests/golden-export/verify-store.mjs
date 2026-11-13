// 用法：node tests/golden-export/verify-store.mjs <storeDir> <kotlinDump.json>（StoreDump.dump 的输出）。退出码 0 = 一致
// JS 参考实现读同一份 store（v0.28.7 原样 / 原生迁移后），与 Kotlin 仓库 dump 逐项比对
import fs from 'node:fs'; import path from 'node:path';
import { loadWww } from './lib.mjs';
const [storeDir, dumpFile] = process.argv.slice(2);
const CL = loadWww('conv-log.js'), Personas = loadWww('personas.js'), Templates = loadWww('templates.js');
const files = {}; fs.readdirSync(storeDir).forEach(f => { files[f] = fs.readFileSync(path.join(storeDir, f), 'utf8'); });
const dump = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
const canon = v => Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined && v[k] !== null).map(k => [k, canon(v[k])])) : v;
const diffs = [];
function same(a, b, p) {
  a = canon(a); b = canon(b);
  const walk = (x, y, q) => {
    if (typeof x === 'number' && typeof y === 'number') { if (x !== y && Math.abs(x - y) > 1e-9 * Math.max(Math.abs(x), Math.abs(y))) diffs.push(q + ': ' + x + ' ≠ ' + y); return; }
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) diffs.push(q + ': len ' + x.length + '≠' + y.length); for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], q + '[' + i + ']'); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object') { new Set([...Object.keys(x), ...Object.keys(y)]).forEach(k => walk(x[k], y[k], q + '.' + k)); return; }
    if (x !== y) diffs.push(q + ': JS=' + JSON.stringify(x)?.slice(0, 80) + ' K=' + JSON.stringify(y)?.slice(0, 80));
  };
  walk(a, b, p);
}
const st = CL.memStore(files); CL.clearSessions();
const js = (f, d) => files[f] ? JSON.parse(files[f]) : d;
const index = js('convs.json', []);
same(index, dump.index, 'index');
let n = 0, msgs = 0;
index.forEach(m => { const c = CL.load(st, m.id); n++; msgs += (c.messages || []).length; same(c, dump.convs[m.id], 'conv[' + m.id + ']'); });
const settings = js('settings.json', {});
same(settings, dump.settings, 'settings');
same(Personas.mergeBuiltins(js('personas.json', Personas.defaultPersonas()), settings.removedPersonas || []), dump.personas, 'personas');
same(js('prompts.json', Personas.defaultPrompts()), dump.prompts, 'prompts');
same(Templates.mergeBuiltins(js('templates.json', Templates.defaultTemplates ? Templates.defaultTemplates() : []), settings.removedTemplates || []), dump.templates, 'templates');
same(js('worlds.json', []), dump.worlds, 'worlds');
Object.keys(files).filter(f => /^knowledge_world_.+\.json$/.test(f)).forEach(f => same(JSON.parse(files[f]), dump.knowledge[f.slice(16, -5)], f));
const seen = new Set(); const log = (files['usage-stats.jsonl'] || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && e.key && !seen.has(e.key) && seen.add(e.key));
same(log.length, dump.usage.count, 'usage.count'); same(js('usage-stats-meta.json', {}), dump.usage.meta, 'usage.meta');
console.log(JSON.stringify({ store: storeDir, convs: n, messages: msgs, usage: log.length, personas: dump.personas.length, templates: dump.templates.length, worlds: dump.worlds.length, knowledge: Object.keys(dump.knowledge).length, keys: dump.keys, diffs: diffs.length }, null, 1));
diffs.slice(0, 40).forEach(d => console.log('  DIFF ' + d));
process.exit(diffs.length ? 1 : 0);
