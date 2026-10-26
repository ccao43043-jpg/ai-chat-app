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
    if (!(provider.apiKey || '').trim()) return { ok: false, reason: '请先在设置中填写 API Key' };
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

  const api = { SIZES, DEFAULT_SIZE, HISTORY_LIMIT, canGenerate, effectiveModel, listImageProviders,
    normalizeSize, buildPromptFromMessages, buildRequest, parseResponse, progressStage, formatElapsed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ImageGen = api;
})(typeof window !== 'undefined' ? window : globalThis);
