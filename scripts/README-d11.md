# 换层布线的可行性与边界

**结论先说：换层方案未做真机验证（0 次执行）。** 18:24 接到「d11 已由 RECT 感知 `fixClearance` 平面重布解决、立即停止」的指令，此前只完成只读探针。d11 已不需要换层。下文只写真机实测或 `doc api` 实查的内容，推算处标「推算」。探针脚本：`scripts\d11b-01-probe.js`、`d11b-02-map.js`、`d11b-ana-geom.js`。

## 1 换层成没成

**没成 —— 没跑。** `check(true,false,false)` 对换层方案没有任何返回值可报。已验证到的只是前置事实：

- 干净板 1711×1437 上 XTAL_IN 的 `check(true,false,false) = true`（0 违规）。
- 引擎自己就在用换层：同一条 XTAL_IN 有 3 个通孔（d=19.6/hole=11.8）走 L2，说明「2 层板换层」在本套规则下**本就是合法通路**。

## 2 过孔参数（`doc api` 实查，非推测）

```js
// 真实签名：没有 layerFrom/layerTo！
eda.pcb_PrimitiveVia.create(net, x, y, holeDiameter, diameter,
    viaType?, designRuleBlindViaName?, solderMaskExpansion?, primitiveLock?)
```
- 顺序是 **hole 在前、diameter 在后**（与常见手册相反）。按 `create(net,x,y,6.5,19.7)` 传会 create 出 hole6.5/d19.7 的畸形孔（**不报错**）；协助顺序传则直接抛 `SYS_ApiError(INVALID_PARAM)`。
- `viaType`：`0=VIA 通孔`/`1=BLIND 盲埋孔`（必须同时给 `designRuleBlindViaName`，值须是规则配置里已有的盲埋孔项）/`2=SUTURE 缝合孔`。**2 层板没有层区间参数**——通孔即贯穿全部铜层，换层就是改走线 `layer=2`，不靠 via 传层。
- 推荐值（与板上现存 18 孔一致）：`holeDiameter=11.8`、`diameter=19.7`（0.3/0.5mm）。环宽**不是**风险点。
- **风险在 Clearance（推算）**：过孔禁入半径 = 9.85+4 = **13.85mil**，即直径 27.7mil 的净空。同一排 QFN 焊盘中心距仅 **15.7mil** → 排内打孔必违规；孔必须落在排末端外侧 ≥13.85mil 空白处，或压在**同网焊盘**上（同网重叠合法）。
- 孔到孔 / 孔到铜的最小间距（hole-to-hole）本会话未查，**未验证**。

## 3 覆铜重建与判定时序

**必须重建后再判，而且不能只信一次 `check`。** 同一工程 `40a38243` 实测：pipeline 收尾 `check(true,false,false)=false`，报 2 个 `RTC_XOUT` Connection Error（H1_6 + L2 走线 e303）；约 12 分钟后独立复核（`openProject`→`openDocument`→`waitForDocumentReady`→`rebuildAllCopperRegions`→2.5s）得 **`check=true`、0 叶子**。

- 结论：`rebuildAllCopperRegions()` + `sleep(2500)` 是硬要求，否则读数不可信。
- 未排除的干扰：两次复核之间同一 headless session 里另有一条 pipeline invoke 在跑。**假通过/假失败都可能来自同会话并发**，建议判定用独立会话。
- 「不重建直接 check 会不会假通过」**没有做对照实验**，不能下结论。

## 4 卡在哪

没卡在 API 上，卡在时间：接到停止指令时下一步正是「删冲突段 → 两端打 via → L2 直线 → rebuild → check」。已识别的两个必踩坑：① via 的 hole/diameter 顺序；② 15.7mil pitch 排内不能打孔，必须排外或压同网焊盘。

## 5 给更密板子（d12/d13）的最小验证（约 30s，1 次 invoke）

在任意 `passed=true` 的板上挑一段**已通过**的 XTAL_IN：删该段 → 两端打同参数 via → `pcb_PrimitiveLine.create(net, 2, x1,y1,x2,y2, w)` → `rebuildAllCopperRegions()` → `sleep(2500)` → `check(true,false,false)`。只回答三件事：① 布尔值；② via 是否引入新 Clearance/Annular Ring 违规；③ 不 rebuild 直接 check 的布尔值（对照假通过）。失败就把 DRC 叶子原样贴回。

**边界（推算）**：换层能救「两端外侧有 ≥27.7mil 见方空白」或「可直接在焊盘上打孔」的情况；救不了「两端被 15.7pitch 排 + 异网铜夹死」。且一个过孔占的净空比 6.5mil 走线（14.5mil 包络）宽近一倍 —— **板子越密，换层反而越可能被过孔自身卡死**。
