/* 回复版本 / 对话分支（v0.3.4）。纯函数模块，无 DOM 依赖。
 *
 * 数据模型：conv.messages 始终是「当前选中的路径」（发送、渲染、插件都只看它）。
 * 某条消息有多个版本时：
 *   m.versions = [快照 | null, ...]，m.vi = 当前版本下标；当前版本的数据就在 m 本身，m.versions[m.vi] 为 null。
 *   其他版本的快照 = 该版本自己的字段（内容、思考过程、模型、用量、引用、图片、RP 统计…）+ tail（该版本之后的消息分支）。
 * 切换版本 = 把当前版本（含它之后的消息）存回快照，再把目标版本和它的分支恢复到路径上。
 * 因此：最后一条回复的版本互相切换没有副作用；较早消息切换时，后面的对话随之切换到对应分支（与 ChatGPT 相同）。
 */
(function (root) {
  'use strict';
  const KEEP = new Set(['id', 'role', 'versions', 'vi']); // 所有版本共用的字段（同一个「消息位置」）
  const TRANSIENT = new Set(['pending', 'searching', 'pluginStatus']);
  const clone = o => JSON.parse(JSON.stringify(o));

  const count = m => (m && Array.isArray(m.versions) && m.versions.length > 1 ? m.versions.length : 1);
  const index = m => (count(m) > 1 ? Math.min(Math.max(m.vi | 0, 0), m.versions.length - 1) : 0);

  /** 当前版本的字段快照（不含共用字段与临时状态） */
  function snapshot(m) {
    const o = {};
    Object.keys(m).forEach(k => { if (!KEEP.has(k) && !TRANSIENT.has(k) && m[k] !== undefined) o[k] = m[k]; });
    return o;
  }
  /** 用快照替换消息的版本字段（共用字段不动） */
  function applySnap(m, snap) {
    Object.keys(m).forEach(k => { if (!KEEP.has(k)) delete m[k]; });
    Object.keys(snap || {}).forEach(k => { if (k !== 'tail' && !KEEP.has(k)) m[k] = snap[k]; });
    return m;
  }
  /** 修复 / 迁移：没有 versions 的旧消息视为单版本；只剩 1 个版本时去掉 versions 字段 */
  function normalizeMsg(m) {
    if (!m || !('versions' in m)) return m;
    if (!Array.isArray(m.versions) || m.versions.length < 2) { delete m.versions; delete m.vi; return m; }
    m.vi = index(m); m.versions[m.vi] = null;
    m.versions.forEach((v, i) => { if (i !== m.vi && v) { if (!Array.isArray(v.tail)) v.tail = []; v.tail.forEach(normalizeMsg); } if (i !== m.vi && !v) m.versions[i] = { content: '', tail: [] }; });
    return m;
  }
  function normalizeConv(conv) { (conv.messages || []).forEach(normalizeMsg); return conv; }

  /** 把当前版本（含其后的消息）存回快照 */
  function stash(msgs, i) {
    const m = msgs[i];
    if (!Array.isArray(m.versions) || m.versions.length < 1) { m.versions = [null]; m.vi = 0; }
    m.versions[m.vi | 0] = Object.assign(snapshot(m), { tail: msgs.slice(i + 1) });
  }
  /**
   * 在第 i 条消息上新增一个版本（重新生成 / 编辑并重发）。之后的消息保留在旧版本的分支里。
   * init：新版本的字段。返回新的路径（到第 i 条为止）。
   */
  function addVersion(msgs, i, init) {
    const m = msgs[i];
    stash(msgs, i);
    applySnap(m, init || {});
    m.versions.push(null); m.vi = m.versions.length - 1;
    return msgs.slice(0, i + 1);
  }
  /** 切换第 i 条消息到第 k 个版本，返回新的路径 */
  function select(msgs, i, k) {
    const m = msgs[i];
    const n = count(m);
    if (n < 2 || k < 0 || k >= n || k === index(m)) return msgs;
    stash(msgs, i);
    const target = m.versions[k] || {};
    applySnap(m, target);
    m.versions[k] = null; m.vi = k;
    return msgs.slice(0, i + 1).concat(target.tail || []);
  }
  /** 删除第 i 条消息的第 k 个版本（连同该版本之后的分支）。删除当前版本时切到相邻版本。 */
  function removeVersion(msgs, i, k) {
    const m = msgs[i];
    const n = count(m);
    if (n < 2 || k < 0 || k >= n) return msgs;
    let out = msgs;
    if (k === index(m)) { out = select(msgs, i, k > 0 ? k - 1 : 1); }
    m.versions.splice(k, 1);
    if (m.vi > k) m.vi--;
    normalizeMsg(m);
    return out;
  }
  /** 只保留当前版本（丢弃其他版本和它们的分支） */
  function keepOnly(msgs, i) { const m = msgs[i]; delete m.versions; delete m.vi; return msgs; }
  /** 某个版本之后有多少条消息（当前版本 = 路径上它后面的消息） */
  function tailLength(msgs, i, k) {
    const m = msgs[i];
    if (k === index(m)) return msgs.length - i - 1;
    const v = m.versions && m.versions[k]; return v && v.tail ? v.tail.length : 0;
  }
  /** 单个版本的内容（用于预览） */
  function versionContent(m, k) { if (k === index(m)) return m.content || ''; const v = m.versions && m.versions[k]; return (v && v.content) || ''; }

  const api = { count, index, snapshot, applySnap, normalizeMsg, normalizeConv, addVersion, select, removeVersion, keepOnly, tailLength, versionContent, clone };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Versions = api;
})(typeof window !== 'undefined' ? window : globalThis);
