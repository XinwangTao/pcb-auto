# artifact-consistency.py —— 交付物之间互相对得上吗（不是"文件存在"，是"文件互证"）
#
# 为什么需要：accept.ps1 的产物校验会核对"设计⇄网表"，但不会核对
#   PnP 行数 vs 网表器件数、钻孔尺寸 vs 板框、钻孔是否落在板框内。
# 今晚出过一次"自述 ok=True 但板子少一个器件"的事故，所以这里逐个交叉。
#
# 判据都是可判定的等式，不做模糊判断：
#   1. PnP 行数 == Netlist.components 数 == 设计 components 数        （三方差一即 fail）
#   2. 每个 PnP designator 都能在设计里找到                            （漏件/多件）
#   3. 每个设计器件都有 PnP 行                                          （漏排）
#   4. 钻孔文件里每个孔的坐标都落在 GKO 板框内                          （孔在板外 = 做不出来）
#   5. Gerber 必需层齐全（GTL/GBL/GTS/GBS/GTO/GKO）
import json, io, os, sys, glob, zipfile, re, csv

# Windows 上 Python 往管道写时默认用本地代码页（英文系统 cp1252 / 中文 cp936）。
# cp1252 编码不了中文，本脚本一 print 就抛 UnicodeEncodeError 崩在中途，
# 于是整个量具返回非 0 —— 而中文 Windows 上永远复现不了。
# 入口处强制 UTF-8，让输出与代码页无关。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

NEED_LAYERS = [".GTL", ".GBL", ".GTS", ".GBS", ".GTO", ".GKO", ".DRL"]

# 必须真跑过的判据。all() 对"没跑"无感（all([]) == True），
# 所以漏跑一条与跑过且通过返回值完全等价 —— 必须显式点名。
REQUIRED = [
    "设计可读", "Netlist.json 存在", "PnP.csv 存在", "PnP 可解析",
    "三方差一致(PnP=网表=设计)", "设计器件都在 PnP 里", "PnP 无多余器件",
    "BOM.xlsx 存在", "BOM 数量 == 设计器件数",
    "Gerber.zip 存在", "GKO 板框可解析", "Gerber 必需层齐全",
    "钻孔都在板框内", "报告板框与实际一致",
]

def gerber_bbox(txt):
    """只从真正的坐标块 X..Y..D01/D02/D03 取极值。
    【踩过的坑】早先对整个文本 re.findall(r"X(-?\\d+)")，结果把文件头
    `%FSLAX45Y45*%` 里的 X45/Y45 当成坐标。当板上所有 Y 都为负时，
    那个 +45 会把高度撑大 3 倍多（实测 1836 mil 被算成 3395 mil）。
    Y 有正坐标时误差可忽略，所以这个 bug 只在"Y 全负"的板上显形 ——
    正是最容易漏掉的那一类。"""
    m = re.search(r"%FSLAX(\d)(\d)Y(\d)(\d)\*%", txt)
    dec = int(m.group(2)) if m else 6
    unit_mm = not re.search(r"%MOIN\*%", txt)
    div = 10 ** dec
    k = 1.0 if unit_mm else 25.4
    xs = []; ys = []
    for mm in re.finditer(r"X(-?\d+)Y(-?\d+)D0[123]\*", txt):
        xs.append(int(mm.group(1)) / div * k)
        ys.append(int(mm.group(2)) / div * k)
    if not xs or not ys: return None
    return (min(xs), min(ys), max(xs), max(ys))

def drill_holes(txt):
    # Excellon: 工具用 T01C0.29972 定义（单位 inch 直径），坐标 X..Y..（单位 inch 或 mm）
    m = re.search(r"METRIC|M71|M72", txt)
    inch = not (m and m.group(0) in ("METRIC", "M71"))
    k = 25.4 if inch else 1.0
    tools = {}
    for mm in re.finditer(r"T(\d+)C([\d.]+)", txt):
        tools["T" + mm.group(1)] = float(mm.group(2)) * k
    holes = []
    cur = None
    for ln in txt.splitlines():
        ln = ln.strip()
        mt = re.match(r"^(T\d+)$", ln)
        if mt:
            cur = mt.group(1); continue
        mc = re.match(r"^X(-?[\d.]+)Y(-?[\d.]+)$", ln)
        if mc:
            holes.append((float(mc.group(1)) * k, float(mc.group(2)) * k, tools.get(cur)))
    return tools, holes

def readtext(p):
    """按 BOM 自动解码。实测 PnP.csv 各目录编码不一：新目录 UTF-8 BOM，老目录 UTF-16。
    按扩展名或固定编码读会在老目录上直接抛 UnicodeDecodeError —— 那是读法错，不是文件坏。"""
    raw = io.open(p, "rb").read()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16")
    if raw[:4] in (b"\xff\xfe\x00\x00", b"\x00\x00\xfe\xff"):
        return raw.decode("utf-32")
    if raw[:3] == b"\xef\xbb\xbf":
        return raw.decode("utf-8-sig")
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("gbk", "ignore")

def component_designators(des):
    """设计器件字段名实测是 des（不是 designator/ref），逐个兼容以免换版本后失效。"""
    out = []
    for c in (des or {}).get("components") or []:
        if not isinstance(c, dict): continue
        for k in ("des", "designator", "ref", "refDes", "designatorName", "reference"):
            v = c.get(k)
            if v: out.append(str(v).strip()); break
    return [x for x in out if x]

def check(d, designpath=None):
    """返回 (ok, [(name, ok, detail)])"""
    res = []
    def add(n, ok, det=""): res.append((n, ok, det))

    def loadjson(p):
        return json.loads(readtext(p))

    run = None
    if os.path.exists(os.path.join(d, "_run.json")):
        try: run = loadjson(os.path.join(d, "_run.json"))
        except Exception as e:
            # 目录可能在跑，读到半写文件。崩掉会让 21 个目录一起没有结论。
            add("_run.json 可解析", False, str(e)[:80])
    if run is None:
        add("_run.json", False, "缺失"); return False, res

    # 设计：优先用目录自带 snapshot
    des = None
    src = ""
    snap = os.path.join(d, "_design.snapshot.json")
    if os.path.exists(snap):
        try: des = loadjson(snap); src = "snapshot"
        except Exception as e: add("设计快照可解析", False, str(e)[:80])
    if des is None and designpath and os.path.exists(designpath):
        try: des = loadjson(designpath); src = "参数"
        except Exception as e: add("设计可解析", False, str(e)[:80])
    add("设计可读", des is not None, src)

    # Netlist
    nl = None
    p = os.path.join(d, "Netlist.json")
    if os.path.exists(p):
        try: nl = loadjson(p)
        except Exception as e: add("Netlist 可解析", False, str(e)[:80])
    add("Netlist.json 存在", nl is not None)
    nlComps = len((nl or {}).get("components") or {})

    # PnP
    pnp = []
    p = os.path.join(d, "PnP.csv")
    if os.path.exists(p):
        txt = readtext(p)
        # 【踩过的坑】有 5 个目录的 PnP 是制表符分隔，默认逗号解析出 0 行，
        # 于是判据1 整条消失、判据2 报"缺 19"（假失败）。实测两类的
        # (分隔符, ok) 完全相关，纯属巧合才没污染 PASS 数。
        head = txt.splitlines()[0] if txt.splitlines() else ""
        delim = "\t" if head.count("\t") > head.count(",") else ","
        rows = list(csv.DictReader(io.StringIO(txt), delimiter=delim))
        pnp = [r for r in rows if (r.get("Designator") or "").strip()]
    add("PnP.csv 存在", os.path.exists(p))
    pnpDes = [ (r.get("Designator") or "").strip() for r in pnp ]
    # 0 行不再静默跳过：没解析出来就是没验证，不能算通过
    add("PnP 可解析", bool(pnp), "%d 行" % len(pnp) if pnp else "0 行：分隔符或表头不符")
    if pnpDes:
        add("PnP 位号无重复", len(set(pnpDes)) == len(pnpDes),
            "重复 " + ",".join(sorted({x for x in pnpDes if pnpDes.count(x) > 1})) if len(set(pnpDes)) != len(pnpDes) else "无重复")

    dDes = component_designators(des)

    if des is not None and nl is not None:
        add("三方差一致(PnP=网表=设计)",
            len(pnpDes) == nlComps == len(dDes),
            "PnP %d / 网表 %d / 设计 %d" % (len(pnpDes), nlComps, len(dDes)))
    if not dDes:
        add("设计位号可解析", False, "设计里 0 个位号，无法与 PnP 对照")
    if dDes:
        missing = sorted(set(dDes) - set(pnpDes))
        extra = sorted(set(pnpDes) - set(dDes))
        add("设计器件都在 PnP 里", not missing, "缺 " + ",".join(missing) if missing else "齐全")
        add("PnP 无多余器件", not extra, "多 " + ",".join(extra) if extra else "无多余")

    # BOM：下单依据，必须与设计器件数相等。
    # 注意 BOM 按器件"合并同类项"，所以比的是 Quantity 列之和，不是行数。
    bp = os.path.join(d, "BOM.xlsx")
    add("BOM.xlsx 存在", os.path.exists(bp))
    if os.path.exists(bp):
        try:
            import openpyxl
            wb = openpyxl.load_workbook(bp, read_only=True, data_only=True)
            ws = wb.worksheets[0]
            vals = [list(r) for r in ws.iter_rows(values_only=True)]
            wb.close()
            hdr = None; hdrs = []
            for i, r in enumerate(vals[:6]):
                j = " ".join(str(x) for x in r if x is not None)
                if any(k in j for k in ("Designator", "位号", "Quantity", "数量")):
                    hdr = i; hdrs = [str(x) for x in r]; break
            qi = None
            for k, h in enumerate(hdrs):
                if "Quantity" in h or "数量" in h or h.strip().lower() == "qty": qi = k; break
            total = 0
            for r in vals[(hdr + 1) if hdr is not None else 0:]:
                if not any(x not in (None, "") for x in r): continue
                if qi is not None:
                    try: total += int(float(r[qi]))
                    except Exception: total += 1
                else:
                    total += 1
            if dDes:
                add("BOM 数量 == 设计器件数", total == len(dDes), "BOM %d / 设计 %d" % (total, len(dDes)))
            else:
                add("BOM 数量可比", False, "设计器件数为 0，无法比较")
        except Exception as e:
            add("BOM.xlsx 可读", False, str(e)[:80])

    # Gerber
    gz = os.path.join(d, "Gerber.zip")
    add("Gerber.zip 存在", os.path.exists(gz))
    bb = None; names = []
    if os.path.exists(gz):
        try:
            z = zipfile.ZipFile(gz)
            names = z.namelist()
            # 只查文件名会把 0 字节的层算成"齐"
            miss = [L for L in NEED_LAYERS
                    if not any(n.upper().endswith(L) and z.getinfo(n).file_size > 0 for n in names)]
            add("Gerber 必需层齐全", not miss,
                "缺或为零字节 " + ",".join(miss) if miss else "%d 个文件" % len(names))
            gko = [n for n in names if n.upper().endswith(".GKO") and z.getinfo(n).file_size > 0]
            if gko:
                bb = gerber_bbox(z.read(gko[0]).decode("utf-8", "ignore"))
                add("GKO 板框可解析", bb is not None,
                    "无可辨识的 D01/D02/D03 坐标" if bb is None else "OK")
            else:
                add("GKO 板框可解析", False, "没有非空 .GKO")
        except Exception as e:
            add("Gerber.zip 可读", False, str(e)[:80])

    # 钻孔 vs 板框
    if bb:
        total = 0; outside = []
        for n in names:
            if not n.upper().endswith(".DRL"): continue
            txt = zipfile.ZipFile(gz).read(n).decode("utf-8", "ignore")
            tools, holes = drill_holes(txt)
            total += len(holes)
            for (x, y, dia) in holes:
                # 比的是孔的"边缘"，不是孔心：孔心在框内但半径越界仍做不出来
                r = (dia or 0) / 2.0
                if (x - r < bb[0] - 0.01 or x + r > bb[2] + 0.01
                        or y - r < bb[1] - 0.01 or y + r > bb[3] + 0.01):
                    outside.append((n, round(x, 3), round(y, 3), dia))
        if total == 0:
            add("钻孔都在板框内", False, "0 个孔：无 .DRL 或孔未被解析 —— 空集合不能当通过")
        else:
            add("钻孔都在板框内", not outside,
                ("%d 个孔在板外: %s" % (len(outside), outside[:3])) if outside else "%d 个孔全靠内" % total)

    # 板框 vs 报告
    if bb and run:
        w = (bb[2]-bb[0]) * 39.3701; h = (bb[3]-bb[1]) * 39.3701
        rw = run.get("boardWidthMil"); rh = run.get("boardHeightMil")
        if rw and rh:
            add("报告板框与实际一致", abs(w-rw) <= 20 and abs(h-rh) <= 20,
                "报告 %sx%s 实际 %.0fx%.0f" % (rw, rh, w, h))
        else:
            add("报告板框与实际一致", False, "_run.json 缺 boardWidthMil/boardHeightMil")

    # 覆盖断言：点名却没跑的判据，必须记 FAIL。
    # 没有这一段，"跳过"与"通过"在 ok 上无法区分。
    seen = {x[0] for x in res}
    for name in REQUIRED:
        if name not in seen:
            add("判据未执行:" + name, False, "跳过不等于通过")

    ok = all(x[1] for x in res)
    return ok, res

if __name__ == "__main__":
    root = os.environ.get("PCB_AUTO_ROOT") or os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    root = os.path.abspath(root)
    targets = sys.argv[1:]
    if not targets:
        dirs = []
        for d in sorted(glob.glob(os.path.join(root, "out", "*"))):
            if not os.path.isdir(d): continue
            if os.path.exists(os.path.join(d, "_design.snapshot.json")) and os.path.exists(os.path.join(d, "_run.json")):
                try:
                    r = json.loads(readtext(os.path.join(d, "_run.json")))
                    if r.get("ok") is True: dirs.append(d)
                except Exception: pass
        targets = dirs
    import hashlib as _h
    _me = io.open(os.path.abspath(__file__), "rb").read()
    print("# 核查器 sha256_12=%s  %d B  目标 %d 个目录"
          % (_h.sha256(_me).hexdigest()[:12].upper(), len(_me), len(targets)))
    npass = 0
    for d in targets:
        ok, res = check(d)
        if ok: npass += 1
        bad = [r for r in res if not r[1]]
        print("%s  %s  [%d 条判据]" % ("PASS" if ok else "FAIL", os.path.basename(d), len(res)))
        for n, o, det in bad:
            print("        x %-28s %s" % (n, det))
    print("\n合计 %d 个目录，全部交叉一致 %d 个" % (len(targets), npass))
    # 【能报错 ≠ 能判定】原来这里没有 sys.exit()，打印 FAIL 却一律退出 0：
    # 接进任何脚本/CI 都是绿灯。空目标列表同样不能算通过（空集合不是证据）。
    if not targets:
        sys.exit(2)
    sys.exit(0 if npass == len(targets) else 1)
