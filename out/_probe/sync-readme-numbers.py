# -*- coding: utf-8 -*-
"""把交付-README.md 的「核心数字」一节改成从量具现场生成。

为什么要有这个脚本：
    这些数字我手写过，于是它们漂移了三次，每次都漂成两份交付物互相矛盾：
      · 页面（当场生成）说 30 条想法 → 28 条可下单（93.3%）
      · README（手写于 08:43）说 30 → 26（86.7%）
    谁都没算错，是两个时刻。但读者只会看到矛盾。
    所以这一节不再是"写下来的"，而是"算出来的"。

输入（全部只读）：
    out/_probe/fab-census.json   离线 DFM 普查（--settle 的沉淀量）
    out/交付说明.html            想法级统计（由 make-dossier.py 生成）
    logs/overnight-*.log         结果行（设计运行级）
    out/ 目录                    磁盘现状
输出：
    改写 README 里 <!-- 核心数字:BEGIN --> 与 <!-- 核心数字:END --> 之间的内容。

用法：
    python sync-readme-numbers.py            # 生成并写回
    python sync-readme-numbers.py --dry      # 只打印，不写
"""
import io
import json
import os
import re
import sys
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "out")
PROBE = os.path.join(OUT, "_probe")
README = os.path.join(ROOT, "交付-README.md")
CENSUS = os.path.join(PROBE, "fab-census.json")
PAGE = os.path.join(OUT, "交付说明.html")
LOGDIR = os.path.join(ROOT, "logs")

BEGIN = "<!-- 核心数字:BEGIN -->"
END = "<!-- 核心数字:END -->"


def die(msg):
    sys.stderr.write("  [sync] 错误：%s\n" % msg)
    sys.exit(2)


def load_census():
    if not os.path.exists(CENSUS):
        die("缺少 %s，先跑 fab-census.py" % CENSUS)
    j = json.loads(io.open(CENSUS, encoding="utf-8").read())
    for k in ("all", "self_ok_true", "blocker_ids", "settle_s", "in_flight"):
        if k not in j:
            die("census 缺字段 %s（量具改过？）" % k)
    tm = datetime.datetime.fromtimestamp(os.path.getmtime(CENSUS))
    return j, tm


def page_idea_numbers():
    """想法级统计只能从页面读：那是 make-dossier.py 算的唯一真源。"""
    if not os.path.exists(PAGE):
        die("缺少 %s，先跑 make-dossier.py" % PAGE)
    h = io.open(PAGE, encoding="utf-8").read()
    m1 = re.search(r'不同想法</div><div class="big">(\d+)', h)
    m2 = re.search(r'做出了能下单的板</div><div class="big">(\d+)</div>'
                   r'<div class="lbl">([\d.]+)%', h)
    m3 = re.search(r'做出来但不合格</div><div class="big">(\d+)', h)
    m4 = re.search(r'正在构建</div><div class="big">(\d+)', h)
    m5 = re.search(r'还没轮到跑</div><div class="big">(\d+)', h)
    if not (m1 and m2 and m3 and m4 and m5):
        die("页面里找不到想法级四个数（页面结构变了，判据要跟着改）")
    return dict(n=int(m1.group(1)), ok=int(m2.group(1)), pct=m2.group(2),
                bad=int(m3.group(1)), fly=int(m4.group(1)), norun=int(m5.group(1)))


def disk_counts():
    total = withrun = withgerber = 0
    no_run_but_gerber = []
    for name in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, name)
        if not os.path.isdir(p) or name.startswith("_"):
            continue
        total += 1
        has_run = os.path.exists(os.path.join(p, "_run.json"))
        has_gerber = os.path.exists(os.path.join(p, "Gerber.zip"))
        if has_run:
            withrun += 1
        if has_gerber:
            withgerber += 1
        if has_gerber and not has_run:
            no_run_but_gerber.append(name)
    return total, withrun, withgerber, no_run_but_gerber


def log_stats():
    logs = [f for f in sorted(os.listdir(LOGDIR))
            if f.startswith("overnight-") and f.endswith(".log")]
    if not logs:
        return None
    raw = io.open(os.path.join(LOGDIR, logs[-1]), "rb").read().decode("utf-8", "replace")
    rows = re.findall(r"\[(\d\d:\d\d:\d\d)\]\s+(PASS|FAIL)\s+(\S+)\s+([\d.,]+)s", raw)
    if not rows:
        return None
    ok = sum(1 for r in rows if r[1] == "PASS")
    return dict(file=logs[-1], n=len(rows), ok=ok, fail=len(rows) - ok,
                pct="%.1f" % (100.0 * ok / len(rows)),
                designs=len(set(r[2] for r in rows)))


def build():
    j, tm = load_census()
    ideas = page_idea_numbers()
    total, withrun, withgerber, orphan = disk_counts()
    ls = log_stats()
    A = j["all"]
    S = j["self_ok_true"]
    blk = j["blocker_ids"] or {}
    inflight = len(j["in_flight"] or [])

    L = []
    L.append("以下为 **%s** 同一时刻跑出来的快照：离线 DFM 普查的时间戳是 `fab-census.json` 的 mtime，"
             "想法级统计由 `out\\交付说明.html` 当场生成，结果行来自循环日志。"
             % tm.strftime("%Y-%m-%d %H:%M"))
    L.append("**这一节由 `out\\_probe\\sync-readme-numbers.py` 生成，不要手改** —— "
             "手写过三次，三次都漂成了和页面互相矛盾的数字。")
    L.append("")
    L.append("- **%d 条去重后的中文想法** → **%d 条做成了可下单的板（%s%%）**；"
             "%d 条做出来但不合格、%d 条当时正在构建、%d 条还没轮到。"
             "来源：`out\\交付说明.html` 第 4 节（由 `make-dossier.py` 生成）。"
             % (ideas["n"], ideas["ok"], ideas["pct"],
                ideas["bad"], ideas["fly"], ideas["norun"]))
    L.append("- **%d 个产物目录**进了离线 DFM 普查，判 **%d 个可打样 / %d 个有阻断 / %d 个解析失败**。"
             "当时在飞被跳过 %d 个（`--settle %ss`）。来源：`out\\_probe\\fab-census.json`。"
             % (A["n"], A["fab_ok"], A["fab_blocked"], A["fab_error"],
                inflight, j["settle_s"]))
    L.append("  **这个 %d 的分母要说清**：同一刻磁盘上有 **%d 个产物目录**，"
             "其中 **%d 个有 `_run.json`**、%d 个有 `Gerber.zip`。"
             "普查只收「有 `_run.json` 且已沉淀」的，所以有 %d 个没有 `_run.json` 的目录不在里面。"
             % (A["n"], total, withrun, withgerber, total - withrun))
    if orphan:
        L.append("  其中 **%d 个是带完整 Gerber 的真产物**（%s），它们不是被误排除的杂项，"
                 "而是「早期跑法不写 `_run.json`」留下的测量盲区 —— 补测结果见「已知限制」第 1 条。"
                 % (len(orphan), "、".join("`%s`" % o for o in orphan)))
    if blk:
        names = {
            "gerber.coord.outside": "图元落在自己板框外",
            "pnp.outside": "贴片坐标出框",
            "gerber.copper.thin": "总铜图元数太少",
            "drill.outside": "钻孔出框",
            "gerber.traces.empty": "有焊盘但没有走线",
        }
        seg = "、".join("`%s` **%d** 条（%s）" % (k, v, names.get(k, "见 fabcheck.js"))
                       for k, v in sorted(blk.items(), key=lambda kv: -kv[1]))
        L.append("- 那 %d 个目录的 %d 条阻断**不是同一类**，共 %d 种：%s。"
                 % (A["fab_blocked"], sum(blk.values()), len(blk), seg))
        L.append("  **不是流水线没跑完**（两目录 `_run.json` 齐全、`ok=false`），"
                 "是几何自洽这一步没过。")
    L.append("- 自述 `ok=true` 的 **%d 个目录里 %d 个可打样（%s%%）**%s。"
             % (S["n"], S["fab_ok"],
                "%.1f" % (100.0 * S["fab_ok"] / S["n"]) if S["n"] else "0.0",
                "，没有反例" if S["fab_ok"] == S["n"] else ""))
    if ls:
        L.append("- 独立口径（设计运行级）：循环日志 `%s` 共 **%d 条结果行**，"
                 "**%d PASS / %d FAIL（%s%%）**，涉及 **%d 个设计名**。"
                 % (ls["file"], ls["n"], ls["ok"], ls["fail"], ls["pct"], ls["designs"]))
        L.append("  这是**另一个单位**：一条结果行 = 一个设计的一整轮（可能含 4 次策略重试），"
                 "和上面的「想法」「目录」都不能互换。")
    return "\n".join(L)


def main():
    dry = "--dry" in sys.argv
    body = build()
    raw = io.open(README, "rb").read()
    crlf = b"\r\n" in raw
    t = raw.decode("utf-8")
    if crlf:
        t = t.replace("\r\n", "\n")
    i0 = t.find(BEGIN)
    i1 = t.find(END)
    if i0 < 0 or i1 < 0 or i1 < i0:
        die("README 里找不到 %s / %s 标记（先插标记）" % (BEGIN, END))
    new = t[:i0 + len(BEGIN)] + "\n" + body + "\n" + t[i1:]
    if dry:
        print(body)
        return
    out = new.replace("\n", "\r\n") if crlf else new
    bad = [hex(ord(c)) for c in out if ord(c) < 32 and c not in "\n\r\t"]
    assert not bad, bad
    io.open(README, "wb").write(out.encode("utf-8"))
    print("  已写回 %s  %d B" % (README, os.path.getsize(README)))
    for ln in body.split("\n"):
        if ln.startswith("- "):
            print("  " + ln[:120])


if __name__ == "__main__":
    main()
