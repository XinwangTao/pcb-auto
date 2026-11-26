/**
 * _trend.js —— 跨运行趋势表：同一块板子在不同 pipeline3.js 版本 / 不同策略下，
 * clearance 修复到底是变好还是变坏。
 *
 * 为什么需要它：本仓库反复踩过的坑是「日志读起来像修好了，板上没变」。
 *   实测 d13：clearanceRound 4,4,3,3,3,3,3,3、fixed 4,3,3,3,3,3,3,3 —— 八轮都在"修成功"，
 *   违规数一格没降，白烧 34s。仅凭 clearanceFixes=25 会得出完全相反的结论。
 *   所以这张表必须同时给出：违规数**序列**、每轮 fixed、真实绕行次数、终止原因、
 *   回滚失败数、以及最后 DRC 叶子数 —— 任何一项单独看都可能骗人。
 *
 * ★ 按**尝试**分行，不按 run 目录合并。一个 run 目录里 `_log-1-smart-fit.json` 与
 *   `_log-2-expand-1.25x.json` 是两次独立尝试，可能一个是旧脚本、一个用了新策略。
 *   实测 SHT30：1 号尝试用了旧脚本且失败，2 号用了新脚本且通过；若按"最大文件"取代表，
 *   会把失败尝试的叶子数当成这块板的结论。
 *
 * 用法：
 *   node _trend.js                       # 扫 out\ 全部
 *   node _trend.js --rev a47c84d4eb7a    # 只看某个流水线版本
 *   node _trend.js --design 19pia69      # 只看名字含该子串的
 *   node _trend.js --only-bad            # 只看最终判失败的板子
 *   node _trend.js --json                # 机器可读
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');

const argv = process.argv.slice(2);
const argOf = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const wantRev = argOf('--rev');
const wantDesign = argOf('--design');
const onlyBad = argv.includes('--only-bad');
const asJson = argv.includes('--json');

// 表示"这一次修复动作没能落地"。必须与"修成功"分开计数，否则 fixed 会把失败记成进展。
const FAIL_KEYS = [
  'trackCornerUnconfirmed', 'trackThinUnconfirmed', 'trackDoglegFixFail',
  'trackRerouteFixFail', 'viaModifyUnconfirmed', 'viaDeleteUnconfirmed',
  'clearanceRevertLineRestoreFail', 'clearanceRevertViaRestoreFail',
  'clearanceRevertViaUnrestorable', 'clearanceRevertDeleteFail',
  'clearanceSkipNoGeo', 'clearanceBudgetSkip', 'pourRebuildEmpty', 'pourRebuildErr',
  'pourMeasureErr', 'pourFail',
];
const ACT_KEYS = ['trackThinned', 'trackRerouted', 'trackDogleg', 'viaShrunk', 'viaDeleted'];

function readEntries(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j.entries)) return j.entries;
    if (Array.isArray(j.log)) return j.log;
    if (j.value && Array.isArray(j.value.log)) return j.value.log;
  } catch (e) { }
  return null;
}

function revOf(dir) {
  try {
    const m = fs.readFileSync(path.join(dir, '_pipeline_rev.txt'), 'utf8')
      .match(/sha256_12\s*=\s*([0-9a-f]{12})/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function num(v, d) { return (v === null || v === undefined || Number.isNaN(Number(v))) ? d : Number(v); }
function fmt(v) { return v === null || v === undefined ? '—' : String(v); }

function summarizeAttempt(dir, file) {
  const p = path.join(dir, file);
  const es = readEntries(p);
  if (!es) return null;
  const g = (k) => es.filter(e => e && e.s === k).map(e => e.v);
  const last = (k) => { const a = g(k); return a.length ? a[a.length - 1] : null; };

  const rounds = g('clearanceRound').map(r => ({
    v: r && r.violations != null ? r.violations : null,
    f: r && r.fixed != null ? r.fixed : null,
  }));
  const cnt = {};
  for (const e of es) if (e && (ACT_KEYS.includes(e.s) || FAIL_KEYS.includes(e.s) || e.s === 'clearanceNoProgress')) {
    cnt[e.s] = (cnt[e.s] || 0) + 1;
  }

  const leaf = last('drcLeafCount');
  const fixes = last('clearanceFixes');
  const rs = g('trackRerouted');
  const pm = last('pourMeasured');
  const cd = g('clearDiag');

  return {
    attempt: file,
    bytes: fs.statSync(p).size,
    violSeq: rounds.map(r => fmt(r.v)),
    fixedSeq: rounds.map(r => fmt(r.f)),
    rounds: rounds.length,
    fixesTotal: fixes && fixes.value != null ? fixes.value : (typeof fixes === 'number' ? fixes : null),
    leaves: leaf && leaf.leaves != null ? leaf.leaves : null,
    drcPassed: leaf && leaf.passed != null ? leaf.passed : null,
    drcUsable: leaf && leaf.usable != null ? leaf.usable : null,
    // 【口径】trackRerouted 落的是 {corridor: chosen.axis}，不是 axis。
    // 曾写成 r.axis === 'x'，于是字段永远 undefined ⇒ 这一列**恒为 0/0**，
    // 与实际跑了几次绕行无关；d13 实测 21 次、d12 坦2 次，日志里全显示 0/0。
    // 常数列最危险：它看起来"很稳"，实际是把"没测到"报成了"没发生"。
    // 两种键都认（历史日志用过 corridor，验证快照用过 axis），并单独计数无法识别的形状。
    rerouteX: rs.filter(r => r && (r.corridor || r.axis) === 'x').length,
    rerouteY: rs.filter(r => r && (r.corridor || r.axis) === 'y').length,
    rerouteUnknown: rs.filter(r => r && (r.corridor || r.axis) !== 'x' && (r.corridor || r.axis) !== 'y').length,
    noProgress: cnt['clearanceNoProgress'] || 0,
    reverts: cnt['clearanceReverted'] || 0,
    restoreFail: (cnt['clearanceRevertLineRestoreFail'] || 0) + (cnt['clearanceRevertViaRestoreFail'] || 0)
      + (cnt['clearanceRevertViaUnrestorable'] || 0),
    noGeo: cnt['clearanceSkipNoGeo'] || 0,
    unconfirmed: (cnt['trackCornerUnconfirmed'] || 0) + (cnt['trackThinUnconfirmed'] || 0)
      + (cnt['viaModifyUnconfirmed'] || 0) + (cnt['viaDeleteUnconfirmed'] || 0),
    pouredCount: pm ? pm.pouredCount : null,
    pourCount: pm ? pm.pourCount : null,
    pourOk: pm ? pm.ok : null,
    // 最后一条 clearDiag 的障碍物类型：能直接看出"卡在 Slot Region"还是 Track×Track
    lastObstacle: cd.length
      ? [cd[cd.length - 1].t1, cd[cd.length - 1].t2].filter(Boolean).join('×')
      : null,
    lastNeed: cd.length ? cd[cd.length - 1].need : null,
    lastCur: cd.length ? cd[cd.length - 1].cur : null,
  };
}

const rows = [];
for (const d of fs.readdirSync(OUT, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const dir = path.join(OUT, d.name);
  const logs = (() => { try { return fs.readdirSync(dir).filter(f => /^_log.*\.json$/.test(f)); } catch (e) { return []; } })();
  if (!logs.length) continue;
  let run = null;
  try { run = JSON.parse(fs.readFileSync(path.join(dir, '_run.json'), 'utf8')); } catch (e) { }
  const rev = revOf(dir);
  if (wantRev && rev !== wantRev) continue;
  if (onlyBad && run && run.ok !== false) continue;
  const base = d.name.replace(/-\d{8}-\d{6}$/, '');
  if (wantDesign && !(d.name + ' ' + (run && run.designName || '')).includes(wantDesign)) continue;
  // 尝试顺序：smart-fit 通常是 1，expand 是 2；没有 _log.json 时这就是唯一顺序来源
  logs.sort((a, b) => {
    if (a === '_log.json') return 1;
    if (b === '_log.json') return -1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
  for (const f of logs) {
    const s = (() => { try { return summarizeAttempt(dir, f); } catch (e) { return null; } })();
    if (!s) continue;
    rows.push(Object.assign({
      base, dir: d.name, rev,
      runOk: run ? run.ok : null,
      designName: run ? run.designName : null,
      gateDrc: run && run.gates ? run.gates.drcPassed : null,
      gatePourRebuildOk: run && run.gates ? run.gates.pourRebuildOk : null,
      gatePouredCount: run && run.gates ? run.gates.pouredCount : null,
    }, s));
  }
}

rows.sort((a, b) => a.base.localeCompare(b.base) || a.dir.localeCompare(b.dir)
  || a.attempt.localeCompare(b.attempt));

if (asJson) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }

console.log('共 ' + rows.length + ' 条尝试记录');
console.log('');
let lastDir = null;
for (const s of rows) {
  if (s.dir !== lastDir) {
    const mark = s.runOk === true ? 'OK ' : (s.runOk === false ? 'BAD' : '?? ');
    console.log('■ [' + mark + '] ' + s.base + '  rev=' + fmt(s.rev) + '  ' + s.dir.slice(-15));
    lastDir = s.dir;
  }
  const tryName = s.attempt.replace(/^_log/, '').replace(/\.json$/, '') || '(single)';
  console.log('   ' + tryName.padEnd(22) +
    ' 违规=[' + s.violSeq.join(',') + ']' +
    ' 每轮fixed=[' + s.fixedSeq.join(',') + ']' +
    ' 叶子=' + fmt(s.leaves) + (s.drcUsable === false ? '(树不可用)' : ''));
  console.log('   ' + ''.padEnd(22) +
    ' 轮=' + s.rounds + ' fixes总=' + fmt(s.fixesTotal) +
    ' 绕行x/y=' + s.rerouteX + '/' + s.rerouteY + (s.rerouteUnknown ? '(+' + s.rerouteUnknown + '未知)' : '') +
    ' 无进展停=' + s.noProgress + ' 回滚=' + s.reverts + '/' + s.restoreFail +
    ' 缺几何=' + s.noGeo + ' 未确认=' + s.unconfirmed +
    (s.lastObstacle ? ' 末障碍=' + s.lastObstacle + '(' + fmt(s.lastCur) + '/' + fmt(s.lastNeed) + ')' : '') +
    (s.pourCount != null ? ' 覆铜=' + s.pouredCount + '/' + s.pourCount + '(' + s.pourOk + ')' : ''));
}
