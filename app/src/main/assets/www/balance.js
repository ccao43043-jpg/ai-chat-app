/* 各家账户余额查询（v0.3.6）。纯函数：构造请求 + 解析响应。只实现已核实的官方接口。 */
(function (root) {
  'use strict';

  /** 控制台链接（用于「不支持查询」时引导） */
  const CONSOLE = {
    deepseek: 'https://platform.deepseek.com/usage',
    openai: 'https://platform.openai.com/settings/organization/billing',
    qwen: 'https://dashscope.console.aliyun.com/',
    moonshot: 'https://platform.moonshot.cn/console/account',
    zhipu: 'https://open.bigmodel.cn/usercenter/apikeys',
    siliconflow: 'https://cloud.siliconflow.cn/account/ak',
    openrouter: 'https://openrouter.ai/settings/credits',
    anthropic: 'https://console.anthropic.com/settings/plans',
    gemini: 'https://aistudio.google.com/apikey',
    xiaomi: 'https://platform.xiaomimimo.com/',
    custom: '',
  };

  /** 已核实支持余额/额度查询的 presetId */
  const SUPPORTED = new Set(['deepseek', 'siliconflow', 'moonshot', 'openrouter']);

  function trimSlash(u) { return String(u || '').replace(/\/+$/, ''); }
  function originOf(base) {
    try { const u = new URL(base); return u.origin; } catch (e) { return trimSlash(base).replace(/\/v1$/i, ''); }
  }
  /** DeepSeek 文档：余额在 api.deepseek.com/user/balance（不在 /v1 下） */
  function deepseekRoot(base) {
    const t = trimSlash(base);
    if (/api\.deepseek\.com/i.test(t)) return 'https://api.deepseek.com';
    return t.replace(/\/v1$/i, '') || 'https://api.deepseek.com';
  }

  function supportInfo(presetId) {
    const id = presetId || 'custom';
    return {
      supported: SUPPORTED.has(id),
      consoleUrl: CONSOLE[id] || '',
      hint: SUPPORTED.has(id) ? '' : '此服务商未提供可用的余额查询接口，请到官网控制台查看。',
    };
  }

  /**
   * 构造余额查询请求。不支持则返回 null。
   * 认证一律用 Bearer，绝不把 key 写入 URL。
   */
  function buildBalanceRequest(provider) {
    if (!provider || !(provider.hasKey || (provider.apiKey || '').trim())) return null; // v0.9.0：Key 在原生层，由其注入
    const id = provider.presetId || '';
    const key = (provider.apiKey || '').trim();
    const auth = { Authorization: 'Bearer ' + key, Accept: 'application/json' };
    if (id === 'deepseek') {
      return { url: deepseekRoot(provider.baseUrl) + '/user/balance', method: 'GET', headers: auth };
    }
    if (id === 'siliconflow') {
      return { url: trimSlash(provider.baseUrl) + '/user/info', method: 'GET', headers: auth };
    }
    if (id === 'moonshot') {
      return { url: trimSlash(provider.baseUrl) + '/users/me/balance', method: 'GET', headers: auth };
    }
    if (id === 'openrouter') {
      // 普通 API Key 可用 /key；/credits 需要管理密钥，此处不用
      return { url: trimSlash(provider.baseUrl) + '/key', method: 'GET', headers: auth };
    }
    return null;
  }

  function money(n, currency) {
    if (n == null || n === '') return '—';
    const x = typeof n === 'number' ? n : parseFloat(n);
    if (isNaN(x)) return String(n);
    const cur = currency || '';
    const s = Math.abs(x) >= 100 ? x.toFixed(2) : (Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(4));
    if (cur === 'CNY' || cur === '¥') return '¥' + s;
    if (cur === 'USD' || cur === '$') return '$' + s;
    return (cur ? cur + ' ' : '') + s;
  }

  function errOf(status, text) {
    if (status === 401 || status === 403) return 'API Key 无效或无权限（HTTP ' + status + '）';
    if (status === 404) return '接口不存在（HTTP 404）';
    if (status === 429) return '请求过于频繁（HTTP 429）';
    if (!status) return '网络错误，请检查连接';
    let msg = '';
    try {
      const o = JSON.parse(text || '{}');
      msg = (o.error && (o.error.message || o.error)) || o.message || o.msg || '';
      if (typeof msg === 'object') msg = JSON.stringify(msg);
    } catch (e) { msg = (text || '').slice(0, 80); }
    return (msg ? String(msg).slice(0, 120) + ' · ' : '') + 'HTTP ' + status;
  }

  /**
   * 统一结果：
   * { ok, unsupported, error, primary:{label,text}, details:[{label,text}], currency, at }
   * 绝不回传 API Key。
   */
  function parseBalanceResponse(presetId, status, text) {
    const info = supportInfo(presetId);
    if (!info.supported) {
      return { ok: false, unsupported: true, error: info.hint, primary: null, details: [], consoleUrl: info.consoleUrl };
    }
    if (status < 200 || status >= 300) {
      return { ok: false, unsupported: false, error: errOf(status, text), primary: null, details: [], consoleUrl: info.consoleUrl };
    }
    let o;
    try { o = JSON.parse(text || '{}'); } catch (e) {
      return { ok: false, error: '响应不是合法 JSON', primary: null, details: [], consoleUrl: info.consoleUrl };
    }
    try {
      if (presetId === 'deepseek') return parseDeepSeek(o, info);
      if (presetId === 'siliconflow') return parseSiliconFlow(o, info);
      if (presetId === 'moonshot') return parseMoonshot(o, info);
      if (presetId === 'openrouter') return parseOpenRouter(o, info);
    } catch (e) {
      return { ok: false, error: '解析失败：' + (e && e.message || e), primary: null, details: [], consoleUrl: info.consoleUrl };
    }
    return { ok: false, unsupported: true, error: info.hint, primary: null, details: [], consoleUrl: info.consoleUrl };
  }

  function parseDeepSeek(o, info) {
    const list = o.balance_infos || [];
    if (!list.length) return { ok: false, error: '未返回余额信息', primary: null, details: [], consoleUrl: info.consoleUrl };
    const b = list[0];
    const cur = b.currency || 'CNY';
    const details = list.map(x => ({
      label: (x.currency || '') + ' 余额',
      text: money(x.total_balance, x.currency),
    }));
    list.forEach(x => {
      if (x.granted_balance != null) details.push({ label: (x.currency || '') + ' 赠送', text: money(x.granted_balance, x.currency) });
      if (x.topped_up_balance != null) details.push({ label: (x.currency || '') + ' 充值', text: money(x.topped_up_balance, x.currency) });
    });
    if (typeof o.is_available === 'boolean') details.push({ label: '可用状态', text: o.is_available ? '充足' : '不足' });
    return {
      ok: true, primary: { label: '总余额', text: money(b.total_balance, cur) },
      details, currency: cur, consoleUrl: info.consoleUrl,
    };
  }
  function parseSiliconFlow(o, info) {
    const d = o.data || o;
    const total = d.totalBalance != null ? d.totalBalance : d.balance;
    if (total == null) return { ok: false, error: '未返回余额字段', primary: null, details: [], consoleUrl: info.consoleUrl };
    const details = [
      { label: '总余额', text: money(total, 'CNY') },
    ];
    if (d.balance != null && d.balance !== total) details.push({ label: '余额', text: money(d.balance, 'CNY') });
    if (d.chargeBalance != null) details.push({ label: '充值余额', text: money(d.chargeBalance, 'CNY') });
    if (d.status) details.push({ label: '账户状态', text: String(d.status) });
    return { ok: true, primary: { label: '总余额', text: money(total, 'CNY') }, details, currency: 'CNY', consoleUrl: info.consoleUrl };
  }
  function parseMoonshot(o, info) {
    const d = o.data || o;
    if (d.available_balance == null && d.available_balance !== 0) {
      return { ok: false, error: '未返回 available_balance', primary: null, details: [], consoleUrl: info.consoleUrl };
    }
    // 国内 .cn 文档为人民币；国际 .ai 为美元 —— 按 base 无法在此判断，默认标 ¥（国内预设）
    const cur = 'CNY';
    const details = [
      { label: '可用余额', text: money(d.available_balance, cur) },
      { label: '代金券', text: money(d.voucher_balance, cur) },
      { label: '现金', text: money(d.cash_balance, cur) },
    ];
    return { ok: true, primary: { label: '可用余额', text: money(d.available_balance, cur) }, details, currency: cur, consoleUrl: info.consoleUrl };
  }
  function parseOpenRouter(o, info) {
    const d = o.data || o;
    const details = [];
    let primary = null;
    if (d.limit_remaining != null || d.limit != null) {
      primary = { label: 'Key 剩余额度', text: money(d.limit_remaining, 'USD') };
      details.push({ label: 'Key 额度上限', text: d.limit == null ? '无限制' : money(d.limit, 'USD') });
      details.push({ label: 'Key 剩余', text: money(d.limit_remaining, 'USD') });
    }
    if (d.usage != null) details.push({ label: '本 Key 已用', text: money(d.usage, 'USD') });
    if (d.usage_daily != null) details.push({ label: '今日用量', text: money(d.usage_daily, 'USD') });
    if (d.usage_monthly != null) details.push({ label: '本月用量', text: money(d.usage_monthly, 'USD') });
    if (d.is_free_tier != null) details.push({ label: '免费档', text: d.is_free_tier ? '是' : '否' });
    if (!primary && d.usage != null) primary = { label: '本 Key 已用', text: money(d.usage, 'USD') };
    if (!primary) return { ok: false, error: '未返回额度字段', primary: null, details: [], consoleUrl: info.consoleUrl };
    details.push({ label: '说明', text: '账户总余额需管理密钥访问 /credits；此处为当前 Key 的额度与用量' });
    return { ok: true, primary, details, currency: 'USD', consoleUrl: info.consoleUrl };
  }

  const api = { CONSOLE, SUPPORTED, supportInfo, buildBalanceRequest, parseBalanceResponse, money, deepseekRoot };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Balance = api;
})(typeof window !== 'undefined' ? window : globalThis);
