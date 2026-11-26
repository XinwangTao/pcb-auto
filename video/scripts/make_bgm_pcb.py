"""为「AI 全自动设计 PCB」宣传片生成 BGM。

## 为什么不找现成音乐

短视频平台对侵权音乐直接限流/下架，版权风险不值得。这里用 ffmpeg 合成
**极简科技氛围**：低频铺底 + 脉冲推进 + 高频微光。

## 手机外放友好（这是「听不听得见」的关键）

实测教训（见 Obsidian《短视频出品标准》§4）：某首指定曲目 90% 能量在 300Hz 以下，
而手机小喇叭 150Hz 以下基本放不出 —— 等于静音。

所以本脚本一开始就：
1. 铺底放在 180~440Hz（手机能放出来的区间），不浪费在 100Hz 以下
2. 强抬 900Hz / 2400Hz / 4200Hz 三段（手机喇叭主战场）
3. 低频只留节奏感，不轰头

## 响度关系（定稿基线）

| 环节 | 目标 |
| --- | --- |
| 纯人声 | -17.5 LUFS（实测） |
| BGM 母带 | -20.5 LUFS |
| 成片混音 | 约 -17.5 LUFS |

BGM 比人声低约 3dB 是验收通过点：更低听不见，更高抢词。
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent      # video/
PUBLIC = ROOT / "public"
DATA = ROOT / "src" / "data"

TARGET_LUFS = -20.5          # 比人声 -17.5 低 3dB


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        print("ffmpeg stderr:", r.stderr[-900:])
        raise RuntimeError("ffmpeg 失败")
    return r


def build(duration: float, out: Path) -> None:
    """合成科技氛围底：A 小调和弦铺底 + 2 秒心跳脉冲 + 缓慢高频微光。"""
    # 铺底：A2 / E3 / A3，能量放在 180~440Hz，手机放得出
    drone = (
        "sine=frequency=220:sample_rate=48000,volume=0.085[a1];"
        "sine=frequency=329.63:sample_rate=48000,volume=0.055[a2];"
        "sine=frequency=440:sample_rate=48000,volume=0.032[a3];"
        "[a1][a2][a3]amix=inputs=3:normalize=0[drone]"
    )
    # 心跳脉冲：2 秒一次，给「在推进」的感觉，不做鼓点
    pulse = (
        "sine=frequency=110:sample_rate=48000,"
        "tremolo=f=0.5:d=0.86,volume=0.13[low]"
    )
    # 高频微光：极轻，制造空间宽度
    shimmer = (
        "sine=frequency=2637:sample_rate=48000,"
        "tremolo=f=0.11:d=0.92,volume=0.010[hi]"
    )
    # 可选：很轻的节拍噪点（像精密仪器运转）
    tick = (
        "anoisesrc=color=white:sample_rate=48000:amplitude=0.02,"
        "highpass=f=3000,tremolo=f=2:d=0.95,volume=0.06[noise]"
    )
    graph = (
        f"{drone};{pulse};{shimmer};{tick};"
        "[drone][low][hi][noise]amix=inputs=4:normalize=0,"
        # 手机外放友好 EQ：强抬中高频三段
        "highpass=f=70,"
        "equalizer=f=900:t=q:w=0.9:g=+7,"
        "equalizer=f=2400:t=q:w=0.9:g=+6,"
        "equalizer=f=4200:t=q:w=1.0:g=+4,"
        # 低频只留节奏，不轰头
        "equalizer=f=120:t=q:w=1.0:g=-1,"
        "lowpass=f=9000,"
        "afade=t=in:st=0:d=1.8,"
        f"afade=t=out:st={max(0, duration - 3):.2f}:d=3[mix]"
    )
    run([
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-filter_complex", graph,
        "-map", "[mix]", "-t", f"{duration:.3f}",
        "-ar", "48000", "-ac", "2", str(out),
    ])


def finish_loudness(src: Path, dst: Path) -> None:
    """两遍 loudnorm 稳定达标（单遍对长素材会有偏差）。"""
    m = run(["ffmpeg", "-i", str(src), "-af",
             f"loudnorm=I={TARGET_LUFS}:TP=-3:LRA=7:print_format=json", "-f", "null", "-"])
    text = m.stderr
    s, e = text.rfind("{"), text.rfind("}")
    stats = json.loads(text[s:e + 1])
    run(["ffmpeg", "-y", "-i", str(src), "-af",
         (f"loudnorm=I={TARGET_LUFS}:TP=-3:LRA=7:"
          f"measured_I={stats['input_i']}:measured_TP={stats['input_tp']}:"
          f"measured_LRA={stats['input_lra']}:measured_thresh={stats['input_thresh']}:"
          f"offset={stats['target_offset']}:linear=true"),
         "-ar", "48000", "-ac", "2", str(dst)])


def main() -> int:
    tf = DATA / "timeline_pcb.json"
    if not tf.is_file():
        print("请先跑 tts_pcb.py 生成时间轴")
        return 1
    total = json.loads(tf.read_text(encoding="utf-8"))["total"]
    raw = PUBLIC / "_bgm_pcb_raw.wav"
    final = PUBLIC / "bgm_pcb.wav"
    build(total, raw)
    finish_loudness(raw, final)
    raw.unlink(missing_ok=True)
    print(f"成片时长 {total}s")
    print(f"BGM {final}（{final.stat().st_size // 1024} KB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
