// secure.js：originOf（Key 源绑定）/ parseJsonl / toJsonl / rebuildIndex
import { loadWww } from '../lib.mjs';
export default function (g) {
  jsonCases(g);
  const S = loadWww('secure.js');
  ['https://OpenRouter.ai:443/api/v1', 'http://10.0.2.2:8080/v1', 'https://user@host/x', 'file:///x', 'https://api.deepseek.com', 'https://api.deepseek.com/',
   'HTTPS://API.X.COM:8443/a?b#c', 'http://a.com:80', 'https://a.com?x=1', 'https://a.com#f', ' https://a.com/v1 ', 'https://', 'ftp://a.com', '',
   'https://[::1]:8080/x', 'https://a_b.com/x', 'https://a.com:abc/', 'https://xn--fiq228c.com/v1', 'http://localhost:11434/v1', 'https://a.com\\@b.com/']
    .forEach(u => g.add('originOf', [u], S.originOf(u)));
  ['{"a":1}\n\n {"b":2} \nbad\n', '', '\n', '{"k":"\\u00e9"}'].forEach(t => g.add('parseJsonl', [t], S.parseJsonl(t).items));
  g.add('rebuildIndex', [[{ id: 'a', title: '', updatedAt: 5 }, { id: 'b', createdAt: 9, personaName: 'P', personaEmoji: 'e' }, null, { title: 'x' }, { id: 'c', updatedAt: '7' }]],
    S.rebuildIndex([{ id: 'a', title: '', updatedAt: 5 }, { id: 'b', createdAt: 9, personaName: 'P', personaEmoji: 'e' }, null, { title: 'x' }, { id: 'c', updatedAt: '7' }]));
}

// Js 值模型自检：JSON.parse → JSON.stringify（数字格式、转义、整数键顺序）必须与 V8 逐字一致
export function jsonCases(g) {
  const texts = ['{"b":1,"a":2,"10":3,"2":4,"-1":5,"01":6,"4294967295":7,"4294967294":8}', '[1.0,1e21,1e-7,0.000001,123456789012345680000,-0,0.1,0.30000000000000004,5e-324,1.7976931348623157e308,2.5e-5,1e300]',
    '"\\u0000\\u001f\\u007f\\u2028\\ud800 \\udc00 \\ud83d\\ude00 \\"\\\\/\\b\\f\\n\\r\\t"', '{"a":{"b":[{"c":null}],"d":true},"a":false}', '[]', '{}', '[[],{},[{}]]'];
  texts.forEach(t => { const v = JSON.parse(t); g.add('stringify', [t], JSON.stringify(v)); g.add('stringifyPretty', [t], JSON.stringify(v, null, 2)); });
  [0, 1, -1, 1.5, 1e21, 1e-7, 123e-20, 0.1 + 0.2, 2 ** 53, 2 ** 53 + 2, 1 / 3, 100, 1e6, 12345.678].forEach(n => g.add('numToString', [n], String(n)));
}
