"""为「AI 全自动设计 PCB」宣传片生成 edge-tts 神经语音配音 + 精确时间轴。

严格照搬 `F:\\projects\\remotion-tiktok\\scripts\\tts_v2.py` 的已验证做法
（该脚本产出 rust-seek-v6 成片，用户验收「非常非常好，已达到出品标准」）。

## 三个不能踩的坑（都是实测出来的）

1. **整轨必须用 `adelay` 按绝对位置摆放，不能 `concat`**
   concat 首尾相接不会插入句间 gap，整轨会比时间轴短（实测 79.34 → 73.27s，差 6s），
   越往后字幕越滞后，观感是「语音比字幕快」。

2. **不要裁首尾静音，让时间轴适配音频**
   每句 wav 自带 0.18~0.28s 头部静音 + 0.81~0.88s 尾部静音。
   `silenceremove` 阈值浅了会连换气一起裁（79s→43s，语速快得听不清），
   阈值深了裁不干净。正确做法是用 `silencedetect` 测出真实语音起止，
   字幕只显示在真正出声的区间。

3. **每句单独合成立即测时长**，不估算 —— 字幕对齐完全依赖这个。

## 输出

- `public/voice_pcb.wav`：整轨配音（48k 立体声，-16 LUFS）
- `src/data/timeline_pcb.json`：含每句 start/end/slot 与分组 scene 标记
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # video/
PUBLIC = ROOT / "public"
OUT_DIR = PUBLIC / "voice_pcb"
DATA = ROOT / "src" / "data"

VOICE = "zh-CN-YunxiNeural"   # 阳光年轻，科技口播
RATE = "+8%"
PITCH = "+0Hz"
GAP_MS = 260                  # 句间呼吸
TARGET_LUFS = -16.0

# (scene 键, [台词...]) —— scene 决定这句配哪一段录屏画面。
# 前两组没有录屏，走「标题卡/痛点卡」画面。
GROUPS: list[tuple[str, list[str]]] = [
    ("title", [
        "一个人，一句需求",
        "半小时后，它变成了一块真的电路板",
    ]),
    ("hook", [
        "这不是剪辑出来的效果",
        "全程没有一个鼠标是我点的",
    ]),
    ("sch", [
        "第一步，原理图",
        "告诉它要什么功能，器件自己选，引脚自己连",
        "电源、地、信号，一个网络都不会漏",
    ]),
    ("pcbimp", [
        "第二步，同步到 PCB",
        "原理图怎么改，板子就怎么变",
        "不用手动对齐任何东西",
    ]),
    ("layout", [
        "第三步，自动布局",
        "器件按电气关系自己找位置",
        "然后铺地，两层板都铺满",
    ]),
    ("route", [
        "第四步，自动布线",
        "信号线、电源线、过孔，全部自己走",
        "原来这一步最费眼睛，现在它几秒钟就干完",
    ]),
    ("drc", [
        "第五步，查间距",
        "间距不够的自己退回去重走，绝不糊弄",
        "规则没过，它不会假装通过",
    ]),
    ("final", [
        "最后，设计规则检查零违规",
        "制造文件、BOM、坐标文件，一次导出",
        "你以为这就完了",
    ]),
    ("end", [
        "它还自己写了打样清单和装配说明",
        "从一句想法到一块能打样的板子，中间零人工干预",
        "这套流水线，现在就在跑",
    ]),
]

# 摊平成 LINES，同时记录每句属于哪个 scene
LINES: list[str] = []
SCENES: list[str] = []
for scene, texts in GROUPS:
    for t in texts:
        LINES.append(t)
        SCENES.append(scene)


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
    """转 48k 立体声 + 单句响度归一化，不裁任何东西。"""
    run(["ffmpeg", "-y", "-i", str(src),
         "-af", f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11",
         "-ar", "48000", "-ac", "2", str(dst)])


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)
    print(f"语音 {VOICE}  语速 {RATE}  句数 {len(LINES)}")

    timeline = []
    cursor = 0.0
    for index, text in enumerate(LINES, start=1):
        raw = synth(index, text)
        final = OUT_DIR / f"s{index:02d}.wav"
        to_wav(raw, final)
        total_dur = probe_duration(final)
        begin, finish = speech_bounds(final)
        timeline.append({
            "i": index,
            "text": text,
            "scene": SCENES[index - 1],
            "start": round(cursor + begin, 3),
            "end": round(cursor + finish, 3),
            "duration": round(finish - begin, 3),
            "slot": round(cursor, 3),
            "slot_duration": round(total_dur, 3),
        })
        cursor += total_dur + GAP_MS / 1000.0
        print(f"  {index:02d} 出声 {finish - begin:5.2f}s 槽 {total_dur:5.2f}s  {text}")

    total = round(cursor - GAP_MS / 1000.0 + 0.35, 3)

    # 按 slot 绝对摆放，整轨长度严格等于时间轴
    inputs: list[str] = []
    filters: list[str] = []
    for item in timeline:
        wav = OUT_DIR / ("s%02d.wav" % item["i"])
        inputs.extend(["-i", str(wav)])
        delay_ms = int(round(item["slot"] * 1000))
        filters.append(f"[{item['i'] - 1}:a]adelay={delay_ms}|{delay_ms}[a{item['i']}]")
    mix = "".join(f"[a{item['i']}]" for item in timeline)
    filters.append(f"{mix}amix=inputs={len(timeline)}:normalize=0:dropout_transition=0[mixed]")
    full = PUBLIC / "voice_pcb.wav"
    run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(filters),
         "-map", "[mixed]", "-ar", "48000", "-ac", "2", "-t", str(total), str(full)])

    # 每个 scene 的时间范围，供 Remotion 切画面
    scene_ranges: dict[str, dict] = {}
    for item in timeline:
        s = item["scene"]
        if s not in scene_ranges:
            scene_ranges[s] = {"from": item["start"], "to": item["end"]}
        else:
            scene_ranges[s]["to"] = item["end"]

    (DATA / "timeline_pcb.json").write_text(
        json.dumps({"voice": VOICE, "rate": RATE, "total": total,
                    "lines": timeline, "scenes": scene_ranges},
                   ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n总时长 {total}s")
    print(f"整轨 {full} ({full.stat().st_size // 1024} KB)")
    print("scene 区间：")
    for k, v in scene_ranges.items():
        print(f"  {k:8s} {v['from']:6.3f} → {v['to']:6.3f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
