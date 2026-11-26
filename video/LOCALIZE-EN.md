# 英文版（本地化）做法 —— 先把目录和音源找对

> 起因：2026-11-26 做 `out/ai-pcb-v6-share.mp4`（88s 真·录屏版）的全英文版，前两版都栽在「BGM」上。
> 这份文件只记**结论 + 命令**，不重复 README 里的分镜/字体说明。

## 1. 目录：这类视频的源在这里，不要在 `F:\projects` 里瞎找

```
pcb-auto\video\                        ← Remotion 工程（正主）
  src\PcbRealV6.jsx  V7  V9            ← 四套合成之一；V6 = 88s 真·录屏版
  src\data\timeline_pcb.json  timeline_v7/v9.json   ← 逐句时间轴 + 文案
  public\bgm_pcb_v6.wav voice_pcb.wav voice_v7/v9.wav voice_pcb\*.wav
  out\ai-pcb-v6-share.mp4              ← 88s 成片（正是被本地化的那支）
  mix-and-ship.ps1                     ← ★ BGM 配方与飞书投递的唯一权威
```

找法（比 grep 中文标题可靠，中文 grep 在 `F:\projects` 全是空）：

```powershell
Get-ChildItem D:\,F:\ -Recurse -File -Filter "ai-pcb*" -ErrorAction SilentlyContinue
```

`F:\projects\remotion-tiktok` 是**另一条片**（RustSeek，79s）的工程，BGM 曲目不同，别串。

## 2. BGM：只能取「干净音源」，绝不能拿中文成片的人声分离当 BGM

中文成片音轨 = 中文配音 + BGM 混在一起。把它 demucs 分离 / 软掩蔽出来的结果当英文版 BGM，
等于**把中文人声嵌进英文版**（2026-11-26 就错在这里，被用户直接指出）。

唯一正确的来源是 `mix-and-ship.ps1` 头部注释里的 **V6 配方**：

```
源： F:\projects\remotion-tiktok\build\douyin_audio.m4a   (130.166s, 44.1k 2ch)
链： atrim=0:<视频时长> , asetpts=N/SR/TB , aresample=48000
     highpass=f=70 , equalizer=f=900:g=+7 , equalizer=f=2400:g=+6
     equalizer=f=4200:g=+4 , equalizer=f=120:g=-1
     afade=t=in:d=1.5 , afade=t=out:st=<时长-2.5>:d=2.5   ← st 必须锚片尾
     loudnorm=I=-19:TP=-1.5:LRA=8 , volume=0.78
```

- `afade=t=out` 不给 `st` 会从 0 秒开始淡出 → 88% 时长静音（成片 RMS −32.7dB、AAC 掉到 25kbps）。
- 只认分段 RMS，不要只信整体 LUFS：EBU R128 有 relative gate，中途静音的片子照样凑到 −21 LUFS。
- 实测 V6 链跑完 BGM ≈ **−21.4 LUFS**（与注释里的 −21.15 吻合），可当回归基准。

## 3. 英文配音

- `edge-tts 7.3.1`（`F:\ANACONDA\1\python.exe` 里有），`en-US-AndrewNeural --rate=-4%` 被用户认可为「播音腔」。
- 逐句生成 → 按原片每句的起止窗摆放；**不要整轨 concat**（会丢句间 gap）。超出窗口用 `atempo≤1.18`，别再往上压。
- 同一句被拆成两个字幕段（遮罩需要）时只念一次，否则会重复念。

## 4. 画面：优先重渲染，其次遮罩

- 有源工程 → 改 `src/*.jsx` 与 `src/data/timeline_*.json` 里的字符串重渲染，画面最干净；
  改到中文字符集变化时按 README 重跑 `subset-fonts.py` + `gen-font-css.mjs`。
- 只有成片（本次情况）→ PIL 逐段遮罩重绘：矩形外沿采样上下两行中位色做**垂直渐变填充 + 16px 羽化**，
  比平铺纯色几乎看不出补丁；再用 drawtext 画英文字。REC 徽章这类压在动态画面上的元素，
  用**不透明药丸整体盖住**，不要用取色填充（会露方块）。

## 5. 验收（每次都要跑，别只看一眼）

```powershell
# a) 成片重新 ASR：英文逐句对得上原片节奏
F:\cache\venvs\stt-gpu2\Scripts\python.exe asr_en.py
# b) 强制 language=zh 再跑一遍：只转出英文谐音 = 无中文残留（有真中文就会转出中文词）
# c) 分段 RMS：15~30% / 40~55% / 75~90% 三段都要有声音，且相差 <12dB
```

工具链事实（本机）：`faster-whisper 1.2.1` 在 `F:\cache\venvs\stt-gpu2`（不用 torch），
模型 `F:\cache\models\faster-whisper-large-v3-turbo`；`F:\ANACONDA\1` 与 `F:\cache\venvs\whisper`
的 torch 坏了（`c10.dll` WinError 1114），要 torch 就 `uv venv` + `uv pip install torch torchaudio`
（2.15.0+cpu 可用），demucs 装在 `F:\cache\venvs\sep`（CPU 上 88s 音频约 6min）。

## 6. 飞书投递

- `msg_type=media` 必须带 `image_key`（先 `POST /im/v1/images?image_type=message`），否则客户端显示「该消息类型暂不支持」。
- 单文件上限约 **43.6MiB**，超了必回 `code 234006`。
- 发错了用 `DELETE /open-apis/im/v1/messages/<message_id>` 撤回（bot 自己的消息可撤），别留两版让人猜。
