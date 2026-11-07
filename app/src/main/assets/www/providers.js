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
      // 优先专用输出模态（如 text+image->text+image 归为图片）
      if (/embed/.test(out) || (!out && /embed/.test(mod))) return 'embedding';
      if (/video/.test(out)) return 'video';
      if (/image/.test(out)) return 'image';
      if (/audio|speech/.test(out)) return 'speech';
      if (/transcri/.test(out)) return 'transcription';
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
    // OpenRouter 默认只返回文本输出模型，需 output_modalities=all 才含图片/视频等
    if (provider.presetId === 'openrouter' || /openrouter\.ai/i.test(base)) {
      return { url: base + '/models?output_modalities=all', method: 'GET', headers: { 'Authorization': 'Bearer ' + key } };
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
      const pr = parsePricing(m.pricing);
      if (pr) o.price = pr;
      if (Object.keys(o).length) out[id] = o;
    });
    return out;
  }

  /**
   * OpenRouter pricing（美元/Token 字符串）-> { prompt, completion, cacheRead, image, imageOut }
   * prompt/completion/cacheRead/imageOut 存为「美元/百万 Token」（与用量页一致）；image 为「美元/张」。
   * 缺失、0、负数（如 openrouter/auto 的 -1）均不保存；全部缺失返回 null。
   */
  function parsePricing(pr) {
    return pricingFromRaw(pr, 1);
  }
  /** 将美元/Token（及 image 美元/张）按 factor 折算为现有 $/M 结构；factor 通常为 1（OpenRouter catalog/endpoints 价已含折扣，勿再乘 1-discount） */
  function pricingFromRaw(pr, factor) {
    if (!pr || typeof pr !== 'object') return null;
    const f = Number(factor); const mul = isFinite(f) && f > 0 ? f : 0;
    if (!mul) return null;
    const num = v => { const n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
    const r = x => Math.round(x * 1e6) / 1e6;
    const o = {};
    const perM = { prompt: pr.prompt, completion: pr.completion, cacheRead: pr.input_cache_read, imageOut: pr.image_output };
    Object.keys(perM).forEach(k => { const n = num(perM[k]) * mul; if (n > 0) o[k] = r(n * 1e6); });
    const img = num(pr.image) * mul; if (img > 0) o.image = r(img);
    return Object.keys(o).length ? o : null;
  }
  /**
   * endpoints 单项 pricing → $/M。OpenRouter 返回的 prompt/completion 已是折后实付价，
   * pricing.discount 仅为元数据，绝不能再乘 (1 - discount)（否则 Flex 会被二次打折）。
   * 0/负价丢弃。
   */
  function effectiveTokenPricing(pr) {
    if (!pr || typeof pr !== 'object') return null;
    return pricingFromRaw(pr, 1);
  }
  /** 在 endpoints 数组中选有效价最低的一端（比较 prompt+completion，同分再比 prompt） */
  function floorPricingFromEndpoints(endpoints) {
    if (!Array.isArray(endpoints) || !endpoints.length) return null;
    let best = null, bestSum = Infinity, bestPrompt = Infinity;
    endpoints.forEach(ep => {
      const eff = effectiveTokenPricing(ep && ep.pricing);
      if (!eff) return;
      const sum = (eff.prompt || 0) + (eff.completion || 0);
      const prompt = eff.prompt || 0;
      if (sum < bestSum || (sum === bestSum && prompt < bestPrompt)) {
        best = eff; bestSum = sum; bestPrompt = prompt;
      }
    });
    return best;
  }
  /** GET {base}/models/{modelId}/endpoints（modelId 按路径段 encode，保留 /） */
  function buildEndpointsRequest(provider, modelId) {
    const base = trimSlash(provider.baseUrl);
    const key = (provider.apiKey || '').trim();
    const pathId = String(modelId || '').split('/').map(encodeURIComponent).join('/');
    return { url: base + '/models/' + pathId + '/endpoints', method: 'GET', headers: { 'Authorization': 'Bearer ' + key } };
  }
  /** 解析 endpoints 响应 -> endpoints 数组 */
  function parseEndpointsResponse(text) {
    let obj; try { obj = JSON.parse(text); } catch (e) { return []; }
    if (Array.isArray(obj)) return obj;
    if (obj && Array.isArray(obj.endpoints)) return obj.endpoints;
    if (obj && obj.data && Array.isArray(obj.data.endpoints)) return obj.data.endpoints;
    if (obj && Array.isArray(obj.data)) return obj.data;
    return [];
  }
  function fmtUsd(n) {
    if (n >= 100) return '$' + n.toFixed(0);
    if (n >= 0.01) return '$' + n.toFixed(2);
    return '$' + Number(n.toPrecision(2));
  }
  /** meta -> 「输入 $0.50 / 输出 $3.00 · 百万Token」/「约 $0.01/张」/「—」；floor 时前缀「最低 」 */
  function formatModelPrice(meta) {
    const p = (meta && (meta.priceFloor || meta.price)); if (!p) return '—';
    const parts = [];
    if (p.prompt || p.completion) {
      parts.push((p.prompt ? '输入 ' + fmtUsd(p.prompt) : '输入 —') + ' / ' + (p.completion ? '输出 ' + fmtUsd(p.completion) : '输出 —') + ' · 百万Token');
    } else if (p.imageOut) parts.push('图片输出 ' + fmtUsd(p.imageOut) + ' · 百万Token');
    if (p.image && !parts.length) parts.push('约 ' + fmtUsd(p.image) + '/张');
    if (!parts.length) return '—';
    const body = parts.join(' · ');
    const isFloor = !!(meta && (meta.priceIsFloor || meta.priceFloor));
    return isFloor ? '最低 ' + body : body;
  }
  function formatContext(n) { return n >= 1e6 ? +(n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n); }

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
  /** Claude 消息的内容块数（文本块 + 图片块） */
  function claudeBlocks(bm) {
    if (typeof bm.content === 'string') return bm.content ? 1 : 0;
    return Array.isArray(bm.content) ? bm.content.length : 0;
  }
  function claudeHasText(bm) {
    if (typeof bm.content === 'string') return !!bm.content;
    return Array.isArray(bm.content) && bm.content.some(b => b && b.type === 'text' && b.text);
  }
  /** 在消息的最后一个 text 块上打 cache_control（不打在图片块上；无文本块则跳过） */
  function markLastText(bm, cc) {
    if (typeof bm.content === 'string') { if (bm.content) bm.content = [{ type: 'text', text: bm.content, cache_control: cc }]; return; }
    for (let j = bm.content.length - 1; j >= 0; j--) {
      const b = bm.content[j];
      if (b && b.type === 'text' && b.text) { bm.content[j] = Object.assign({}, b, { cache_control: cc }); return; }
    }
  }
  /**
   * Claude 历史断点：以最后一个 _cache 标记的消息为末尾断点，向前每累计 ≥ every（默认 15）个块插一个锚点；
   * 历史断点最多 max 个（≤3，连同 system ≤ 4），只选含文本块的消息。返回升序消息下标。
   */
  function claudeCacheAnchors(bodyMessages, marked, max, every) {
    max = Math.max(0, Math.min(3, max == null ? 3 : max)); every = every || 15;
    if (!max || !marked || !marked.length) return [];
    let tail = marked[marked.length - 1];
    while (tail >= 0 && !claudeHasText(bodyMessages[tail])) tail--;
    if (tail < 0) return [];
    const out = [tail];
    let since = claudeBlocks(bodyMessages[tail]);
    for (let i = tail - 1; i >= 0 && out.length < max; i--) {
      since += claudeBlocks(bodyMessages[i]);
      if (since >= every && claudeHasText(bodyMessages[i])) { out.push(i); since = 0; }
    }
    return out.reverse();
  }
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
      // RP 缓存优化器（强制启用于 Claude 时）：system + 稳定历史末尾 + 历史锚点（每 ~15 块一个，历史最多 3 个，总数 ≤ 4）
      // Anthropic 每个断点只向前回溯 20 个内容块；一轮新增很多块（如图片）时，锚点保证上一轮写入点仍在窗口内。
      if (opts.cacheControl) {
        const cc = { type: 'ephemeral' };
        if (sys) body.system = [{ type: 'text', text: sys, cache_control: cc }];
        const marked = [];
        msgs.forEach((m, i) => { if (m._cache) marked.push(i); });
        const idx = claudeCacheAnchors(body.messages, marked, sys ? 3 : 4);
        idx.forEach(i => markLastText(body.messages[i], cc));
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
      if (opts.jsonMode) gc.responseMimeType = 'application/json';
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
    // C-2：cacheSystemSplit = 字符偏移；在 summary|memory 交界额外加一个断点（两段各自成块）
    const split = cc && opts.cacheSystem !== false && opts.cacheSystemSplit > 0 && opts.cacheSystemSplit < (sys || '').length ? opts.cacheSystemSplit : 0;
    if (sys) out.push({ role: 'system', content: split
      ? [{ type: 'text', text: sys.slice(0, split), cache_control: { type: 'ephemeral' } }, { type: 'text', text: sys.slice(split), cache_control: { type: 'ephemeral' } }]
      : cc && opts.cacheSystem !== false ? mark(sys) : sys });
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
    if (opts.jsonMode && jsonModeSupported(provider)) body.response_format = { type: 'json_object' }; // v0.7.5：设定提取等结构化调用
    // OpenRouter：缓存亲和路由（有效成本）或回退 sort:'price'
    if (provider.presetId === 'openrouter' || /openrouter\.ai/i.test(base)) {
      const affinity = opts.cacheAffinity !== false && (provider.cacheAffinity !== false);
      const Router = root.Router;
      if (affinity && Router && opts.providerOrder && opts.providerOrder.length) {
        body.provider = Object.assign({}, body.provider || {}, Router.buildProviderField(opts.providerOrder[0], { enabled: true }));
      } else if (affinity && Router && opts.routeSlug) {
        body.provider = Object.assign({}, body.provider || {}, Router.buildProviderField(opts.routeSlug, { enabled: true }));
      } else if (affinity && Router && Array.isArray(opts.routePrices) && opts.routePrices.length) {
        const st = (opts.routerState && opts.routerModel)
          ? Router.ensureModel(opts.routerState, opts.routerModel)
          : (opts.routerModelState || {});
        const chosen = Router.chooseUpstream(opts.routePrices, st, opts.routeCurrent || (st && st.current) || null, opts.prefixTokens || 0, opts.routerOpts);
        if (chosen) {
          body.provider = Object.assign({}, body.provider || {}, Router.buildProviderField(chosen, { enabled: true }));
          if (opts.onRouteChosen) opts.onRouteChosen(chosen);
        } else {
          body.provider = Object.assign({}, body.provider || {}, { sort: 'price' });
        }
      } else {
        // 旧行为 / 开关关闭
        body.provider = Object.assign({}, body.provider || {}, { sort: 'price' });
      }
    }
    const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };
    if (stream) headers['Accept'] = 'text/event-stream';
    return { url: base + '/chat/completions', method: 'POST', headers, body: JSON.stringify(body) };
  }

  /** 已核实支持 response_format: json_object 的 OpenAI 兼容服务商 */
  function jsonModeSupported(provider) {
    const p = provider || {};
    if (p.type !== 'openai') return false;
    return ['openai', 'deepseek', 'qwen', 'qwen-intl', 'openrouter'].includes(p.presetId) || /\/\/api\.(deepseek|openai)\.com/i.test(p.baseUrl || '') || isQwenEndpoint(p);
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
      } else if (num(u.cache_read_input_tokens) !== undefined || num(u.cached_tokens) !== undefined) {
        // 部分 OpenAI 兼容端点（如 MiniMax 原生 / 某些中转）把命中数放在顶层
        out.hit = num(u.cache_read_input_tokens) !== undefined ? u.cache_read_input_tokens : u.cached_tokens;
        out.miss = (out.prompt || 0) - out.hit; out.cacheSupported = true; out.source = 'openai';
      }
      // OpenRouter：本次实际扣费（美元，已含缓存折扣）与缓存节省
      if (num(u.cost) !== undefined) out.cost = u.cost;
      if (u.cost_details && num(u.cost_details.upstream_inference_cost) !== undefined) out.upstreamCost = u.cost_details.upstream_inference_cost;
      // cache_discount：正数 = 因缓存少付的美元；cost_cache：负数 = 节省（部分路由返回此形态）
      if (num(u.cache_discount) !== undefined) out.cacheSaved = u.cache_discount;
      else if (num(u.cost_cache) !== undefined && u.cost_cache < 0) out.cacheSaved = -u.cost_cache;
      else if (u.cost_details && num(u.cost_details.cache_discount) !== undefined) out.cacheSaved = u.cost_details.cache_discount;
      // OpenRouter（Gemini / Claude 等）：缓存写入 Token
      if (num(det.cache_write_tokens) !== undefined && det.cache_write_tokens > 0 && out.cacheWrite === undefined) out.cacheWrite = det.cache_write_tokens;
      // 千问显式缓存：创建缓存的 Token（按输入价 125% 计费）
      if (num(det.cache_creation_input_tokens) !== undefined) {
        out.cacheWrite = det.cache_creation_input_tokens;
        if (out.hit === undefined) { out.hit = 0; out.miss = out.prompt || 0; out.cacheSupported = true; out.source = 'openai'; }
      }
    }
    return Object.keys(out).length ? out : null;
  }
  /**
   * 单条回复的缓存显示数据。无缓存字段时返回 null（不显示假 0）。
   * price：模型价格 { prompt, cacheRead }（美元/百万 Token，可选），仅在服务商没返回节省金额时用于估算。
   * -> { hit, prompt, rate(0–100, 1 位小数), write, saved, savedEstimated, cost }
   */
  function cacheView(u, price) {
    if (!u || !u.cacheSupported || num(u.hit) === undefined) return null;
    const prompt = num(u.prompt);
    const rate = prompt ? Math.round(u.hit / prompt * 1000) / 10 : null;
    const v = { hit: u.hit, prompt: prompt == null ? null : prompt, rate, write: u.cacheWrite || 0, saved: null, savedEstimated: false, cost: num(u.cost) == null ? null : u.cost };
    if (num(u.cacheSaved) !== undefined) v.saved = u.cacheSaved;
    else if (u.hit > 0 && price && num(price.prompt) !== undefined && num(price.cacheRead) !== undefined && price.prompt > price.cacheRead) {
      v.saved = u.hit * (price.prompt - price.cacheRead) / 1e6; v.savedEstimated = true;
    }
    return v;
  }
  function fmtUsdSmall(x) {
    if (x == null) return '';
    if (x === 0) return '$0';
    if (x < 0.0001) return '<$0.0001';
    return '$' + (x < 0.01 ? x.toFixed(4) : x < 1 ? x.toFixed(3) : x.toFixed(2));
  }
  /** 缓存显示文案（简体中文）：{ text, title } 或 null */
  function cacheViewText(v) {
    if (!v) return null;
    const n = x => Number(x).toLocaleString('en-US');
    if (!v.hit) {
      const t = '缓存未命中' + (v.write ? ' · 写入 ' + n(v.write) : '');
      return { text: t, title: '服务商返回 cached_tokens = 0' + (v.prompt != null ? '（输入 ' + n(v.prompt) + ' Token）' : '') };
    }
    const parts = ['缓存命中 ' + n(v.hit) + (v.prompt != null ? ' / ' + n(v.prompt) : '') + ' Token'];
    if (v.rate != null) parts.push('命中率 ' + v.rate + '%');
    if (v.saved != null && v.saved > 0) parts.push((v.savedEstimated ? '约省 ' : '节省 ') + fmtUsdSmall(v.saved));
    if (v.write) parts.push('写入 ' + n(v.write));
    const title = parts.join('，') + (v.cost != null ? '；本次实际费用 ' + fmtUsdSmall(v.cost) : '') + (v.savedEstimated ? '（节省额按模型价估算）' : '');
    return { text: parts.join(' · '), title };
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

  /** OpenRouter 服务商（预设或 baseUrl） */
  function isOpenRouterProvider(provider) {
    if (!provider) return false;
    if (provider.presetId === 'openrouter') return true;
    return /openrouter\.ai/i.test(String(provider.baseUrl || ''));
  }

  /**
   * FLUX 3 / Seedream 等使用 resolution 档位 + aspect_ratio，而非像素 size。
   * 匹配：flux-3 / flux.3 / flux3，或 black-forest-labs/ + flux；可选 openrouter 上的 seedream。
   */
  function isFluxTierModel(model, provider) {
    const id = String(model || '').toLowerCase();
    if (!id) return false;
    if (/flux[\-._]?3/.test(id)) return true;
    if (/black-forest-labs\//.test(id) && /flux/.test(id)) return true;
    if (provider && isOpenRouterProvider(provider) && /seedream/.test(id)) return true;
    return false;
  }

  const ASPECT_RATIOS = [
    '21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1',
    '4:5', '3:4', '5:7', '2:3', '9:16', '1:2', '9:21',
  ];

  function parsePixelSize(size) {
    const m = String(size || '').trim().match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!m) return null;
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    if (!w || !h) return null;
    return { w: w, h: h };
  }

  function resolutionFromLongEdge(maxEdge) {
    if (maxEdge <= 768) return '768';
    if (maxEdge <= 1280) return '1K';
    if (maxEdge <= 1792) return '1.5K';
    if (maxEdge <= 2560) return '2K';
    return '4K';
  }

  function closestAspectRatio(w, h) {
    const r = w / h;
    let best = '1:1', bestDiff = Infinity;
    for (let i = 0; i < ASPECT_RATIOS.length; i++) {
      const parts = ASPECT_RATIOS[i].split(':');
      const ar = Number(parts[0]) / Number(parts[1]);
      const d = Math.abs(ar - r);
      if (d < bestDiff) { bestDiff = d; best = ASPECT_RATIOS[i]; }
    }
    return best;
  }

  /** 像素 WxH → { resolution, aspect_ratio }；无法解析时默认 1K + 1:1 */
  function pixelSizeToTier(size) {
    const wh = parsePixelSize(size);
    if (!wh) return { resolution: '1K', aspect_ratio: '1:1' };
    return {
      resolution: resolutionFromLongEdge(Math.max(wh.w, wh.h)),
      aspect_ratio: closestAspectRatio(wh.w, wh.h),
    };
  }

  /** OpenAI 兼容图像生成；FLUX 档位模型用 resolution+aspect_ratio；OpenRouter 走 /images */
  function buildImageRequest(provider, model, prompt, opts) {
    opts = opts || {};
    const body = { model: model, prompt: prompt, n: 1 };
    const images = Array.isArray(opts.images) ? opts.images.filter(Boolean).slice(0, 10) : [];
    const tier = isFluxTierModel(model, provider);
    const openrouter = isOpenRouterProvider(provider);

    if (tier) {
      const mapped = pixelSizeToTier(opts.size || '1024x1024');
      body.resolution = mapped.resolution;
      body.aspect_ratio = mapped.aspect_ratio;
      delete body.size;
      if (images.length) {
        body.input_references = images.map(function (url) {
          return { type: 'image_url', image_url: { url: url } };
        });
      }
    } else {
      if (opts.size) body.size = opts.size;
      if (provider.presetId === 'siliconflow') {
        body.image_size = opts.size || '1024x1024'; delete body.size; delete body.n;
        if (/kolors/i.test(model)) body.batch_size = 1;
      }
      if (images.length) body.image = images[0];
    }

    const path = openrouter ? '/images' : '/images/generations';
    return {
      url: trimSlash(provider.baseUrl) + path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (provider.apiKey || '').trim() },
      body: JSON.stringify(body),
    };
  }

  /** 返回图片 src 列表（URL 或 data:URL）；尊重 media_type */
  function parseImageResponse(text) {
    const obj = JSON.parse(text);
    const list = obj.data || obj.images || [];
    return list.map(function (it) {
      if (it.url) return it.url;
      if (it.b64_json) {
        const mt = (it.media_type || it.mime_type || 'image/png').trim() || 'image/png';
        return 'data:' + mt + ';base64,' + it.b64_json;
      }
      return null;
    }).filter(Boolean);
  }


  /** 从 endpoints 数组提取路由候选 [{slug,pMiss,pHit,ok}] */
  function endpointRoutePrices(endpoints) {
    if (!Array.isArray(endpoints)) return [];
    const out = [];
    endpoints.forEach(ep => {
      if (!ep) return;
      const slug = ep.tag || ep.provider_name || ep.name || (ep.provider && (ep.provider.slug || ep.provider.name)) || null;
      if (!slug) return;
      const eff = effectiveTokenPricing(ep.pricing);
      if (!eff || !(eff.prompt > 0)) return;
      out.push({
        slug: String(slug),
        pMiss: eff.prompt,
        pHit: eff.cacheRead != null ? eff.cacheRead : eff.prompt,
        ok: true,
        completion: eff.completion || 0,
      });
    });
    return out;
  }

  /** 规划本轮上游：返回 { slug, providerField, view } */
  function planOpenRouterRoute(provider, model, endpoints, routerState, opts) {
    opts = opts || {};
    const Router = root.Router;
    const affinity = opts.cacheAffinity !== false && provider && provider.cacheAffinity !== false;
    if (!affinity || !Router) {
      return { slug: null, providerField: { sort: 'price' }, view: null, affinity: false };
    }
    const prices = endpointRoutePrices(endpoints);
    if (!prices.length) {
      return { slug: null, providerField: { sort: 'price' }, view: null, affinity: true, reason: 'no-prices' };
    }
    const state = routerState || {};
    const ms = Router.ensureModel(state, model || '');
    const chosen = Router.chooseUpstream(prices, ms, ms.current, opts.prefixTokens || 0, opts.routerOpts);
    const field = Router.buildProviderField(chosen, { enabled: true });
    const priceMap = {};
    prices.forEach(p => { priceMap[p.slug] = p; });
    return { slug: chosen, providerField: field, view: Router.panelView(ms, priceMap), affinity: true, prices, state };
  }

  /** 用 usage 更新命中后验 */
  function observeRoute(routerState, model, slug, usage, now) {
    const Router = root.Router;
    if (!Router || !slug || !model) return routerState || {};
    const state = routerState || {};
    const u = usage || {};
    const prompt = typeof u.prompt === 'number' ? u.prompt : 0;
    const hit = typeof u.hit === 'number' ? u.hit : 0;
    if (prompt > 0) Router.observe(state, model, slug, { hitTokens: hit, promptTokens: prompt, ok: true }, now);
    else Router.observe(state, model, slug, { hit: !!(hit > 0), ok: true }, now);
    return state;
  }

  const api = { claudeCacheAnchors, PRESETS, OLD_DEFAULTS, RETIRED, SETTINGS_VERSION, migrateSettings, migrateConversation, migrateModelName,
    buildModelsRequest, parseModelsResponse, buildChatRequest, createStreamParser, parseFullResponse, parseError, buildImageRequest,
    parseImageResponse, extractDeltas, splitDataUrl, normalizeUsage, mergeUsage, cacheView, cacheViewText, streamUsageEnabled, STREAM_USAGE_PRESETS, isQwenEndpoint, jsonModeSupported, parseModelsMeta, parsePricing, effectiveTokenPricing, floorPricingFromEndpoints, buildEndpointsRequest, parseEndpointsResponse, formatModelPrice, formatContext,
    MODEL_CATEGORIES, EXTRA_MODEL_FIELDS, normalizeModelFields, classifyModel,
    isOpenRouterProvider, isFluxTierModel, parsePixelSize, pixelSizeToTier, closestAspectRatio, ASPECT_RATIOS, endpointRoutePrices, planOpenRouterRoute, observeRoute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Providers = api;
})(typeof window !== 'undefined' ? window : globalThis);
