// 版本一致性：package.json / desktop / Gradle / APP_VERSION / about-ver
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('各处版本号一致', () => {
  const v = JSON.parse(R('package.json')).version;
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(JSON.parse(R('desktop/package.json')).version, v, 'desktop/package.json');
  const lock = 'desktop/package-lock.json';
  if (fs.existsSync(path.join(__dirname, '..', lock))) assert.strictEqual(JSON.parse(R(lock)).version, v, lock);
  const g = /versionName\s+['"]([^'"]+)['"]/.exec(R('app/build.gradle'));
  assert.ok(g, 'Gradle versionName'); assert.strictEqual(g[1], v, 'Gradle versionName');
  assert.ok(/versionCode\s+\d+/.test(R('app/build.gradle')), 'versionCode');
  const a = /const APP_VERSION = '([^']+)'/.exec(R('app/src/main/assets/www/app.js'));
  assert.ok(a, 'APP_VERSION'); assert.strictEqual(a[1], v, 'APP_VERSION');
  const h = /id="about-ver">v([\d.]+)/.exec(R('app/src/main/assets/www/index.html'));
  assert.ok(h, 'about-ver'); assert.strictEqual(h[1], v, 'about-ver');
  assert.ok(R('CHANGELOG.md').includes('v' + v), 'CHANGELOG 含当前版本');
  assert.ok(R('README.md').includes('**v' + v), 'README 功能标题含当前版本');
  assert.ok(R('README.md').includes('`' + v + '`'), 'README 含 Android/npm 版本');
});

test('renderMarkdown LRU 缓存规格', () => {
  const s = R('app/src/main/assets/www/app.js');
  assert.ok(/MD_CACHE_MAX = 80/.test(s) && /HL_CACHE_MAX = 300/.test(s) && /MD_CACHE_TEXT_MAX = 20000/.test(s));
  assert.ok(s.includes('mdHtmlCache') && s.includes('hlCache'));
  assert.ok(s.includes('{ streaming: !!m.pending }'));
});
