const test = require('node:test');
const assert = require('node:assert');
const H = require('../app/src/main/assets/www/home-cards.js');

test('toCardModel 映射 name/desc/emoji，无封面时 cover 为空', () => {
  const c = H.toCardModel({ id: 'p1', name: '林晚', desc: '一位神秘的东方女剑客', emoji: '🗡️', systemPrompt: '你是林晚' });
  assert.strictEqual(c.name, '林晚');
  assert.strictEqual(c.emoji, '🗡️');
  assert.ok(c.desc.includes('神秘'));
  assert.strictEqual(c.cover, '');
  assert.strictEqual(c.gender, 'female');
});

test('cardDesc 优先 desc，过长截断', () => {
  assert.strictEqual(H.cardDesc({ desc: '短简介' }), '短简介');
  const long = '字'.repeat(100);
  assert.ok(H.cardDesc({ systemPrompt: long }).endsWith('…'));
  assert.ok(H.cardDesc({ systemPrompt: long }).length <= 73);
});

test('filterCards：推荐=全部；男/女含启发式 unknown', () => {
  const list = [
    { id: '1', name: '阿修', desc: '拥有火焰力量的战士', emoji: '🔥' },
    { id: '2', name: '林晚', desc: '一位神秘的东方女剑客', emoji: '🗡️' },
    { id: '3', name: '白泽', desc: '上古神兽，博学多闻', emoji: '🐉' },
  ];
  assert.strictEqual(H.filterCards(list, 'all').length, 3);
  const males = H.filterCards(list, 'male');
  const females = H.filterCards(list, 'female');
  assert.ok(males.some(c => c.id === '1'));
  assert.ok(females.some(c => c.id === '2'));
  // unknown 同时出现在男/女，避免空列表
  assert.ok(males.some(c => c.id === '3') && females.some(c => c.id === '3'));
});

test('guessGender 尊重显式 gender 字段', () => {
  assert.strictEqual(H.guessGender({ name: 'X', gender: 'male' }), 'male');
  assert.strictEqual(H.guessGender({ name: 'X', gender: 'female' }), 'female');
});
