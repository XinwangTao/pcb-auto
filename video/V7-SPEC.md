# V7-SPEC · PcbRealV7（EDA 自己渲染的画布帧版）

## 1. 合成参数
`PcbRealV7` / `src/PcbRealV7.jsx`｜1080×1920 · 30fps｜H.264 High · **yuv420p**(tv)｜静音 AAC
占位素材 631 帧 = 21.03s / 8.61 MB（5 段）；9 个真实帧 929 帧 = 30.97s

渲染命令（**两个编码参数不能省**，见 §6）：
```
npx remotion render src\entry.js PcbRealV7 out\v7-placeholder.mp4 --concurrency=4 --pixel-format=yuv420p --color-space=bt709
```

## 2. 素材发现（`v7/prepare.mjs`，CLI 启动前跑一次）
1. `out/frames/` 按名字倒序取最新时间戳目录（忽略 `_`/`.` 开头，必须有 png），png 按文件名排序 → `source=frames`（正片）
2. 否则 `out/stills/*.png` → `source=stills`（占位）
3. 都没有 → 1 段 4.5s 占位卡，不崩（`npx remotion still` 实测通过）

选中的 PNG 硬链接（跨卷复制）到 `public/v7/img/`，写 `public/v7/manifest.json`；合成直接 `import` 它，`durationInFrames` 打包期即确定。
> 本目录原有 `remotion.config.mjs` **从未被加载**——cli 只认 `remotion.config.ts` / `.js`。新增的 `remotion.config.js` 用子进程调 `prepare()`，不复制 .mjs 里的 setVideoImageFormat / setConcurrency / setBrowserExecutable，老合成行为不变；失败只 warn。## 3. 帧 → 阶段映射
| tag | 小标题 | 字幕 |
| --- | --- | --- |
| `sch-wired` | 原理图连线 | 器件逐个落位，引脚逐根接出 |
| `pcb-imported` | 导入 PCB | 网表进 PCB，器件自动落板框 |
| `pcb-layout` | 自动布局 | 按网络关系排布，缩短走线距离 |
| `pcb-pour` | 覆铜 | 双面覆铜，GND 铺满整板 |
| `pcb-routed` | 自动布线 | 布线器逐条走线，过孔自动生成 |
| `pcb-stitched` | 孤岛补线 | 孤立铜皮补过孔，GND 接回去 |
| `pcb-clearance` | 间距修复 | 间距不足就退回重走 |
| `pcb-patched` | DRC 兜底 | DRC 前统一兜底修补 |
| `pcb-drc` | DRC 通过 | 零违规通过，制造文件一次导出 |

未知 tag 两段兜底：关键词（rout/pour/layout/drc…）→ 序号铺满上面 9 阶段（`matched=positional`）。字幕 ≤16 汉字，竖屏一行读完不拆词。

## 4. 时间轴
```
XF=11 帧(0.35s)   SEG=round(30×clamp(34/N, 3.2, 4.5))   总帧=(N−1)×(SEG−XF)+SEG
```
| N | 5（占位） | 6 | 9（真实） | 11 | 15 |
| --- | --- | --- | --- | --- | --- |
| 总帧 | 631 | 755 | 929 | 946 | 1286 |
| 时长 | 21.03s | 25.17s | 30.97s | 31.53s | 42.87s |

N>11 后 SEG 触底 3.2s，总长按 85 帧/段线性增长。帧间 0.35s 交叉淡入（下一段压在上一段上，不用黑场）；Ken Burns 100%→108% / 108%→100% 交替。**无封面页、片头 logo、片尾感谢页**，第 1 帧即第 1 阶段。

## 5. 占位图处理
- `stills` 是 1080×1920 成片抽帧，自带进程栏与底部图例 → 只取 `y=240..940` 画布带，裁后无旧标题残留。
- 真实帧**不裁**，`contain` 完整显示；比例未知宁可留边不切内容。
- 徽标 `占位素材` + 页脚 `占位素材 · 成片抽帧，非 EDA 画布`，避免把抽帧当 EDA 证据；真实帧时变 `EDA 实时渲染帧` / `EDA 画布 · <tag>`。

## 6. 实际 ffprobe 输出（原文）
```
codec_name=h264
width=1080
height=1920
r_frame_rate=30/1
codec_name=aac
r_frame_rate=0/0
duration=21.077333
```
v:0：`profile=High pix_fmt=yuv420p color_range=tv nb_frames=631`，`9031324 bytes`。
不加 `--color-space=bt709` 时 Remotion 4 默认 `colorSpace='default'`，JPEG 中间帧全范围 → 输出被标成 **yuvj420p**（首轮实测），加参数后才是 yuv420p/tv。

## 7. 三张抽帧的观感（`out\_chk_01..03.png` = n 30/200/400）
1. **n=30（STEP 01 原理图连线，占位）**：画布不黑——裁出的 EDA PCB 视图中红色铜面、U2/D1/C1/GND 丝印、「保存成功!」气泡、底部层叠色条俱全，无旧成片标题残留。标题 64px 白字左对齐、笔画完整无方框；进度约 3%；字幕 52px 白底黑字单行，底边距 170px。
2. **n=200（STEP 02 自动布局）**：已推到 108%，PCB 边缘被裁属预期、主体居中；进度约 40%；环境模糊层是暗红渐晕，**不是纯黑**。
3. **n=400（STEP 04 间距修复）**：奇数段反向缓出，比 n=200 略松，交替生效；进度约 80%。
另查 n=128（淡入中点）画面叠影但**文字无重影**；n=630 末帧进度 100%。

## 8. 真实帧到位后要调的
1. **帧数**：加 PNG 即重算；N>11 按 85 帧/段变长（N=15 ≈42.9s）。锁 ~34s 改 `SEG_TARGET_S`，或 `XFADE_S` 降到 0.25。
2. **tag**：新增/改名里程碑要在 `STAGES` 补行，否则走兜底、标题错位。
3. **比例**：画布框按真实宽高比算（`plateH=clamp(992/aspect,320,1024)`）；竖版长图卡 1024，上下留 396/480。
4. **清晰度**：若真实帧宽 <1000px，108% 放大后丝印会糊，把 zoom 上限降到 1.04。
5. **目录**：只认名字倒序最新目录，录制沿用 `HHmmss`；`prepare()` 每次 CLI 启动重扫。
