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
import shutil
import subprocess
import sys
import time

# Windows 上 Python 往管道写时默认用本地代码页（英文系统 cp1252 / 中文 cp936）。
# cp1252 编码不了中文，本脚本一 print 就抛 UnicodeEncodeError 崩在中途，
# 于是整个量具返回非 0 —— 而中文 Windows 上永远复现不了。
# 入口处强制 UTF-8，让输出与代码页无关。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 仓库根：优先环境变量，否则从本文件位置推（out/_probe/<script>.py 的上两级）。
# **不要写死绝对路径。** 写死会让这个量具在被别人克隆后去量另一个目录，
# 而且不报错 —— 它会给出一份看起来正常的、属于别人的数字。
ROOT = os.environ.get("PCB_AUTO_ROOT") or os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ROOT = os.path.abspath(ROOT)
# node：优先 $PCB_AUTO_NODE，其次 PATH，最后退回命令名让系统去解析。
NODE = os.environ.get("PCB_AUTO_NODE") or shutil.which("node") or "node"
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

    # 时点必须是**文件里的字段**，不能只靠 mtime。
    # mtime 是文件系统属性：任何人 git clone 之后它都等于克隆时刻，
    # 于是文档里「测于 <某时刻>」这句话对每个读者都是错的，而且他无法察觉。
    # 字段跟着 blob 走，克隆/拷贝/checkout 都不会改它。
    _off = time.strftime("%z", time.localtime(now)) or "+0000"
    if len(_off) == 5:
        _off = _off[:3] + ":" + _off[3:]
    _measured_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)) + _off

    summary = {
        "generated_for": "pcb-auto 交付物可打样性普查",
        # 这份快照是什么时候测的。引用本文件的任何数字都要连同这个字段一起引。
        "measured_at": _measured_at,
        # 这几行是给**读这个文件的陌生人**看的，不是给作者看的。
        # 本文件被发布在公开仓库里，而它描述的是作者机器上 out\ 的现状。
        # 没有这段说明，一个全新克隆的人会看到「56 个目录 / 53 可下单」，
        # 然后在自己空空的 out\ 里跑同一条命令得到 0 —— 那是**正确答案**，
        # 但他会以为是自己装错了。这个仓库反复批评的正是这种
        # 「看起来正常的数字，其实描述的是别人的机器」。
        "corpus_scope": (
            "作者机器上 out\\ 下带 _run.json 的产物目录。"
            "这些数字**不是这份代码的属性**，而是一次测量。"
        ),
        "not_a_property_of_code": (
            "全新克隆里 out\\ 是空的，跑同一条命令会得到 0 个目录 —— "
            "那是正确答案，不是失败。要复现这些数字，得先跑出产物。"
        ),
        "reproduce": "node cli/pcb.mjs census --settle 180",
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

    # ── 零样本不许覆盖真测量 ─────────────────────────────────────────
    # `out/_probe/fab-census.json` 同时是**随仓库发布的证据**（交付-README.md
    # 里「53 个可打样 / 3 个有阻断」以它为来源）和这个脚本的输出路径。
    #
    # 于是在一个没有产物的克隆里跑一次，它会被改写成「0 个目录」：
    # 证据没了，`git status` 多一条 M，而 `0 个目录` 看起来像完美的成绩单。
    # smoke 第 8 组用「跑前备份、跑后还原」绕过了这件事 —— 那保护的是测试，
    # 不是用户。真正该保护的是**证据本身**。
    if not rows and os.path.exists(OUT):
        _old_n = 0
        try:
            with io.open(OUT, "r", encoding="utf-8") as _fh:
                _old_n = int((json.load(_fh).get("all") or {}).get("n") or 0)
        except Exception:
            _old_n = 0
        if _old_n:
            _empty_path = OUT[:-5] + ".empty.json" if OUT.endswith(".json") else OUT + ".empty.json"
            _tmp0 = _empty_path + ".tmp"
            with io.open(_tmp0, "wb") as _fh:
                _fh.write(json.dumps(summary, ensure_ascii=False, indent=2).encode("utf-8"))
                _fh.flush()
                os.fsync(_fh.fileno())
            os.replace(_tmp0, _empty_path)
            print("  没有可测量的产物目录（out/ 下没有带 _run.json 的目录）。")
            print("  这不是「全部可下单」，是**没有样本** —— 所以没有覆盖")
            print("    %s" % OUT)
            print("  它记录的是 %d 个目录，是随仓库发布的证据。" % _old_n)
            print("  本次的空结果写到了：%s" % _empty_path)
            print("  要一次真实测量，请先跑出产物（见 examples/README.md）。")
            return

    # 原子写：中途崩了也不能留下半截 JSON —— 那会让下游把残缺当完整。
    _tmp = OUT + ".tmp"
    with io.open(_tmp, "wb") as _fh:
        _fh.write(json.dumps(summary, ensure_ascii=False, indent=2).encode("utf-8"))
        _fh.flush()
        os.fsync(_fh.fileno())
    os.replace(_tmp, OUT)
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
