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

NEED_LAYERS = [".GTL", ".GBL", ".GTS", ".GBS", ".GTO", ".GKO"]

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
        run = loadjson(os.path.join(d, "_run.json"))
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
        rows = list(csv.DictReader(io.StringIO(readtext(p))))
        pnp = [r for r in rows if (r.get("Designator") or "").strip()]
    add("PnP.csv 存在", os.path.exists(p))
    pnpDes = [ (r.get("Designator") or "").strip() for r in pnp ]

    dDes = component_designators(des)

    if des is not None and nl is not None and pnp:
        add("三方差一致(PnP=网表=设计)",
            len(pnpDes) == nlComps == len(dDes),
            "PnP %d / 网表 %d / 设计 %d" % (len(pnpDes), nlComps, len(dDes)))
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
            miss = [L for L in NEED_LAYERS if not any(n.upper().endswith(L) for n in names)]
            add("Gerber 必需层齐全", not miss, "缺 " + ",".join(miss) if miss else "%d 个文件" % len(names))
            gko = [n for n in names if n.upper().endswith(".GKO")]
            if gko: bb = gerber_bbox(z.read(gko[0]).decode("utf-8", "ignore"))
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
                if x < bb[0] - 0.01 or x > bb[2] + 0.01 or y < bb[1] - 0.01 or y > bb[3] + 0.01:
                    outside.append((n, round(x, 3), round(y, 3), dia))
        add("钻孔都在板框内", not outside,
            ("%d 个孔在板外: %s" % (len(outside), outside[:3])) if outside else "%d 个孔全靠内" % total)

    # 板框 vs 报告
    if bb and run:
        w = (bb[2]-bb[0]) * 39.3701; h = (bb[3]-bb[1]) * 39.3701
        rw = run.get("boardWidthMil"); rh = run.get("boardHeightMil")
        if rw and rh:
            add("报告板框与实际一致", abs(w-rw) <= 20 and abs(h-rh) <= 20,
                "报告 %sx%s 实际 %.0fx%.0f" % (rw, rh, w, h))

    ok = all(x[1] for x in res)
    return ok, res

if __name__ == "__main__":
    root = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
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
    npass = 0
    for d in targets:
        ok, res = check(d)
        if ok: npass += 1
        bad = [r for r in res if not r[1]]
        print("%s  %s" % ("PASS" if ok else "FAIL", os.path.basename(d)))
        for n, o, det in bad:
            print("        x %-28s %s" % (n, det))
    print("\n合计 %d 个目录，全部交叉一致 %d 个" % (len(targets), npass))
