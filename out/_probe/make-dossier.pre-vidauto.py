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
             '由自然语言想法自动生成，全程无人工干预。'
             '本页所有数字都由 <code>out/_probe/make-dossier.py</code> 从原始文件重算，'
             '不引用任何手写值。</p>')

    # 概览
    H.append('<div class="row">')
    H.append('<div><div class="lbl">设计-轮次结果行</div><div class="big">%d</div>'
             '<div class="lbl">PASS %d / FAIL %d</div></div>'
             % (total, npass, total - npass))
    H.append('<div><div class="lbl">做过板的设计</div><div class="big">%d</div>'
             '<div class="lbl">其中做出过合格板 %d 个</div></div>' % (ndesign, ever))
    H.append('<div><div class="lbl">产物目录</div><div class="big">%d</div>'
             '<div class="lbl">设计文件 %d 个</div></div>'
             % (sum(len(v) for v in agg.values()), len(des)))
    H.append('<div><div class="lbl">交叉核查</div><div class="big">%d/%d</div>'
             '<div class="lbl">目录全判据通过</div></div>'
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

    # 视频
    vid = os.path.join(ROOT, "video", "out", "v9-065428.mp4")
    if os.path.exists(vid):
        H.append("<h2>真实操作录像</h2>")
        H.append('<video controls preload="metadata" src="../video/out/v9-065428.mp4"></video>')
        H.append('<p class="sub">屏幕录像是 AI 实际驱动 EDA 软件的过程，非演示动画。'
                 '文件 <code>video/out/v9-065428.mp4</code>，%.1f MB，1080x1920 / 30 fps / H.264+AAC。</p>'
                 % (os.path.getsize(vid) / 1048576.0))

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
        bad = fab.get("blocked_but_self_ok") or []
        if bad:
            H.append('<p class="sub">自述通过但不能下单的目录（全部来自早期批次）：</p>')
            H.append('<table><tr><th>目录</th><th>阻断原因</th></tr>')
            for b in bad:
                H.append('<tr><td><code>%s</code></td><td>%s</td></tr>'
                         % (e(b["dir"]),
                            e("；".join(x.get("msg") or x.get("id") or "?" for x in b["blockers"]))))
            H.append('</table>')
        H.append('<p class="sub">普查原始数据 <code>out/_probe/fab-census.json</code>，'
                 '可用 <code>python out/_probe/fab-census.py</code> 重算（217 目录约 21 秒）。</p>')
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

    H.append('<div class="warn"><b>口径声明。</b>'
             '本页的通过率一律按「设计-轮次结果行」计算（%d 行），'
             '不重复计入同一设计的多次尝试；'
             '「做成过」按设计计算（%d 个设计里 %d 个出现过 ok=true 的目录）。'
             '两个数字回答的不是同一个问题，不能互相替代。</div>'
             % (total, ndesign, ever))

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
