// 证明 universalGeo 的「读不到真实几何就放弃」**真的会放弃** —— 不是读代码猜。
// 做法：把 pipeline3.js 里真实的 universalGeo 代码块整段切出来，喂假 eda/log 跑。
//
// 为什么值得单独测：这个函数是为了不再"凭 DRC 报的类型猜几何"才写的 ——
// 它唯一的正确性主张就是「拿到的 bbox 必须真的包含违规点，否则返回 null」。
// 而它在真实日志里至今一次都没出现过（uniGeo* 全是 0），所以只能靠夹具证明它是对的，
// 否则它就是一段永远不会被证伪的装饰代码。
const fs = require('fs');
const P = process.argv[2];
if (!P) { console.log('用法: node _test-universal-geo.js <pipeline3.js>'); process.exit(2); }
const src = fs.readFileSync(P, 'utf8');

const START = 'const universalGeo = async (id, violX, violY) => {';
const END = '};\nconst resolveObstacle = async (obType, obId, violX, violY) => {';
const a = src.indexOf(START);
const b = src.indexOf(END, a);
if (a < 0 || b < 0) { console.log('切不出 universalGeo 段，a=' + a + ' b=' + b); process.exit(1); }
const block = src.slice(a, b + 3);   // 含结尾的 };

// 用假 eda/log 把这段真代码编译成可调用的函数
function build(code) {
  const logs = [];
  return {
    logs,
    make(eda) {
      const f = new Function('eda', 'log', code + '\nreturn universalGeo;');
      f.log = null;
      return f(eda, (k, v) => logs.push({ k, v }));
    },
  };
}

const hasKey = (logs, k) => logs.some(e => e.k === k);
const getKey = (logs, k) => (logs.find(e => e.k === k) || {}).v;

// 构造假 eda。box 为 null 表示 getPrimitivesBBox 返回 null；
// box 为字符串 'throw' 表示抛错；type 为 'throw' 表示类型读取抛错。
function makeEda(box, type, opts) {
  opts = opts || {};
  const P = {};
  if (!opts.noPrim) {
    P.getPrimitiveTypeByPrimitiveId = async (id) => {
      if (type === 'throw') throw new Error('type boom');
      return type === undefined ? undefined : type;
    };
    if (box !== 'noFn') {
      P.getPrimitivesBBox = async (ids) => {
        if (box === 'throw') throw new Error('bbox boom');
        return box;
      };
    }
  }
  return { pcb_Primitive: opts.noPrim ? undefined : P };
}

const cases = [];
function tc(name, box, type, violX, violY, opts, wantNull, wantKeys, wantPoly) {
  cases.push({ name, box, type, violX, violY, opts: opts || {}, wantNull, wantKeys: wantKeys || [], wantPoly });
}

const GOOD = { minX: 1000, minY: -2000, maxX: 1100, maxY: -1900 };   // 100x100 mil

// --- 1. 环境缺能力：必须放弃，而不是猜 ---
tc('1  pcb_Primitive 不存在 → 放弃', GOOD, 1, 1050, -1950, { noPrim: true }, true, ['uniGeoUnavailable']);
tc('2  getPrimitivesBBox 不存在 → 放弃', 'noFn', 1, 1050, -1950, {}, true, ['uniGeoUnavailable']);
tc('3  违规点坐标非有限 → 放弃', GOOD, 1, NaN, -1950, {}, true, []);

// --- 2. 读到一半失败：每种失败都要有自己的键（否则 0 与"没测"无法区分） ---
tc('4  类型读取抛错 → 仍继续，但留 uniGeoTypeErr', GOOD, 'throw', 1050, -1950, {}, false, ['uniGeoTypeErr'], 'OBSTACLE');
tc('5  bbox 读取抛错 → 放弃 + uniGeoBBoxErr', 'throw', 1, 1050, -1950, {}, true, ['uniGeoBBoxErr']);
tc('6  bbox 为 null → 放弃 + uniGeoNoBBox', null, 1, 1050, -1950, {}, true, ['uniGeoNoBBox']);
tc('7  bbox 含 NaN → 放弃 + uniGeoBadBox', { minX: NaN, minY: 0, maxX: 1100, maxY: 100 }, 1, 1050, -1950, {}, true, ['uniGeoBadBox']);
tc('8  bbox 反向(minX>maxX) → 放弃 + uniGeoBadBox', { minX: 1100, minY: -2000, maxX: 1000, maxY: -1900 }, 1, 1050, -1950, {}, true, ['uniGeoBadBox']);

// --- 3. ★ 核心主张：bbox 不包含违规点就必须返回 null（不合成几何）---
tc('9  bbox 不含违规点(偏 200 mil) → 返回 null', GOOD, 1, 1250, -1950, {}, true, ['uniGeo'], null);
tc('10 ★ 偏 5 mil（超出 tol=4）→ 返回 null', GOOD, 1, 1105, -1950, {}, true, ['uniGeo'], null);
tc('11 ★ 恰好偏 4 mil（等于 tol）→ 视为包含', GOOD, 'PAD', 1104.0, -1950, {}, false, ['uniGeo'], 'PAD');

// --- 4. 正常路径与退化盒 ---
tc('12 正常包含 → 返回真实四边形（类型是字符串枚举）', GOOD, 'REGION', 1050, -1950, {}, false, ['uniGeo'], 'REGION');
tc('13 退化盒(宽高皆 0) → 放弃', { minX: 1000, minY: -2000, maxX: 1000, maxY: -2000 }, 1, 1000, -2000, {}, true, ['uniGeo']);
tc('14 类型为 undefined → padKind 兜底 OBSTACLE', GOOD, undefined, 1050, -1950, {}, false, ['uniGeo'], 'OBSTACLE');


async function main() {
  let pass = 0, fail = 0;
  for (const c of cases) {
    const h = build(block);
    const eda = makeEda(c.box, c.type, c.opts);
    let got = null, err = null;
    try { got = await h.make(eda)('prim-1', c.violX, c.violY); } catch (e) { err = e; }
    const problems = [];
    if (err) problems.push('抛错: ' + err.message);
    const isNull = (got === null || got === undefined);
    if (c.wantNull && !isNull) problems.push('期望 null，实际 ' + JSON.stringify(got));
    if (!c.wantNull && isNull) problems.push('期望有几何，实际 null');
    for (const k of c.wantKeys) if (!hasKey(h.logs, k)) problems.push('缺日志键 ' + k);
    if (c.wantPoly !== undefined && !isNull) {
      if (got.kind !== 'poly') problems.push('kind 应为 poly，实际 ' + got.kind);
      if (got.owner !== 'universal') problems.push('owner 应为 universal，实际 ' + got.owner);
      if (got.padKind !== c.wantPoly) problems.push('padKind 应为 ' + c.wantPoly + '，实际 ' + got.padKind);
      if (!Array.isArray(got.pts) || got.pts.length !== 4) problems.push('pts 应为 4 点四边');
    }
    if (problems.length) { fail++; console.log('  FAIL  ' + c.name + '\n        ' + problems.join(' / ')); }
    else { pass++; console.log('  pass  ' + c.name); }
  }
  console.log('  ---- ' + pass + ' pass / ' + fail + ' fail (共 ' + cases.length + ') ----');
  return fail === 0;
}

// ---------- 反向对照：把"不包含就放弃"删掉，用例 9/10 必须失败 ----------
async function reverseControl() {
  const mutated = block.replace('if (!contains) return null;', '/* 对照：这行被删掉 */');
  if (mutated === block) { console.log('  反向对照无效：没找到 if (!contains) return null;'); return false; }
  const h = build(mutated);
  const got9 = await h.make(makeEda(GOOD, 1))('prim-1', 1250, -1950);
  const got10 = await h.make(makeEda(GOOD, 1))('prim-1', 1104, -1950);
  const ok = !(got9 === null || got9 === undefined) && !(got10 === null || got10 === undefined);
  console.log('  反向对照（删掉 contains 守卫）: case9=' + JSON.stringify(got9 && got9.kind) +
    ' case10=' + JSON.stringify(got10 && got10.kind) + ' → ' + (ok ? '确实会合成假几何 ✓' : '没复现 ✗'));
  return ok;
}

// ---------- 结构锁：确认真实代码里守卫还在（防止有人删了它而测试夹具也同步被改） ----------
function structuralLock() {
  const need = [
    "if (!P || typeof P.getPrimitivesBBox !== 'function')",
    'const tol = 4;',
    'if (!contains) return null;',
    'if (!(w > 0) && !(h > 0)) return null;',
  ];
  const missing = need.filter(s => !block.includes(s));
  if (missing.length) { console.log('  结构锁失败：缺 ' + JSON.stringify(missing)); return false; }
  console.log('  结构锁：4 处关键守卫都在 ✓');
  return true;
}

main().then(async (ok) => {
  const lockOk = structuralLock();
  const revOk = await reverseControl();
  if (!ok || !lockOk || !revOk) { console.log('  结果: FAIL'); process.exit(1); }
  console.log('  结果: 全部通过（且反向对照证明这些用例是可证伪的）');
  process.exit(0);
}).catch(e => { console.log('  测试自身异常: ' + (e && e.stack || e)); process.exit(3); });
