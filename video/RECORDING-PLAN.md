# RECORDING-PLAN · 录屏素材清单与缺口报告

全程只读 + ffmpeg 文件级分析。**未启动 LCEDA、未开 EDA 会话、未跑流水线**（`.pipeline.lock` 在跑，勿抢 EDA）。

## 结论：现有素材不够，拍不出"一步步画图布线"

1. **`out\stills\` 不存在。** `cam()`（`scripts\pipeline3.js` L47-85，行号按 19:19 修订版；该文件正被后台循环打补丁）没有截图调用，只做 `openDocument`/`tileAllDocumentToSplitScreen`/`zoomTo…` 改视图；画面靠外部 `record-*.ps1` 的 `gdigrab` 录桌面。全仓唯一 stills 是 `video\out\stills\` 5 张（1080×1920，15:24–15:42），是**成片抽帧**，不是 EDA 画面。
2. **49s"真实画面"里没有过程。** `video\public\real\*` 6 段（1122/1280×796，30fps）按 1fps 去重后每段只剩 2–9 个不同画面；`03_layout/04_pour/05_route/06_final` 首帧灰度差仅 1.3–3.0（同一张已布好的板），`05_route` 第 0.5s 就已全布通。`01_sch`（12s/9 帧）是"空黑→58% 全图"转场，器件仅约 30px，读不出内容。
3. **根因可复现。** `placeParts`(71.7s)/`connect`(4.0s) 期间画布**纯黑**（`gui-hd.mp4` t=88 双分屏两格全黑）——紧排的 API 写操作让浏览器拿不到绘制帧；只有 `waitJob()`（L99-110）带 `sleep(1200)` 轮询的布局/布线段出画面。灰度差：`gui-hd` 仅 0–20s、80–130s 在动，130–200s 恒 0.01。**全库真实"动作"约 20–30s，只有布线一段。**

## 现有 stills 实测

| 素材 | 规格 | 量 | 时间跨度 | 覆盖 |
| --- | --- | --- | --- | --- |
| `out\stills\` | — | **0 张** | — | 无，目录不存在 |
| `video\out\stills\` | 1080×1920 | 5 张 | 15:24–15:42 | 成片抽帧 |

原始录屏：`out\gui-*.mp4` 1280×800–1920×1200、150–230s；`real\*` 1122/1280×796、6 段 49s，03–06 为同一静止板。

## 缺口：想法→原理图→布局→布线→DRC→Gerber

| 阶段 | 有无 | 缺什么 |
| --- | --- | --- |
| ① 想法 | 仅卡片 | 输入那一屏（CLI/design.json） |
| ② 放件 | **无**（黑屏） | 器件逐个出现 |
| ③ 连线 | **无**（黑屏，58% 缩放读不清） | 导线逐条接上引脚、GND/电源标志 |
| ④ 同步 PCB | 无 | 导入成功 + 器件落入板框 |
| ⑤ 布局 | 有完成态 | 布局**进行中**的器件挪动 |
| ⑥ 铺铜 | 有 | 铜面从无到满 |
| ⑦ 布线 | 有 20s（`gui-hd` 100–130s） | 走线特写，需单独切 |
| ⑧ DRC | 有日志面板 | 违规→修复→0 对比 |
| ⑨ Gerber/BOM | 无 | 导出目录 6 文件出现的瞬间 |

## cam() 要改哪里

**替换 L47-85**（split/force/zoom 原逻辑保留，只加截图与让帧）：

```js
let shotN = 0, lastPulse = 0;
const SHOT_MAX = 240;
const SHOTDIR = ((A && A.stillDir) || (OUT + '\\stills\\')).replace(/[\\/]?$/, '\\');
async function shot(tag) {
  if (!REC || shotN >= SHOT_MAX) return;
  try {
    const img = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(); // beta
    if (!img) return;
    const name = (++shotN).toString().padStart(3, '0') + '_' + tag + '.png';
    await eda.sys_FileSystem.saveFileToFileSystem(SHOTDIR + name, toBlob(img));
  } catch (e) { log('shotErr', { tag, m: String(e && e.message).slice(0, 120) }); }
}
async function cam(what, force, tag) {
  /* …… 原 L49–81 的 splitDone / force / zoom 原样不动 …… */
  await sleep(150);
  await shot(tag || what);
}
async function pulse(tag, gapMs = 1100) {
  if (!REC || shotN >= SHOT_MAX) return;
  const now = Date.now();
  if (now - lastPulse < gapMs) return;   // 节流不 sleep，别拖慢轮询
  lastPulse = now;
  await sleep(220);                      // 让出事件循环，否则画布不重绘（黑屏根因）
  await cam(tag.indexOf('sch') === 0 ? 'sch' : 'pcb', false, tag);
}
```

| 行 | 现状 | 改为 |
| --- | --- | --- |
| L296 后（放件循环尾） | 无 | `await pulse('sch-part' + i, 900);`（≈8s 一帧 ×9） |
| L377 前（连线循环尾） | 无 | `await pulse('sch-net' + ci, 700);`（21 根各一帧） |
| L107 `waitJob` 的 `sleep(1200)` 后 | 无 | `await pulse('job-' + what, 3400);` ← 布局/布线过程帧唯一来源 |
| L454/599/660/1352/1453 | `cam('pcb'[,true])` | 补 tag：`layout-before`/`pour`/`route-before`/`drc-clean`/`gerber` |

配合三点：① 原理图不能只 `zoomToAllPrimitives()`（58%，器件 30px），放件/连线后改用 `zoomToRegion` 框住已用区域；② 先复制成 `pipeline3-rec.js` 再验证，**别改正在被无人值守循环调用的那份**；③ 上述 API 为 beta，不可用则改为按 `shot` 时间戳到 `live-*.mp4` 抽帧。

## 旁白（8 句，各 ≤20 字）与画面节点

| # | 台词 | 画面 |
| --- | --- | --- |
| 1 | 一句话，它开始自己画 | ① 需求/CLI 输入 |
| 2 | 器件自己挑，一个个摆上原理图 | ② 放件（需补） |
| 3 | 每根线都按引脚方向接出去 | ③ 连线（需补） |
| 4 | 同步到 PCB，器件自动排开 | ④→⑤ |
| 5 | 两层铺铜，地把整块板铺满 | ⑥ 铺铜 |
| 6 | 布线器一条条走，只剩收尾 | ⑦ 布线特写（已有） |
| 7 | 间距不够就退回重走，零违规 | ⑧ DRC 对比 |
| 8 | 制造文件和 BOM，一次导出 | ⑨ Gerber（需补） |

配音链路已就绪：台词填进 `video\scripts\tts_pcb.py` 的 `GROUPS`（L46-90）。`VOICE/RATE/GAP_MS/TARGET_LUFS`（L38-42）= `zh-CN-YunxiNeural / +8% / 260ms / -16`，单句 `loudnorm=I=-16:TP=-1.5:LRA=11`（L142）、`adelay`（L181）、`amix=normalize=0`（L183）均合 V6 标准。按否决项须删 `PcbRealV6.jsx` L631 的 `<Captions>` 与 L301/L329 标题卡、痛点卡。

## Remotion 校验（已实跑，未渲染）

```
cd pcb-auto\video
npx remotion compositions src\entry.js
The following compositions are available:
PcbAuto      60      1080x1920      3480 (58.00 sec)
PcbReal      30      1080x1920      1470 (49.00 sec)
PcbRealV6    30      1080x1920      2641 (88.03 sec)
```

exit 0，`PcbRealV6` 在列。**未执行 render**（素材不全，渲了是废片）。
