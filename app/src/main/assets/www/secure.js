/* v0.9.0 安全与存储辅助（纯函数，可在 Node 中测试）
 *  - originOf / isUrlAllowed：密钥请求只允许发往服务商登记的 Base URL 同源地址（防止 Key 被带去其它域名）
 *  - stripSecrets：把旧版明文保存在 settings.json 里的 API Key 取出（交给原生安全存储），并从设置对象里删除
 *  - authTypeFor：服务商 / 搜索服务对应的认证方式（由原生层注入请求头）
 *  - rebuildIndex：convs.json 损坏时用 conv_*.json 重建索引
 *  - splitStableMarkdown：流式 Markdown 增量渲染，找出“已稳定”的前半部分
 *  - parseJsonl / toJsonl：追加式 JSONL 日志读写
 * 与原生（Android NativeBridge.java / 桌面 main.js）中的同名校验逻辑保持一致。
 */
(function (root) {
  'use strict';

  /** 返回 scheme://host[:port]（小写，去掉默认端口）；含用户信息(@)、非 http(s) 或无法解析时返回 '' */
  function originOf(u) {
    const m = /^(https?):\/\/([^/?#@\\\s]+)(?=[/?#]|$)/i.exec(String(u == null ? '' : u).trim());
    if (!m) return '';
    const scheme = m[1].toLowerCase();
    let host = m[2].toLowerCase();
    const pm = /^(.*?)(?::(\d+))?$/.exec(host);
    host = pm[1]; let port = pm[2] || '';
    if (!host || /[^a-z0-9.\-\[\]:]/.test(host)) return '';
    if ((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')) port = '';
    return scheme + '://' + host + (port ? ':' + port : '');
  }

  /** 请求地址是否与登记的 Base URL 同源（scheme + host + port 完全一致） */
  function isUrlAllowed(url, baseUrl) {
    const a = originOf(url), b = originOf(baseUrl);
    return !!a && a === b;
  }

  const PROVIDER_AUTH = { openai: 'bearer', anthropic: 'anthropic', gemini: 'gemini' };
  const SEARCH_AUTH = { tavily: 'bearer', bocha: 'bearer', brave: 'brave', searxng: 'bearer' };
  function authTypeFor(kind, idOrType) {
    if (kind === 'search_key') return SEARCH_AUTH[idOrType] || 'bearer';
    return PROVIDER_AUTH[idOrType] || 'bearer';
  }
  /** 这些请求头一律由原生层注入；页面传来的同名头会被丢弃 */
  const AUTH_HEADERS = ['authorization', 'x-api-key', 'x-goog-api-key', 'x-subscription-token'];
  function stripAuthHeaders(h) {
    const out = {};
    Object.keys(h || {}).forEach(k => { if (!AUTH_HEADERS.includes(k.toLowerCase())) out[k] = h[k]; });
    return out;
  }

  /**
   * 从设置对象中取出明文密钥（会修改入参）。返回 { changed, secrets:[{kind,id,value}] }。
   * 处理后：provider.apiKey 被删除，provider.hasKey 标记是否已有密钥；search.keys 被删除，search.hasKeys 记录。
   */
  function stripSecrets(settings) {
    const secrets = []; let changed = false;
    if (!settings || typeof settings !== 'object') return { changed, secrets };
    (settings.providers || []).forEach(p => {
      if (!p || !Object.prototype.hasOwnProperty.call(p, 'apiKey')) return;
      const v = String(p.apiKey == null ? '' : p.apiKey).trim();
      if (v) { secrets.push({ kind: 'provider_key', id: p.id, value: v }); p.hasKey = true; }
      delete p.apiKey; changed = true;
    });
    const ss = settings.search;
    if (ss && ss.keys && typeof ss.keys === 'object') {
      ss.hasKeys = Object.assign({}, ss.hasKeys || {});
      Object.keys(ss.keys).forEach(id => {
        const v = String(ss.keys[id] == null ? '' : ss.keys[id]).trim();
        if (v) { secrets.push({ kind: 'search_key', id, value: v }); ss.hasKeys[id] = true; }
      });
      delete ss.keys; changed = true;
    }
    return { changed, secrets };
  }

  /** 用若干对话对象重建 convs.json 索引（按更新时间倒序） */
  function rebuildIndex(convs) {
    return (convs || []).filter(c => c && typeof c === 'object' && c.id).map(c => {
      const meta = { id: c.id, title: c.title || '未命名对话', providerId: c.providerId || '', model: c.model || '',
        updatedAt: +c.updatedAt || +c.createdAt || 0 };
      if (c.personaName) { meta.personaName = c.personaName; meta.personaEmoji = c.personaEmoji; }
      return meta;
    }).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 损坏文件的备份名：name.corrupt-<时间戳> */
  function corruptName(name, now) { return name + '.corrupt-' + (now || Date.now()); }

  /**
   * 流式 Markdown：返回 { head, tail }，head 为最后一个“安全空行”之前的内容（不在代码块内、
   * 下一行不是缩进续行或列表项），可以单独解析并缓存；tail 每次重新解析。head 为空表示没有安全边界。
   */
  function splitStableMarkdown(src) {
    src = String(src || '');
    let fence = null, cut = 0, pos = 0;
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fm = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (fence) {
        if (fm && fm[1][0] === fence[0] && fm[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      } else if (fm) {
        fence = fm[1];
      } else if (line.trim() === '' && i > 0 && i + 1 < lines.length - 1) {
        // 下一行要已经写完（不是最后一行）且不是缩进续行、列表项、表格续行
        const next = lines[i + 1];
        if (next !== '' && !/^[ \t]/.test(next) && !/^([-*+]|\d{1,9}[.)])\s/.test(next) && !/^\|/.test(next) && !/^\[[^\]]+\]:/.test(next)) {
          cut = pos + line.length + 1;
        }
      }
      pos += line.length + 1;
    }
    return { head: src.slice(0, cut), tail: src.slice(cut) };
  }

  function parseJsonl(text) {
    const out = []; let bad = 0;
    String(text || '').split('\n').forEach(l => {
      l = l.trim(); if (!l) return;
      try { out.push(JSON.parse(l)); } catch (e) { bad++; }
    });
    return { items: out, bad };
  }
  function toJsonl(items) { return (items || []).map(x => JSON.stringify(x)).join('\n') + ((items || []).length ? '\n' : ''); }

  const api = { originOf, isUrlAllowed, authTypeFor, AUTH_HEADERS, stripAuthHeaders, stripSecrets, rebuildIndex, corruptName,
    splitStableMarkdown, parseJsonl, toJsonl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Secure = api;
})(typeof window !== 'undefined' ? window : globalThis);
