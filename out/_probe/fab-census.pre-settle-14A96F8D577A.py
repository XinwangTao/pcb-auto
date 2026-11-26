# -*- coding: utf-8 -*-
"""fab-census.py —— 对全部产物目录跑一遍离线 DFM 闸门（fabcheck.js），出可复算的普查。

为什么单独做：fabcheck.js 从来没接进流水线闸门（已知缺陷），但**不改流水线**也能拿它
做只读普查 —— 每目录约 100 ms。这样"这堆产物能不能直接下单"就有了全量答案，
而不是只在个别目录上跑过一次。

按**输入可信度分层**报（自述 ok=true / ok=false），并按批次日期分层，
因为这两层混在一起会得出相反的结论（详见台账 07:55 条）。

输出：out/_probe/fab-census.json
用法：python fab-census.py [--quiet]
"""
import io
import json
import os
import subprocess
import sys

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
NODE = r"E:\APP\nodejs24\node.exe"
FAB = os.path.join(ROOT, "scripts", "fabcheck.js")
OUT = os.path.join(ROOT, "out", "_probe", "fab-census.json")


def load(p):
    try:
        return json.loads(io.open(p, encoding="utf-8-sig").read())
    except Exception:
        return None


def main():
    quiet = "--quiet" in sys.argv
    outdir = os.path.join(ROOT, "out")
    dirs = []
    for name in sorted(os.listdir(outdir)):
        d = os.path.join(outdir, name)
        if not os.path.isdir(d):
            continue
        if not os.path.exists(os.path.join(d, "_run.json")):
            continue
        dirs.append(d)

    rows = []
    for i, d in enumerate(dirs, 1):
        run = load(os.path.join(d, "_run.json")) or {}
        try:
            p = subprocess.run([NODE, FAB, d],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               timeout=120)
            code = p.returncode
            raw = p.stdout.decode("utf-8", "replace")
        except Exception as e:
            code = None
            raw = ""
        blockers = []
        warnings = 0
        try:
            j = json.loads(raw)
            blockers = j.get("blockers") or []
            warnings = len(j.get("warnings") or [])
        except Exception:
            pass
        name = os.path.basename(d)
        # 批次日期从目录名的 -YYYYMMDD- 后缀取
        batch = ""
        parts = name.split("-")
        for seg in parts:
            if len(seg) == 8 and seg.isdigit():
                batch = seg
        rows.append({
            "dir": name,
            "batch": batch,
            "self_ok": run.get("ok"),
            "fab_exit": code,
            "blockers": [{"id": b.get("id"), "msg": b.get("msg")} for b in blockers],
            "n_blockers": len(blockers),
            "n_warnings": warnings,
        })
        if not quiet and i % 40 == 0:
            print("  ... %d/%d" % (i, len(dirs)))

    def tally(sub):
        return {
            "n": len(sub),
            "fab_ok": sum(1 for r in sub if r["fab_exit"] == 0),
            "fab_blocked": sum(1 for r in sub if r["fab_exit"] == 1),
            "fab_error": sum(1 for r in sub if r["fab_exit"] not in (0, 1)),
        }

    by_batch = {}
    for r in rows:
        by_batch.setdefault(r["batch"] or "(无)", []).append(r)

    summary = {
        "generated_for": "pcb-auto 交付物可打样性普查",
        "fabcheck_sha256_12": _sha(FAB),
        "all": tally(rows),
        "self_ok_true": tally([r for r in rows if r["self_ok"] is True]),
        "self_ok_false": tally([r for r in rows if r["self_ok"] is False]),
        "by_batch": {k: {
            "all": tally(v),
            "self_ok_true": tally([r for r in v if r["self_ok"] is True]),
        } for k, v in sorted(by_batch.items())},
        "blocked_but_self_ok": [
            {"dir": r["dir"], "blockers": r["blockers"]}
            for r in rows if r["self_ok"] is True and r["fab_exit"] != 0
        ],
        "blocker_ids": {},
        "rows": rows,
    }
    ids = {}
    for r in rows:
        for b in r["blockers"]:
            ids[b["id"]] = ids.get(b["id"], 0) + 1
    summary["blocker_ids"] = dict(sorted(ids.items(), key=lambda kv: -kv[1]))

    io.open(OUT, "wb").write(json.dumps(summary, ensure_ascii=False, indent=2).encode("utf-8"))
    a = summary["all"]
    print("  fabcheck 普查：%d 个目录，可打样 %d，有阻断 %d，解析错 %d"
          % (a["n"], a["fab_ok"], a["fab_blocked"], a["fab_error"]))
    t = summary["self_ok_true"]
    print("  自述 ok=true：%d 个，可打样 %d（%.1f%%）"
          % (t["n"], t["fab_ok"], 100.0 * t["fab_ok"] / t["n"] if t["n"] else 0))
    for k, v in summary["by_batch"].items():
        s = v["self_ok_true"]
        if s["n"]:
            print("    批次 %s：自述 ok=true %d，可打样 %d（%.1f%%）"
                  % (k, s["n"], s["fab_ok"], 100.0 * s["fab_ok"] / s["n"]))
    print("  阻断类型：" + ", ".join("%s×%d" % (k, v) for k, v in summary["blocker_ids"].items()))
    print("  → %s (%d B)" % (OUT, os.path.getsize(OUT)))


def _sha(p):
    import hashlib
    return hashlib.sha256(io.open(p, "rb").read()).hexdigest()[:12].upper()


if __name__ == "__main__":
    main()
