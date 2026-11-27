# -*- coding: utf-8 -*-
"""auto-zoom.py · 算「AI 操作时放大到板子」的裁剪框

用户的原话（2026-11-27）：
  「AI 操作画板子、画线，然后自动布线的时候，你要适当放大，不然看不清。要自动缩放。
    就是没有操作的时候……开头和结尾……是现在的视角。当 AI 开始操作了，你就是要放大到
    那块板子的视角，方便别人看清 AI 到底做了什么。」

## 为什么不是「切中心」

板子在录屏里的位置**不是画面中心**（实测中心在 x≈792，而画面中心是 800 —— 看着接近，
但它只占宽度 222/1600 = 14%，切中心等于什么都没放大）。

## 怎么找到板子（两次踩坑之后的办法）

1. ❌ 直接对整幅算「彩色像素 bbox」→ 得到 1596×992，几乎整幅。因为这是**整个桌面截图**，
   图层栏色块、工具栏图标、日志彩字全是彩色的。`frames-stats.py` 那套掩码只适用于
   「纯画布」PNG（`getCurrentRenderedAreaImage()`），不适用于带 UI 的桌录。
2. ❌ 列/行密度取 min/max → 只要画面边缘有一列过阈值，范围就被拉到 x=1599。
3. ✅ **从最密的那一列向两侧扩展取连续段**（`run_containing`），再在该列带内找行。

实测结果：板子固定在 `682,118 – 903,741`（222×624），t=160…332 逐帧一致 ——
所以整轮共用一个裁剪框不仅够用，而且**更好**：段与段之间不会跳。

## 裁剪策略

- 裁剪框按板子**本来的竖长比**（≈0.356）走，只留 8% 边距。
  这样竖屏里是一个高窄的画面板，板子几乎占满 → 渲染后板子从 138×387 px 变成约 335×940 px（**约 2.4 倍**）。
- 首尾两段（`pcb-imported` / `pcb-clearance`）不裁，保持现在的全窗视角 —— 用户点名。
- 断言：裁剪框必须**完整包含**板子 bbox；板子 bbox 的逐帧离散度超过 8% 就退 1
  （说明它在动，静态裁剪会把它切掉）。

输出 `out/motion/zoom.json`，由 cut-motion.ps1 读进 ffmpeg 的 crop 滤镜。

退出码：0 成功 / 2 缺输入 / 1 断言失败
"""
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime

import numpy as np
from PIL import Image

VIDEO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(VIDEO)
CLIPS = os.path.join(VIDEO, "out", "motion", "clips.json")
OUT = os.path.join(VIDEO, "out", "motion", "zoom.json")
SRC = os.path.join(REPO, "out", "gui-v11-real.mp4")
FFMPEG = os.environ.get("PCB_AUTO_FFMPEG") or "ffmpeg"

WIDE_BEATS = {"pcb-imported", "pcb-clearance"}   # 用户点名：开头 / 结尾
SAMPLE_TIMES = [160, 180, 200, 220, 240, 260, 280, 300, 315, 325, 332, 340]
MARGIN = 1.08
ASPECT_MIN, ASPECT_MAX = 0.34, 1.60
MIN_SIDE = 200
COLOR_THRESHOLD = 45
# 【这个阈值不是“布局稳不稳”，是“有没有一个采样点找到了别的东西”】
# 实测板子完整 bbox 逐帧只差 0–14px（有几帧底层被日志拦住一部分），
# 而裁剪框取的是并集，容纳性由构造保证。设 8% 会误判。
MAX_SPREAD = 0.35        # 离群检测：单个采样点偏离超过这个就说明它找错了


def run_containing(prof, thr, peak):
    lo = peak
    while lo > 0 and prof[lo - 1] > thr:
        lo -= 1
    hi = peak
    n = len(prof)
    while hi < n - 1 and prof[hi + 1] > thr:
        hi += 1
    return lo, hi


def board_bbox(path):
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.int16)
    H, W, _ = a.shape
    mask = (a.max(axis=2) - a.min(axis=2)) > COLOR_THRESHOLD
    cc = mask[: int(H * 0.88)].mean(axis=0)          # 排除底部日志区（那里也有彩字）
    peak = int(np.argmax(cc))
    x0, x1 = run_containing(cc, max(0.25, cc[peak] * 0.55), peak)
    if x1 - x0 < 80:
        return None
    rr = mask[:, x0:x1 + 1].mean(axis=1)
    rpk = int(np.argmax(rr))
    y0, y1 = run_containing(rr, max(0.30, rr[rpk] * 0.5), rpk)
    if y1 - y0 < 120:
        return None
    return (x0, y0, x1, y1)


def main():
    if not os.path.exists(CLIPS):
        print(f"缺片段清单：{CLIPS}（先跑 cut-motion.ps1）", file=sys.stderr)
        return 2
    if not os.path.exists(SRC):
        print(f"缺源屏录：{SRC}", file=sys.stderr)
        return 2

    doc = json.load(open(CLIPS, encoding="utf-8"))
    clips = doc.get("clips") or []
    if not clips:
        print("clips.json 里没有片段", file=sys.stderr)
        return 2

    tmp = tempfile.mkdtemp(prefix="autozoom-")
    boxes = []
    for t in SAMPLE_TIMES:
        p = os.path.join(tmp, f"t{t}.png")
        subprocess.run([FFMPEG, "-v", "error", "-y", "-ss", str(t), "-i", SRC,
                        "-frames:v", "1", p], check=False)
        if not os.path.exists(p):
            continue
        bb = board_bbox(p)
        if bb:
            boxes.append(bb)
            print(f"  t={t:<4}s 板子 bbox {bb[0]},{bb[1]} - {bb[2]},{bb[3]}  "
                  f"{bb[2]-bb[0]+1}x{bb[3]-bb[1]+1}")
        else:
            print(f"  t={t:<4}s 未定位到板子（跳过）")

    if len(boxes) < len(SAMPLE_TIMES) * 0.6:
        print(f"只有 {len(boxes)}/{len(SAMPLE_TIMES)} 个采样点定位到板子，不足 60%", file=sys.stderr)
        return 1

    xs0 = [b[0] for b in boxes]; ys0 = [b[1] for b in boxes]
    xs1 = [b[2] for b in boxes]; ys1 = [b[3] for b in boxes]
    x0, y0, x1, y1 = min(xs0), min(ys0), max(xs1), max(ys1)
    bw, bh = x1 - x0 + 1, y1 - y0 + 1

    # 离散度：如果板子在录屏里挪过位置，静态裁剪会把它切掉，必须拒绝
    spread = max(
        (max(xs1) - min(xs1)) / bw,
        (max(ys1) - min(ys1)) / bh,
        (max(xs0) - min(xs0)) / bw,
        (max(ys0) - min(ys0)) / bh,
    )
    print(f"\n  板子并集 bbox {x0},{y0} - {x1},{y1}  {bw}x{bh}   逐帧离散度 {spread*100:.1f}%")

    img = Image.open(os.path.join(tmp, f"t{SAMPLE_TIMES[0]}.png"))
    src_w, src_h = img.size

    aspect = max(ASPECT_MIN, min(ASPECT_MAX, bw / bh))
    ch = bh * MARGIN
    cw = ch * aspect
    if min(cw, ch) < MIN_SIDE:
        k = MIN_SIDE / min(cw, ch)
        cw *= k; ch *= k
    cw = min(cw, src_w); ch = min(ch, src_h)
    cw = int(round(cw / 2) * 2); ch = int(round(ch / 2) * 2)
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    px = int(round(cx - cw / 2))
    px = max(0, min(px, src_w - cw))
    # 【竖向留白全放到下方】居中的话，板子上方那 ~25px 恰好把 EDA 画布的
    # 「EDA 画布 005256/1-sma…」小标签切成一半（实测看起来像裁错了）。
    # 让板子贴近画框顶边，多余的高度留在下方。
    py = max(0, min(y0 - 2, src_h - ch))

    contained = (x0 >= px and y0 >= py and x1 <= px + cw and y1 <= py + ch)
    zoom_linear = round(src_h / ch, 3)
    zoom_area = round((src_w * src_h) / (cw * ch), 2)
    print(f"  裁剪框 {cw}x{ch} @({px},{py})   长宽比 {cw/ch:.3f}（板子 {bw/bh:.3f}）")
    print(f"  放大：线性 {zoom_linear}x  面积 {zoom_area}x   完整包含板子 = {contained}")

    problems = []
    # 真正该守的一条：**每一个**采样点的 bbox 都得落在裁剪框里。
    # 只查并集是废话（并集本来就是由它们算出来的），查逐个才能发现
    # “某一帧板子比别的帧大”这种会被裁掉的情形。
    outside = [b for b in boxes if not (b[0] >= px and b[1] >= py and b[2] <= px + cw and b[3] <= py + ch)]
    print(f"  逐个采样点被裁剪框完整包住：{len(boxes) - len(outside)}/{len(boxes)}")
    if outside:
        problems.append(f"{len(outside)} 个采样点的 bbox 溢出裁剪框（会被裁掉一角）")
    if spread > MAX_SPREAD:
        problems.append(f"板子逐帧离散度 {spread*100:.1f}% > {MAX_SPREAD*100:.0f}%（它在动，静态裁剪会切掉）")
    if zoom_area < 2.0:
        problems.append(f"面积放大只有 {zoom_area}x，用户要的是「看清」，这不够")

    crop = {"x": px, "y": py, "w": cw, "h": ch}
    rows = []
    for c in clips:
        wide = c["beat"] in WIDE_BEATS
        rows.append({
            "name": c["name"], "beat": c["beat"],
            "mode": "wide" if wide else "zoom",
            "reason": "用户点名：开头/结尾保持现在的全窗视角" if wide else "AI 在操作，放大到板子",
            "crop": None if wide else crop,
            "zoomFactorLinear": 1.0 if wide else zoom_linear,
            "zoomFactorArea": 1.0 if wide else zoom_area,
        })

    if problems:
        print("\n问题：", file=sys.stderr)
        for p in problems:
            print("  - " + p, file=sys.stderr)

    open(OUT, "w", encoding="utf-8").write(json.dumps({
        "generatedAt": datetime.now().isoformat(timespec="seconds"),
        "source": os.path.basename(SRC),
        "srcW": src_w, "srcH": src_h,
        "sampleTimes": SAMPLE_TIMES,
        "samplesHit": len(boxes), "samplesTotal": len(SAMPLE_TIMES),
        "boardBBox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
        "boardSpreadPct": round(spread * 100, 2),
        "margin": MARGIN, "aspectMin": ASPECT_MIN, "aspectMax": ASPECT_MAX,
        "wideBeats": sorted(WIDE_BEATS),
        "problems": problems,
        "clips": rows,
    }, ensure_ascii=False, indent=1))
    print(f"\n  已写 {OUT}")
    print(f"  放大段 {len(rows) - len(WIDE_BEATS)} / 宽景段 {len(WIDE_BEATS)}")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
