# pcb-auto 演示视频（Remotion）

竖屏短视频，主题「AI 全自动接管 PCB 设计」。视频里所有数字都从 `pcb-auto` 的真实产物读取。

> 要做**英文版**（英文字幕 + 英文配音、BGM 用原曲）先看 [LOCALIZE-EN.md](LOCALIZE-EN.md)：
> 音源只能取 `mix-and-ship.ps1` 里的 V6 配方，**不要**拿中文成片音轨分离出来的东西当 BGM。

## 四套合成，素材来源各不相同 —— 别搞混

| 合成 | 素材 | 规格 | 是不是「录屏」 |
| --- | --- | --- | --- |
| `PcbRealV9` | `public/v7/real/v7r-*.png`（11 张，EDA 自渲染画布帧） | 31.6s / 30fps | **不是** |
| `PcbRealV7` | 同上（与 V9 共用同一个 `public/v7/manifest.json`） | 31s / 30fps | **不是** |
| `PcbRealV6` | `public/real/*.mp4`（6 段 gdigrab 桌面录像） | 88s / 30fps | **是** |
| `PcbAuto` | 静态数据卡（`src/data.json`） | 58s / 60fps | 不适用，纯图表 |

**正片是 `out/v9-074907.mp4`**（1080×1920 / 30fps / 31.6s / H.264 + AAC），由 `PcbRealV9` 渲染。

### 正片的素材到底是什么（这一点我错过一次，所以写细）

正片**不是录屏**。它的 11 段来自：

```
out/frames/<批次>/<尝试>/<序号>-<tag>.png   ← 流水线在里程碑调
                                            eda.dmt_EditorControl.getCurrentRenderedAreaImage()
                                            让 EDA 自己渲染画布并落盘 PNG
        ↓ curate-v9.mjs 挑帧 + 写 manifest
video/public/v7/real/v7r-01.png … v7r-11.png  ← 受跟踪，clone 下来就有
```

**好处是可回溯**：`public/v7/manifest.json` 里每段都记着 `src`（批次/尝试/帧文件名），
例如 `055041/1-smart-fit/0000-sch-wired.png`，能一路对回 `out/frames/` 里那张原图。
11 段跨 3 块板（`055041` ×9、`053328` ×1、`045629` ×1），台词逐句由该批 `_run.json` 背书。

**代价是它只记里程碑，不记操作过程** —— 所以它撑不起「录屏」这个词。这是改口的真实原因，
不是措辞微调。

### 真·录屏素材在另一处

`public/real/` 那 6 段是 gdigrab 录的**真实桌面**，屏幕上是嘉立创 EDA 完整窗口
（图层面板、底部状态栏、mil 标尺都能看到），画面角标就写着 `REC 真实录屏`。供 `PcbRealV6` 用：

```
public/real/01_sch.mp4      原理图连线
public/real/02_pcbimp.mp4   导入 PCB
public/real/03_layout.mp4   自动布局
public/real/04_pour.mp4     覆铜
public/real/05_route.mp4    自动布线
public/real/06_final.mp4    收尾
```

**一句话分清**：V6 = 录屏（88s，早期版本）；V7/V9 = 画布帧（31s，当前正片）。

下面 §真实数据来源 / §中文字体 / §转场 记的是 `PcbAuto` 那一套的踩坑，
对 `PcbRealV6` / `V7` / `V9` 同样适用（同一套字体内联、同一套硬切）。

## 产物

| 文件 | 说明 |
| --- | --- |
| `out/v9-074907.mp4` | **正片**（`PcbRealV9`，EDA 自渲染画布帧），H.264，1080×1920，31.6s |
| `out/ai-pcb-v6-share.mp4` | 早期真·录屏版（`PcbRealV6`），1080×1920，88s —— 「录屏」只对它成立 |
| `out/ai-pcb-demo.mp4` | 更早的 58s 版（`PcbAuto` 静态数据卡），保留对比用 |
| `out/cover.png` | 封面图（从正片抽帧） |

`out/` 整个目录是 gitignore 的 —— 成片走 [Releases](https://github.com/XinwangTao/pcb-auto/releases) 下载。

### 关于「clone 下来自己重渲」

图像素材都受跟踪（`public/v7/real/*.png` 11 张 + `public/real/*.mp4` 6 段共 3.9 MB），
但**配音不在库里**：`voice_v9.wav`、`voice_pcb.wav`、`bgm_pcb_v6.wav` 都没入库。
所以直接 `render` 会因为找不到 `staticFile('voice_v9.wav')` 失败。

要重渲得二选一：自备配音轨，或者把对应 `<Audio>` 那行注释掉。
本文件以前写的是「仓库里只放可重新渲染的素材」—— 那句话是没验就写的，改成现在这样。

## 真实数据来源

`scripts/collect-data.mjs` 只读地读取：

- `../out/SHT30_LDO_Module-20261125-010254/` —— 6 个真实产物文件，文件大小直接 `fs.statSync` 读磁盘
- `../logs/SHT30_LDO_Module-20261125-010254.json` —— `value.log` 里的 16 条 `PHASE` 累计时间戳、`elapsedMs`、`drcPassed`、`schDrcErrors`、`mismatchCount`、`copperPours`、`snappedLines`
- `../designs/d3-sht30-ldo.json` —— 想法原文、9 个器件、21 条连接

**为什么钉住一个 run**：这台机器上的流水线在持续产出新 run（本次工作期间就多了 3 个），
glob「最新」会让视频数字在两次渲染之间漂移，不可复现。因此脚本里 `PINNED_RUN` 显式钉住
一个 DRC 全过、`drcDetailCount=0` 的 run；把它改成 `''` 就回退到「最新」。

`PHASE` 记录的是**累计**毫秒，脚本做差分才得到单阶段耗时，所以
`resolveParts`/`drc` 这类相邻时间戳相同的阶段显示为 `—`（真实为 0 耗时）。

## 素材

`public/board/hi_page3.png` 是从真实 `Board.pdf` 第 4 页（索引 3）用 PyMuPDF 以 1600dpi
渲染出来的已布线铜层图，用作开场/收尾的暗底。PDF 页本身是矢量图元，不含位图，
所以必须"渲染"而不是"提取图片"。

## 中文字体（踩过两个坑，记在这里）

不显式加载字体，中文会渲染成方框。但下面两种"看起来对"的做法都会挂：

| 做法 | 结果 |
| --- | --- |
| 只写 `font-family: 'Microsoft YaHei'` | 依赖 Chromium 命中系统字体，不可靠 |
| `staticFile()` + `new FontFace().load()` + 模块层 `delayRender()` | Remotion 并发多 page 渲染时部分 page 的字体请求挂住，**3480 帧跑到 442 帧就 `delayRender` 超时崩** |

最终方案：字体**内联成 base64 @font-face CSS**，由 CSS 解析器同步建好，不依赖网络或静态服务，
因此不需要任何 `delayRender` / 门控（门控还有另一个坑：用 React state 做"加载完才渲染"，
首帧会在 state 生效前被截走，截图是占位画面）。

完整字体 19MB/16MB 也太慢，先裁到实际用字（453 字 → 约 80KB）：

```powershell
# 1) 从 Windows 字体集合抽出单字体（msyh.ttc 里 index 0 = Microsoft YaHei）
python -c "from fontTools.ttLib import TTCollection; TTCollection(r'C:\Windows\Fonts\msyh.ttc').fonts[0].save('public/fonts/msyh-regular.ttf')"
# 2) 裁子集（自带缺字自检，改文案后必须重跑）
python scripts/subset-fonts.py
# 3) TTF -> base64 CSS
node scripts/gen-font-css.mjs
```

`scripts/subset-fonts.py` 会扫 `src/` 下所有文案收集字符，缺字直接 `exit 1`。
**改了任何中文文案都要重跑 2) 和 3)**，否则新字会变成方框。

## 复现

```powershell
# 先把 node 放进 PATH（node --version 能跑就说明已经有了）
$env:Path = "C:\Program Files\nodejs;" + $env:Path

# 1) 重新抽取真实数据 -> src/data.json
#    PINNED_RUN 钉住的那次 run 很可能已经被 cleanup.ps1 清理掉了
#    （out/ 只保留最新 40 个 + 每个设计名最新 1 个）。这时脚本**退 2**并列出还能用的 run，
#    不会静默换成「最新」—— 换了 run，视频里每个数字就不再对得上注释里钉的那一次。
#    自己指定一次：VIDEO_RUN=<run 目录名> node scripts/collect-data.mjs
node scripts/collect-data.mjs

# 2) 渲染（必须显式给 entry point；用系统 Chrome，比 Remotion 自带的 headless-shell 下载快很多）
#    注意：不要接 `| Select-Object -First N`，管道提前关闭会把渲染进程一起杀掉
node node_modules\@remotion\cli\remotion-cli.js render src\entry.js PcbAuto out\ai-pcb-demo.mp4 `
  --codec=h264 --browser-executable="C:\Users\UserX\AppData\Local\Google\Chrome\Application\chrome.exe" *> out\render.log

# 3) 去掉 Remotion 默认塞进来的空 AAC 音轨（可选，纯视觉视频不需要）
ffmpeg -y -i out\ai-pcb-demo.mp4 -c:v copy -an out\_tmp.mp4; Move-Item out\_tmp.mp4 out\ai-pcb-demo.mp4 -Force

# 4) 抽封面 + 验收帧
ffmpeg -y -i out\ai-pcb-demo.mp4 -ss 1.6 -frames:v 1 out\cover.png
ffmpeg -y -i out\ai-pcb-demo.mp4 -vf "fps=1/5" -frames:v 4 out\acc-%02d.png
```

## 竖屏安全区

短视频平台上下各有 UI 遮挡。所有分镜统一走 `SAFE`（上 150 / 下 220），并用 `flex:1`
让内容撑满安全区 —— 否则容易出现「上半屏有字、下半屏一片黑」。
数字大字用雅黑而非 Consolas：Consolas 的 `0` 带斜杠，`0 违规` 会被看成「Ø」。

## 结构

- `src/data.json` —— 抽取后的真实数据（由脚本生成，勿手改）
- `src/fonts.css` —— base64 内联 @font-face（由脚本生成，勿手改）
- `src/theme.js` —— 分辨率/帧率/时长
- `src/ui.jsx` —— 配色、背景网格、Chip、Divider
- `src/scenes.jsx` —— 6 个分镜
- `src/Root.jsx` —— 时间轴拼接（硬切 + 前 6 帧缩放推入）
- `src/entry.js` —— `registerRoot` + 引入字体/全局 CSS
- `scripts/collect-data.mjs` —— 真实数据抽取（只读 pcb-auto，不写）
- `scripts/subset-fonts.py` —— 字体裁子集 + 缺字自检
- `scripts/gen-font-css.mjs` —— TTF → base64 @font-face

## 转场：必须用硬切（踩过的坑）

时间轴最初用**透明度交叉淡变**（上一场景淡出到 0、下一场景从 0 淡入），实测两个可见缺陷：

| 现象 | 根因 |
| --- | --- |
| 46s 处出现**纯黑帧** | 淡出尾端与淡入首端都≈0，两层叠加仍近黑 |
| 切换瞬间**标题叠字** | 改成"下层不淡出、上层淡入"后旧场景仍完整可见，`05·质量证明` 压在产物页副标题上 |

最终方案：**硬切**（每个 `Sequence` 全不透明）+ 每场景前 6 帧 `scale 1.035→1`。

硬切又暴露第三个坑：**场景内部入场动画从 `opacity: 0` 起步**，`rise()` 弹簧要 20–26 帧才到位，
切点后头几帧几乎空白，观感同样是闪黑（抽帧仅 42KB）。
修法：`rise()` 与行内 `opacity: p` 全部改为 **`0.35 + 0.65 * p`** 基线，上浮距离减半 → 46.01s 抽帧 42KB→320KB。

**验收关键**：在每个切点**前后各抽 1 帧**（4.99/5.01、12.99/13.01、32.99/33.01、45.99/46.01、53.99/54.01）逐张目视。
只看均匀间隔的 `fps=1/5` 会**漏掉**这类切点黑屏。


