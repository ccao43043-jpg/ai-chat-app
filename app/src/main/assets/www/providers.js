/* 各家 API 的请求构造与响应解析（纯函数，可在 Node 中单元测试） */
(function (root) {
  'use strict';

  // 预设模型名均已对照各家官方文档核实（2026-10）；用户可随时编辑或「从接口获取模型列表」
  const PRESETS = [
    { presetId: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'], imageModel: 'gpt-image-2.5-flare', videoModel: '', embeddingModel: 'text-embedding-3-small', speechModel: 'tts-1', transcriptionModel: 'whisper-1', vision: true },
    { presetId: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com',
      models: ['deepseek-flash', 'deepseek-v4-pro'], imageModel: '', vision: true },
    // 阿里云百炼（DashScope OpenAI 兼容模式）：help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope · model-pricing（2026-10-15 更新）
    { presetId: 'qwen', name: '阿里云百炼 · 千问（中国）', type: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen-plus', 'qwen-flash', 'qwen-plus-character', 'qwen3-coder-flash', 'qwen3-vl-plus'], imageModel: '', vision: true },
    { presetId: 'qwen-intl', name: '阿里云百炼 · 千问（国际）', type: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      models: ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash', 'qwen-plus', 'qwen-flash', 'qwen3-coder-flash', 'qwen3-vl-plus'], imageModel: '', vision: true },
    { presetId: 'moonshot', name: 'Kimi (Moonshot)', type: 'openai', baseUrl: 'https://api.moonshot.cn/v1',
      models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code'], imageModel: '', vision: true },
    { presetId: 'zhipu', name: '智谱 GLM', type: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-5.3', 'glm-5.3-flash', 'glm-4.7-flash'], imageModel: 'cogview-3-flash', vision: true },
    { presetId: 'siliconflow', name: '硅基流动 SiliconFlow', type: 'openai', baseUrl: 'https://api.siliconflow.cn/v1',
      models: ['deepseek-ai/DeepSeek-V3.2', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3-32B'], imageModel: 'Kwai-Kolors/Kolors', vision: false },
    { presetId: 'xiaomi', name: '小米 MiMo', type: 'openai', baseUrl: 'https://api.xiaomimimo.com/v1',
      models: ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed', 'mimo-v2.5-pro', 'mimo-v2.5'], imageModel: '', vision: true },
    { presetId: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      models: ['openai/gpt-6-astra', 'anthropic/claude-opus-5.5', 'google/gemini-3.8-flash'], imageModel: '', vision: true },
    { presetId: 'anthropic', name: 'Anthropic Claude', type: 'anthropic', baseUrl: 'https://api.anthropic.com',
      models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'], imageModel: '', vision: true },
    { presetId: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      models: ['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-3.5-flash-lite'], imageModel: '', vision: true },
    { presetId: 'custom', name: '自定义（OpenAI 兼容）', type: 'openai', baseUrl: 'https://',
      models: [''], imageModel: '', vision: true },
  ];

  // v0.1.0 的预设默认值（用于升级迁移：用户没改过的列表整体替换为新默认）
  const OLD_DEFAULTS = {
    openai: { models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'], imageModel: 'gpt-image-1' },
    deepseek: { models: ['deepseek-chat', 'deepseek-reasoner'], baseUrl: 'https://api.deepseek.com/v1' },
    qwen: { models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-vl-plus'] },
    moonshot: { models: ['kimi-latest', 'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], name: 'Moonshot (Kimi)' },
    zhipu: { models: ['glm-4-flash', 'glm-4-plus', 'glm-4v-flash'] },
    siliconflow: { models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-R1'] },
    openrouter: { models: ['openai/gpt-4o-mini', 'anthropic/claude-sonnet-4', 'google/gemini-2.5-flash'] },
    anthropic: { models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'] },
    gemini: { models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'] },
  };
  // 官方已下线的模型名 -> 替代模型（对话里用到的也会被替换）
  const RETIRED = {
    deepseek: { 'deepseek-chat': 'deepseek-flash', 'deepseek-reasoner': 'deepseek-flash' },
    moonshot: { 'kimi-latest': 'kimi-k3', 'moonshot-v1-8k': 'kimi-k3', 'moonshot-v1-32k': 'kimi-k3', 'moonshot-v1-128k': 'kimi-k3' },
  };
  const SETTINGS_VERSION = 2;

  function sameSet(a, b) {
    const x = (a || []).filter(Boolean), y = (b || []).filter(Boolean);
    return x.length === y.length && x.every(v => y.includes(v));
  }
  function dedupe(arr) { const out = []; (arr || []).forEach(v => { if (v && !out.includes(v)) out.push(v); }); return out; }

  /** 迁移某个服务商下的模型名（已下线 -> 新名），无需迁移则原样返回 */
  function migrateModelName(presetId, model) {
    const m = RETIRED[presetId];
    return m && m[model] ? m[model] : model;
  }

  /** 迁移设置（不改动 API Key）。返回 { settings, changed } */
  function migrateSettings(settings) {
    const s = settings || {};
    if ((s.settingsVersion || 1) >= SETTINGS_VERSION) return { settings: s, changed: false };
    (s.providers || []).forEach(p => {
      const old = OLD_DEFAULTS[p.presetId];
      const preset = PRESETS.find(x => x.presetId === p.presetId);
      if (!old || !preset) return;
      if (sameSet(p.models, old.models)) p.models = preset.models.slice();
      else p.models = dedupe((p.models || []).map(m => migrateModelName(p.presetId, m)));
      if (!p.models.length) p.models = preset.models.slice();
      if (old.imageModel && p.imageModel === old.imageModel) p.imageModel = preset.imageModel;
      if (old.baseUrl && (p.baseUrl || '').replace(/\/+$/, '') === old.baseUrl) p.baseUrl = preset.baseUrl;
      if (old.name && p.name === old.name) p.name = preset.name;
    });
    const lp = (s.providers || []).find(p => p.id === s.lastProviderId);
    if (lp && s.lastModel) s.lastModel = migrateModelName(lp.presetId, s.lastModel);
    s.settingsVersion = SETTINGS_VERSION;
    return { settings: s, changed: true };
  }

  /** 迁移单个对话的模型名，返回是否有改动 */
  function migrateConversation(conv, providers) {
    const p = (providers || []).find(x => x.id === conv.providerId);
    if (!p) return false;
    const n = migrateModelName(p.presetId, conv.model);
    if (n !== conv.model) { conv.model = n; return true; }
    return false;
  }


  /** 模型分类（API 设置里细分选择）：text 用 models[]，其余为单个主模型字段 */
  const MODEL_CATEGORIES = [
    { key: 'text', label: '文本模型', field: 'models' },
    { key: 'image', label: '图片生成', field: 'imageModel' },
    { key: 'video', label: '视频生成', field: 'videoModel' },
    { key: 'embedding', label: '嵌入向量', field: 'embeddingModel' },
    { key: 'speech', label: '语音合成', field: 'speechModel' },
    { key: 'transcription', label: '语音转写', field: 'transcriptionModel' },
  ];
  const EXTRA_MODEL_FIELDS = ['imageModel', 'videoModel', 'embeddingModel', 'speechModel', 'transcriptionModel'];

  /** 补齐分类字段（缺失 = ''），不改动已有 models / imageModel */
  function normalizeModelFields(p) {
    if (!p || typeof p !== 'object') return p;
    if (!Array.isArray(p.models)) p.models = [];
    EXTRA_MODEL_FIELDS.forEach(f => { if (typeof p[f] !== 'string') p[f] = p[f] == null ? '' : String(p[f]); });
    return p;
  }

  /** 按名称/模态推测模型分类：返回 text|image|video|embedding|speech|transcription|audio */
  function classifyModel(id, meta) {
    const mod = meta && meta.modality ? String(meta.modality).toLowerCase() : '';
    if (mod) {
      const [inp, out = ''] = mod.split('->');
      if (/embed/.test(mod)) return 'embedding';
      if (/video/.test(out)) return 'video';
      if (/image/.test(out) && !/text/.test(out)) return 'image';
      if (/audio/.test(out) && !/text/.test(out)) return 'speech';
      if (/audio/.test(inp) && out.trim() === 'text' && !/image|video/.test(inp) && /whisper|transcri|asr|stt/i.test(id)) return 'transcription';
      if (out) return 'text';
    }
    const n = String(id || '').toLowerCase();
    if (/embed|bge-|\bm3e\b/.test(n)) return 'embedding';
    if (/whisper|transcri|\basr\b|stt|paraformer|sensevoice/.test(n)) return 'transcription';
    if (/tts|speech|cosyvoice|sambert|fishaudio/.test(n)) return 'speech';
    if (/video|sora|kling|wanx?[\d.-]*-?(t2v|i2v)|cogvideo|veo|hunyuanvideo|ltx/.test(n)) return 'video';
    if (/image|kolors|cogview|flux|wanx|dall-?e|stable-diffusion|sdxl|imagen|seedream/.test(n)) return 'image';
    return 'text';
  }

  /** 获取模型列表的请求 */
  function buildModelsRequest(provider) {
    const base = trimSlash(provider.baseUrl);
    const key = (provider.apiKey || '').trim();
    if (provider.type === 'anthropic') {
      return { url: base + '/v1/models?limit=1000', method: 'GET', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } };
    }
    if (provider.type === 'gemini') {
      return { url: base + '/models?pageSize=1000', method: 'GET', headers: { 'x-goog-api-key': key } };
    }
    return { url: base + '/models', method: 'GET', headers: { 'Authorization': 'Bearer ' + key } };
  }

  /** 解析模型列表 -> [id]（Gemini 只保留支持 generateContent 的模型） */
  function parseModelsResponse(type, text) {
    const obj = JSON.parse(text);
    let ids = [];
    if (type === 'gemini') {
      ids = (obj.models || []).filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map(m => String(m.name || '').replace(/^models\//, ''));
    } else {
      const list = Array.isArray(obj) ? obj : (obj.data || obj.models || []);
      ids = list.map(m => typeof m === 'string' ? m : (m.id || m.name || ''));
    }
    return dedupe(ids.filter(Boolean)).sort((a, b) => a.localeCompare(b));
  }

  /** 模型列表中的元数据 -> { id: { context, maxOutput } }（OpenRouter context_length、Anthropic max_input_tokens、Gemini inputTokenLimit 等） */
  function parseModelsMeta(type, text) {
    let obj; try { obj = JSON.parse(text); } catch (e) { return {}; }
    const list = Array.isArray(obj) ? obj : (obj.data || obj.models || []);
    const out = {};
    list.forEach(m => {
      if (!m || typeof m !== 'object') return;
      const id = String(m.id || m.name || '').replace(/^models\//, ''); if (!id) return;
      const ctx = m.context_length || m.context_window || m.max_context_length || m.max_input_tokens || m.inputTokenLimit ||
        (m.top_provider && m.top_provider.context_length) || 0;
      const outT = m.outputTokenLimit || m.max_output_tokens || (m.top_provider && m.top_provider.max_completion_tokens) || 0;
      const arch = m.architecture || {};
      const modality = arch.modality || (arch.input_modalities && arch.output_modalities ? arch.input_modalities.join('+') + '->' + arch.output_modalities.join('+') : '') ||
        (typeof m.modality === 'string' ? m.modality : '') || (m.type && /embed|image|video|audio|tts|stt/i.test(m.type) ? m.type + '->' + m.type : '');
      const o = {};
      if (ctx > 0) { o.context = Number(ctx); if (outT > 0) o.maxOutput = Number(outT); }
      if (modality) o.modality = String(modality);
      if (Object.keys(o).length) out[id] = o;
    });
    return out;
  }

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
      // RP 缓存优化器（强制启用于 Claude 时）：system 与「稳定历史末尾」加 cache_control 断点（最多 2 个，Anthropic 上限 4 个）
      if (opts.cacheControl) {
        const cc = { type: 'ephemeral' };
        if (sys) body.system = [{ type: 'text', text: sys, cache_control: cc }];
        msgs.forEach((m, i) => {
          if (!m._cache) return;
          const bm = body.messages[i];
          if (typeof bm.content === 'string') bm.content = [{ type: 'text', text: bm.content, cache_control: cc }];
          else if (bm.content.length) bm.content[bm.content.length - 1] = Object.assign({}, bm.content[bm.content.length - 1], { cache_control: cc });
        });
      }
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
    // 显式缓存（千问等 OpenAI 兼容接口）：被标记的消息改为数组形式，在最后一段加 cache_control（消息级断点）
    const cc = !!opts.cacheControl;
    const mark = content => {
      const parts = Array.isArray(content) ? content.map(x => Object.assign({}, x)) : [{ type: 'text', text: content || '' }];
      const last = parts[parts.length - 1]; if (last) last.cache_control = { type: 'ephemeral' };
      return parts;
    };
    if (sys) out.push({ role: 'system', content: cc && opts.cacheSystem !== false ? mark(sys) : sys });
    msgs.forEach(m => {
      let content;
      if (m.role === 'user' && m.images && m.images.length) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        m.images.forEach(img => parts.push({ type: 'image_url', image_url: { url: img } }));
        content = parts;
      } else content = m.content || '';
      out.push({ role: m.role, content: cc && m._cache ? mark(content) : content });
    });
    const body = { model, messages: out, stream };
    const th = opts.thinking != null ? opts.thinking : provider.thinking === 'on' ? true : provider.thinking === 'off' ? false : null;
    if (th !== null && isQwenEndpoint(provider)) body.enable_thinking = !!th; // 千问：enable_thinking（思考过程在 reasoning_content 中流式返回）
    if (stream && streamUsageEnabled(provider)) body.stream_options = { include_usage: true };
    if (temp !== undefined) body.temperature = temp;
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    if (stream) headers['Accept'] = 'text/event-stream';
    return { url: base + '/chat/completions', method: 'POST', headers, body: JSON.stringify(body) };
  }

  // 流式请求附带 usage（stream_options.include_usage）：已核实官方文档支持的预设默认开启，其他可在服务商设置里打开
  const STREAM_USAGE_PRESETS = ['openai', 'deepseek', 'qwen', 'qwen-intl', 'openrouter'];
  function streamUsageEnabled(provider) {
    if (!provider || provider.type !== 'openai') return false;
    if (provider.streamUsage === true || provider.streamUsage === false) return provider.streamUsage;
    return STREAM_USAGE_PRESETS.includes(provider.presetId) || /\/\/api\.deepseek\.com/i.test(provider.baseUrl || '') || isQwenEndpoint(provider);
  }
  /** 阿里云百炼 / DashScope 接口（中国、国际、业务空间专属域名） */
  function isQwenEndpoint(provider) {
    const p = provider || {};
    if (p.presetId === 'qwen' || p.presetId === 'qwen-intl') return true;
    return /dashscope(-intl|-us)?\.aliyuncs\.com|\.maas\.aliyuncs\.com|dashscope/i.test(String(p.baseUrl || ''));
  }

  const num = v => (typeof v === 'number' && isFinite(v) ? v : undefined);
  /**
   * 统一 usage 字段：{ prompt, completion, hit, miss, cacheSupported, cacheWrite, source }
   * 只返回响应中出现的字段（流式时可能分几次到达，用 mergeUsage 合并）
   */
  function normalizeUsage(type, u) {
    if (!u || typeof u !== 'object') return null;
    const out = {};
    if (type === 'anthropic') {
      const input = num(u.input_tokens), read = num(u.cache_read_input_tokens), write = num(u.cache_creation_input_tokens);
      if (input !== undefined || read !== undefined || write !== undefined) {
        out.prompt = (input || 0) + (read || 0) + (write || 0);
        if (read !== undefined || write !== undefined) {
          out.hit = read || 0; out.miss = out.prompt - out.hit; out.cacheSupported = true; out.source = 'anthropic';
          if (write) out.cacheWrite = write;
        }
      }
      if (num(u.output_tokens) !== undefined) out.completion = u.output_tokens;
    } else if (type === 'gemini') {
      if (num(u.promptTokenCount) !== undefined) out.prompt = u.promptTokenCount;
      if (num(u.candidatesTokenCount) !== undefined) out.completion = u.candidatesTokenCount + (num(u.thoughtsTokenCount) || 0);
      if (num(u.cachedContentTokenCount) !== undefined) {
        out.hit = u.cachedContentTokenCount; out.miss = (out.prompt || 0) - out.hit; out.cacheSupported = true; out.source = 'gemini';
      }
    } else {
      if (num(u.prompt_tokens) !== undefined) out.prompt = u.prompt_tokens;
      if (num(u.completion_tokens) !== undefined) out.completion = u.completion_tokens;
      const det = u.prompt_tokens_details || {};
      if (num(u.prompt_cache_hit_tokens) !== undefined) { // DeepSeek
        out.hit = u.prompt_cache_hit_tokens;
        out.miss = num(u.prompt_cache_miss_tokens) !== undefined ? u.prompt_cache_miss_tokens : (out.prompt || 0) - out.hit;
        if (out.prompt === undefined) out.prompt = out.hit + out.miss;
        out.cacheSupported = true; out.source = 'deepseek';
      } else if (num(det.cached_tokens) !== undefined) { // OpenAI 等
        out.hit = det.cached_tokens; out.miss = (out.prompt || 0) - out.hit; out.cacheSupported = true; out.source = 'openai';
      }
      // 千问显式缓存：创建缓存的 Token（按输入价 125% 计费）
      if (num(det.cache_creation_input_tokens) !== undefined) {
        out.cacheWrite = det.cache_creation_input_tokens;
        if (out.hit === undefined) { out.hit = 0; out.miss = out.prompt || 0; out.cacheSupported = true; out.source = 'openai'; }
      }
    }
    return Object.keys(out).length ? out : null;
  }
  function mergeUsage(a, b) {
    if (!b) return a || null;
    const out = Object.assign({}, a || {});
    Object.keys(b).forEach(k => { if (b[k] !== undefined) out[k] = b[k]; });
    if (out.cacheSupported && out.prompt !== undefined && out.hit !== undefined) out.miss = Math.max(0, out.prompt - out.hit);
    return out;
  }

  /** 从一个 JSON 事件中提取增量 [{kind:'text'|'reasoning'|'error'|'usage', text|usage}] */
  function extractDeltas(type, obj) {
    const out = [];
    if (!obj) return out;
    if (type === 'anthropic') {
      const au = obj.type === 'message_start' && obj.message ? obj.message.usage : obj.usage;
      const nu = normalizeUsage('anthropic', au);
      if (nu) out.push({ kind: 'usage', usage: nu });
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
      const gu = normalizeUsage('gemini', obj.usageMetadata);
      if (gu) out.push({ kind: 'usage', usage: gu });
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
    const ou = normalizeUsage('openai', obj.usage); // 流式最后一块（DeepSeek 附在最后的内容块上；OpenAI 为 choices 为空的单独一块）
    if (ou) out.push({ kind: 'usage', usage: ou });
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
    if (provider.presetId === 'siliconflow') {
      body.image_size = opts.size || '1024x1024'; delete body.size; delete body.n;
      if (/kolors/i.test(model)) body.batch_size = 1;
    }
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

  const api = { PRESETS, OLD_DEFAULTS, RETIRED, SETTINGS_VERSION, migrateSettings, migrateConversation, migrateModelName,
    buildModelsRequest, parseModelsResponse, buildChatRequest, createStreamParser, parseFullResponse, parseError, buildImageRequest,
    parseImageResponse, extractDeltas, splitDataUrl, normalizeUsage, mergeUsage, streamUsageEnabled, STREAM_USAGE_PRESETS, isQwenEndpoint, parseModelsMeta,
    MODEL_CATEGORIES, EXTRA_MODEL_FIELDS, normalizeModelFields, classifyModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Providers = api;
})(typeof window !== 'undefined' ? window : globalThis);
