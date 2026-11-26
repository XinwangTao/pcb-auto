# pipeline3.js 审查报告

基准：`pipeline3.js` @ sha256 `393F3FDB…`，1822 行，2026-11-25 19:51:37。该文件审查期间被并发编辑（1763→1822），行号对不上按片段检索；`prevFixed` 与 patch 复检回滚（1577-1609）是中途补上的，已核对正确。

## 1. 必须修

### 1.1 `create` 返回 undefined 被当成成功 → 制造断网 + 虚增 fixed［1428-1437, 1461-1470, 1111-1114, 1555-1576］
文档是 `Promise<IPCB_PrimitiveLine|undefined>`。`recNew(m1)` 与 `madeHere.push(...)` 都带 `?.`，返回 undefined 时既**不抛也不记**：m1 缺失 → 原线已截短到 `(sx+ox,sy+oy)`，m2 却从 `(ex+ox,ey+oy)` 起步，中间 100% 无铜；1447 照样 `fixed++`，1448 还打成功日志；整轮回滚时 m1/m2 不在 `roundCreated`，连悬空的 m2 也删不掉。这就是文件 1413-1418 记的 d13 事故，只是这次连异常都没有。L 形（1465/1468）、stitch（1111）、patch（1564-1576）同一模式。
```js
const m1 = await eda.pcb_PrimitiveLine.create(...);
const id1 = m1?.getState_PrimitiveId?.();
if (!id1) throw new Error('create(m1) returned undefined');  // 走 catch 回滚
madeHere.push(id1); recNew(m1);
```
c1/c2 同；stitch 改 `if (!ok) { log('stitchNoOp',…); break; }`，别 `stitchCount++`。

### 1.2 整轮回滚 ≠ 回到原状［1216, 1252, 1176-1194］
`roundMods` 只记 `pcb_PrimitiveLine`；via 缩孔（1216）与 GND via 删除（1252）**完全不进账**。1176 判定回滚后 track 恢复，via 仍是 19.7/11.8 或已不存在（删除不可逆），1194 又直接 `break` 不回跑 DRC —— `clearanceReverted` 声称"停在最好状态"，实际是没测量过、且与 `prevClearCount` 不一致的板子。局部 catch（1438-1445/1471-1480）删掉的 id 仍留在 `roundCreated`，下一轮会对同一 id 再 delete、同一 track 再 modify：不会删错（不存在 id 抛错被吞）、不会改错（回原值幂等），但 `rb.deleted/restored` 虚高。
```js
// 1216/1252 前各记一条；removed 标记该 via 是否已被删除
roundModVias.push({ id: viaObjId, net: netName, x: vv.getState_X(), y: vv.getState_Y(),
                    d: curD, h: curH, removed: false });
// 回滚分支补：
for (const s of roundModVias.reverse()) {
  if (s.removed) await eda.pcb_PrimitiveVia.create(s.net, s.x, s.y, s.h, s.d).catch(() => {});
  else await eda.pcb_PrimitiveVia.modify(s.id, { diameter: s.d, holeDiameter: s.h }).catch(() => {});
}
```
局部回滚已删的 id 还要从 `roundCreated` 摘掉，回滚后补跑一次 DRC 把真实条数写进日志。

### 1.3 预算闸门起点太晚［208-234, 512］
第一处 `left()` 闸在 780 行。此前有：建板 8 轮 × 两次 `waitForReady(…,60000)`（225/228，最坏 ≈976s）、布局 `waitJob(job.jobId,420000)`（512）、netlist/schDrc 各一次 `waitDoc(…,90000)`。任一慢下来就整段越过 530s（开头 19-24 行的死法：幽灵调用 → 下个设计 `SESSION_NOT_FOUND`）。
```js
if (i > 0 && left() < 420000) { log('budgetAbort', { at: 'boardWait', i, leftMs: left() }); break; }  // 208 首行
const r = await waitJob(job.jobId, Math.max(Math.min(420000, left() - 300000), 60000));               // 512
```

### 1.4 布线 TIMEOUT 不收尸，还会再起一个布线作业［796-801, 141］
`cap` 下限 60000 使 `left()` 在 240~420s 时只等 60~240s（文件自述 ULTRA_FAST 600s 够用），几乎必然 TIMEOUT；141 行只 `return {state:'TIMEOUT'}` 不取消作业，801 行只处理 `completed`，于是下一个变体再 `startAutoRouting` —— 同板两个布线器同时写，比预算超限更严重。
```js
if (r.state === 'TIMEOUT') {
  log('routeJobOrphan', { jobId: job.jobId, variant: v.name, leftMs: left() });
  routeState = 'TIMEOUT'; routeAborted = true;
  try { await eda.pcb_Document.cancelAutoRouting?.(job.jobId); } catch (e) { }  // 接口名按文档核对
  break;
}
if (routeAborted) break;   // 外层 iter 循环末尾
```

### 1.5 `valueMismatch` 整类静默漏报（node 实测同一表达式）［327-333］
| 声明 / 库内真值 | 告警 | 说明 |
|---|---|---|
| `4.7k` / `4.7kΩ` | 否 ✅ | 归一化正确 |
| `10uF` / `10F` | 是 ✅ | 这组没问题（`10UF` vs `10F`） |
| `10µF` / `1µF` | **否** ❌ | `toUpperCase()` 把 µ(U+00B5)→Μ(U+039C)，`NOM` 永不匹配 → 所有 µF 跳过 |
| `1k2`/`1.2k`、`4R7`/`4.7`、`2n2`/`2.2nF` | **否** ❌ | `NOM` 只认 12k/12.5k；`R\b` 在 `4R7` 里不成立（两侧皆 `\w`，无词边界） |
| `10mΩ` / `10MΩ` | **否** ❌ | `toUpperCase()` 把 milli 与 mega 合流 |

命中时也只 `log`、不进 `warns`（全文件仅 175 行 push 过），run-all 摘要看不到。"取库值、只告警"策略下这是唯一信号，现约等于关闭。
```js
const norm = (s) => String(s).replace(/[µμ]/g, 'u').replace(/\s+/g, '')   // µ→u 必须在 toUpperCase 前
  .replace(/ohms?/gi, '').replace(/Ω/g, '').toUpperCase().replace(/R$/, '');
const NOM = /^[\d.]+[KM]?(F|UF|NF|PF|H|MH|UH)?$/;
const a = norm(item.value), b = norm(real);
if (a !== b) {
  const tag = (NOM.test(a) && NOM.test(b)) ? 'valueMismatch' : 'valueUnparsed';  // 解析不出也留痕
  log(tag, { des: item.des, lcsc: item.lcsc, declared: String(item.value), actual: real });
  warns.push(`${tag} ${item.des}: declared=${item.value} actual=${real}`);
}
```
`m/M` 合流需数值解析根治；后三行至少会以 `valueUnparsed` 出现。

### 1.6 patchDrc 用 1/10 坐标找最近节点 → 在错误位置拉底层长铜［1552-1556］
同文件四处都把 `errData.position` ×10 后当 mil 用（1074、1311-1312、1679、1719），而 1552 取 `pos` 后，1556 直接与真实 mil 坐标的焊盘 `Math.hypot` —— 等于在 10 倍偏移后排序：`sorted[0]/[1]` 成了靠近画布原点的两个同网节点，补出的线与过孔落在与断点无关处，`fixed++` 照加，违规数不增就永久留板。
```js
const px = Number(pos?.x) * 10, py = Number(pos?.y) * 10;   // 与 1074/1311/1719 一致
… d: Math.hypot(n.x - px, n.y - py)
```

## 2. 建议修
- **1176 只比数量**：`1 Track-to-Track → 1 Hole-to-Slot-Region` 不回滚。改权重和：`clears.reduce((s,v)=>s+(Number(v.explanation?.errData?.clearance)||0),0)`。
- **1157 recMod 只留首个字段集**：今天不可达（1201 每轮新建 `seenVia`），但放开"先缩窄再绕行"后 `{lineWidth}` 会挡掉后来的 `{endX/endY}`，回滚只恢复一半。改 `Object.assign(m, orig)` 即免疫。
- **1442/1477 的恢复 modify 失败被 `catch(e6/e3){}` 吞掉**：真断网时日志只剩 `trackRerouteRolledBack made:1`。补 `log('trackRestoreFail',{line:trackId,m:String(e3&&e3.message)})`。
- **1600 patch 按总违规数回滚**：会删掉"断连 -1、间距 +1"的净改善轮，按 errorType 分开比。

## 3. 确认没问题
- **`cap` 不超剩余预算**：`max(left()-180000,60000)`，780 闸保证进入时 `left()≥240000` → cap=60000 ≪ 剩余，且恒有 cap<left()；你举的 `left()=100000` 到不了这里。真 bug 是 §1.4。
- **`4.7k`/`4.7kΩ`、`100nF`、`100R`/`220` 归一化正确**（node 实测）。
- **dogleg/L 只改终点不动起点**，`modify(endX,endY)` 能完整恢复原线段；重复回滚幂等，不会删错/改错铜。
- **同一轮同一条线不会被改两次**：1201 `seenVia` 每轮新建，1206/1265 拦住重复。
- **`clearanceFixes` 已不虚高**：`prevFixed`（1152/1178/1190）已退掉回滚轮 fixed。
- **`anchorsByNet` 旧 bug 已修**：1048 `drawn` + 1108 判重，不会每轮重画同一条。
- **失败不会误报 `ok`**：1801 复合条件含 `drcPassed/routeState/exports/artifacts`，§1.1/1.4 的损坏会以最终 DRC 失败暴露。

STATUS={"status":"ok","changed":["scripts/PIPELINE-REVIEW.md"],"verify":{"cmd":"read scripts/PIPELINE-REVIEW.md","exit":0},"reason":"found 6 must-fix issues (create-undefined breaks nets, incomplete rollback, late budget gate, orphan routing job, valueMismatch silent misses, patch coordinate scale)"}
