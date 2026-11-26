# LCEDA 自动布线 DRC 失败诊断（详细版）

配套笔记：Obsidian `inbox/2026-11-25-LCEDA布线DRC两类根因.md`

## 一、误判：流水线自报 FAIL，实际通过

2026-11-25 第 1 轮批量，13 个设计 4 个报 `PCB DRC 通过: False`。逐个用 `工程 UUID` 在流水线外复核：

| 设计 | 流水线 | 独立复核 | 真实违规 |
|---|---|---|---|
| RP2040_Minimal | FAIL | **passed=true** | 0 |
| RP2040_flash | FAIL | **passed=true** | 0 |
| Crystal_RTC | FAIL | false | 2 断点 |
| USBC_Power_ESD | FAIL | false | 2 间距 |

误判根因：`pcb_PrimitivePour.rebuildAllCopperRegions()` 是异步的。流水线
在 trace 结束、覆铜尚未重建完成的窗口里调 `pcb_Drc.check`，读到的是中间态。

代价：误判触发「放大板框重试」，RP2040_Minimal 被从 1600×1200 撑到
2069×1738 → 3103×2607 → 4138×3476，最终仍是同样的结果。**纯浪费**。

### 修法

```js
// pipeline3.js phase('drc')
for (let attempt = 0; attempt < 4; attempt++) {
  try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) {}
  await sleep(attempt === 0 ? 2500 : 1500);
  drcPassed = await eda.pcb_Drc.check(true, false, false);
  if (drcPassed === true) break;
}
await eda.pcb_Document.save();
await sleep(1200);
if (await eda.pcb_Drc.check(true, false, false)) drcPassed = true;   // 存盘后确认
```

复核脚本：`scripts/reheal.js <projectUuid> [sessionId]`

## 二、断线缺口（Connection Error）

### 实例：Crystal_RTC / GND / U1_19

```
焊盘 U1_19 (2106.9,-624.7) layer1, GND
  → 走线 (2106.9,-624.7) → (2106.9,-625.7)     ← 仅 1 mil
  → 走线 (2130.5,-625.7) → (2136.4,-631.6)     ← 起点在 2130.5
                              ↑ 2106.9→2130.5 之间 23.6mil 完全空白
```

DRC 原始树（注意是分组树，不是扁平数组）：

```json
[{"name":"Connection Error","count":2,"list":[
  {"name":"GND","count":2,"title":"GND (2)","list":[
    {"errorType":"Connection Error","errorObjType":"Track","net":"GND",
     "obj1":{"suffix":"(GND): e288"},
     "explanation":{"errData":{"position":{"x":210.64361,"y":-61.72592},
                               "obj1":"cf703e087a3b676a","obj1Type":"Track"}}},
    {"errorType":"Connection Error","errorObjType":"SMD Pad","net":"GND",
     "obj1":{"suffix":"(GND): U1_19"},
     "explanation":{"errData":{"position":{"x":210.69008,"y":-62.46533},
                               "obj1":"d598d2d357415e65e184","obj1Type":"SMD Pad"}}}
  ]}]}]
```

### 坑：按 errorType 扫顶层会把 2 个断点算成 0

顶层节点只有 `name`/`count`/`list`，**没有 `errorType`**。原代码：

```js
if (n.errorType === 'Connection Error') flat.push(n);   // 顶层永远不匹配
stillUnconnected = flat.length;                          // → 恒为 0
if (stillUnconnected === 0) break;                       // → 误判已布通，提前退出
```

后果：布局阶段报「布线已清零断连」，收尾 DRC 才暴露，白烧一轮。

### 坑：DRC 坐标是真实坐标的 1/10

`position.x = 210.64361` 对应画布 `2105.9722`。按 210 附近搜 30mil 半径
什么图元都找不到（实测 `nearPadsVias: []`、`nearLines: []`），会误判成
「图元不存在」。必须先 `× 10`。

### 修法：孤岛跨越补铜

第一版按「离断点最近的锚点」补线，失败：

```
round 0: GND L2 (2107,-618)→(2106,-617) gap=1
round 0: GND L1 (2107,-625)→(2107,-626) gap=1
...共 12 条 gap=1 的废线，after 仍 false
```

原因：最近锚点是碎片线自己的另一端。真实缺口 23.6mil 并不是「最近」的点。

正确做法 —— 并查集聚孤岛，只跨不同孤岛：

```js
const MERGE = 2;      // 同层 ≤2mil 视为已连通
const MAX_GAP = 150;  // 跨岛补线上限

const buildIslands = (pool) => {
  const parent = pool.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (let i = 0; i < pool.length; i++)
    for (let j = i + 1; j < pool.length; j++)
      if (Math.hypot(pool[i].x - pool[j].x, pool[i].y - pool[j].y) <= MERGE) uni(i, j);
  const g = new Map();
  for (let i = 0; i < pool.length; i++) {
    const r = find(i); if (!g.has(r)) g.set(r, []); g.get(r).push(i);
  }
  return [...g.values()];
};
```

锚点必须包含**走线中点**：

```js
add(n, sx, sy, layer, id); add(n, ex, ey, layer, id);
add(n, (sx+ex)/2, (sy+ey)/2, layer, id);   // 少了这行，长线中段附近的断点找不到岛
```

过孔两层都要登记（贯穿 TOP/BOTTOM）。

## 三、铜压铜（Clearance Error，0mil）

### 实例：USBC_Power_ESD / VBUS vs USB-C 屏蔽壳 GND

```
违规 1: (VBUS) e144 ↔ (GND) e6e35, minDistance 0mil,  shouldBe >=6mil
违规 2: (VBUS) e146 ↔ (GND) e6e35, minDistance 4.6mil, shouldBe >=6mil
```

焊盘 `e6e35` 是多边形焊盘（USB-C 屏蔽壳，`A1B12`），
`getState_Pad()` = `["POLYGON",[325.9779,-296.2448,"L",337.7879,...]]`，
bbox `x[325.98,349.60] y[-347.43,-296.24]`。

实测距离（线段-多边形采样法）：

| 走线 | 中心线到焊盘边缘 | 边缘距（扣半宽 3.25）| DRC 报 |
|---|---|---|---|
| t144 | 0.07mil | **-3.18**（压上去了）| 0mil |
| t146 | 7.84mil | **4.59** | 4.6mil ✓ |

数值完全吻合，证明算法可信。

### 修法阶梯

**① 缩窄**（无损，铜还在，只是细）：

```js
const curW = Number(tl.getState_LineWidth?.() ?? 0);
if (curW > 6.5) await eda.pcb_PrimitiveLine.modify(id, { lineWidth: 6.5 });
```

**② 仍不够则绕行**（L 形走焊盘外侧）：

```js
const NEED = 6 + 3.25 + 1.0;           // 6mil 净距 + 半线宽 + 余量
const cx = bx0 - NEED;                 // 焊盘左侧安全走廊
await eda.pcb_PrimitiveLine.modify(trackId, { endX: cx, endY: sy });
await eda.pcb_PrimitiveLine.create(net, layer, cx, sy, cx, ey, 6.5);
await eda.pcb_PrimitiveLine.create(net, layer, cx, ey, ex, ey, 6.5);
```

实测：`before false (clearance 4)` → 手动 L 形成功后 `after true, remaining []`。

### 反例：绕不开时不要手工救

Crystal_RTC 的 XTAL_IN 有一条 `(1362.7,-201.4) → (1349.54,-62.43)` 的
139mil 斜线，直穿晶振 GND 焊盘 Y1_4（`RECT 55.1×47.2`，中心 1349.5,-129.4）。

手工改成「下方 → 左侧 x=1306 → 上行 → 焊盘」的 L 形路线后：
违规 **4 → 22 个**。原因：U1 那排焊盘间距仅 15.7mil，
容不下 6.5mil 线宽 + 4~6mil 间距的通道；左侧走廊撞上了 XTAL_OUT / 3V3 / 1V1 / GND 一堆走线。

**结论**：只有「焊盘外侧真有空地」时手工绕行才可行。密集引脚区必须交回布线引擎。

## 四、方向约束不严格

`engineConfig.layers` 已设 `[{id:1,dir:'V'},{id:2,dir:'H'}]`，
但极速引擎仍产出 139mil 的斜线（dx=-13.2, dy=+139）。方向约束是**倾向**不是硬约束。

## 五、接口速查

```js
// 开文档正确链（eda.pcb_Document.openDocument 不存在）
await eda.dmt_Project.openProject(projectUuid);
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);

// 走线创建：线宽在最后
await eda.pcb_PrimitiveLine.create(net, layer, startX, startY, endX, endY, lineWidth);

// 焊盘没有 getState_Width/Height，尺寸在 getState_Pad() 数组里
const raw = pad.getState_Pad();   // ['RECT',55.1,47.2,0] | ['POLYGON',[x,y,'L',...]]
const verts = [];
if (Array.isArray(raw) && Array.isArray(raw[1])) {
  const a = raw[1];
  for (let i = 0; i < a.length - 1; i++)
    if (typeof a[i] === 'number' && typeof a[i+1] === 'number') verts.push([a[i], a[i+1]]);
}
```

`pcb_Drc.check(true,false,true)` 返回分组树；`pcb_Drc.checkDetailed` 可直接拿展平明细。
