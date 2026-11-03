// Character Card V2：PNG tEXt chara 导入/导出
const test = require('node:test');
const assert = require('node:assert');
const CC = require('../app/src/main/assets/www/charcard.js');
const R = require('../app/src/main/assets/www/rpcache.js');

const SAMPLE = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '艾琳',
    description: '王国骑士，执着于守护。',
    personality: '冷静、寡言、重诺。',
    scenario: '王都城墙下的雨夜。',
    first_mes: '……你就是新来的佣兵？',
    mes_example: '{{user}}: 你好\n{{char}}: 嗯。',
    system_prompt: '保持角色口吻。',
    post_history_instructions: '不要跳出角色。',
    alternate_greetings: ['雨越下越大。'],
    character_book: {
      name: '艾琳 lore',
      entries: [
        { keys: ['王都', '王城'], content: '王都有三重城墙', comment: '王都', enabled: true, insertion_order: 1, priority: 50, probability: 100 },
        { keys: [], content: '魔法需要代价', comment: '法则', constant: true, enabled: true, insertion_order: 0, priority: 100 },
        { keys: ['龙'], secondary_keys: ['鳞片'], selectiveLogic: 3, content: '龙的鳞片可炼药', comment: '龙', enabled: true, probability: 100 },
      ],
    },
  },
};

test('cardToPersona 映射 persona + 世界书', () => {
  const p = CC.cardToPersona(SAMPLE);
  assert.strictEqual(p.name, '艾琳');
  assert.ok(p.systemPrompt.includes('王国骑士'));
  assert.ok(p.systemPrompt.includes('冷静'));
  assert.ok(p.firstMes.includes('佣兵'));
  assert.ok(p.loreText.includes('## 法则 | *'));
  assert.ok(p.loreText.includes('## 王都 |'));
  const lore = R.parseLore(p.loreText);
  assert.ok(lore.some(e => e.mode === 'constant' && e.content.includes('魔法需要代价')));
  assert.ok(lore.some(e => e.keys.includes('王都')));
  const dragon = lore.find(e => e.name === '龙');
  assert.ok(dragon);
  assert.deepStrictEqual(dragon.secondaryKeys, ['鳞片']);
  assert.strictEqual(dragon.secondaryLogic, 'AND_ALL');
});

test('PNG 往返：writeCardToPng → parseCard', () => {
  const png = CC.writeCardToPng(SAMPLE);
  assert.ok(CC.isPng(png));
  const raw = CC.extractCharaRaw(png);
  assert.ok(raw && raw.length > 20);
  const card = CC.parseCard(png);
  assert.strictEqual(card.spec, 'chara_card_v2');
  assert.strictEqual(card.data.name, '艾琳');
  assert.ok(card.data.character_book.entries.length >= 3);
});

test('personaToCard 反向导出含世界书', () => {
  const p = CC.cardToPersona(SAMPLE);
  // 注入 RPCache 以便 personaToCard 解析 loreText
  global.RPCache = R;
  const card = CC.personaToCard(p);
  assert.strictEqual(card.data.name, '艾琳');
  assert.ok(card.data.character_book.entries.some(e => e.constant && String(e.content).includes('魔法')));
  assert.ok(card.data.character_book.entries.some(e => (e.keys || []).includes('王都')));
});

test('损坏 PNG / 无 chara 时报错', () => {
  assert.throws(() => CC.parseCard(new Uint8Array([1, 2, 3, 4])), /PNG|识别/);
  const bare = CC.minimalPng();
  assert.throws(() => CC.parseCard(bare), /chara/);
});
