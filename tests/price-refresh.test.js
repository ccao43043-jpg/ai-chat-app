// OpenRouter 配置页「刷新价格」接线与 force 路径
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('index.html 有 pe-refresh-price 按钮', () => {
  const h = R('app/src/main/assets/www/index.html');
  assert.ok(h.includes('id="pe-refresh-price"'));
  assert.ok(h.includes('刷新价格'));
  assert.ok(h.includes('pe-cat-actions'));
  // 位于模型分类标题旁、pe-fetch 之前
  const iRefresh = h.indexOf('id="pe-refresh-price"');
  const iFetch = h.indexOf('id="pe-fetch"');
  const iTitle = h.indexOf('模型分类');
  assert.ok(iTitle >= 0 && iRefresh > iTitle && iFetch > iRefresh);
});

test('app.js 复用 endpoints floor 并支持 force 刷新', () => {
  const s = R('app/src/main/assets/www/app.js');
  assert.ok(s.includes('function ensureOpenRouterFloor(modelId, opts)'));
  assert.ok(s.includes('opts && opts.force'));
  assert.ok(s.includes('function selectedModelsForFloor'));
  assert.ok(s.includes("refreshOpenRouterFloorPrices(ids, { force: true })") || s.includes('refreshOpenRouterFloorPrices(ids, { force: true })'));
  assert.ok(s.includes("innerHTML = '刷新中…'"));
  assert.ok(s.includes("toast('仅 OpenRouter 支持刷新价格')"));
  assert.ok(s.includes('syncPriceRefreshBtn'));
  assert.ok(s.includes('Providers.buildEndpointsRequest'));
  assert.ok(s.includes('Providers.floorPricingFromEndpoints'));
  assert.ok(s.includes('FLOOR_CONCURRENCY'));
});

test('app.css pe-cat-actions', () => {
  assert.ok(R('app/src/main/assets/www/app.css').includes('.pe-cat-actions'));
});
