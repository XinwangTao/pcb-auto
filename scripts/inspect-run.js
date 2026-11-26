#!/usr/bin/env node
/**
 * inspect-run.js —— 单次运行的离线体检（只读，不碰 lceda）
 *
 * 用法：
 *   node scripts/inspect-run.js <日志json>            直接给 logs\X.json
 *   node scripts/inspect-run.js <运行目录>             给 out\X-20261126-020219，自动找同名日志
 *   node scripts/inspect-run.js <日志json> --all       连每条 stitch/clearDiag 明细都打
 *
 * 为什么要有它：判一次运行是否成功，过去要靠人肉翻 88~130 条事件，
 * 于是"差一条"和"差二十条"在报告里长得一样。这里把有区分力的字段集中成一张判决，
 * 并且**显式区分**「没有数据」「是 0」「不能判断」——空数组不等于没测。
 *
 * 信封格式（已核实，别猜）：{ ok, value:{ log:[{s,v}...], drcDetails }, logs, durationMs }
 * 注意顶层 `logs`（复数）**不是**事件数组；事件在 `value.log`。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const arg = argv.find(a => !a.startsWith('--'));
const showAll = argv.includes('--all');
if (!arg) {
  console.error('用法: node scripts/inspect-run.js <日志json | 运行目录> [--all]');
  process.exit(2);
}

// ---------- 定位日志 ----------
function resolveLog(p) {
  if (!fs.existsSync(p)) return { err: '路径不存在: ' + p };
  const st = fs.statSync(p);
  if (st.isFile()) return { file: p };
  // 目录：优先 <dir名>.json，其次目录内 _log.json
  const base = path.basename(p);
  const cand = [
    path.join(__dirname, '..', 'logs', base + '.json'),
    path.join(p, '_log.json'),
  ];
  for (const c of cand) if (fs.existsSync(c)) return { file: c };
  return { err: '目录里找不到日志，已试: ' + cand.join(' | ') };
}

const loc = resolveLog(path.resolve(arg));
if (loc.err) { console.error('  ' + loc.err); process.exit(1); }

let j;
try { j = JSON.parse(fs.readFileSync(loc.file, 'utf8')); }
catch (e) { console.error('  JSON 解析失败: ' + e.message); process.exit(1); }

const log = j && j.value && Array.isArray(j.value.log) ? j.value.log : null;
if (!log) {
  console.error('  这不是流水线日志：缺少 value.log（可能是别的信封）');
  process.exit(1);
}

const pick = s => log.filter(e => e && e.s === s).map(e => e.v);
const last = s => { const a = pick(s); return a.length ? a[a.length - 1] : undefined; };
const has = s => log.some(e => e && e.s === s);

// ---------- 终局 DRC 明细（权威来源是返回值 drcDetails，不是 drcLeaves 事件）----------
const leafMeasurable = Array.isArray(j.value.drcDetails);
const leaves = [];
(function walk(n) {
  if (!n) return;
  if (Array.isArray(n)) { n.forEach(walk); return; }
  if (n.errorType) leaves.push(n);
  if (n.list) walk(n.list);
})(j.value.drcDetails);

const connLeaves = leaves.filter(l => l.errorType === 'Connection Error');
const clearLeaves = leaves.filter(l => l.errorType === 'Clearance Error');
const otherLeaves = leaves.filter(l => l.errorType !== 'Connection Error' && l.errorType !== 'Clearance Error');

const dupCount = (arr, key) => {
  const m = new Map();
  for (const x of arr) { const k = key(x); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

// ---------- 输出 ----------
const W = (s) => console.log(s === undefined ? '' : '  ' + s);
W('日志      : ' + loc.file);
W('顶层 ok   : ' + String(j.ok) + '   耗时: ' + (j.durationMs != null ? (j.durationMs / 1000).toFixed(1) + 's' : '—'));

// 阶段耗时：找出最慢的三段，失败运行往往是某一段异常膨胀
const phases = pick('PHASE').filter(p => p && p.n).map(p => ({ n: p.n, ms: Number(p.ms) || 0 }));
if (phases.length) {
  W('');
  W('阶段耗时（ms）:');
  const tot = phases.reduce((s, p) => s + p.ms, 0);
  for (const p of phases) {
    const share = tot ? (100 * p.ms / tot).toFixed(0) : '0';
    W('  ' + p.n.padEnd(18) + String(p.ms).padStart(7) + '  ' + share.padStart(3) + '%');
  }
}

// 槽孔禁布区：本轮 d13/d12 的关键新机制
W('');
const sk = last('slotKeepout');
if (sk === undefined) {
  W('slotKeepout : 事件不存在 → 该次运行用的是**没有这个机制**的旧构建（不是 found=0）');
} else {
  W('slotKeepout : found=' + sk.found + ' created=' + sk.created + ' failed=' + sk.failed +
    ' skippedBig=' + sk.skippedBig + '  areas=' + JSON.stringify(sk.areas || []));
  if (sk.found === 0) W('              → 板上没有 MULTI 层 FILL（无槽孔），对本次运行无影响');
  else if (sk.created === 0 && sk.failed > 0) W('              → 找到槽孔但**一个都没建成**，需要查 slotKeepoutErr');
}
if (has('slotKeepoutErr')) W('slotKeepoutErr: ' + JSON.stringify(last('slotKeepoutErr')));

// 间距阶段
W('');
const cRounds = pick('clearanceRound');
W('间距轮次   : ' + (cRounds.length ? cRounds.map(r => 'r' + r.round + ' 违规' + r.violations + '/修' + r.fixed).join('  ') : '无记录'));
const cDone = last('clearanceDone');
W('间距收敛   : ' + (cDone ? ('结束于第 ' + cDone.round + ' 轮，剩 ' + cDone.remaining) : '未收敛（无 clearanceDone）'));
const cFix = last('clearanceFixes');
W('clearanceFixes(API 接受数，不等于板上真修好): ' + (cFix === undefined ? '—' : cFix));
const cRev = last('clearanceReverted');
if (cRev) W('整轮回滚   : ' + JSON.stringify(cRev));
else W('整轮回滚   : 无（这一轮没有被判成变差）');

// 放弃原因聚合：回答"为什么修不掉"
const skipKeys = ['clearanceSkipNoPush', 'clearanceSkipTooShort', 'clearanceSkipDegenerate', 'clearanceSkipNoPos', 'clearanceThinHopeless', 'clearanceFlippedSide', 'clearanceNoHandler'];
const skips = skipKeys.filter(has);
if (skips.length) {
  W('');
  W('间距放弃/降级原因:');
  for (const k of skipKeys) {
    if (!has(k)) continue;
    const arr = pick(k);
    W('  ' + k.padEnd(26) + '×' + arr.length);
    const show = showAll ? arr : arr.slice(0, 3);
    for (const v of show) W('      ' + JSON.stringify(v).slice(0, 200));
  }
}

// 删过孔：会制造断路，属高危动作，必须露出来
W('');
const vDel = pick('viaDeleted');
if (vDel.length) {
  W('删过孔     : ' + vDel.length + ' 个');
  for (const v of (showAll ? vDel : vDel.slice(0, 5))) W('      ' + JSON.stringify(v));
} else W('删过孔     : 0');
if (has('viaDeleteUnconfirmed')) W('删过孔未确认: ' + JSON.stringify(pick('viaDeleteUnconfirmed')));
if (has('viaKept')) W('保孔（拒绝删）: ' + pick('viaKept').length + ' 个');

// 补线阶段
W('');
for (const k of ['patchRound', 'patchNoProgress', 'patchTotal', 'patchNoGeo', 'patchPairSynth', 'patchTooFar', 'patchNoNet']) {
  if (!has(k)) continue;
  const arr = pick(k);
  if (k === 'patchNoGeo') W(k.padEnd(26) + '×' + arr.length);
  else W(k.padEnd(26) + JSON.stringify(arr.length > 3 && !showAll ? arr.slice(0, 3) : arr).slice(0, 220));
}

// 缝补阶段
W('');
const sDone = last('stitchDone');
const sRounds = pick('stitchRound');
if (sDone !== undefined) W('stitchDone : ' + JSON.stringify(sDone));
else W('stitchDone : 事件不存在');
W('stitchRound: ' + (sRounds.length ? sRounds.length + ' 轮；skippedNoAnchor/skippedTooFar 字段 ' +
  (sRounds.some(r => 'skippedNoAnchor' in r) ? '有' : '**无**（旧构建，不能读成 0）') : '无（缝补在 stitchDone 处就 break，没进循环）'));
const sTot = last('stitchedTotal');
W('stitchedTotal(常量打印，不是增量): ' + (sTot === undefined ? '—' : sTot));
const sEv = pick('stitch');
W('stitch 补线: ' + sEv.length + ' 条' + (sEv.length && sEv.some(e => e.id) ? '（含 id）' : '（无 id）'));
if (showAll) for (const e of sEv) W('      ' + JSON.stringify(e));

// 终局违规
W('');
W('终局 DRC 明细（来源 value.drcDetails）:');
if (!leafMeasurable) {
  W('  ⚠ 返回值**没有 drcDetails** → 本次运行的终局违规**无法判断**（不是 0 处）');
} else if (!leaves.length) {
  W('  drcDetails 是空数组 → **0 处违规**（空数组是合法答案）');
} else {
  W('  合计 ' + leaves.length + ' 处：Connection ' + connLeaves.length + ' / Clearance ' + clearLeaves.length +
    (otherLeaves.length ? ' / 其它 ' + otherLeaves.length : ''));
  const byType = dupCount(leaves, l => (l.errorType || '?') + ' | ' + (l.errorObjType || '?'));
  for (const [k, n] of byType) W('    ' + k.padEnd(48) + '×' + n);
  for (const l of (showAll ? leaves : leaves.slice(0, 6))) {
    const ed = (l.explanation && l.explanation.errData) || {};
    // 【单位与标签】errData.position / .minDistance / .clearance 都是画布单位（mil/10），
    // 三者都要 ×10 才是 mil。其中 minDistance 是**实测**距离（= cur），clearance 是**要求**
    // 距离（= need）—— 我第一版把 minDistance 标成 need，于是 cur=0 的违规在报告里变成
    // "need=0"，看起来像规则要求为 0，实际是"铜贴住了障碍物"。
    const pos = ed.position ? ('[' + (Number(ed.position.x) * 10).toFixed(1) + ',' + (Number(ed.position.y) * 10).toFixed(1) + ']') : '—';
    const cur = (ed.minDistance != null) ? ' cur=' + (Number(ed.minDistance) * 10).toFixed(2) : '';
    const need = (ed.clearance != null) ? ' need=' + (Number(ed.clearance) * 10).toFixed(2) : '';
    W('      ' + pos + ' ' + (l.errorType || '') + ' ' + (ed.net || '') + cur + need);
  }
}

const dc = last('drcCheck');
W('');
W('drcCheck   : ' + (dc ? ('passed=' + dc.passed + ' detailLen=' + dc.detailLen) : '无记录'));
const dA = pick('drcAttempt');
if (dA.length) W('drcAttempt : ' + dA.map(a => '#' + a.attempt + '=' + a.passed).join(' '));
const dLc = last('drcLeafCount');
if (dLc) W('drcLeafCount: ' + JSON.stringify(dLc));
W('connDiag   : ' + pick('connDiag').length + ' 条');

// 产物
const ex = last('exports');
W('');
if (Array.isArray(ex)) {
  W('产物 ' + ex.filter(e => e.ok).length + '/' + ex.length + ' 成功');
  for (const e of ex) W('  ' + String(e.name).padEnd(18) + (e.ok ? 'ok' : 'FAIL') + '  ' + e.size + ' B');
} else W('产物       : 无 exports 记录');

// ---------- 判决 ----------
W('');
W('================ 判决 ================');
const reasons = [];
if (!Array.isArray(ex)) reasons.push('没有产物记录');
else {
  const bad = ex.filter(e => !e.ok);
  if (bad.length) reasons.push('产物失败 ' + bad.length + ' 个');
  if (!ex.length) reasons.push('产物列表为空');
}
if (!leafMeasurable) reasons.push('终局违规无法判断（无 drcDetails）');
else if (connLeaves.length) reasons.push('断路 ' + connLeaves.length + ' 处');
else if (clearLeaves.length) reasons.push('间距违规 ' + clearLeaves.length + ' 处');
if (dc && dc.passed === false && leafMeasurable && !leaves.length) reasons.push('drcCheck 说未通过但明细为空（自相矛盾，需查）');
const ok = leafMeasurable && leaves.length === 0 && Array.isArray(ex) && ex.length > 0 && ex.every(e => e.ok);
W(ok ? '  通过（终局 0 违规，产物齐备）' : '  未通过：' + reasons.join('；'));
const stops = pick('stopsOnErr');
if (stops.length) W('  中止原因: ' + JSON.stringify(stops));
W('======================================');
process.exit(ok ? 0 : 1);
