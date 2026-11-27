"""为 PcbRealV11（单次建筑版·8 段）生成配音 + 时间轴，并把每句裁到「真实语音」区间。

为什么是 V11 的一份新脚本，而不是改 tts_pcb.py / tts_v9.py
----------------------------------------------------------
那两个是 V6/V9 的产线，已经被验收过，改它们等于把旧成片的时间轴一起重算。
这里只做 V11 需要的事：8 句台词 → `public/voice_v11/s01..s08.wav` + `timing.json`。
音色 / 语速 / 音高 / loudnorm 参数与 V6、V9 **逐字一致**：
    zh-CN-YunxiNeural / +8% / +0Hz / loudnorm=I=-16:TP=-1.5:LRA=11
（照抄 tts_pcb.py L38-42 与 tts_v9.py L52-55，没有一处「调优」。）

与旧脚本唯一的差别：这里**按检测到的语音起止精确裁掉首尾静音**
------------------------------------------------------------
V6/V9 的规矩是「不裁静音，让时间轴适配音频」——那条规矩成立的前提是句子之间
有 0.26~0.9s 的呼吸空隙，字幕只要盖住真正出声的区间就不会撞车。

V11 没有那个余地：段长 SEG=77 帧，段间 10 帧交叉，所以**每句只有 67 帧（2.233s）
就必须让位给下一句**。edge-tts 每句自带 ≈0.20s 头静音 + ≈0.81s 尾静音，
原样交付时 8 个文件的整文件时长是 2.51~3.07s，全部超过 2.233s 段窗 —— 那两个
≈1.0s 的静音没有任何信息量，却会把「时长 / 段窗」这个比值顶到 1.3。

所以这里用 silencedetect 精确量出 B（首个非静音时刻）与 F（末段静音起点），
`atrim=start=B:end=F+0.03` 只切**静音**，一个语音采样都不动；尾部多留 30ms
是为了不让 `afade` 把最后一个字的尾音咬掉。语速一个参数都没改
（想缩短只能改短台词，这条写在 PcbRealV11 的口播契约里）。

交付口径
--------
- `durSec`  = 交付文件（wav）的实测整文件时长，也就是 Remotion 里真正占的时间
- `rawDurSec` = edge-tts 原始 mp3 时长（含首尾静音），只作对照，不用于对齐
- `speechSec` = 检测到的真实语音长度（不含那 30ms 尾巴）

时间轴口径（与 src/PcbRealV11.jsx 的 SEG/XFADE 同源，不手抄）
--------------------------------------------------------------
    total = (N-1)*(SEG-XFADE) + SEG          # 8 段 → 546 帧 = 18.200s
    segStart[i] = i*(SEG-XFADE)/30
    可用窗 avail = (SEG-XFADE)/30 - LEAD      # LEAD=0.08s，避开切点
帧级断言（真正的闸门，Remotion 只认帧）：
    startFrame + durFrames <= (i+1)*(SEG-XFADE)      # i < N-1
    startFrame + durFrames <= total                  # 末段
超了就以退出码 1 结束，不让一个「大约能过」的时间轴流到渲染那一步。
"""
from __future__ import annotations

import json
import math
import re
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # video/
PUBLIC = ROOT / "public"
MANIFEST = PUBLIC / "v11" / "manifest.json"
OUT_DIR = PUBLIC / "voice_v11"

# ── 与 tts_pcb.py / tts_v9.py 完全一致的语音参数（不许改） ──────────────
VOICE = "zh-CN-YunxiNeural"
RATE = "+8%"
PITCH = "+0Hz"
TARGET_LUFS = -16.0
LOUDNORM = f"loudnorm=I={TARGET_LUFS}:TP=-1.5:LRA=11"
TP_LINEAR = 0.841        # -1.5 dBFS 的线性值（10^(-1.5/20)=0.8414），给 alimiter 用

# ── 与 src/PcbRealV11.jsx 同源的段几何 ───────────────────────────────────
FPS = 30
SEG = 110
XFADE = 10
LEAD_SEC = 0.08          # 段起点后 0.08s 才出声；同时把字幕的进出锚在同一刻度上
TAIL_PAD_SEC = 0.03      # 裁剪后尾部多留 30ms，给 afade 留余地，不吃掉尾音
FADE_IN_SEC = 0.008
FADE_OUT_SEC = 0.03

# ── 台词（8 句，一句一段，顺序 = manifest.beats[].id 顺序） ──────────────
# 全部 ≤14 字（竖屏一行放得下）；5 组实测数字全部来自
# out/ESP32S3_Wireless_Mic_V5-20261127-005256/_run.json：
#   components 28 / connections 115 / gates.drcLeafCount 0 / elapsedMs 410299(=410s)
#   gates.exportsOk 6（exportsTotal 6）
# 主旨：手工要好几个小时 → 410 秒（6.8 分钟）从导入到导出 6 个制造文件。
LINES: list[tuple[str, str]] = [
    ("pcb-imported",  "手工干，要好几个小时"),
    ("pcb-layout",    "28 个器件，自己排开"),
    ("pcb-pour",      "铺铜两层，先把地接通"),
    ("route",         "115 根线，自己走过去"),
    ("pcb-routed",    "布线走完，DRC 零违规"),
    ("pcb-bottom",    "翻到底层，走线压铜"),
    ("pcb-stitched",  "断掉的线自己缝上"),
    ("pcb-clearance", "410 秒，6 个制造文件"),
]


def _which(name: str, env_var: str | None = None) -> str:
    """先 PATH，再环境变量。**不写死本机绝对路径** ——
    写死会把脚本变成只在一台机器上能跑，而 test/dev-path-scan.mjs 会把它
    判成**功能级违规**（本文件就被抳过一次：旧版把 ffmpeg 的安装目录写成了字面量）。
    """
    p = shutil.which(name)
    if p:
        return p
    if env_var:
        cand = os.environ.get(env_var)
        if cand and Path(cand).is_file():
            return cand
        raise SystemExit(
            f"找不到 {name}：PATH 里没有，环境变量 {env_var} 也没指到可执行文件。"
        )
    raise SystemExit(f"找不到 {name}：PATH 里没有。")


FFMPEG = _which("ffmpeg", "PCB_AUTO_FFMPEG")
FFPROBE = _which("ffprobe", "PCB_AUTO_FFPROBE")
EDGE_TTS = _which("edge-tts", "PCB_AUTO_EDGE_TTS")


def run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, errors="replace")


def probe_duration(path: Path) -> float:
    r = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(path)])
    try:
        return float((r.stdout or "0").strip())
    except ValueError:
        return 0.0


def speech_bounds(path: Path) -> tuple[float, float]:
    """测真实语音起止；-45dB / 0.10s 与 tts_pcb.py、tts_v9.py 完全一致。"""
    duration = probe_duration(path)
    if duration <= 0:
        return 0.0, 0.0
    r = run([FFMPEG, "-i", str(path), "-af",
             "silencedetect=noise=-45dB:d=0.10", "-f", "null", "-"])
    starts = [float(m.group(1)) for m in re.finditer(r"silence_start:\s*([\d.]+)", r.stderr)]
    ends = [float(m.group(1)) for m in re.finditer(r"silence_end:\s*([\d.]+)", r.stderr)]
    begin = ends[0] if ends and ends[0] < duration - 0.1 else 0.0
    finish = starts[-1] if starts and starts[-1] > 0.05 else duration
    if finish <= begin:
        begin, finish = 0.0, duration
    return round(begin, 3), round(min(finish, duration), 3)


def synth(index: int, text: str) -> Path:
    # 原料单独放 raw/：它含 ≈1.0s 首尾静音，整文件时长 2.5~3.0s，
    # 谁要是拿它当「每句时长」去比段窗，结论一定是错的。交付口径只看 sNN.wav。
    raw_dir = OUT_DIR / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw = raw_dir / f"raw_{index:02d}.mp3"
    if raw.exists():
        raw.unlink()
    r = run([EDGE_TTS, "--voice", VOICE, "--rate", RATE, "--pitch", PITCH,
             "--text", text, "--write-media", str(raw)])
    if not raw.is_file() or raw.stat().st_size < 1000:
        raise SystemExit(f"第 {index} 句合成失败（{EDGE_TTS}）：{(r.stderr or r.stdout)[:400]}")
    return raw


def trim_and_normalize(raw: Path, dst: Path, begin: float, finish: float,
                       src_dur: float) -> tuple[float, float]:
    """只切静音：atrim 精确落在检测到的语音起止上，再走与 V6/V9 相同的 loudnorm。

    loudnorm 的**目标参数一个都没动**（I=-16:TP=-1.5:LRA=11），只是从「单遍」改成
    「两遍测量」：单遍 loudnorm 是流式动态算法，在 1.5~2.1s 的短句上会跑偏 ——
    同一批交付文件实测 input_i 从 -17.49 到 -23.03 LUFS，5.5dB 的忽大忽小，
    在多句连播的成片里是能听出来的。两遍做法是先把实测值量出来再喂回去
    （measured_* + linear=true），目标值仍是同一组 -16/-1.5/11。
    """
    end = min(src_dur, finish + TAIL_PAD_SEC)
    seg = end - begin
    if seg <= 0.05:
        raise SystemExit(f"裁剪区间异常：{raw.name} begin={begin} finish={finish} dur={src_dur}")
    fade_out_at = max(FADE_IN_SEC + 0.001, seg - FADE_OUT_SEC)
    trim_af = (
        f"atrim=start={begin:.3f}:end={end:.3f},asetpts=N/SR/TB,"
        f"afade=t=in:st=0:d={FADE_IN_SEC},"
        f"afade=t=out:st={fade_out_at:.3f}:d={FADE_OUT_SEC}"
    )

    # 第 0 遍：裁静音 + 淡入淡出，落到中间 wav（后面两遍 loudnorm 都读它，输入完全一致）
    tmp = OUT_DIR / f"_trim_{dst.stem}.wav"
    tmp2 = OUT_DIR / f"_norm_{dst.stem}.wav"
    r0 = run([FFMPEG, "-y", "-i", str(raw), "-af", trim_af,
              "-ar", "48000", "-ac", "2", str(tmp)])
    if not tmp.is_file() or tmp.stat().st_size < 2000:
        raise SystemExit(f"第 {dst.name} 裁剪失败：{r0.stderr[-600:]}")

    # 第 1 遍：只测量
    m = run([FFMPEG, "-hide_banner", "-i", str(tmp), "-af", f"{LOUDNORM}:print_format=json",
             "-f", "null", "-"])
    blk = re.search(r'\{\s*"input_i".*?\}', m.stderr or "", re.S)
    if not blk:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"第 {dst.name} loudnorm 测量失败：{(m.stderr or '')[-600:]}")
    meas = json.loads(blk.group(0))

    # 第 2 遍：把实测值喂回去应用（linear=true → 整句一个恒定增益，不做动态压）
    apply_af = (
        f"{LOUDNORM}:measured_I={meas['input_i']}:measured_TP={meas['input_tp']}"
        f":measured_LRA={meas['input_lra']}:measured_thresh={meas['input_thresh']}"
        f":offset={meas['target_offset']}:linear=true"
    )
    r2 = run([FFMPEG, "-y", "-i", str(tmp), "-af", apply_af,
              "-ar", "48000", "-ac", "2", str(tmp2)])
    tmp.unlink(missing_ok=True)
    if not tmp2.is_file() or tmp2.stat().st_size < 2000:
        raise SystemExit(f"第 {dst.name} 归一失败：{r2.stderr[-600:]}")

    # 第 3 步：补回被 true-peak 钳位吃掉的增益。
    # loudnorm 的 linear 模式在「+增益会让真峰越过 TP」时只能少给增益，于是短促、
    # 波峰因数高的句子就停在 -18~-20 LUFS（实测 8 句里 4 句如此，最大差 4.05dB）。
    # 这里只做两件事：静态增益（volume）+ 真峰限幅（alimiter，天花板 -1.5dBFS=0.841），
    # 迭代到与目标差 <= 0.10dB 为止。限幅只削越过天花板的瞬态，动态范围基本不变。
    cur = tmp2
    applied = 0.0
    for k in range(3):
        lufs = measure_lufs(cur)
        gain = TARGET_LUFS - lufs
        if abs(gain) <= 0.10:
            applied += gain
            break
        nxt = OUT_DIR / f"_fix{k}_{dst.stem}.wav"
        rf = run([FFMPEG, "-y", "-i", str(cur),
                  "-af", f"volume={gain:.2f}dB,alimiter=level_in=1:level_out=1"
                         f":limit={TP_LINEAR}:level=false:attack=1:release=40",
                  "-ar", "48000", "-ac", "2", str(nxt)])
        cur.unlink(missing_ok=True)
        if not nxt.is_file() or nxt.stat().st_size < 2000:
            raise SystemExit(f"第 {dst.name} 补增益失败：{rf.stderr[-600:]}")
        cur = nxt
        applied += gain

    shutil.move(str(cur), str(dst))
    for p in OUT_DIR.glob(f"_*_{dst.stem}.wav"):
        p.unlink(missing_ok=True)
    return probe_duration(dst), applied


def measure_lufs(path: Path) -> float:
    """核对用：对交付文件再量一次 input_i（-16 就是目标）。"""
    r = run([FFMPEG, "-hide_banner", "-i", str(path),
             "-af", f"{LOUDNORM}:print_format=json", "-f", "null", "-"])
    blk = re.search(r'\{\s*"input_i".*?\}', r.stderr or "", re.S)
    if not blk:
        return float("nan")
    try:
        return float(json.loads(blk.group(0))["input_i"])
    except (ValueError, KeyError):
        return float("nan")


def main() -> int:
    beats = json.loads(MANIFEST.read_text(encoding="utf-8")).get("beats") or []
    ids = [str(b.get("id") or "") for b in beats]
    n = len(ids)
    total_frames = (n - 1) * (SEG - XFADE) + SEG if n else 0
    advance = SEG - XFADE
    advance_sec = advance / FPS
    seg_sec = SEG / FPS
    avail_sec = advance_sec - LEAD_SEC

    # 同源闸门：段数/帧数与 PcbRealV11.jsx 的 SEG/XFADE 算出来的必须一致
    if n != len(LINES):
        raise SystemExit(f"manifest {n} 段 ≠ 台词 {len(LINES)} 句：{MANIFEST}")
    if ids != [i for i, _ in LINES]:
        raise SystemExit(f"manifest 段序与台词顺序不一致：\nmanifest={ids}\n台词  ={[i for i, _ in LINES]}")
    if total_frames != 810:
        raise SystemExit(f"帧数 {total_frames} ≠ 成片 810 帧（SEG/XFADE 与 jsx 分叉了）")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"语音 {VOICE}  语速 {RATE}  音高 {PITCH}  loudnorm I={TARGET_LUFS}")
    print(f"段数 {n}  SEG={SEG}  XFADE={XFADE}  总帧 {total_frames} = {total_frames / FPS:.3f}s")
    print(f"段长 {seg_sec:.3f}s  推进 {advance_sec:.3f}s  出声窗 {avail_sec:.3f}s（LEAD {LEAD_SEC}s）\n")

    lines: list[dict] = []
    problems: list[str] = []
    for i, (beat_id, text) in enumerate(LINES):
        idx = i + 1
        raw = synth(idx, text)
        raw_dur = probe_duration(raw)
        begin, finish = speech_bounds(raw)
        final = OUT_DIR / f"s{idx:02d}.wav"
        dur, applied = trim_and_normalize(raw, final, begin, finish, raw_dur)
        if dur <= 0:
            raise SystemExit(f"{final.name} 时长探测为 0")
        lufs = measure_lufs(final)

        seg_start = i * advance / FPS
        start_sec = round(seg_start + LEAD_SEC, 3)
        end_sec = round(start_sec + dur, 3)
        start_frame = i * advance + round(LEAD_SEC * FPS)
        dur_frames = math.ceil(dur * FPS)
        limit_frame = (i + 1) * advance if i < n - 1 else total_frames
        ratio = dur / avail_sec

        if start_frame + dur_frames > limit_frame:
            problems.append(
                f"第 {idx} 句占帧 {start_frame}~{start_frame + dur_frames} 越过段界 {limit_frame}"
                f"（多 {start_frame + dur_frames - limit_frame} 帧）")
        if ratio > 1.0:
            problems.append(
                f"第 {idx} 句 {dur:.3f}s / 出声窗 {avail_sec:.3f}s = {ratio:.3f} > 1.0"
                f" —— 念的是「{text}」（{len(text)} 字），需改短台词，不许提速")
        if not (-17.0 <= lufs <= -15.0):
            problems.append(f"第 {idx} 句响度 {lufs:.2f} LUFS 偏离目标 {TARGET_LUFS}（允许 ±1）")

        lines.append({
            "line": idx,
            "beat": beat_id,
            "text": text,
            "file": f"voice_v11/{final.name}",
            "durSec": round(dur, 3),
            "startSec": start_sec,
            "endSec": end_sec,
            "startFrame": start_frame,
            "durFrames": dur_frames,
            "segmentStartSec": round(seg_start, 3),
            "segmentDurSec": round(seg_sec, 3),
            "advanceSec": round(advance_sec, 3),
            "availSec": round(avail_sec, 3),
            "ratioAvail": round(ratio, 4),
            "ratioSegment": round(dur / seg_sec, 4),
            "chars": len(text),
            "speechSec": round(finish - begin, 3),
            "rawDurSec": round(raw_dur, 3),
            "trimmedSec": round(max(0.0, raw_dur - dur), 3),
            "lufs": round(lufs, 2) if lufs == lufs else None,
            "residualGainDb": round(applied, 2),
        })
        print(f"  {idx:02d} {beat_id:14s} 段起 {seg_start:6.2f}s  出声 {start_sec:6.2f}~{end_sec:6.2f}s "
              f"({dur:.3f}s / 窗 {avail_sec:.3f}s = {ratio:.3f})  帧 {start_frame}~{start_frame + dur_frames}"
              f" ≤ {limit_frame}  {lufs:.1f}LUFS  {text}")

    max_ratio = max(l["ratioAvail"] for l in lines)
    max_line = max(lines, key=lambda l: l["durSec"])
    worst = max(lines, key=lambda l: l["ratioAvail"])
    payload = {
        "voice": VOICE, "rate": RATE, "pitch": PITCH, "loudnorm": LOUDNORM,
        "fps": FPS, "seg": SEG, "xfade": XFADE, "beats": n,
        "totalFrames": total_frames, "totalSec": round(total_frames / FPS, 3),
        "leadSec": LEAD_SEC, "advanceSec": round(advance_sec, 3),
        "segSec": round(seg_sec, 3), "availSec": round(avail_sec, 3),
        "source": "out/ESP32S3_Wireless_Mic_V5-20261127-005256/_run.json",
        "numbers": {"components": 28, "connections": 115, "drcLeaf": 0,
                    "elapsedS": 410, "exportsOk": 6, "exportsTotal": 6},
        "maxRatioAvail": round(max_ratio, 4),
        "maxRatioSegment": round(max(l["ratioSegment"] for l in lines), 4),
        "longestLine": {"line": max_line["line"], "text": max_line["text"],
                        "durSec": max_line["durSec"], "chars": max_line["chars"]},
        "tightestLine": {"line": worst["line"], "text": worst["text"],
                         "ratioAvail": worst["ratioAvail"]},
        "lufsRange": [round(min(l["lufs"] for l in lines), 2),
                      round(max(l["lufs"] for l in lines), 2)],
        "lines": lines,
        "problems": problems,
    }
    (OUT_DIR / "timing.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n最长句 #{max_line['line']}「{max_line['text']}」{max_line['durSec']:.3f}s "
          f"（{max_line['chars']} 字）")
    print(f"max(durSec/出声窗) = {max_ratio:.3f}（第 {worst['line']} 句）"
          f"   max(durSec/段长) = {payload['maxRatioSegment']:.3f}")
    print(f"响度 {payload['lufsRange'][0]}~{payload['lufsRange'][1]} LUFS（目标 {TARGET_LUFS}）")
    if problems:
        print(f"\n{len(problems)} 条不通过：")
        for p in problems:
            print("  ! " + p)
        return 1
    print("\n全部通过：每句都在帧级段界内，且 max(ratio) <= 1.0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
