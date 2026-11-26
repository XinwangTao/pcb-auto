# v5 摆放改动 vs 布线结果的实测对照

> 量于 2026-11-26T19:49（Asia/Shanghai），构建目录
> `out/ESP32S3_Wireless_Mic_V5-20261126-193938/`，`pipeline3.js` sha `DDAEC326BC22`。
> 全部读数取自第 1 轮 `[smart-fit]`（板框 1300×3700 mil）的 `_run-1-smart-fit.json`
> 与 `_log-1-smart-fit.json`，74 个顶层目录里只取这一对，不跨轮次合并。

## 1. 改了什么

`designs/mic-esp32s3-v5.json` 相对 v4 只做三件事（其余逐字节相同）：

| 动作 | 器件 | 位置 (mil) | 到目标 IC 边缘 | 为什么 |
|---|---|---|---|---|
| 新增 | `C9` 100nF (C14663) | (499, −312) | U4 20.0 | U4 原本离最近旁路电容 **1404 mil** |
| 新增 | `C10` 100nF (C14663) | (219, −2889) | U1 20.0 | U1 在天线端，原本没有专属旁路 |
| 移动 | `C5` (1000,−1720) → (860,−2160) | | U3 79.5 | 原位置一个 IC 都没服务到（离 U3 349 mil） |

静态审计（`scripts/audit-placement.mjs`）：**11 条判据 11 通过，`PLACEMENT=PASS`，`exit 0`**。
元件 26→28、连接 111→115。

## 2. 量到什么

同一设计名、同一板框、同一轮阶段，只差这三个摆放改动：

| 量 | v4 (192608 第 1 轮) | v5 (193938 第 1 轮) | 变化 |
|---|---|---|---|
| `drcLeafCount` | 7 | **20** | ×2.86 |
| `drcTotalCount` | 14 | **40** | ×2.86 |
| 顶层违规组（`run-all` 报的「违规组」）| 1（只有 Clearance）| **2**（多了 Connection）| **类别退化** |
| `clearanceRevertOk` | `true` | **`false`** | 新失败 |
| `clearanceRevertDangling` | `[]` | **`['c3ed8bc1d5b0afb4']`** | 悬空引用 |
| `exportsOk` | 6/6 | 6/6 | 同 |
| `errors` / `mismatches` | 0 / 0 | 0 / 0 | 同 |

**这两个数不能直接比。** v5 有 28 个元件、v4 有 26 个，元件多两个必然多出 DRC 面。
真正的信号是**类别**而不是计数：v5 多出了整整一类 `Connection Error`。

## 3. 20 条 leaf 的分解（v5）

```
Clearance Error | Track to Track          3    @ (772,-1732)(770,-1739)(772,-1732)  cur=0 need=4
Clearance Error | SMD Pad to Track        1    @ (743,-1739)                        cur=3 need=6
Clearance Error | SMD Pad to Via          2    @ (103,-109)(103,-331)               cur=6 need=6  ← cur==need，取整边界
Clearance Error | Slot Region to Track    3    @ (634,-249)×2 (650,-248)            U4 声孔区域，已知
Clearance Error | Hole to Hole            3    @ (659,-2159)(99,-390)(99,-49)       cur=0/8 need=12
Connection Error | Track                  2    @ (591,-2106)(612,-2062)             GND
Connection Error | SMD Pad                6    @ (591,-2110)(640,-2041)(591,-2090)  GND ×3
                                                (994,-3366) AMP_LRCLK
                                                (775,-2966)(729,-1671) IMU_INT
```

`byNet`: `?` 12 / `GND` 4 / `AMP_LRCLK` 2 / `IMU_INT` 2。

## 4. 归因：避让器删了地孔，恢复失败

`_log-1-smart-fit.json` 里 `viaDeleted` × 4，**全部 `net="GND"`、`d=19.8`**：

```
(729,-1737)  (633,-2041)  (591,-2103)  (729,-1683)
```

而 4 条 GND `Connection Error` 的坐标：

```
(591,-2106)  (591,-2110)  (612,-2062)  (640,-2041)
```

**逐个对得上（差 ≤ 15 mil）。** 即：为了躲净距删掉的 GND 缝合孔，
把 GND 网络拆成了孤岛；而 `clearanceRevertOk=false` 说明该轮回滚**没能把孔放回去**，
于是「净距瑕疵」被换成了「电路断开」。

`clearanceRevertDangling=['c3ed8bc1d5b0afb4']` 是同一病灶的第二个证据：
回滚删掉了一条本该接回去的线。

这条路径早就在代码里有注释（`pipeline3.js:1256`）：
「clearance 会把它当间距违规删掉（语料 `viaDeleted` 45/45 都是 GND、`d` 恒 19.8）」
「不是必然报废：45 条里有 26 条最终仍 passed，属高危路径」。
v5 这次是没救回来的那一类。

## 5. 结论（以及不下的结论）

**能说的：** v5 的**摆放**在电气上确实比 v4 好（U4/U1 的旁路距离 1404→20 mil、无→20 mil），
静态 11 条判据全过；但**这一次布线**比 v4 差，且差在类别上（多了 Connection Error）。
直接成因是避让器删 GND 缝合孔 + 回滚失败，不是摆放本身。

**不能说的：** 不能说「摆放改动导致 DRC 变差」。
元件数 26→28 未控制，避让器也是关键变量，两个变量没隔离。
要判断摆放的影响，必须再跑一版 **v5b = v4 + C9/C10（不动 C5）**，把「移动 C5」这个变量单独拎出来。

**下一步（按收益排序）：**
1. 让避让器**不删 GND 缝合孔**（或删后必须验证连通性），否则它随时会把好板子换成断板。
2. 隔离变量跑 v5b，判断「移动 C5」到底值不值。
3. 若确认 C5 移动是主因，改在 U3 左侧更空的位置重新搜索，而不是挤进 (860,−2160)。
