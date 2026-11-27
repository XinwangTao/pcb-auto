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
    # 同理：V11 的段标题在 public/v11/manifest.json，口播字幕在
    # public/voice_v11/timing.json（由 scripts/tts_v11.py 生成）—— 这两处也是文案真源，
    # 不扫就会漏字。V11 加「缝」字时就踩过一次：sub-*.ttf 缺字，渲染不报错，只是方框。
    patterns = (
        "src/*.jsx",
        "src/*.js",
        "src/**/*.jsx",
        "src/**/*.js",
        "src/data.json",
        "public/v10/manifest.json",
        "public/v11/manifest.json",
        "public/voice_v11/timing.json",
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

    # 自检：拦的是「源字体本来有的字，subset 里丢了」——那才会渲染成方框。
    #
    # 以前这里是「所有扫到的字都必须在 subset 里」，于是 ◻ ✓ 这类符号把闸门长期打红：
    # 微软雅黑根本没有 U+25FB / U+2713，V6/V7/V9 拿它们当占位框与对勾，浏览器会按
    # font-family 回退到 Segoe UI Symbol（渲染正常，不是豆腐块）。一条天天红的闸门
    # 等于没有闸门，所以这里把「源字体没有」和「subset 丢了」分开报：
    #   前者 → 提示，走系统字体回退；后者 → ERROR + 退出码 1。
    for src_name, sub_name in (("msyh-regular.ttf", "sub-regular.ttf"),
                               ("msyh-bold.ttf", "sub-bold.ttf")):
        sp = os.path.join(OUT, src_name)
        dp = os.path.join(OUT, sub_name)
        if not (os.path.exists(sp) and os.path.exists(dp)):
            print(f"[subset] SKIP self-check missing {sp} / {dp}")
            continue
        src_cmap = set(TTFont(sp).getBestCmap().keys())
        sub_cmap = set(TTFont(dp).getBestCmap().keys())
        expected = {c for c in text if ord(c) in src_cmap and c not in "\n\r\t"}
        missing = sorted(c for c in expected if ord(c) not in sub_cmap)
        fallback = sorted(c for c in text if ord(c) not in src_cmap and c not in "\n\r\t")
        if fallback:
            print(f"[subset] {sub_name}: {len(fallback)} 字源字体没有，走系统回退：{''.join(fallback)}")
        if missing:
            print(f"[subset] ERROR {sub_name} 丢了源字体有的字: {''.join(missing)}")
            sys.exit(1)
    print("[subset] ok: 源字体覆盖的字一个没丢")


if __name__ == "__main__":
    main()
