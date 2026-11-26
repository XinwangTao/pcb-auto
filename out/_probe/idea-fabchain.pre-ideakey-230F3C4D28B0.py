# -*- coding: utf-8 -*-
"""对「想法生成」的每块板跑离线 DFM 普查，把链路补到「能不能直接下单」。

为什么用 fabcheck.js 而不是看 `_run.json.ok`：
`ok` 是流水线自己的判定，它只说"我的闸都过了"。
`fabcheck.js` 是**纯离线**的第三方视角：自己解 ZIP、手读 xlsx、解析 Gerber/Excellon，
只用 Node 内建模块，不调 EDA —— 它证明的是"制造文件本身自洽且可下单"。

选目录规则：同一想法有多个产物目录时，取**最后一次**尝试 ok=true 的那个；
都失败则取最后一次尝试。这样表里每一行都是"这块想法最终得到的东西"。

只读。不写任何产物。
"""
import io
import os
import re
import json
import subprocess

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
DES = os.path.join(ROOT, "designs")
OUT = os.path.join(ROOT, "out")
NODE = r"E:\APP\nodejs24\node.exe"
FAB = os.path.join(ROOT, "scripts", "fabcheck.js")
ATT = re.compile(r"^_run-(\d+)-[A-Za-z][\w.-]*\.json$")


def rj(p):
    try:
        return json.loads(io.open(p, encoding="utf-8-sig").read())
    except Exception:
        return None


def index():
    idx = {}
    for d in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, d)
        if not os.path.isdir(p):
            continue
        runs = [f for f in os.listdir(p) if ATT.match(f)]
        if not runs:
            continue
        runs.sort(key=lambda f: int(ATT.match(f).group(1)))
        j = rj(os.path.join(p, runs[-1])) or {}
        nm = j.get("designName")
        if not nm:
            continue
        key = (nm, (j.get("idea") or "").strip())
        # 同一个站，保留"末次 ok 优先、其次序号最大"
        cur = idx.get(key)
        cand = (1 if j.get("ok") is True else 0, int(ATT.match(runs[-1]).group(1)), d)
        if cur is None or cand[:2] > cur[:2]:
            idx[key] = cand
    return idx


def fabcheck(d):
    p = os.path.join(OUT, d)
    try:
        r = subprocess.run([NODE, FAB, p, "--quiet"],
                           capture_output=True, timeout=180)
    except Exception as e:
        return -1, "调用失败: %s" % e
    txt = (r.stdout or b"").decode("utf-8", "replace") + (r.stderr or b"").decode("utf-8", "replace")
    return r.returncode, txt.strip()


def main():
    idx = index()
    print("  ═══ 「想法 → 板 → 能不能下单」 ═══")
    print()
    hdr = "  %-3s %-56s %-34s %-6s %s" % ("#", "想法（逐字）", "产物目录", "ok", "fabcheck")
    print(hdr)
    print("  " + "-" * (len(hdr) - 2))
    rows = []
    for (nm, idea), (oklast, att, d) in sorted(idx.items(), key=lambda x: x[0][1]):
        code, txt = fabcheck(d)
        rows.append((idea, d, oklast, code, txt))
        last = [l for l in txt.split("\n") if l.strip()][-1:] or [""]
        print("  %-3d %-56s %-34s %-6s exit=%d"
              % (len(rows), idea[:56], d[:34], "是" if oklast else "否", code))
        if code != 0:
            for l in txt.split("\n")[:6]:
                if l.strip():
                    print("        " + l.strip()[:120])
    print()
    n = len(rows)
    fab_ok = sum(1 for r in rows if r[3] == 0)
    both = sum(1 for r in rows if r[2] and r[3] == 0)
    print("  汇总：%d 个不同想法" % n)
    print("    流水线判定 ok      : %d" % sum(1 for r in rows if r[2]))
    print("    fabcheck exit 0    : %d" % fab_ok)
    print("    两者都过（可下单） : %d" % both)
    print()
    print("  不可下单的逐个原因：")
    for idea, d, oklast, code, txt in rows:
        if code == 0:
            continue
        print("    · %s" % idea[:52])
        print("      %s" % d)
        for l in txt.split("\n"):
            if l.strip():
                print("        " + l.strip()[:130])
        print()


if __name__ == "__main__":
    main()
