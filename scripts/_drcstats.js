#!/usr/bin/env node
// 临时探针：只读 logs/*.json，统计 DRC 修复策略的净收益。不碰 EDA、不写工程文件。
// 用法: node scripts/_drcstats.js [--json]
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOGDIR = path.join(ROOT, 'logs');

// ---------- 读文件（容忍尾部垃圾，例如 SESSION_NOT_FOUND 文本）----------
function readJsonLoose(p) {
  const t = fs.readFileSync(p, 'utf8');
  try { return { ok: true, j: JSON.parse(t) }; } catch (e) { }
  const i = t.indexOf('{');
  if (i < 0) return { ok: false, err: 'no { found' };
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let k = i; k < t.length; k++) {
    const c = t[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end > 0) {
    try { return { ok: true, j: JSON.parse(t.slice(i, end + 1)), tail: t.slice(end + 1).trim() }; }
    catch (e) { return { ok: false, err: 'unparseable block' }; }
  }
  return { ok: false, err: 'unbalanced braces (truncated)' };
}

// ---------- DRC 明细遍历 ----------
function walkGroups(node, prefix, out) {
  if (!node) return;
  if (Array.isArray(node)) { node.forEach(n => walkGroups(n, prefix, out)); return; }
  if (Array.isArray(node.list)) { walkGroups(node.list, prefix.concat(node.name || '?'), out); return; }
  out.push({ group: prefix.join(' / '), errorType: node.errorType || prefix[0] || '?', objType: node.errorObjType || '?' });
}

// ---------- 单文件解析 ----------
// 键名以 pipeline3.js 里的 `log('...')` 为准，不要凭印象加。2026-11-25 的改动把两个
// "回滚成功"键换成了独立的失败键（rollbackLineFail / rollbackModifyFail /
// trackDoglegFixFail / trackRerouteFixFail），并把 via 回滚拆成 4 个键 —— 旧脚本只认
// trackRerouteRolledBack，会把这些新的失败事件**静默统计成 0**（计数为 0 与"没发生过"不可区分）。
const FIX_EVENTS = new Set(['trackThinned', 'trackRerouted', 'trackDogleg', 'trackFixErr',
  'trackDoglegFixFail', 'trackRerouteFixFail',
  'viaShrunk', 'viaDeleted', 'viaKept', 'viaFixErr',
  'clearanceReverted', 'clearanceBudgetSkip', 'padGetErr',
  'rollbackOk', 'rollbackLineFail', 'rollbackModifyFail',
  'clearanceRevertDeleteFail', 'clearanceRevertLineRestoreFail',
  'clearanceRevertViaRestoreFail', 'clearanceRevertViaUnrestorable',
  'clearanceFixesNegative', 'snapDotDelErr',
  // ★ 2026-11-25 补：delete/modify 的失败方式是**返回值**（false/undefined），
  // 不是异常。改成判返回值后新出现的键必须在这里登记，否则
  // 「没统计」与「统计到 0」在报告里完全同形。
  'snapModifyUnconfirmed', 'viaModifyUnconfirmed', 'viaDeleteUnconfirmed',
  'trackThinUnconfirmed', 'patchRollbackFail',
  // ★ 2026-11-25 补（与上面同因）：L 形拐弯的 modify 从 try 外移到判定内，新增此键。
  'trackCornerUnconfirmed',
  // ★ 2026-11-25 深夜补：clearance 循环新增「无进展即停」，覆铜重建从「没抛就算成功」
  // 改成真实计数。这些键不登记的话，报告里「没统计」与「统计到 0」完全同形 ——
  // 而 11 处裸空 catch 的历史教训正是「没记录 ≠ 没发生」。
  'clearanceNoProgress',
  // ★ 2026-11-26 补：fixClearance 里两个修复循环各有分工（Via 环 / Track 环），
  // 两侧都不是 Via/Track 的违规**没有任何处理者**，每轮原样带过去。
  // 旧报告看不出来，因为 fixed 是别的项在涨、clearanceRound 也照常打印。
  // 这四个键不登记，那么"没有这类违规"与"根本没统计"在输出上完全同形。
  'clearanceUnclaimable', 'clearanceNoHandler', 'clearanceAllUnclaimable',
  'clearanceRevertGaveUp',
  // ★ 2026-11-26 凌晨补：布线器作业超时被主动取消后，DRC 若证明断连为 0，
  // routeState 会从 TIMEOUT/ERR/budget 校正成 completed 并记这条。
  // 这是**改变整次运行成败**的事件，不登记的话「从没发生过」与「统计到 0」同形 ——
  // 而它恰恰是"板子明明通了却被判死"的唯一痕迹。
  'routeStateRecovered',
  // ★ 2026-11-26 凌晨补：补铜时"两对象已贴合但分处不同层"的正确处置是打一个过孔，
  // 不再当成死铜孤岛跳过。这两种结局必须分格：
  // patchedCrossLayer 是"真下手修了"，patchCrossLayerNoObj 是"下手但 create 返回
  // undefined（静默失败）"。合成一格会让"修了没成"看起来像"没遇到"。
  'patchedCrossLayer', 'patchCrossLayerNoObj',
  'pourMeasured', 'pourRebuildEmpty', 'pourMeasureErr', 'pourRebuildErr', 'pourFail',
  // ★ 2026-11-26 凌晨补：这三格回答"断路是覆铜重建造成的，还是上游阶段造成的"。
  // connBeforePour 是重建**之前**测到的断连数，与最终 drcLeaves 对照才有意义；
  // 只记 0 而不记"没测"会把"预算跳过"读成"板子是通的"，所以 Skip/Err 必须分格。
  'connBeforePour', 'connBeforePourErr', 'connBeforePourSkip', 'connAfterClearance',
  // ★ 2026-11-26 凌晨补：槽（Slot）在布线前被罩成禁布区这件事必须留下成功与失败两种痕迹。
  // 只记 slotKeepout 而漏掉 Err，会把"调用抛异常"读成"板上没有槽"。
  'slotKeepout', 'slotKeepoutErr',
  // ★ 2026-11-26 凌晨补：两侧搜索救回来的那处违规要能和"一次普通成功"分开统计，
  // 否则无法回答"旧实现到底在这里放弃了多少处"。
  'clearanceFlippedSide']);

function analyze(file) {
  const full = path.join(LOGDIR, file);
  const r = readJsonLoose(full);
  const st = fs.statSync(full);
  const rec = { file, mtime: st.mtime.toISOString(), bytes: st.size };
  if (!r.ok) { rec.kind = 'unparseable'; rec.err = r.err; return rec; }
  const j = r.j;
  if (j && j.ok === false && j.error) { rec.kind = 'envelope-error'; rec.err = j.error.code + ': ' + (j.error.message || '').slice(0, 60); return rec; }
  const v = j.value;
  if (!v || !Array.isArray(v.log)) { rec.kind = 'non-pipeline'; return rec; }
  rec.kind = 'pipeline';
  rec.design = file.replace(/-\d{8}-\d{6}\.json$/, '').replace(/\.json$/, '');
  rec.ok = !!v.ok;
  rec.drcPassed = v.drcPassed === true;
  rec.pass = rec.ok && rec.drcPassed;
  rec.boardW = v.boardWidthMil; rec.boardH = v.boardHeightMil;
  rec.area = (rec.boardW || 0) * (rec.boardH || 0);
  rec.fill = v.outlineFillRatio;
  rec.detailCount = v.drcDetailCount;
  rec.elapsedMs = Number(v.elapsedMs || j.durationMs || 0);
  rec.compN = Array.isArray(v.components) ? v.components.length : null;
  const nets = new Set();
  for (const c of (v.netSummary || [])) for (const k in (c.pins || {})) { const n = c.pins[k]; if (n) nets.add(n); }
  rec.netN = nets.size;
  rec.connN = Array.isArray(v.netSummary) ? v.netSummary.reduce((a, c) => a + Object.keys(c.pins || {}).filter(k => c.pins[k]).length, 0) : null;

  // 阶段耗时：pipeline3.js 的 phase(n) 打在**该阶段开始时**（ms = 距 T0 累计）。
  // 交叉验证：89 个日志全部走了 pourCount>0 分支（patchSkipped），该分支只写一行日志、
  // 不做实际修补 → 若「起点打点」成立，patchDrc 段耗时必为 0；实测恰为 0/1ms，
  // 而按「终点打点」解释则为 3~25s（= 上一段的工作量）。故取 起点打点。
  const ph0 = v.log.filter(e => e.s === 'PHASE' && e.v).map(e => ({ n: e.v.n, ms: Number(e.v.ms) || 0 }));
  const phases = [];
  for (let i = 0; i < ph0.length; i++) {
    const end = i + 1 < ph0.length ? ph0[i + 1].ms : rec.elapsedMs;
    phases.push({ n: ph0[i].n, d: Math.max(0, end - ph0[i].ms) });
  }
  rec.phases = phases;

  // 事件流：按 clearanceRound 切轮
  const rounds = [];
  // 每个 FIX_EVENTS 里的键都必须在这里有一格，否则 `if (s in counts)` 不会累加，
  // 报告里就只剩 "0" —— 而 "0" 和 "没统计" 在输出上完全一样。
  const counts = { trackThinned: 0, trackRerouted: 0, trackDogleg: 0, trackFixErr: 0,
    trackDoglegFixFail: 0, trackRerouteFixFail: 0,
    viaShrunk: 0, viaDeleted: 0, viaKept: 0, viaFixErr: 0, padGetErr: 0,
    rollbackOk: 0, rollbackLineFail: 0, rollbackModifyFail: 0,
    clearanceReverted: 0, clearanceBudgetSkip: 0, clearanceDone: 0,
    clearanceRevertDeleteFail: 0, clearanceRevertLineRestoreFail: 0,
    clearanceRevertViaRestoreFail: 0, clearanceRevertViaUnrestorable: 0,
    clearanceFixesNegative: 0, snapDotDelErr: 0, snapDotDelUnconfirmed: 0,
    // 返回值未确认（delete 返 false / modify 返 undefined）：这些是
    // 「以为修了其实没修」，与「修失败」不同 —— 必须单独成格，不能混进 fixed 也不该静默丢弃。
    snapModifyUnconfirmed: 0, viaModifyUnconfirmed: 0, viaDeleteUnconfirmed: 0, trackCornerUnconfirmed: 0,
    trackThinUnconfirmed: 0, patchRollbackFail: 0,
    // 「无处理者」三态必须分格：unclaimable 是"本轮有这类违规"，
    // allUnclaimable 是"本轮全是这类违规、提前退出"，noHandler 是"某个环跳过了它"。
    // 合成一格会让"没统计到"与"确实一次都没有"继续同形。
    clearanceUnclaimable: 0, clearanceNoHandler: 0, clearanceAllUnclaimable: 0,
    clearanceRevertGaveUp: 0,
    // 布线器作业超时/出错/预算跳过之后，DRC 证明断连为 0 而把 routeState 校正回
    // completed 的次数。它必须与 routeCancelled / routeBudgetStop 分开成格：
    // 前者是"板子通了但作业被判超时"，后者是"作业确实没跑完"，混在一格就分不清。
    routeStateRecovered: 0,
    // 补铜的两条新结局：打了跨层过孔 / 打孔 create 静默失败。分开成格，
    // 否则"修好了"与"下手了但没成"在报告里同形。
    patchedCrossLayer: 0, patchCrossLayerNoObj: 0,
    // 原理图那一帧等页面就绪失败。必须单独一格：否则"这一轮没有原理图帧"与
    // "原理图页根本没就绪"在报告里同形，又会退回成"这版没有原理图"。
    schShotWaitFail: 0,
    // 删孔前读坐标/型号失败。缺它会让"补不回来"看起来像是记录格式的锅，
    // 而真实原因是这一次读取就没成功 —— 两种成因必须分得开。
    viaGeomErr: 0,
    // 底层视图那两拍：切层失败 / 恢复失败。恢复失败尤其要单独一格 ——
    // 它意味着后续每一帧都只拍到一面，而视频看起来完全正常。
    bottomViewErr: 0, bottomViewRestoreErr: 0,
    // Hole×Hole 处理者（两侧都是孔，原有两个环都不认领）。这几种情况必须**分开**记账：
    //   nudged=真的推动了过孔 / noVia=缺口附近找不到可动过孔 / tooFar=需要的位移超出安全区
    //   / odd=数据自相矛盾 / noCoord=读数缺失 / degenerate=过孔心与缺口点重合
    // 混成一格会把"没找到对象"读成"物理上修不了" —— d12 就是被这么误判的。
    holePairNudged: 0, holePairSummary: 0, holePairNoVia: 0,
    holePairTooFar: 0, holePairOdd: 0, holePairNoCoord: 0,
    holePairDegenerate: 0, holePairModifyFail: 0, holePairModifyErr: 0,
    holePairViaIndexErr: 0,
    // 失败侧的 DRC 叶子明细：drcCheck 只存 {passed, detailLen:1}，
    // 若不再单独记 drcLeaves，"哪一类违规"就只存在于当次控制台里。
    // 这几个键必须各占一格，否则 `if (s in counts)` 不累加，
    // 报告里只会剩下 "0" —— 而 "0" 与 "没统计" 在输出上完全一样。
    drcLeaves: 0, drcLeavesErr: 0,
    // 通用按 id 取几何（pcb_Primitive.getPrimitivesBBox）的五种结局，
    // 分开计数才能区分"API 没有这个能力"与"这个 id 没有 bbox"与"bbox 不含违规点"。
    uniGeo: 0, uniGeoNoBBox: 0, uniGeoBadBox: 0,
    uniGeoUnavailable: 0, uniGeoTypeErr: 0, uniGeoBBoxErr: 0,
    // ★ 2026-11-26 补：下列键在 pipeline3.js 里都在 log()，却一直没有格子，
    //   `if (s in counts)` 永不成立 ⇒ 报告里恒为「0」，而「0」与「没统计」同形。
    //   其中 clearanceNoProgress / pourMeasured / pourRebuildEmpty / pourMeasureErr /
    //   pourRebuildErr / pourFail 六个**早已登记进 FIX_EVENTS 却没开格**，
    //   等于「覆铜重建成功了几次」这一整列一直是假的 0。
    //   守卫见 scripts\_test-stats-coverage.js（登记即开格，否则红）。
    boardCreateErr: 0, boardWaitBudgetSkip: 0, camErr: 0, clearanceNoProgress: 0,
    clearanceSkipDegenerate: 0, clearanceSkipNoGeo: 0, clearanceSkipNoPos: 0, clearanceSkipNoPush: 0,
    clearanceSkipTooShort: 0, clearanceThinHopeless: 0, connAfterClearance: 0, connBeforePour: 0,
    connBeforePourErr: 0, connBeforePourSkip: 0, connDiagErr: 0, createProjectEmpty: 0,
    createProjectErr: 0, drcBudgetSkip: 0, drcFalseNegative: 0, drcFalseNegativeRejected: 0,
    exportSkipped: 0, geoAccessorErr: 0, geoDiscretizeErr: 0, geoGetErr: 0,
    geoIndexErr: 0, geoUnparsedSrc: 0, iterDrcErr: 0, layoutCancelErr: 0,
    outlineDelErr: 0, outlineReadErr: 0, patchBudgetSkip: 0, patchErr: 0,
    patchGeoErr: 0, patchNoProgress: 0, patchPerErr: 0, patchReverted: 0,
    patchVerifyErr: 0, pinGeoErr: 0, pourErr: 0, pourFail: 0,
    pourMeasureErr: 0, pourMeasured: 0, pourRebuildEmpty: 0, pourRebuildErr: 0, preViaErr: 0,
    routeBudgetSkip: 0, routeCancelErr: 0, routeErr: 0, routeRulesProofErr: 0,
    runLogFail: 0, runMetaFail: 0, shotErr: 0, slotKeepout: 0, slotKeepoutErr: 0, snapErr: 0,
    clearanceFlippedSide: 0,
    snapFail: 0, stitchErr: 0, viaErr: 0, viaNetErr: 0,
  };
  const errTexts = [];
  const padKinds = [];
  // 失败侧叶子的按类型聚合：这是"这批失败到底是不是同一个根因"的唯一直接证据
  const leafByType = new Map();
  const uniGeoSamples = [];   // {id,type,box,viol,contains}
  let leafEventCount = 0;
  const rerouteNets = new Map();
  const idNet = new Map();
  let cur = null;
  const ensure = () => { if (!cur) { cur = { pre: true, acts: {}, errs: [] }; rounds.push(cur); } return cur; };
  for (const e of v.log) {
    const s = e.s; const x = e.v || {};
    if (s in counts) counts[s]++;
    if (s === 'drcLeaves') {
      leafEventCount++;
      // 载荷形如 {n, byType:{'Clearance Error | Slot Region':'x'}, byNet:{...}, sample:[...]}
      const bt = (x && x.byType) || {};
      for (const k in bt) leafByType.set(k, (leafByType.get(k) || 0) + Number(bt[k] || 0));
    }
    if (s === 'uniGeo') {
      uniGeoSamples.push({ id: String((x && x.id) || ''), type: (x && x.type) || null,
        box: (x && x.box) || null, viol: (x && x.viol) || null, contains: !!(x && x.contains) });
    }
    if (s === 'clearanceRound') {
      if (cur) { rounds.pop(); } // 占位轮（pre）与真实轮重复
      rounds.push({ round: x.round, violations: x.violations, fixed: x.fixed, acts: (cur && cur.acts) || {}, errs: (cur && cur.errs) || [] });
      cur = null;
      continue;
    }
    if (s === 'clearanceDone') counts.clearanceDone++;
    if (!FIX_EVENTS.has(s)) continue;
    const R = ensure();
    R.acts[s] = (R.acts[s] || 0) + 1;
    if (s === 'trackThinned' || s === 'trackRerouted' || s === 'trackDogleg') {
      if (x.line) idNet.set(String(x.line), x.net);
      if (s === 'trackRerouted' && x.padKind) padKinds.push(String(x.padKind));
      if (s === 'trackRerouted') { const n = String(x.net || '?'); rerouteNets.set(n, (rerouteNets.get(n) || 0) + 1); }
    }
    // 失败事件的载荷形状不统一：有的带 m（原始报错），有的只有 n + ids（哪个对象没删掉），
    // 而 snapDotDelErr 直接记的是字符串（`e.v` 是 string，不是对象）。
    // 统一成一句可 grep 的文本，否则这些事件在表里只剩一个计数、看不出到底哪条线没救回来。
    const FAIL_EVENTS = new Set(['trackFixErr', 'padGetErr', 'viaFixErr',
      'trackDoglegFixFail', 'trackRerouteFixFail',
      'rollbackLineFail', 'rollbackModifyFail',
      'clearanceRevertDeleteFail', 'clearanceRevertLineRestoreFail',
      'clearanceRevertViaRestoreFail', 'clearanceRevertViaUnrestorable',
      'clearanceFixesNegative', 'snapDotDelErr', 'snapDotDelUnconfirmed',
      // 回滚放弃 = 铜留在中间态（modify/delete 返 undefined/false，不抛异常）。
      // 这条一旦发生，板上的实际状态比日志里的"已回滚"更糟，必须能单列出来。
      'clearanceRevertGaveUp']);
    if (FAIL_EVENTS.has(s)) {
      const idList = Array.isArray(x.ids) ? x.ids.map(String) : [];
      const m = String(x.m || x.message || (typeof e.v === 'string' ? e.v : '')
        || (x.n !== undefined ? 'n=' + x.n + (idList.length ? ' ids=' + idList.join(',') : '') : '')
        || (x.fixes !== undefined ? 'fixes=' + x.fixes + ' givenBack=' + x.givenBack : '')
        // snapDotDelUnconfirmed：delete 返回的不是 true（真实 API 失败时 resolve(false) 而非抛错），
        // 载荷是 {id,net,w,ret} —— 不专门解一下，这条会退化成一个纯计数、看不出是哪条线没删掉。
        || (x.ret !== undefined ? 'ret=' + x.ret + ' net=' + (x.net || '?') + ' w=' + (x.w !== undefined ? x.w : '?') : ''));
      errTexts.push({ ev: s, m: m.slice(0, 200),
        id: x.line || x.id || x.pad || x.via || (idList[0] || null),
        where: x.where || null,
        round: R.round !== undefined ? R.round : '?' });
      R.errs.push(s + (m ? ':' + m.slice(0, 80) : ''));
    }
  }
  rec.rounds = rounds.filter(R => R.round !== undefined || Object.keys(R.acts || {}).length);
  // 最终 DRC 明细
  const leaves = [];
  walkGroups(v.drcDetails, [], leaves);
  rec.finalByObj = new Map(); rec.finalByErr = new Map();
  for (const l of leaves) {
    rec.finalByObj.set(l.objType, (rec.finalByObj.get(l.objType) || 0) + 1);
    rec.finalByErr.set(l.errorType, (rec.finalByErr.get(l.errorType) || 0) + 1);
  }
  rec.finalClear = rec.finalByErr.get('Clearance Error') || 0;
  rec.finalConn = rec.finalByErr.get('Connection Error') || 0;
  rec.leaves = leaves;
  // 【两个不同的东西，别混】`drcLeaves` 是一条**日志事件**（版本很晚才加，只有 5 份日志有）；
  // `v.drcDetails` 是流水线的**返回值**（覆盖广得多）。按对象对聚合要用后者。
  // 我一度用 leafEventCount 当覆盖度分母，得出的"只在 5 份里成立"与表里"涉及日志数 9"直接矛盾 ——
  // 覆盖度写错方向比不写更坏：它会让真实数据看起来不可信。
  rec.hasDrcDetails = Array.isArray(v.drcDetails);
  // 结构长度：用来区分"空树（DRC 真没报）"与"树里有东西"。只存布尔会让两者无法分辨，
  // 于是"字段覆盖 165/165"会被读成"数据齐全"，而实际大部分是空树。
  rec.drcDetailsLen = rec.hasDrcDetails ? v.drcDetails.length : null;
  const dr = v.log.filter(e => e.s === 'drcResult');
  rec.drcResultN = dr.length ? dr[dr.length - 1].v.n : null;
  rec.drcAttempts = v.log.filter(e => e.s === 'drcAttempt').length;
  rec.clearanceFixes = (v.log.find(e => e.s === 'clearanceFixes') || {}).v;
  rec.errTexts = errTexts;
  rec.padKinds = padKinds;
  rec.rerouteNets = [...rerouteNets.entries()];
  rec.idNet = idNet.size ? Object.fromEntries(idNet) : {};
  rec.hasClearDiag = v.log.some(e => e.s === 'clearDiag');
  rec.hasRevert = counts.clearanceReverted > 0;
  rec.counts = counts;
  // 失败侧叶子的按类型聚合。leafEventCount===0 且 rec.drcPassed===false 时，
  // 说明这次失败发生在加 drcLeaves 之前（**没测到**），不能读成"没有违规类型"。
  rec.leafEventCount = leafEventCount;
  rec.leafByType = [...leafByType.entries()].sort((a, b) => b[1] - a[1]);
  rec.uniGeo = {
    events: counts.uniGeo,
    noBBox: counts.uniGeoNoBBox,
    badBox: counts.uniGeoBadBox,
    unavailable: counts.uniGeoUnavailable,
    typeErr: counts.uniGeoTypeErr,
    bboxErr: counts.uniGeoBBoxErr,
    // 只有 contains===true 才会被拿去改道；这里同时留样本，便于核对"盒子是不是真在那个点"
    hit: uniGeoSamples.filter(s => s.contains).length,
    miss: uniGeoSamples.filter(s => !s.contains).length,
    samples: uniGeoSamples.slice(0, 6),
  };
  rec.stitchN = v.log.filter(e => e.s === 'stitch').length;
  // 缝补那一刻的断点数（`stitchDone.remaining`）。null = 没有该事件（不是 0）。
  const stDone = v.log.filter(e => e.s === 'stitchDone').map(e => e.v);
  rec.doneRemaining = (stDone.length && stDone[0] && typeof stDone[0].remaining === 'number') ? stDone[0].remaining : null;
  rec.hasStitchDone = stDone.length > 0;
  rec.stitchRounds = v.log.filter(e => e.s === 'stitchRound').map(e => e.v);
  // 缝补补出的每条铜的坐标。只计数不够：要回答"缝合有没有自己造出间距违规"，
  // 必须能把 stitch 的 from/to 与终局违规的 at 放在一起看（间距按坐标报，不按对象报）。
  rec.stitchEvents = v.log.filter(e => e.s === 'stitch').map(e => e.v);
  rec.routeN = v.log.filter(e => e.s === 'route').length;
  return rec;
}

// ---------- 主流程 ----------
// 无人值守循环在持续写日志 → 用 --before=<ISO 本地时间> 冻结样本，保证数字可复现。
const beforeArg = (process.argv.find(a => a.startsWith('--before=')) || '').slice(9);
const CUTOFF = beforeArg ? new Date(beforeArg) : null;
const allRaw = fs.readdirSync(LOGDIR).filter(f => f.toLowerCase().endsWith('.json')).sort();
const all = CUTOFF ? allRaw.filter(f => fs.statSync(path.join(LOGDIR, f)).mtime <= CUTOFF) : allRaw;
const skippedByCutoff = allRaw.length - all.length;
const recs = all.map(analyze);
const pipes = recs.filter(r => r.kind === 'pipeline');
const probes = pipes.filter(r => /^diag-/.test(r.file));
const main = pipes.filter(r => !/^diag-/.test(r.file));
const bad = recs.filter(r => r.kind === 'unparseable');
const envErr = recs.filter(r => r.kind === 'envelope-error');
const other = recs.filter(r => r.kind === 'non-pipeline');

const md = [];
const P = (...a) => md.push(a.join(''));
const num = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x)) ? '—' : Number(x).toFixed(d);
const pct = (a, b) => (!b ? '—' : (100 * a / b).toFixed(1) + '%');

P('### 0. 样本范围');
P('');
P('| 项 | 值 |');
P('|---|---|');
P('| logs/ 下 .json 总数 | ' + recs.length + ' |');
P('| 可解析且为流水线返回（value.log 存在） | ' + pipes.length + ' |');
P('| 其中标准流水线日志（参与统计） | **' + main.length + '** |');
P('| 其中 diag-* 探针（另计） | ' + probes.length + ' |');
P('| 信封错误（SESSION_NOT_FOUND 等，无 value） | ' + envErr.length + ' |');
P('| 无法解析 / 非流水线结构 | ' + bad.length + ' + ' + other.length + ' |');
const mt = recs.map(r => r.mtime).sort();
P('| 文件修改时间跨度（UTC） | ' + mt[0] + ' → ' + mt[mt.length - 1] + ' |');
P('| 样本冻结截止 | ' + (CUTOFF ? CUTOFF.toISOString() + '（因截止被排除 ' + skippedByCutoff + ' 个）' : '未冻结（统计当下全部文件）') + ' |');
P('| 含 clearDiag 事件的日志 | **' + pipes.filter(r => r.hasClearDiag).length + '** |');
P('| 含 clearanceReverted 的日志 | **' + pipes.filter(r => r.hasRevert).length + '** |');
P('| trackDogleg 事件总数 | **' + pipes.reduce((a, r) => a + (r.counts.trackDogleg || 0), 0) + '** |');
P('| clearanceBudgetSkip / drcBudgetSkip 总数 | ' + pipes.reduce((a, r) => a + (r.counts.clearanceBudgetSkip || 0), 0) + ' |');
// ★ delete 返回 false / modify 返回 undefined 都是**静默失败**（不抛异常）。
// 不单独列出来的话，它们只能被读成 fixed，与真正的修复同形。
const unconf = ['snapModifyUnconfirmed', 'viaModifyUnconfirmed', 'viaDeleteUnconfirmed', 'trackThinUnconfirmed', 'patchRollbackFail', 'trackCornerUnconfirmed'];
const unconfSum = unconf.map(k => [k, pipes.reduce((a, r) => a + (r.counts[k] || 0), 0)]).filter(x => x[1] > 0);
P('| 返回值未确认（以为修了其实没修） | ' + (unconfSum.length ? unconfSum.map(x => '' + x[0] + '×' + x[1]).join('、') : '0') + ' |');
P('');
P('环境错误文件：' + envErr.map(r => '`' + r.file + '`').join('、'));
P('');

// ---------- 1. 轮次明细 ----------
P('### 1a. 每轮明细（violations = 该轮开局 DRC 的违规数；netΔ = 下一轮 violations − 本轮 violations，负数=改善）');
P('');
P('| 日志 | 轮 | violations | fixed | 本轮动作 | netΔ | 判定 |');
P('|---|---|---|---|---|---|---|');
function sig(acts) {
  const m = [['trackThinned', '缩窄'], ['trackRerouted', '绕行'], ['trackDogleg', '平移'], ['viaShrunk', '缩孔'], ['viaDeleted', '删孔']];
  const out = m.filter(([k]) => acts[k]).map(([k, n]) => n + '×' + acts[k]);
  if (acts.trackFixErr) out.push('异常×' + acts.trackFixErr);
  if (acts.viaKept) out.push('保孔×' + acts.viaKept);
  return out.join(' ') || '—';
}
// 【一处算 delta，三处用】这段减法原本在报告里被抄了三遍（逐轮表 / 净收益表 /
// 动作收益汇总），于是同一个缺陷在三张表里各坏一次：ensure() 造的占位轮
// {pre:true,acts,errs} **没有 violations**，undefined - n = NaN，
// 而判空只写了 `delta === null`（NaN 不是 null，直接漏过），
// 结果就是「净变化 NaN」「| undefined | undefined | NaN | ❌ 变糟 |」这种行 ——
// 表格看着正常，结论全部作废。
// 合并后同时返回口径来源：实测 / 清零 / ≈终局 三种来源混在同一列里，
// 不标来源就读不出"+11 到底是实测还是拿终局倒推的"。
const roundDelta = (R, i, r) => {
  const vNow = Number(R[i].violations);
  if (!Number.isFinite(vNow)) return { delta: null, note: '无违规数' };
  if (i + 1 < R.length) {
    const vNext = Number(R[i + 1].violations);
    if (Number.isFinite(vNext)) return { delta: vNext - vNow, note: '实测' };
    return { delta: null, note: '下一轮无违规数' };
  }
  if (r.counts.clearanceDone) return { delta: -vNow, note: '清零' };
  const fc = Number(r.finalClear);
  if (r.finalClear != null && Number.isFinite(fc)) return { delta: fc - vNow, note: '≈终局' };
  return { delta: null, note: '无终局数' };
};
let roundRows = 0;
let deltaUnusable = 0;
for (const r of main) {
  const R = r.rounds;
  for (let i = 0; i < R.length; i++) {
    const a = R[i];
    // 占位轮（ensure() 造的 {pre:true,acts,errs}）没有 violations，直接参与减法会得 NaN。
    // 这种轮次仍然有意义——"动作发生了但违规数没记录"，所以要输出成显式的 —，
    // 而不是让它污染 delta 列（以前这里会打出 `undefined | undefined | NaN | ❌ 变糟`）。
    const vNow = Number(a.violations);
    const hasV = Number.isFinite(vNow);
    const dd = roundDelta(R, i, r);
    const delta = dd.delta, note = dd.note;
    if (delta === null) deltaUnusable++;
    // 口径（）必须打出来：实测 / 清零 / ≈终局 三种来源混在一列里，
    // 不标来源就无法判断"+11 是实测还是拿终局倒推的"。
    P('| ' + r.file.replace(/\.json$/, '').slice(0, 34) + ' | ' + (a.round === undefined ? '占位' : a.round) + ' | ' +
      (hasV ? vNow : '—') + ' | ' + (a.fixed === undefined ? '—' : a.fixed) + ' | ' + sig(a.acts) + ' | ' +
      (delta === null ? '—' : (delta > 0 ? '+' : '') + delta) + ' | ' +
      (delta === null ? '（' + note + '）' : (delta < 0 ? '✅ 有效' : delta === 0 ? '⚪ 无变化' : '❌ 变糟')) + ' |');
    roundRows++;
  }
}
P('');
P('（共 ' + roundRows + ' 个轮次行，其中 ' + deltaUnusable + ' 行**算不出** netΔ（占位轮或末轮无终局数），它们不计入任何合计）');
P('');

// ---------- 1b. 策略 → 净收益 ----------
P('### 1b. 策略 → 净收益（只统计能算出 netΔ 的轮次）');
P('');
P('「纯净轮次」= 该轮只有这一种有效动作（可干净归因）；「含该动作」= 该轮出现过该动作（相加会重复计）。');
P('');
const STRAT = [['trackThinned', '缩窄线宽'], ['trackRerouted', 'L 形绕行'], ['trackDogleg', '平移绕障'], ['viaShrunk', '缩小过孔'], ['viaDeleted', '删除过孔']];
const rnds = [];
for (const r of main) {
  const R = r.rounds;
  for (let i = 0; i < R.length; i++) {
    const a = R[i];
    const delta = roundDelta(R, i, r).delta;
    if (delta === null) continue;
    rnds.push({ delta, file: r.file, round: a.round, fixed: a.fixed, v: a.violations, acts: a.acts || {}, last: i + 1 === R.length });
  }
}
const hasA = (a, k) => (a.acts[k] || 0) > 0;
const pureOf = (a) => { const ks = STRAT.map(s => s[0]).filter(k => hasA(a, k)); return ks.length === 1 ? ks[0] : null; };
P('| 策略 | 纯净轮次 | 纯净轮净减少合计 | 纯净轮平均净减少 | 含该动作轮次 | 有效/无变化/变糟 | 最差案例（netΔ>0） |');
P('|---|---|---|---|---|---|---|');
for (const [k, label] of STRAT) {
  const pure = rnds.filter(x => pureOf(x) === k);
  const all = rnds.filter(x => hasA(x, k));
  if (!all.length) { P('| ' + label + ' (`' + k + '`) | 0 | — | **无数据** | 0 | — | — |'); continue; }
  const pNet = -pure.reduce((s, x) => s - x.delta, 0);          // 正数=违规减少
  const avgAll = all.reduce((s, x) => s - x.delta, 0) / all.length;
  const bad = all.filter(x => x.delta > 0);
  const good = all.filter(x => x.delta < 0).length, flat = all.filter(x => x.delta === 0).length;
  P('| ' + label + ' (`' + k + '`) | ' + pure.length + ' | ' + (pure.length ? (pNet >= 0 ? '+' : '') + pNet : '—') + ' | ' +
    (pure.length ? num(pNet / pure.length) : '—') + ' | ' + all.length + ' | ' + good + ' / ' + flat + ' / ' + bad.length + ' | ' +
    (bad.length ? bad.slice(0, 3).map(x => x.file.replace(/\.json$/, '').slice(-13) + '#' + x.round + '(+' + x.delta + ')').join('<br>') : '—') + ' |');
}
P('');
P('（「净减少」正数=违规变少；「纯净轮净减少合计」= 该策略单独出现时可干净归因的违规减少总数）');
P('');
// fixed vs 实际
let sumFixed = 0, sumDelta = 0, falseRounds = [], uncomputable = 0;
for (const r of main) {
  const R = r.rounds;
  for (let i = 0; i < R.length; i++) {
    if (R[i].fixed > 0) { sumFixed += R[i].fixed; }
    // 口径统一走 roundDelta（原先这里也抄了一份减法，同样会被占位轮的 undefined 毒成 NaN）
    const delta = roundDelta(R, i, r).delta;
    if (delta === null) { uncomputable++; continue; }
    sumDelta += delta;
    if (R[i].fixed > 0 && delta >= 0) falseRounds.push({ file: r.file, round: R[i].round, fixed: R[i].fixed, delta, v: R[i].violations, acts: R[i].acts });
  }
}
P('**动作次数 vs 实际收益**：可归因轮次里 `fixed` 合计 ' + sumFixed + ' 次，同口径 violations 净变化 ' + (sumDelta > 0 ? '+' : '') + sumDelta + '（即平均每次动作净改变 ' + num(sumDelta / (sumFixed || 1), 2) + ' 处）。' +
  (uncomputable ? ('另有 ' + uncomputable + ' 个轮次无法算净变化（占位轮无 violations，或末轮无终局数）—— 它们**不计入**，不是 0。') : ''));
P('');
P('`fixed>0` 但违规数没降（含上升）的轮次 **' + falseRounds.length + '** 个：');
P('');
P('| 日志 | 轮 | fixed | violations | netΔ | 动作 |');
P('|---|---|---|---|---|---|');
for (const f of falseRounds) P('| ' + f.file.replace(/\.json$/, '').slice(0, 34) + ' | ' + f.round + ' | ' + f.fixed + ' | ' + f.v + ' | +' + f.delta + ' | ' + sig(f.acts) + ' |');
P('');

// ---------- 2. 违规类型 ----------
P('### 2. 违规类型（终局 DRC 明细，value.drcDetails）');
P('');
// 【覆盖度必须写在表前】下面几张表的分母是"返回值带 drcDetails 的日志"，不是全部日志。
// 注意区分两个来源：`drcLeaves` 是**日志事件**（很晚才加，本语料只有 5 份）；
// `v.drcDetails` 是流水线**返回值**（覆盖广）。聚合用的是后者。
// 若只打印表格，没有行会被读成"没有违规"；若把覆盖度算错，真实数据又会被读成不可信。
const leafMeasured = main.filter(r => r.hasDrcDetails);
const leafUnmeasured = main.length - leafMeasured.length;
// 【覆盖度不能只写 N/M】本语料所有 pipeline 日志都带 drcDetails 字段 ⇒ N 恒等 M，
// 于是"165/165"的心理暗示是"数据齐全"，而其中大部分是**空树**。
// 空树只有在 drcPassed===true 时才能读成"真 0 处违规"；否则属**没有数据**。
const leafWithLeaves = leafMeasured.filter(r => (r.leaves || []).length > 0).length;
const leafEmptyPassed = leafMeasured.filter(r => !(r.leaves || []).length && r.drcPassed === true).length;
const leafEmptyNoData = leafMeasured.length - leafWithLeaves - leafEmptyPassed;
P('**覆盖度：' + leafMeasured.length + ' / ' + main.length + ' 份日志带 `drcDetails` 字段；其中实测有叶子 **' +
  leafWithLeaves + '** 份；空树但 `drcPassed===true`（真 0 处）**' + leafEmptyPassed +
  '** 份；空树且未判通过（**没有数据**，不能读成 0）**' + leafEmptyNoData + '** 份**' +
  (leafUnmeasured ? '；另有 **' + leafUnmeasured + '** 份连字段都没有 ⇒ 没有数据' : '') + '。');
P('（另有 `drcLeaves` 日志事件，本语料仅 ' + main.filter(r => (r.leafEventCount || 0) > 0).length +
  ' 份有——那是事件，不是本表的来源。）');
P('');
const clr = new Map(), clrF = new Map(), conn = new Map(), connF = new Map();
// 【别用 else 兜底】原来写的是 `if (Clearance) … else conn…`：任何第三种 errorType
// （工艺类 / 尺寸类）都会被算进"断连"表，冒充 Connection Error。改为显式三分。
const oth = new Map(), othF = new Map();
for (const r of main) {
  for (const l of (r.leaves || [])) {
    if (l.errorType === 'Clearance Error') clr.set(l.objType, (clr.get(l.objType) || 0) + 1);
    else if (l.errorType === 'Connection Error') conn.set(l.objType, (conn.get(l.objType) || 0) + 1);
    else oth.set(String(l.errorType), (oth.get(String(l.errorType)) || 0) + 1);
  }
}
// 重新遍历以保留文件维度
for (const r of main) {
  const seen = new Set();
  for (const l of (r.leaves || [])) {
    if (l.errorType === 'Clearance Error') seen.add('C:' + l.objType);
    else if (l.errorType === 'Connection Error') seen.add('N:' + l.objType);
    else seen.add('O:' + String(l.errorType));
  }
  for (const k of seen) {
    const nm = k.slice(2);
    if (k.startsWith('C:')) clrF.set(nm, (clrF.get(nm) || 0) + 1);
    else if (k.startsWith('N:')) connF.set(nm, (connF.get(nm) || 0) + 1);
    else othF.set(nm, (othF.get(nm) || 0) + 1);
  }
}
P('**间距类（Clearance Error）对象对：**');
P('');
P('| 对象对 (errorObjType) | 残留处数 | 涉及日志数 | fixClearance 能否触及 |');
P('|---|---|---|---|');
for (const [k, c] of [...clr.entries()].sort((a, b) => b[1] - a[1])) {
  const touch = /Track/.test(k) ? '能（缩窄/绕行针对 Track 侧）' : '不能（无 Track 侧，直接跳过）';
  const nf = clrF.get(k) || 0;
  P('| ' + k + ' | ' + c + ' | ' + nf + ' | ' + touch + ' |');
}
P('');
P('**连通性类（Connection Error）断开对象：**');
P('');
P('| 对象类型 | 残留处数 | 涉及日志数 |');
P('|---|---|---|');
let connRowN = 0;
for (const [k, c] of [...conn.entries()].sort((a, b) => b[1] - a[1])) { connRowN++; P('| ' + k + ' | ' + c + ' | ' + (connF.get(k) || 0) + ' |'); }
if (!connRowN) {
  // 空表是两种完全不同的情况，必须分开写，否则"0 行"被读成"0 处断连"。
  P('| （无行） | — | — |');
  P('');
  P('⚠ 上表为空**不代表没有断连**：终局明细非空的只有 ' + leafWithLeaves + ' / ' + leafMeasured.length +
    ' 份（其余空树里 ' + leafEmptyPassed + ' 份 `drcPassed===true` 属真 0，' + leafEmptyNoData + ' 份属没有数据）。');
  P('要判断连通性，应看 `stitchDone` / `stitchRound` 事件（每份日志都有），而不是这张表。');
}
P('');
if (oth.size) {
  // 第三种 errorType 必须单列：混进上面任一张表都会冒充。叫"其他"也不等于次要，
  // 可能完全没有处理者。
  P('**其他错误类型（既非间距也非连通；单列，不计入上面两张表）：**');
  P('');
  P('| 错误类型 | 残留处数 | 涉及日志数 |');
  P('|---|---|---|');
  for (const [k, c] of [...oth.entries()].sort((a, b) => b[1] - a[1])) P('| ' + k + ' | ' + c + ' | ' + (othF.get(k) || 0) + ' |');
  P('');
}
// 初始 vs 终局 clearance
let initSum = 0, finSum = 0, cleared = 0, nWithRound = 0, nClearEvidenced = 0, nClearNoData = 0;
const initFin = [];
for (const r of main) {
  if (!r.rounds.length) continue;
  const init = r.rounds[0].violations;
  if (typeof init !== 'number') continue;
  nWithRound++; initSum += init; finSum += r.finalClear;
  // 【没有数据 ≠ 0】r.finalClear 来自 `get(...) || 0`，空树同样得 0。
  // 必须要求"有叶子"或"drcPassed===true"才算拿得到终局值，否则计入"没有数据"。
  const finEvidenced = (Array.isArray(r.leaves) && r.leaves.length > 0) || r.drcPassed === true;
  if (finEvidenced) { nClearEvidenced++; if (r.finalClear === 0) cleared++; } else nClearNoData++;
  initFin.push({ file: r.file, init, fin: r.finalClear, rounds: r.rounds.length, ev: finEvidenced });
}
P('**间距违规（Clearance Error）总量**：' + nWithRound + ' 个设计开局合计 ' + initSum + ' 处 → 终局合计 ' + finSum +
  ' 处（净 ' + (finSum - initSum > 0 ? '+' : '') + (finSum - initSum) + '，' + pct(finSum, initSum) + ' 残留），' +
  '其中 **' + cleared + '** 个设计清零（终局可判定的 ' + nClearEvidenced + ' 个，' +
  (nClearNoData ? '另有 **' + nClearNoData + '** 个没有数据、未计入清零分母' : '无缺失') + '）。');
P('');
P('| 日志 | 开局 | 终局 | 轮数 |');
P('|---|---|---|---|');
for (const x of initFin.filter(x => x.init > 0).sort((a, b) => b.init - a.init).slice(0, 20)) {
  P('| ' + x.file.replace(/\.json$/, '').slice(0, 40) + ' | ' + x.init + ' | ' + x.fin + ' | ' + x.rounds + ' |');
}
P('');

// ---------- 2b. 缝补阶段跳过原因 ----------
// rec.stitchRounds 早就在 L316 被收集，却从未打印过 —— 收集了不读等于没测。
// 价值：skippedNoAnchor / skippedTooFar 是 stitch **静默放弃**的落点。
// 没有这两列，"缝补没收敛"只能归因成"引擎不行"，无法区分
// 「找不到同网锚点/最近距离>12」（布局或网络问题）与「锚点超过 MAX_GAP」（参数问题）。
// 缺列 = 该轮跑在没有计数器的旧版本上 ⇒ **没有数据**，不是 0。
// 【B11】截断日志名要保留尾部时间戳。否则同一设计的多份日志在表里长得一模一样，
// 而 2c 的目的恰恰是"把某条 stitch 与某处终局违规对照" —— 分不清是哪份就没法对照。
const shortName = (f, head) => {
  const n = String(f).replace(/\.json$/, '');
  return n.length <= head ? n : (n.slice(0, Math.max(4, head - 14)) + '…' + n.slice(-13));
};
P('### 2b. 缝补阶段（stitchGaps）每轮明细与跳过原因');
P('');
P('`skippedNoAnchor` = 该孤岛找不到同网锚点，或最近网络距离 > 12；`skippedTooFar` = 找到锚点但超过 MAX_GAP。');
P('「—」= 该轮代码还没有这个字段（**没有数据**，不能读成 0）。');
P('');
P('| 日志 | 轮 | broken | fixed | dupSkipped | skippedNoAnchor | skippedTooFar | 计数器 |');
P('|---|---|---|---|---|---|---|---|');
let stitchRoundsWith = 0, stitchRoundsWithout = 0, stitchLogs = 0;
for (const r of main) {
  if (!r.stitchRounds || !r.stitchRounds.length) continue;
  stitchLogs++;
  for (const rd of r.stitchRounds) {
    const hasA = typeof rd.skippedNoAnchor === 'number';
    const hasB = typeof rd.skippedTooFar === 'number';
    // 【B7】原来用 `hasA && hasB` 判"无计数器"，但两格各按 hasA/hasB 打印 ⇒
    // 会出现"计数器=无，但 skippedNoAnchor 列有数字"的自相矛盾行。判定改 || 。
    if (hasA || hasB) stitchRoundsWith++; else stitchRoundsWithout++;
    P('| ' + shortName(r.file, 30) + ' | ' + (rd.round ?? '—') +
      ' | ' + (rd.broken ?? '—') + ' | ' + (rd.fixed ?? '—') + ' | ' + (rd.dupSkipped ?? '—') +
      ' | ' + (hasA ? rd.skippedNoAnchor : '—') + ' | ' + (hasB ? rd.skippedTooFar : '—') +
      ' | ' + (hasA && hasB ? '有' : (hasA || hasB ? '半数' : '无')) + ' |');
  }
}
P('');
// 【B2】"进入过缝补"不能拿"有 stitchRound"当分母：绝大多数日志在 `stitchDone` 处就 break 了。
// 有 stitchDone 就说明进过这个阶段。三个数分开写，别互相冒充。
const stitchEntered = main.filter(r => r.hasStitchDone || (r.stitchRounds && r.stitchRounds.length)).length;
const stitchDoneClean = main.filter(r => r.hasStitchDone && r.doneRemaining === 0).length;
P('进入过 `stitchGaps` 的日志 **' + stitchEntered + '** 份；其中 `stitchDone` 那一刻已 0 断点 **' +
  stitchDoneClean + '** 份；真的进过循环体（有 `stitchRound`）**' + stitchLogs + '** 份。');
P('带计数器轮次 **' + stitchRoundsWith + '** / 无计数器轮次 **' + stitchRoundsWithout + '**。');
// 【B4】整列都是「—」极易被读成"确实一次都没跳过"。必须直说这是没有数据。
if (!stitchRoundsWith && stitchRoundsWithout) {
  P('⚠ 全部 ' + stitchRoundsWithout + ' 轮都跑在**没有这两个计数器**的旧构建上 ⇒ 本节**无法**归因任何"跳过原因"，' +
    '**不是 0 次跳过**。');
}
P('');

// ---------- 2c. 缝补补出来的铜在哪里 ----------
// 间距违规按**坐标**报，不按对象报（IPCB_ViolationBase.position 是点）。
// 所以"这条违规是不是缝补自己补出来的"永远无法靠对象 id 直接回答，
// 只能把 stitch 的 from/to 摊开，与终局违规的 at 人工比对。
// 旧表只统计 stitch 次数，这个比对从来没做过。
P('### 2c. stitch 补线坐标（可与终局违规的 at 对照）');
P('');
P('| 日志 | 网络 | 层 | gap | 孤岛数 | id | from | to |');
P('|---|---|---|---|---|---|---|---|');
let stitchEventTotal = 0, stitchWidest = { gap: -1 }, stitchIdN = 0;
for (const r of main) {
  if (!r.stitchEvents || !r.stitchEvents.length) continue;
  for (const ev of r.stitchEvents) {
    stitchEventTotal++;
    if (ev.id) stitchIdN++;
    if (typeof ev.gap === 'number' && ev.gap > stitchWidest.gap) stitchWidest = { gap: ev.gap, file: r.file, from: ev.from, to: ev.to };
    P('| ' + shortName(r.file, 30) + ' | ' + (ev.net ?? '—') + ' | ' + (ev.layer ?? '—') +
      ' | ' + (ev.gap ?? '—') + ' | ' + (ev.islands ?? '—') + ' | ' + (ev.id ? String(ev.id).slice(0, 16) : '—') +
      ' | ' + JSON.stringify(ev.from ?? null) + ' | ' + JSON.stringify(ev.to ?? null) + ' |');
  }
}
P('');
if (stitchEventTotal) {
  // 【B9】只有真拿到数字 gap 才能报"最大 gap"，否则会印出 -1 这个假数字。
  if (stitchWidest.gap >= 0) {
    P('缝补补线共 **' + stitchEventTotal + '** 条；最大 gap **' + stitchWidest.gap + '**' +
      (stitchWidest.file ? '（' + shortName(stitchWidest.file, 40) + '，' + JSON.stringify(stitchWidest.from) + '→' + JSON.stringify(stitchWidest.to) + '）' : '') + '。');
  } else {
    P('缝补补线共 **' + stitchEventTotal + '** 条；但**没有任何一条带数字 gap** ⇒ 最大 gap **没有数据**。');
  }
  // 【B3】整列 id 是「—」时必须解释，否则"没有 id"会被读成"补线没有 primitive id"。
  P('带 `id` 的 stitch 事件 **' + stitchIdN + ' / ' + stitchEventTotal + '**' +
    (stitchIdN === 0 ? ' ⇒ 这批日志产自**还没有 id 字段的旧构建**，属**没有数据**；' +
      '不能读成"补线没有 primitive id"，也不能据此做「补线 ↔ 违规」的逐步归因。' : '。'));
  // MAX_GAP 是源码常量，产出日志的构建可能与之不同 ⇒ 必须声明，否则改了上限报告就在撒谎。
  P('MAX_GAP = 150（`pipeline3.js` 源码常量；**产出本语料的构建可能与之不同**）：' +
    'gap 越接近它，"缝补把长距离铜硬接过去"的可能性越大。');
} else {
  P('没有任何 stitch 事件 —— 注意区分「缝补没跑到」与「跑了但一条都没补」，旧表里这两者长得一样。');
}
P('');

// ---------- 2d. 缝补时刻 vs 终局：断连是不是后来的阶段弄出来的 ----------
// 这是"后期阶段把铜弄坏"这个说法的**唯一可判据**：
//   `stitchDone{remaining:0}` = 缝补那一刻 DRC 一处 Connection Error 都没有；
//   `finalConn` = 最终 DRC 的 Connection Error 数。
// 二者同时可测且 0 → N，才证明"断连是缝补之后产生的"；否则断连是路由阶段就没修好。
// 不做这个交叉，两种完全不同的病因会被同一句"末轮仍断连"糊在一起。
P('### 2d. 缝补时刻 vs 终局连通性（判断"后期阶段弄坏铜"）');
P('');
const stClean = main.filter(r => (r.doneRemaining === 0));
// 【B5】原来 withBoth 只查 hasDrcDetails，而本语料所有 pipeline 日志都带该字段 ⇒ 放行 101/101，
// 闸门形同虚设；且空树的 finalConn 来自 `|| 0`，分不清"没有数据"与"真 0"。
// 要求：明细非空，或有叶子，或 drcPassed===true（此时空树才真是 0）。
const withBoth = stClean.filter(r =>
  r.hasDrcDetails && (((r.drcDetailsLen || 0) > 0) || ((r.leaves || []).length > 0) || r.drcPassed === true));
const brokeLater = withBoth.filter(r => (r.finalConn || 0) > 0);
P('| 项目 | 数量 |');
P('|---|---|');
P('| 有 `stitchDone` 记录（进过缝补判定） | ' + main.filter(r => r.hasStitchDone).length + ' |');
// 【B12】该版本的 `stitchDone` 只会写 `remaining:0`，所以这两行**结构上恒等**，
// 并列不注明会让人以为做了两次独立筛选。
P('| 其中 `remaining=0`（那一刻无断连）—— 与上一行**结构恒等**，不是独立证据 | ' + stClean.length + ' |');
P('| 上述且终局 `finalConn` 可判定（有明细/有叶子/或 `drcPassed`） | **' + withBoth.length + '** |');
P('| 其中终局仍有 Connection Error | **' + brokeLater.length + '** |');
P('');
if (withBoth.length) {
  P('可测样本里，缝补时干净而终局断连的占 **' + pct(brokeLater.length, withBoth.length) + '**。');
  P('判读：若这个比例很低，"后期阶段弄坏铜"就不是主要病因，主要问题在**路由/缝补没把断连修完**；');
  P('反之才需要逐阶段插探针（connBeforePour / connAfterClearance 已有）。');
  // 【必须按日期分层】这个缺陷（删掉 GND 过孔 → 整网断开）在 11-26 的版本里已修：
  // fixClearance 现在把"断路变多"当变差并整轮回滚，viaDeleted 会用同坐标 create 补回。
  // 不分层的话，11-25 的历史样本会把一个**已修**的 bug 一直报成"当前仍有 5%"。
  // 这正是"按构建版本分层再归因"的用处：不分层，修复永远显示不出来。
  const dayOf = (f) => { const m = /-(\d{8})-/.exec(f); return m ? m[1] : '未知'; };
  const byDay = new Map();
  for (const r of withBoth) {
    const d = dayOf(r.file);
    const o = byDay.get(d) || { n: 0, broke: 0 };
    o.n++; if ((r.finalConn || 0) > 0) o.broke++;
    byDay.set(d, o);
  }
  P('');
  P('| 日期（按日志名） | 可测样本 | 缝补后断连 | 占比 |');
  P('|---|---|---|---|');
  for (const [d, o] of [...byDay.entries()].sort()) {
    P('| ' + d + ' | ' + o.n + ' | ' + o.broke + ' | ' + pct(o.broke, o.n) + ' |');
  }
  P('');
  P('分层后才可归因：若断连样本全部落在旧日期，说明该缺陷已被后续版本修掉，');
  P('上表总计是**跨版本历史均值**，不能当"当前水平"读。');
  P('「未知」= 日志名里没有日期（手工复现 / 探针跑），不是某个批次，别把它当一天的数据。');
} else {
  P('⚠ 没有任何一份日志同时具备两者 ⇒ **这个问题目前无法判断**，不能写成"断连都是路由没修完"。');
}
P('');
if (brokeLater.length) {
  P('| 日志 | finalConn | 终局间距违规 | 是否通过 |');
  P('|---|---|---|---|');
  for (const r of brokeLater.sort((a, b) => (b.finalConn || 0) - (a.finalConn || 0)).slice(0, 15)) {
    P('| ' + shortName(r.file, 38) + ' | ' + r.finalConn + ' | ' + (r.finalClear || 0) + ' | ' + (r.pass ? '通过' : '失败') + ' |');
  }
  P('');
}

// ---------- 3. padKind ----------
P('### 3. trackRerouted 的 padKind 分布');
P('');
const pk = new Map();
let rerouteTotal = 0;
for (const r of main) {
  rerouteTotal += r.counts.trackRerouted || 0;
  for (const k of r.padKinds) pk.set(k, (pk.get(k) || 0) + 1);
}
const pkTotal = [...pk.values()].reduce((a, b) => a + b, 0);
P('| padKind | 次数 | 占「带该字段的绕行」比例 |');
P('|---|---|---|');
for (const [k, c] of [...pk.entries()].sort((a, b) => b[1] - a[1])) P('| ' + k + ' | ' + c + ' | ' + pct(c, pkTotal) + ' |');
P('| **合计** | **' + pkTotal + '** | 100% |');
P('');
P('口径：`trackRerouted` 事件共 **' + rerouteTotal + '** 次，其中 **' + pkTotal + '** 次带 `padKind` 字段（' +
  (rerouteTotal - pkTotal) + ' 次产自还没有该字段的代码版本 → **没有数据**，不是 0）。UNKNOWN 占比按带字段的样本算。');
P('');
P('样本极小的原因：绕行需要「缩窄到 6.5mil 仍违规」才触发，' + main.length + ' 个日志里只有 ' +
  main.filter(r => r.padKinds.length).length + ' 个走到这条路。**该比例证据不足**，只能定性说明回退包围盒在用。');
P('');

// ---------- 4. trackFixErr ----------
P('### 4. trackFixErr / 修复异常');
P('');
const em = new Map(); const emNets = new Map(); const emFiles = new Map();
for (const r of main) {
  for (const e of r.errTexts) {
    if (e.ev === 'trackFixErr') {
      em.set(e.m, (em.get(e.m) || 0) + 1);
      const net = r.idNet && e.id ? (r.idNet[String(e.id)] || '(未知)') : '(未知)';
      emNets.set(net, (emNets.get(net) || 0) + 1);
      emFiles.set(r.file, (emFiles.get(r.file) || 0) + 1);
    }
  }
}
P('| 错误文本 | 次数 |');
P('|---|---|');
for (const [k, c] of [...em.entries()].sort((a, b) => b[1] - a[1])) P('| `' + k + '` | ' + c + ' |');
P('| **合计** | **' + [...em.values()].reduce((a, b) => a + b, 0) + '** |');
P('');
P('出错 net 归属（按事件流里同 id 的 trackThinned/trackRerouted 反查）：' + ([...emNets.entries()].map(([k, c]) => '`' + k + '`×' + c).join('、') || '无数据'));
P('');
P('分布文件：' + ([...emFiles.entries()].map(([k, c]) => k.replace(/\.json$/, '') + '×' + c).join('、') || '无'));
P('');
const otherErr = new Map();
for (const r of main) for (const e of r.errTexts) if (e.ev !== 'trackFixErr') otherErr.set(e.ev, (otherErr.get(e.ev) || 0) + 1);
P('其它修复侧异常事件：' + ([...otherErr.entries()].map(([k, c]) => k + '=' + c).join('、') || '0 次'));
P('');

// ---------- 5. 阶段耗时 ----------
P('### 5. 阶段耗时（PHASE.ms 是距 T0 累计时间，按相邻差值还原单段耗时）');
P('');
const ph = new Map();
for (const r of main) for (const p of r.phases) {
  if (!ph.has(p.n)) ph.set(p.n, { sum: 0, n: 0, max: 0 });
  const o = ph.get(p.n); o.sum += p.d; o.n++; o.max = Math.max(o.max, p.d);
}
const phTotal = [...ph.values()].reduce((a, o) => a + o.sum, 0);
P('| 阶段 | 出现次数 | 合计耗时(s) | 占比 | 平均(s) | 最长(s) |');
P('|---|---|---|---|---|---|');
for (const [k, o] of [...ph.entries()].sort((a, b) => b[1].sum - a[1].sum)) {
  P('| ' + k + ' | ' + o.n + ' | ' + num(o.sum / 1000) + ' | ' + pct(o.sum, phTotal) + ' | ' + num(o.sum / o.n / 1000) + ' | ' + num(o.max / 1000) + ' |');
}
P('| **合计** | | **' + num(phTotal / 1000) + '** | 100% | | |');
P('');

// ---------- 6. 通过 vs 失败 ----------
P('### 6. 通过 vs 失败');
P('');
function agg(list, f) { const a = list.map(f).filter(x => typeof x === 'number' && !Number.isNaN(x)); if (!a.length) return null; return a.reduce((s, x) => s + x, 0) / a.length; }
const pass = main.filter(r => r.pass), fail = main.filter(r => !r.pass);
P('口径：**通过 = value.ok && value.drcPassed**（' + pass.length + ' / ' + main.length + '）；失败 = 其余（' + fail.length + '）。');
P('');
P('| 指标 | 通过组（均值） | 失败组（均值） | 通过组中位 | 失败组中位 |');
P('|---|---|---|---|---|');
function med(list, f) { const a = list.map(f).filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y); return a.length ? a[(a.length - 1) >> 1] : null; }
for (const [name, f, unit] of [['器件数', r => r.compN, ''], ['网络数', r => r.netN, ''], ['板框面积 (mil²)', r => r.area, ''], ['outlineFillRatio', r => r.fill, ''], ['总耗时 (s)', r => r.elapsedMs / 1000, ''], ['间距违规开局数', r => r.rounds.length ? r.rounds[0].violations : null, '']]) {
  P('| ' + name + ' | ' + num(agg(pass, f)) + ' | ' + num(agg(fail, f)) + ' | ' + num(med(pass, f)) + ' | ' + num(med(fail, f)) + ' |');
}
P('');
P('**失败组的失败原因构成**（终局 DRC 明细，' + fail.length + ' 个失败日志）：');
P('');
let onlyC = 0, onlyN = 0, bothC = 0, neither = 0;
for (const r of fail) {
  const c = r.finalClear > 0, n = r.finalConn > 0;
  if (c && n) bothC++; else if (c) onlyC++; else if (n) onlyN++; else neither++;
}
P('| 只有间距违规 | 只有连通性违规 | 两者都有 | 明细为空（ok=false 的早期失败） |');
P('|---|---|---|---|');
P('| ' + onlyC + ' | ' + onlyN + ' | ' + bothC + ' | ' + neither + ' |');
P('');
P('各阶段均耗时（通过 vs 失败，秒）：');
P('');
P('| 阶段 | 通过组 | 失败组 | 差值 |');
P('|---|---|---|---|');
const pnames = [...ph.keys()];
for (const pn of pnames) {
  const a = agg(pass, r => { const x = r.phases.find(p => p.n === pn); return x ? x.d / 1000 : null; });
  const b = agg(fail, r => { const x = r.phases.find(p => p.n === pn); return x ? x.d / 1000 : null; });
  if (a === null && b === null) continue;
  P('| ' + pn + ' | ' + num(a) + ' | ' + num(b) + ' | ' + num((a || 0) - (b || 0)) + ' |');
}
P('');

// ---------- 7. 板框放大 ----------
P('### 7. 板框尺寸对最终违规数的影响');
P('');
P('**(a) 同一设计名、不同板框的多次运行**（每个日志只保留最后一次尝试；跨文件比较，代码版本可能不同）');
P('');
const byDesign = new Map();
for (const r of main) { if (!byDesign.has(r.design)) byDesign.set(r.design, []); byDesign.get(r.design).push(r); }
P('| 设计 | 板框(面积 mil²) → 终局违规 [drcResult.n] 通过? | 说明 |');
P('|---|---|---|');
let pairs = 0;
for (const [d, arr] of byDesign) {
  const areas = new Set(arr.map(x => x.area));
  if (areas.size < 2) continue;
  pairs++;
  const cells = arr.slice().sort((a, b) => a.area - b.area).map(r => r.boardW + '×' + r.boardH + ' (' + r.area + ') → ' + r.finalClear + ' [' + r.drcResultN + '] ' + (r.pass ? '✅' : '❌') + ' @' + r.file.slice(-15, -5));
  P('| ' + d + ' | ' + cells.join('<br>') + ' | ' + areas.size + ' 种板框 / ' + arr.length + ' 次运行 |');
}
P('');
P('（' + pairs + ' 个设计出现过 ≥2 种板框）');
P('');
P('**最干净的一对：d11b 同一设计、同代码版本、只改板框**');
P('');
for (const r of main.filter(r => /^d11b-repro/.test(r.file))) {
  P('- `' + r.file + '`：板框 ' + r.boardW + '×' + r.boardH + '，间距违规 ' + (r.rounds.length ? r.rounds[0].violations : '—') + ' → ' + r.finalClear + '，drcResult.n=' + r.drcResultN + '，通过=' + r.pass);
}
P('');

// fail-*.txt 里的同一次运行的多次尝试
P('**(b) 同一次运行内的多次板框尝试**（logs/fail-*.txt，run-all.ps1 的 smart-fit → expand-1.25x）');
P('');
const txts = fs.readdirSync(LOGDIR).filter(f => f.startsWith('fail-') && f.endsWith('.txt'));
const attemptRows = [];
for (const f of txts) {
  const t = fs.readFileSync(path.join(LOGDIR, f), 'utf8');
  const trys = [...t.matchAll(/尝试 \[([^\]]+)\] 板框 (\d+)x(\d+) mil/g)].map(m => ({ tag: m[1], w: +m[2], h: +m[3] }));
  const fails = [...t.matchAll(/\[([^\]]+)\] (?:未通过|流水线未通过)[：:]\s*DRC 违规组 (\d+)/g)].map(m => ({ tag: m[1], groups: +m[2] }));
  if (trys.length < 2 || fails.length < 2) continue;
  const a = { tag: trys[0].tag, area: trys[0].w * trys[0].h, groups: (fails.find(x => x.tag === trys[0].tag) || {}).groups };
  const b = { tag: trys[1].tag, area: trys[1].w * trys[1].h, groups: (fails.find(x => x.tag === trys[1].tag) || {}).groups };
  if (a.groups === undefined || b.groups === undefined) continue;
  attemptRows.push({ f, a, b });
}
P('| 失败汇总 | 小框 违规组 | 大框 违规组 | 变化 |');
P('|---|---|---|---|');
let same = 0, better = 0, worse = 0;
for (const x of attemptRows) {
  const d = x.b.groups - x.a.groups;
  if (d === 0) same++; else if (d < 0) better++; else worse++;
  P('| ' + x.f.replace(/^fail-|-2026.*$|\.txt$/g, '') + ' | ' + x.a.groups + ' (' + x.a.area + ' mil²) | ' + x.b.groups + ' (' + x.b.area + ' mil²) | ' + (d > 0 ? '+' + d : d) + ' |');
}
P('');
P('小结：' + attemptRows.length + ' 组里「放大后更糟/不变/更好」= ' + worse + ' / ' + same + ' / ' + better + '。');
P('');
P('**(c) 按板框面积分档的通过率（全部 ' + main.length + ' 个日志）**');
P('');
const bands = [[0, 2e6, '< 2.0M mil²'], [2e6, 4e6, '2.0–4.0M'], [4e6, 6e6, '4.0–6.0M'], [6e6, 1e7, '6.0–10M'], [1e7, 1e18, '> 10M']];
P('| 面积档 | 运行数 | 通过 | 通过率 |');
P('|---|---|---|---|');
for (const [lo, hi, label] of bands) {
  const g = main.filter(r => r.area >= lo && r.area < hi);
  if (!g.length) continue;
  P('| ' + label + ' | ' + g.length + ' | ' + g.filter(r => r.pass).length + ' | ' + pct(g.filter(r => r.pass).length, g.length) + ' |');
}
P('');
P('**(d) 同设计 + 同板框面积、不同运行的结局是否一致**');
P('');
const key = new Map();
for (const r of main) { const k = r.design + '@' + r.area; if (!key.has(k)) key.set(k, []); key.get(k).push(r); }
const div = [...key.entries()].filter(([, arr]) => new Set(arr.map(x => x.finalClear + '|' + x.pass)).size > 1);
P('| 设计@面积 | 各次结局（终局间距违规 / 通过） |');
P('|---|---|');
for (const [k, arr] of div) {
  P('| ' + k + ' | ' + arr.map(x => x.finalClear + (x.pass ? '✅' : '❌') + ' @' + x.file.slice(-15, -5)).join('<br>') + ' |');
}
P('');
P('结论用：完全相同的板框也会出现「0 违规通过」与「16 违规失败」两种结局 —— 说明决定成败的不是板框面积。');
P('');
P('**(e) 混杂因素检查：板框面积 vs 设计复杂度**');
P('');
function pearson(xs, ys) {
  const n = xs.length; if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return (sxx && syy) ? sxy / Math.sqrt(sxx * syy) : null;
}
const vld = main.filter(r => r.compN && r.area);
P('- 板框面积 ↔ 器件数 相关系数 r = **' + num(pearson(vld.map(r => r.area), vld.map(r => r.compN)), 2) + '**（n=' + vld.length + '）');
P('- 板框面积 ↔ 网络数 相关系数 r = **' + num(pearson(vld.map(r => r.area), vld.map(r => r.netN)), 2) + '**');
P('');
P('| 器件数档 | 运行数 | 平均板框面积 | 通过率 |');
P('|---|---|---|---|');
for (const [lo, hi] of [[0, 6], [6, 10], [10, 13], [13, 99]]) {
  const g = main.filter(r => r.compN >= lo && r.compN < hi);
  if (!g.length) continue;
  P('| ' + lo + '–' + (hi === 99 ? '∞' : hi - 1) + ' | ' + g.length + ' | ' + num(agg(g, r => r.area) / 1e6, 2) + 'M | ' + pct(g.filter(r => r.pass).length, g.length) + ' |');
}
P('');
P('→ 板框与器件数强相关：大框样本本身就是复杂设计。因此「面积越大越难过」主要反映**设计复杂度**，不能当作放大板框有害的证据。');
P('');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ main: main.map(r => ({ file: r.file, design: r.design, pass: r.pass, bw: r.boardW, bh: r.boardH, fill: r.fill, compN: r.compN, netN: r.netN, finalClear: r.finalClear, drcResultN: r.drcResultN, rounds: r.rounds, counts: r.counts, phases: r.phases })) }, null, 1));
} else {
  console.log(md.join('\n'));
}
