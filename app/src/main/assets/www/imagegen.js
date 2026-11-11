/* 图片生成共享逻辑：独立生图页 + 聊天「据此生图」共用 */
(function (root) {
  'use strict';

  const SIZES = ['1024x1024', '1024x1792', '1792x1024', '512x512', '768x768'];
  const DEFAULT_SIZE = '1024x1024';
  const HISTORY_LIMIT = 10;
  const MSG_SLICE = 280;

  function effectiveModel(provider, modelOverride) {
    const o = (modelOverride == null ? '' : String(modelOverride)).trim();
    if (o) return o;
    return provider ? String(provider.imageModel || '').trim() : '';
  }

  function canGenerate(provider, modelOverride) {
    if (!provider) return { ok: false, reason: '请先选择服务商' };
    if (provider.type !== 'openai') return { ok: false, reason: '图片生成仅支持 OpenAI 兼容接口' };
    if (!provider.hasKey && !(provider.apiKey || '').trim()) return { ok: false, reason: '请先在设置中填写 API Key' };
    const model = effectiveModel(provider, modelOverride);
    if (!model) {
      return { ok: false, reason: '请先填写图片生成模型（或在设置中为「' + (provider.name || '当前服务商') + '」配置 imageModel）' };
    }
    return { ok: true, model: model };
  }

  /** 可作为生图页服务商的候选：OpenAI 兼容（可选手填模型） */
  function listImageProviders(providers) {
    return (providers || []).filter(p => p && p.type === 'openai');
  }

  function normalizeSize(size) {
    const s = String(size || '').trim();
    return s || DEFAULT_SIZE;
  }

  /** 从对话消息提炼可编辑的生图提示词（跳过 imageGen / error / pending） */
  function buildPromptFromMessages(messages, opts) {
    opts = opts || {};
    const limit = opts.limit || HISTORY_LIMIT;
    const slice = opts.slice || MSG_SLICE;
    const list = (messages || []).filter(m => m && !m.imageGen && !m.error && !m.pending &&
      (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim());
    const recent = list.slice(-limit);
    if (!recent.length) return '';
    const lines = recent.map(m => {
      const who = m.role === 'user' ? '用户' : '助手';
      const text = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, slice);
      return who + '：' + text;
    });
    return '根据以下对话内容，生成一张配图：\n' + lines.join('\n');
  }

  function buildRequest(provider, prompt, size, modelOverride, opts) {
    const Providers = root.Providers || (typeof require !== 'undefined' ? require('./providers.js') : null);
    if (!Providers || !Providers.buildImageRequest) throw new Error('Providers 未加载');
    const model = effectiveModel(provider, modelOverride);
    if (!model) throw new Error('缺少图片生成模型');
    opts = opts || {};
    const reqOpts = { size: normalizeSize(size) };
    if (Array.isArray(opts.images) && opts.images.length) reqOpts.images = opts.images;
    return Providers.buildImageRequest(provider, model, prompt, reqOpts);
  }

  function parseResponse(text) {
    const Providers = root.Providers || (typeof require !== 'undefined' ? require('./providers.js') : null);
    if (!Providers || !Providers.parseImageResponse) throw new Error('Providers 未加载');
    return Providers.parseImageResponse(text);
  }

  /**
   * 单次 /images/generations 无真实百分比时，用耗时阶段 + 可选 HTTP 信号给出状态文案。
   * @param {number} elapsedMs
   * @param {{ receiving?: boolean, httpStarted?: boolean }} [opts]
   */
  function progressStage(elapsedMs, opts) {
    opts = opts || {};
    if (opts.receiving) return { key: 'receiving', text: '正在接收…' };
    if (opts.httpStarted) return { key: 'waiting', text: '等待结果…' };
    const s = Math.max(0, Number(elapsedMs) || 0) / 1000;
    if (s < 1.2) return { key: 'sent', text: '请求已发送…' };
    if (s < 8) return { key: 'generating', text: '生成中…' };
    if (s < 22) return { key: 'waiting', text: '等待结果…' };
    return { key: 'still', text: '仍在生成，请稍候…' };
  }

  function formatElapsed(elapsedMs) {
    const s = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    return s + ' 秒';
  }

  /** FLUX/Seedream 档位模型：委托 Providers（未加载时用本地启发） */
  function isFluxTierModel(model, provider) {
    const Providers = root.Providers || (typeof require !== 'undefined' ? require('./providers.js') : null);
    if (Providers && Providers.isFluxTierModel) return Providers.isFluxTierModel(model, provider);
    const id = String(model || '').toLowerCase();
    return /flux[\-._]?3/.test(id) || (/black-forest-labs\//.test(id) && /flux/.test(id));
  }

  /** 生图页尺寸下拉：FLUX 时用更清晰的档位标签，value 仍为 WxH */
  function sizeOptionLabel(size, fluxTier) {
    if (!fluxTier) return size;
    const Providers = root.Providers || (typeof require !== 'undefined' ? require('./providers.js') : null);
    if (Providers && Providers.pixelSizeToTier) {
      const t = Providers.pixelSizeToTier(size);
      const square = t.aspect_ratio === '1:1';
      return t.resolution + ' · ' + (square ? '正方形' : t.aspect_ratio);
    }
    return size;
  }


  /**
   * 从服务商 models 列表中筛出图片模型（Providers.classifyModel + modelMeta）。
   * 去重并保持原顺序；无 Providers 时返回空数组。
   */
  function listImageModels(provider) {
    const Providers = root.Providers || (typeof require !== 'undefined' ? require('./providers.js') : null);
    if (!Providers || !Providers.classifyModel) return [];
    const models = provider && Array.isArray(provider.models) ? provider.models : [];
    const meta = (provider && provider.modelMeta) || {};
    const out = [];
    const seen = Object.create(null);
    for (let i = 0; i < models.length; i++) {
      const id = models[i] == null ? '' : String(models[i]).trim();
      if (!id || seen[id]) continue;
      if (Providers.classifyModel(id, meta[id]) === 'image') {
        seen[id] = true;
        out.push(id);
      }
    }
    return out;
  }

  /** 当前模型若在列表中则返回该值，否则返回 ''（不覆盖手动输入） */
  function matchImageModelSelect(models, current) {
    const cur = (current == null ? '' : String(current)).trim();
    if (cur && Array.isArray(models) && models.indexOf(cur) >= 0) return cur;
    return '';
  }

  const api = { SIZES, DEFAULT_SIZE, HISTORY_LIMIT, canGenerate, effectiveModel, listImageProviders,
    normalizeSize, buildPromptFromMessages, buildRequest, parseResponse, progressStage, formatElapsed,
    isFluxTierModel, sizeOptionLabel, listImageModels, matchImageModelSelect };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ImageGen = api;
})(typeof window !== 'undefined' ? window : globalThis);
