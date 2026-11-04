/* 渲染差分纯函数（v0.19.x 方向 F）。无 DOM 依赖的核心逻辑可单测；applyBlockDiff 在浏览器内跑。 */
(function (root) {
  function blockHash(s) {
    s = String(s || '');
    let h = 2166136261;
    const step = s.length > 4096 ? Math.ceil(s.length / 4096) : 1;
    for (let i = 0; i < s.length; i += step) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    // 混入长度，降低长文采样碰撞
    h ^= s.length;
    return (h >>> 0).toString(36);
  }

  /** 顶层块切分：优先 DOM；Node 下用嵌套感知的字符串扫描 */
  function splitBlocks(html) {
    html = String(html || '');
    if (!html) return [];
    if (typeof document !== 'undefined' && document.createElement) {
      try {
        const d = document.createElement('div');
        d.innerHTML = html;
        const out = [];
        Array.from(d.childNodes).forEach(n => {
          if (n.nodeType === 1) {
            const h = n.outerHTML;
            out.push({ key: blockHash(h), html: h, tag: (n.tagName || '').toLowerCase() });
          } else if (n.nodeType === 3) {
            const t = n.textContent;
            if (t && t.trim()) out.push({ key: blockHash(t), html: t, tag: '#text' });
          }
        });
        return out;
      } catch (e) { /* fall through */ }
    }
    return splitBlocksStr(html);
  }

  function splitBlocksStr(html) {
    const out = [];
    let i = 0;
    const n = html.length;
    while (i < n) {
      while (i < n && /\s/.test(html[i])) i++;
      if (i >= n) break;
      if (html[i] !== '<') {
        const j = html.indexOf('<', i);
        const end = j < 0 ? n : j;
        const text = html.slice(i, end);
        if (text.trim()) out.push({ key: blockHash(text), html: text, tag: '#text' });
        i = end;
        continue;
      }
      if (html.startsWith('<!--', i)) {
        const end = html.indexOf('-->', i + 4);
        i = end < 0 ? n : end + 3;
        continue;
      }
      const om = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i));
      if (!om) { i++; continue; }
      const tag = om[1].toLowerCase();
      if (/^(br|hr|img|input|meta|link|area|base|col|embed|source|track|wbr)$/.test(tag)) {
        let gt = html.indexOf('>', i);
        if (gt < 0) gt = n - 1;
        const chunk = html.slice(i, gt + 1);
        out.push({ key: blockHash(chunk), html: chunk, tag });
        i = gt + 1;
        continue;
      }
      const end = findMatchingClose(html, i, tag);
      const chunk = html.slice(i, end);
      out.push({ key: blockHash(chunk), html: chunk, tag });
      i = end;
    }
    return out;
  }

  function findMatchingClose(html, start, tag) {
    const openRe = new RegExp('<' + tag + '(?:\\s[^>]*)?>', 'ig');
    const closeRe = new RegExp('</' + tag + '\\s*>', 'ig');
    openRe.lastIndex = start;
    const first = openRe.exec(html);
    if (!first || first.index !== start) {
      const gt = html.indexOf('>', start);
      return gt < 0 ? html.length : gt + 1;
    }
    let depth = 1;
    let pos = first.index + first[0].length;
    while (depth > 0 && pos < html.length) {
      openRe.lastIndex = pos;
      closeRe.lastIndex = pos;
      const o = openRe.exec(html);
      const c = closeRe.exec(html);
      if (!c) return html.length;
      if (o && o.index < c.index) {
        // 跳过自闭合误匹配：若 open 实际是同名闭包前的嵌套
        depth++;
        pos = o.index + o[0].length;
      } else {
        depth--;
        pos = c.index + c[0].length;
        if (depth === 0) return pos;
      }
    }
    return pos;
  }

  function commonPrefix(a, b) {
    a = a || []; b = b || [];
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
  }

  /** 纯函数：根据上一帧 key 与新块，算出 keep 长度与需重建的尾部 */
  function planBlockDiff(prevKeys, nextBlocks) {
    const keys = (nextBlocks || []).map(b => b.key);
    const keep = commonPrefix(prevKeys || [], keys);
    return { keep, rebuild: (nextBlocks || []).slice(keep), nextKeys: keys };
  }

  /**
   * 把 html 差分应用到 el：复用公共前缀节点，只重建尾部。
   * processBlock(node) 可选：高亮 / 包 code-block / 图占位；返回应挂到 el 的根节点。
   */
  function applyBlockDiff(el, html, processBlock) {
    if (!el) return { keep: 0, rebuilt: 0 };
    const blocks = splitBlocks(html);
    const prev = el._blocks || [];
    const plan = planBlockDiff(prev.map(b => b.key), blocks);
    const keep = plan.keep;

    for (let i = prev.length - 1; i >= keep; i--) {
      const node = prev[i] && prev[i].node;
      if (node && node.parentNode === el) el.removeChild(node);
    }

    // 首次无 _blocks 且 el 已有子节点（旧路径 innerHTML）：清空后全量建
    if (!el._blocks && el.childNodes && el.childNodes.length && keep === 0) {
      while (el.firstChild) el.removeChild(el.firstChild);
    }

    const next = prev.slice(0, keep);
    for (let i = keep; i < blocks.length; i++) {
      let node = materialize(blocks[i].html);
      if (!node) continue;
      if (typeof processBlock === 'function') {
        const r = processBlock(node, { index: i, key: blocks[i].key, html: blocks[i].html });
        if (r) node = r;
      }
      el.appendChild(node);
      next.push({ key: blocks[i].key, node });
    }
    el._blocks = next;
    return { keep, rebuilt: blocks.length - keep, total: blocks.length };
  }

  function materialize(html) {
    if (typeof document === 'undefined' || !document.createElement) {
      return { __html: html, nodeType: 1 }; // 占位，供无 DOM 环境单测 plan 用
    }
    const w = document.createElement('div');
    w.innerHTML = html;
    if (w.childNodes.length === 1) return w.firstChild;
    // 多节点（少见）：包一层
    if (!w.childNodes.length) return null;
    const frag = document.createDocumentFragment();
    while (w.firstChild) frag.appendChild(w.firstChild);
    const box = document.createElement('div');
    box.className = 'md-frag';
    box.appendChild(frag);
    return box;
  }

  /** 从 URL 猜测宽高比；猜不到返回 null（调用方用 '4 / 3'） */
  function guessAspect(url) {
    url = String(url || '');
    let w = /[?&#](?:w|width)=(\d{1,5})\b/i.exec(url);
    let h = /[?&#](?:h|height)=(\d{1,5})\b/i.exec(url);
    if (w && h && +w[1] > 0 && +h[1] > 0) return (+w[1]) + ' / ' + (+h[1]);
    const m = /(?:^|[^\d])(\d{2,5})x(\d{2,5})(?:[^\d]|$)/i.exec(url);
    if (m && +m[1] > 0 && +m[2] > 0) return m[1] + ' / ' + m[2];
    return null;
  }

  /** 按消息 id 多槽流式 head 缓存（LRU） */
  function createStreamHeadCache(max) {
    max = Math.max(1, Number(max) || 8);
    const map = new Map();
    return {
      get(id) {
        if (id == null || id === '') return null;
        const k = String(id);
        if (!map.has(k)) return null;
        const v = map.get(k);
        map.delete(k); map.set(k, v);
        return v;
      },
      set(id, v) {
        if (id == null || id === '') return;
        const k = String(id);
        if (map.has(k)) map.delete(k);
        map.set(k, v);
        while (map.size > max) map.delete(map.keys().next().value);
      },
      delete(id) { if (id != null) map.delete(String(id)); },
      clear() { map.clear(); },
      size() { return map.size; },
      has(id) { return id != null && map.has(String(id)); },
    };
  }

  /**
   * 每帧最多一次的调度器。schedule(item) 合并到下一帧；flush 时对集合调用 fn。
   * raf 可注入（测试 / 无 window 环境）。
   */
  function createFrameScheduler(fn, raf) {
    const pending = new Set();
    let handle = null;
    const scheduleRaf = raf || (typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame.bind(typeof window !== 'undefined' ? window : globalThis)
      : (cb) => setTimeout(cb, 16));
    function flush() {
      handle = null;
      const batch = Array.from(pending);
      pending.clear();
      batch.forEach(fn);
    }
    return {
      schedule(item) {
        pending.add(item);
        if (handle != null) return;
        handle = scheduleRaf(flush);
      },
      pending() { return pending.size; },
      _flush: flush,
    };
  }

  const api = {
    blockHash, splitBlocks, splitBlocksStr, commonPrefix, planBlockDiff,
    applyBlockDiff, guessAspect, createStreamHeadCache, createFrameScheduler,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RenderDiff = api;
})(typeof window !== 'undefined' ? window : globalThis);
