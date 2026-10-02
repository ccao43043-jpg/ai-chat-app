/* 各家 API 的请求构造与响应解析（纯函数，可在 Node 中单元测试） */
(function (root) {
  'use strict';

  const PRESETS = [
    { presetId: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'], imageModel: 'gpt-image-1', vision: true },
    { presetId: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'], imageModel: '', vision: false },
    { presetId: 'qwen', name: '通义千问', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-plus'], imageModel: '', vision: true },
    { presetId: 'moonshot', name: 'Moonshot (Kimi)', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
      models: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], imageModel: '', vision: false },
    { presetId: 'zhipu', name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-4-flash', 'glm-4-plus', 'glm-4v-flash'], imageModel: 'cogview-3-flash', vision: true },
    { presetId: 'siliconflow', name: '硅基流动 SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1',
      models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-R1'], imageModel: 'Kwai-Kolors/Kolors', vision: false },
    { presetId: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-flash'], imageModel: '', vision: true },
    { presetId: 'anthropic', name: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com',
      models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'], imageModel: '', vision: true },
    { presetId: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'], imageModel: '', vision: true },
    { presetId: 'custom', name: '自定义（OpenAI 兼容）', type: 'openai', baseUrl: 'https://',
      models: [''], imageModel: '', vision: true },
  ];

  function trimSlash(u) { return String(u || '').trim().replace(/\/+$/, ''); }

  /** data:image/png;base64,xxxx -> {mime, data} */
  function splitDataUrl(dataUrl) {
    const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(dataUrl || '');
    if (!m) return { mime: 'image/jpeg', data: '' };
    return { mime: m[1], data: m[3] };
  }

  /**
   * messages: [{role:'user'|'assistant', content:string, images?:[dataUrl]}]
   * opts: { stream, temperature, maxTokens }
   * 返回 { url, method, headers, body(string) }
   */
  function buildChatRequest(provider, model, messages, systemPrompt, opts) {
    opts = opts || {};
    const stream = opts.stream !== false;
    const base = trimSlash(provider.baseUrl);
    const key = (provider.apiKey || '').trim();
    const msgs = (messages || []).filter(m => (m.role === 'user' || m.role === 'assistant') &&
      ((m.content && m.content.length) || (m.images && m.images.length)));
    const sys = (systemPrompt || '').trim();
    const temp = (typeof opts.temperature === 'number' && !isNaN(opts.temperature)) ? opts.temperature : undefined;

    if (provider.type === 'anthropic') {
      const body = {
        model, max_tokens: opts.maxTokens || 4096, stream,
        messages: msgs.map(m => {
          if (m.role === 'user' && m.images && m.images.length) {
            const parts = m.images.map(img => {
              const d = splitDataUrl(img);
              return { type: 'image', source: { type: 'base64', media_type: d.mime, data: d.data } };
            });
            if (m.content) parts.push({ type: 'text', text: m.content });
            return { role: 'user', content: parts };
          }
          return { role: m.role, content: m.content || '' };
        }),
      };
      if (sys) body.system = sys;
      if (temp !== undefined) body.temperature = temp;
      return {
        url: base + '/v1/messages', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01',
          'Accept': stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(body),
      };
    }

    if (provider.type === 'gemini') {
      const body = {
        contents: msgs.map(m => {
          const parts = [];
          (m.role === 'user' ? (m.images || []) : []).forEach(img => {
            const d = splitDataUrl(img);
            parts.push({ inline_data: { mime_type: d.mime, data: d.data } });
          });
          if (m.content) parts.push({ text: m.content });
          return { role: m.role === 'assistant' ? 'model' : 'user', parts };
        }),
      };
      if (sys) body.systemInstruction = { parts: [{ text: sys }] };
      const gc = {};
      if (temp !== undefined) gc.temperature = temp;
      if (opts.maxTokens) gc.maxOutputTokens = opts.maxTokens;
      if (Object.keys(gc).length) body.generationConfig = gc;
      const path = stream ? ':streamGenerateContent?alt=sse' : ':generateContent';
      return {
        url: base + '/models/' + encodeURIComponent(model) + path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      };
    }

    // OpenAI 兼容
    const out = [];
    if (sys) out.push({ role: 'system', content: sys });
    msgs.forEach(m => {
      if (m.role === 'user' && m.images && m.images.length) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        m.images.forEach(img => parts.push({ type: 'image_url', image_url: { url: img } }));
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: m.role, content: m.content || '' });
      }
    });
    const body = { model, messages: out, stream };
    if (temp !== undefined) body.temperature = temp;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    if (stream) headers['Accept'] = 'text/event-stream';
    return { url: base + '/chat/completions', method: 'POST', headers, body: JSON.stringify(body) };
  }

  /** 从一个 JSON 事件中提取增量 [{kind:'text'|'reasoning', text}] */
  function extractDeltas(type, obj) {
    const out = [];
    if (!obj) return out;
    if (type === 'anthropic') {
      if (obj.type === 'content_block_delta' && obj.delta) {
        if (obj.delta.type === 'text_delta') out.push({ kind: 'text', text: obj.delta.text || '' });
        else if (obj.delta.type === 'thinking_delta') out.push({ kind: 'reasoning', text: obj.delta.thinking || '' });
      } else if (obj.type === 'error') {
        out.push({ kind: 'error', text: (obj.error && obj.error.message) || JSON.stringify(obj) });
      } else if (Array.isArray(obj.content)) { // 非流式
        obj.content.forEach(c => {
          if (c.type === 'text') out.push({ kind: 'text', text: c.text });
          else if (c.type === 'thinking') out.push({ kind: 'reasoning', text: c.thinking });
        });
      }
      return out;
    }
    if (type === 'gemini') {
      if (obj.error) { out.push({ kind: 'error', text: obj.error.message || JSON.stringify(obj.error) }); return out; }
      const cands = obj.candidates || [];
      if (cands[0] && cands[0].content && cands[0].content.parts) {
        cands[0].content.parts.forEach(p => {
          if (typeof p.text === 'string') out.push({ kind: p.thought ? 'reasoning' : 'text', text: p.text });
        });
      }
      return out;
    }
    // openai
    if (obj.error) { out.push({ kind: 'error', text: obj.error.message || JSON.stringify(obj.error) }); return out; }
    const ch = (obj.choices || [])[0];
    if (ch) {
      const d = ch.delta || ch.message || {};
      const r = d.reasoning_content || d.reasoning;
      if (typeof r === 'string' && r) out.push({ kind: 'reasoning', text: r });
      if (typeof d.content === 'string' && d.content) out.push({ kind: 'text', text: d.content });
    }
    return out;
  }

  /** SSE 增量解析器：push(chunk) 返回本次得到的增量数组 */
  function createStreamParser(type) {
    let buf = '';
    let dataLines = [];
    let done = false;
    function flushEvent(out) {
      if (!dataLines.length) return;
      const data = dataLines.join('\n');
      dataLines = [];
      if (data.trim() === '[DONE]') { done = true; return; }
      try { extractDeltas(type, JSON.parse(data)).forEach(d => out.push(d)); } catch (e) { /* 忽略非 JSON */ }
    }
    function processLine(line, out) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') { flushEvent(out); return; }
      if (line.startsWith(':')) return;
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
      // event:/id:/retry: 忽略（anthropic 的 data 里本身带 type）
    }
    return {
      push(chunk) {
        const out = [];
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          processLine(line, out);
        }
        return out;
      },
      end() {
        const out = [];
        if (buf) { processLine(buf, out); buf = ''; }
        flushEvent(out);
        return out;
      },
      get done() { return done; },
    };
  }

  /** 非流式完整响应解析 */
  function parseFullResponse(type, text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return [{ kind: 'error', text: '无法解析响应：' + String(text).slice(0, 300) }]; }
    if (Array.isArray(obj)) { const all = []; obj.forEach(o => extractDeltas(type, o).forEach(d => all.push(d))); return all; }
    return extractDeltas(type, obj);
  }

  /** HTTP 错误转为可读信息 */
  function parseError(status, text) {
    let msg = '';
    try {
      const obj = JSON.parse(text);
      const e = Array.isArray(obj) ? obj[0] && obj[0].error : obj.error;
      msg = (e && (e.message || (typeof e === 'string' ? e : ''))) || obj.message || obj.msg || '';
    } catch (e) { /* 非 JSON */ }
    if (!msg) msg = String(text || '').slice(0, 500);
    const hint = { 401: 'API Key 无效或未填写', 403: '无权限访问（检查 Key/地区/账户）', 404: '地址或模型名不存在',
      429: '请求过于频繁或额度不足', 400: '请求参数有误' }[status];
    return 'HTTP ' + status + (hint ? '（' + hint + '）' : '') + (msg ? '：' + msg : '');
  }

  /** OpenAI 兼容 /images/generations */
  function buildImageRequest(provider, model, prompt, opts) {
    opts = opts || {};
    const body = { model, prompt, n: 1 };
    if (opts.size) body.size = opts.size;
    if (provider.presetId === 'siliconflow') { body.image_size = opts.size || '1024x1024'; delete body.size; body.batch_size = 1; delete body.n; }
    return {
      url: trimSlash(provider.baseUrl) + '/images/generations', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (provider.apiKey || '').trim() },
      body: JSON.stringify(body),
    };
  }

  /** 返回图片 src 列表（URL 或 data:URL） */
  function parseImageResponse(text) {
    const obj = JSON.parse(text);
    const list = obj.data || obj.images || [];
    return list.map(it => it.url ? it.url : (it.b64_json ? 'data:image/png;base64,' + it.b64_json : null)).filter(Boolean);
  }

  const api = { PRESETS, buildChatRequest, createStreamParser, parseFullResponse, parseError, buildImageRequest,
    parseImageResponse, extractDeltas, splitDataUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Providers = api;
})(typeof window !== 'undefined' ? window : globalThis);
