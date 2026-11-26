# pcb-auto 演示视频（Remotion）

用 Remotion 生成的竖屏短视频（1080×1920 / 60fps / 58s），主题「AI 全自动接管 PCB 设计」。
视频里所有数字都从 `pcb-auto` 的真实产物读取，不存在编造数据。

## 产物

| 文件 | 说明 |
| --- | --- |
| `out/ai-pcb-demo.mp4` | 正片，H.264，1080×1920，58s |
| `out/cover.png` | 封面图（从正片抽帧） |

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
$env:Path = "E:\APP\nodejs24;" + $env:Path

# 1) 重新抽取真实数据 -> src/data.json
node scripts/collect-data.mjs

# 2) 渲染（必须显式给 entry point；用系统 Chrome，比 Remotion 自带的 headless-shell 下载快很多）
#    注意：不要接 `| Select-Object -First N`，管道提前关闭会把渲染进程一起杀掉
node node_modules\@remotion\cli\remotion-cli.js render src\entry.js PcbAuto out\ai-pcb-demo.mp4 `
  --codec=h264 --browser-executable="C:\Users\UserX\AppData\Local\Google\Chrome\Application\chrome.exe" *> out\render.log

# 3) 去掉 Remotion 默认塞进来的空 AAC 音轨（可选，纯视觉视频不需要）
C:\ffmpeg\bin\ffmpeg.exe -y -i out\ai-pcb-demo.mp4 -c:v copy -an out\_tmp.mp4; Move-Item out\_tmp.mp4 out\ai-pcb-demo.mp4 -Force

# 4) 抽封面 + 验收帧
C:\ffmpeg\bin\ffmpeg.exe -y -i out\ai-pcb-demo.mp4 -ss 1.6 -frames:v 1 out\cover.png
C:\ffmpeg\bin\ffmpeg.exe -y -i out\ai-pcb-demo.mp4 -vf "fps=1/5" -frames:v 4 out\acc-%02d.png
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


