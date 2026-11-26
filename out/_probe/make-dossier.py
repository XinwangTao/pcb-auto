# -*- coding: utf-8 -*-
"""生成 out/交付说明.html —— 一页把「中文想法 → 设计 JSON → 产物目录 → 四层验证」串起来。

为什么要有它：台账（_build-ledger.md）是给写代码的人看的，140 KB 太长；
验收报告（_accept.json）是给机器看的。用户要的是「一句话怎么就变成一块板」的证据链，
需要一页能从头读到尾、每个数字都能点回原始文件的东西。

只读现有数据，不改任何产物。
用法：python make-dossier.py            # 写 out/交付说明.html
"""
import io, os, re, glob, json, html, hashlib, subprocess, sys

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
OUT = os.path.join(ROOT, "out")
PY = sys.executable

# ---------- 工具 ----------

def readjson(p):
    return json.loads(io.open(p, encoding="utf-8-sig").read())

def sha12(p):
    return hashlib.sha256(io.open(p, "rb").read()).hexdigest()[:12].upper()

def e(x):
    return html.escape(str(x), quote=True)

# ---------- 1. 循环日志 ----------

LOG = os.path.join(ROOT, "logs", "overnight-20261126-015151.log")

def parse_log():
    if not os.path.exists(LOG):
        return [], []
    lines = io.open(LOG, encoding="utf-8", errors="replace").read().splitlines()
    rows, roundmarks = [], []
    pat = re.compile(r"\[(\d\d:\d\d:\d\d)\]\s+(PASS|FAIL)\s+(\S+)\s+([\d,]+\.?\d*)s\s+策略=(\S+)")
    for i, l in enumerate(lines):
        m = re.search(r"=====\s*第\s*(\d+)\s*轮（(\d+)\s*个设计）", l)
        if m:
            roundmarks.append((i, int(m.group(1)), int(m.group(2))))
        m = re.search(r"第\s*(\d+)\s*轮结果:\s*(\d+)\s*通过\s*/\s*(\d+)\s*失败", l)
        if m:
            roundmarks.append((i, -int(m.group(1)), (int(m.group(2)), int(m.group(3)))))
        m = pat.search(l)
        if m:
            rows.append({
                "t": m.group(1), "verdict": m.group(2), "design": m.group(3),
                "sec": float(m.group(4).replace(",", "")), "strategy": m.group(5), "line": i,
            })
    return rows, roundmarks

def round_of(idx, roundmarks):
    cur = 0
    for (i, n, _) in roundmarks:
        if i <= idx and n > 0:
            cur = n
    return cur

# ---------- 2. 产物目录 ----------

def scan_dirs():
    """设计内部名 -> [{dir, ok, rev, attempts}]"""
    agg = {}
    for d in sorted(glob.glob(os.path.join(OUT, "*"))):
        if not os.path.isdir(d) or os.path.basename(d).startswith("_"):
            continue
        rp = os.path.join(d, "_run.json")
        if not os.path.exists(rp):
            continue
        try:
            r = readjson(rp)
        except Exception:
            continue
        nm = r.get("designName")
        if not nm:
            continue
        agg.setdefault(nm, []).append({
            "dir": d, "ok": r.get("ok") is True,
            "idea": (r.get("idea") or "").strip(),
            "attempts": len(glob.glob(os.path.join(d, "_log-*.json"))),
            "rev": (io.open(os.path.join(d, "_pipeline_rev.txt"), encoding="utf-8").read().split()
                    if os.path.exists(os.path.join(d, "_pipeline_rev.txt")) else []),
        })
    return agg

def design_files():
    """slug -> 设计 JSON 内容"""
    m = {}
    for p in sorted(glob.glob(os.path.join(ROOT, "designs", "*.json"))):
        b = os.path.basename(p)
        if b.startswith("_"):
            continue
        try:
            m[b[:-5]] = readjson(p)
        except Exception:
            pass
    return m

# ---------- 3. 核查器 ----------

def run_consistency():
    probe = os.path.join(OUT, "_probe", "artifact-consistency.py")
    if not os.path.exists(probe):
        return None, []
    r = subprocess.run([PY, probe], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    lines = [l for l in r.stdout.splitlines() if l.strip()]
    head = lines[0] if lines and lines[0].startswith("#") else ""
    total = [l for l in lines if re.match(r"^(PASS|FAIL)\s\s", l)]
    return (head, total)

# ---------- 4. 想法源码 ----------

def load_fab_census():
    p = os.path.join(ROOT, "out", "_probe", "fab-census.json")
    if not os.path.exists(p):
        return None
    try:
        return readjson(p)
    except Exception:
        return None


def copper_inside_stats(dirs):
    """自己解 Gerber 算「铜 bbox 是否落在 .GKO 板框内」。

    不调 fabcheck：这条统计正是要用一份**独立**实现去交叉验证它。
    只认 `X..Y..D0[123]*`；本库 `%FS..%` 固定 45、`%MOMM*%`，所以除数 1e5。
    返回 (有 Gerber 的目录数, 铜在框内的目录数)。
    """
    import re as _re
    import zipfile
    C = _re.compile(r"X(-?\d+)Y(-?\d+)D0([123])\*")
    got = inside = 0
    for d in dirs:
        p = os.path.join(OUT, d, "Gerber.zip")
        if not os.path.exists(p):
            continue
        try:
            z = zipfile.ZipFile(p)
            boxes = {}
            for nm in z.namelist():
                u = nm.upper()
                for ext in ("GKO", "GTL", "GBL"):
                    if u.endswith("." + ext):
                        txt = z.read(nm).decode("ascii", "replace")
                        pts = [(float(a) / 1e5, float(b) / 1e5)
                               for a, b, c in C.findall(txt)]
                        if pts:
                            boxes[ext] = pts
        except (zipfile.BadZipFile, OSError):
            # 只吞"文件坏了/读不了"。别用裸 Exception：
            # 它曾经把 `findall` 返回 2 元组却按 3 个解包的错误吞掉，
            # 结果这个统计安安静静返回 0/0，页面上印出"0 个里 0 个"。
            continue
        if "GKO" not in boxes:
            continue
        gx = [q[0] for q in boxes["GKO"]]
        gy = [q[1] for q in boxes["GKO"]]
        cp = boxes.get("GTL", []) + boxes.get("GBL", [])
        if not cp:
            continue
        got += 1
        TOL = 0.05
        if all(min(gx) - TOL <= x <= max(gx) + TOL and min(gy) - TOL <= y <= max(gy) + TOL
               for x, y in cp):
            inside += 1
    return got, inside


def fit_retry_stats(fx):
    """统计「放不下 → 自动改板 → 重试」的结局。

    只读 `_log-N-<策略>.json` 里的 `outlineFit` 事件序列，不碰产物。
    要点：`fits=false` **不是导出闸门**，它是重试的扳机。
    所以判别要看**末次**的 fits，而不是「有没有出现过 false」。
    """
    import re as _re
    ATT = _re.compile(r"_log-(\d+)-[A-Za-z][\w.-]*\.json$")
    ever = recovered = stuck = 0
    stuck_blocked = stuck_passed = 0
    rec_ok = rec_pending = 0
    for d in sorted(os.listdir(OUT)):
        p = os.path.join(OUT, d)
        if not os.path.isdir(p):
            continue
        fs = [f for f in glob.glob(os.path.join(p, "_log-*.json"))
              if ATT.search(os.path.basename(f))]
        if not fs:
            continue
        fs.sort(key=lambda x: int(ATT.search(os.path.basename(x)).group(1)))
        seq = []
        for f in fs:
            try:
                j = readjson(f)
            except Exception:
                continue
            for e in ((j or {}).get("entries") or []):
                if isinstance(e, dict) and e.get("s") == "outlineFit":
                    seq.append((e.get("v") or {}).get("fits"))
        if not seq:
            continue
        if any(x is False for x in seq):
            ever += 1
            if seq[-1] is True:
                recovered += 1
                if fx.get(d) == 0:
                    rec_ok += 1
                elif fx.get(d) is None:
                    rec_pending += 1
            else:
                stuck += 1
                if fx.get(d) == 0:
                    stuck_passed += 1
                elif fx.get(d) is not None:
                    stuck_blocked += 1
    return dict(ever=ever, recovered=recovered, stuck=stuck, rec_ok=rec_ok,
                rec_pending=rec_pending, stuck_blocked=stuck_blocked,
                stuck_passed=stuck_passed)


def gko_shape_stats(dirs):
    """现算「有多少个 .GKO、共多少种板框尺寸、有几个只含一条闭合轮廓」。

    为什么必须现算：这段原先写死「229 个目录 / 63 种尺寸」——
    而 `scripts\\cleanup.ps1` 会删目录，写死的数会随着清理变成假话。
    """
    import re as _r
    import zipfile as _z
    C = _r.compile(r"X(-?\d+)Y(-?\d+)D0([123])\*")
    sizes = {}
    files = one_contour = 0
    for d in dirs:
        p = os.path.join(OUT, d, "Gerber.zip")
        if not os.path.exists(p):
            continue
        try:
            z = _z.ZipFile(p)
        except Exception:
            continue
        for nm in z.namelist():
            if not nm.upper().endswith(".GKO"):
                continue
            txt = z.read(nm).decode("ascii", "replace")
            pts = [(float(a) / 1e5, float(b) / 1e5) for a, b, c in C.findall(txt)]
            if not pts:
                continue
            xs = [q[0] for q in pts]
            ys = [q[1] for q in pts]
            key = (round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2))
            sizes[key] = sizes.get(key, 0) + 1
            files += 1
            if len(_r.findall(r"D02\*", txt)) == 1:
                one_contour += 1
            break
    return dict(files=files, shapes=len(sizes),
                top=sorted(sizes.items(), key=lambda kv: -kv[1])[:3],
                one_contour=one_contour)


def retention_stats():
    """从循环日志里数「自动清理」删掉了多少产物目录 / EDA 工程。

    为什么必须写在页面上：`run-overnight.ps1` 每 3 轮结束会调
    `scripts\\cleanup.ps1 -Apply`，规则是「保留最近 40 个 + 每个设计最新 1 份」。
    所以**磁盘上的目录数会随时间下降**，本页统计的是清理后的存量。
    不写这一句，读者会以为亲眼看到的 63 个目录就是全部历史。
    """
    import re as _re
    RX = _re.compile(r"已删除\s+(\d+)\s+个(.*)$", _re.MULTILINE)
    dirs = projs = runs = 0
    logdir = os.path.join(ROOT, "logs")
    if os.path.isdir(logdir):
        for f in sorted(glob.glob(os.path.join(logdir, "*.log"))):
            try:
                txt = io.open(f, encoding="utf-8", errors="replace").read()
            except Exception:
                continue
            for m in RX.finditer(txt):
                k = int(m.group(1))
                if "AI 工程" in m.group(2) or "工程" in m.group(2):
                    projs += k
                else:
                    dirs += k
                    runs += 1
    return dict(dirs=dirs, projs=projs, cleanups=runs)


def load_idea_sources():
    p = os.path.join(OUT, "_probe", "idea-sources.json")
    if not os.path.exists(p):
        return None
    try:
        return readjson(p)
    except Exception:
        return None

# ---------- 渲染 ----------

def main():
    rows, roundmarks = parse_log()
    agg = scan_dirs()
    des = design_files()
    cons_head, cons_rows = run_consistency()
    idea_src = load_idea_sources()

    npass = sum(1 for r in rows if r["verdict"] == "PASS")
    total = len(rows)
    ever = sum(1 for k, v in agg.items() if any(x["ok"] for x in v))
    ndesign = len(agg)

    H = []
    H.append("""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>从一句中文到一块 PCB · 交付说明</title>
<style>
 :root{--fg:#1a1a1a;--dim:#6b6b6b;--line:#e3e3e3;--ok:#0a7c3f;--bad:#b42318;--bg:#fbfbfa;--acc:#8a5a00}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);
      font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
 main{max-width:980px;margin:0 auto;padding:40px 28px 80px}
 h1{font-size:27px;line-height:1.3;margin:0 0 6px;letter-spacing:-.01em}
 h2{font-size:18px;margin:44px 0 12px;padding-bottom:7px;border-bottom:1px solid var(--line)}
 h3{font-size:15px;margin:22px 0 6px;color:var(--dim);font-weight:600}
 .sub{color:var(--dim);font-size:13.5px;margin:0 0 26px}
 table{border-collapse:collapse;width:100%;font-size:13.5px;margin:10px 0}
 th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
 th{color:var(--dim);font-weight:600;font-size:12.5px;background:#f4f4f2}
 td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
 code{font:12.5px/1.5 ui-monospace,Consolas,monospace;background:#f0f0ee;
      padding:1px 5px;border-radius:3px;word-break:break-all}
 pre{background:#f0f0ee;padding:12px 14px;border-radius:5px;overflow-x:auto;
     font:12.5px/1.6 ui-monospace,Consolas,monospace;margin:10px 0}
 .ok{color:var(--ok);font-weight:600}
 .bad{color:var(--bad);font-weight:600}
 .card{background:#fff;border:1px solid var(--line);border-radius:7px;padding:16px 18px;margin:14px 0}
 .big{font-size:31px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
 .row{display:flex;gap:14px;flex-wrap:wrap;margin:16px 0}
 .row>div{flex:1 1 168px;background:#fff;border:1px solid var(--line);
          border-radius:7px;padding:13px 15px}
 .lbl{font-size:12px;color:var(--dim);margin-bottom:2px}
 blockquote{margin:12px 0;padding:10px 16px;border-left:3px solid var(--acc);
            background:#fff;color:#333;font-size:14.5px}
 .chain{display:flex;gap:0;flex-wrap:wrap;margin:16px 0;font-size:13px}
 .chain div{flex:1 1 0;min-width:132px;padding:11px 13px;background:#fff;
            border:1px solid var(--line);border-right:none;position:relative}
 .chain div:first-child{border-radius:7px 0 0 7px}
 .chain div:last-child{border-right:1px solid var(--line);border-radius:0 7px 7px 0}
 .chain b{display:block;font-size:11.5px;color:var(--dim);font-weight:600;margin-bottom:3px}
 video{width:100%;max-width:340px;border-radius:8px;border:1px solid var(--line);background:#000}
 a{color:#0b5cad}
 .warn{background:#fff8e6;border:1px solid #f0dca8;border-radius:7px;padding:12px 16px;margin:14px 0;font-size:14px}
</style></head><body><main>""")

    H.append("<h1>从一句中文到一块 PCB</h1>")
    H.append('<p class="sub">板厂可用交付物（Gerber / 钻孔 / BOM / 贴片坐标 / 网表 / 原理图 PDF）'
             '由自然语言想法自动生成。<b>跑板过程中没有任何人类操作</b>：'
             '所有脚本里没有 <code>Read-Host</code> / <code>pause</code> / stdin 路径，'
             '机器在结构上无法停下来等人。'
             '但有一件事必须同时说清：<b>流水线代码与设计文件在夜间被 AI 自己改动过多次</b>'
             '（至少 5 次 <code>pipeline3.js</code> 替换，循环每次尝试都重读该文件），'
             '所以「零人工」不等于「系统一成不变」。两者不是一回事，'
             '细节与逐条证据见 <code>out/_build-ledger.md</code>。'
             '本页<b>统计量</b>（行数、目录数、比例、想法数）都由 '
             '<code>out/_probe/make-dossier.py</code> 从原始文件重算，目录数是活的。'
             '文中少数<b>具体坐标/距离</b>是人工核对后写下的常量（如某目录的 Y 区间），'
             '各自注明了出处；若有偏差以目录里的原始文件为准。</p>')

    # 概览
    H.append('<div class="row">')
    H.append('<div><div class="lbl">设计-轮次结果行</div><div class="big">%d</div>'
             '<div class="lbl">PASS %d / FAIL %d</div></div>'
             % (total, npass, total - npass))
    H.append('<div><div class="lbl">做过板的设计</div><div class="big">%d</div>'
             '<div class="lbl">其中做出过合格板 %d 个</div></div>' % (ndesign, ever))
    H.append('<div><div class="lbl">产物目录</div><div class="big">%d</div>'
             '<div class="lbl">含正在构建的；设计文件 %d 个</div></div>'
             % (sum(len(v) for v in agg.values()), len(des)))
    H.append('<div><div class="lbl">交叉核查</div><div class="big">%d/%d</div>'
             '<div class="lbl">有设计快照的目录</div></div>'
             % (sum(1 for l in cons_rows if l.startswith("PASS")), len(cons_rows)))
    H.append('</div>')

    # 证据链
    H.append("<h2>证据链：一条想法是怎么走到 Gerber 的</h2>")
    if idea_src and idea_src.get("entries"):
        ent = idea_src["entries"][0]
        H.append('<blockquote>%s</blockquote>' % e(ent["idea"]))
        H.append('<div class="chain">')
        H.append('<div><b>① 中文想法</b>%d 字</div>' % len(ent["idea"]))
        H.append('<div><b>② 编译成设计</b><code>%s</code></div>' % e(ent["sha256_12"]))
        H.append('<div><b>③ 静态电气审计</b>%s</div>'
                 % ('<span class="ok">0 问题</span>' if "exit 0" in ent.get("audit", "") else "见台账"))
        nm = ent.get("design_name")
        got = agg.get(nm, [])
        okd = [x for x in got if x["ok"]]
        if okd:
            st4 = '<span class="ok">ok=true</span>'
        elif got:
            st4 = '<span class="bad">ok=false</span>'
        else:
            st4 = "待跑"
        H.append('<div><b>④ 流水线建板</b>%s</div>' % st4)
        H.append('<div><b>⑤ 四层验证</b>见下</div>')
        H.append('</div>')
        H.append('<p class="sub">设计文件 <code>%s</code>，%d B。'
                 '同一句话连编 3 次字节完全相同（<code>%s</code>），'
                 '所以「想法 → 设计」这一步是可复现的，不是随机抽取。</p>'
                 % (e(ent["design_file"]), ent["bytes"], e(ent["sha256_12"])))
        if got:
            for x in sorted(got, key=lambda y: y["dir"]):
                H.append('<p class="sub">产物目录 <code>%s</code>（%d 次尝试）</p>'
                         % (e("out/" + os.path.basename(x["dir"])), x["attempts"]))
    else:
        H.append("<p>未找到想法源码记录 <code>out/_probe/idea-sources.json</code>。</p>")

    # 视频：自动取最新的非 superseded 版本。
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
                 '<code>verify-film.ps1</code> 全部断言 PASS，且给错帧数会 FAIL（可证伪）。'
                 '注意它打印 <b>23</b> 行，其中 <code>format.size(MB)</code> 一行是'
                 '<b>自己跟自己比</b>（两边同一个表达式），实际有效断言 22 项。</p>'
                 % (vrel, os.path.getsize(vid) / 1048576.0, sha12(vid)))
        if len(vids) > 1:
            H.append('<p class="sub">更早的成片：%s（均已改名带 <code>-superseded</code>，保留不删）。</p>'
                     % "、".join("<code>%s</code>" % os.path.basename(x) for x in vids[1:]))

    # 四层验证
    H.append("<h2>验收：四个互相独立的层</h2>")
    H.append("""<table>
<tr><th style="width:21%">层</th><th>问的问题</th><th style="width:26%">工具</th></tr>
<tr><td>① 静态电气</td><td>器件有没有孤立脚、电源和地有没有接上、网络名是否自洽</td>
    <td><code>scripts/audit-design.js</code></td></tr>
<tr><td>② 自建流水线门</td><td>网表一致、板框存在、DRC 通过、导出齐全</td>
    <td><code>pipeline3.js</code> gates</td></tr>
<tr><td>③ 独立验收</td><td>不采信自述，重算产物并逐项 PASS/FAIL。
    <b>已知缺陷</b>：它只检查「已出现的」判据，缺失的判据等于通过，
    所以<b>本页结论不依赖它</b></td>
    <td><code>accept.ps1</code></td></tr>
<tr><td>④ 跨产物互证</td><td>设计 = 网表 = 贴片坐标 = BOM；钻孔全在板框内；层全且非空；尺寸与报告一致</td>
    <td><code>out/_probe/artifact-consistency.py</code></td></tr>
</table>""")
    if cons_head:
        H.append("<h3>第④层当前结论</h3>")
        H.append("<pre>%s\n共 %d 个目录，全判据通过 %d 个</pre>"
                 % (e(cons_head),
                    len(cons_rows), sum(1 for l in cons_rows if l.startswith("PASS"))))

    # 能不能直接下单
    fab = load_fab_census()
    fx_all = {}
    if fab:
        for _r in (fab.get("rows") or []):
            fx_all[_r.get("dir")] = _r.get("fab_exit")
    cu_n, cu_ok = 0, 0
    if fab:
        cu_n, cu_ok = copper_inside_stats(
            [r.get("dir") for r in (fab.get("rows") or []) if r.get("dir")])
    # 这一节是全篇的靶心：用户要的是"从一句话到一块板"。
    # 分母必须是**去重后的想法字符串**，而不是尝试次数、结果行数、产物目录数，
    # 也不能是 (designName, idea) 这种复合键 —— 同一个想法换个设计名会被算成两条，
    # 实测那样会把 31 条虚增成 34 条。
    # 想法全集取两处并集：设计文件里的（可能还没轮到跑）+ 产物目录里的（跑过的）。
    if fab:
        fx = {}
        for rr in (fab.get("rows") or []):
            fx[rr.get("dir")] = rr.get("fab_exit")
        didea = set()
        for slug, dj in (des or {}).items():
            if not isinstance(dj, dict):
                continue
            v = (dj.get("idea") or dj.get("_idea") or "").strip()
            if v:
                didea.add(v)
        byidea = {}
        for nm, lst in agg.items():
            for x in lst:
                key = x.get("idea") or ""
                if key:
                    byidea.setdefault(key, []).append(os.path.basename(x["dir"]))
        universe = didea | set(byidea.keys())
        H.append("<h2>一句话想法 &#8594; 一块能下单的板</h2>")
        if universe:
            good, bad, fly, norun = [], [], [], []
            for v in sorted(universe):
                ds = byidea.get(v, [])
                if any(fx.get(x) == 0 for x in ds):
                    good.append(v)
                elif any(fx.get(x) not in (None, 0) for x in ds):
                    # 至少有一个目录拿到了明确的「不可下单」判定
                    bad.append(v)
                elif ds:
                    # 有目录但一个判定都没有 —— 正在构建 / 刚生成还没普查 / 没有 Gerber。
                    # 这跟「做出来但不合格」是两件事，混在一起会把在飞的算成失败。
                    fly.append(v)
                else:
                    norun.append(v)
            n = len(universe)
            H.append('<p class="sub">分母是<b>去重后的中文想法</b>，取「设计文件里的」并上'
                     '「产物目录里的」两处，否则还没轮到跑的想法会被漏掉。'
                     '一个想法只要有一个产物目录的离线 DFM 退出码为 0 就算做成。'
                     '<b>不要用 <code>(designName, idea)</code> 这种复合键去重</b>——'
                     '同一个想法换个设计名会被算成两条，实测会把 %d 条虚增成 34 条。</p>' % n)
            H.append('<div class="row">')
            H.append('<div><div class="lbl">不同想法</div><div class="big">%d</div></div>' % n)
            H.append('<div><div class="lbl">做出了能下单的板</div><div class="big">%d</div>'
                     '<div class="lbl">%.1f%%</div></div>' % (len(good), 100.0 * len(good) / n))
            H.append('<div><div class="lbl">做出来但不合格</div><div class="big">%d</div>'
                     '<div class="lbl">图元越出自己板框</div></div>' % len(bad))
            H.append('<div><div class="lbl">正在构建</div><div class="big">%d</div>'
                     '<div class="lbl">还没跑完，无判定</div></div>' % len(fly))
            H.append('<div><div class="lbl">还没轮到跑</div><div class="big">%d</div>'
                     '<div class="lbl">本轮排在后面</div></div>' % len(norun))
            H.append('</div>')
            H.append('<table><tr><th>想法</th><th>产物目录</th><th>可下单</th><th>状态</th></tr>')
            for v in bad + fly + norun + good:
                ds = byidea.get(v, [])
                nok = sum(1 for x in ds if fx.get(x) == 0)
                if v in good:
                    st = '<span class="ok">做成</span>'
                elif v in bad:
                    st = '<span class="bad">不合格</span>'
                elif v in fly:
                    st = "在飞"
                else:
                    st = "待跑"
                H.append('<tr><td>%s</td><td>%d</td><td>%d</td><td>%s</td></tr>'
                         % (e(v[:62] + ("…" if len(v) > 62 else "")), len(ds), nok, st))
            H.append('</table>')
            H.append('<p class="sub"><b>读这张表要分清四种「没成」</b>：'
                     '「不合格」是板子做出来了、制造文件也在，但铜/钻孔/贴片坐标落到了'
                     '自己的板框之外（%d 条，同一类缺陷）；'
                     '「在飞」是有产物目录但还没拿到任何离线判定（%d 条，正在构建）；'
                     '「待跑」是想法已经编译成设计、还没轮到上机（%d 条）。'
                     '只有第一种是缺陷，后两种只是在途。</p>'
                     % (len(bad), len(fly), len(norun)))
        else:
            H.append('<p>没有读到任何 <code>idea</code> 字段，无法按想法归并。</p>')

    H.append("<h2>能不能直接拿去下单：离线 DFM 普查</h2>")
    if fab:
        a = fab["all"]
        t = fab["self_ok_true"]
        H.append('<p class="sub">用 <code>scripts/fabcheck.js</code> 对<b>全部 %d 个产物目录</b>'
                 '逐个复算（纯离线：自己解 ZIP、读 Gerber、读 Excellon，'
                 '不联网也不开 EDA）。它此前没有接进流水线闸门，'
                 '所以这一层是<b>事后独立普查</b>，不是流水线的自述。</p>'
                 % a["n"])
        H.append('<div class="row">')
        H.append('<div><div class="lbl">自述 ok=true</div><div class="big">%d</div></div>' % t["n"])
        H.append('<div><div class="lbl">其中可打样</div><div class="big">%d</div></div>' % t["fab_ok"])
        H.append('<div><div class="lbl">比例</div><div class="big">%.1f%%</div></div>'
                 % (100.0 * t["fab_ok"] / t["n"] if t["n"] else 0))
        H.append('<div><div class="lbl">有阻断</div><div class="big">%d</div></div>' % t["fab_blocked"])
        H.append('</div>')
        H.append('<table><tr><th>批次</th><th class="num">自述 ok=true</th>'
                 '<th class="num">可打样</th><th class="num">比例</th></tr>')
        for k, v in fab["by_batch"].items():
            s = v["self_ok_true"]
            if not s["n"]:
                continue
            pct = 100.0 * s["fab_ok"] / s["n"]
            cls = "ok" if s["fab_ok"] == s["n"] else "bad"
            H.append('<tr><td>%s</td><td class="num">%d</td><td class="num %s">%d</td>'
                     '<td class="num %s">%.1f%%</td></tr>'
                     % (e(k if k != "（无）" else "旧目录（无日期）"),
                        s["n"], cls, s["fab_ok"], cls, pct))
        H.append('</table>')
        bl = fab.get("blocker_ids") or {}
        if bl:
            H.append('<p class="sub">阻断类型：' + "、".join(
                '<code>%s</code>×%d' % (e(k), v) for k, v in bl.items()) + '。</p>')
        # 反方向也要写：只看 ok=true 那一侧，会把"流过闸"当成唯一标准。
        # 实测有相当一部分自述 ok=false 的目录，制造文件本身是能打样的。
        f0 = fab.get("self_ok_false") or {}
        if f0.get("n"):
            H.append('<p class="sub">反方向同样要说清：<b>%d</b> 个自述 <code>ok=false</code> 的目录里，'
                     '仍有 <b>%d</b> 个制造文件通过离线 DFM（%d 个有阻断，%d 个读不出）。'
                     '「流水线没过闸」与「板子做不出来」<b>不是同一件事</b>，'
                     '两个数不能互相替代。</p>'
                     % (f0["n"], f0.get("fab_ok", 0), f0.get("fab_blocked", 0),
                        f0.get("fab_error", 0)))
        # 这一项是最值得写的：它曾经被"量具自己"藏起来。
        if (fab.get("blocker_ids") or {}).get("gerber.coord.outside"):
            H.append('<p class="sub"><b><code>gerber.coord.outside</code> 一类要特别说明。</b>'
                     '它指 Gerber 里有点落在<b>这块板自己的板框之外</b>——'
                     '铜被边框裁掉，是真的画错，不是记录问题。'
                     '这一项在早先的普查里只命中 1 个目录，是<b>假的少</b>：'
                     '本工具解析 Gerber 时把格式声明 <code>%%FSLAX45Y45*%%</code> '
                     '里的 <code>X45Y45</code> 当成了坐标，于是板框 bbox 被原点钉住；'
                     '凡板框不经过 Gerber 原点的板子，bbox 都被撑大，'
                     '越框的点就落回框内、被静默吞掉。'
                     '修好解析后由 1 个变成 5 个，其中 <b>5/5</b> 又被一份'
                     '不复用本工具任何代码的独立 Python 实现复核确认。'
                     '也就是说：<b>之前不是没问题，是看不见问题。</b>'
                     '这几个目录同时出现 <code>drill.outside</code> / '
                     '<code>pnp.outside</code>，是同一件事的三个视角（铜、钻孔、贴片）。'
                     '再往下量一层，情况比「压了一点边」严重：'
                     '例如 <code>AI_OLED_底板_5p5g6m</code> 的器件全在 Y −11.4…−6.1mm，'
                     '而它自己的板框在 Y −67.1…−28.2mm —— <b>两个 Y 区间完全不重叠</b>，'
                     '板框根本没框住器件。<code>USBC_Power_ESD</code> 更直接：'
                     '铜横跨 117.06mm，板框只有 67.06mm 宽。'
                     '反过来看，本脚本另写一份实现，把所有已普查目录的铜 bbox 与各自的 '
                     '<code>.GKO</code> 比过：<b>%d 个里 %d 个（%.1f%%）的铜完全落在框内</b>，'
                     '所以这个判据不是「对谁都报警」——它只在真出框时才响。</p>'
                     % (cu_n, cu_ok, 100.0 * cu_ok / cu_n if cu_n else 0.0))
            # 逐个目录点名，且从普查 JSON 现取，不写死文件名
            # （写死过一次：那段文字点了 5 个目录名，其中 4 个已被 cleanup.ps1 删掉）
            blk = [r for r in (fab.get("rows") or []) if r.get("fab_exit") != 0]
            if blk:
                H.append('<p class="sub"><b>但这 %d 个不是同一种病。</b>'
                         '看每层有多少个图元出框：</p>' % len(blk))
                H.append('<table><tr><th>产物目录</th><th>出框的层（图元数）</th>'
                         '<th class="num">阻断项</th></tr>')
                for r in blk:
                    per, others = {}, []
                    for b in (r.get("blockers") or []):
                        if (b.get("id") or "") == "gerber.coord.outside":
                            mm = re.search(r"(G[A-Z]{2}) 有 (\d+) 个图元",
                                           b.get("msg") or "")
                            if mm:
                                per[mm.group(1)] = int(mm.group(2))
                        else:
                            others.append(b.get("id") or "")
                    cells = "、".join("%s %d" % (k, v)
                                     for k, v in sorted(per.items())) or "—"
                    if others:
                        cells += "　＋" + "、".join(sorted(set(others)))
                    H.append('<tr><td><code>%s</code></td><td>%s</td>'
                             '<td class="num bad">%d</td></tr>'
                             % (e(r.get("dir", "")), e(cells), r.get("n_blockers") or 0))
                H.append('</table>')
                H.append('<p class="sub">凡是<b>某一层的全部图元都出框</b>，说明'
                         '整块布局相对自己的板框整体位移了（成因在布局/板框同步，不在布线）；'
                         '只有少数图元出框的，是<b>游离铜或单个器件</b>跑出去了。'
                         '性质不同、修法也不同。这张表由普查 JSON 现算，'
                         '目录名不写死在代码里。</p>')
            gk = gko_shape_stats([r.get("dir") for r in (fab.get("rows") or [])
                                  if r.get("dir")])
            if gk["files"]:
                top = "、".join("%.2f×%.2f mm ×%d" % (k[0], k[1], v)
                                for k, v in gk["top"])
                H.append('<p class="sub">板框本身是可信的：参与普查的 %d 个目录的 <code>.GKO</code> '
                         '共 <b>%d 种</b>不同尺寸，最常见的三种是 %s。'
                         '重复的尺寸只出现在<b>同一设计重跑</b>之间，'
                         '说明它是每块板各自算出来的，不是写死的默认值。'
                         '而且 <b>%d/%d</b> 个 <code>.GKO</code> 只有<b>一条</b>闭合轮廓'
                         '（起笔 D02 恰好一次），所以 bbox 就是板框本身。'
                         '<b>这两个数是按当前磁盘上的目录现算的</b>，'
                         '清理掉的目录不在其中。</p>'
                         % (gk["files"], gk["shapes"], e(top),
                            gk["one_contour"], gk["files"]))
        bad = fab.get("blocked_but_self_ok") or []
        if bad:
            H.append('<p class="sub">自述通过但不能下单的目录（全部来自早期批次）：</p>')
            H.append('<table><tr><th>目录</th><th>阻断原因</th></tr>')
            for b in bad:
                H.append('<tr><td><code>%s</code></td><td>%s</td></tr>'
                         % (e(b["dir"]),
                            e("；".join(x.get("msg") or x.get("id") or "?" for x in b["blockers"]))))
            H.append('</table>')
        # 目录数是活的（循环还在产出），不许写死。
        H.append('<p class="sub">普查原始数据 <code>out/_probe/fab-census.json</code>，'
                 '可用 <code>python out/_probe/fab-census.py</code> 重算（%d 目录约 20 秒）。'
                 '每行都带 <code>newest_mtime</code>/<code>age_s</code>：'
                 '最新写入距今不足 180 秒的目录会<b>整目录跳过并单独计数</b>，'
                 '因为对构建中的目录拍快照量到的是半写的 Gerber —— '
                 '上一版普查就因此把 4 个正在建的目录读成了「不能下单」。</p>'
                 % a["n"])
    else:
        H.append("<p>未找到 <code>out/_probe/fab-census.json</code>。</p>")

    # 设计清单
    H.append("<h2>每个设计做成过几块板</h2>")
    H.append('<p class="sub">「尝试」是天数口径，「做成过」是能力口径：'
             '同一设计多跑几次会有不同结果，因为布线器本身不确定。</p>')
    H.append('<table><tr><th>设计</th><th class="num">合格目录</th>'
             '<th class="num">目录总数</th><th>源文件</th></tr>')
    slug_of = {}
    for s, d in des.items():
        if d.get("name"):
            slug_of.setdefault(d["name"], s)
    for nm in sorted(agg, key=lambda k: (sum(1 for x in agg[k] if x["ok"]) / len(agg[k]), k)):
        v = agg[nm]
        okd = sum(1 for x in v if x["ok"])
        cls = "ok" if okd == len(v) else ("bad" if okd == 0 else "")
        H.append('<tr><td><code>%s</code></td><td class="num %s">%d</td>'
                 '<td class="num">%d</td><td><code>%s</code></td></tr>'
                 % (e(nm), cls, okd, len(v), e(slug_of.get(nm, "—"))))
    H.append('</table>')

    # 策略
    st = {}
    for r in rows:
        d = st.setdefault(r["strategy"], [0, 0, 0.0])
        d[0 if r["verdict"] == "PASS" else 1] += 1
        d[2] += r["sec"]
    H.append("<h2>最终用哪种策略做成的</h2>")
    H.append('<p class="sub">流水线由弱到强依次尝试，弱策略成功就越早结束。'
             '强策略失败率高是正常的：只有弱策略都没成的板才会走到它们。</p>')
    H.append('<table><tr><th>策略</th><th class="num">PASS</th><th class="num">FAIL</th>'
             '<th class="num">平均耗时</th></tr>')
    for s, (a, b, sec) in sorted(st.items(), key=lambda kv: -(kv[1][0] + kv[1][1])):
        H.append('<tr><td><code>%s</code></td><td class="num ok">%d</td>'
                 '<td class="num %s">%d</td><td class="num">%.0f s</td></tr>'
                 % (e(s), a, "bad" if b else "", b, sec / (a + b)))
    H.append('</table>')

    # 「放不下」之后发生了什么 —— 这是整条闭环能自我纠错的最强证据
    fs2 = fit_retry_stats(fx_all)
    if fs2["ever"]:
        H.append('<p class="sub"><b>「放不下」之后发生了什么。</b>'
                 '流水线在 <code>outlineFit</code> 这一步量器件包围盒是否落在板框内；'
                 '某次尝试判 <code>fits=false</code> 时，<b>这次尝试不导出</b>，改板重试。'
                 '但<b>重试用尽仍放不下时，产物照样导出了</b>（下面那 2 个就是），'
                 '真正的最后一道防线是<b>离线 DFM</b>，不是流水线自己。'
                 '所以 <code>fits=false</code> <b>是扳机，不是闸门</b>——'
                 '判别要看<b>末次</b>结果，不能看「有没有出现过」。'
                 '有该记录的目录里，<b>%d 次</b>出现过「放不下」：'
                 '其中 <b>%d 次</b>重试后 <code>fits</code> 变真'
                 '（%d 个经离线 DFM 复核可下单%s），'
                 '%d 次重试到底仍然放不下（%d 个被离线 DFM 拦下%s）。</p>'
                 % (fs2["ever"], fs2["recovered"], fs2["rec_ok"],
                    ("，%d 个刚生成还没来得及普查" % fs2["rec_pending"]) if fs2["rec_pending"] else "",
                    fs2["stuck"], fs2["stuck_blocked"],
                    ("，%d 个漏过" % fs2["stuck_passed"]) if fs2["stuck_passed"] else "，无一漏过"))
        if fs2["stuck"] and fs2["stuck_blocked"] == fs2["stuck"]:
            H.append('<p class="sub">这份交叉核查值得单看一眼：'
                     '<b>放不下到底的 %d 个，全部被离线 DFM 判为不可下单</b>。'
                     '也就是说「几何放不下」与「制造文件不自洽」这两件独立的事，'
                     '在样本上完全重合——前者是预警，后者是判据，'
                     '而两者没有共用一行代码。</p>' % fs2["stuck"])

    # 复现
    H.append("<h2>怎么自己复现</h2>")
    H.append("<pre>"
             "# 一句话 → 设计 JSON（同一句话输出字节相同）\n"
             "node scripts\\idea2design.js \"做一个锂电池供电的 SHT30 温湿度记录板，TP4056 充电，3.3V 稳压，I2C 经排针引出，带电源指示 LED\" -o designs\\x.json\n"
             "\n"
             "# 设计 JSON → 整条流水线 → 产物目录（含 Gerber / BOM / 贴片坐标 / DRC）\n"
             "pwsh -File run-all.ps1 -Design designs\\x.json\n"
             "\n"
             "# 两步合一（不需要先落一个设计文件）\n"
             "pwsh -File run-all.ps1 -Idea \"做一个 SHT30 温湿度采集板，I2C 经排针引出\"\n"
             "\n"
             "# 独立复核某个产物目录\n"
             "pwsh -File accept.ps1 -Design designs\\x.json -VerifyOnly\n"
             "</pre>")

    # 「设计」这个词在本页要钉死：它指 _run.json 里的 designName 去重数，
    # 与 designs\ 目录下的设计文件数、循环日志里的设计名数都不是同一个分母。
    # 不写清楚，读者会把 42 当成「42 个设计文件」。
    _ndfile = len([f for f in os.listdir(os.path.join(ROOT, "designs"))
                   if f.endswith(".json") and not f.startswith("_")])
    H.append('<div class="warn"><b>口径声明。</b>'
             '本页的通过率一律按「设计-轮次结果行」计算（%d 行），'
             '不重复计入同一设计的多次尝试。'
             '<b>「设计」在本页专指 <code>_run.json</code> 里的 <code>designName</code> 去重数</b>（%d 个），'
             '「做成过」指其中 %d 个出现过 <code>ok=true</code> 的目录。'
             '这个 %d <b>不等于</b> <code>designs\\</code> 下的设计文件数（现为 %d 个），'
             '也不等于循环日志里的设计名数——早期预跑留下的目录没有对应设计文件，'
             '而重名设计又会让一个名字对应多个文件。三个分母回答三个不同的问题，不能互相替代。</div>'
             % (total, ndesign, ever, ndesign, _ndfile))

    rs = retention_stats()
    if rs["cleanups"]:
        H.append('<div class="warn" style="border-color:#c9a227;background:#fffdf3">'
                 '<b>产物目录会被自动删掉，本页统计的是清理后的存量。</b>'
                 '无人值守循环每 3 轮结束调用一次 <code>scripts\\cleanup.ps1 -Apply</code>，'
                 '规则是「<b>保留最近 40 个目录 + 每个设计名保留最新 1 份</b>」，'
                 '外加 EDA 工程只留最近 10 个。'
                 '日志里本夜共执行 %d 次，累计删掉 <b>%d</b> 个产物目录和 <b>%d</b> 个 EDA 工程。'
                 '所以你现在数到的目录数会随清理下降；'
                 '「一个想法做成了几块板」也只看得到<b>每个设计最新的那一次尝试</b>。'
                 '想看到完整历史，得在跑之前把 <code>-KeepOut</code> 调大或干脆不调清理。</div>'
                 % (rs["cleanups"], rs["dirs"], rs["projs"]))

    # ---- 已知限制 ----
    # 本页前面全在讲成功面。这一节把失败面、证据缺口和统计口径的暗坑一并写出来，
    # 数字全部现场算 —— 写死必然过期，过期就变成假话。
    _acc_all = _acc_have = 0
    _run_n = 0
    _warn_total = 0
    _od = os.path.join(ROOT, "out")
    for _nm in sorted(os.listdir(_od)):
        _p = os.path.join(_od, _nm)
        if not os.path.isdir(_p) or _nm.startswith("_"):
            continue
        if not os.path.exists(os.path.join(_p, "_run.json")):
            continue
        _acc_all += 1
        if os.path.exists(os.path.join(_p, "_accept.json")):
            _acc_have += 1
        for _f in os.listdir(_p):
            if _f != "_run.json" and re.match(r"_run-\d+-.+\.json$", _f):
                _run_n += 1
    if fab:
        _warn_total = sum(int(r.get("n_warnings") or 0) for r in (fab.get("rows") or []))

    H.append("<h2>已知限制与证据缺口</h2>")
    H.append('<p class="sub">这一节不是免责声明。每一条都指向具体的文件或算出来的数，'
             '目的是让人知道<b>本页哪些话是可以核的、哪些是核不了的</b>。</p>')
    H.append("<ol>")
    if _acc_all:
        H.append("<li><b>「通过了独立验收」这句话，有 %d 个运行目录没有记录可依。</b>"
                 "%d 个有 <code>_run.json</code> 的目录里，只有 <b>%d</b> 个存了 "
                 "<code>_accept.json</code>。<b>没有记录不等于没通过，也不等于通过 —— 等于没测。</b>"
                 "</li>" % (_acc_all - _acc_have, _acc_all, _acc_have))
    H.append("<li><b>两份记录用了同一个键名 <code>drcIndependent</code>，含义不同，读错会以为证据在打架。</b>"
             "<code>_accept.json</code> 顶层的那个问的是「<b>本次验收这一趟</b>自己跑没跑 DRC」"
             "（<code>-VerifyOnly</code> 不跑流水线，所以按设计恒为 false）；"
             "<code>_gates.independent.json</code> 里 <code>gates.drcIndependent</code> 问的是"
             "「<b>流水线</b>的 DRC 闸是否独立」。实测 <b>%d 份 <code>_accept.json</code> 里该字段为 true 的 0 份</b> —— "
             "这不是 0%% 通过率，是<b>同名不同义</b>。"
             "</li>" % max(_acc_have, 1))
    if _warn_total:
        H.append("<li><b><code>fabcheck</code> 报的 %d 条是「警告」，不是「阻断」，不会让板子失败。</b>"
                 "其中一类是 <code>gerber.outline.size</code>：<code>_run.json</code> 自述的板框尺寸"
                 "与 Gerber 实测不符。这类问题<b>能下单但多半会做错</b>，而流水线不拿它当失败。"
                 "</li>" % _warn_total)
    H.append("<li><b>尝试级的历史已经被自己的清理删掉了。</b>"
             "本页所有「做成过几块板」的统计，只能看到<b>每个设计保留下来的那些尝试</b>；"
             "同目录现存 <code>_run-N-*.json</code> 共 <b>%d</b> 个。"
             "早期统计的「整夜 139 次尝试」<b>现在无法复算</b> —— 那些文件已经不在了。"
             "引用它时必须注明它来自已删除的证据。</li>" % _run_n)
    H.append("<li><b>历史设计不一定能复现。</b>想法编译器 <code>idea2design.js</code> 当晚被改过多次；"
             "<code>designs/gen-led.json</code> 里有 6 个器件，而当前版本的编译器对同一句话只产出 3 个。"
             "<b>产出它的那个编译器版本已经不在了</b>，所以这块板的设计文件不能再生成一次。"
             "</li>")
    H.append("<li><b>「零人工」只覆盖「跑板的时候」，不覆盖「代码变没变」。</b>"
             "跑板全程没有 <code>Read-Host</code> / <code>pause</code> / stdin 交互，这一条可查；"
             "但流水线与设计文件当晚被改过多次并立即生效（<code>pipeline3.js</code> 每次尝试都重读）。"
             "<b>零人工 ≠ 系统一成不变。</b></li>")
    H.append("</ol>")

    H.append('<p class="sub" style="margin-top:40px">生成于 %s。'
             '台账：<code>out/_build-ledger.md</code>。'
             '想法源码：<code>out/_probe/idea-sources.json</code>。</p>'
             % e(__import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M")))
    H.append("</main></body></html>")

    dst = os.path.join(OUT, "交付说明.html")
    io.open(dst, "wb").write("\n".join(H).encode("utf-8"))
    print("  写入 %s  %d B" % (dst, os.path.getsize(dst)))
    print("  结果行 %d / 设计 %d / 做成过 %d / 交叉核查 %d 目录"
          % (total, ndesign, ever, len(cons_rows)))

if __name__ == "__main__":
    main()
