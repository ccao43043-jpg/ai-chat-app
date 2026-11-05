// 主页角色卡片：纯函数映射 / 筛选（供 app.js 与单测共用）
(function (root) {
  // 强性别词优先；职业词仅在无强词时作弱启发
  const STRONG_F = /女[性孩孩王神神仙]|女剑|女侠|女神|女王|女子|女性|她|姑娘|小姐|夫人|公主|太后|妃|妾|魔女|御姐|萝莉|少女|女孩|姐妹|妈妈|母亲/;
  const STRONG_F2 = /(?:^|[^\w])女(?:$|[^\w])/; // 单字「女」
  const STRONG_M = /男[性孩孩]|男子|男性|他(?!们)|少爷|先生|王子|皇帝|将军|少年|男孩|兄弟|爸爸|父亲|汉子/;
  const WEAK_F = /娘|姐|妹|姬|妮|琳|娜|雪|梅|芳|婷|倩|蓉|薇|艳|丽|妇|妻|母|妈/;
  const WEAK_M = /哥|弟|叔|爷|父|爸|侠|僧|君|郎|雄|豪|凯|俊|伟|强|修罗|战士/;

  function guessGender(ps) {
    if (!ps) return 'unknown';
    if (ps.gender === 'male' || ps.gender === 'female') return ps.gender;
    const tags = Array.isArray(ps.tags) ? ps.tags.join(' ') : (ps.tags || '');
    const blob = [ps.name, ps.desc, ps.systemPrompt && String(ps.systemPrompt).slice(0, 160), tags].filter(Boolean).join(' ');
    const strongF = STRONG_F.test(blob) || /女/.test(blob);
    const strongM = STRONG_M.test(blob) || /男/.test(blob);
    if (strongF && !strongM) return 'female';
    if (strongM && !strongF) return 'male';
    if (strongF && strongM) {
      // 同时出现时：以「女X」类复合词优先女，否则 unknown
      if (/女\w|女剑|女侠|女神|女王/.test(blob)) return 'female';
      if (/男\w|男剑|男主/.test(blob)) return 'male';
      return 'unknown';
    }
    const weakF = WEAK_F.test(blob);
    const weakM = WEAK_M.test(blob);
    if (weakF && !weakM) return 'female';
    if (weakM && !weakF) return 'male';
    return 'unknown';
  }

  function cardDesc(ps) {
    if (!ps) return '';
    const raw = (ps.desc || ps.systemPrompt || '').replace(/\s+/g, ' ').trim();
    return raw.length > 72 ? raw.slice(0, 72) + '…' : raw;
  }

  function toCardModel(ps) {
    if (!ps) return null;
    return {
      id: ps.id,
      name: ps.name || '未命名',
      desc: cardDesc(ps),
      emoji: ps.emoji || '🎭',
      cover: ps.avatar || ps.cover || ps.image || '',
      gender: guessGender(ps),
      tags: Array.isArray(ps.tags) ? ps.tags.slice(0, 3) : [],
      builtin: !!ps.builtin,
      lore: !!(ps.loreText || ps.character_book),
    };
  }

  function filterCards(list, filter) {
    const f = filter || 'all';
    const arr = (list || []).map(toCardModel).filter(Boolean);
    if (f === 'male') return arr.filter(c => c.gender === 'male' || c.gender === 'unknown');
    if (f === 'female') return arr.filter(c => c.gender === 'female' || c.gender === 'unknown');
    return arr;
  }

  const api = { guessGender, cardDesc, toCardModel, filterCards };
  root.HomeCards = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
