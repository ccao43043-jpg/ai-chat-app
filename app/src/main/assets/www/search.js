/* 联网搜索：请求构造、结果解析与上下文注入（纯函数，可在 Node 中测试）
 * 接口格式核对自官方文档（2026-10）：
 *  - Tavily  POST https://api.tavily.com/search  Authorization: Bearer tvly-…  {query, max_results, search_depth}
 *            -> results[].{title,url,content,score}
 *  - 博查    POST https://api.bochaai.com/v1/web-search  Authorization: Bearer …  {query, freshness, summary, count}
 *            -> data.webPages.value[].{name,url,snippet,summary,siteName,datePublished}
 *  - Brave   GET  https://api.search.brave.com/res/v1/web/search?q=&count=  X-Subscription-Token: …
 *            -> web.results[].{title,url,description,extra_snippets}
 *  - SearXNG GET  {实例}/search?q=&format=json（需实例开启 json 格式） -> results[].{title,url,content}
 */
(function (root) {
  'use strict';

  const SEARCH_PROVIDERS = [
    { id: 'tavily', name: 'Tavily', needsKey: true, keyHint: 'tvly-…', site: 'https://app.tavily.com' },
    { id: 'bocha', name: '博查 Bocha', needsKey: true, keyHint: 'sk-…', site: 'https://open.bochaai.com' },
    { id: 'brave', name: 'Brave Search', needsKey: true, keyHint: 'BSA…', site: 'https://api-dashboard.search.brave.com' },
    { id: 'searxng', name: 'SearXNG（自建实例）', needsKey: false, keyHint: '', site: 'https://docs.searxng.org' },
  ];
  const DEFAULT_BASE = {
    tavily: 'https://api.tavily.com',
    bocha: 'https://api.bochaai.com',
    brave: 'https://api.search.brave.com',
    searxng: '',
  };

  function trimSlash(u) { return String(u || '').trim().replace(/\/+$/, ''); }
  function clampCount(n) { n = parseInt(n, 10); if (isNaN(n)) n = 5; return Math.max(1, Math.min(10, n)); }

  /** cfg: { provider, apiKey, baseUrl, count } */
  function buildSearchRequest(cfg, query) {
    const count = clampCount(cfg.count);
    const key = String(cfg.apiKey || '').trim();
    const base = trimSlash(cfg.baseUrl) || DEFAULT_BASE[cfg.provider] || '';
    const q = String(query || '').trim().slice(0, 380);
    switch (cfg.provider) {
      case 'tavily':
        return { url: base + '/search', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: JSON.stringify({ query: q, max_results: count, search_depth: 'basic', include_answer: false }) };
      case 'bocha':
        return { url: base + '/v1/web-search', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
          body: JSON.stringify({ query: q, freshness: 'noLimit', summary: true, count }) };
      case 'brave':
        return { url: base + '/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=' + count, method: 'GET',
          headers: { 'Accept': 'application/json', 'X-Subscription-Token': key } };
      case 'searxng':
        if (!base) throw new Error('请先填写 SearXNG 实例地址');
        return { url: base + '/search?q=' + encodeURIComponent(q) + '&format=json', method: 'GET',
          headers: Object.assign({ 'Accept': 'application/json' }, key ? { 'Authorization': 'Bearer ' + key } : {}) };
      default:
        throw new Error('未知的搜索服务：' + cfg.provider);
    }
  }

  function hostOf(url) { const m = /^https?:\/\/([^/?#]+)/i.exec(url || ''); return m ? m[1].replace(/^www\./, '') : ''; }
  function clean(s) { return String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(); }

  /** 统一解析为 [{title,url,content,site,date}] */
  function parseSearchResponse(provider, text, count) {
    const obj = JSON.parse(text);
    let list = [];
    if (provider === 'tavily') {
      list = (obj.results || []).map(r => ({ title: r.title, url: r.url, content: r.content || r.raw_content, date: r.published_date }));
    } else if (provider === 'bocha') {
      if (obj.code && obj.code !== 200 && !obj.data) throw new Error(obj.msg || obj.message || ('博查返回错误码 ' + obj.code));
      const wp = (obj.data && obj.data.webPages) || obj.webPages || {};
      list = (wp.value || []).map(r => ({ title: r.name, url: r.url, content: r.summary || r.snippet, site: r.siteName, date: r.datePublished || r.dateLastCrawled }));
    } else if (provider === 'brave') {
      list = ((obj.web && obj.web.results) || []).map(r => ({ title: r.title, url: r.url,
        content: [r.description].concat(r.extra_snippets || []).filter(Boolean).join(' '), date: r.page_age || r.age }));
    } else if (provider === 'searxng') {
      list = (obj.results || []).map(r => ({ title: r.title, url: r.url, content: r.content, date: r.publishedDate }));
    }
    const seen = new Set();
    return list.filter(r => r && r.url && /^https?:/i.test(r.url) && !seen.has(r.url) && seen.add(r.url))
      .slice(0, clampCount(count || 10))
      .map(r => ({ title: clean(r.title) || hostOf(r.url), url: r.url, content: clean(r.content).slice(0, 1200),
        site: clean(r.site) || hostOf(r.url), date: r.date ? String(r.date).slice(0, 10) : '' }));
  }

  /** 把搜索结果拼成注入到用户消息前的上下文 */
  function buildSearchContext(results, question, opts) {
    opts = opts || {};
    const today = opts.today || new Date().toISOString().slice(0, 10);
    const maxChars = opts.maxChars || 6000;
    let used = 0;
    const blocks = [];
    results.forEach((r, i) => {
      let content = r.content || '';
      const remain = maxChars - used;
      if (remain <= 80) return;
      if (content.length > remain) content = content.slice(0, remain) + '…';
      used += content.length;
      blocks.push('[' + (i + 1) + '] ' + r.title + '\n链接：' + r.url + (r.date ? '\n日期：' + r.date : '') + '\n内容：' + content);
    });
    return '以下是针对用户问题的联网搜索结果（今天是 ' + today + '）：\n\n' + blocks.join('\n\n') +
      '\n\n请结合以上搜索结果回答用户的问题。要求：\n' +
      '1. 引用搜索结果中的信息时，在对应句子末尾用 [编号] 标注来源，例如 [1] 或 [2][3]；\n' +
      '2. 只引用与问题相关的结果，不要编造链接或编号；\n' +
      '3. 如果搜索结果不足以回答，请说明，并可结合自身知识作答（这部分不加编号）；\n' +
      '4. 不需要在末尾重复列出参考链接。\n\n用户问题：' + question;
  }

  /** 让模型改写搜索词的提示词（可选功能） */
  function buildRewritePrompt(question, history) {
    const ctx = (history || []).slice(-4).map(m => (m.role === 'user' ? '用户：' : '助手：') + String(m.content || '').slice(0, 300)).join('\n');
    return '你是搜索词生成器。根据对话和用户最新问题，生成一个最适合在搜索引擎中检索的简短查询词（不超过 30 个字，保留关键实体、时间与地点）。只输出查询词本身，不要解释、不要引号。\n\n' +
      (ctx ? '最近对话：\n' + ctx + '\n\n' : '') + '最新问题：' + question;
  }
  function cleanRewrite(text, fallback) {
    let t = String(text || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    t = t.replace(/^(查询词|搜索词|query)\s*[:：]\s*/i, '').replace(/^["'“”「」]+|["'“”「」]+$/g, '').trim();
    return t && t.length <= 120 ? t : fallback;
  }

  const api = { SEARCH_PROVIDERS, DEFAULT_BASE, buildSearchRequest, parseSearchResponse, buildSearchContext, buildRewritePrompt, cleanRewrite, hostOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Search = api;
})(typeof window !== 'undefined' ? window : globalThis);
