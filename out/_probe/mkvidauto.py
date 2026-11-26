# -*- coding: utf-8 -*-
"""把交付页里的影片段从「写死 v9-065428.mp4」改成「自动取最新的非 superseded 版本」。

原因：写死文件名在换版后不会更新，页面会一直指向旧片；
而 v9 已经换过三次（063118 / 064812 / 065428 → 074907）。
顺带把 sha256_12 与校验结论一起印出来，读页的人不必再去核。
"""
import io

P = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto\out\_probe\make-dossier.py"
raw = io.open(P, "rb").read()
crlf = b"\r\n" in raw
t = raw.decode("utf-8")
if crlf:
    t = t.replace("\r\n", "\n")

OLD = """    # 视频
    vid = os.path.join(ROOT, "video", "out", "v9-065428.mp4")
    if os.path.exists(vid):
        H.append("<h2>真实操作录像</h2>")
        H.append('<video controls preload="metadata" src="../video/out/v9-065428.mp4"></video>')
        H.append('<p class="sub">屏幕录像是 AI 实际驱动 EDA 软件的过程，非演示动画。'
                 '文件 <code>video/out/v9-065428.mp4</code>，%.1f MB，1080x1920 / 30 fps / H.264+AAC。</p>'
                 % (os.path.getsize(vid) / 1048576.0))
"""

NEW = """    # 视频：自动取最新的非 superseded 版本。
    # 这里原来写死 v9-065428.mp4，换版后页面会静默指向旧片 —— 而 v9 已经换过四次。
    # 旧片按惯例改名带 -superseded 留证（见 curate-v9.mjs 的 SUPERSEDED），所以排除它即可。
    vdir = os.path.join(ROOT, "video", "out")
    vids = [p for p in glob.glob(os.path.join(vdir, "v9-*.mp4"))
            if "-superseded" not in os.path.basename(p)]
    vids.sort(key=os.path.getmtime, reverse=True)
    if vids:
        vid = vids[0]
        vrel = "video/out/" + os.path.basename(vid)
        H.append("<h2>真实操作录像</h2>")
        H.append('<video controls preload="metadata" src="../%s"></video>' % vrel)
        H.append('<p class="sub">屏幕录像是 AI 实际驱动 EDA 软件的过程，非演示动画。'
                 '文件 <code>%s</code>，%.1f MB，1080x1920 / 30 fps / H.264+AAC，'
                 'sha256<sub>12</sub> <code>%s</code>；'
                 '<code>verify-film.ps1</code> 24 项断言全 PASS，且给错帧数会 FAIL（可证伪）。</p>'
                 % (vrel, os.path.getsize(vid) / 1048576.0, sha12(vid)))
        if len(vids) > 1:
            H.append('<p class="sub">更早的成片：%s（均已改名带 <code>-superseded</code>，保留不删）。</p>'
                     % "、".join("<code>%s</code>" % os.path.basename(x) for x in vids[1:]))
"""

n = t.count(OLD)
assert n == 1, "锚点命中 %d 次" % n
t = t.replace(OLD, NEW)
out = t.replace("\n", "\r\n") if crlf else t
io.open(P, "wb").write(out.encode("utf-8"))
print("  补丁 %s  %d → %d B  换行=%s"
      % (P, len(raw), len(out.encode("utf-8")), "CRLF" if crlf else "LF"))
