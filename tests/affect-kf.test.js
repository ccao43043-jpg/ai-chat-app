// D/KF：观测融合 + 卡尔曼 + CUSUM + 一致性 + 多角色 + legacy 回退（§5.2）
const test = require('node:test');
const assert = require('node:assert');
globalThis.Plugins = require('../app/src/main/assets/www/plugins.js');
const A = require('../app/src/main/assets/www/affect.js');
const T0 = new Date(2026, 10, 3, 10, 0, 0).getTime();
const KF = { estimator: 'kf' };
const LEGACY = { estimator: 'legacy' };

test('lexiconScore：正负/否定/程度', () => {
  assert.ok(A.lexiconScore('谢谢你，好可爱') > 0);
  assert.ok(A.lexiconScore('滚，你这个废物') < 0);
  // 否定翻转：不喜欢 → 负向或接近 0 的负贡献被翻转成正？「不」+「喜欢」→ 喜欢被否定 → 负分变号 → 正分抵消/变负
  // 实现：命中「喜欢」前有「不」→ weight 为负 → score += 1 * (-w) → 负分
  assert.ok(A.lexiconScore('不喜欢') < 0);
  assert.ok(A.lexiconScore('非常喜欢你') > A.lexiconScore('喜欢你'));
  assert.strictEqual(A.lexiconScore(''), 0);
  assert.ok(A.lexiconScore('谢谢谢谢谢谢谢谢') <= 2); // 夹紧
});

test('KF：单次尖峰不掀翻；连续同向会推动', () => {
  // 稳态附近，一次 y=+2 不应把 x 直接打到 2
  let kf = { x: 0, P: 0.1 };
  const spike = A.kfUpdate(kf, 2, 0.3);
  assert.ok(spike.x < 1.2, '单次尖峰 x=' + spike.x);
  // 连续同向
  kf = { x: 0, P: 0.1 };
  for (let i = 0; i < 12; i++) kf = A.kfUpdate(kf, 1.5, 0.3);
  assert.ok(kf.x > 0.8, '连续同向应推动 x=' + kf.x);
});

test('鲁棒门控：|y−â|>3σ 时收缩 50%', () => {
  const kf = A.kfUpdate({ x: 0, P: 0.05 }, 2, 0.3);
  // PPrior=0.09, gate=3*sqrt(0.39)≈1.87；|2-0|=2>1.87 → robust
  assert.strictEqual(kf.robust, true);
  // yUsed = 0 + 0.5*2 = 1
  assert.ok(Math.abs(kf.yUsed - 1) < 1e-6, 'yUsed=' + kf.yUsed);
});

test('CUSUM：阈值附近来回抖时档位不抖；累积够才升档', () => {
  // 在 k_up 附近抖动：x 交替 0.1 / 0.2，S 难持续超 h
  let cu = { sp: 0, sm: 0, dwell: 0, tier: 2 };
  const tier0 = cu.tier;
  for (let i = 0; i < 20; i++) {
    cu = A.cusumUpdate(cu, i % 2 === 0 ? 0.12 : 0.18, 0.3);
  }
  assert.strictEqual(cu.tier, tier0, '抖动不应升档 tier=' + cu.tier);

  // 持续高 â：应在 dwell>=4 且 S 累积后升档
  cu = { sp: 0, sm: 0, dwell: 0, tier: 2 };
  let raised = false;
  for (let i = 0; i < 30; i++) {
    cu = A.cusumUpdate(cu, 0.6, 0.3); // 每轮 +0.45 到 S+
    if (cu.changed) { raised = true; break; }
  }
  assert.ok(raised, '连续高 â 应升档');
  assert.strictEqual(cu.tier, 3);
});

test('一致性：关心词 + 自报 a≤-1 → w 打折 + inconsistent', () => {
  const c = A.checkConsistency('别难过，我在陪你抱抱', -1, '不悦');
  assert.strictEqual(c.inconsistent, true);
  assert.strictEqual(c.wMul, A.KF_W_INCONSISTENT);
  const c2 = A.checkConsistency('你滚，受够了', 2, '开心');
  assert.strictEqual(c2.inconsistent, true);
  const ok = A.checkConsistency('今天天气不错', 1, '开心');
  assert.strictEqual(ok.inconsistent, false);

  const s = A.step(null, { a: -1, m: '不悦' }, '嗯', T0, Object.assign({}, KF, { assistantText: '抱歉，是我不好，抱抱' }));
  assert.ok(s.g.inconsistent);
  assert.ok(s.g.guard.includes('inconsistent'));
  assert.ok(s.g.w < A.KF_W); // 0.65 * 0.7
});

test('legacy 回退路径仍绿（与旧 DELTA 行为一致）', () => {
  const s = A.step(null, { a: 1, m: '开心' }, '谢谢你', T0, LEGACY);
  assert.strictEqual(s.aff, 0.34);
  assert.ok(!String(s.p).includes('kf'));
  assert.ok(!s.kf);
  // settings 关闭
  const s2 = A.step(null, { a: 1, m: '开心' }, '谢谢你', T0, { settings: { affectKf: false } });
  assert.strictEqual(s2.aff, 0.34);
  assert.strictEqual(A.useKfEstimator({ estimator: 'legacy' }), false);
  assert.strictEqual(A.useKfEstimator({}), true);
  assert.strictEqual(A.useKfEstimator({ estimator: 'kf' }), true);
});

test('step KF：写入 kf/cusum；护栏仍先生效', () => {
  const s = A.step(null, { a: 1, m: '开心', why: '谢谢' }, '谢谢你帮我', T0, KF);
  assert.ok(s.kf && typeof s.kf.x === 'number' && s.kf.P > 0);
  assert.ok(s.cusum && s.cusum.tier >= 1 && s.cusum.tier <= 5);
  assert.ok(String(s.p).includes('kf'));
  assert.ok(s.g.w === A.KF_W_WHY || s.g.w === A.KF_W); // why 证据可能达阈值
  // boundary 护栏先跑
  const bd = A.step(null, { a: 2, m: '开心' }, '发裸照', T0, KF);
  assert.strictEqual(bd.a, -2);
  assert.ok(bd.g.guard.includes('boundary'));
});

test('多角色隔离：affectBy + sceneMood 70/30', () => {
  const conv = {};
  A.setAffectFor(conv, 'alice', { aff: 0.8, vec: { val: 0.6, aro: 0.4 }, mood: '开心' });
  A.setSceneMood(conv, { aff: 0.2, vec: { val: -0.2, aro: 0.5 }, mood: '低落' });
  const b = A.getAffectFor(conv, 'alice');
  const expect = 0.7 * 0.8 + 0.3 * 0.2;
  assert.ok(Math.abs(b.aff - expect) < 1e-6, 'aff=' + b.aff);
  assert.strictEqual(b.blended, true);
  assert.ok(conv.affectBy.alice.aff === 0.8); // 自身未改
  assert.strictEqual(A.getAffectFor(conv, 'bob').aff, 0.2); // 无自身 → 场景
  assert.strictEqual(A.blendAffect(null, null), null);
});

test('affToX / deltaFromA 映射自洽', () => {
  assert.strictEqual(A.affToX(A.BASE_AFF), 0);
  assert.strictEqual(A.affToX(1), 2);
  assert.strictEqual(A.deltaFromA(0), 0);
  assert.strictEqual(A.deltaFromA(1), A.DELTA['1']);
  assert.strictEqual(A.deltaFromA(2), A.DELTA['2']);
  const mid = A.deltaFromA(0.5);
  assert.ok(mid > 0 && mid < A.DELTA['1']);
});

test('estimatorOf：conv 优先于 settings；非法回落 kf', () => {
  assert.strictEqual(A.estimatorOf(null, null), 'kf');
  assert.strictEqual(A.estimatorOf({ affectEstimator: 'legacy' }, { affectEstimator: 'kf' }), 'legacy');
  assert.strictEqual(A.estimatorOf({}, { affectEstimator: 'legacy' }), 'legacy');
  assert.strictEqual(A.estimatorOf({ affectKf: false }, null), 'legacy');
  assert.strictEqual(A.estimatorOf({ affectEstimator: 'nope' }, null), 'kf');
  assert.strictEqual(A.useKfEstimator({ conv: { affectEstimator: 'legacy' } }), false);
});

test('vecStepKf：â 驱动目标；增益夹在 G_MIN..G_MAX；classify 滞回仍可用', () => {
  const base = { val: 0, aro: 0.2 };
  const hi = A.vecStepKf(base, '开心', { x: 2, K: 0.5 });
  // tg 应介于 TARGET.开心 与 â→val=1 之间，val 高于纯 mood*INERTIA 起跑点
  assert.ok(hi.vec.val > 0.2, 'val=' + hi.vec.val);
  assert.ok(hi.g >= A.VEC_KF_G_MIN && hi.g <= A.VEC_KF_G_MAX, 'g=' + hi.g);
  assert.ok(hi.tg.val > A.TARGET['开心'].val * 0.5, 'tg.val=' + hi.tg.val);
  // â 负向应拉低 valence
  const lo = A.vecStepKf(base, '平静', { x: -2, K: 0.4 });
  assert.ok(lo.vec.val < 0, 'neg val=' + lo.vec.val);
  // 无 K 时仍可算
  const nk = A.vecStepKf(base, '开心', { x: 1 });
  assert.ok(nk.vec.val > 0);
  // 滞回：中间点不轻易切
  const mid = A.classify({ val: 0.28, aro: 0.31 }, '开心');
  assert.strictEqual(mid, '开心');
});

test('step KF：vec 不再等于纯 INERTIA；legacy 仍纯 INERTIA', () => {
  const leg = A.step(null, { a: 1, m: '开心' }, '谢谢你', T0, LEGACY);
  assert.deepStrictEqual(leg.vec, { val: 0.3, aro: 0.325 }); // INERTIA*TARGET 钉死
  const kf = A.step(null, { a: 1, m: '开心' }, '谢谢你', T0, KF);
  assert.ok(kf.kf && kf.kf.K != null);
  assert.ok(kf.g.vecG >= A.VEC_KF_G_MIN && kf.g.vecG <= A.VEC_KF_G_MAX);
  // 与 legacy 同输入时 vec 应有差异（â 拉目标）或至少不全等 INERTIA 公式的偶然重合时仍带 kf 元数据
  const pureInertia = {
    val: Math.round((0 + A.INERTIA * (0.6 - 0)) * 1e4) / 1e4,
    aro: Math.round((0.2 + A.INERTIA * (0.45 - 0.2)) * 1e4) / 1e4
  };
  assert.deepStrictEqual(leg.vec, pureInertia);
  // KF 路径：合成目标含 â，通常 ≠ 纯 INERTIA；若数值碰巧接近，至少 vecG 存在且 p 含 kf
  assert.ok(String(kf.p).includes('kf'));
  assert.ok(kf.g.vecG != null);
  assert.ok(Math.abs(kf.vec.val - pureInertia.val) > 1e-6 || Math.abs(kf.vec.aro - pureInertia.aro) > 1e-6,
    'KF vec should differ from pure INERTIA: ' + JSON.stringify(kf.vec));
});

test('formatKfHint / formatCusumHint：短可读，无状态返回空', () => {
  assert.strictEqual(A.formatKfHint(null), '');
  assert.strictEqual(A.formatCusumHint(null), '');
  const st = {
    kf: { x: 0.5, P: 0.2 },
    g: { yT: 0.8, yModel: 1, yLex: 0.4, w: 0.65 },
    cusum: { tier: 3, dwell: 2, sp: 0.12, sm: 0 }
  };
  const kh = A.formatKfHint(st);
  assert.ok(kh.includes('â=0.50') && kh.includes('P=0.200') && kh.includes('yT=0.80') && kh.includes('w=0.65'));
  const ch = A.formatCusumHint(st);
  assert.ok(ch.includes('档3/5') && ch.includes('dwell=2') && ch.includes('S+=0.12'));
});

test('合成稳定性：振荡 a 下 KF vec 步长均值 ≤ legacy INERTIA 路径（无人工金标）', () => {
  // 交替 a=+1/-1，比较 |Δvec| 均值；KF 用滤波 â 平滑，期望不比纯 INERTIA 更抖
  function traj(est) {
    let s = null;
    const deltas = [];
    for (let i = 0; i < 24; i++) {
      const a = i % 2 === 0 ? 1 : -1;
      const m = a > 0 ? '开心' : '不悦';
      const n = A.step(s, { a, m }, a > 0 ? '谢谢' : '有点烦', T0 + i * 1000, { estimator: est });
      if (s && s.vec) {
        deltas.push(Math.hypot(n.vec.val - s.vec.val, n.vec.aro - s.vec.aro));
      }
      s = n;
    }
    return deltas.reduce((x, y) => x + y, 0) / deltas.length;
  }
  const maeKf = traj('kf');
  const maeLeg = traj('legacy');
  // 允许 KF 略大，但不应显著更抖（阈值 1.25×）；主要是回归哨兵而非金标
  assert.ok(maeKf <= maeLeg * 1.25 + 1e-9, 'kf=' + maeKf + ' legacy=' + maeLeg);
});
