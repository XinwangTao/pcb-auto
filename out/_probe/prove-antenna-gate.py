# 用法：python prove-antenna-gate.py [产物目录]
#   不给参数就用 v4 的产物目录（目录名带时间戳，会随 out\ 清理失效）。
#   这是 scripts/fabcheck.js 里 antenna.keepout* 判据的证明脚本，不是闸门本体。
# -*- coding: utf-8 -*-
"""证明 fabcheck 新增的 antenna.keepout 判据会失败（正向）且不会误报（特异性）。

不变式：
  I1  干净产物          → exit 0，有 antenna.keepout pass，无 antenna.keepout.copper
  I2  带内注入一条走线  → exit 1，阻断里有 antenna.keepout.copper（正对照）
  I3  带外注入同样走线  → exit 0，无 antenna.keepout.copper（特异对照；测的是"带内外"这个维度）
  I4  I2 与 I3 的差别只在注入的 y 坐标 —— 若两者结论相同，说明判据没在量它该量的东西
  I5  I1 的 d01 分母 > 0 —— 否则"带内 0 个"是空集合上的真命题
"""
import io, json, os, re, shutil, subprocess, sys, zipfile

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "out", "ESP32S3_Wireless_Mic_V4-20261126-185013")
NODE = r"E:\APP\nodejs24\node.exe"
FAB = os.path.join(ROOT, "scripts", "fabcheck.js")
WORK = r"F:\cache\temp\antenna-gate"

# 净空带（设计标称，mil→mm）：x 7.0104..26.0096，y -93.98..-93.726
# 坐标单位 = 1e-5 mm
IN_BAND = [("X1500000Y-9400000D02*", "X1500000Y-9350000D01*")]   # y -94.0 → -93.5 mm，横穿带
OUT_BAND = [("X1500000Y-5000000D02*", "X1500000Y-4500000D01*")]  # y -50.0 → -45.0 mm，远离带


def prep(tag, inject):
    d = os.path.join(WORK, tag)
    if os.path.isdir(d):
        shutil.rmtree(d)
    shutil.copytree(SRC, d)
    if inject:
        zp = os.path.join(d, "Gerber.zip")
        zin = zipfile.ZipFile(zp)
        items = [(i, zin.read(i.filename)) for i in zin.infolist()]
        zin.close()
        out = []
        touched = 0
        for info, data in items:
            if info.filename.upper().endswith(".GTL"):
                t = data.decode("utf-8", "replace")
                assert t.count("M02*") == 1, "GTL 里 M02* 不唯一: %d" % t.count("M02*")
                add = "".join("".join(pair) for pair in inject)
                t = t.replace("M02*", add + "M02*")
                touched += 1
                data = t.encode("utf-8")
            out.append((info, data))
        assert touched == 1, "没找到唯一 GTL: %d" % touched
        zo = zipfile.ZipFile(zp, "w", zipfile.ZIP_DEFLATED)
        for info, data in out:
            zo.writestr(info, data)
        zo.close()
    return d


def run(d):
    p = subprocess.run([NODE, FAB, d], capture_output=True, text=True, encoding="utf-8")
    return p.returncode, p.stdout


def pick(j, key):
    return [x for x in (j.get(key) or []) if str(x.get("id", "")).startswith("antenna")]


fails, lines = [], []
def ck(cond, msg):
    lines.append(("  OK   " if cond else "  FAIL ") + msg)
    if not cond:
        fails.append(msg)

for tag, inject, want_exit in (("clean", None, 0), ("band", IN_BAND, 1), ("ctrl", OUT_BAND, 0)):
    d = prep(tag, inject)
    code, out = run(d)
    try:
        j = json.loads(out)
    except Exception as e:
        ck(False, "%s: fabcheck 输出不是 JSON (%s)" % (tag, e))
        continue
    blockers = j.get("blockers") or []
    ids = [b.get("id") for b in blockers]
    an = pick(j, "blockers") + pick(j, "passes") + pick(j, "warnings") + pick(j, "notes")
    lines.append("  ── %s: exit=%d blockers=%d" % (tag, code, len(blockers)))
    if tag == "clean":
        ck(code == 0, "I1 clean exit 0（实测 %d）" % code)
        ck("antenna.keepout.copper" not in ids, "I1 clean 无 antenna.keepout.copper")
        ps = [x for x in (j.get("passes") or []) if x.get("id") == "antenna.keepout"]
        ck(len(ps) == 1, "I1 clean 有且仅有一条 antenna.keepout pass（实测 %d）" % len(ps))
        ev = ps[0].get("evidence") if ps else {}
        m = re.search(r"(\d+) 段 D01", ps[0]["msg"]) if ps else None
        d01 = int(m.group(1)) if m else 0
        ck(d01 > 0, "I5 分母 d01=%d > 0（空集合上的『带内 0 个』不算证据）" % d01)
        tot_seg = sum(x.get("segs", 0) for x in (ev.get("layers") or []) if x.get("copper"))
        ck(tot_seg == d01, "I5 evidence 里铜层线段合计 %d == 消息里的 %d" % (tot_seg, d01))
    elif tag == "band":
        ck(code == 1, "I2 band exit 1（实测 %d）" % code)
        ck("antenna.keepout.copper" in ids, "I2 band 阻断里有 antenna.keepout.copper（实有: %s）" % ",".join(ids))
        bl = [b for b in blockers if b.get("id") == "antenna.keepout.copper"]
        if bl:
            ev = bl[0].get("evidence") or {}
            lines.append("       hits=%s  例: %s" % (ev.get("hits"), (ev.get("examples") or [])[:1]))
            ck(int(ev.get("hits") or 0) >= 1, "I2 evidence.hits >= 1（实测 %s）" % ev.get("hits"))
    else:
        ck(code == 0, "I3 ctrl exit 0（实测 %d）" % code)
        ck("antenna.keepout.copper" not in ids, "I3 ctrl 无 antenna.keepout.copper（带外同形状走线不该报）")
        ps = [x for x in (j.get("passes") or []) if x.get("id") == "antenna.keepout"]
        ck(len(ps) == 1, "I3 ctrl 仍有 antenna.keepout pass（实测 %d）" % len(ps))

# I4：band 与 ctrl 的差异只能来自注入点
lines.append("")
print("\n".join(lines))
if fails:
    print("\n  PROVE=FAIL %d/%d" % (len(fails), len(lines)))
    for f in fails:
        print("     - " + f)
    sys.exit(1)
print("\n  PROVE=PASS  —— 带内注入必红、带外同形状不红、干净样本全绿且分母非空")
