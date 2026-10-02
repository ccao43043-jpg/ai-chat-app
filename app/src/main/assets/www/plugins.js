/* 插件框架：注册表 + 钩子执行（纯逻辑，可在 Node 中测试）。
 * 目前只加载随应用打包的内置插件，不下载、不执行第三方代码。API 说明见 docs/plugins/README.md
 */
(function (root) {
  'use strict';

  function createRegistry() {
    const list = [];
    const errors = [];

    /** 注册插件。必填：id、name；其余均可选 */
    function register(plugin) {
      if (!plugin || !plugin.id || !plugin.name) throw new Error('插件必须有 id 和 name');
      if (list.some(p => p.id === plugin.id)) throw new Error('插件 id 重复：' + plugin.id);
      const p = Object.assign({ icon: '🧩', desc: '', version: '1.0.0', defaultEnabled: false, perConversation: false, hooks: {} }, plugin);
      list.push(p);
      return p;
    }
    const all = () => list.slice();
    const get = id => list.find(p => p.id === id) || null;

    /** 全局开关（settings.plugins[id].enabled），未设置时取插件默认值 */
    function isGloballyEnabled(id, settings) {
      const p = get(id); if (!p) return false;
      const st = settings && settings.plugins && settings.plugins[id];
      return st && typeof st.enabled === 'boolean' ? st.enabled : !!p.defaultEnabled;
    }
    /**
     * 在某个对话中是否生效：
     *  - perConversation=false：全局开启即对所有对话生效，可在对话中单独关闭（conv.plugins[id].enabled === false）
     *  - perConversation=true ：全局开启后，还需要在对话中手动开启（conv.plugins[id].enabled === true）
     */
    function isActive(id, settings, conv) {
      const p = get(id);
      if (!p || !isGloballyEnabled(id, settings)) return false;
      const cs = conv && conv.plugins && conv.plugins[id];
      if (p.perConversation) return !!(cs && cs.enabled === true);
      return !(cs && cs.enabled === false);
    }
    function active(settings, conv) { return list.filter(p => isActive(p.id, settings, conv)); }

    function setGlobal(settings, id, enabled) {
      settings.plugins = settings.plugins || {};
      settings.plugins[id] = Object.assign({}, settings.plugins[id], { enabled: !!enabled });
      return settings;
    }
    function setForConversation(conv, id, enabled) {
      conv.plugins = conv.plugins || {};
      conv.plugins[id] = Object.assign({}, conv.plugins[id], { enabled: !!enabled });
      return conv;
    }
    /** 插件的全局配置 / 对话数据（可写） */
    function config(settings, id) { settings.plugins = settings.plugins || {}; return (settings.plugins[id] = settings.plugins[id] || {}); }
    function convData(conv, id) { conv.plugins = conv.plugins || {}; return (conv.plugins[id] = conv.plugins[id] || {}); }

    function safe(p, name, fn) {
      try { return fn(); } catch (e) {
        errors.push({ plugin: p.id, hook: name, message: String(e && e.message || e) });
        if (typeof console !== 'undefined') console.warn('[plugin ' + p.id + '] ' + name + ' 出错：', e);
        return undefined;
      }
    }

    /**
     * 请求前：依次把 ctx 交给每个生效插件的 onBeforeRequest(ctx, host)（可以是 async）。
     * 钩子可以直接修改 ctx 或返回新的 ctx。某个插件出错时丢弃它的修改，继续使用上一步的 ctx。
     * ctx: { conv, provider, model, systemPrompt, messages:[{role,content,images,_src}], opts, settings, lastUser, meta:{}, setStatus(text), setCancel(fn) }
     * 返回 Promise<ctx>
     */
    async function runBeforeRequest(ctx, host) {
      let cur = ctx;
      cur.meta = cur.meta || {};
      const act = active(cur.settings, cur.conv);
      cur.plugins = act.map(p => p.id);
      for (const p of act) {
        if (!p.hooks.onBeforeRequest) continue;
        // 给插件一份浅拷贝：出错时丢弃它的修改，保持原请求不变
        const work = Object.assign({}, cur, { messages: (cur.messages || []).map(m => Object.assign({}, m)), meta: Object.assign({}, cur.meta), opts: Object.assign({}, cur.opts) });
        let r;
        try { r = await p.hooks.onBeforeRequest(work, host); } catch (e) {
          errors.push({ plugin: p.id, hook: 'onBeforeRequest', message: String(e && e.message || e) });
          if (typeof console !== 'undefined') console.warn('[plugin ' + p.id + '] onBeforeRequest 出错：', e);
          continue;
        }
        cur = r && typeof r === 'object' ? r : work;
      }
      return cur;
    }
    /** 响应结束后：onResponseUsage(usage, ctx, host) 与 onAfterResponse(result, ctx, host) */
    function runAfterResponse(ctx, result, host) {
      active(ctx.settings, ctx.conv).forEach(p => {
        if (result && result.usage && p.hooks.onResponseUsage) safe(p, 'onResponseUsage', () => p.hooks.onResponseUsage(result.usage, ctx, host));
        if (p.hooks.onAfterResponse) safe(p, 'onAfterResponse', () => p.hooks.onAfterResponse(result || {}, ctx, host));
      });
    }
    /** 徽章：[{text, tone:'ok'|'warn'|'bad'|'info', title, action}] */
    function messageBadges(msg, settings, conv, host) {
      const out = [];
      active(settings, conv).forEach(p => {
        if (!p.hooks.messageBadges) return;
        (safe(p, 'messageBadges', () => p.hooks.messageBadges(msg, conv, host)) || []).forEach(b => out.push(Object.assign({ plugin: p.id }, b)));
      });
      return out;
    }
    function headerBadges(settings, conv, host) {
      const out = [];
      active(settings, conv).forEach(p => {
        if (!p.hooks.headerBadges) return;
        (safe(p, 'headerBadges', () => p.hooks.headerBadges(conv, host)) || []).forEach(b => out.push(Object.assign({ plugin: p.id }, b)));
      });
      return out;
    }
    /** 消息在界面上的附加状态（如「已压缩」） */
    function messageState(msg, settings, conv, host) {
      let st = null;
      active(settings, conv).forEach(p => {
        if (!p.hooks.messageState) return;
        const r = safe(p, 'messageState', () => p.hooks.messageState(msg, conv, host));
        if (r) st = Object.assign(st || {}, r);
      });
      return st;
    }

    return { register, all, get, isGloballyEnabled, isActive, active, setGlobal, setForConversation, config, convData,
      runBeforeRequest, runAfterResponse, messageBadges, headerBadges, messageState, errors };
  }

  const api = { createRegistry, registry: createRegistry() };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Plugins = api;
})(typeof window !== 'undefined' ? window : globalThis);
