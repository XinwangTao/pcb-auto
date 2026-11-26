# -*- coding: utf-8 -*-
"""fab-census.py —— 对全部产物目录跑一遍离线 DFM 闸门（fabcheck.js），出可复算的普查。

为什么单独做：fabcheck.js 从来没接进流水线闸门（已知缺陷），但**不改流水线**也能拿它
做只读普查 —— 每目录约 100 ms。这样"这堆产物能不能直接下单"就有了全量答案，
而不是只在个别目录上跑过一次。

按**输入可信度分层**报（自述 ok=true / ok=false），并按批次日期分层，
因为这两层混在一起会得出相反的结论（详见台账 07:55 条）。

**在飞目录必须排除。** 07:43 那版普查里有一行记着「板框 30.78×42.40mm ≠ _run.json
20.32×15.24mm」，可那个目录 07:40:11 才创建、07:44:00 才写完 —— 普查拍在**构建中途**，
读到的是半写的 Gerber.zip 和一个还没回写完的 _run.json。四个这样的目录足以让
「可打样 206/217」这个数变成噪声。所以现在：目录里最新文件距今不足 `--settle` 秒
（默认 180）的，**整目录跳过并单独计数**，不参与任何比例。

**但 180 秒不够。** 实测单次尝试要 400 s（09:33 那次普查里 `AI_OLED_底板_5p5g6m-20261126-092206`
的最新写入距今 269 s，已经超过 180 s，于是被判「已沉淀」并收了进去 ——
而它当时正在跑第 2 次尝试，被算进去的是第 1 次的旧产物，贡献了 8 条阻断）。
所以再加一条**锁护栏**：`.pipeline.lock` 在手上时，凡是写入时间**晚于锁 start** 的目录
一律算在飞。判据从「多久以前写的」换成「是不是这一轮写的」，后者才和"构建中"同义。

输出：out/_probe/fab-census.json
用法：python fab-census.py [--quiet]
"""
import io
import json
import os
import subprocess
import sys
import time

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
NODE = r"E:\APP\nodejs24\node.exe"
FAB = os.path.join(ROOT, "scripts", "fabcheck.js")
OUT = os.path.join(ROOT, "out", "_probe", "fab-census.json")


LOCK = os.path.join(ROOT, ".pipeline.lock")


def lock_start():
    """读 .pipeline.lock 的 start= 时间戳（epoch 秒）。读不到就返回 None。

    刻意**不**去判断持锁进程是否还活着：在 Windows 上 `os.kill(pid, 0)` 不是探活，
    它是 TerminateProcess(handle, 0)，会把正在跑的流水线直接杀掉。宁可多算一个在飞。
    """
    if not os.path.exists(LOCK):
        return None
    try:
        txt = io.open(LOCK, encoding="utf-8", errors="replace").read()
    except OSError:
        return None
    for line in txt.splitlines():
        if line.startswith("start="):
            s = line[6:].strip()
            try:
                import datetime
                return datetime.datetime.fromisoformat(s).timestamp()
            except ValueError:
                return None
    return None


def load(p):
    try:
        return json.loads(io.open(p, encoding="utf-8-sig").read())
    except Exception:
        return None


def main():
    quiet = "--quiet" in sys.argv
    settle = 180
    if "--settle" in sys.argv:
        try:
            settle = int(sys.argv[sys.argv.index("--settle") + 1])
        except Exception:
            pass
    outdir = os.path.join(ROOT, "out")
    now = time.time()
    lst = lock_start()
    dirs = []
    mtime = {}
    in_flight = []
    for name in sorted(os.listdir(outdir)):
        d = os.path.join(outdir, name)
        if not os.path.isdir(d):
            continue
        if not os.path.exists(os.path.join(d, "_run.json")):
            continue
        # 目录里最新的文件时间 = 这个目录最后一次被写入的时刻
        newest = 0.0
        for fn in os.listdir(d):
            try:
                m = os.path.getmtime(os.path.join(d, fn))
            except OSError:
                continue
            if m > newest:
                newest = m
        age = now - newest
        if age < settle:
            in_flight.append({"dir": name, "age_s": round(age, 1), "why": "settle"})
            continue
        if lst is not None and newest >= lst:
            in_flight.append({"dir": name, "age_s": round(age, 1), "why": "locked"})
            continue
        mtime[d] = newest
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
            "newest_mtime": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(mtime[d])),
            "age_s": round(now - mtime[d], 1),
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
        "settle_s": settle,
        "in_flight": in_flight,
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
    if in_flight:
        n_settle = sum(1 for x in in_flight if x.get("why") == "settle")
        n_lock = len(in_flight) - n_settle
        print("  在飞跳过 %d 个（%d 个最新写入距今 < %ds；%d 个写入晚于锁 start，这一轮正在重构）"
              % (len(in_flight), n_settle, settle, n_lock))
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
