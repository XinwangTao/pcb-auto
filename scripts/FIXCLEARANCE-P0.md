# fixClearance P0 — 障碍物按真实类型取几何

`pipeline3.js` 2106→2374 行（111277→126124 B）。仅 P0，P1-P4 未动。

## 改动点（行号为改后）

- 1242-1500 几何工具 + id→图元类索引 + 按类解析器；日志 `geoIndexErr` `geoGetErr` `geoUnparsedSrc`。
- 1267-1337 距离工具：点到线段 / 线段相交 / 线段↔多边形 / 线段↔形状 / bbox。
- 1347 `geoPolyFromSource`：只认已取证的 `['R',x,y,w,h,…]`，其它 null。
- 1360-1379 `ensureGeoIdx`：每轮惰性建 pad/line/via/region/polyline/fill 的 id 集合。
- 1529 每轮清空 `geoIdx`（上一轮已改过铜）。
- 1631-1651 障碍物选择：**Track-Track 用 id 区分**违规线与障碍线（旧实现此处置 null → 假盒）。
- 1662-1683 取不到几何 → 记 `clearanceSkipNoGeo` 并 `continue`（**不改道**）。
- 1692 `NEED = clearance×10 + 3.25 + 1`：不写死 6（Slot Region 实测 11.81mil）。
- 1718-1725 走廊候选必须过真实距离判据（中段到障碍物 ≥ NEED）。
- 1744-1761 dogleg 平移量由几何搜索（6→40mil，步 2），找不到记 `clearanceSkipNoPush`。
- 1799 / 1841 `trackDogleg` / `trackRerouted` 增 `obstacleType` `objId` `geoKind` `need` `cur`；`padKind` 不再出现 `UNKNOWN`。
- 删除：pad-only 解析、`haveBox` 兜底的「违规点 ±4mil」合成盒、`padGetErr`。

## 各类型几何

- **Track**：`pcb_PrimitiveLine.get` → `getState_StartX/StartY/EndX/EndY/LineWidth`（回退 `Width`/6.5）；线段+线宽，判据扣 `w/2`（= 到线段距离 ≤ w/2+间距）。
- **Via**：`getState_X/Y/Diameter` → 圆，r=外径/2。
- **Hole**：logs 证实与 Via **同一 id** → r=孔径/2（`getState_HoleDiameter`）。
- **Slot Region**：20 位 hex、不属 pad；region→polyline→fill 依次试 `get`，几何取 `getState_Polygon().getSource()`。
- **Pad**：沿用原解析（POLYGON 顶点 bbox / RECT·OVAL·ROUND 旋转后 bbox），bbox 当轮廓（⊇真实铜，保守）。
- 归属不猜 id 长相：先建六类 id 集合，只对「确认包含该 id」的类调 `get`；集合建不出才按 DRC 类型挑读取器。

## 保守分支（三个出口都禁止 corridor/dogleg 改道）

1. `clearanceSkipNoGeo`：几何 null / bbox 为空；带 `obstacleType` `objId` `need` `cur` 与**放大**的 `safeBox`（半边长 ≥ max(need,10)=20mil 起，仅记录）。
2. `clearanceSkipNoPush`：6~40mil 内找不到使中段 ≥ NEED 的平移量。
3. `geoGetErr` / `geoUnparsedSrc`：`get` 抛 `primitiveId` 或 source 非 `'R'`。

缩窄（无损）在此前独立完成、仍计 fixed；取不到几何只损失「绕行」机会。

## 与上游结论的出入（必录）

上游称 `eda.pcb_PrimitiveLine.get(id)` 在当前离线版本不存在。本机证据相反：`api/methods.csv` 有 `"PCB_PrimitiveLine","get","beta"`；本文件 993/1607 行在用，日志 `trackThinned` 证明可读。它**会抛**的是过期 id：`Cannot read properties of undefined (reading 'primitiveId')`（日志 `trackFixErr` ×4）。故未走全局保守分支，改为逐次 try/catch。若换到真无此 API 的版本，索引与 `get` 全部落到 `geoGetErr` → `clearanceSkipNoGeo`，行为自动退化成保守分支。

## 只能真实运行确认的点

1. `Hole`/`Via` 同 id、`Slot Region` 属 region/polyline/fill 哪一类（看 `geoIndexErr`/`geoGetErr`/`geoUnparsedSrc`）。
2. 非 `'R'` 的多边形 source 形式仍未取证，命中即跳过。
3. Region 是否支持 `getState_Polygon`（Polyline/Fill 已由 `_bbox.js` 证实）。
4. L 形绕行的两段**短桩**未校验（只校验中段），仍可能贴着障碍物，只能靠 DRC 复检。
5. 8 轮是否真收敛：看 `clearanceRound` 序列是否单调、`clearanceFixes` 是否不再翻滚。
6. 每轮 6 次 `getAllPrimitiveId` 耗时未实测。

## 闸门

`node scripts/staticcheck.js scripts/pipeline3.js` → `{"ok":true}` exit 0；`new vm.Script('(async function(){…})')` → exit 0。每次编辑后立即复跑，共 9 次全部通过。未运行 `run-all.ps1` / EDA。
