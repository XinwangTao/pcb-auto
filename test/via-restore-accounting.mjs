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

// ────────────────────────────────────────────────────────────────────────────
// 10. 真实失败形态：create 的第 6 个参数（viaType）必须是**数字**枚举。
//
// 桩照抄的不是猜的形状，是 out/ESP32S3_Wireless_Mic_V5-20261126-195631 的真实报错：
//   viaRestoreDiag {"net":"GND","threw":"Cannot read properties of undefined
//                    (reading 'primitiveId')","why":"create 抛异常：确实没补回来"}
// 四个 GND 缝合孔全部落进这个 catch，同期 GND Connection Error 从 4 涨到 8。
//
// 根因（README-d11.md §2 的 doc api 实查签名）：
//   create(net, x, y, holeDiameter, diameter, viaType?, …)
//   viaType：0=VIA 通孔 / 1=BLIND / 2=SUTURE —— 数字。
// 而记录侧用 String(getState_ViaType() ?? '') 存成字符串，回滚时原样传回 ⇒
// EDA 侧枚举查表得 undefined ⇒ 读 .primitiveId ⇒ 抛。
// 旧代码还有第二处：`m.viaType || undefined` 会把**合法值 0** 变成 undefined。
//
// 这一组在旧代码上必须全红、在新代码上必须全绿（已双向实测，见 out/_probe/）。
function driveStrict(mods) {
  const calls = [];
  const eda = {
    pcb_PrimitiveLine: { delete: async () => true, modify: async () => ({ ok: 1 }) },
    pcb_PrimitiveVia: {
      modify: async () => ({ ok: 1 }),
      create: async (...args) => {
        calls.push(args);
        if (args.length > 5) {
          const vt = args[5];
          if (typeof vt !== 'number' || !Number.isInteger(vt) || vt < 0 || vt > 2) {
            // 与真实 EDA 抛出的原文一致
            throw new Error("Cannot read properties of undefined (reading 'primitiveId')");
          }
        }
        return { getState_PrimitiveId: () => 'nid' + calls.length };
      },
    },
    pcb_PrimitivePour: { rebuildAllCopperRegions: async () => true },
  };
  return run(eda, [], mods.map(m => ({ ...m })), new Set(), 23, 4, { length: 12 }, 1, 9, 0,
    async () => {}, 9).then(r => ({ ...r, calls }));
}

// 10a 记录侧真实形状：String(getState_ViaType()) ⇒ '2'
{
  const r = await driveStrict([via('t1', { viaType: '2' }), via('t2', { viaType: '2' })]);
  chk(r.clearanceRevertOk === true, "viaType 记成字符串 '2' 时必须能补回来（旧代码在这里抛异常）");
  chk(r.rb.viaRestored === 2, "字符串 '2' 的 2 个孔都要真的补回来");
  chk(r.calls.every(c => c.length === 6 && c[5] === 2),
    "必须把 viaType 以**数字** 2 传给 create，不是字符串 '2'");
  chk(!r.logLines.some(l => l.s === 'viaRestoreDiag'), '修好之后不该再出现 viaRestoreDiag');
}

// 10b 合法值 0 被 `||` 吃掉（旧写法 `m.viaType || undefined`）—— 0 是合法枚举
{
  const r = await driveStrict([via('z1', { viaType: 0 })]);
  chk(r.clearanceRevertOk === true, 'viaType=0 是合法枚举，不得被 `||` 变成 undefined 后抛异常');
  chk(r.calls[0] && r.calls[0][5] === 0, 'viaType=0 必须原样传 0，不能丢');
  chk(r.rb.viaRestored === 1, 'viaType=0 的孔必须真的补回来');
}

// 10c 缺失/空串：只传 5 个参数，不要拿 undefined 占位（参数个数本身可能改变桥的行为）
{
  const r = await driveStrict([via('e1', { viaType: '' }), via('e2', { viaType: undefined })]);
  chk(r.clearanceRevertOk === true, 'viaType 缺失/空串时必须退回 5 参数并成功');
  chk(r.calls.every(c => c.length === 5), 'viaType 缺失时不得传第 6 个参数（哪怕值是 undefined）');
  chk(r.rb.viaRestored === 2, '两个孔都要补回来');
}

// 10d 越界值不得被编造：'9' 不是合法枚举 ⇒ 退回 5 参数，而不是猜成 0/1/2
{
  const r = await driveStrict([via('o1', { viaType: '9' })]);
  chk(r.rb.viaRestored === 1, "越界 viaType '9' 必须仍然能把孔补回来（不编造枚举值）");
  chk(r.calls[0] && r.calls[0].length === 5, "越界 viaType '9' 不得传给 create");
}

// 10e 阴性对照：本闸门 via() 的默认值 'Through' 是不可解析字符串，也必须不炸
{
  const r = await driveStrict([via('d1')]);
  chk(r.rb.viaRestored === 1, "viaType='Through' 这类不可解析字符串必须退回 5 参数并成功");
  chk(r.clearanceRevertOk === true, "不可解析 viaType 不得导致撤回被判失败");
}

if (fails.length) {
  console.log(`  VIA-RESTORE=FAIL  ${fails.length} 条断言失败（共 ${pass + fails.length}）`);
  for (const f of fails) console.log('    ✗ ' + f);
  process.exit(1);
}
console.log(`  VIA-RESTORE=PASS  ${pass} 条断言全过（14 个场景：5 类失败 + 9 类阴性/回归对照）`);
