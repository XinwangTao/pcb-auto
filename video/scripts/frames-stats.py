#!/usr/bin/env python3
"""
frames-stats.py — 给 out/frames 里的真实画布帧做客观量测，供 V10 选帧用。

为什么需要：`out/frames/<批次>/<尝试>/` 里的 PNG 并不都可用 —— 实测
`0000-sch-wired.png` 是**整张近白空画布**（185013 / 140310 两个批次里
sha256 完全相同，1000x410 / 13109 B）。肉眼逐张看 600+ 张不现实，所以这里给每张帧算：

  mean        —— 整图平均亮度（>200 基本就是空白画布）
  brightRatio —— 亮度 > 70 的像素占比
  bbox        —— **彩色**（max-min > 45）像素的外接矩形，归一化 x0,y0,x1,y1。
                 彩色是这块板的特征：红铜面 / 蓝走线 / 黄丝印。灰色网格点、
                 白/灰标尺刻度、原点十字都不是彩色，所以 bbox 不会被它们撑到整幅。
                 用亮度做 mask 时 bbox 恒为 [0,0,1,1]（标尺和网格满屏，已实测）。

输出：JSON（默认打表格，--out 写文件）。**只读 out/frames，不写仓库里任何东西。**

用法：
    python video/scripts/frames-stats.py out/frames/185013 out/frames/140310 \
        --out video/data/frames-stats.json
    python video/scripts/frames-stats.py out/frames/185013/1-smart-fit --limit 3
"""
import argparse
import json
import os
import sys

import numpy as np
from PIL import Image


def stats(path):
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        a = np.asarray(im, dtype=np.int16)
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    # 注意：必须用 int32。int16 下 299*255 会溢出成负数（实测 mean 打出 -1.8），
    # 而 brightRatio / bbox 不受影响 —— 这种「只有一个字段坏了」的错最容易漏看。
    lum = (a[:, :, 0].astype(np.int32) * 299 + a[:, :, 1] * 587 + a[:, :, 2] * 114) // 1000
    bright = mx > 70
    colored = (mx - mn) > 45
    ys, xs = np.nonzero(colored)
    if xs.size == 0:
        bbox = None
    else:
        bbox = [
            round(float(xs.min()) / w, 4),
            round(float(ys.min()) / h, 4),
            round(float(xs.max() + 1) / w, 4),
            round(float(ys.max() + 1) / h, 4),
        ]
    return {
        "w": w,
        "h": h,
        "mean": round(float(lum.mean()), 1),
        "brightRatio": round(float(bright.mean()), 4),
        "coloredRatio": round(float(colored.mean()), 4),
        "bbox": bbox,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", nargs="+")
    ap.add_argument("--json", action="store_true", help="只打 JSON（默认打表格）")
    ap.add_argument("--out", help="把 JSON 写到这个文件")
    ap.add_argument("--limit", type=int, default=0, help="每个目录只取前 N 张（冒烟用）")
    args = ap.parse_args()

    rows = []
    for d in args.dir:
        if not os.path.isdir(d):
            print(f"[frames-stats] 错误：目录不存在 {d}", file=sys.stderr)
            return 2
        names = []
        for root, _dirs, files in os.walk(d):
            for n in files:
                if n.lower().endswith(".png"):
                    names.append(os.path.join(root, n))
        names.sort()
        if args.limit:
            names = names[: args.limit]
        for p in names:
            st = stats(p)
            st["file"] = p.replace("\\", "/")
            st["rel"] = os.path.relpath(p, d).replace("\\", "/")
            st["dir"] = d.replace("\\", "/")
            rows.append(st)
        print(f"[frames-stats] {d}: {len(names)} 张", file=sys.stderr)

    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
        print(f"[frames-stats] {len(rows)} 张 → {args.out}", file=sys.stderr)

    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
    else:
        print(f"{'rel':52s} {'mean':>6s} {'bright':>7s} {'color':>7s}  bbox")
        for r in rows:
            print(
                f"{r['rel'][:52]:52s} {r['mean']:6.1f} {r['brightRatio']:7.4f} "
                f"{r['coloredRatio']:7.4f}  {r['bbox']}"
            )
    return 0


if __name__ == "__main__":
    sys.exit(main())
