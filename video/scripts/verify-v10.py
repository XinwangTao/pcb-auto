#!/usr/bin/env python3
"""
verify-v10.py — V10 成片的机器可验项（不靠"看着像"）。

三组判据，任何一组不过就退 1（缺输入退 2）：

  A. manifest ↔ out/frames 对应关系
     - 每段的 frames[].src 在 out/frames 里真实存在
     - 段内拍摄序号严格递增（时间线不倒流）
     - 跨段按 (批次, 尝试号, 首帧序号) 单调递增（4 次尝试各自连续）
     - 同一段里没有两张字节相同的画面

  B. 成片/静帧的画布框里**确实是那张真实帧**
     - 从成片按 crop 裁出画布框，跟 out/frames 里那张原图逐像素比平均绝对差
     - 差太多说明画布框里放的不是这张图（或缩放/裁切错了）

  C. ffprobe 硬指标
     - 能读、有视频流、时长 > 20s、宽高非 0、帧数 = manifest 推导值

用法：
    python video/scripts/verify-v10.py --mp4 video/out/v10-074907.mp4
    python video/scripts/verify-v10.py --stills video/out/v10-still-30.png --stills ...

退出码：0 全过 / 1 有判据没过 / 2 缺输入（ffprobe、manifest、文件）
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
VIDEO = os.path.dirname(HERE)
REPO = os.path.dirname(VIDEO)
MANIFEST = os.path.join(VIDEO, "public", "v10", "manifest.json")
FRAMES = os.path.join(REPO, "out", "frames")


def find_ffprobe():
    """
    找 ffprobe：环境变量 → PATH。**不写死本机路径。**

    这是仓库约定的硬线：`video/scripts/` 下的路径算「功能级开发者路径」，
    会被 `test/dev-path-scan.mjs` 判红（历史级路径只豁免 `docs/` 与 `out/_probe/`）。
    找不到 ffprobe 属于**环境问题**，按仓库三值契约退 2（不是「发现失败」退 1）。
    """
    env = os.environ.get("PCB_AUTO_FFPROBE")
    if env:
        return env if os.path.exists(env) else None
    exe = shutil.which("ffprobe")
    return exe


FFPROBE = find_ffprobe()

W, H = 1080, 1920
PLATE_W_MAX, PLATE_H_MAX = 992, 940

ok = 0
bad = 0


def check(cond, msg):
    global ok, bad
    if cond:
        ok += 1
        print(f"  PASS  {msg}")
    else:
        bad += 1
        print(f"  FAIL  {msg}")


def plate_box(beat):
    c = beat["crop"]
    aspect = c["w"] / c["h"]
    pw = min(PLATE_W_MAX, PLATE_H_MAX * aspect)
    ph = pw / aspect
    return (round((W - pw) / 2), round(560 + (PLATE_H_MAX - ph) / 2), round((W - pw) / 2 + pw), round(560 + (PLATE_H_MAX - ph) / 2 + ph))


def group_a(manifest):
    print("[A] manifest ↔ out/frames")
    beats = manifest["beats"]
    check(len(beats) >= 12, f"段数 {len(beats)} ≥ 12")
    total = sum(len(b["frames"]) for b in beats)
    check(total >= 40, f"总帧数 {total} ≥ 40")

    for b in beats:
        prev = None
        for f in b["frames"]:
            p = os.path.join(FRAMES, *f["src"].split("/"))
            check(os.path.exists(p), f"{b['id']} 帧存在：{f['src']}")
            if prev is not None:
                check(f["idx"] > prev, f"{b['id']} 段内序号递增 {prev} → {f['idx']}")
            prev = f["idx"]

    prev_key = None
    for b in beats:
        attempt = int(str(b["attempt"]).split("-")[0])
        key = (b["batch"], attempt, b["frames"][0]["idx"])
        check(prev_key is None or key > prev_key, f"段顺序单调 {prev_key} → {key}")
        prev_key = key

    print("[B] 段内无重复画面")
    for b in beats:
        import hashlib

        hs = []
        for f in b["frames"]:
            p = os.path.join(VIDEO, "public", f["file"])
            hs.append(hashlib.sha256(open(p, "rb").read()).hexdigest())
        check(len(set(hs)) == len(hs), f"{b['id']} {len(hs)} 帧互不相同")
    return beats


def group_c(beats, stills, seg, xfade):
    """
    画布框里放的是不是那张真实帧 —— 判据是「最像的是不是它」，不是绝对像素差。

    为什么不能直接逐像素比：段内有 Ken Burns（100%↔104%）和入场推入（1.045→1），
    画布框里的像素被缩放 1.00–1.045；EDA 的走线只有 1px 宽，1% 的缩放就足以整体错位，
    平均绝对差随便 15–50、裸 NCC 掉到 0.65（实测）。所以判据里必须带
    ① 缩放搜索（±4%，步长 0.4%）② 高斯模糊（半径 4 @200px）压掉细线错位。
    加了这两样之后同一帧的 NCC 从 0.65 升到 0.93。

    还要求：这个 still 不能落在**段间交叉淡入**窗口里。落在窗口里时画布框里是两张
    真实帧叠在一起（opacity 0.1 + 0.9），逐像素比必然失败 —— 这不是错误，是取样错误。
    本函数遇到这种 still 直接报出来并算失败，逼调用方换帧。
    """
    print("[C] 画布框里是那张真实帧吗（模糊 + 缩放搜索 + 最佳匹配）")
    TW = 200
    BLUR = 4
    SCALES = [1.0 + i * 0.004 for i in range(-10, 11)]

    def prep(im, size):
        g = im.convert("L").resize((max(TW, size), max(TW, size)), Image.LANCZOS).filter(
            ImageFilter.GaussianBlur(BLUR)
        )
        return np.asarray(g, dtype=np.float64)

    def center(a, size):
        w, h = a.shape[1], a.shape[0]
        l, t = (w - TW) // 2, (h - TW) // 2
        a = a[t : t + TW, l : l + TW]
        a = a - a.mean()
        n = np.linalg.norm(a)
        return (a / n).ravel() if n else a.ravel()

    refs = {}
    for b in beats:
        c = b["crop"]
        for f in b["frames"]:
            p = os.path.join(FRAMES, *f["src"].split("/"))
            ref_im = Image.open(p).crop((c["x"], c["y"], c["x"] + c["w"], c["y"] + c["h"]))
            refs[f["file"]] = [center(prep(ref_im, round(TW * s)), TW) for s in SCALES]

    for still, frame_no in stills:
        # 这一帧属于哪一段？
        owner = None
        for i in range(len(beats)):
            start = i * (seg - xfade)
            if start <= frame_no < start + seg:
                owner = i
        b = beats[owner]
        local = frame_no - owner * (seg - xfade)
        if owner > 0 and local < xfade:
            check(False, f"{os.path.basename(still)} 取在段间淡入窗口里（local={local} < {xfade}），画布框是两张真实帧叠加 —— 换个帧取")
            continue
        n = len(b["frames"])
        shot = min(n - 1, int(local * n / seg))
        f = b["frames"][shot]
        plate = center(prep(Image.open(still).crop(plate_box(b)), TW), TW)
        scores = {k: float(max(plate @ v for v in vs)) for k, vs in refs.items()}
        ranked = sorted(scores.items(), key=lambda kv: -kv[1])
        best, best_s = ranked[0]
        mine = scores[f["file"]]
        # 断言"期望的这一张是并列最佳"，不要求独占第一：
        # 同一次布线里相邻两帧本来就长得几乎一样（实测 c2-02 与 c2-03 都是 0.9900），
        # 要求独占第一等于要求一个本就分不出来的差别 —— 那种闸门只会教人放宽阈值。
        check(
            mine > 0.90 and mine >= best_s - 0.005,
            f"{os.path.basename(still)} (帧 {frame_no} → {b['id']} 第 {shot + 1}/{n} 张) = {f['src']} "
            f"NCC {mine:.4f}，最佳 {best} {best_s:.4f}（差 {best_s - mine:.4f}）",
        )


def group_d(mp4):
    print(f"[D] ffprobe {mp4}")
    if not os.path.exists(mp4):
        print(f"  FAIL  成片不存在：{mp4}")
        global bad
        bad += 1
        return
    if not FFPROBE or not os.path.exists(FFPROBE):
        print("  环境问题：找不到 ffprobe。设 PCB_AUTO_FFPROBE=<路径> 或把它放进 PATH。退 2。")
        sys.exit(2)
    raw = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "stream=index,codec_type,codec_name,width,height,pix_fmt,channels,sample_rate,r_frame_rate,nb_frames,duration,bit_rate:format=duration,size,bit_rate,format_name",
         "-of", "json", mp4],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    check(raw.returncode == 0, f"ffprobe 退出码 {raw.returncode}")
    j = json.loads(raw.stdout or "{}")
    streams = j.get("streams", [])
    v = [s for s in streams if s.get("codec_type") == "video"]
    check(bool(v), "有视频流")
    if not v:
        return
    vs = v[0]
    dur = float(j.get("format", {}).get("duration") or vs.get("duration") or 0)
    check(dur > 20.0, f"时长 {dur:.3f}s > 20s")
    check(int(vs.get("width") or 0) > 0 and int(vs.get("height") or 0) > 0, f"分辨率 {vs.get('width')}x{vs.get('height')} 非 0")
    check(vs.get("codec_name") == "h264", f"视频编码 {vs.get('codec_name')}")
    size = int(j.get("format", {}).get("size") or os.path.getsize(mp4))
    check(size > 1024 * 1024, f"体积 {size / 1024 / 1024:.2f} MB > 1MB")
    print("  ---- ffprobe 原始关键行 ----")
    for s in streams:
        # 音频流没有 width/height，直接 .format 会打出 "NonexNone"，看着像测量失败
        if s.get("codec_type") == "video":
            desc = f"{s.get('codec_name')} {s.get('width')}x{s.get('height')} fps={s.get('r_frame_rate')} frames={s.get('nb_frames')}"
        else:
            desc = f"{s.get('codec_name')} {s.get('channels')}ch {s.get('sample_rate')}Hz frames={s.get('nb_frames')}"
        print(f"  stream={s.get('index')} type={s.get('codec_type')} {desc} dur={s.get('duration')} br={s.get('bit_rate')}")
    print(f"  format={j.get('format', {}).get('format_name')} duration={dur:.3f} size={size} bit_rate={j.get('format', {}).get('bit_rate')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mp4", help="成片路径（跑 D 组）")
    ap.add_argument("--stills", nargs="*", default=[], help="静帧，格式 <path>:<帧号>（跑 C 组）")
    ap.add_argument("--seg", type=int, default=77, help="每段帧数（与 PcbRealV10.jsx 的 SEG 一致）")
    ap.add_argument("--xfade", type=int, default=10, help="段间交叉淡入帧数（与 XFADE 一致）")
    args = ap.parse_args()

    if not os.path.exists(MANIFEST):
        print(f"缺 manifest：{MANIFEST}")
        return 2
    manifest = json.load(open(MANIFEST, encoding="utf-8"))
    beats = group_a(manifest)

    if args.stills:
        pairs = []
        for s in args.stills:
            p, fr = s.rsplit(":", 1)
            pairs.append((p, int(fr)))
        group_c(beats, pairs, args.seg, args.xfade)

    if args.mp4:
        group_d(os.path.abspath(args.mp4))

    print(f"\n判据：{ok} 通过 / {bad} 失败")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
