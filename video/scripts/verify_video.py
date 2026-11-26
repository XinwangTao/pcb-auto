"""从成片音频验证字幕对齐 + BGM 可闻性（规范 §3 / §7 核心验收）。

## 为什么不能用 silencedetect 验证混音

第一版对成片做 `silencedetect`，结果整条音轨「没有静音」——
因为 BGM 全程铺底，只识别出 1 段，25 句全被误判成错位 84 秒。
那是验证脚本的 bug，不是成片的 bug。

## 正确做法：检测「语音起始的能量突变」

字幕对齐的本质是：**在字幕出现的那一刻，人声应该正好开始**。
所以对每句取两个窗口做电平对比：

    前置窗 [start-0.20, start-0.03]   ← 此时应当还没出声（只剩 BGM）
    起始窗 [start+0.03, start+0.25]   ← 此时应当已出声（人声 + BGM）

人声比 BGM 高 3dB 以上，所以起始窗应显著高于前置窗。
若某句前置窗反而更响，说明字幕早于语音（滞后/超前）。

这个判定不依赖静音检测，BGM 全程响也能测。

## 另一项：BGM 可闻性

测人声空档（句子之间）的平均电平，规范要求 ≥ -24dB，
否则手机小喇叭听不见 BGM。
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIDEO = ROOT / "out" / "ai-pcb-v6.mp4"
TIMELINE = ROOT / "src" / "data" / "timeline_pcb.json"

PRE = 0.20        # 前置窗长度
GAP = 0.03        # 距起点留白
POST = 0.25       # 起始窗长度


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace")


def mean_db(wav: Path, start: float, end: float) -> float | None:
    if end - start < 0.04:
        return None
    r = run(["ffmpeg", "-i", str(wav), "-af",
             f"atrim=start={start:.3f}:end={end:.3f},volumedetect", "-f", "null", "-"])
    m = re.search(r"mean_volume:\s*(-?[\d.]+) dB", r.stderr)
    return float(m.group(1)) if m else None


def main() -> int:
    if not VIDEO.is_file():
        print(f"缺少成片 {VIDEO}")
        return 1
    lines = json.loads(TIMELINE.read_text(encoding="utf-8"))["lines"]

    tmp = ROOT / "out" / "_verify_audio.wav"
    run(["ffmpeg", "-y", "-i", str(VIDEO), "-ar", "48000", "-ac", "1", str(tmp)])

    print("=== 字幕与语音对齐（起始窗应比前置窗响）===\n")
    print(f"{'#':>3} {'起点':>8} {'前置dB':>8} {'起始dB':>8} {'提升':>7}  判定  文本")
    ok = 0
    worst_drop = 0.0
    for ln in lines:
        st = ln["start"]
        pre = mean_db(tmp, max(0, st - PRE), max(0, st - GAP))
        post = mean_db(tmp, st + GAP, st + GAP + POST)
        if pre is None or post is None:
            print(f"{ln['i']:>3} {st:>8.3f}   窗口不足，跳过")
            continue
        gain = post - pre
        passed = gain >= 1.5
        if passed:
            ok += 1
        else:
            worst_drop = min(worst_drop, gain)
        mark = "OK " if passed else "!! "
        print(f"{ln['i']:>3} {st:>8.3f} {pre:>8.1f} {post:>8.1f} {gain:>+7.1f}  {mark}{ln['text'][:18]}")

    print(f"\n对齐 {ok}/{len(lines)} 句（起始窗较前置窗响 ≥1.5dB 视为对齐）")

    # BGM 可闻性
    print("\n=== BGM 在人声空档处的电平（规范 ≥ -24dB）===")
    gaps = []
    for i in range(len(lines) - 1):
        a = lines[i]["end"] + 0.06
        b = lines[i + 1]["start"] - 0.06
        if b - a >= 0.22:
            gaps.append((a, b))
    levels = []
    for a, b in gaps[:8]:
        lv = mean_db(tmp, a, b)
        if lv is not None:
            levels.append(lv)
            print(f"  {a:6.2f}~{b:6.2f}s  {lv:6.1f} dB  {'OK' if lv >= -24 else '偏低'}")
    if levels:
        avg = sum(levels) / len(levels)
        print(f"\n空档平均 {avg:.1f} dB → {'达标' if avg >= -24 else '未达标（需提高 BGM 音量）'}")

    tmp.unlink(missing_ok=True)
    return 0 if ok >= len(lines) else 1


if __name__ == "__main__":
    raise SystemExit(main())
