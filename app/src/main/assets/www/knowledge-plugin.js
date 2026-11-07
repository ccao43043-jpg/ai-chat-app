/* 内置插件：本地资料库管理（阶段 1）。依赖 plugins.js、knowledge.js。
 * 阶段 2：CRUD + BM25F 检索 + onBeforeRequest [LOCAL_KNOWLEDGE] 注入（默认关）。 */
(function (root) {
  'use strict';
  const K = root.Knowledge;
  const reg = root.Plugins && root.Plugins.registry;
  if (!K || !reg) return;

  const ID = 'knowledge';
  const esc = (host, s) => (host && host.esc ? host.esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c])));

  function memStore() {
    const m = Object.create(null);
    return {
      get(n, d) { return Object.prototype.hasOwnProperty.call(m, n) ? m[n] : d; },
      set(n, v) { m[n] = v; return true; },
      del(n) { delete m[n]; },
      _raw: m,
    };
  }

  function storeOf(host) {
    return (host && host.store) || memStore();
  }

  function worldsOf(host) {
    if (host && typeof host.worlds === 'function') {
      try { return host.worlds() || []; } catch (e) { /* fallthrough */ }
    }
    const st = storeOf(host);
    const raw = st.get('worlds.json', null);
    return Array.isArray(raw) ? raw : [];
  }

  function cfg(host) {
    const c = reg.config(host.settings(), ID);
    if (typeof c.injectEnabled !== 'boolean') c.injectEnabled = false; // 阶段 2 注入总闸，默认关
    return c;
  }

  function convCfg(conv) {
    const d = reg.convData(conv, ID);
    if (typeof d.injectEnabled !== 'boolean') d.injectEnabled = false;
    return d;
  }

  /** 当前面板选中的 worldId（模块级，切换对话不丢） */
  let selectedWorldId = null;
  let ui = { catId: null, q: '', mode: 'list', editEntry: null, editCat: null, importMode: 'merge', importText: '', importFormat: '' };

  function pickWorld(host, preferId) {
    const list = worldsOf(host);
    if (preferId && list.some(w => w.id === preferId)) return preferId;
    if (selectedWorldId && list.some(w => w.id === selectedWorldId)) return selectedWorldId;
    const conv = host.conv && host.conv();
    if (conv && conv.worldId && list.some(w => w.id === conv.worldId)) return conv.worldId;
    return list.length ? list[0].id : '';
  }

  function loadDoc(host, worldId) {
    if (!worldId) return K.emptyDoc('');
    return K.ensure(storeOf(host), worldId);
  }

  function persist(host, doc) {
    K.save(storeOf(host), doc);
    return doc;
  }

  function kwStr(arr) { return (arr || []).join('，'); }

  function renderEntryEditor(box, host, worldId, catId, entry) {
    const isNew = !entry;
    const title = isNew ? '' : (entry.title || '');
    const content = isNew ? '' : (entry.content || '');
    const keywords = isNew ? '' : kwStr(entry.keywords);
    const pinned = !!(entry && entry.pinned);
    box.innerHTML =
      '<div class="hint">' + (isNew ? '新建条目' : '编辑条目') + ' · 世界 ' + esc(host, worldId) + '</div>' +
      '<div class="group form">' +
      '<label class="field"><span>标题</span><input class="kn-title" placeholder="例如：主角别墅" value="' + esc(host, title) + '"></label>' +
      '<label class="field"><span>内容</span><textarea class="kn-content" rows="6" placeholder="详细描述…">' + esc(host, content) + '</textarea></label>' +
      '<label class="field"><span>关键词<small>逗号 / 空格分隔，供阶段 2 检索命中</small></span><input class="kn-kw" placeholder="别墅，房间，车库" value="' + esc(host, keywords) + '"></label>' +
      '<label class="field inline"><span>置顶</span><input type="checkbox" class="switch kn-pin"' + (pinned ? ' checked' : '') + '></label>' +
      '</div>' +
      '<div class="btn-row" style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="pill-btn kn-cancel" type="button">取消</button>' +
      '<button class="pill-btn primary kn-save" type="button" style="flex:1.4">保存</button>' +
      '</div>' +
      (isNew ? '' : '<button class="ghost-btn danger kn-del" type="button" style="width:100%;margin-top:14px">删除此条目</button>');

    box.querySelector('.kn-cancel').onclick = () => {
      ui.mode = 'list'; ui.editEntry = null; plugin.renderPanel(box, host, worldId);
    };
    box.querySelector('.kn-save').onclick = () => {
      const patch = {
        title: box.querySelector('.kn-title').value,
        content: box.querySelector('.kn-content').value,
        keywords: box.querySelector('.kn-kw').value,
        pinned: box.querySelector('.kn-pin').checked,
      };
      if (!String(patch.title || '').trim() && !String(patch.content || '').trim()) {
        host.toast('请填写标题或内容'); return;
      }
      let doc = loadDoc(host, worldId);
      try {
        if (isNew) doc = K.addEntry(doc, catId, patch);
        else doc = K.updateEntry(doc, catId, entry.id, patch);
        persist(host, doc);
        host.toast(isNew ? '已添加' : '已保存');
        ui.mode = 'list'; ui.editEntry = null; ui.catId = catId;
        plugin.renderPanel(box, host, worldId);
      } catch (e) { host.toast(String(e && e.message || e)); }
    };
    const del = box.querySelector('.kn-del');
    if (del) del.onclick = async () => {
      const ok = host.dialog
        ? await host.dialog({ title: '删除条目？', body: '「' + (entry.title || '未命名') + '」将被删除。', okText: '删除', danger: true })
        : true;
      if (!ok) return;
      try {
        let doc = loadDoc(host, worldId);
        doc = K.removeEntry(doc, catId, entry.id);
        persist(host, doc);
        host.toast('已删除');
        ui.mode = 'list'; ui.editEntry = null;
        plugin.renderPanel(box, host, worldId);
      } catch (e) { host.toast(String(e && e.message || e)); }
    };
  }

  function renderCatEditor(box, host, worldId, cat) {
    const isNew = !cat;
    box.innerHTML =
      '<div class="hint">' + (isNew ? '新建分类' : '重命名分类') + '</div>' +
      '<div class="group form">' +
      '<label class="field"><span>名称</span><input class="kn-cat-name" placeholder="例如：人物关系" value="' + esc(host, cat ? cat.name : '') + '"></label>' +
      '</div>' +
      '<div class="btn-row" style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="pill-btn kn-cancel" type="button">取消</button>' +
      '<button class="pill-btn primary kn-save" type="button" style="flex:1.4">保存</button>' +
      '</div>' +
      (isNew || !cat ? '' : '<button class="ghost-btn danger kn-del-cat" type="button" style="width:100%;margin-top:14px">删除此分类（含全部条目）</button>');
    box.querySelector('.kn-cancel').onclick = () => {
      ui.mode = 'list'; ui.editCat = null; plugin.renderPanel(box, host, worldId);
    };
    box.querySelector('.kn-save').onclick = () => {
      const name = box.querySelector('.kn-cat-name').value;
      if (!String(name || '').trim()) { host.toast('请填写分类名称'); return; }
      let doc = loadDoc(host, worldId);
      try {
        if (isNew) doc = K.addCategory(doc, { name });
        else doc = K.updateCategory(doc, cat.id, { name });
        persist(host, doc);
        host.toast('已保存');
        ui.mode = 'list'; ui.editCat = null;
        plugin.renderPanel(box, host, worldId);
      } catch (e) { host.toast(String(e && e.message || e)); }
    };
    const del = box.querySelector('.kn-del-cat');
    if (del) del.onclick = async () => {
      const ok = host.dialog
        ? await host.dialog({ title: '删除分类？', body: '「' + cat.name + '」及其全部条目将被删除。', okText: '删除', danger: true })
        : true;
      if (!ok) return;
      try {
        let doc = loadDoc(host, worldId);
        doc = K.removeCategory(doc, cat.id);
        persist(host, doc);
        if (ui.catId === cat.id) ui.catId = null;
        host.toast('已删除分类');
        ui.mode = 'list'; ui.editCat = null;
        plugin.renderPanel(box, host, worldId);
      } catch (e) { host.toast(String(e && e.message || e)); }
    };
  }


  function traceHtml(host) {
    const conv = host.conv && host.conv();
    const tr = conv && conv._knowledgeTrace;
    if (!tr) return '';
    const n = (tr.hitIds && tr.hitIds.length) || 0;
    const drop = (tr.dropped && tr.dropped.length) || 0;
    let reason = '';
    if (drop) {
      const by = {};
      (tr.dropped || []).forEach(d => { by[d.reason] = (by[d.reason] || 0) + 1; });
      reason = '（' + Object.keys(by).map(k => (k === 'dup' ? '重复' : k === 'budget' ? '预算' : '低分') + ' ' + by[k]).join('、') + '）';
    }
    return '<div class="hint soft kn-trace">本轮资料 ' + n + ' 条 / ' + (tr.tokens | 0) + ' tok' + (drop ? ' / 丢弃 ' + drop + ' 条' + reason : '') + '</div>';
  }

  function renderList(box, host, worldId) {
    const worlds = worldsOf(host);
    const globalOn = reg.isGloballyEnabled(ID, host.settings());
    const conv = host.conv && host.conv();
    const ccfg = conv ? convCfg(conv) : null;
    const gcfg = cfg(host);

    if (!worlds.length) {
      box.innerHTML =
        '<div class="hint">还没有世界。请先在「世界」页新建一个世界，资料库按世界隔离存储。</div>' +
        '<div class="hint soft">开启「注入总闸」后会按 BM25F 检索注入到 user 消息（不写 L1 / system）。</div>' +
        switchBlock(host, globalOn, gcfg, ccfg, conv) + traceHtml(host);
      bindSwitches(box, host, worldId, globalOn, conv);
      return;
    }

    if (!worldId) worldId = pickWorld(host);
    selectedWorldId = worldId;
    const doc = loadDoc(host, worldId);
    if (!ui.catId || !doc.categories.some(c => c.id === ui.catId)) {
      ui.catId = doc.categories.length ? doc.categories[0].id : null;
    }
    const cat = doc.categories.find(c => c.id === ui.catId) || null;
    const q = ui.q || '';
    const hits = q.trim() ? K.search(doc, q) : null;
    const entries = hits
      ? hits.map(h => Object.assign({ categoryId: h.categoryId, categoryName: h.categoryName }, h.entry))
      : (cat ? K.sortEntries(cat.entries) : []);

    const worldOpts = worlds.map(w =>
      '<option value="' + esc(host, w.id) + '"' + (w.id === worldId ? ' selected' : '') + '>' +
      esc(host, (w.emoji || '🌍') + ' ' + (w.name || w.id)) + '</option>'
    ).join('');

    const catChips = doc.categories.map(c =>
      '<button type="button" class="chip kn-cat' + (c.id === ui.catId && !q.trim() ? ' active' : '') + '" data-id="' + esc(host, c.id) + '">' +
      esc(host, c.name) + ' <small>' + (c.entries || []).length + '</small></button>'
    ).join('') +
      '<button type="button" class="chip kn-cat-add">＋ 分类</button>';

    const entryHtml = entries.length
      ? entries.map(e => {
        const cid = e.categoryId || (cat && cat.id);
        return '<div class="plugin-card kn-entry" data-cid="' + esc(host, cid) + '" data-eid="' + esc(host, e.id) + '" style="margin-bottom:8px;padding:12px;cursor:pointer">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">' +
          '<div style="min-width:0;flex:1"><div style="font-weight:600">' + (e.pinned ? '📌 ' : '') + esc(host, e.title || '（无标题）') + '</div>' +
          '<div class="hint" style="margin:4px 0 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' +
          esc(host, (e.content || '').slice(0, 120)) + '</div>' +
          (e.keywords && e.keywords.length ? '<div class="hint soft" style="margin-top:4px">关键词：' + esc(host, e.keywords.join('、')) + '</div>' : '') +
          (hits ? '<div class="hint soft">分类：' + esc(host, e.categoryName || '') + '</div>' : '') +
          '</div>' +
          '<button type="button" class="chip-btn kn-pin-btn" data-cid="' + esc(host, cid) + '" data-eid="' + esc(host, e.id) + '" data-on="' + (e.pinned ? '1' : '0') + '">' +
          (e.pinned ? '取消置顶' : '置顶') + '</button></div></div>';
      }).join('')
      : '<div class="hint">' + (q.trim() ? '没有匹配的条目' : '此分类还没有条目') + '</div>';

    box.innerHTML =
      switchBlock(host, globalOn, gcfg, ccfg, conv) +
      '<label class="field"><span>当前世界</span><select class="kn-world">' + worldOpts + '</select></label>' +
      '<label class="field"><span>搜索<small>按标题 / 内容 / 关键词本地检索</small></span>' +
      '<input class="kn-q" placeholder="例如：别墅" value="' + esc(host, q) + '"></label>' +
      '<div class="chip-row kn-cats" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px">' + catChips + '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">' +
      '<button type="button" class="chip-btn accent kn-add-entry"' + (cat ? '' : ' disabled') + '>＋ 新建条目</button>' +
      '<button type="button" class="chip-btn kn-rename-cat"' + (cat ? '' : ' disabled') + '>重命名分类</button>' +
      '<button type="button" class="chip-btn kn-import">导入</button>' +
      '<button type="button" class="chip-btn kn-export">导出</button>' +
      '<button type="button" class="chip-btn kn-cat-up" title="分类前移"' + (cat ? '' : ' disabled') + '>←</button>' +
      '<button type="button" class="chip-btn kn-cat-down" title="分类后移"' + (cat ? '' : ' disabled') + '>→</button>' +
      '</div>' +
      '<div class="kn-entries">' + entryHtml + '</div>' +
      '<div class="hint soft" style="margin-top:14px">存储键：' + esc(host, K.storeKey(worldId)) +
      ' · 开启注入总闸后按 BM25F 注入 [LOCAL_KNOWLEDGE]。</div>';

    bindSwitches(box, host, worldId, globalOn, conv);

    box.querySelector('.kn-world').onchange = e => {
      selectedWorldId = e.target.value;
      ui.catId = null; ui.q = '';
      plugin.renderPanel(box, host, selectedWorldId);
    };
    const qEl = box.querySelector('.kn-q');
    let qTimer = null;
    qEl.oninput = () => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        ui.q = qEl.value;
        plugin.renderPanel(box, host, worldId);
      }, 180);
    };
    box.querySelectorAll('.kn-cat').forEach(b => {
      b.onclick = () => { ui.catId = b.getAttribute('data-id'); ui.q = ''; plugin.renderPanel(box, host, worldId); };
    });
    box.querySelector('.kn-cat-add').onclick = () => {
      ui.mode = 'cat'; ui.editCat = null; renderCatEditor(box, host, worldId, null);
    };
    const rename = box.querySelector('.kn-rename-cat');
    if (rename) rename.onclick = () => {
      if (!cat) return;
      ui.mode = 'cat'; ui.editCat = cat; renderCatEditor(box, host, worldId, cat);
    };
    const addE = box.querySelector('.kn-add-entry');
    if (addE) addE.onclick = () => {
      if (!cat) return;
      ui.mode = 'entry'; ui.editEntry = { catId: cat.id, entry: null };
      renderEntryEditor(box, host, worldId, cat.id, null);
    };
    const imp = box.querySelector('.kn-import');
    if (imp) imp.onclick = () => {
      ui.mode = 'import';
      renderImport(box, host, worldId);
    };
    const exp = box.querySelector('.kn-export');
    if (exp) exp.onclick = () => {
      ui.mode = 'export';
      renderExport(box, host, worldId);
    };
    box.querySelectorAll('.kn-entry').forEach(card => {
      card.onclick = e => {
        if (e.target.closest('.kn-pin-btn')) return;
        const cid = card.getAttribute('data-cid');
        const eid = card.getAttribute('data-eid');
        const d = loadDoc(host, worldId);
        const hit = K.findEntry(d, cid, eid);
        if (!hit) return;
        ui.mode = 'entry'; ui.editEntry = { catId: cid, entry: hit.entry };
        renderEntryEditor(box, host, worldId, cid, hit.entry);
      };
    });
    box.querySelectorAll('.kn-pin-btn').forEach(b => {
      b.onclick = e => {
        e.stopPropagation();
        const cid = b.getAttribute('data-cid');
        const eid = b.getAttribute('data-eid');
        const on = b.getAttribute('data-on') === '1';
        try {
          let doc2 = loadDoc(host, worldId);
          doc2 = K.setPinned(doc2, cid, eid, !on);
          persist(host, doc2);
          plugin.renderPanel(box, host, worldId);
        } catch (err) { host.toast(String(err && err.message || err)); }
      };
    });
    const up = box.querySelector('.kn-cat-up');
    const down = box.querySelector('.kn-cat-down');
    if (up) up.onclick = () => moveCat(host, box, worldId, -1);
    if (down) down.onclick = () => moveCat(host, box, worldId, 1);
  }


  function formatLabel(fmt) {
    if (fmt === 'json') return '原生 JSON（整库，信息密度中）';
    if (fmt === 'ndjson') return 'NDJSON / JSONL（每行一条，信息密度最高）';
    if (fmt === 'markdown') return '紧凑 Markdown（可读 + 较密）';
    if (fmt === 'empty') return '空内容';
    return '未识别';
  }

  function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function renderImport(box, host, worldId) {
    const detected = ui.importText ? K.detectImportFormat(ui.importText) : '';
    ui.importFormat = detected && detected !== 'empty' && detected !== 'unknown' ? detected : ui.importFormat;
    const mode = ui.importMode === 'replace' ? 'replace' : 'merge';
    box.innerHTML =
      '<div class="hint">导入资料 · 世界 ' + esc(host, worldId) + '</div>' +
      '<div class="hint soft">支持三种格式（信息密度从高到低）：<br>' +
      '1. <b>NDJSON / JSONL</b>（推荐，最密）每行一条 entry<br>' +
      '2. <b>原生 JSON</b> 整库 <code>knowledge_world_*.json</code><br>' +
      '3. <b>紧凑 Markdown</b> <code>## 分类</code> / <code>### 标题</code></div>' +
      '<div class="group form">' +
      '<label class="field"><span>选择文件<small>.json / .ndjson / .jsonl / .md</small></span>' +
      '<input type="file" class="kn-file" accept=".json,.ndjson,.jsonl,.md,.markdown,.txt,application/json,text/plain,text/markdown"></label>' +
      '<label class="field"><span>或粘贴文本</span><textarea class="kn-import-text" rows="10" placeholder=\'{"categoryId":"housing","title":"别墅","content":"…","keywords":["别墅"]}\'>' +
      esc(host, ui.importText || '') + '</textarea></label>' +
      '<div class="hint">格式探测：' + esc(host, formatLabel(detected || 'unknown')) + '</div>' +
      '<label class="field"><span>冲突策略</span>' +
      '<select class="kn-import-mode">' +
      '<option value="merge"' + (mode === 'merge' ? ' selected' : '') + '>合并（默认：同 id 覆盖，无 id 新建）</option>' +
      '<option value="replace"' + (mode === 'replace' ? ' selected' : '') + '>替换（清空原条目后导入）</option>' +
      '</select></label>' +
      '</div>' +
      '<div class="btn-row" style="display:flex;gap:8px;margin-top:12px">' +
      '<button class="pill-btn kn-cancel" type="button">取消</button>' +
      '<button class="pill-btn primary kn-do-import" type="button" style="flex:1.4">开始导入</button>' +
      '</div>';

    const ta = box.querySelector('.kn-import-text');
    const refreshDetect = () => {
      ui.importText = ta.value;
      const d = K.detectImportFormat(ui.importText);
      const hint = box.querySelector('.hint:nth-of-type(3)') || box.querySelectorAll('.hint')[2];
      // re-render detect line simply:
      const labels = box.querySelectorAll('.hint');
      labels.forEach(el => {
        if (String(el.textContent || '').indexOf('格式探测') === 0) {
          el.textContent = '格式探测：' + formatLabel(d);
        }
      });
    };
    ta.oninput = refreshDetect;

    box.querySelector('.kn-file').onchange = e => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        ui.importText = String(rd.result || '');
        ta.value = ui.importText;
        refreshDetect();
        host.toast('已读取文件「' + f.name + '」');
      };
      rd.onerror = () => host.toast('读取文件失败');
      rd.readAsText(f);
    };
    box.querySelector('.kn-import-mode').onchange = e => {
      ui.importMode = e.target.value === 'replace' ? 'replace' : 'merge';
    };
    box.querySelector('.kn-cancel').onclick = () => {
      ui.mode = 'list'; ui.importText = '';
      plugin.renderPanel(box, host, worldId);
    };
    box.querySelector('.kn-do-import').onclick = () => {
      const text = ta.value;
      if (!String(text || '').trim()) { host.toast('请选择文件或粘贴内容'); return; }
      const mode2 = box.querySelector('.kn-import-mode').value === 'replace' ? 'replace' : 'merge';
      ui.importMode = mode2;
      try {
        const parsed = K.parseImport(text);
        let doc = loadDoc(host, worldId);
        const result = K.mergeDoc(doc, parsed, { mode: mode2, worldId, now: Date.now() });
        persist(host, result.doc);
        const parts = [];
        parts.push('新增 ' + result.added);
        parts.push('更新 ' + result.updated);
        if (result.categoriesCreated) parts.push('新分类 ' + result.categoriesCreated);
        host.toast('导入完成（' + formatLabel(parsed.format).split('（')[0] + ' · ' + (mode2 === 'replace' ? '替换' : '合并') + '）：' + parts.join('，'));
        ui.mode = 'list'; ui.importText = '';
        plugin.renderPanel(box, host, worldId);
      } catch (err) {
        host.toast('导入失败：' + String(err && err.message || err));
      }
    };
  }

  function renderExport(box, host, worldId) {
    const doc = loadDoc(host, worldId);
    const count = (doc.categories || []).reduce((n, c) => n + (c.entries || []).length, 0);
    box.innerHTML =
      '<div class="hint">导出资料 · 世界 ' + esc(host, worldId) + ' · ' + count + ' 条</div>' +
      '<div class="hint soft">NDJSON 信息密度最高，适合大批量备份；原生 JSON 可完整往返；Markdown 便于阅读编辑。</div>' +
      '<div class="group form" style="display:flex;flex-direction:column;gap:8px;margin-top:8px">' +
      '<button type="button" class="chip-btn accent kn-ex-ndjson">导出 NDJSON（最密）</button>' +
      '<button type="button" class="chip-btn kn-ex-json">导出原生 JSON</button>' +
      '<button type="button" class="chip-btn kn-ex-md">导出紧凑 Markdown</button>' +
      '<button type="button" class="chip-btn kn-ex-copy-ndjson">复制 NDJSON 到剪贴板</button>' +
      '</div>' +
      '<div class="btn-row" style="margin-top:12px"><button class="pill-btn kn-cancel" type="button">返回</button></div>';

    const base = 'knowledge_world_' + worldId;
    box.querySelector('.kn-ex-ndjson').onclick = () => {
      downloadText(base + '.ndjson', K.exportNdjson(doc), 'application/x-ndjson;charset=utf-8');
      host.toast('已导出 NDJSON');
    };
    box.querySelector('.kn-ex-json').onclick = () => {
      downloadText(base + '.json', K.exportJSON(doc), 'application/json;charset=utf-8');
      host.toast('已导出 JSON');
    };
    box.querySelector('.kn-ex-md').onclick = () => {
      downloadText(base + '.md', K.exportMarkdown(doc), 'text/markdown;charset=utf-8');
      host.toast('已导出 Markdown');
    };
    box.querySelector('.kn-ex-copy-ndjson').onclick = async () => {
      const t = K.exportNdjson(doc);
      try {
        if (host.copyText) host.copyText(t);
        else if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(t);
        else {
          const ta = document.createElement('textarea');
          ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
        }
        host.toast('已复制 NDJSON');
      } catch (e) { host.toast('复制失败：' + String(e && e.message || e)); }
    };
    box.querySelector('.kn-cancel').onclick = () => {
      ui.mode = 'list';
      plugin.renderPanel(box, host, worldId);
    };
  }

  function moveCat(host, box, worldId, delta) {
    const doc = loadDoc(host, worldId);
    const ids = doc.categories.map(c => c.id);
    const i = ids.indexOf(ui.catId);
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    const next = ids.slice();
    const t = next[i]; next[i] = next[j]; next[j] = t;
    persist(host, K.reorderCategories(doc, next));
    plugin.renderPanel(box, host, worldId);
  }

  function switchBlock(host, globalOn, gcfg, ccfg, conv) {
    return '<div class="group form" style="margin-bottom:12px">' +
      '<label class="field inline"><span>全局启用<small>插件总开关（阶段 2 注入才生效；默认关）</small></span>' +
      '<input type="checkbox" class="switch kn-global"' + (globalOn ? ' checked' : '') + '></label>' +
      '<label class="field inline"><span>预留·注入总闸<small>阶段 2 用；阶段 1 仅存设置</small></span>' +
      '<input type="checkbox" class="switch kn-inject-g"' + (gcfg.injectEnabled ? ' checked' : '') + '></label>' +
      (conv
        ? '<label class="field inline"><span>本对话注入<small>阶段 2 用；默认关</small></span>' +
          '<input type="checkbox" class="switch kn-inject-c"' + (ccfg && ccfg.injectEnabled ? ' checked' : '') + '></label>' +
          '<label class="field inline"><span>本对话启用插件<small>可单独关掉本对话</small></span>' +
          '<input type="checkbox" class="switch kn-conv-on"' +
          (reg.isActive(ID, host.settings(), conv) ? ' checked' : '') + '></label>'
        : '<div class="hint soft">打开某一对话后可设置「本对话」开关。</div>') +
      '</div>';
  }

  function bindSwitches(box, host, worldId, globalOn, conv) {
    const g = box.querySelector('.kn-global');
    if (g) g.onchange = e => {
      reg.setGlobal(host.settings(), ID, e.target.checked);
      host.saveSettings();
      host.toast(e.target.checked ? '已全局启用本地资料库' : '已全局停用');
      plugin.renderPanel(box, host, worldId);
    };
    const ig = box.querySelector('.kn-inject-g');
    if (ig) ig.onchange = e => {
      cfg(host).injectEnabled = !!e.target.checked;
      host.saveSettings();
      host.toast(e.target.checked ? '已打开注入总闸（阶段 2 才生效）' : '已关闭注入总闸');
    };
    const ic = box.querySelector('.kn-inject-c');
    if (ic && conv) ic.onchange = e => {
      convCfg(conv).injectEnabled = !!e.target.checked;
      host.saveConv(conv);
      host.toast(e.target.checked ? '本对话注入已开' : '本对话注入已关');
    };
    const co = box.querySelector('.kn-conv-on');
    if (co && conv) co.onchange = e => {
      // perConversation=false：false 表示对本对话关闭
      reg.setForConversation(conv, ID, e.target.checked);
      host.saveConv(conv);
      host.toast(e.target.checked ? '本对话已启用' : '本对话已关闭');
      plugin.renderPanel(box, host, worldId);
    };
  }

  const plugin = reg.register({
    id: ID,
    icon: '📚',
    name: '本地资料库',
    version: '1.2.0',
    perConversation: false,
    defaultEnabled: false,
    desc: '按世界隔离的本地设定资料（住宅 / 物品 / 地点等）。管理 / 导入导出；开启注入总闸后按 BM25F 检索把 [LOCAL_KNOWLEDGE] 追加到最后一条 user 消息（MEMORY 与 CURRENT_STATE 之间，不写 L1）。',
    hooks: {
      onBeforeRequest(ctx, host) {
        const g = cfg(host);
        if (!g.injectEnabled) return ctx;
        const conv = ctx.conv || {};
        const cc = convCfg(conv);
        // 单对话注入开关：显式 false 则跳过（默认跟随总闸）
        if (cc.injectEnabled === false) return ctx;
        const worldId = conv.worldId || selectedWorldId;
        if (!worldId) return ctx;

        const msgs = ctx.messages || [];
        let idx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'user') { idx = i; break; }
        if (idx < 0) return ctx;

        const doc = loadDoc(host, worldId);
        const recent = msgs.slice(Math.max(0, idx - 2), idx + 1).map(m => {
          const c = m.content;
          return Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : String(c || '');
        }).join('\n');
        const lastA = msgs.slice(0, idx).reverse().find(m => m.role === 'assistant');
        const scene = lastA ? String(Array.isArray(lastA.content) ? '' : (lastA.content || '')).slice(-200) : '';
        let budget = g.kbTokens != null ? (g.kbTokens | 0) : 400;
        if (budget > 1200) budget = 1200;
        if (budget < 0) budget = 0;

        // 已注入的 L1 / memory 文本用于去重
        const already = [];
        const sys = String(ctx.systemPrompt || '');
        if (sys) already.push(sys.slice(0, 2000));
        const user0 = String(Array.isArray(msgs[idx].content) ? '' : (msgs[idx].content || ''));
        if (user0.indexOf('[MEMORY_UPDATE]') >= 0) already.push(user0);
        if (user0.indexOf('[MEMORY_RECALL]') >= 0) already.push(user0);

        const sel = K.selectForInject(doc, recent, {
          budget,
          maxBudget: 1200,
          alreadyTexts: already,
          expand: { scene, context: scene },
        });
        const inj = K.renderInjection(sel.hits);
        if (!inj) {
          ctx.meta = ctx.meta || {};
          ctx.meta.knowledge = sel.trace;
          return ctx;
        }
        const content = msgs[idx].content;
        let next;
        if (Array.isArray(content)) {
          const a = content.map(x => Object.assign({}, x));
          // 尝试拼到文本：转成 splice 字符串再不行就 append
          const asText = a.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
          const spliced = K.spliceIntoUserContent(asText || user0, inj);
          next = [{ type: 'text', text: spliced }].concat(a.filter(b => b && b.type !== 'text'));
        } else {
          next = K.spliceIntoUserContent(String(content || ''), inj);
        }
        msgs[idx] = Object.assign({}, msgs[idx], { content: next });
        ctx.messages = msgs;
        ctx.meta = ctx.meta || {};
        ctx.meta.knowledge = sel.trace;
        // 挂到对话上供面板展示
        try {
          conv._knowledgeTrace = sel.trace;
        } catch (e) { /* ignore */ }
        return ctx;
      },
    },
    renderSettings(box, host) {
      const globalOn = reg.isGloballyEnabled(ID, host.settings());
      const gcfg = cfg(host);
      box.innerHTML =
        '<div class="hint">资料按世界存放在本地键 knowledge_world_&lt;worldId&gt;.json。入口：世界页 / 世界编辑 / 本插件面板。</div>' +
        '<label class="field inline"><span>注入总闸</span><input type="checkbox" class="switch kn-set-inj"' +
        (gcfg.injectEnabled ? ' checked' : '') + '></label>' +
        '<div class="hint soft">当前全局：' + (globalOn ? '已启用' : '未启用') + '。开启注入总闸后，请求会按关键词注入资料（不写 L1）。</div>' +
        '<button type="button" class="chip-btn accent kn-open-panel" style="margin-top:8px">打开资料库 ›</button>';
      if (typeof gcfg.kbTokens !== 'number') gcfg.kbTokens = 400;
      const budgetHtml = '<label class="hint">注入预算 Token（默认 400，上限 1200） <input type="number" class="kn-set-budget" min="0" max="1200" value="' + (gcfg.kbTokens | 0) + '"></label>';
      box.insertAdjacentHTML('beforeend', budgetHtml);
      box.querySelector('.kn-set-inj').onchange = e => {
        cfg(host).injectEnabled = !!e.target.checked;
        host.saveSettings();
        host.toast('已保存注入总闸');
      };
      const bud = box.querySelector('.kn-set-budget');
      if (bud) bud.onchange = e => {
        let n = +e.target.value; if (!isFinite(n)) n = 400;
        cfg(host).kbTokens = Math.max(0, Math.min(1200, n | 0));
        host.saveSettings();
      };
      box.querySelector('.kn-open-panel').onclick = () => host.openPanel(ID);
    },
    renderPanel(box, host, tab) {
      plugin._box = box;
      const prefer = typeof tab === 'string' && tab && tab !== 'settings' ? tab : selectedWorldId;
      const worldId = pickWorld(host, prefer);
      selectedWorldId = worldId || selectedWorldId;
      if (ui.mode === 'entry' && ui.editEntry) {
        renderEntryEditor(box, host, worldId, ui.editEntry.catId, ui.editEntry.entry);
        return;
      }
      if (ui.mode === 'cat') {
        renderCatEditor(box, host, worldId, ui.editCat);
        return;
      }
      if (ui.mode === 'import') {
        renderImport(box, host, worldId);
        return;
      }
      if (ui.mode === 'export') {
        renderExport(box, host, worldId);
        return;
      }
      ui.mode = 'list';
      renderList(box, host, worldId);
    },
  });

  // 供 app.js 入口直接打开指定世界
  root.KnowledgePlugin = {
    id: ID,
    open(host, worldId) {
      selectedWorldId = worldId || selectedWorldId;
      ui.mode = 'list'; ui.editEntry = null; ui.editCat = null; ui.q = ''; ui.importText = '';
      if (host && host.openPanel) host.openPanel(ID, worldId || selectedWorldId);
    },
    selectedWorldId: () => selectedWorldId,
  };
})(typeof window !== 'undefined' ? window : globalThis);
