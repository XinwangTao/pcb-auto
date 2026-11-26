"""生成「AI 全自动设计 PCB」视频封面（竖版 1080x1920 + 横版 1920x1080）。

封面三要素（规范 §6）：**大字钩子 + 产品感 + 高对比**，不堆文字。
信息流里缩略图很小，小字等于不存在。

## 踩过的坑

- filter 里字体路径的盘号冒号必须写成 `\\:`，否则会被当参数分隔
- 单帧输出必须加 `-update 1`，否则 ffmpeg 报「image sequence」错
- 中文必须用 msyhbd.ttc（雅黑粗体）；用英文等宽字体会缺字变方块
"""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "out" / "covers"
# 封面底图：从真实录屏「布线完成」帧截取（红色板图对比度高，在信息流里抓眼）
# 不用 public/board 的导出图——那是灰白线框，缩略图里几乎看不见
SHOT = OUT / "_shot_final.png"

FONT_BOLD = "C\\:/Windows/Fonts/msyhbd.ttc"
FONT_REG = "C\\:/Windows/Fonts/msyh.ttc"
BG = "0x07090F"
ACCENT = "0x2ED3A0"
HOT = "0xFF6B35"
WHITE = "0xF5F7FA"
GREY = "0x8792A6"


def run(cmd: list[str]) -> None:
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0:
        print("ffmpeg stderr:", r.stderr[-900:])
        raise RuntimeError("ffmpeg 失败")


def vertical() -> Path:
    """竖版 1080x1920：顶部大字钩子，中部 PCB 实拍，底部卖点。"""
    dst = OUT / "cover-vertical.png"
    f = [
        f"color=c={BG}:s=1080x1920[bg]",
        # 录屏帧裁切：源 1122x796，板区约 x180~880 / y80~640。
        # 只取板区（不含顶部工具栏、底部图例栏），否则图例会和文字重叠。
        "[1:v]crop=680:560:200:90,scale=960:-1[screen]",
        "[bg][screen]overlay=(W-w)/2:672[base]",
        f"[base]drawtext=fontfile='{FONT_BOLD}':text='AI 自己':fontcolor={ACCENT}:fontsize=126:x=(w-text_w)/2:y=186[L1]",
        f"[L1]drawtext=fontfile='{FONT_BOLD}':text='画完了整块板':fontcolor={WHITE}:fontsize=142:x=(w-text_w)/2:y=330[L2]",
        f"[L2]drawtext=fontfile='{FONT_REG}':text='原理图 · 布局 · 布线 · DRC 全自动':fontcolor=0xC9D4E4:fontsize=52:x=(w-text_w)/2:y=530[L3]",
        # 板图区 672+~790=1462 结束，卖点条从 1500 起，留足间距
        f"[L3]drawtext=fontfile='{FONT_BOLD}':text='零人工干预':fontcolor={HOT}:fontsize=86:x=(w-text_w)/2:y=1516[L4]",
        f"[L4]drawtext=fontfile='{FONT_REG}':text='一句话 → 可直接打样的板子':fontcolor={GREY}:fontsize=46:x=(w-text_w)/2:y=1652[out]",
    ]
    run(["ffmpeg", "-y",
         "-f", "lavfi", "-i", "color=c=0x07090F:s=1080x1920:d=1",
         "-i", str(SHOT),
         "-filter_complex", ";".join(f),
         "-map", "[out]", "-frames:v", "1", "-update", "1", str(dst)])
    return dst


def horizontal() -> Path:
    """横版 1920x1080：左大字右 PCB，B站/微博用。"""
    dst = OUT / "cover-horizontal.png"
    f = [
        "[0:v]scale=1920:1080[bg]",
        "[1:v]crop=700:660:180:80,scale=880:-1[screen]",
        "[bg][screen]overlay=960:120[base]",
        f"[base]drawtext=fontfile='{FONT_BOLD}':text='AI 自己':fontcolor={ACCENT}:fontsize=98:x=90:y=270[H1]",
        f"[H1]drawtext=fontfile='{FONT_BOLD}':text='画完了整块板':fontcolor={WHITE}:fontsize=112:x=90:y=390[H2]",
        f"[H2]drawtext=fontfile='{FONT_REG}':text='原理图 · 布局 · 布线 · DRC':fontcolor=0xC9D4E4:fontsize=44:x=94:y=560[H3]",
        f"[H3]drawtext=fontfile='{FONT_REG}':text='全自动，零人工干预':fontcolor=0xC9D4E4:fontsize=44:x=94:y=624[H4]",
        f"[H4]drawtext=fontfile='{FONT_BOLD}':text='一句话 → 可打样':fontcolor={HOT}:fontsize=60:x=94:y=730[out]",
    ]
    run(["ffmpeg", "-y",
         "-f", "lavfi", "-i", "color=c=0x07090F:s=1920x1080:d=1",
         "-i", str(SHOT),
         "-filter_complex", ";".join(f),
         "-map", "[out]", "-frames:v", "1", "-update", "1", str(dst)])
    return dst


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    if not SHOT.is_file():
        print(f"缺少封面底图 {SHOT}")
        print("用这条命令生成：")
        print(r'  ffmpeg -y -ss 3.5 -i public\real\06_final.mp4 -frames:v 1 -update 1 out\covers\_shot_final.png')
        return 1
    for maker, label in ((vertical, "竖版 1080x1920"), (horizontal, "横版 1920x1080")):
        p = maker()
        print(f"{label}: {p}（{p.stat().st_size // 1024} KB）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
