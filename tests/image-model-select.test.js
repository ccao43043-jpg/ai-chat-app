// 生图页：图片模型下拉 + 手动输入同步 / persist / 切换服务商刷新
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const www = (...p) => fs.readFileSync(path.join(__dirname, '..', 'app/src/main/assets/www', ...p), 'utf8');

test('生图页 DOM：ig-model-sel 在 ig-model 上方', () => {
  const h = www('index.html');
  const selAt = h.indexOf('id="ig-model-sel"');
  const inpAt = h.indexOf('id="ig-model"');
  assert.ok(selAt > 0, '有 ig-model-sel');
  assert.ok(inpAt > selAt, '下拉在手动输入框上方');
  const c = www('app.css');
  assert.ok(c.includes('#ig-model-sel'));
});

test('app.js：fillImageGenControls 填充下拉，选择同步输入并 persist，切换服务商刷新', () => {
  const j = www('app.js');
  assert.ok(j.includes('function fillImageModelSelect'));
  assert.ok(j.includes('ImageGen.listImageModels'));
  assert.ok(j.includes('Providers.classifyModel') || j.includes('listImageModels'));
  assert.ok(j.includes('function onImageModelSelectChange'));
  assert.ok(j.includes('function syncImageModelSelectFromInput'));
  assert.ok(j.includes("addEventListener('change', () => onImageModelSelectChange())") || j.includes('onImageModelSelectChange()'));
  // 选择下拉时写回输入框并 persist
  const start = j.indexOf('function onImageModelSelectChange');
  const fn = j.slice(start, start + 500);
  assert.ok(fn.includes('modelEl.value'), '下拉同步到输入框');
  assert.ok(fn.includes('persistImageGenSelection'), '下拉变更后 persist');
  // fillImageGenControls 调用 fillImageModelSelect
  const fill = j.slice(j.indexOf('function fillImageGenControls'), j.indexOf('function fillImageGenControls') + 1800);
  assert.ok(fill.includes('fillImageModelSelect(cur, model)'));
  // 切换服务商也更新下拉
  const ch = j.slice(j.indexOf('function onImageGenProviderChange'), j.indexOf('function onImageGenProviderChange') + 900);
  assert.ok(ch.includes('fillImageModelSelect(p, next)'));
  // 手动输入若在列表中则同步选中，不在列表中不覆盖输入
  const sync = j.slice(j.indexOf('function syncImageModelSelectFromInput'), j.indexOf('function syncImageModelSelectFromInput') + 700);
  assert.ok(sync.includes('matchImageModelSelect'));
  assert.ok(sync.includes('sel.value = matched'));
  assert.ok(!sync.includes('modelEl.value ='), '同步时不覆盖手动输入');
});
