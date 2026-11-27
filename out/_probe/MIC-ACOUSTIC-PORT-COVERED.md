# MEMS 麦克风的声孔被铜覆盖、且没有被钻出来

> 记录时间：2026-11-26 21:4x（Asia/Shanghai）
> 样本：`out/ESP32S3_Wireless_Mic_V5-20261126-211421`（`elapsedMs=790880`，`drcResult.n=5`）
> 与 `-210140` 逐点一致的旁证：两次构建的 5 条 DRC 叶子坐标**完全相同**
> （`(621,−193)` / `(636,−249)` / `(650,−248)` / `(99,−390)` / `(99,−49)`），
> 说明它们与 C6/C7 的挪位无关，是稳定的几何事实。

## 一、这条线索是从哪冒出来的

先查 `slotKeepout.found === 0` 这个长期可疑读数。日志里它每次都这样：

```
slotKeepout {"found":0,"created":0,"failed":0,"skippedBig":0,
             "fillCensus":{"1":0,"2":0,"12":0,"15":0,"16":0,"17":0},
             "censusEmpty":true,"padTotal":163,
             "holeTypes":{"ROUND":8,"SLOT":4},"npthCount":0,"slotCount":4}
```

`fillCensus` 全 0 ⇒ 它去找的是 **Fill**（`pcb_PrimitiveFill`），而板上的面是 **Pour**
（`idxSizes` 实测 `fill:0, pour:2, poured:2`）。所以 `found:0` 是**量具看错了对象**，
不是「板上没有槽」。这一点已在 FAILURES 第 27 条记过。

但顺着它查下去，撞到一件更要紧的事：`slotGeoCmp` 每轮都在报同一个对象，而它**不是**
那 4 个 USB-C 壳体槽。4 个槽在 `x∈[133,297] y∈{−50,−390}`，是 TYPE-C 的抱死脚；
这个对象在 **(650, −251)** —— 在 U4 的封装正中间。

## 二、那个对象是 U4 的声孔

`pipeline3.js:2975` 的注释（2026-11-26T19:21 写下，当时是 v4 第 4 次尝试）直说：

> 「U4（MEMS 硅麦 DMM-4026）封装里那个 **16.83×16.83mil 的声孔区域**，
> 违规点 x=637 而盒子 x0=641.587 —— 只差 0.587mil」

日志里的实测盒子与它对得上：

```
slotGeoCmp {"objId":"4b3d7a2eb8b2cf61e37","parentId":"4b3d7a2eb8b2cf61",
            "obBBox":[642,-260,658,-243],"obWH":[17,17],"obCenter":[650,-251],
            "viol":[650,-248],"violInFabricatedBox":true,"violInRealHole":false,
            "slotsTotal":4}
```

17×17 mil = 0.43×0.43 mm。位置 (650,−251) 落在 U4 占位
`x∈[578.5,721.5] y∈[−283.5,−116.5]` 之内，距封装中心 (650,−200) 偏下 51 mil。
**这是封装底部的一个开口，不是焊盘**：全板 `holeTypes` 只有 `ROUND 8 + SLOT 4`，
而 4 个 SLOT 都在 TYPE-C 那边；`padTotal 163` 里没有它。

## 三、两件无条件成立的事

### 3.1 铜压在这个开口上，净距 0 mil

```
clearDiag {"t1":"Track","t2":"Slot Region","net":null,"layer":[1,12],
           "cur":0,"need":11.811,"at":[650,-248]}
```

`cur: 0` —— 不是「靠得近」，是**重叠**。另一条是 `cur: 6.669` 对 `need: 11.811`。
两条都在 DRC 里留了下来，`drcLeaves.byType` 记为 `"Clearance Error | Slot Region to Track": 2`。

也就是说：**有走线从麦克风封装体的正下方穿过去，而且压住了封装自己标注的开口区域。**

### 3.2 那块地方在钻孔文件里没有孔

parse 三份 DRC 文件（十进制坐标、`METRIC` 口径）实测：

| 文件 | 坐标行 | 唯一孔位 |
|---|---|---|
| `Drill_PTH_Through.DRL` | 108 | 108 |
| `Drill_PTH_Through_Via.DRL` | 102 | 102 |
| `Drill_NPTH_Through.DRL` | 2 | 2 |

那 2 个 NPTH 是 0.6 mm，在 **(3.874, −8.488)** 与 **(3.874, −2.688) mm**
= (152.5, −334.2) 与 (152.5, −105.8) mil —— 落在 USB1 占位 `x∈[6,394] y∈[−384.5,−55.5]` 内，
是 TYPE-C 的定位柱孔。

U4 占位（±2 mm 内）**没有任何 NPTH 孔**；PTH 有 4 个，最近的在 (18.109,−5.639) mm
= (713,−222) mil，距开口中心约 68 mil，都是正常焊盘。

**结论：声孔位置既没有金属化孔也没有非金属化孔。**

## 四、条件成立的那一半（必须写成条件，不能写成结论）

「声孔没钻孔 ⇒ 麦克风收不到声音」这个推论**依赖端口朝向**：

- 若 DMM-4026-B 的端口朝板面（底进音）⇒ 必须在 PCB 上开孔，**这块板是哑的**；
- 若端口朝上（顶进音）⇒ 不需要 PCB 开孔，封装里那块区域是别的用途，本条不成立。

**这个朝向无法从第一方资料核实。** 该料号在立创库**没有 datasheet 字段**，
而且流水线自己在 `runErrors.warnList` 里就为它报了低信任警告：

> `low-trust part C2875567 for U4 (社区上传件，无原厂/datasheet，下单前建议人工复核)`

`designs/mic-esp32s3-v*.json` 的 `_knownAssumption` 也已经为同一个料号留了同性质的免责声明
（LR / CONFIG 两脚极性待实物复核）。本条按同样处理：**记成待核实风险，不记成已证实缺陷。**

## 五、为什么已有的检查都没抓到

| 检查 | 为什么看不见 |
|---|---|
| `slotKeepout` | 查 `pcb_PrimitiveFill`，板上是 `pour`；且它查的是焊盘孔（`holeTypes.SLOT`），这个开口不是焊盘 |
| `slotPadGeometry`（L2916） | 只读 `EPCB_PrimitivePadHoleType.SLOT` 的焊盘孔 ⇒ 只看到 TYPE-C 那 4 个 |
| `geoIdPrefix`（日志原文） | `{"drcId":"4b3d7a2eb8b2cf61e37","hits":[],"used":null,`<br>`"note":"前 16 位也不在图元索引里 → 仍走 universalGeo 的 bbox 兜底"}` |
| `fabcheck` | 判据集合里没有「封装内开口到铜」这一档。它判 PASS 是**这一档没查**，不是查过放行 |
| `audit-placement` | 只读设计 JSON。这个开口是**封装几何**，设计文件里没有它 |

四条检查、四个不同的盲区。第 4 条是设计上应该的（摆放审计不该知道封装内部），
前三条是同一个根：**图元索引不覆盖封装内部的非焊盘对象。**

## 六、该怎么做（按可落地顺序）

1. **先解「能不能表达」，再解「怎么绕」。** 现在设计 JSON 里没有任何字段能声明
   「这块地方不许走铜」。`_antennaKeepout` 是硬编码在流水线里的单个用途。
   把它泛化成 `_copperVoids: [{x,y,w,h,why,src}]`，流水线按同样的
   `pcb_PrimitiveRegion(layer=12, ruleType=[5,6,7])` 建禁布区。
   坐标就用上面实测的 `[642,−260] → [658,−243]`，`src` 写明它来自封装自带的开口区域。
2. **再让布线绕开它。** 禁布区建在布线之前（与天线禁布区同一个阶段），
   然后接受验收判据：`Slot Region to Track` 必须从 2 条降到 0 条，
   且 `stillUnconnected` 不回归、其它 3 条叶子不变。
3. **端口朝向必须由人核实**，或换一个有 datasheet 的料号。
   在核实之前，本条永远停在「可能哑」而不是「确定哑」。

## 七、复核命令

```powershell
cd D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto
py -X utf8 -c "import json,io;L=json.load(io.open(r'out\ESP32S3_Wireless_Mic_V5-20261126-211421\_log.json',encoding='utf-8'))['entries'];[print(e['s'],json.dumps(e['v'],ensure_ascii=False)) for e in L if e['s'] in ('slotGeoCmp','geoIdPrefix')][:2]"
#   期望 obBBox [642,-260,658,-243] / geoIdPrefix hits:[] used:null

py -X utf8 -c "import json,io;L=json.load(io.open(r'out\ESP32S3_Wireless_Mic_V5-20261126-211421\_log.json',encoding='utf-8'))['entries'];print([e['v'] for e in L if e['s']=='clearDiag' and e['v'].get('t2')=='Slot Region'])"
#   期望两条，第一条 cur=0 need=11.811
```

钻孔侧：

```powershell
py -X utf8 -c "import zipfile,re;z=zipfile.ZipFile(r'out\ESP32S3_Wireless_Mic_V5-20261126-211421\Gerber.zip');
print([(n,z.read(n).count(b'\n')) for n in z.namelist() if '.DRL' in n.upper()])"
#   期望三个 DRL；NPTH 那个只有 2 个孔，坐标 (3.874,-8.488)/(3.874,-2.688)
```
