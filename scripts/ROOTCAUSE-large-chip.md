# 大芯片/复杂设计反复失败 · 根因

证据 `logs\<name>-20261125-*.json` 的 `.value.log`/`.value.drcDetails`；行号＝`scripts\pipeline3.js` 20:36 版（2103 行），均附 log key，漂移按 key 检索。

## 0 结论

4 个设计都死在最终 `drc`（`drcCheck{passed:false}`，4 次 attempt 全 false，导出照常成功），责任代码在**布线后的收尾兜底**：

- **A 连接残留**（d6、d10）：2 个 No Connection 叶子（SMD Pad+Track，同网 GND）→ `stitchGaps`(L1044-1206)+`patchDrc`(L1605-1805)。
- **B 自伤间距**（d12、d13，路由残差已 0）：7/18 个 Safe Spacing 叶子，12 个 `minDistance:0` → `fixClearance`(L1214-1592)。

变量是**违规基数**：基数越大越容易剩 1 个叶子，而收尾三段对"最后 1 个叶子"既收不干（A）又会改坏（B）。"大"不成立（d7 2400×1800 通过，§4）。

## 1 逐个设计

### d6 RP2040_Minimal（20 器件 / 2000×1500 / 409 s，预算剩 121 s）
- 失败点：`phase('drc')`。叶子 2：`SMD Pad D1_2`(err247) + `Track e446`(err248)，GND 同层，两个 `position` 相距 **0.53 mil** → 一块铜被判不连通。
- 证据：`routeIter 54>52>52>2`（压到 2 即收工）；`stitchAnchors{16/1585}` 只画 2 条线，`stitchRound 0:fixed2→1:fixed0,dupSkipped2` 后无 `stitchDone`；19:42 版画了 400 mil 直插 `[517,-73]→[517,-473]`，`patchVerify 2→21` 回滚（现版改为 `patchIslandPair` 跳过）。
- 裁决：**A 类**。非超时、非板框、非缺铺铜。

### d10 ESP32C3_Minimal（2000×1625 / 171 s）
- 失败点：`phase('drc')`。叶子 2：`SMD Pad U1_19`(err175) + `Track e213`(err176)，GND 同层，相距 **0.03 mil**。
- 证据：185851 版 `28>26>26>66`，183101 版 `28>26>26>78`（COMPLETION 把残差改大）；同设计 7 次通过且 `iter3=0`。`stillUnconnected` 非验收指标：d10 残差 66 只对应 2 个叶子，d12 残差 0 却有 7 个。
- 裁决：**A 类**，强抖动（同一份 design.json 的 iter3 在 0/2/66/78 间跳）。

### d12 USBC_Power_ESD（1875×1500 / 194 s）
- 失败点：`phase('drc')`，**路由已干净**（`28>28>28>0`、`stitchDone{round:0,remaining:0}`）。叶子 7 全 Safe Spacing：`Track-Track ×4`（`VBUS e378/e379` 对 `GND e231/e229`，`minDistance:0`）、`Track-SMD Pad ×2`(0 mil)、`Track-Slot Region ×1`。
- 证据：`clearanceRound 1>1>7`；2 次 `trackRerouted … "padKind":"UNKNOWN"`（`padBBox` 为合成盒 `[1559,-277,1571,-265]`）；`trackFixErr: …reading 'primitiveId'`。
- 裁决：**B 类**。7 个叶子里 ≥6 个是本阶段自己造的——首次进循环只有 1 个违规。

### d13 AI_传感器___充电___显示_19ptbuz（2250×1625 / 232 s）
- 失败点：`phase('drc')`，路由同样干净：`34>34>34>0`、`stitchDone{round:0}`。
- 叶子 18：`Track-Track ×6`、`Track-Slot ×4`、`Track-Via ×2`、`Track-Hole ×2`、`Via-Slot ×1`、`Hole-Slot ×1`、`VBAT NoConn ×2`；12 个 `minDistance:0`，**Slot 参与 6/18**。
- 证据：`clearanceRound 6>6>17`、`clearanceFixes 14`（含虚数）；9 条 `trackRerouted` 全 `padKind:"UNKNOWN"`；5 条 `trackFixErr`。
- 裁决：**B 类 + 槽孔几何不识别**：铺铜重算把"绕开槽"变成"贴住槽"，违规修完翻倍。

## 2 共性因子（与设计无关）

**F1｜A 类总因：`stitchGaps` 拿"距离聚类"当连通性。** `MERGE=2`(L1046)+`buildIslands`(L1091-1107) 用 `hypot<=2` 合并 pad/via 中心与线端点中点：线交叉与 T 接**不**合并，隔槽缝边却**误**合并——"孤岛"不等于铜的连通分量。再叠三点：`anchorsByNet` 循环内从不更新(L1111-1116 自述)；`drawn`(L1177-1178) 一次登记永久去重，`create` 返回 undefined(L1188) 也占位 → 每处缺口只有一次机会；`myD>12`(L1163)、`otherD>150`(L1174)、`pool.length<2`(L1151) 全静默 continue。d6 有 1585 锚点只留 2 条 stitch 记录。

**F2｜A 类总因：`patchDrc` 只在 DRC 同时给出 obj1/obj2 时可用，而连接叶子常只带 obj1。** L1703-1710：任一缺失即 `patchNoGeo` 放弃。实测 d6/d10 最终报告 2/2 叶子只有 `obj1/obj1Suffix`（如 `obj1Suffix:"(GND): D1_2"`），无 `obj2`；19:42 版凑出一对，两对象却相距 400 mil，直插后 2→21 回滚。**两种情形都无解：前者不敢修，后者修错。**

**F3｜B 类总因：`fixClearance` 的障碍物几何只认 Pad。** L1395-1402 用 `PrimitivePad.get(obstacleId)`，只解析 `POLYGON/RECT/OVAL/ROUND`(L1411-1439)。障碍是 **Track / Slot / Hole** 时（d12 有 5/7、d13 有 18/18 的违规根本没有 SMD Pad 侧）`pad=null`→`haveBox=false`→L1442-1448 用"违规点±max(净距/2,4)"合成 12 mil 假盒，`padKind='UNKNOWN'`；走廊(L1459-1479) 与 `NEED=10.25`(L1452) 全建在假几何上，实际压在真障碍旁；再按 L1549-1577 改 L 形 → `VBUS` 被搬上 `GND` 轨迹。指纹：`trackRerouted … padKind:"UNKNOWN"` 在 d12/d13 占 100%。

**F4｜放大器：终止判据只认"叶子数=0"，修复动作不以"叶子集合变小"为准入。** fixClearance 有 `clearanceReverted`(L1255-1274)、patchDrc 有 `patchVerify/Reverted`(L1789-1802)，但 `stitchGaps`(L1125-1204) 只数 `fixed` → "画 N 条线一个没连上"记成收益。回滚只是止损：d13 的 18 退回 6、d12 的 7 退回 1，**仍是失败**。

## 3 按收益排序的修复

**P0 救 d12+d13｜`fixClearance` 障碍物按类型取真几何**（L1395-1448）
- `Track`→`PrimitiveLine.get(obstacleId)` 取两端+线宽，线段±w/2 代替 bbox；`Via`→圆心±直径/2；`Slot/Hole`→取所属轮廓；取不到就放大到 ≥`needDist*10`、打 `conservative:true`，并**禁止** corridor（只缩窄）。验收：`padKind` 不再出现 `UNKNOWN`，d12/d13 首轮违规数单调递减。

**P1 救 d6+d10｜`stitchGaps` 连通性换代 + 静默丢弃日志化**（判据 L1091-1107；continue L1151/1163/1174；`drawn` L1177-1178；锚点 L1111-1116）
- ①并集条件由 `d<=MERGE` 改为"点到线段距离 ≤ 线宽/2"，T 接/交叉才合并；②每轮把新线段端点 push 回 `anchorsByNet`，清掉本轮 `stitchNoObj` 的 `drawn` 键；③三处 continue 改 `log('stitchSkip',{net,why})`；④`MAX_GAP` 与 `patchTooFar`(80) 对齐。

**P2 A 类正确兜底｜`patchDrc` 支持单对象叶子**（L1703-1710、L1721-1725）
- `obj2` 缺失也不放弃：取该 net 全部图元做连通分量，选"含 pad 最多"者为主网，从 `obj1` 分量连到主网（≤`MAX_GAP`）；`cp.d<=1.0` 同走"连主网"，别只记 `patchIslandPair`。**"如实记录"不算处置**（夜间无人读该日志）。

**P3 省机时｜`run-all.ps1` L369-379 删掉 `expand-1.25x`/`1.5x` 自愈**（注释已写"扩板零收益"；d6 976 s 大半耗在这 4 轮重跑）。

**P4 低｜`snapEnds` L1008-1010 命中 `seen` 就 `continue`**，那条线保持未吸附（d12 43 条、d13 60 条）；应删后画的那条，别留不吸附的。

**20:36 版已修、勿重复**：patchDrc 重新启用、`patchTooFar(>80)`、`patchIslandPair(<=1.0)`、`clearanceReverted`、`MAX_CLEAR_ROUNDS=8`、create 返回值校验、`drcTreeUsable`、`TestPoints.xlsx`、`connDiag`。均未在本文日志中生效，下次夜间跑后再评估 P0-P2。

## 4 已排除

- **超时/预算**：d6 409 s/530 s（`budgetEnd leftMs 121015`）、d10 171 s、d12 194 s、d13 232 s；`snapBudgetOut` 全 false。
- **板框/尺寸/引脚密度**：`outlineFit fits:true`、`fillRatio 0.32~0.49`；`run-all.ps1 L371-377` 记录 d6/d7/d11/d12 在 1.5x/2.0x 下失败方式相同；d6 叶子在 `D1_2`（二极管）、d10 在 `U1_19`（GND 焊盘），都不在 LQFN-56 本体上。
- **网表/封装/导入/铺铜**：`schDrc{errors:0}`、`netMismatches []`、`importChanges true`、`routeRulesProof{rulesApplied:true}`、`pourRebuilt true`。
- **缩过孔换净距**：`routeRulesProof.sizes` 仅 39×12/24 与 1×11.8/19.8，已在 JLC 下限，缩不动。
- **独立校验器/环境抖动**：18:55 轮 FAIL 全是自述失败（`校验FAIL=0`）；失败指纹稳定（d6/d10 恒同网 pad+track ≤0.53 mil，d12/d13 恒 fixClearance 后 `minDistance:0`）。
