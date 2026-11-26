#!/usr/bin/env node
// 闸门：clearance 整轮回滚的账目必须分得清「试过但失败」「对象回来了但读不出」「根本没试」。
//
// 为什么要有这道闸门：
//   `clearanceRevertOk` 曾经只数 restoreFail / delFail 两个桶，把 viaRestoreFail 和
//   viaUnrestorable 整个漏掉。于是「四个 GND 缝合孔一个都没补回来」会被报成
//   clearanceRevertOk=true —— 板子上有 4 个孤岛，账上写着「撤回成功」。
//   实测出处：out/ESP32S3_Wireless_Mic_V5-20261126-193938 第 1 轮，
//   clearanceRevertViaRestoreFail{n:4} 而 GND Connection Error 4→8。
//
// 退出码契约：0 通过 / 1 发现失败 / 2 环境问题（读不到源文件、抽取锚点变了）。
//
// 设计要点：这道闸门**不**依赖 git 历史里的旧版本 —— 它只钉住「现在的行为是否正确」。
// 把旧版本留在测试里有两个害处：提交之后 `git show HEAD:` 拿到的就是新版，闸门自己会腐；
// 而双版本对比的价值在**改代码的那一次**已经用过了（证据见 out/_probe/）。
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'scripts', 'pipeline3.js');

const START = 'const delFail = [], restoreFail = [], viaRestoreFail = [], viaUnrestorable = [];';
const ENDMARK = 'prevFixed = 0;';

function bail(msg) { console.log('  VIA-RESTORE=ENVSKIP  ' + msg); process.exit(2); }

let src;
try { src = fs.readFileSync(SRC, 'utf8'); }
catch (e) { bail(`读不到 ${path.relative(ROOT, SRC)}：${e.message}`); }

const a = src.indexOf(START);
if (a < 0) bail(`找不到起锚点（源码改了？）：${START.slice(0, 60)}…`);
if (src.indexOf(START, a + 1) >= 0) bail('起锚点出现多次，无法确定抽哪一段');
const b = src.indexOf(ENDMARK, a);
if (b < 0) bail(`找不到止锚点：${ENDMARK}`);
if (b <= a) bail('抽取区间为空');
const block = src.slice(a, b);

// 这段必须真的包含我们关心的三条路径，否则抽到的不是回滚段
for (const needle of ["kind === 'viaDeleted'"]) {
  if (!block.includes(needle)) bail(`抽取到的区块里没有 ${needle} —— 锚点对不上，闸门不成立`);
}

const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;

function makeRunner() {
  const body = `
    const logLines = [];
    const log = (s, v) => logLines.push({ s, v });
    let clearanceRevertOk = null;
    let rb = { deleted: 0, restored: 0, viaRestored: 0, from: prevClearCount, to: clears.length,
      connFrom: 0, connTo: 0, why: 'gate', fixedRequested: 0, fixedGivenBack: 0 };
${block}
    return { logLines, rb, clearanceRevertOk, dangling: [...danglingLines],
             viaRestoreFail, viaUnrestorable, restoreFail, delFail,
             viaRestoreUnverified: (typeof viaRestoreUnverified !== 'undefined') ? viaRestoreUnverified : null };
  `;
  return new AsyncFn('eda', 'roundCreated', 'roundMods', 'danglingLines',
    'prevClearCount', 'prevConnCount', 'clears', 'round', 'clearanceFixes',
    'pourCount', 'sleep', 'prevFixed', body);
}

const run = makeRunner();

const via = (id, extra = {}) => ({ kind: 'viaDeleted', id, net: 'GND', x: 700, y: -1700,
  viaType: 'Through', before: { holeDiameter: 11.8, diameter: 19.8 }, ...extra });

function drive(mods, mode, lineDelete = true, lineModifyMode = 'ok') {
  let n = 0;
  const eda = {
    pcb_PrimitiveLine: {
      delete: async () => lineDelete,
      // modify 失败在本版本是 resolve(undefined) 而不抛 —— 必须能构造出这个形状，
      // 否则「截短线恢复失败」这条断言恒真（不会失败的测试不是测试）。
      modify: async () => (lineModifyMode === 'undef' ? undefined : { ok: 1 }),
    },
    pcb_PrimitiveVia: {
      modify: async () => ({ ok: 1 }),
      create: async () => {
        n++;
        if (mode === 'throw') throw new Error('create failed');
        if (mode === 'null') return null;
        if (mode === 'ok') return { getState_PrimitiveId: () => 'nid' + n };
        return { getState_PrimitiveId: () => null };
      },
    },
    pcb_PrimitivePour: { rebuildAllCopperRegions: async () => true },
  };
  return run(eda, [], mods.map(m => ({ ...m })), new Set(), 23, 4, { length: 12 }, 1, 9, 0,
    async () => {}, 9);
}

let pass = 0;
const fails = [];
const chk = (cond, label) => { if (cond) pass++; else fails.push(label); };

// 1. 四个孔全都补不回来、而线一条都没失败 —— 靶心
{
  const r = await drive([via('v1'), via('v2'), via('v3'), via('v4')], 'null');
  chk(r.clearanceRevertOk === false, '4 个孔全部 create 失败时，clearanceRevertOk 必须为 false');
  chk(r.viaRestoreFail.length === 4, 'viaRestoreFail 必须是 4');
  chk(r.logLines.some(l => l.s === 'clearanceRevertViaRestoreFail' && l.v.n === 4),
    '必须落 clearanceRevertViaRestoreFail{ n:4 }');
  chk(r.logLines.filter(l => l.s === 'viaRestoreDiag').length === 4,
    '每个失败孔都要有一条 viaRestoreDiag（否则读不出失败原因）');
  chk(r.rb.viaRestored === 0, 'viaRestored 必须为 0（不能虚报）');
}

// 2. create 回了对象但读不到 id：没证实 ≠ 成功，也 ≠ 失败，必须单列
{
  const r = await drive([via('u1'), via('u2')], 'noid');
  chk(r.clearanceRevertOk === false, '孔是否落板未证实时，不得声明撤回成功');
  chk(r.viaRestoreUnverified && r.viaRestoreUnverified.length === 2,
    '读不到 id 必须进 viaRestoreUnverified（2 条），不能混进 viaRestoreFail');
  chk(r.viaRestoreFail.length === 0,
    '「对象回来了但读不出 id」不得记成「create 失败」—— 两者处置完全不同');
  chk(r.logLines.some(l => l.s === 'clearanceRevertViaUnverified' && l.v.n === 2),
    '必须落 clearanceRevertViaUnverified{ n:2 }');
  const d = r.logLines.find(l => l.s === 'viaRestoreDiag');
  chk(d && d.v.hasGetId === 'function', 'viaRestoreDiag 必须记下 create 返回形状（hasGetId）');
  chk(d && !!d.v.why, 'viaRestoreDiag 必须带 why，不能只有 id');
}

// 3. 坐标缺失：连补都补不了
{
  const r = await drive([via('w1', { x: NaN, y: NaN })], 'ok');
  chk(r.clearanceRevertOk === false, '坐标缺失导致不可恢复时，不得声明撤回成功');
  chk(r.viaUnrestorable.length === 1, '坐标缺失必须进 viaUnrestorable');
}

// 4. create 抛异常：异常消息必须落进日志（以前被 catch 吞掉）
{
  const r = await drive([via('x1')], 'throw');
  chk(r.clearanceRevertOk === false, 'create 抛异常时不得声明撤回成功');
  const d = r.logLines.find(l => l.s === 'viaRestoreDiag');
  chk(d && /create failed/.test(String(d.v.threw || '')), '异常消息必须落进 viaRestoreDiag.threw');
}

// 5-7. 阴性对照：成功路径必须仍然是 true，否则这个字段就是恒假的
{
  const r = await drive([via('s1'), via('s2')], 'ok');
  chk(r.clearanceRevertOk === true, '孔全部补回来时 clearanceRevertOk 必须是 true（防恒假）');
  chk(r.rb.viaRestored === 2, 'viaRestored 必须是 2');
  chk(!r.logLines.some(l => l.s === 'viaRestoreDiag'), '成功路径不得产生 viaRestoreDiag 噪声');
}
{
  const r = await drive([], 'ok');
  chk(r.clearanceRevertOk === true, '空 roundMods 必须是 true');
}
{
  const r = await drive([{ kind: 'via', id: 'p1', before: { holeDiameter: 11.8, diameter: 19.8 } }], 'ok');
  chk(r.clearanceRevertOk === true, '只缩孔并改回去必须是 true');
  chk(r.rb.viaRestored === 1, '缩孔恢复的 viaRestored 必须是 1');
}
// 8. 线侧失败仍然要被看见（回归：不许因为改了 via 分支而漏掉 restoreFail）
{
  const r = await drive(
    [{ kind: 'line', id: 'L1', endX: 1, endY: 2 }], 'ok', true, 'undef');
  chk(r.clearanceRevertOk === false, '截短线恢复失败时 clearanceRevertOk 必须是 false');
  chk(r.restoreFail.length === 1, 'restoreFail 必须是 1');
}
// 9. 反面对照：截短线恢复成功 ⇒ true（防止上面那条靠「modify 恒失败」蒙对）
{
  const r = await drive(
    [{ kind: 'line', id: 'L2', endX: 1, endY: 2 }], 'ok', true, 'ok');
  chk(r.clearanceRevertOk === true, '截短线恢复成功时 clearanceRevertOk 必须是 true');
  chk(r.rb.restored === 1, '恢复成功的 restored 必须是 1');
}

if (fails.length) {
  console.log(`  VIA-RESTORE=FAIL  ${fails.length} 条断言失败（共 ${pass + fails.length}）`);
  for (const f of fails) console.log('    ✗ ' + f);
  process.exit(1);
}
console.log(`  VIA-RESTORE=PASS  ${pass} 条断言全过（8 个场景：4 类失败 + 4 类阴性对照）`);
