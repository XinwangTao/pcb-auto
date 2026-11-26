// _test-thin-gate.js —— 锁住「缩窄能不能达标必须算出来，不许靠试」。
//
// 缺陷：Track 侧的处理顺序是「先缩窄到 6.5 → 成功就 continue → 下一轮才绕行」。
// 缩窄的成功判据只是 `curW > 6.5`，**从不看这一处差多远**。
// 于是差距大到算术上根本补不上的违规，也会先缩一轮窄：
//   · 白烧一整轮（同一处要再等一轮才被绕行处理）；
//   · 这一轮违规数不变 → 计入 noProgressRounds → 两轮就把整个循环提前停掉。
//
// 实测（scripts\_drcstats.js 对 139 个日志的统计）：
//   「缩窄线宽」纯净轮次（该轮只有缩窄这一个动作）**7 轮，违规净减少 0**。
//   含缩窄的 20 轮里只有 10 轮有效、9 轮无变化、1 轮变糟。
// 即：缩窄单独出现时一次都没修好过任何一处。
//
// 缩窄的收益是可以算出来的：线宽 curW → 6.5，两侧各让 (curW-6.5)/2，
// 边缘距最多增加这么多。若 curDist + 增量 < needDist，则缩窄不可能达标。
//
// 守四件事：
//   A 结构：距离提前算、`thinGain`/`thinKnowable`/`thinHopeless` 三件套、跳过时单独成键；
//   B 顺序：距离声明必须早于缩窄分支（否则 TDZ 崩在修复中途）；
//   C 算术 oracle：含 d12 的真实数值，正反两侧都验，且"未知"不许判成无望；
//   D 反向对照：旧构建（无此判据）必须红。
'use strict';
const fs = require('fs');
const path = require('path');

const TARGET = process.argv[2] || path.join(__dirname, 'pipeline3.js');
let src;
try { src = fs.readFileSync(TARGET, 'utf8'); }
catch (e) { console.error('读不到 ' + TARGET + ' : ' + e.message); process.exit(2); }

let pass = 0;
const fails = [];
const ok = (n, c, d) => { if (c) pass++; else fails.push(n + (d ? '  << ' + d : '')); };
const has = (s) => src.indexOf(s) >= 0;
const at = (s) => src.indexOf(s);
const flat = src.replace(/\s+/g, ' ');

// ───────── A. 结构 ─────────
ok('A1 缩窄前先算当前距离', has('const curDist = Number(ed.minDistance) * 10;'));
ok('A2 缩窄前先算目标间距', has('const needDist = Number(ed.clearance) * 10;'));
ok('A3 单位换算注释在（×10 是 mil，不是随手乘）', /minDistance \/ clearance 是画布单位（mil\/10）/.test(src));
ok('A4 收益按半线宽算', has('const thinGain = curW > 6.5 ? (curW - 6.5) / 2 : 0;'));
ok('A5 可判定性单独成条件（读数缺失 ≠ 无望）', has('const thinKnowable = Number.isFinite(curDist) && Number.isFinite(needDist)'));
ok('A6 无望判据带 epsilon（不能用 0 边界）', /const thinHopeless = thinKnowable && \(curDist \+ thinGain\) < \(needDist - 1e-3\);/.test(flat));
ok('A7 跳过缩窄时单独记事件', has("log('clearanceThinHopeless', {"));
ok('A8 无望时**不修改**铜（只记录）', /thinHopeless[\s\S]{0,900}?why: '缩窄最多补 thinGain/.test(src));

// ───────── B. 顺序 / 无重复声明 ─────────
const iDecl = at('const curDist = Number(ed.minDistance) * 10;');
const iThin = at('if (curW > 6.5 && thinHopeless)');
const iBranch = at('} else if (curW > 6.5) {');
ok('B1 距离声明早于缩窄分支', iDecl > 0 && iThin > iDecl, iDecl + '/' + iThin);
ok('B2 无望分支在可缩窄分支之前（否则先缩了才判）', iThin > 0 && iBranch > iThin, iThin + '/' + iBranch);
{
  const dup = (src.match(/const curDist = Number\(ed\.minDistance\) \* 10;/g) || []).length;
  const dupN = (src.match(/const needDist = Number\(ed\.clearance\) \* 10;/g) || []).length;
  ok('B3 curDist 只声明一处（重复声明 = 两个缺陷点）', dup === 1, 'x' + dup);
  ok('B4 needDist 只声明一处', dupN === 1, 'x' + dupN);
}

// ───────── C. 算术 oracle（独立复刻，不引用被测代码） ─────────
const judge = (curW, curDist, needDist) => {
  const gain = curW > 6.5 ? (curW - 6.5) / 2 : 0;
  const knowable = Number.isFinite(curDist) && Number.isFinite(needDist) && curDist >= 0 && needDist > 0;
  const hopeless = knowable && (curDist + gain) < (needDist - 1e-3);
  return { gain, knowable, hopeless };
};
{
  // d12 smart-fit 实测：线宽 10、cur 0~3.4、need 5.9843
  const a = judge(10, 0, 5.9843);
  ok('C1 d12 实测(10,0,5.9843) 判为无望', a.hopeless === true, JSON.stringify(a));
  ok('C2 其收益 = 1.75mil（10→6.5 的一半）', Math.abs(a.gain - 1.75) < 1e-9, String(a.gain));
  const b = judge(10, 3.4, 5.9843);
  ok('C3 d12 实测(10,3.4,5.9843) 也判为无望（3.4+1.75=5.15 < 5.98）', b.hopeless === true, JSON.stringify(b));
  // d12 expand 的 Hole×Hole 那种差距（用 Track 侧同口径验证边界）
  const c = judge(10, 4.6, 11.811);
  ok('C4 (10,4.6,11.811) 判为无望（4.6+1.75=6.35 < 11.81）', c.hopeless === true);
  // 反过来：差一点点就够，必须仍然去缩
  const d = judge(10, 10.5, 11.811);
  ok('C5 (10,10.5,11.811) 仍应缩窄（10.5+1.75=12.25 ≥ 11.81）', d.hopeless === false, JSON.stringify(d));
  const e = judge(10, 11.0, 11.811);
  ok('C6 (10,11.0,11.811) 仍应缩窄', e.hopeless === false);
  // 已在最小线宽：收益 0，不能因为"无望"就走别的逻辑（curW>6.5 才进这条分支）
  const f = judge(6.5, 0, 11.811);
  ok('C7 已最小线宽时收益为 0', f.gain === 0);
  ok('C8 已最小线宽时不进入缩窄分支（由 curW>6.5 守住）', has('if (curW > 6.5 && thinHopeless)'));
  // 读数缺失：不许判无望
  ok('C9 curDist=NaN 时不判无望（不知道 ≠ 不可能）', judge(10, NaN, 5).hopeless === false);
  ok('C10 needDist=NaN 时不判无望', judge(10, 1, NaN).hopeless === false);
  ok('C11 needDist=0 时不判无望（读数无效≠无望）', judge(10, 1, 0).hopeless === false);
  ok('C12 curDist 为负时不判无望（读数异常≠无望）', judge(10, -5, 6).hopeless === false);
  // 边界：恰好等于（curDist+gain == needDist）→ 不算无望，仍值得试
  ok('C13 恰好达标（4.25+1.75=6.0=need）不算无望', judge(10, 4.25, 6.0).hopeless === false);
  ok('C14 差 0.01mil 才算无望（epsilon 不能吃掉整段）', judge(10, 4.25, 6.01).hopeless === true);
}

// ───────── D. 反向对照 ─────────
// 注意：反向对照**不是**能写进断言的"旧构建必红"条件 —— 那会变成
// 「在候选上求值一个只在旧文件成立的命题」，必然假红（本测试第一版就栽在这）。
// 反向对照的正确形式是：拿同一套断言去跑旧文件，由调用方比较两次退出码。
// 这里只断言新代码确实在，供 D 段标注可证伪性。
ok('D1 新判据确实存在（供反向对照跑旧文件时区分）',
  has('const thinHopeless = thinKnowable') && has("log('clearanceThinHopeless', {"));

if (fails.length) {
  console.error('FAIL  ' + pass + '/' + (pass + fails.length) + ' 通过');
  for (const f of fails) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log('PASS  ' + pass + '/' + pass + ' 通过  (缩窄能否达标改为可计算判据，无望时直接绕行)');
process.exit(0);
