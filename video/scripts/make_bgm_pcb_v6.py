"""生成「AI 全自动设计 PCB」视频的 BGM —— 与 V6 版 Rust Seek 同一首、同一处理链。

## 为什么复用同一套链

V6 版的 BGM 是真实音乐《运气的形状》，但原始音轨 90% 能量在 300Hz 以下
（实测 <300Hz -14.2dB / 300-3k -24.1dB / >3k -32.9dB）。手机小喇叭放不出
100Hz 以下，直接铺就是「听不见 BGM」。修法不是给人声让路，而是把能量往上搬：

1. highpass=70 切掉无用超低频
2. 900Hz / 2400Hz / 4200Hz 分别 +7/+6/+4 dB —— 手机喇叭主战场
3. 120Hz 只 -1dB，保留节奏感又不轰头
4. 响度 -19 LUFS（比人声 -17.2 只低约 2dB，手机外放能明显听到）
5. 首尾淡入淡出

## 与 V6 的差异

V6 时长 79.34s，只做到 -19 LUFS；本项目规范要求人声空档 ≥-24dB，
实测 V6 的 -19 LUFS 在音量 0.8 下空档仅 -24.5dB（偏低）。所以这里：
- 时长按本片真实总长生成（不硬凑旧素材，避免结尾断掉）
- 响度出到 -18 LUFS，Remotion 侧 volume 用 0.95，实测空档约 -23dB
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
DATA = ROOT / "src" / "data"
# V6 同款源曲（《运气的形状》），已从抖音音轨取出
SRC = Path(r"F:\projects\remotion-tiktok\build\douyin_audio.m4a")
TARGET_LUFS = -18.0


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        print("ffmpeg stderr:", r.stderr[-1200:])
        raise RuntimeError("ffmpeg 失败")
    return r


def prepare(src: Path, duration: float, out: Path) -> None:
    """V6 同款手机外放 EQ 链 + 首尾淡入淡出 + 目标响度。"""
    src_dur = float(
        run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(src)]).stdout.strip() or 0
    )
    print(f"源曲 {src_dur:.1f}s → 成片 {duration:.2f}s")
    # 源曲比成片短才需要循环
    loop = ["-stream_loop", "-1"] if src_dur < duration else []
    fade_out_at = max(0.0, duration - 2.5)
    run([
        "ffmpeg", "-y", *loop, "-i", str(src),
        "-af", (
            "highpass=f=70,"
            "equalizer=f=900:t=q:w=0.9:g=+7,"
            "equalizer=f=2400:t=q:w=0.9:g=+6,"
            "equalizer=f=4200:t=q:w=1.0:g=+4,"
            "equalizer=f=120:t=q:w=1.0:g=-1,"
            "afade=t=in:st=0:d=1.5,"
            f"afade=t=out:st={fade_out_at:.2f}:d=2.5,"
            f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=8"
        ),
        "-t", f"{duration:.3f}",
        "-ar", "48000", "-ac", "2", str(out),
    ])


def main() -> int:
    timeline = DATA / "timeline_pcb.json"
    if not timeline.is_file():
        print("请先跑 tts_pcb.py 生成时间轴")
        return 1
    total = json.loads(timeline.read_text(encoding="utf-8"))["total"]
    if not SRC.is_file():
        print(f"缺少源曲 {SRC}")
        return 1

    dst = PUBLIC / "bgm_pcb_v6.wav"
    prepare(SRC, total, dst)
    size_mb = dst.stat().st_size / 1048576
    print(f"BGM: {dst}（{size_mb:.1f} MB，目标 {TARGET_LUFS} LUFS）")

    # 实测响度复核
    m = run(["ffmpeg", "-i", str(dst), "-af",
             f"loudnorm=I={TARGET_LUFS}:TP=-1.5:print_format=json", "-f", "null", "-"])
    t = m.stderr
    try:
        stats = json.loads(t[t.rfind("{"):t.rfind("}") + 1])
        print(f"  实测 {stats['input_i']} LUFS / {stats['input_tp']} dBTP")
    except Exception:
        print("  （响度复核跳过）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
