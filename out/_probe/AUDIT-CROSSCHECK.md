# AUDIT-CROSSCHECK · 独立重算 `scripts/audit-placement.mjs` 的 10 条摆放判据

测于 **2026-11-26T18:56:15+08:00**。被测对象：`audit-placement.mjs` sha256_12=`45C28ACC1982`。
输入：`designs/mic-esp32s3-v3.json` sha256_12=`DCBB54A80DF2`、`designs/mic-esp32s3-v4.json` sha256_12=`31E62744FBEA`。
重算器：`out/_probe/audit-crosscheck.py`（纯标准库）。**实现阶段只吃设计 JSON + 它自己的尺寸表，不 import / 不调用被测脚本；被测源码只在「比对差异、解释根因」阶段才读**（第 5、6 节里的行号与代码片段都是那一步的产物）。

## 0. 结论先放这里

| | 结论 |
|---|---|
| 10 条判据在 v4 上 | 两边 **10/10 一致**：全通过，exitCode=0 |
| 10 条判据在 v3 上 | 两边 **10/10 一致**：7 通过 / 3 不通过（`usb_at_end`、`imu_near_centerline`、`mic_speaker_apart`），exitCode=0（WARN） |
| 合计 | **20 个判据结论，20 一致，0 不一致** |
| 但判据**能不能失败** | 构造 9 个变异设计后出现 **10 处结论分歧**，涉及 **4 条判据**（`antenna_band_empty`、`band_covers_antenna`、`all_inside_board`、`antenna_overhang`）。8 处是「审计静默通过 / 我的实现不通过」，2 处（T6）是反向：审计把可算的天线悬出报成 unknown + bbox 越界 |
| 4 项重点 | ①`usb_at_end` 分母改对了，但它**不是**决定 v3/v4 结论的那一步；②`antenna_band_empty` 对**无面积带子**会静默通过（**已复现**）；③旋转矩形**没算错**；④`all_inside_board` 的天线豁免**确实会连带放过焊盘区越界**（**已复现**，174 mil） |

一句话：**算术没错，结论没错，但三条 PCB 判据在畸形输入下会把「没测量」报成「通过」。**

## 1. 我给自己定的 10 条判据语义（先写，后算）

在看被测源码之前定的。列成式子，方便逐条对账。

| id | 我的语义 | 我的阈值 |
|---|---|---|
| `antenna_band_empty` | `_antennaKeepout` 矩形内，除 `allowDesignators` 外任何器件包围盒不得相交。**带子必须是有面积的**（`x1>x0 && y1>y0`），否则判 fail | 重叠面积 > 0 |
| `antenna_overhang` | U1 天线段尖端越过板边多少。板边取标称 `-H`（天线朝 −Y 时）；越出量 = 板边 − 尖端 | > 0 即通过 |
| `band_covers_antenna` | 净空带必须罩住「板边 → U1 焊盘区外缘」这条缝，**且要罩住整条天线的宽度**（垂直方向）。缝跨度 = \|焊盘区底 − 板边\| | 覆盖 ≥ 跨度，两轴都要 |
| `all_inside_board` | 所有器件包围盒在 `x∈[0,W] y∈[-H,0]` 内。**U1 只豁免天线段**，焊盘区仍须在板内 | 相交判定容差：审计 ±0.5 mil，我 ±1e-9 |
| `no_bbox_overlap` | C(26,2)=325 对轴对齐包围盒两两不相交；`rot%180==90` 时宽高互换 | 重叠面积 > 0 |
| `connector_at_edge` | USB1 对口面到板边 ≤ 100 mil。我两种口径都算：包围盒到四边的最小距离 / 只用自然 ±Y 两面对口面 | 100 mil |
| `usb_at_end` | USB1 中心到**较近那一端**的距离 ÷ 可用跨度 ≤ 25%。可用跨度 = 板高 − 净空带厚度 | 25% |
| `imu_near_centerline` | 偏轴 = \|U5.x − W/2\| ≤ 10%·W | 130 mil |
| `mic_speaker_apart` | U4↔H1 中心距 ≥ 50 mm | 50 mm = 1969 mil |
| `buttons_centered` | SW1/SW2/SW3 的 x 均值 − W/2 的绝对值 ≤ 10%·W | 130 mil |

## 2. 基线（Node 实测，`--json`）

```
v4 → summary{total:10, pass:10, fail:0, failPcb:0, unknown:0, sizedComps:26, unsizedComps:0}
     exitCode=0  banner=PLACEMENT=PASS
v3 → summary{total:10, pass:7,  fail:3, failPcb:0, unknown:0, sizedComps:26, unsizedComps:0}
     exitCode=0  banner=PLACEMENT=WARN（3 条都是 [机构] 类）
```

注意：v3 有 3 条不通过、`exitCode` 仍然是 **0**。这是设计好的契约（只有 [PCB] 类不通过才给 1），不是 bug；但「`exitCode=0` ⇒ 全过」是错的读法。

## 3. 逐条对账表

| 判据 | 类 | v4 审计 | v4 我的 | 一致 | v3 审计 | v3 我的 | 一致 |
|---|---|---|---|---|---|---|---|
| antenna_band_empty | PCB | 通过 | 通过 | ✅ | 通过 | 通过 | ✅ |
| antenna_overhang | PCB | 通过 | 通过 | ✅ | 通过 | 通过 | ✅ |
| band_covers_antenna | PCB | 通过 | 通过 | ✅ | 通过 | 通过 | ✅ |
| all_inside_board | PCB | 通过 | 通过 | ✅ | 通过 | 通过 | ✅ |
| no_bbox_overlap | PCB | 通过 | 通过 | ✅ | 通过 | 通过 | ✅ |
| connector_at_edge | PCB | 通过 | 通过 | ✅ | 通过 | 通过 | ✅ |
| usb_at_end | 机构 | 通过 | 通过 | ✅ | **不通过** | **不通过** | ✅ |
| imu_near_centerline | 机构 | 通过 | 通过 | ✅ | **不通过** | **不通过** | ✅ |
| mic_speaker_apart | 机构 | 通过 | 通过 | ✅ | **不通过** | **不通过** | ✅ |
| buttons_centered | 机构 | 通过 | 通过 | ✅ | 通过 | 通过 | ✅ |

## 4. 关键数值对照（每个数都能复现）

单位 mil，除注明 mm。mm 换算 = mil × 0.0254（审计脚本用 mil / 39.3701，差 < 0.01%，不影响任何结论）。

| 判据 | 量 | v4 | v3 |
|---|---|---|---|
| antenna_band_empty | 带子 | x[276,1024] y[-3700,-3690] | x[0,1300] y[-3700,-3690] |
| | 带内除 U1 外器件数 | 0 | 0 |
| | 最近的非豁免器件 | U2 距带子 **776.0** | USB1 距带子 **936.0** |
| antenna_overhang | 天线尖端 | **-3972.0** | -3972.0 |
| | 板边 | -3700.0 | -3700.0 |
| | 悬出 | **272.0 mil = 6.91 mm** | 272.0 / 6.91 |
| band_covers_antenna | 缝跨度（板边→焊盘区底） | 10.0（-3700 → -3690） | 10.0 |
| | Y 向覆盖 | 10.0 / 10.0 | 10.0 / 10.0 |
| | X 向需覆盖 / 实覆盖 | 748.0 / 748.0 | 748.0 / 748.0 |
| all_inside_board | 参与器件 | 26 | 26 |
| | U1 焊盘区 | x[276,1024] y[-3690,-2942]，**在板内** | 同左 |
| | U1 整只（含天线） | y[-3972,-2942]，越出 **272** | 同左 |
| no_bbox_overlap | 对数 | **325** = 26×25/2 | 325 |
| | 相交对数 | 0 | 0 |
| | 最近一对 | C1↔C3 **20.0** | R2↔R3 **22.0** |
| connector_at_edge | USB1 到四边（左/右/上/下） | **35.5 / 935.5 / 26.0 / 3286.0** | **69.5 / 901.5 / 2366.0 / 946.0** |
| | 包围盒最小面 | 上 26.0 | 左 69.5 |
| | X 向「对口面」 | 左 35.5 | 左 69.5 |
| | H1 最近边 | 498（497.5） | 498（497.5） |
| usb_at_end | USB1 中心 y | **-220** | **-2560** |
| | 到上端 / 到带子上沿 / 到板底 | 220 / 220 / 3480 | 2560 / **1130** / 1140 |
| | ÷ 可用跨度 3690 | **5.96%** | **30.62%** |
| | ÷ 整板 3700 | 5.95% | 30.54% |
| | 到「整板下端」口径 ÷ 3700 | 5.95%（220/3700） | 30.81%（1140/3700） |
| imu_near_centerline | U5.x / 中线 / 偏轴 / 容差 | 650 / 650 / **0.0** / 130 | 325 / 650 / **325.0 = 8.26 mm** / 130 |
| mic_speaker_apart | U4↔H1 | (650,-180)↔(650,-2350) = **2150 = 54.6 mm** | (650,-180)↔(650,-1250) = **1070 = 27.2 mm** |
| buttons_centered | 三键 x | 299 / 650 / 1001，均值 **650**，跨距 **702** | 同左（同坐标） |

v4 与 v3 的 `buttons_centered`、`no_bbox_overlap`（对数）、`antenna_*` 数值相同，是因为这两个版本的按键带与天线方案**没改过**（v4 的 `_v4Reason` 自己写明「天线悬出方案是整块板的锚」）。

## 5. 不一致 / 缺陷分节

下面每一条都写了「谁错、错在哪、为什么」。**注意：这些都不是 v3/v4 上算错**，而是判据在畸形/边界输入下的行为。基线 20 个结论两边完全一致。

### 5.1 【严重·假通过】`antenna_band_empty` 对「无面积带子」静默通过

**实测**（变异设计 T1：把 `_antennaKeepout` 的 y 上下界互换，`y0=-3690, y1=-3700`）：

```
audit : antenna_band_empty  pass  带子 [-3690,-3700] 内只有 U1
python: antenna_band_empty  FAIL  净空盒倒置（[x1<=x0 或 y1<=y0]）：几何上不覆盖任何面积
```

**为什么**：`overlap(a,b,shrink)` 的实现是

```js
const x0 = Math.max(a.x0,b.x0) + shrink, x1 = Math.min(a.x1,b.x1) - shrink;   // a=器件, b=带子
return x1 > x0 && y1 > y0 ? (x1-x0)*(y1-y0) : 0;
```

带子倒置 ⇒ 对**任何**器件都恒有 `y1 <= y0` ⇒ 恒返回 0 ⇒ `hits=[]` ⇒ 打印「带内只有 U1」。**一个空集合被当成了「干净」。** 这正是仓库 `AGENTS.md` 点名的那类错（「别把『没检』写进『通过』的分母」/「`dirs: 0` 不是全部通过」）。

**v4 的实际值**：`x0=276, x1=1024, y0=-3700, y1=-3690` ⇒ `y0 < y1` 成立，**不是倒置的**。所以这条判据在 v4 上的通过是真的。你担心的假通过**在本设计上没有发生，但判据抓不到它**。

**补一个更狠的**（T1c：只把 x 倒置 `x0=1024, x1=276`，y 保持正常）：

```
audit : antenna_band_empty pass / band_covers_antenna pass / exitCode=0
python: antenna_band_empty FAIL / band_covers_antenna FAIL
```

x 倒置时两条判据**双绿、退出码 0**。原因：`antenna_band_empty` 因空集合恒通过；`band_covers_antenna` 只比较 `K.y0`/`K.y1` 两个数，**从不看 x**（见 5.2）。

### 5.2 【判据定义不完整】`band_covers_antenna` 只在 Y 轴量，X 方向完全没约束

实现只有两个比较：

```js
const inner = u1.padBottom;
const gap   = inner - K.y1;        // >0.5 判裸露缝
const cover = K.y0 - boardMinY;    // >0.5 判没到板边
```

**T1d**（带子 x 收到 `[0,100]`，只罩住 748 mil 宽天线里的 100 mil）：

```
audit : antenna_band_empty pass / band_covers_antenna pass / exitCode=0
python: band_covers_antenna FAIL（X 向需覆盖 748.0，实覆盖 100.0）
```

**T2**（U1 移到 x=100，焊盘区 x[-274,474]，左半截在板外）也出现同一分歧：审计 `band_covers_antenna` 通过；我的实现因为带子 x[276,1024] 只盖住焊盘 198/748 判 fail。T2 的**真实缺陷**两边都抓到了（`all_inside_board` 都 fail），所以这条分歧只是「谁先说」。

**谁错**：审计。判据名叫「带子覆盖天线」。天线是 748 mil 宽的矩形，还压在板上 10 mil 深的缝里。判据只验证了「缝深 10 mil」这一个维度，**缝宽 748 mil 完全没进判定**。

**v4 实际值**：带子 x[276,1024] 恰好**等于**焊盘区 x 范围 —— 这是写 `_antennaKeepout` 的人对，不是判据在检查。v3 的带子是 x[0,1300]，覆盖有余。

### 5.3 【严重·假通过 + 假不通过】`all_inside_board` 的天线豁免是「按坐标裁剪」，不是「按天线段豁免」

实现：

```js
const allowAnt = b.lcsc === 'C2913199';
const y0 = allowAnt ? Math.max(b.y0, -d.boardHeightMil) : b.y0;   // 把 U1 盒子的下界夹进板内
if (!inside({ ...b, y0 }, 0, -H, W, 0)) bad.push(...)
```

它做的是把 U1 **合并包围盒的下界**夹到板底，而不是单独排除天线段。

**T5**（U1 下移到 y=-3500，焊盘区底 = -3500-374 = **-3874**，即焊盘有 **174 mil** 挂在板外）：

```
audit : all_inside_board  pass  26 个器件全部在板内（U1 天线段按设计悬出，已排除）
        band_covers_antenna pass  带子 [-3700,-3690] 覆盖 板边 -3700 → 天线内缘 -3874（-174 mil）
python: all_inside_board  FAIL  U1(焊盘区) 越界
        band_covers_antenna FAIL  覆盖 -3700→-3874 这一缝中的 0.0/174.0
exitCode = 0
```

两点：

1. `Math.max(-3874, -3700) = -3700` ⇒ 174 mil 的焊盘越界被**抹平**。**你担心的「连焊盘区一起放过」是真的发生了。**
2. `band_covers_antenna` 打印出「覆盖 板边 -3700 → 天线内缘 **-3874**（**-174** mil）」—— 区间是**反的**，跨度是负的，而它判**通过**。因为 `gap = -3874 - (-3690) = -184`，`-184 > 0.5` 为假。判据没有「跨度必须为正」的守卫。

**反向误报**（T6：U1 `rot=90`，天线朝 −X 悬出，`x0=-6`，焊盘区 x[276,1024] y[-3690,-2942] 仍在板内）：

```
audit : antenna_overhang  unknown  找不到 U1 或天线朝向无法判定
        all_inside_board  fail     U1 bbox [-6,-3690,1024,-2942]
python: antenna_overhang  PASS     天线朝 X- 悬出 6.0 mil：尖端 -6.0，板边 0.0
        all_inside_board  PASS     U1 焊盘区 x[276,1024] 在板内（只排除天线段）
exitCode = 1（audit）
```

`ANT_ROT_DIR` 里明明有 `90:[-1,0]`，但 `geom()` 算 `antTip` 时只在 `d[1]!==0` 才给值：

```js
antTip: d[1] < 0 ? p.y - PAD_HALF - ANT_LEN
     : d[1] > 0 ? p.y + PAD_HALF + ANT_LEN
     : null,
```

x 方向的天线**没有 antTip** ⇒ `antenna_overhang` 判 unknown（而这 6 mil 是**可算的**）。同时 `all_inside_board` 的豁免恒夹 `y0`，对 −X 悬出毫无作用 ⇒ 把 6 mil 的天线悬出报成 bbox 越界。所以同一块板、同一个「天线悬出」方案，判据的反应取决于 U1 转到了哪个角度。**这一条我判审计错，但要知道它是保守方向的错（误报，不是假通过）。**

**v4/v3 实际值**：U1 `rot=180`，焊盘区 y[-3690,-2942]、x[276,1024]，**焊盘区确实在板内**（板 y∈[-3700,0] x∈[0,1300]），越界的只有天线 272 mil。所以本设计「通过」是对的；但**证明它对的检查不存在**——同样的两条判据在 T5 上就是绿的。

### 5.4 【标签错·结论对】`connector_at_edge` 把「包围盒最小面」叫成「对口面」

```
v4: USB1 对口面离上边 26 mil     ← 26 是 min(左35.5, 右935.5, 上26.0, 下3286.0) = 上
v3: USB1 对口面离左边 70 mil     ← 70 是 min(左69.5, 右901.5, 上2366.0, 下946.0) = 左
```

代码里确实取的是四边的 `Math.min`：

```js
const dists = { 左: b.x0, 右: W-b.x1, 下: b.y0-(-H), 上: 0-b.y1 };
const [side, dist] = Object.entries(dists).sort((a,b2)=>a[1]-b2[1])[0];
```

**同一个料号（C165948）、同一个 `rot=90`，在两块板上报告的「对口面」不一样（v4 是「上」，v3 是「左」）。** 一个随位置改变的面，不是面属性 —— 这是最直接的证据：代码没有推导对口方向，只是把「包围盒离哪个板边最近」贴上了「对口面」这个标签。

**口径差多少**：v4 的包围盒在 X 向是 329 mil、Y 向 388 mil（`rot=90` 把自然 388×329 换过来）。两个候选口径：

- 四边最小：**26.0**（面=上）
- 只取与本体进深方向垂直的两面对口面（自然 ±Y 经 rot 映射到 ±X）：**35.5**（面=左）

差 9.5 mil。选哪个取决于 `TYPE-C-31-M-12` 的口朝哪边，**这一点代码没建模，我也没有实物封装可查**。所以我的实现两个口径都算、都打印，判据用四边最小（与审计同口径）→ 结论一致。

**结论不受影响**：26.0 与 35.5 都 ≤ 100 阈值；v3 的两种口径都是 69.5。但**判据的稳健性依赖于「四个面里总有一个够近」**——只要板子窄到让 X 向对口面超过 100 mil、而侧面仍在 100 mil 内，它就会用一个与插拔无关的面判「贴边通过」。

### 5.5 `usb_at_end` 的分母：**改对了，但不是它决定结论**

**问题 1：分母改对了吗？** 改对了。板底那 10 mil 是净空带（`[-3700,-3690]`），器件本来就不许进去，它不是一个「离端部远」的中间段，而是**不存在的端部**。用 3690 比用 3700 在语义上更正确。

**问题 2：结论是不是由这个分母决定的？** **不是。可以证明。**

判据是 `dist/span ≤ 0.25`。`span` 取 3690 时阈值为 `0.25×3690 = 922.5 mil`；取 3700 时为 `0.25×3700 = 925 mil`。**只有 `dist ∈ (922.5, 925]` 的 2.5 mil 窗口里，换分母才会翻转结论。**

- v4：dist = 220 → 5.96% / 5.95%，两个分母都过，离窗口 700 mil 远。
- v3：dist = 1130 → 30.62% / 30.54%，两个分母都不过，离窗口 200 mil 远。

**所以「v4 过、v3 不过」跟分母无关。** 真正决定它的是另外两步：

1. **距离改为「到两端取 min」**（旧写法 `dist = |y-0|` 只量到上端）。v3 的 USB1 在 y=-2560：到上端 2560、到可用下端 1130 —— 取 min 之后才降到 1130。如果不取 min，v3 是 2560/3690 = 69.4%，结论同样是不过，但**数字会很吓人**。
2. **下端从 −3700 抬到 −3690**。只影响 10 mil。

**问题 3：改分母前结论不同的情形在哪？** 只有 `dist ∈ (922.5, 925]` 这 **2.5 mil** 窗口才有。对本板（天线朝 −Y、下端取 −3690）它是 USB1 中心 **y ≈ -3615 ~ -3612.5** 那一小段（`|y+3690| ∈ (922.5,925]`）—— 而那段**在净空带里面**，正常布局不会进去。所以分母这一改在本板上是**语义正确、结果中性**。

**残留缺陷**：分母只在 `Number.isFinite(k.y1) && k.y0 <= -H+1` 时替换。如果净空带不贴板底、或者被倒置（`y0=-3690 > -3699`），分母**静默退回整板 3700**，而那块区域依然不可用。这个 fallback 没有任何提示（T1 里就退回成了「整板 3700」）。我的实现里同样有这个缺陷，只是我会把四种分母/端点组合全打出来，让读者看见它是哪一格。

### 5.6 `antenna_overhang` 的 272 与 261.5（两个都成立，别混用）

- **272** = 标称板边 `-3700` − 天线尖端 `-3316-374-282 = -3972`。两边独立算出同一个数。
- **261.5** = 实测板框 `boardMinY = -3705`（`_antennaKeepout.why` 与 `_v3Reason` 都记了这个数）− 同一个尖端。

差 10.5 mil，是因为设计 JSON 只写 `boardHeightMil=3700`，而 EDA 里的板框 polyline 实测是 3705。审计脚本在 detail 里显式声明了用的是标称值，**这不算错**，但 272 这个数**不是实测悬出量**。我没跑 EDA，无法自己验 3705，所以这一条我**只复现了标称口径**。

### 5.7 我认为「判据定义本身」有问题的几条

| 判据 | 问题 | 我是否在基线里复现到它 |
|---|---|---|
| `antenna_band_empty` | **空集合 = 通过**。缺 `x1>x0 && y1>y0` 守卫（见 5.1） | 是（T1/T1b/T1c 复现） |
| `band_covers_antenna` | 只查 Y 不查 X；且没有「跨度必须为正」的守卫，能把 `-174 mil` 当覆盖（见 5.2/5.3） | 是（T1d/T2/T5） |
| `all_inside_board` | U1 豁免硬编码在 `-Y` 一根轴上，用 `Math.max` 裁剪合并盒；keeps antenna 的 rot 90/270 豁免错轴，且**扫掉焊盘区越界** | 是（T5 假通过、T6 假不通过） |
| `usb_at_end` | 分母 fallback 静默（见 5.5）；未校验 `y1>y0` | 部分（T1 里退回整板） |
| `no_bbox_overlap` | 只比 AABB，不比真实外形；`rot` 90 与 270 的 AABB 完全同形，所以判据**在原理上不可能**发现「90/270 装反」；`shrink=2`（相交区每边各缩 2 mil）让**深度 < 4 mil 的重叠被忽略**——我的实现用严格相交（不缩），这是两边的**定义差异**，只是 v3/v4 最小间隙 20 mil、根本没有相交对，所以不显形 | 一致（结论层面） |
| `mic_speaker_apart` | 量的是**两个器件中心的 PCB 距离**，而声学路径由壳体决定 —— 判据自己的 `basis` 就写了「PCB 无法保证」。它被当成 fail 计数，会让「改壳体」和「布局重做」看起来一样。这是**判据定性**问题，不是算错 | 一致 |
| `buttons_centered` | 只看 x，不看 y；「均位」用三个点的算术均值，对 3 个点等价于「首尾中点」，所以**恰好中间那颗键不在中线也不会红**（只要两侧对称） | 一致（v3/v4 都是 299/650/1001） |
| `imu_near_centerline` | 只比 x，忽略封装原点与焊盘中心可能不重合；容差 130 mil = 板宽 10%，自己声明是工程目标 | 一致 |

## 6. 旋转矩形（325 对）单独验算

**结论：没算错。** 两边算法不同，结果一致。

- 换宽高规则：`rot % 180 === 90` ⇒ 宽高互换。`_probe-sizes.js` 里 `natW/natH` 的定义是 `swapped = ((rot % 180)+180) % 180 === 90`，同一个式子。我按 `rot % 180 == 90` 实现，Python 与 JS 在 90/270/0/180 上取值一致。
- v4 的旋转器件实测盒（我从设计 JSON 独立算）：

| 器件 | rot | 盒 宽×高 | 备注 |
|---|---|---|---|
| SW1/SW2/SW3/SW4/SW5 | 90 | **128 × 217**（自然 217×128 换过来） | SW2 x[586,714] y[-1008.5,-791.5] |
| USB1 | 90 | **329 × 388**（自然 388×329 换过来） | x[35.5,364.5] y[-414,-26] |
| U1 | 180 | **748 × 1030** | y[-3972,-2942]，天线段向下 282 |

- U1 是**唯一**不能用「换宽高」处理的：它的包围盒不对称。两边都用「按 rot 定向展开」的写法（`x0 = p.x - (d[0]<0 ? ex : PAD_HALF)` …），`ex/ey = 374+282 = 656`，`PAD_HALF = 374`。我按「焊盘区 + 天线×定向」拼盒子，数值一致：`748 = 2×374`，`1030 = 748+282`。
- 325 对无相交，最近一对 v4 是 **C1↔C3 = 20.0 mil**（C1 x1=1080.5，C3 x0=1100.5），v3 是 **R2↔R3 = 22.0 mil**（R2 y0=-689，R3 y1=-711）。手算可复现。
- U1 与三颗 SW（rot 90）的间隙：SW1/SW2/SW3 全部 **1933.5 mil**（U1 盒顶 y=-2942 到 SW 盒底 y=-1008.5 之差），远不相交。
- 一处**原理性盲区**（不是错误）：AABB 测试对 rot 90 与 rot 270 给出完全相同的盒子，所以「装反 180°」这类缺陷这条判据在结构上不可能发现。要发现它得比焊盘坐标，不是比包围盒。
- 一处**定义差异**（不显形）：审计用 `shrink=2`，即相交区每边各缩 2 mil ⇒ 深 < 4 mil 的重叠被忽略；我用严格相交。v3/v4 无任何相交对（最小间隙 20 mil），所以两边结论一致；但在「刚好压线」的布局上两边会分歧。

## 7. 变异设计验证矩阵（11 个案例 × 10 条）

变异文件全部在 `F:\cache\temp\xT*.json`（只改设计 JSON，不碰 `designs/`）。生成脚本 `F:\cache\temp\mkvariants.py` / `mk2.py` / `mk3.py`，对账脚本 `F:\cache\temp\cmp.py`。

| 案例 | 改了什么 | audit exitCode | 结论分歧 |
|---|---|---|---|
| v4 基线 | — | 0 | 0 |
| v3 基线 | — | 0 | 0 |
| T1 带 y 倒置 | `y0=-3690,y1=-3700` | 1 | `antenna_band_empty`：audit pass / mine fail |
| T1b 带 x+y 倒置 | 再加 `x0=1024,x1=276` | 1 | `antenna_band_empty` |
| T1c 带 x 倒置 | 只倒 x | **0** | `antenna_band_empty`、`band_covers_antenna`（**双绿**） |
| T1d 带 x 太窄 | `x0=0,x1=100` | **0** | `band_covers_antenna`（**静默通过**） |
| T2 U1 焊盘出左板边 | `U1.x=100` | 1 | `band_covers_antenna`（真实缺陷两边都抓到：`all_inside_board` 同判 fail） |
| T3 器件侵入带内 | `C2.y=-3695` | 1 | 0（两边同判 3 条 fail） |
| T4 USB 移到长边中段 | `USB1.y=-1850` | **0** | 0（两边同判 `usb_at_end` fail，但 **exitCode 仍是 0**） |
| T5 U1 焊盘跨板底 174 | `U1.y=-3500` | **0** | `all_inside_board`（假通过）、`band_covers_antenna`（负跨度当覆盖） |
| T6 U1 rot90 天线朝 −X | `U1.rot=90` | 1 | `antenna_overhang`（unknown vs **pass**）、`all_inside_board`（fail vs pass） |

**判据结论差异合计 10 处，涉及 4 条判据。** 全部集中在 PCB 类。**8 处的方向是「审计更宽」（静默通过），2 处（T6 的 `antenna_overhang` 与 `all_inside_board`）是「审计更窄」（误报）。**

T4 值得单独看：`usb_at_end` 判 **fail**（49.9%），`exitCode` 却是 **0**。因为它是 [机构] 类，按契约不算 PCB 缺陷。如果把 `PLACEMENT=WARN` 当通过，这条会被漏掉。

## 8. 这次复核**没能**检查什么

按重要性排：

1. **尺寸表无法独立实测。** 我没有 EDA 会话（禁止并发调 `lceda-pro.exe`），`SIZES` 表整段采信 `scripts/relayout.mjs` 顶部常量（注释声明出自 `_probe-sizes.js` 实测包围盒）。它与被测的 `audit-placement.mjs` **同源**。所以「哪个料号的宽高记错了」这一整类错误，**这次复核结构上查不出来**。要查必须重跑 `_probe-sizes.js` 或读 EDA 里每个封装的 `getPrimitivesBBox`。
2. **U1 的内部结构参数**（焊盘区 748×748、天线 +282、封装原点在焊盘区中心、`0→+Y/180→−Y/90→−X/270→+X`）全部按题给事实采信，未实测。
3. **真实板框几何。** 我只用 `boardHeightMil=3700`。`_antennaKeepout.why` 记录的实测 `boardMinY=-3705` 我没验，所以 261.5 这个「实测悬出量」我复现不了。`antenna_overhang` 的 272 是**标称口径**。
4. **旋转方向的定义本身。** 我采信「rot 逆时针、0→+Y」。如果 EDA 的 rot 实际是顺时针，90 与 270 会互换 —— AABB 相同，包围盒类判据看不出来；只有 U1 天线朝向与 Type-C 对口面会错。
5. **净空区是否真被落成 Region。** `_antennaKeepout` 只是 JSON 里的意图；它有没有变成 `pcb_PrimitiveRegion(ruleType 5/6/7)` 是另一条链（`pipeline3.js`）的断言，我没跑，也没读那边的产物。
6. **电气、DRC、可制造性全部不在范围内。** 10 条判据只比包围盒。
7. **退出码 2 的路径**（尺寸未知 → `PLACEMENT=NOSAMPLE`）我没构造样本验证；v3/v4 都是 26/26 有尺寸。
8. **其它设计没跑。** 本轮只有 v3 与 v4 两份（以及 9 个由 v4 派生的变异体）。v2、`mic-esp32s3.json` 和 `designs/` 下其余设计**未跑、未计数**，所以本报告的分母始终是「2 份设计 × 10 条判据 = 20 个结论」，不外推到整个语料。
9. **`_probe-sizes.js` 与 `SIZES` 是否真的一致**：我只能看到 `relayout.mjs` 的注释这么说，没有实测记录可比对。

## 9. 复现

```powershell
# 基线（被测）
E:\APP\nodejs24\node.exe scripts\audit-placement.mjs designs\mic-esp32s3-v4.json --json
E:\APP\nodejs24\node.exe scripts\audit-placement.mjs designs\mic-esp32s3-v3.json --json

# 独立重算
C:\Users\UserX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe out\_probe\audit-crosscheck.py designs\mic-esp32s3-v4.json designs\mic-esp32s3-v3.json
C:\Users\UserX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe out\_probe\audit-crosscheck.py designs\mic-esp32s3-v4.json --json
C:\Users\UserX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe out\_probe\audit-crosscheck.py designs\mic-esp32s3-v4.json --focus

# 变异设计与对账
C:\...\python.exe F:\cache\temp\mkvariants.py ; F:\cache\temp\mk2.py ; F:\cache\temp\mk3.py
C:\...\python.exe F:\cache\temp\cmp.py
```

全部只读仓库；写入只落在 `out\_probe\` 与 `F:\cache\temp\`。
