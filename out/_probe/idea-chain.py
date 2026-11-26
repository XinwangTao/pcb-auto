# -*- coding: utf-8 -*-
"""把「一句中文想法 → 设计 JSON → 产物目录 → 判定」串成一张表。

为什么需要它：用户要的是"从一个想法到一块 PCB 的完整设计"，
而证据散在三处 —— `designs\\gen-*.json` 里的 `_idea` 字段、
该文件的 `name` 字段、以及 `out\\<dir>\\_run.json` 里的 `designName`。
三者之间**没有现成的映射**，而 `_run.json` 里根本不存设计文件路径，
所以文件→目录必须经 `designs\\<slug>.json` 的 `name` 字段中转。

口径（写在明处，否则数字不可复算）：
  * 一个设计文件对应内部名 `name`；
  * 一个产物目录属于它 ⟺ `_run.json.designName == name`；
  * 目录判定取最后一次尝试的 `_run-<N>-*.json`（N 最大者）的 `ok`；
  * 「做成过」= 该设计名下有任意目录 ok=true。

只读。不写任何产物。
"""
import io
import os
import re
import json
import glob

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
DES = os.path.join(ROOT, "designs")
OUT = os.path.join(ROOT, "out")
ATT = re.compile(r"^_run-(\d+)-[A-Za-z][\w.-]*\.json$")


def rj(p):
    try:
        return json.loads(io.open(p, encoding="utf-8-sig").read())
    except Exception:
        return None


def product_index():
    r"""(designName, idea) -> [ (dir, 最后尝试序号, ok, drcLeaf, lastfile) ]

    必须带 idea 一起做键：`designs\gen-rp2040.json`、`gen-rp2040-v2.json`、
    `gen-做一个-RP2040-….json` 三个文件共用同一个内部名 `AI_RP2040_系统_15pqy38`，
    只用 designName 匹配会把同一个目录记到三个设计名下 —— 分母就虚高了。
    `_run.json.idea` 与设计文件的 `_idea` 逐字相同，所以这个键是精确的。
    """
    idx = {}
    for d in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, d)
        if not os.path.isdir(p):
            continue
        runs = [f for f in os.listdir(p) if ATT.match(f)]
        if not runs:
            continue
        runs.sort(key=lambda f: int(ATT.match(f).group(1)))
        last = runs[-1]
        j = rj(os.path.join(p, last)) or {}
        nm = j.get("designName")
        if not nm:
            continue
        key = (nm, (j.get("idea") or "").strip())
        idx.setdefault(key, []).append(
            (d, int(ATT.match(last).group(1)), j.get("ok") is True,
             j.get("drcLeafCount"), last)
        )
    return idx


def main():
    idx = product_index()
    print("  产物索引：%d 个内部设计名" % len(idx))
    print()
    rows = []
    for f in sorted(glob.glob(os.path.join(DES, "gen-*.json"))):
        j = rj(f)
        if not j:
            continue
        idea = j.get("_idea") or j.get("idea") or ""
        nm = j.get("name") or ""
        cs = len(j.get("components") or [])
        cn = len(j.get("connections") or [])
        dirs = idx.get((nm, (idea or "").strip()), [])
        good = [x for x in dirs if x[2]]
        rows.append((os.path.basename(f), idea, nm, cs, cn,
                     j.get("boardWidthMil"), j.get("boardHeightMil"),
                     dirs, good))
    print("  %-46s %-26s %3s %3s %4s %5s %s"
          % ("设计文件", "内部名", "器件", "连接", "目录", "做成", "结论"))
    for (bn, idea, nm, cs, cn, w, h, dirs, good) in rows:
        verdict = "✓ 已做成" if good else ("× 试过没成" if dirs else "· 还没跑过")
        print("  %-46s %-26s %3d %3d %4d %5d %s"
              % (bn[:46], nm[:26], cs, cn, len(dirs), len(good), verdict))
    print()
    tot = len(rows)
    withdir = sum(1 for r in rows if r[7])
    madewith = sum(1 for r in rows if r[8])
    print("  汇总（按设计文件）：%d 个「想法生成」的设计文件；%d 个已被无人值守循环跑过；%d 个做出了板"
          % (tot, withdir, madewith))
    # 按「想法」去重：多个文件可能是同一句话的重复存档
    seen = {}
    for (bn, idea, nm, cs, cn, w, h, dirs, good) in rows:
        k = idea.strip()
        e = seen.setdefault(k, [0, 0, 0])
        e[0] += 1
        if dirs:
            e[1] += 1
        if good:
            e[2] += 1
    made = sum(1 for k, v in seen.items() if v[2] > 0)
    print("  汇总（按不同想法去重）：%d 个不同想法；%d 个被跑过；**%d 个做出了板**"
          % (len(seen), sum(1 for v in seen.values() if v[1]), made))
    print()
    print("  逐个想法：")
    for k, v in sorted(seen.items(), key=lambda x: (-x[1][2], x[0])):
        print("    %s  （%d 个文件 / 跑过 %d / 做出 %d）  %s"
              % ("✓" if v[2] else "×", v[0], v[1], v[2], k[:64]))
    print()
    for (bn, idea, nm, cs, cn, w, h, dirs, good) in rows:
        if not dirs:
            continue
        print("  ── %s" % bn)
        print("     想法（逐字）：%s" % idea)
        print("     板 %sx%s mil  器件 %d  连接 %d" % (w, h, cs, cn))
        for (d, natt, ok, leaf, lastf) in dirs:
            print("       %-46s 尝试 %d  末次 ok=%-5s drcLeaf=%s"
                  % (d[:46], natt, ok, leaf))
    print()
    print("  尚未被跑过的（= 第 4 轮才会进场的）：")
    for (bn, idea, nm, cs, cn, w, h, dirs, good) in rows:
        if not dirs:
            print("    · %s   [%sx%s, %d 器件]" % (bn, w, h, cs))


if __name__ == "__main__":
    main()
