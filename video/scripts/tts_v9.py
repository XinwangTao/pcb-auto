"""为 PcbRealV9（真实画布帧版·整夜版）生成 edge-tts 配音 + 时间轴。

与 tts_v7.py 的唯一差别：输出文件名换成 voice_v9 / timeline_v9，台词改由
curate-v9.mjs 写进 manifest 的 `sub`（讲整夜真实发生的 11 步，含失败）。

[V9] 段步长只有 2.833s，比 V7 的 3.033s 更短 —— 台词上限相应收紧：
      实测 zh-CN-YunxiNeural @ +8% 约 5 字/秒，段窗 (SEG-XF)/30-0.15 ≈ 2.68s
      ⇒ 一句话 ≤13 汉字/数字组。超窗这里会报警并给出是哪一句。

以下是 V7 原始说明（链路一条没改）：

为 PcbRealV7（真实画布帧版）生成 edge-tts 配音 + 时间轴。

与 tts_pcb.py（V6，25 句 / 88s）的关系
------------------------------------
做法完全照搬已验证的 V6 链（该链产出 rust-seek-v6，用户验收「已达到出品标准」），
但 V7 只有 8 段、总长约 31.6s，所以台词改成「一段一句」，锚定到每段起点。

V6 那三个坑原样继承，一条都不能改：
1. 整轨用 adelay 按绝对位置摆放，**不能用 concat**（concat 不插句间 gap，
   整轨比时间轴短，越往后语音越超前于字幕）。
2. 不裁首尾静音，用 silencedetect 测真实语音起止，字幕只显示真正出声的区间。
3. 每句单独合成立即测时长，不估算。

V7 独有的约束
------------
段数与段长**不手抄**：从这里读 public/v7/manifest.json 得到 N，再用 src/PcbRealV7.jsx
里那套一模一样的公式（clamp(34/N, 3.2, 4.5) 帧/秒 * 30）推导 SEG。两边各写一份
常量必然分叉——N 从 9 改 8 时 jsx 算 128 帧、本文件还留着 113 帧，字幕会整体滑动。

一句台词的「理想窗」= (SEG-XF)/30 秒。台词控制在 ≤16 汉字（与 V7 字幕同源，
念的就是屏幕上那行字，天然同步）。若某句实测超窗，脚本会报警并给位置，
但**不会**偷偷压语速 —— 语速是出品标准的一部分。

输出
----
- public/voice_v9.wav       整轨配音（48k 立体声，-16 LUFS，与 V6 同标准）
- src/data/timeline_v9.json 每句 start/end/segment，供后续对轴核对
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # video/
PUBLIC = ROOT / "public"
OUT_DIR = PUBLIC / "voice_v9"
DATA = ROOT / "src" / "data"

VOICE = "zh-CN-YunxiNeural"
RATE = "+8%"
PITCH = "+0Hz"
TARGET_LUFS = -16.0

FPS = 30

# 【唯一真源】段数与段长必须与 src/PcbRealV7.jsx 完全一致，否则字幕从第 2 段就开始
# 错位、到末段差出一整段。之前这里把 SEG_FRAMES 写死 113（那是 N=9 时的
# round(clamp(34/9,3.2,4.5)*30)=113）；N 改成 8 之后 jsx 会算出
# round(clamp(34/8,3.2,4.5)*30)=128，两边当场分叉。
# 所以不再手抄常量：读 manifest 拿到 N，再用 jsx 里那套一模一样的公式与上下限推导。
def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def _jsround(v: float) -> int:
    """复刻 JS 的 Math.round：.5 一律进位。

    Python 内置 round() 是银行家舍入（round(10.5)==10），JS 是 round half up
    （Math.round(10.5)==11）。这里差 1 帧就会让 XF 变成 10、步长变成 3.933s，
    与 jsx 的 11 帧/3.900s 分叉，越到后面字幕越超前。
    """
    return int(v + 0.5) if v >= 0 else -int(-v + 0.5)


_MANIFEST = PUBLIC / "v7" / "manifest.json"
_items = json.loads(_MANIFEST.read_text(encoding="utf-8"))
if isinstance(_items, dict):
    _items = _items.get("items") or []
N_SEG = len(_items)
if N_SEG <= 0:
    raise SystemExit(f"manifest 为空，无法推导段数：{_MANIFEST}")

# 与 PcbRealV7.jsx L32-35 逐字对齐
XFADE_S = 0.35
SEG_TARGET_S = 34
SEG_MIN_S = 3.2
SEG_MAX_S = 4.5
XF_FRAMES = max(2, _jsround(XFADE_S * FPS))                             # 11
SEG_FRAMES = _jsround(_clamp(SEG_TARGET_S / N_SEG, SEG_MIN_S, SEG_MAX_S) * FPS)
TOTAL_FRAMES = (N_SEG - 1) * (SEG_FRAMES - XF_FRAMES) + SEG_FRAMES
TOTAL_S = TOTAL_FRAMES / FPS

# 台词 = V7 屏幕上那行字幕（V7-SPEC §3）。念字幕而不是另写一套，
# 是因为口播与字幕不同步时观众立刻能察觉，而这是唯一不会错位的做法。
#
# 【不许再在这里手抄一份 LINES/TAGS】curate-v7.mjs 写 manifest 时已经把每段的
# `tag`（叙事角色）和 `sub`（屏幕上那行字）一起写进去了，那就是唯一真源。
# 手抄的第二份一旦与 manifest 段数不同，本文件 raise SystemExit —— 看着安全，
# 实则是"改了段数就整条产线停摆"；更糟的是一旦有人顺手改了这里的句子，
# 口播就开始念屏幕上没有的话，而检查是查不出来的（两边都"合法"）。
# 段数 N 本来就从 manifest 来（见上），台词与标签也必须同源。
LINES: list[str] = []
TAGS: list[str] = []
for _i, _it in enumerate(_items, 1):
    _sub = str((_it or {}).get("sub") or "").strip()
    _tag = str((_it or {}).get("tag") or "").strip()
    if not _sub:
        raise SystemExit(f"manifest 第 {_i} 段缺 sub（屏幕上那行字幕），无法配音：{_MANIFEST}")
    if not _tag:
        raise SystemExit(f"manifest 第 {_i} 段缺 tag（叙事角色），无法对轴：{_MANIFEST}")
    LINES.append(_sub)
    TAGS.append(_tag)

# 台词逐句锚定到段起点，句数必须与段数一致；不一致就别往下跑（会静默错位）。
if len(LINES) != N_SEG:
    raise SystemExit(f"LINES {len(LINES)} 句 ≠ manifest {N_SEG} 段")
if len(TAGS) != N_SEG:
    raise SystemExit(f"TAGS {len(TAGS)} 个 ≠ manifest {N_SEG} 段")

SEG_STEP_S = (SEG_FRAMES - XF_FRAMES) / FPS    # N=8 时为 3.900s
LEAD_S = 0.15                                   # 段起点后 0.15s 出声，别贴着切换点
MIN_GAP_S = 0.12                                # 两句之间至少留 0.12s，避免粘连


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace")


def probe_duration(path: Path) -> float:
    r = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)])
    try:
        return float((r.stdout or "0").strip())
    except ValueError:
        return 0.0


def synth(index: int, text: str) -> Path:
    raw = OUT_DIR / f"raw_{index:02d}.mp3"
    r = run(["edge-tts", "--voice", VOICE, "--rate", RATE, "--pitch", PITCH,
             "--text", text, "--write-media", str(raw)])
    if not raw.is_file() or raw.stat().st_size < 1000:
        raise RuntimeError(f"第 {index} 句合成失败：{r.stderr[:300]}")
    return raw


def speech_bounds(wav: Path) -> tuple[float, float]:
    """测真实语音起止（不裁音频，只测位置）。"""
    duration = probe_duration(wav)
    if duration <= 0:
        return 0.0, 0.0
    r = run(["ffmpeg", "-i", str(wav), "-af",
             "silencedetect=noise=-45dB:d=0.10", "-f", "null", "-"])
    starts = [float(m.group(1)) for m in re.finditer(r"silence_start:\s*([\d.]+)", r.stderr)]
    ends = [float(m.group(1)) for m in re.finditer(r"silence_end:\s*([\d.]+)", r.stderr)]
    begin = ends[0] if ends and ends[0] < duration - 0.1 else 0.0
    finish = starts[-1] if starts and starts[-1] > 0.05 else duration
    if finish <= begin:
        begin, finish = 0.0, duration
    return round(begin, 3), round(min(finish, duration), 3)


def to_wav(src: Path, dst: Path) -> None:
    run(["ffmpeg", "-y", "-i", str(src),
         "-af", f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11",
         "-ar", "48000", "-ac", "2", str(dst)])


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    print(f"语音 {VOICE}  语速 {RATE}  句数 {len(LINES)}  "
          f"目标总长 {TOTAL_S:.3f}s  段步长 {SEG_STEP_S:.3f}s")

    timeline = []
    prev_end = -1e9
    cursor = 0.0
    warnings = []
    for i, text in enumerate(LINES):
        idx = i + 1
        raw = synth(idx, text)
        final = OUT_DIR / f"s{idx:02d}.wav"
        to_wav(raw, final)
        slot_dur = probe_duration(final)
        begin, finish = speech_bounds(final)
        speech = finish - begin

        # 锚定到本段起点；若会与上一句重叠，则后推到上一句结束 + MIN_GAP
        target = i * SEG_STEP_S + LEAD_S
        start = max(target, prev_end + MIN_GAP_S)
        if start - target > 0.001:
            warnings.append(f"第 {idx} 句被后推 {start - target:.3f}s（前句太长）")
        end = start + speech
        if speech > SEG_STEP_S - LEAD_S:
            warnings.append(
                f"第 {idx} 句语音 {speech:.2f}s 超过段窗 {SEG_STEP_S - LEAD_S:.2f}s —— "
                f"念的是「{text}」（{len(text)} 字），需缩短或改语速")
        prev_end = end
        timeline.append({
            "i": idx, "tag": TAGS[i], "text": text,
            "segment_start": round(i * SEG_STEP_S, 3),
            "start": round(start, 3), "end": round(end, 3),
            "speech": round(speech, 3), "slot": round(cursor, 3),
            "slot_duration": round(slot_dur, 3),
        })
        cursor += slot_dur + MIN_GAP_S
        print(f"  {idx:02d} {TAGS[i]:14s} 段起 {i * SEG_STEP_S:6.2f} → 出声 "
              f"{start:6.2f}~{end:6.2f} ({speech:.2f}s)  {text}")

    if prev_end > TOTAL_S - 0.2:
        warnings.append(f"整轨最后一句结束于 {prev_end:.2f}s，已顶到片尾 {TOTAL_S:.2f}s")

    # 按 slot 绝对摆放；总长严格等于视频长度，不让音频比视频长
    inputs: list[str] = []
    filters: list[str] = []
    for item in timeline:
        wav = OUT_DIR / ("s%02d.wav" % item["i"])
        inputs.extend(["-i", str(wav)])
        delay_ms = int(round(item["start"] * 1000))
        filters.append(f"[{item['i'] - 1}:a]adelay={delay_ms}|{delay_ms}[a{item['i']}]")
    mix = "".join(f"[a{item['i']}]" for item in timeline)
    filters.append(f"{mix}amix=inputs={len(timeline)}:normalize=0:dropout_transition=0[mixed]")
    full = PUBLIC / "voice_v9.wav"
    r = run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(filters),
             "-map", "[mixed]", "-ar", "48000", "-ac", "2",
             "-t", f"{TOTAL_S:.3f}", str(full)])
    if not full.is_file() or full.stat().st_size < 10000:
        print("整轨合成失败：", r.stderr[-600:])
        return 1

    (DATA / "timeline_v9.json").write_text(
        json.dumps({"voice": VOICE, "rate": RATE, "total": round(TOTAL_S, 3),
                    "frames": TOTAL_FRAMES, "seglen": SEG_STEP_S,
                    "lines": timeline, "warnings": warnings},
                   ensure_ascii=False, indent=2), encoding="utf-8")

    real = probe_duration(full)
    print(f"\n整轨 {full} ({full.stat().st_size // 1024} KB)  实测 {real:.3f}s / 目标 {TOTAL_S:.3f}s")
    if warnings:
        print(f"\n{len(warnings)} 条告警：")
        for w in warnings:
            print("  ! " + w)
    else:
        print("\n无告警：每句都在段窗内，且无重叠")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
