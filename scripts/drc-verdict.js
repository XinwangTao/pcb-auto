'use strict';
/**
 * 独立 DRC 复核的**裁定**——纯函数，不碰 EDA、不碰文件系统。
 *
 * 为什么单独一个文件
 * ------------------
 * 原来的裁定散在 `verify-drc.js` 的两处：内层算一个布尔 `consistent`，
 * 外层用一串内联三元式决定退出码。那种形状**只能靠跑真 EDA 才能测**，
 * 于是它长期处于「没人测过」的状态，并且两个方向都归错了类
 * （2026-11-27 对抗性审查实测，见下）。
 *
 * 抽成纯函数之后，闸门可以用构造信封把每一种组合直接喂进来，
 * 断言退出码是哪一个——不需要 EDA、不需要 9 分钟。
 *
 * 四种组合，只有第一种是「通过」
 * ------------------------------
 *   passed  itemsErr  total   真实含义                          退出码
 *   ------  --------  -----   --------------------------------  ------
 *   true    null      0       真的通过                            0
 *   true    null      >0      自述通过但明细非空（异步窗口）⇒ 有违规   **1**
 *   false   null      >0      有违规                              1
 *   false   null      0       说不通过却一条都列不出 ⇒ 没量成        **2**
 *   any     ≠null     0       明细取不到 ⇒ 没量成                   **2**
 *   —       —        缺失     根本没跑到那一步 ⇒ 没量成               **2**
 *
 * 原实现错在两处（都是「让结论错」等级）：
 *
 *   1. `consistent = passed ? (…) : true` —— `passed=false` 时恒为 true。
 *      于是「明细取不到」也走 exit 1（= 有违规），run-all 会打印
 *      「违规 处」并把一块**没量过的板**换成更宽的板。白烧 6~10 分钟，
 *      而且结论指向一个不存在的问题。
 *
 *   2. `passed=true` 但明细非空 → `consistent=false` → exit 2（= 环境异常）。
 *      但真相是**这条板确实有违规**。把它记成环境故障，等于把设计缺陷
 *      写成「量具坏了」，处置完全相反（env 分支会停止自愈阶梯）。
 *
 * 退出码契约抄自文件头：0 = DRC 通过；1 = **有违规**（一个结论）；2 = 没量成（环境/工程问题）。
 * 这三者不能互相顶替。
 */

/** 每种裁定的固定属性，闸门拿它做表驱动断言。 */
const VERDICT_TABLE = {
  clean:         { code: 0, measured: true,  violations: 0 },
  violations:    { code: 1, measured: true,  violations: null },
  'no-detail':   { code: 2, measured: false, violations: null },
  'no-total':    { code: 2, measured: false, violations: null },
  contradictory: { code: 2, measured: false, violations: null },
  'no-passed':   { code: 2, measured: false, violations: null },
  'bad-envelope': { code: 2, measured: false, violations: null },
  'cli-refused': { code: 2, measured: false, violations: null },
  'no-value':    { code: 2, measured: false, violations: null },
  'eda-refused': { code: 2, measured: false, violations: null },
};

function mk(verdict, reason, extra) {
  const t = VERDICT_TABLE[verdict];
  if (!t) throw new Error('未知裁定：' + verdict);
  return Object.assign({
    verdict,
    reason,
    code: t.code,
    measured: t.measured,
  }, extra || {});
}

/**
 * 用「自述」与「明细条数」两个信号交叉判定。
 * @param {{passed?: any, itemsErr?: any, total?: any}} v
 */
function classify(v) {
  const src = (v && typeof v === 'object') ? v : {};

  const detailOk = (src.itemsErr === null || src.itemsErr === undefined);
  const n = Number.isFinite(src.total) ? Number(src.total) : null;
  const selfPassed = src.passed;

  // 【明细取不到 ⇒ 没量成】这是唯一能给出「违规是哪几类」的诊断来源。
  // 取不到时 items 也是 []，于是 total:0 与"真的 0 违规"在输出上完全同形 ——
  // 必须靠 itemsErr 这个独立信号区分，绝不能看 total。
  if (!detailOk) {
    return mk('no-detail', '明细取不到：' + String(src.itemsErr).slice(0, 160), { consistent: false });
  }

  // total 缺失 = 内层没跑到返回，等于没量
  if (n === null) {
    return mk('no-total', 'total 缺失（内层未给出违规条数）', { consistent: false });
  }

  // 有违规：**两个信号里只要有明细说有，就以明细为准**。
  // 这正是原来错的方向②：passed=true 却列出 3 条，那是真违规，不是环境异常。
  if (n > 0) {
    const disagree = (selfPassed === true);
    return mk('violations',
      n + ' 处违规' + (disagree ? '（自述通过 = 假阴性，以明细为准）' : ''),
      { consistent: !disagree, total: n });
  }

  // total === 0：能否判「真的通过」取决于自述
  if (selfPassed === true) {
    return mk('clean', '0 违规且自述通过', { consistent: true, total: 0 });
  }
  if (selfPassed === false) {
    // 方向①的镜像：说不通过却一条都列不出。既不能当通过，也不能当"有违规"。
    return mk('contradictory', '自述不通过，但明细一条都列不出 —— 结论不可采信', { consistent: false, total: 0 });
  }
  return mk('no-passed', 'passed 缺失（内层未给出判定）', { consistent: false, total: 0 });
}

/**
 * 从 CLI 信封一路判到退出码。这是 verify-drc.js 里**唯一**该决定退出码的地方。
 * @param {any} env CLI 打印的最后一行 JSON
 */
function decide(env) {
  if (!env || typeof env !== 'object') {
    return mk('bad-envelope', 'CLI 输出不是 JSON 对象');
  }
  if (env.ok !== true) {
    return mk('cli-refused', 'CLI 信封 ok≠true：' + JSON.stringify(env.error || env).slice(0, 160));
  }
  const v = env.value;
  if (!v || typeof v !== 'object') {
    return mk('no-value', 'CLI 信封没有 value');
  }
  // 内层 openTarget() 找不到板时返回 { ok:false, error:'no board…' }，
  // 这个对象落进 value 若被当成"判定"，就会把环境故障记成设计缺陷。
  if (v.ok === false) {
    return mk('eda-refused', '内层拒绝执行：' + String(v.error || '').slice(0, 160));
  }
  // 【字段映射就在这里做】实测 2026-11-27 踩过：内层一度把它叫 passedRaw，
  // 而 classify 读 passed ⇒ 真机上永远裁成 no-passed（exit 2）。纯函数闸门看不见这种“单元对、接线错”。
  // 所以由 decide 做显式映射，并由闸门断言映射关系本身。
  return classify({ passed: v.passed, itemsErr: v.itemsErr, total: v.total });
}

module.exports = { classify, decide, VERDICT_TABLE };
