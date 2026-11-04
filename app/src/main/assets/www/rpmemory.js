/* 结构化记忆（v0.11.0）：每 N 轮自动调用模型从最近对话中提取事实 / 事件 / 关系 / 细节，
 * 存成可编辑条目（按角色卡隔离，本地持久化 rp-memory.json），请求时只按关键词相关性注入少量条目。
 * 缓存友好：不改系统提示词 / L1–L3 前缀，只在最后一条用户消息末尾追加 [MEMORY_RECALL]（与 [STATE] / [MEMORY_UPDATE] 同属动态层）。
 * 提取失败只记录错误，不打断聊天。
 */
(function (root) {
  'use strict';
  const TYPES = ['fact', 'event', 'relation', 'detail'];
  const TYPE_CN = { fact: '事实', event: '事件', relation: '关系', detail: '细节' };
  const DEFAULTS = { interval: 20, window: 40, maxInject: 8, pinBudget: 8, minScore: 1, retrieval: 'bm25', memTokens: 600, tau: 20, mmrLambda: 0.7 };
  const FILE = 'rp-memory.json';

  const textOf = c => Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : String(c || '');
  const charKey = conv => conv && conv.personaId ? 'persona:' + conv.personaId : 'conv:' + (conv && conv.id);
  const norm = s => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  function appendToContent(c, add) {
    if (Array.isArray(c)) { const a = c.map(x => Object.assign({}, x)); a.push({ type: 'text', text: add }); return a; }
    return (c ? c + '\n\n' : '') + add;
  }
  function settingsOf(cfg) {
    const o = Object.assign({}, DEFAULTS, cfg || {});
    o.interval = Math.max(5, Math.min(200, o.interval | 0 || DEFAULTS.interval));
    o.maxInject = Math.max(0, Math.min(50, o.maxInject | 0));
    o.pinBudget = Math.max(0, Math.min(50, o.pinBudget != null ? o.pinBudget | 0 : DEFAULTS.pinBudget));
    o.retrieval = o.retrieval === 'legacy' ? 'legacy' : 'bm25';
    o.memTokens = Math.max(0, Math.min(8000, o.memTokens != null ? o.memTokens | 0 : DEFAULTS.memTokens));
    o.window = Math.max(o.interval, Math.min(200, o.window | 0 || DEFAULTS.window));
    return o;
  }

  /** 统一关键词上限；合并与自动提取共用，避免 merge 再 slice 到 16 */
  const KW_MAX = 48;
  const KW_REL = /喜欢|讨厌|爱|恨|朋友|敌人|信任|结盟|决裂|敌对|合作|忠诚|背叛|已婚|未婚/;
  const KW_TIME = /今晚|当天|次日|曾经|现在|之后|之前|当时|目前|\d{1,2}月|\d{1,4}年|昨天|今天|明天/;
  const KW_OBJ = /账本|钥匙|信件|照片|剑|刀|戒指|地图|密道|卷轴|护符|盒子|文件|证据/;
  function kwPriority(k) {
    const s = String(k || '');
    if (KW_REL.test(s)) return 400 + s.length;
    if (KW_OBJ.test(s)) return 300 + s.length;
    if (KW_TIME.test(s)) return 200 + s.length;
    // 2–4 字实体词优先于碎片
    if (/^[\u4e00-\u9fff]{2,4}$/.test(s) || /^[A-Za-z][A-Za-z0-9_-]{2,}$/.test(s)) return 100 + s.length;
    return s.length;
  }
  function mergeKeywords(a, b) {
    const freq = new Map();
    [...(a || []), ...(b || [])].forEach(k => {
      const t = String(k || '').trim(); if (!t) return;
      freq.set(t, (freq.get(t) || 0) + 1);
    });
    return [...freq.entries()]
      .sort((x, y) => (y[1] - x[1]) || (kwPriority(y[0]) - kwPriority(x[0])) || y[0].length - x[0].length || x[0].localeCompare(y[0]))
      .map(e => e[0])
      .slice(0, KW_MAX);
  }
  /** 自动关键词：英文单词 + 中文词（不截断成长词的前 2 字；长段保留 2/3/4 字滑窗） */
  function autoKeywords(text) {
    const t = String(text || ''); const out = new Set();
    (t.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || []).forEach(w => out.add(w.toLowerCase()));
    (t.match(/[\u4e00-\u9fff]{2,}/g) || []).forEach(seg => {
      if (seg.length <= 4) { out.add(seg); return; }
      // 长中文段：保留完整 4 字前缀 + 2/3/4 字滑窗，避免只剩无意义的前两字
      out.add(seg.slice(0, 4));
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i <= seg.length - n; i++) out.add(seg.slice(i, i + n));
      }
    });
    // 按优先级排序后截到 KW_MAX（不再在 merge 时二次压到 16）
    return [...out].sort((a, b) => kwPriority(b) - kwPriority(a) || b.length - a.length || a.localeCompare(b)).slice(0, KW_MAX);
  }

  function buildExtractPrompt(turns, existing) {
    const conv = turns.map(m => (m.role === 'user' ? '用户' : '角色') + '：' + textOf(m.content).slice(0, 2000)).join('\n');
    const ex = (existing || []).slice(-40).map(e => '- [' + e.type + '] ' + e.text).join('\n');
    return '你是角色扮演对话的记忆整理器。从下面的最近对话中提取之后仍然重要的信息，输出 JSON 数组，不要输出其他内容。\n' +
      '每个元素：{"type":"fact|event|relation|detail","text":"一句话、第三人称、具体","keywords":["人名/地名/物品等 1-5 个"]}\n' +
      'fact=稳定事实（身份、设定、喜好）；event=发生的事件；relation=人物关系变化；detail=以后可能用到的细节（约定、物品、伏笔）。\n' +
      '只记录新的或有变化的信息；已有记忆里已经有的不要重复；最多 12 条；没有就输出 []。\n\n' +
      (ex ? '===== 已有记忆 =====\n' + ex + '\n\n' : '') + '===== 最近对话 =====\n' + conv;
  }

  /** 宽松解析模型输出：去代码块、截取第一个 JSON 数组 / 对象；也接受「- [类型] 文本」行格式 */
  function parseExtraction(raw) {
    let s = String(raw || '').replace(/```(?:json)?/gi, '').trim();
    let arr = null;
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) { try { arr = JSON.parse(s.slice(a, b + 1)); } catch (e) { arr = null; } }
    if (!arr) { try { const o = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); arr = o.items || o.memories || o.entries || null; } catch (e) { arr = null; } }
    if (!Array.isArray(arr)) {
      arr = s.split('\n').map(l => /^\s*[-*]\s*\[(\w+|[\u4e00-\u9fff]+)\]\s*(.+)$/.exec(l)).filter(Boolean).map(m => ({ type: m[1], text: m[2] }));
    }
    const rev = { 事实: 'fact', 事件: 'event', 关系: 'relation', 细节: 'detail' };
    return arr.filter(x => x && (typeof x === 'string' || x.text)).map(x => {
      if (typeof x === 'string') x = { text: x };
      let type = String(x.type || 'detail').toLowerCase(); type = rev[x.type] || type; if (!TYPES.includes(type)) type = 'detail';
      const text = String(x.text).trim().slice(0, 300);
      let kw = Array.isArray(x.keywords) ? x.keywords.map(k => String(k).trim()).filter(Boolean).slice(0, KW_MAX) : [];
      if (!kw.length) kw = autoKeywords(text);
      return { type, text, keywords: kw };
    }).filter(x => x.text);
  }

  function bigrams(s) { const n = norm(s), g = new Set(); for (let i = 0; i < n.length - 1; i++) g.add(n.slice(i, i + 2)); return g; }
  function similarity(a, b) {
    const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return norm(a) === norm(b) ? 1 : 0;
    let i = 0; A.forEach(x => { if (B.has(x)) i++; }); return i / Math.min(A.size, B.size);
  }
  /** 冲突对：极性相反的关系/状态；映射到关系族后，仅同 subject+object+族才冲突 */
  const CONFLICT_PAIRS = [
    ['喜欢', '讨厌'], ['爱', '恨'], ['朋友', '敌人'], ['信任', '不信任'], ['结盟', '决裂'],
    ['存活', '死亡'], ['活着', '死了'], ['同意', '反对'], ['敌对', '合作'], ['忠诚', '背叛'],
    ['在场', '缺席'], ['已婚', '未婚'], ['解锁', '上锁'],
  ];
  const REL_FAMILY = {
    '喜欢': 'affection', '讨厌': 'affection', '爱': 'affection', '恨': 'affection',
    '朋友': 'alliance', '敌人': 'alliance', '结盟': 'alliance', '决裂': 'alliance', '敌对': 'alliance', '合作': 'alliance',
    '信任': 'trust', '不信任': 'trust', '忠诚': 'trust', '背叛': 'trust',
    '存活': 'alive', '死亡': 'alive', '活着': 'alive', '死了': 'alive',
    '同意': 'agree', '反对': 'agree',
    '在场': 'presence', '缺席': 'presence',
    '已婚': 'marital', '未婚': 'marital',
    '解锁': 'lock', '上锁': 'lock',
  };
  const POLARITY = {
    '喜欢': 1, '爱': 1, '朋友': 1, '信任': 1, '结盟': 1, '合作': 1, '忠诚': 1,
    '存活': 1, '活着': 1, '同意': 1, '在场': 1, '已婚': 1, '解锁': 1,
    '讨厌': -1, '恨': -1, '敌人': -1, '不信任': -1, '决裂': -1, '敌对': -1, '背叛': -1,
    '死亡': -1, '死了': -1, '反对': -1, '缺席': -1, '未婚': -1, '上锁': -1,
  };
  /** 抽取关系三元组：subject + predicate + object + polarity/family */
  function extractRelationTriple(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const preds = Object.keys(REL_FAMILY).sort((a, b) => b.length - a.length);
    for (const pred of preds) {
      const i = s.indexOf(pred);
      if (i < 0) continue;
      let subject = s.slice(0, i).replace(/^[关于对与和]/, '').replace(/[的地得了着过]/g, '').trim();
      let object = s.slice(i + pred.length).replace(/^[了着过的]/, '').replace(/[。！？!.].*$/, '').trim();
      // 去掉主语/宾语两端标点与助词
      subject = subject.replace(/^[\s，,：:]+|[\s，,：:]+$/g, '');
      object = object.replace(/^[\s，,：:]+|[\s，,：:]+$/g, '');
      if (!subject || subject.length > 16) continue;
      if (!object) object = '_'; // 允许单目状态（存活/死亡）
      return {
        subject: norm(subject),
        object: norm(object),
        predicate: pred,
        family: REL_FAMILY[pred],
        polarity: POLARITY[pred] || 0,
        raw: s,
      };
    }
    return null;
  }
  function sameEntity(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    return (a.length >= 2 && b.length >= 2) && (a.includes(b) || b.includes(a));
  }
  function detectConflict(a, b) {
    const ta = extractRelationTriple(a);
    const tb = extractRelationTriple(b);
    if (ta && tb) {
      // 仅同 subject + object + 关系族且极性相反 → 冲突
      if (sameEntity(ta.subject, tb.subject) && sameEntity(ta.object, tb.object)
          && ta.family && ta.family === tb.family
          && ta.polarity && tb.polarity && ta.polarity !== tb.polarity) {
        return true;
      }
      return false; // 抽到三元组但不满足同主体/对象/族 → 明确不冲突
    }
    // 回退：否定冲突仍要求共享主体片段，避免「张燕…」「李明…」误伤
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    const neg = /不|没|并非|未|无/;
    if (neg.test(a) !== neg.test(b)) {
      const ca = na.replace(/不|没|并非|未|无/g, '');
      const cb = nb.replace(/不|没|并非|未|无/g, '');
      // 需要足够重叠且主体前缀相近
      const subA = ca.slice(0, 4), subB = cb.slice(0, 4);
      if (ca.length >= 2 && cb.length >= 2 && sameEntity(subA, subB)
          && (ca.includes(cb) || cb.includes(ca) || similarity(ca, cb) >= 0.85)) return true;
    }
    return false;
  }
  /**
   * 合并：冲突检测优先于相似度合并。
   * 冲突 → 旧条目标记 superseded（失效），新条作为新版本写入；不合并文本。
   * 同向相似 → 合并关键词/取更长文本。
   */
  function mergeEntries(list, incoming, at, src) {
    const out = (list || []).map(e => Object.assign({}, e)); let added = 0, merged = 0, superseded = 0, conflicts = 0;
    let seq = out.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    (incoming || []).forEach(n => {
      const nn = norm(n.text);
      // 先找冲突（同类型）
      const conflictHit = out.find(e => !e.disabled && !e.supersededBy && e.type === n.type && detectConflict(e.text, n.text));
      if (conflictHit) {
        seq++;
        const id = 'm' + seq + '_' + (at % 100000);
        conflictHit.supersededBy = id;
        conflictHit.supersededAt = at;
        conflictHit.disabled = true; // 失效标记：召回时跳过
        out.push({ id, seq, type: n.type, text: n.text, keywords: n.keywords || [], createdAt: at, updatedAt: at, source: src || 'auto', pinned: false, version: (conflictHit.version | 0) + 1, supersedes: conflictHit.id });
        added++; conflicts++; superseded++;
        return;
      }
      const hit = out.find(e => !e.supersededBy && e.type === n.type && (norm(e.text) === nn || norm(e.text).includes(nn) || nn.includes(norm(e.text)) || similarity(e.text, n.text) >= 0.8));
      if (hit) {
        if (n.text.length > hit.text.length && !hit.edited) hit.text = n.text;
        hit.keywords = mergeKeywords(hit.keywords, n.keywords);
        hit.updatedAt = at; merged++;
      } else {
        seq++; out.push({ id: 'm' + seq + '_' + (at % 100000), seq, type: n.type, text: n.text, keywords: n.keywords || [], createdAt: at, updatedAt: at, source: src || 'auto', pinned: false, version: 1 });
        added++;
      }
    });
    return { list: out, added, merged, conflicts, superseded };
  }

  // ---------------- §3 BM25F + 时间衰减 + MMR + mem_tokens ----------------
  const BM25 = { k1: 1.2, b: 0.75, w: { keywords: 3, text: 1, type: 0.5, entity: 2 }, openBoost: 1.25 };
  const FIELDS = ['keywords', 'text', 'type', 'entity'];
  /** term 切分：中文 bigram（单字段落保留单字），英文/数字 \w+ */
  function terms(s) {
    const out = [], str = String(s || '').toLowerCase();
    (str.match(/[a-z0-9_]+/g) || []).forEach(w => out.push(w));
    (str.match(/[\u4e00-\u9fff]+/g) || []).forEach(seg => {
      if (seg.length === 1) out.push(seg); else for (let i = 0; i < seg.length - 1; i++) out.push(seg.slice(i, i + 2));
    });
    return out;
  }
  function entitiesOf(e) {
    if (Array.isArray(e.entities)) return e.entities.join(' ');
    const t = extractRelationTriple(e.text); return t ? [t.subject, t.object === '_' ? '' : t.object].join(' ') : '';
  }
  function fieldTerms(e) {
    return { keywords: terms((e.keywords || []).join(' ')), text: terms(e.text), type: terms((TYPE_CN[e.type] || '') + ' ' + (e.type || '')), entity: terms(entitiesOf(e)) };
  }
  /** 会话级倒排：{ df, postings, len, avgLen, tf, N, sig }；按条目 id+updatedAt 签名增量判定是否重建 */
  function buildIndex(list, prev) {
    const sig = list.map(e => e.id + ':' + (e.updatedAt || 0)).join('|');
    if (prev && prev.sig === sig) return prev;
    const idx = { df: {}, postings: {}, len: {}, avgLen: {}, tf: {}, N: list.length, sig };
    const sum = { keywords: 0, text: 0, type: 0, entity: 0 };
    list.forEach(e => {
      const ft = fieldTerms(e), tf = {}, seen = new Set(); idx.len[e.id] = {};
      FIELDS.forEach(f => {
        idx.len[e.id][f] = ft[f].length; sum[f] += ft[f].length; tf[f] = {};
        ft[f].forEach(t => { tf[f][t] = (tf[f][t] || 0) + 1; seen.add(t); });
      });
      idx.tf[e.id] = tf;
      seen.forEach(t => { idx.df[t] = (idx.df[t] || 0) + 1; (idx.postings[t] = idx.postings[t] || []).push(e.id); });
    });
    FIELDS.forEach(f => { idx.avgLen[f] = list.length ? sum[f] / list.length || 1 : 1; });
    return idx;
  }
  const idf = (idx, t) => { const df = idx.df[t] || 0; return Math.log(1 + (idx.N - df + 0.5) / (df + 0.5)); };
  /** 带权查询 Q：Map term→权重 */
  function buildQuery(query, ext) {
    const Q = new Map(), add = (s, w) => { const ts = terms(s); ts.forEach(t => Q.set(t, (Q.get(t) || 0) + w)); };
    if (!ext) { add(query, 1); return Q; }
    add(query, 0.6); add(ext.context || '', 0.3); add((ext.pinnedKeywords || []).join(' '), 0.1);
    return Q;
  }
  function bm25f(idx, Q, e) {
    const tf = idx.tf[e.id]; if (!tf) return 0; let s = 0;
    Q.forEach((qw, t) => {
      if (!idx.df[t]) return; const i = idf(idx, t);
      FIELDS.forEach(f => {
        const n = tf[f][t]; if (!n) return;
        const L = idx.len[e.id][f] / idx.avgLen[f];
        s += qw * BM25.w[f] * i * (n * (BM25.k1 + 1)) / (n + BM25.k1 * (1 - BM25.b + BM25.b * L));
      });
    });
    return s;
  }
  const estTokens = e => Math.ceil(String(e.text || '').length * 0.7) + 6;
  /** 时间：Δturns 优先 e.turn/o.nowTurn；缺失时用 seq 差作近似 */
  function decay(e, o, maxSeq) {
    const d = (o.nowTurn != null && e.turn != null) ? Math.max(0, o.nowTurn - e.turn) : Math.max(0, maxSeq - (e.seq || 0));
    return Math.exp(-d / (o.tau || 20)) * (e.status === 'open' ? BM25.openBoost : 1);
  }
  function selectBM25(active, query, o, pinned) {
    const idx = buildIndex(active, o.index); if (o.onIndex) o.onIndex(idx);
    const Q = buildQuery(query, o.expand);
    const maxSeq = active.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    const pinIds = new Set(pinned.map(e => e.id));
    const cands = active.filter(e => !pinIds.has(e.id)).map(e => ({ e, s: bm25f(idx, Q, e) })).filter(x => x.s > 0)
      .map(x => ({ e: x.e, s: x.s * decay(x.e, o, maxSeq) }));
    if (!cands.length) return [];
    const top = Math.max(...cands.map(x => x.s)); cands.forEach(x => { x.r = x.s / top; });
    const lam = o.mmrLambda != null ? o.mmrLambda : 0.7, S = [];
    let budget = o.memTokens, left = cands.slice();
    while (left.length && S.length < Math.max(o.maxInject, 1) * 4) {
      let best = null, bv = -Infinity;
      left.forEach(x => {
        const red = S.length ? Math.max(...S.map(y => similarity(x.e.text, y.e.text))) : 0;
        const v = lam * x.r - (1 - lam) * red;
        if (v > bv || v === bv && (x.e.seq || 0) > (best.e.seq || 0)) { bv = v; best = x; }
      });
      left = left.filter(x => x !== best);
      const c = estTokens(best.e); if (c > budget) continue; // 放不下就跳过，继续找更短的
      budget -= c; S.push(best);
    }
    return S.map(x => x.e);
  }

  /** 相关性：置顶独立预算；普通条目用 maxInject；已失效(superseded)跳过 */
  function selectRelevant(list, query, o) {
    o = settingsOf(o); const q = String(query || ''), qn = norm(q), qg = bigrams(q);
    const qKeys = new Set(autoKeywords(q).map(norm).filter(Boolean));
    const active = (list || []).filter(e => !e.disabled && !e.supersededBy);
    const scoreOne = e => {
      let s0 = 0;
      (e.keywords || []).forEach(k => {
        const kn = norm(k); if (!kn) return;
        if (qn.includes(kn) || kn.includes(qn) && qn.length >= 2) s0 += 2;
        else if ([...qKeys].some(qk => qk.includes(kn) || kn.includes(qk))) s0 += 2;
      });
      let ov = 0; bigrams(e.text).forEach(g => { if (qg.has(g)) ov++; }); s0 += Math.min(3, ov / 3);
      return s0;
    };
    const pinBudget = o.pinBudget != null ? o.pinBudget : DEFAULTS.pinBudget;
    const pinned = active.filter(e => e.pinned).sort((a, b) => (a.seq || 0) - (b.seq || 0)).slice(0, pinBudget);
    if (o.retrieval === 'bm25') return pinned.concat(selectBM25(active, q, o, pinned)).sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const pinIds = new Set(pinned.map(e => e.id));
    const normals = active.filter(e => !pinIds.has(e.id)).map(e => ({ e, s: scoreOne(e) })).filter(x => x.s >= o.minScore);
    normals.sort((a, b) => b.s - a.s || (b.e.seq || 0) - (a.e.seq || 0));
    const picked = normals.slice(0, o.maxInject).map(x => x.e);
    return pinned.concat(picked).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  }
  function renderInjection(entries) {
    if (!entries || !entries.length) return '';
    return '[MEMORY_RECALL]（相关记忆，只作参考，不要复述）\n' + entries.map(e => '- [' + (TYPE_CN[e.type] || e.type) + '] ' + e.text).join('\n');
  }
  /** 到了提取点？turns = 当前对话的用户轮数 */
  const shouldExtract = (turns, lastTurn, interval) => turns - (lastTurn | 0) >= interval;
  function toMemoryText(entries) { return entries.map(e => '- [' + (TYPE_CN[e.type] || e.type) + '] ' + e.text).join('\n'); }

  const RPMemory = { TYPES, TYPE_CN, DEFAULTS, FILE, settingsOf, KW_MAX, autoKeywords, mergeKeywords, kwPriority, buildExtractPrompt, parseExtraction, similarity, detectConflict, extractRelationTriple, CONFLICT_PAIRS, REL_FAMILY, mergeEntries, selectRelevant, terms, buildIndex, buildQuery, bm25f, BM25, renderInjection, shouldExtract, toMemoryText, charKey, textOf };

  // ---------------- 插件 ----------------
  const reg = root.Plugins && root.Plugins.registry;
  if (reg) {
    const ID = 'rpmemory';
    let cache = null; const running = new Set();
    const loadAll = host => cache || (cache = host.store.get(FILE, null) || {});
    const saveAll = (host, m) => { cache = m; host.store.set(FILE, m); };
    const bucket = (host, key) => { const all = loadAll(host); return (all[key] = all[key] || { entries: [], lastError: '' }); };
    const cfgOf = host => settingsOf(reg.config(host.settings(), ID));
    const userTurns = conv => (conv.messages || []).filter(m => m.role === 'user' && !m.error).length;

    async function extract(conv, host, manual) {
      const key = charKey(conv); if (running.has(key)) return { skipped: true };
      running.add(key);
      const o = cfgOf(host), cd = reg.convData(conv, ID), b = bucket(host, key);
      try {
        const msgs = (conv.messages || []).filter(m => (m.role === 'user' || m.role === 'assistant') && !m.error && !m.pending && !m.imageGen).slice(-o.window * 2);
        if (!msgs.length) return { added: 0 };
        const raw = await host.callModel(buildExtractPrompt(msgs, b.entries), { conv, usageType: 'memory', maxTokens: 2048 });
        const items = parseExtraction(raw);
        const r = mergeEntries(b.entries, items, Date.now(), manual ? 'manual' : 'auto');
        b.entries = r.list; b.lastError = ''; b.lastAt = Date.now();
        cd.lastTurn = userTurns(conv); host.saveConv(conv);
        saveAll(host, loadAll(host));
        return r;
      } catch (e) {
        b.lastError = String(e && e.message || e); saveAll(host, loadAll(host));
        cd.lastTurn = userTurns(conv); host.saveConv(conv); // 失败也推进，避免每轮重试烧钱；可手动重试
        if (manual) throw e; return { error: b.lastError };
      } finally { running.delete(key); }
    }
    RPMemory._extract = extract; RPMemory._reset = () => { cache = null; };

    reg.register({
      id: ID, icon: '🧠', name: '结构化记忆', version: '1.0.0', perConversation: false, defaultEnabled: false,
      desc: '每 N 轮（默认 20）自动用当前模型从最近对话提取事实 / 事件 / 关系变化 / 细节，存成可编辑条目（按角色卡跨对话共享，否则按对话）。请求时只按关键词相关性注入少量条目到最后一条消息末尾，不改系统提示词与缓存前缀；可一键写入 RP 缓存「记忆增量」再合并进长期记忆。提取失败不影响聊天。',
      hooks: {
        onBeforeRequest(ctx, host) {
          const msgs = ctx.messages || []; let idx = -1;
          for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { idx = i; break; }
          if (idx < 0) return ctx;
          const b = loadAll(host)[charKey(ctx.conv)]; if (!b || !b.entries.length) return ctx;
          const q = msgs.slice(Math.max(0, idx - 2), idx + 1).map(m => textOf(m.content)).join('\n');
          const cfg = cfgOf(host), conv = ctx.conv || {};
          const lastA = msgs.slice(0, idx).reverse().find(m => m.role === 'assistant');
          const pinKw = b.entries.filter(e => e.pinned && !e.disabled).flatMap(e => e.keywords || []);
          const mood = conv.affect && (conv.affect.mood || conv.affect.label) || '';
          const sel = selectRelevant(b.entries, q, Object.assign({}, cfg, {
            index: conv.memIndex, onIndex: ix => { try { Object.defineProperty(conv, 'memIndex', { value: ix, writable: true, configurable: true, enumerable: false }); } catch (e) { /* 冻结对象：不缓存 */ } },
            nowTurn: userTurns(conv), expand: { context: mood + ' ' + (lastA ? textOf(lastA.content).slice(-200) : ''), pinnedKeywords: pinKw },
          })); const inj = renderInjection(sel);
          if (!inj) return ctx;
          msgs[idx] = Object.assign({}, msgs[idx], { content: appendToContent(msgs[idx].content, inj) });
          ctx.messages = msgs; ctx.meta.rpmemory = { ids: sel.map(e => e.id) };
          return ctx;
        },
        onAfterResponse(result, ctx, host) {
          if (!result || !result.ok || !ctx.conv) return;
          const o = cfgOf(host), cd = reg.convData(ctx.conv, ID);
          if (shouldExtract(userTurns(ctx.conv), cd.lastTurn, o.interval)) Promise.resolve().then(() => extract(ctx.conv, host, false)).then(r => { if (r && r.added && host.isCurrent(ctx.conv)) host.refresh(); }).catch(() => {});
        },
        headerBadges() { return []; }, // 顶栏不显示记忆条数；详情仍在插件面板
      },
      renderSettings(box, host) {
        const c = reg.config(host.settings(), ID), o = settingsOf(c);
        box.innerHTML = '<label class="hint">每多少轮自动提取一次 <input type="number" class="rm-int" min="5" max="200" value="' + o.interval + '"></label><br>' +
          '<label class="hint">每次注入最多条数 <input type="number" class="rm-max" min="0" max="50" value="' + o.maxInject + '"></label>';
        box.querySelector('.rm-int').onchange = e => { c.interval = +e.target.value; host.saveSettings(); };
        box.querySelector('.rm-max').onchange = e => { c.maxInject = +e.target.value; host.saveSettings(); };
      },
      renderPanel(box, host) {
        const conv = host.conv(); if (!conv) { box.innerHTML = '<div class="hint">请先打开一个对话</div>'; return; }
        const key = charKey(conv), b = bucket(host, key), o = cfgOf(host), cd = reg.convData(conv, ID), esc = host.esc;
        const left = Math.max(0, o.interval - (userTurns(conv) - (cd.lastTurn | 0)));
        const save = () => { saveAll(host, loadAll(host)); host.refresh(); };
        box.innerHTML = '<div class="hint">绑定：' + esc(conv.personaName ? '角色卡「' + conv.personaName + '」（跨对话共享）' : '本对话') + ' · ' + b.entries.length + ' 条 · 距下次自动提取 ' + left + ' 轮' +
          (b.lastError ? '<br>⚠ 上次提取失败：' + esc(b.lastError) : '') + '</div>' +
          '<div><button class="chip-btn accent rm-run">立即提取</button> <button class="chip-btn rm-add">新增条目</button> <button class="chip-btn rm-merge">选中写入记忆增量</button></div>' +
          b.entries.map((e, i) => '<div class="rm-item" data-i="' + i + '" style="border-top:1px solid var(--line,#ddd);padding:6px 0">' +
            '<label><input type="checkbox" class="rm-sel"> </label><select class="rm-type">' + TYPES.map(t => '<option value="' + t + '"' + (t === e.type ? ' selected' : '') + '>' + TYPE_CN[t] + '</option>').join('') + '</select> ' +
            '<label class="hint"><input type="checkbox" class="rm-pin"' + (e.pinned ? ' checked' : '') + '>置顶</label> <label class="hint"><input type="checkbox" class="rm-off"' + (e.disabled ? ' checked' : '') + '>停用</label> ' +
            '<button class="chip-btn danger rm-del">删除</button>' +
            '<textarea class="rm-text" rows="2" style="width:100%">' + esc(e.text) + '</textarea>' +
            '<input class="rm-kw" style="width:100%" placeholder="关键词，逗号分隔" value="' + esc((e.keywords || []).join(', ')) + '"></div>').join('');
        const item = el => b.entries[+el.closest('.rm-item').dataset.i];
        box.querySelectorAll('.rm-item').forEach(row => {
          const e = item(row);
          row.querySelector('.rm-type').onchange = ev => { e.type = ev.target.value; e.edited = true; save(); };
          row.querySelector('.rm-pin').onchange = ev => { e.pinned = ev.target.checked; save(); };
          row.querySelector('.rm-off').onchange = ev => { e.disabled = ev.target.checked; save(); };
          row.querySelector('.rm-text').onchange = ev => { e.text = ev.target.value.trim(); e.edited = true; e.updatedAt = Date.now(); save(); };
          row.querySelector('.rm-kw').onchange = ev => { e.keywords = ev.target.value.split(/[,，、\s]+/).filter(Boolean); e.edited = true; save(); };
          row.querySelector('.rm-del').onclick = () => { b.entries.splice(b.entries.indexOf(e), 1); save(); this.renderPanel(box, host); };
        });
        box.querySelector('.rm-add').onclick = () => { const r = mergeEntries(b.entries, [{ type: 'fact', text: '（新条目，请编辑）', keywords: [] }], Date.now(), 'manual'); b.entries = r.list; save(); this.renderPanel(box, host); };
        box.querySelector('.rm-run').onclick = async () => {
          host.toast('正在提取…');
          try { const r = await extract(conv, host, true); host.toast(r.skipped ? '正在提取中' : '新增 ' + (r.added || 0) + ' 条，合并 ' + (r.merged || 0) + ' 条'); } catch (e) { host.toast('提取失败：' + (e.message || e)); }
          this.renderPanel(box, host);
        };
        box.querySelector('.rm-merge').onclick = () => {
          const sel = [...box.querySelectorAll('.rm-item')].filter(r => r.querySelector('.rm-sel').checked).map(item);
          if (!sel.length) { host.toast('请先勾选条目'); return; }
          const R = root.RPCache; if (!R) { host.toast('未加载 RP 缓存模块'); return; }
          const d = reg.convData(conv, 'rpcache'); const st = d.state ? R.normalizeState(d.state) : R.newState();
          const cur = R.getBlock(st, 'delta').content;
          d.state = R.setBlock(st, 'delta', (cur ? cur + '\n' : '') + toMemoryText(sel), Date.now()).state;
          host.saveConv(conv); host.refresh();
          host.toast('已写入 RP「记忆增量」（不破坏缓存）；在 RP 面板点「合并进长期记忆」即可固化');
        };
      },
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = RPMemory;
  else root.RPMemory = RPMemory;
})(typeof window !== 'undefined' ? window : globalThis);
