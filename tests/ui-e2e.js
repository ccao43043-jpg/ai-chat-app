const puppeteer = require('puppeteer-core');
(async () => {
  const b = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--allow-file-access-from-files'] });
  const page = await b.newPage();
  await page.setViewport({ width: 390, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.evaluateOnNewDocument(() => {
    const mem = {}; window.__reqs = [];
    window.AndroidBridge = {
      storeGet: k => (k in mem ? mem[k] : null), storeSet: (k, v) => { mem[k] = v; return true; }, storeDelete: k => { delete mem[k]; },
      copy: t => { window.__copied = t; }, toast: () => {}, saveImage: () => {}, cancel: id => { window.__cancelled = id; },
      request: (id, method, url, headers, body) => {
        window.__reqs.push({ url, headers: JSON.parse(headers), body: JSON.parse(body) });
        const H = window.__nativeHttp;
        if (url.includes('anthropic')) { setTimeout(() => { H.onStart(id, 401); H.onChunk(id, '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'); H.onEnd(id); }, 50); return; }
        const text = '好的！下面是一个 **Python** 示例：\n\n```python\ndef hello():\n    print("你好，世界")\n```\n\n| 列1 | 列2 |\n|---|---|\n| a | b |\n';
        const sse = [];
        sse.push('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '用户想要示例代码…' } }] }) + '\n\n');
        for (let i = 0; i < text.length; i += 5) sse.push('data: ' + JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 5) } }] }) + '\n\n');
        sse.push('data: [DONE]\n\n');
        setTimeout(() => H.onStart(id, 200), 20);
        sse.forEach((c, i) => setTimeout(() => H.onChunk(id, c), 30 + i * 15));
        setTimeout(() => H.onEnd(id), 60 + sse.length * 15);
      },
    };
  });
  await page.goto('file://'+require('path').join(__dirname,'../app/src/main/assets/www/index.html'));
  await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: require('path').join(__dirname,'../docs/')+'s1-empty.png' });
  await page.click('#empty-setup'); await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: require('path').join(__dirname,'../docs/')+'s2-settings.png' });
  // 编辑 DeepSeek
  const items = await page.$$('.prov-item'); await items[1].click(); await new Promise(r => setTimeout(r, 400));
  await page.type('#pe-key', 'sk-fake-123');
  await page.screenshot({ path: require('path').join(__dirname,'../docs/')+'s3-provider.png' });
  await page.click('#pe-save'); await new Promise(r => setTimeout(r, 400));
  // 配置 Claude
  await (await page.$$('.prov-item'))[7].click(); await new Promise(r => setTimeout(r, 400));
  await page.type('#pe-key', 'sk-ant-fake'); await page.click('#pe-save'); await new Promise(r => setTimeout(r, 300));
  await page.evaluate(() => window.onAndroidBack()); await new Promise(r => setTimeout(r, 400));
  await page.type('#input', '给我一个 Python 示例');
  await page.click('#btn-send'); await new Promise(r => setTimeout(r, 300));
  const stopShown = await page.$eval('#btn-send', e => e.classList.contains('stop'));
  await page.screenshot({ path: require('path').join(__dirname,'../docs/')+'s4-streaming.png' });
  await new Promise(r => setTimeout(r, 2500));
  await page.screenshot({ path: require('path').join(__dirname,'../docs/')+'s5-chat.png' });
  const res = await page.evaluate(() => ({ req: window.__reqs[0], bubbles: document.querySelectorAll('.bubble').length,
    code: !!document.querySelector('.code-block .hljs'), table: !!document.querySelector('.md table'), title: document.querySelector('#conv-title').textContent,
    model: document.querySelector('#conv-model').textContent }));
  // 复制代码
  await page.click('.code-head button');
  res.copied = await page.evaluate(() => window.__copied);
  // 切换到 Claude
  await page.click('#conv-model'); await new Promise(r => setTimeout(r, 400));
  const chips = await page.$$('#sheet-providers .chip'); await chips[1].click();
  await page.screenshot({ path: require('path').join(__dirname,'../docs/')+'s6-model.png' });
  await page.click('#sheet-ok'); await new Promise(r => setTimeout(r, 300));
  await page.type('#input', '再来一次'); await page.click('#btn-send'); await new Promise(r => setTimeout(r, 600));
  res.claudeReq = await page.evaluate(() => window.__reqs[1]);
  res.errText = await page.evaluate(() => (document.querySelector('.msg.error .bubble') || {}).textContent);
  await page.screenshot({ path: require('path').join(__dirname,'../docs/')+'s7-error.png' });
  await page.click('#btn-menu'); await new Promise(r => setTimeout(r, 400));
  await page.screenshot({ path: require('path').join(__dirname,'../docs/')+'s8-drawer.png' });
  res.convs = await page.$$eval('.conv-item', e => e.length);
  console.log(JSON.stringify({ stopShown, ...res, errors }, null, 1));
  await b.close();
})();
