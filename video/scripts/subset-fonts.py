#!/usr/bin/env python3
"""
subset-fonts.py — 把 Windows 的微软雅黑裁到「视频里真正出现的字符」。

为什么必须裁：msyh.ttc 完整字体 19MB/16MB，通过 FontFace 加载会拖慢每一帧的
delayRender，超过 Remotion 默认超时就直接渲染失败。裁到实际用字后只有 ~80KB。

用法（字体或文案改了都要重跑）：
    python scripts/subset-fonts.py
"""
import glob
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, "public", "fonts")

# 常用中文标点 + 全角字符，避免数字/符号回退到别的字体
PUNCT = "，。、；：？！“”‘’（）【】《》—…·→×／％＋－０１２３４５６７８９"


def collect_chars() -> str:
    chars = set(chr(c) for c in range(0x20, 0x7F))
    chars |= set(PUNCT)
    # **递归**扫 src（V10 把文案放在 public/v10/manifest.json 里，由 build-v10.mjs 生成，
    # 所以也要一起扫 —— 否则新加的汉字会变成方框，而且渲染不会报错）。
    patterns = (
        "src/*.jsx",
        "src/*.js",
        "src/**/*.jsx",
        "src/**/*.js",
        "src/data.json",
        "public/v10/manifest.json",
    )
    for pattern in patterns:
        for path in glob.glob(os.path.join(BASE, pattern), recursive=True):
            with open(path, encoding="utf-8") as fh:
                chars |= set(fh.read())
    return "".join(sorted(c for c in chars if c.strip() or c == " "))


def main():
    text = collect_chars()
    print(f"[subset] distinct chars: {len(text)}")

    jobs = [
        ("msyh-regular.ttf", "sub-regular.ttf"),
        ("msyh-bold.ttf", "sub-bold.ttf"),
        ("consola.ttf", "sub-mono.ttf"),
        ("consolab.ttf", "sub-monob.ttf"),
    ]
    for src, dst in jobs:
        sp = os.path.join(OUT, src)
        dp = os.path.join(OUT, dst)
        if not os.path.exists(sp):
            print(f"[subset] SKIP missing {sp}")
            continue
        subset.main(
            [
                sp,
                f"--text={text}",
                f"--output-file={dp}",
                "--layout-features=*",
                "--no-hinting",
                "--desubroutinize",
                "--drop-tables+=DSIG",
            ]
        )
        print(f"[subset] {dst} {os.path.getsize(dp) / 1024:.0f} KB")

    # 自检：确认没有缺字
    bold = os.path.join(OUT, "sub-bold.ttf")
    if os.path.exists(bold):
        cmap = set(TTFont(bold).getBestCmap().keys())
        missing = sorted(
            c for c in text if ord(c) not in cmap and c not in "\n\r\t"
        )
        if missing:
            print(f"[subset] ERROR missing glyphs: {''.join(missing)}")
            sys.exit(1)
        print("[subset] ok: no missing glyphs")


if __name__ == "__main__":
    main()
