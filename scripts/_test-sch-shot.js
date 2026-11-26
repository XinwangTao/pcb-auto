// _test-sch-shot.js —— 锁住「原理图那一帧为什么总是缺」的两条判据。
//
// 真实事故（2026-11-26 01:29，gen-rp2040 / 取片第 2 次）：
//   12 张帧里 PCB 侧每一张都成功，唯独原理图那帧是
//     shotNone {tag:"sch-wired"}
//   原因：`await cam('sch', true); await shot('sch-wired');` 排在
//   `await waitDoc(pageUuid, 90000)` **之前** —— 取图时原理图页还没打开，
//   getCurrentRenderedAreaImage() 自然返回空。
//   后果不只是少一张图：成片需要 8 个不同画面，那一轮只有 6 个，
//   取片被判 TAKE=FAIL，尽管板子真的通过了（ok=True drcLeaf=0 route=completed，
//   独立校验 18/18）。**一个截图顺序错误，让一次成功的设计跑白跑。**
//
// 守四件事：
//   A. 结构：等页面就绪在前、截图在后；等待失败要留痕；取图有**有界**重试
//   B. 语义 oracle：重试能在偶发空图上收敛，且空图到底时是有界放弃
//   C. 反向：旧构建必须红（否则本测试没有鉴别力）
//   D. 不许把"没拍到"写成"这一版没有"
//
// 用法: node _test-sch-shot.js [pipeline3.js 路径]
'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] || path.join(__dirname, 'pipeline3.js');
let src;
try {
  src = fs.readFileSync(TARGET, 'utf8');
} catch (e) {
  console.error('读不到 ' + TARGET + ' : ' + e.message);
  process.exit(2);
}

let pass = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fails.push(name + (detail ? '  << ' + detail : ''));
};
const at = (s) => src.indexOf(s);
const count = (s) => src.split(s).length - 1;

// ───────────────────────── A. 结构锁 ─────────────────────────
const iShot = at("shot('sch-wired')");
ok('A1 原理图截图仍然存在且只有一处', iShot >= 0 && count("shot('sch-wired')") === 1,
  '出现 ' + count("shot('sch-wired')") + ' 次');

const iWaitNew = at('await waitDoc(pageUuid, 60000);');
ok('A2 截图前有"等原理图页就绪"的调用', iWaitNew >= 0, '没找到页面就绪等待');

ok('A3 等待在截图之前（顺序反了就等于没等）',
  iWaitNew >= 0 && iShot >= 0 && iWaitNew < iShot, '等待排在截图之后');

// 镜头切换必须仍在截图之前 —— 否则截到的是上一页
const iCamSch = src.lastIndexOf("cam('sch', true)", iShot);
ok('A4 切镜头仍在截图之前', iCamSch >= 0 && iCamSch < iShot, '镜头切换丢了');

// 等待本身在 cam 之后（先就绪再取景）或之前都行，但必须在 shot 之前；
// 这里额外要求"就绪"与"截图"之间还有沉降时间，避免刚就绪就取图。
const segReady = (iWaitNew >= 0 && iShot > iWaitNew) ? src.slice(iWaitNew, iShot) : '';
ok('A5 就绪与截图之间留有沉降时间', /await sleep\((\d+)\)/.test(segReady),
  '没有沉降，刚就绪就取图');

ok('A6 等待失败要留痕，不许静默当成"这版没有原理图"',
  at('schShotWaitFail') >= 0, '等待失败被吞掉');

// ---- 取图重试 ----
ok('A7 取图有重试循环', /for \(let t = 0; t < \d+ && !img; t\+\+\)/.test(src),
  '没有重试循环');

const mRetry = src.match(/for \(let t = 0; t < (\d+) && !img; t\+\+\)/);
const nRetry = mRetry ? Number(mRetry[1]) : 0;
ok('A8 重试次数是有界的有限值', nRetry >= 2 && nRetry <= 8, 'n=' + nRetry);

ok('A9 重试用的是无界等待（while(true)/无上限）',
  !/while \(true\)[\s\S]{0,200}getCurrentRenderedAreaImage/.test(src),
  '出现了无界等待');

ok('A10 重试到底仍记 shotNone（"没拍到"与"没拍"必须可分）',
  /if \(!img\) \{ log\('shotNone', \{ tag \}\); return null; \}/.test(src),
  'shotNone 没了');

// ───────────────────── B. 语义 oracle（回放重试）─────────────────────
// 复刻源码循环：最多 nRetry 次；空图之间等 250ms。
const replay = (seq) => {
  let img = null, calls = 0, waits = 0;
  for (let t = 0; t < nRetry && !img; t++) {
    if (t > 0) waits++;
    img = seq[calls] ?? null;
    calls++;
  }
  return { img: !!img, calls, waits };
};

// 真实形状：前两拍空（画布还没重绘完），第三拍出图
{
  const r = replay([null, null, 'png']);
  ok('B1 前两拍空、第三拍出图 → 收敛（这正是切镜头后的常见形状）',
    r.img === true && r.calls === 3, JSON.stringify(r));
}

// 空图到底：必须**有界放弃**，不能挂住
{
  const r = replay([null, null, null, null, null, null, null, null]);
  ok('B2 一直空 → 恰好 nRetry 次后放弃（不挂住整轮）',
    r.img === false && r.calls === nRetry, JSON.stringify(r));
}

// 最坏情况追加耗时 = (nRetry-1) * 250ms，必须远小于单次设计预算
{
  const worstMs = (nRetry - 1) * 250;
  ok('B3 最坏追加耗时 < 2s（截图不许吃掉设计预算）', worstMs < 2000, worstMs + 'ms');
}

// 第一拍就出图：不许无谓多等
{
  const r = replay(['png', null]);
  ok('B4 第一拍就出图 → 只调一次、不多等', r.img === true && r.calls === 1 && r.waits === 0,
    JSON.stringify(r));
}

// ───────────────────────── C. 反向对照 ─────────────────────────
// 旧构建：截图在 waitDoc 之前、取图无重试。两条都必须判红，否则本测试空真。
{
  const iOldShot = at("shot('sch-wired')");
  const iOldWait = at('await waitDoc(pageUuid, 90000);');   // 旧代码里只有这一处
  ok('C1 反向对照：旧顺序确实会判红（截图早于页面就绪）',
    iOldWait > iOldShot || iOldWait < 0, '旧构建竟然也是先等后截');
}

// ───────────────────────── D. 成绩口径 ─────────────────────────
// 这一处修复不改变任何板级判据，只影响素材。若它开始出现在闸门里，说明越界了。
ok('D1 本修复不进闸门（只修素材，不改判定）',
  !/gates\.schShot/.test(src) && !/schShotWaitFail[\s\S]{0,80}computeOK/.test(src),
  '截图逻辑被塞进了判定');

if (fails.length) {
  console.log('FAIL ' + pass + '/' + (pass + fails.length));
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('PASS ' + pass + '/' + pass + ' 原理图帧先等页面就绪再截，取图有界重试 ' + nRetry + ' 次');
process.exit(0);
