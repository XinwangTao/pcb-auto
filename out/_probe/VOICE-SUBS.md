# VOICE-SUBS · V11 配音 + 硬字幕（8 句）

量于 2026-11-27T10:20(+08:00) · 本机 Windows / pwsh 7 / ffmpeg 7 在 `C:\ffmpeg\bin`
对应成片 `video\out\v11-final.mp4`（1080×1920 / 30fps / 546 帧 / 18.200s）
本轮只做**配音 + 字幕 + 合成改造**，整片渲染由主 agent 统一跑；这里给出「一次能过」的证据。

---

## 1. 八句台词（全部 ≤14 字）

| # | 段 id | 台词 | 字数 | 实测时长 | 段长 2.567s 占比 | 段推进 2.233s 占比 | 可用窗 2.153s 占比 | 帧区间 | 响度 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `pcb-imported` | 手工干，要好几个小时 | 10 | **1.797s** | 0.700 | 0.805 | 0.835 | 2–56 | -16.0 |
| 2 | `pcb-layout` | 28 个器件，自己排开 | 11 | **1.721s** | 0.671 | 0.771 | 0.799 | 69–121 | -16.0 |
| 3 | `pcb-pour` | 铺铜两层，先把地接通 | 10 | **1.840s** | 0.717 | 0.824 | 0.855 | 136–192 | -16.0 |
| 4 | `route` | 115 根线，自己走过去 | 12 | **1.925s** | 0.750 | 0.862 | 0.894 | 203–261 | -16.0 |
| 5 | `pcb-routed` | 布线走完，DRC 零违规 | 12 | **2.040s** | 0.795 | 0.913 | **0.948** | 270–332 | -16.0 |
| 6 | `pcb-bottom` | 翻到底层，走线压铜 | 9 | **1.823s** | 0.710 | 0.816 | 0.847 | 337–392 | -16.1 |
| 7 | `pcb-stitched` | 断掉的线自己缝上 | 8 | **1.500s** | 0.584 | 0.672 | 0.697 | 404–449 | -16.0 |
| 8 | `pcb-clearance` | 410 秒，6 个制造文件 | 13 | **1.852s** | 0.722 | 0.829 | 0.860 | 471–527 | -16.0 |

**max(句长 / 段长) = 0.795**（第 5 句，段长 2.567s）
**max(句长 / 段推进) = 0.913**
**max(句长 / 可用窗) = 0.948** ← 最严的一条，仍 ≤ 1.0

「段可用时长」按三个口径都算了，因为段与段之间有 10 帧交叉：
`段长 = SEG/30 = 2.567s`、`段推进 = (SEG-XFADE)/30 = 2.233s`（决定会不会撞下一句）、
`可用窗 = 段推进 - 起播余量 0.08s = 2.153s`（本片实际用的）。三者都 ≤ 1.0。

### 台词为什么是这几句

主旨：**手工要好几个小时 → 410 秒（6.83 分钟）从导入到 6 个制造文件**。
第 1 句立分母（几个小时，定性基线），第 8 句给分子（410 秒 + 6 个文件）。
中间 6 句全部在说「AI 具体在干什么」，一句一段，念的就是屏上那行字。

五组实测数字都在里面，出处 `out\ESP32S3_Wireless_Mic_V5-20261127-005256\_run.json`
（DRC 计数在 `gates` 里，不在顶层 —— 顶层没有这个字段）：

| 数字 | 台词位置 | 来源字段 | 值 |
|---|---|---|---|
| 28 器件 | 第 2 句 | `components` / `gates.placements.requested` | 28 / 28 |
| 115 连接 | 第 4 句 | `connections` | 115 |
| DRC 零违规 | 第 5 句 | `gates.drcLeafCount` / `gates.drcTotalCount` | 0 / 0（`gates.drcPassed=true`）|
| 410 秒 | 第 8 句 | `elapsedMs` | 410299 → 410s |
| 6 个制造文件 | 第 8 句 | `gates.exportsOk` / `exportsTotal` | 6 / 6 |

没有写任何「提升 N 倍」类无分母数字。板框 1300×3700mil 在同一份 `_run.json`。

---

## 2. 字幕参数（`video\src\Subtitle.jsx` → `SUBTITLE_LAYOUT`）

| 项 | 值 | 理由 |
|---|---|---|
| 字号 | **62px**，字重 800 | 竖屏 1080 宽，13 个汉字 = 806px，一屏一行不折行 |
| 位置 | `top: 1356`，`height: 132`（占 70.6%–77.5% 高度） | 画布框下沿 1322、`数字事实`行 1536 —— 只有这段空白带能放，且不和已有三行（事实/帧来源/进度点）撞车 |
| 底宽 | 992px（`PAD=44` 版心同宽），文字可用 904px | 与全片左右留白一致 |
| 底色 | 半透明渐变底，峰值 `rgba(3,5,10,0.88)`，两端淡出 | 「半透明底」，不是贴纸盒子 |
| 描边 | 8 向 3px `text-shadow` + 30px 落影 | Chromium 对中文多边形描边比 `-webkit-text-stroke` 干净（后者会啃字怀） |
| 颜色 | 正文 `#FFFFFF`；**数字 `#2ED3A0`（主题绿）** | 28 / 115 / 410 / 6 一眼能抓住 |
| 动画 | 只 `interpolate` 按帧算：进 4 帧、出 5 帧、上浮 14px | 无 CSS transition/keyframes（逐帧截图下取值不确定） |
| 区间 | 与这句配音**同起同落**：`startFrame = 段内第 2 帧`，`endFrame = startFrame + ceil(durSec×30)` | 音、字、画三者同源，避免「字在念下一句」 |

位置不在最底部是有意的：1322 以下已经被 `数字事实`(1536)、`帧来源`(1610)、
`帧进度点`(1676)、`进度条`(1720/1750) 占满，硬塞到最底部只会压字。

---

## 3. 改了哪些文件

| 文件 | 动作 | sha256_12 |
|---|---|---|
| `video\src\PcbRealV11.jsx` | 改：8 段各叠一句字幕 + 8 条 `<Audio>` + BGM 压到 0.5 | `A8DB9F212276` |
| `video\src\Subtitle.jsx` | **新增**：字幕组件 + 排版常量导出 | `F431736604B0` |
| `video\scripts\tts_v11.py` | **新增**：8 句 TTS → `public\voice_v11\` + `timing.json` | `36493DD2D11D` |
| `video\scripts\verify-voice-v11.mjs` | **新增**：独立重测每句时长并断言 | `73CC79DE578A` |
| `video\public\voice_v11\s01..s08.wav` | **新增**：交付音频（48k/16bit/立体声/-16 LUFS） | — |
| `video\public\voice_v11\timing.json` | **新增**：时间轴 | — |
| `video\public\voice_v11\raw\raw_01..08.mp3` | **新增**：edge-tts 原料（含首尾静音，**不能当分母**） | — |
| `video\scripts\subset-fonts.py` | 改：扫描源加上 `public/v11/manifest.json` 与 `public/voice_v11/timing.json`；自检改为「源字体有的字不能丢」 | — |
| `video\public\fonts\sub-regular.ttf` / `sub-bold.ttf` | 重跑 subset（新增「缝」字等） | — |
| `video\src\fonts.css` | 由 `gen-font-css.mjs` 重新生成 | `56384075E092` |

**没碰**：`PcbRealV10.jsx`（`git status` 无条目 ✓）、`video\scripts\make-v11.ps1`、
`video\scripts\build-v11.mjs`。
`scripts\*.js` 里没加任何 `import`/`export`（新增的是 `.mjs` 与 `.py`）。

---

## 4. 验证（都是自己跑的，输出原样贴）

### 4.1 每句音频实测时长

```powershell
cd D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto\video
ffprobe -v error -show_entries format=duration -of csv=p=0 public\voice_v11\s01.wav   # 以此类推 s01..s08
```

```
public\voice_v11\s01.wav -> 1.797000
public\voice_v11\s02.wav -> 1.721000
public\voice_v11\s03.wav -> 1.840000
public\voice_v11\s04.wav -> 1.925000
public\voice_v11\s05.wav -> 2.040000
public\voice_v11\s06.wav -> 1.823000
public\voice_v11\s07.wav -> 1.500000
public\voice_v11\s08.wav -> 1.852000
```

### 4.2 断言 max(durSec / 段可用时长) ≤ 1.0（脚本算，不是目测）

```powershell
node scripts\verify-voice-v11.mjs
```

它不读 `timing.json` 自报的时长，而是**对 8 个 wav 逐个重新 ffprobe**，再比对 JSON：
差 > 1ms 就报「实测 ≠ 自述」。退出码 0：

```
timing.json: public\voice_v11\timing.json
段数 8  段长 2.567s  推进 2.233s  起播余量 0.08s  可用窗 2.153s  总帧 546

 #  实测时长  JSON时长  JSON差   段长比  可用窗比  帧区间        ≤界   字  台词
 1    1.797     1.797 +  0.000   0.700     0.835     2~56     67  10  手工干，要好几个小时
 2    1.721     1.721 +  0.000   0.671     0.799    69~121   134  11  28 个器件，自己排开
 3    1.840     1.840 +  0.000   0.717     0.855   136~192   201  10  铺铜两层，先把地接通
 4    1.925     1.925 +  0.000   0.750     0.894   203~261   268  12  115 根线，自己走过去
 5    2.040     2.040 +  0.000   0.795     0.948   270~332   335  12  布线走完，DRC 零违规
 6    1.823     1.823 +  0.000   0.710     0.847   337~392   402   9  翻到底层，走线压铜
 7    1.500     1.500 +  0.000   0.584     0.697   404~449   469   8  断掉的线自己缝上
 8    1.852     1.852 +  0.000   0.722     0.860   471~527   546  13  410 秒，6 个制造文件

max(durSec/段长)      = 0.7948  （判据 <= 1.0）
max(durSec/可用窗)    = 0.9475  （判据 <= 1.0，最紧一句 #5「布线走完，DRC 零违规」）
最长句                = 「布线走完，DRC 零违规」2.040s（段长 2.567s，占 79.5%）
timing.json 自述      = maxRatioAvail 0.9474 / maxRatioSegment 0.7948

全部通过：8 句实测时长均 <= 段长与段推进，帧区间不越界
VERIFY EXIT=0
```

### 4.3 合成还能打包（不渲染）

```powershell
npx remotion compositions src/entry.js --config=remotion.config.v10.js
```

一次通过（exit 0，无需重试）。`PcbRealV11` 在列表里且时长就是 546 帧 / 18.20s：

```
PcbAuto       60      1080x1920      3480 (58.00 sec)
PcbReal       30      1080x1920      1470 (49.00 sec)
PcbRealV6     30      1080x1920      2641 (88.03 sec)
PcbRealV7     30      1080x1920       946 (31.53 sec)
PcbRealV9     30      1080x1920       946 (31.53 sec)
PcbRealV10    30      1080x1920      1149 (38.30 sec)
PcbRealV11    30      1080x1920       546 (18.20 sec)
EXIT=0
```

### 4.4 配音真的进了合成（只渲 111 帧，**没有渲染整片**）

```powershell
npx remotion render src/entry.js PcbRealV11 out\_probe\v11-audio-probe.mp4 --frames=0-110 --config=remotion.config.v10.js
ffprobe -show_entries stream=codec_type,codec_name,channels,sample_rate ...
```

```
index=1 codec_name=aac codec_type=audio sample_rate=48000 channels=2 duration=3.754667
```

分段音量（证明「该响的时候响、不该响的时候干净」）：

| 窗口 | mean_volume / LUFS | 说明 |
|---|---|---|
| 全片 0–3.7s | **-15.98 LUFS** | 目标 -16，配音主导 |
| 0.09–1.85s（第 1 句） | -15.80 LUFS | 有配音 |
| 1.90–2.30s（两句之间） | mean **-27.6 dB** / max -14.4 dB | 只剩 BGM（压到 0.5），**没有人声残留** |
| 2.32–4.02s（第 2 句） | -15.36 LUFS | 有配音 |

### 4.5 字幕静帧（4 张，`out\_probe\`）

`v11-still-f040.png`（第 1 句）、`f300.png`（第 5 句，最紧）、`f420.png`（第 7 句，
含新字「缝」）、`f500.png`（第 8 句，数字高亮 410 / 6）。
四张全部**无豆腐块、无折行**，字幕落在 1356–1488 的空白带内，与下面三行不重叠。

---

## 5. 失败 / 降级说明（4 件事，都是实测撞出来的）

### 5.1 首尾静音会让「每句时长」全线超标 → 精确裁静音（不加速）

edge-tts 每句自带 ≈0.20s 头静音 + ≈0.81s 尾静音，原样交付时 8 个文件是 2.51–3.07s，
**全部超过 2.233s 段窗**，比值顶到 1.3。

做法：`silencedetect=noise=-45dB:d=0.10` 量出真实语音起止（与 `tts_pcb.py` 同一组参数），
`atrim=start=B:end=F+0.03` 只切静音，一个语音采样都没动；尾部多留 30ms 是给 `afade` 留余地。
**语速 +8% 一个参数没改**，想更短只能改台词（第 3 句就是因此从「两层铺铜，先把地连通」
改成「铺铜两层，先把地接通」，实测 2.054s → 1.840s）。

`raw\*.mp3` 是裁剪前的原料，整文件 2.2–3.0s（含静音），**不能当「每句时长」用**；
交付口径只看 `s01..s08.wav`。

### 5.2 loudnorm 单遍在 1.5–2.1s 短句上会跑偏 → 改「两遍测量 + 补增益」

沿用 V6/V9 的 `loudnorm=I=-16:TP=-1.5:LRA=11`（参数**一字未改**）单遍处理后实测：
8 个文件 `input_i` 从 **-17.49 到 -23.03 LUFS**，5.5dB 的忽大忽小——连播时能听出来。

根因：linear 模式下「补到 -16 会让真峰越过 -1.5dBTP」时只能少给增益。
现在：① 两遍测量（把 `measured_*` 喂回去，`linear=true`）；② 剩下的缺口用
`volume=<残差dB>` + `alimiter(limit=0.841, level=false)` 补，迭代到差 ≤0.10dB。

结果：**8 句全部 -16.0±0.05 LUFS**。代价是 4 句里波峰最高的瞬态被限幅（最多约 4dB，
集中在句首爆破音上），换来的是整片人声一致——这个取舍写在 `tts_v11.py` 的注释里。

### 5.3 字体缺「缝」字 → 重跑 subset（否则就是豆腐块）

`sub-bold.ttf` / `sub-regular.ttf` 里**没有「缝」**（第 7 句台词 + manifest 标题「缝合补线」都要它），
渲染不报错、只是方框。处理：
1. `subset-fonts.py` 的扫描源加上 `public/v11/manifest.json` 与 `public/voice_v11/timing.json`
   （原先只扫 `src/**` 与 `public/v10/manifest.json`，V11 的两处文案真源都没扫到）；
2. 重跑 `python scripts/subset-fonts.py`（用 `F:\ANACONDA\1\python.exe`，DSH 的 python 没装 fontTools）→ `ok: 源字体覆盖的字一个没丢`；
3. `node scripts\gen-font-css.mjs` 重新生成 `src/fonts.css`；
4. 复检：`sub-bold.ttf: 缺字 无`，并渲染第 7 句静帧肉眼确认。

顺带修了自检的一个**长期假红**：以前是「所有扫到的字必须在 subset 里」，于是 `◻` / `✓`
（微软雅黑本来就没有，V6/V7/V9 拿它们当占位框与对勾，浏览器走 Segoe UI Symbol 回退，
渲染是正常的）把这条闸门一直打红。现在分开报：源字体没有 → 提示走回退；
**subset 丢了源字体有的字 → ERROR + 退出码 1**（闸门仍然能失败）。

⚠️ `src/fonts.css` 变了，`PcbRealV10` 的**源码一个字没改**、已发布的 v10 成片不受影响；
只是将来若重渲 V10，字体文件字节变了（字形集合是超集）。要回滚就把这两个 ttf 与 fonts.css 一起退。

### 5.4 BGM 从 1.0 压到 0.5（只改 V11）

BGM 原本按「没有配音」的场合挂 `volume={1}`（-19 LUFS 预混）。现在下面叠了 -16 LUFS 的人声，
不压就会被垫住，所以 V11 里改成 `volume={0.5}`（约 -6dB）。测下来两句之间的空档
mean -27.6dB —— 能听到垫底，不抢人声。`PcbRealV10.jsx` 的 BGM 音量**没动**。

---

## 6. 复现

```powershell
cd D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto\video
$env:PATH="C:\ffmpeg\bin;F:\ANACONDA\1\Scripts;E:\APP\nodejs24;$env:PATH"
$env:PYTHONIOENCODING='utf-8'

# 1) 生成 8 句配音 + timing.json（需联网；edge-tts 走微软 TTS，本机可用）
& 'C:\Users\UserX\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe' scripts\tts_v11.py
#    退出码 0 = 每句都在帧级段界内；非 0 会打印是哪一句、差几帧，此时**改短台词**再跑

# 2) 独立核对（重测时长 + 断言比值）
node scripts\verify-voice-v11.mjs

# 3) 能否打包
npx remotion compositions src/entry.js --config=remotion.config.v10.js
```

`tts_v11.py` 里自带三道同源闸门，任何一道不过就退出码 1，不会产出半成品时间轴：
台词句数 ≠ manifest 段数 / 段序不一致 / `(N-1)*(SEG-XFADE)+SEG ≠ 546`（说明 SEG/XFADE 与 jsx 分叉了）。

---

## 7. 给主 agent 的渲染提示

- 命令：`npx remotion render src/entry.js PcbRealV11 out\v11-voice-sub.mp4 --config=remotion.config.v10.js`
- 546 帧 / 18.2s，画质参数沿用 `index.jsx` 里 `PcbRealV11` 的 `defaultCodec=h264 / yuv420p`
- 已知本机 chrome 偶发 `Timed out ... connect to the browser`：按约定先
  `Get-Process | ? ProcessName -match 'chrome' | Stop-Process -Force` 再重试（本次 4 次调用全程没触发）
- 配音总时长 14.5s / 18.2s，片尾 15.71–17.57s 是最后一句，**末尾留 0.63s 静音收尾**，不要裁
