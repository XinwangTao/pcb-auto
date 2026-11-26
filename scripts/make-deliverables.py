# -*- coding: utf-8 -*-
"""从一次流水线运行的产物生成制造交付文档：打样检查清单 / 装配说明 / 成本估算。

原则（fail-visible）：
- 文档里出现的每个数字/结论都必须来自本次运行的产物文件；
- 产物里拿不到的，一律写「未验证（原因）」，绝不写死常量冒充结论；
- 任何设计专属内容（网络名、电压、器件用途、极性）都从 Netlist/BOM/PnP 推导，不硬编码。

产物来源：BOM.xlsx / PnP.csv / Gerber.zip / Netlist.json / TestPoints.xlsx；
可选交叉校验：_run.json（板框尺寸、流水线自检）、_gates.independent.json（独立校验门）。

用法：python scripts/make-deliverables.py <运行目录> [输出目录]
"""
import csv
import io
import json
import os
import re
import sys
import zipfile
from collections import Counter
from datetime import datetime

import openpyxl

MIL_TO_MM = 0.0254
UNVERIFIED = '未验证'


# --------------------------------------------------------------------------- #
# 基础工具
# --------------------------------------------------------------------------- #
def _blank(v):
    """空值判定：None 或纯空白字符串都算空（BOM 第 10 行是 '' + None 的混合）。"""
    return v is None or (isinstance(v, str) and not v.strip())


def _fmt(v, nd=3):
    """数字格式化：固定小数位后去掉多余的尾零（40.640 -> 40.64，1600 -> 1600）。"""
    s = f'{float(v):.{nd}f}'
    if '.' in s:
        s = s.rstrip('0').rstrip('.')
    return s or '0'


def _load_json(path):
    if not os.path.exists(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def _ext(name):
    base = name.rsplit('/', 1)[-1].rsplit('\\', 1)[-1]
    return os.path.splitext(base)[1].lstrip('.').upper()


# --------------------------------------------------------------------------- #
# 产物读取
# --------------------------------------------------------------------------- #
def read_bom(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return [], []
    header = [str(c).strip() if c is not None else '' for c in rows[0]]
    items = []
    for r in rows[1:]:
        # 整行都是 None 或空白串才算空行（导出末尾常见 ('', None, None, ...)）
        if not r or all(_blank(c) for c in r):
            continue
        rec = {}
        for i, h in enumerate(header):
            rec[h] = r[i] if i < len(r) else None
        items.append(rec)
    return header, items


def _decode_text(raw):
    """按 BOM/字节特征选编码：PnP.csv 实际是 UTF-8-BOM，不能盲试 utf-16-le。"""
    if raw.startswith(b'\xef\xbb\xbf'):
        return raw.decode('utf-8-sig')
    if raw[:2] in (b'\xff\xfe', b'\xfe\xff'):
        return raw.decode('utf-16')
    if raw.count(b'\x00') > max(4, len(raw) // 4):
        for enc in ('utf-16-le', 'utf-16-be'):
            try:
                text = raw.decode(enc)
            except Exception:
                continue
            if '\x00' not in text:
                return text
    for enc in ('utf-8-sig', 'gbk'):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode('utf-8', 'ignore')


def read_pnp(path):
    text = _decode_text(open(path, 'rb').read()).replace('\ufeff', '')
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        return [], []
    sep = '\t' if lines[0].count('\t') > lines[0].count(',') else ','
    reader = list(csv.reader(io.StringIO('\n'.join(lines)), delimiter=sep))
    header = [h.strip().strip('"') for h in reader[0]]
    rows = []
    for parts in reader[1:]:
        parts = [p.strip().strip('"') for p in parts]
        if not parts or all(_blank(p) for p in parts):
            continue
        rows.append(dict(zip(header, parts)))
    return header, rows


def read_gerber_layers(zip_path):
    with zipfile.ZipFile(zip_path) as z:
        return z.namelist()


def read_netlist(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def read_testpoints(path):
    """TestPoints.xlsx 的 Summary 页是 键/值 两列。"""
    wb = openpyxl.load_workbook(path, data_only=True)
    summary = {}
    key = 'Summary' if 'Summary' in wb.sheetnames else wb.sheetnames[0]
    for row in wb[key].iter_rows(values_only=True):
        if not row or _blank(row[0]):
            continue
        summary[str(row[0]).strip()] = row[1] if len(row) > 1 else None
    return summary, wb.sheetnames


# --------------------------------------------------------------------------- #
# 推导
# --------------------------------------------------------------------------- #
def _is_copper(ext):
    return ext in ('GTL', 'GBL') or re.fullmatch(r'G(L)?\d+', ext) is not None


KIND = {
    'GTL': '铜层', 'GBL': '铜层',
    'GTS': '阻焊', 'GBS': '阻焊',
    'GTP': '钢网', 'GBP': '钢网',
    'GTO': '丝印', 'GBO': '丝印',
    'GKO': '板框', 'GM1': '板框',
    'GDD': '钻孔图', 'GDL': '文档层', 'DRL': '钻孔',
}
KIND_ORDER = ['铜层', '阻焊', '钢网', '丝印', '板框', '钻孔', '钻孔图', '文档层', '其他']


def layer_kind(name):
    ext = _ext(name)
    if _is_copper(ext):
        return '铜层'
    if ext == 'GDD':
        return '钻孔图'
    return KIND.get(ext, '其他')


def layer_count_text(names):
    c = Counter(layer_kind(n) for n in names)
    return ' / '.join(f'{k} {c[k]}' for k in KIND_ORDER if c[k])


def drill_files(names):
    """真钻孔文件＝扩展名 .DRL；GDD 是钻孔『图』层，不是钻孔文件。"""
    return [n for n in names if _ext(n) == 'DRL']


POLAR_WORDS = ('LED', 'DIODE', '二极管', '发光', '电解', 'ELECTROLYTIC', '钽', 'TANTALUM')


def orientation_note(props, pin_count):
    """极性/方向判词：只依据料号/封装/描述/脚数，同一料号必然同一判词。"""
    hay = ' '.join(str(props.get(k) or '') for k in (
        'Manufacturer Part', 'DeviceName', 'FootprintName', 'Supplier Footprint',
        'Value', 'Description', 'LCSC Part Name')).upper()
    hits = sorted({w for w in POLAR_WORDS if w.upper() in hay})
    if hits:
        return f'有极性（料号/描述含 {"、".join(hits)}；方向以丝印为准）', 'polar'
    if pin_count >= 3:
        return f'无极性；{pin_count} 脚封装，须按 1 脚丝印对位', 'orient'
    return '无极性（两脚片式件，料号无极性标记）', 'none'


def net_role(net):
    u = net.upper()
    if u in ('GND', 'AGND', 'PGND', 'DGND', 'EARTH'):
        return '地'
    if re.fullmatch(r'\+?\d+V\d*', u) or re.search(r'(^|_)(VCC|VDD|VBUS|VIN|VBAT|V\d+)', u):
        return '电源候选'
    return '信号'


def _num(s):
    v = str(s if s is not None else '').replace('mm', '').replace('"', '').strip()
    try:
        return float(v)
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def main():
    if len(sys.argv) < 2:
        print('用法: python scripts/make-deliverables.py <运行目录> [输出目录]')
        return 2
    run_dir = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else run_dir

    bom_path = os.path.join(run_dir, 'BOM.xlsx')
    pnp_path = os.path.join(run_dir, 'PnP.csv')
    gerber_path = os.path.join(run_dir, 'Gerber.zip')
    nl_path = os.path.join(run_dir, 'Netlist.json')
    tp_path = os.path.join(run_dir, 'TestPoints.xlsx')

    for p in (bom_path, pnp_path, gerber_path, nl_path):
        if not os.path.exists(p):
            print(f'缺少产物: {p}')
            return 1
    os.makedirs(out_dir, exist_ok=True)

    bom_header, bom = read_bom(bom_path)
    pnp_header, pnp = read_pnp(pnp_path)
    gerber = read_gerber_layers(gerber_path)
    netlist = read_netlist(nl_path)
    tp_summary, tp_sheets = read_testpoints(tp_path) if os.path.exists(tp_path) else ({}, [])
    run_meta = _load_json(os.path.join(run_dir, '_run.json')) or {}
    gates_ind = _load_json(os.path.join(run_dir, '_gates.independent.json')) or {}

    comps = netlist.get('components', {}) or {}
    props_by_des = {}
    pins_by_des = {}
    for _uid, c in comps.items():
        props = c.get('props', {}) or {}
        des = props.get('Designator')
        if not des:
            continue
        props_by_des[des] = props
        pins_by_des[des] = c.get('pinInfoMap', {}) or {}
    designators = sorted(props_by_des)

    # ---- 网络清单与脚数（全部来自 Netlist） ----
    net_rule = (netlist.get('designRule', {}) or {}).get('netRule', {}) or {}
    nets = set(net_rule.keys())
    for pins in pins_by_des.values():
        for p in pins.values():
            n = str((p or {}).get('net') or '').strip()
            if n:
                nets.add(n)
    nets = sorted(nets)
    net_pin_count = {}
    for n in nets:
        net_pin_count[n] = sum(
            1 for pins in pins_by_des.values()
            for p in pins.values() if str((p or {}).get('net') or '').strip() == n)

    # ---- 板框尺寸：优先 _run.json，用 _gates.independent.json 交叉校验 ----
    w_mil = _num(run_meta.get('boardWidthMil'))
    h_mil = _num(run_meta.get('boardHeightMil'))
    board_ok = bool(w_mil and h_mil and w_mil > 0 and h_mil > 0)
    board_txt = UNVERIFIED
    board_note = '未找到 _run.json 的 boardWidthMil/boardHeightMil'
    if board_ok:
        w_mm, h_mm = w_mil * MIL_TO_MM, h_mil * MIL_TO_MM
        area_mil2 = w_mil * h_mil
        board_txt = f'{_fmt(w_mm, 2)} × {_fmt(h_mm, 2)} mm（{_fmt(w_mil, 0)} × {_fmt(h_mil, 0)} mil）'
        board_note = '_run.json boardWidthMil/boardHeightMil'
        g_area = _num(gates_ind.get('boardAreaMil2'))
        if g_area:
            if abs(area_mil2 - g_area) < 1:
                board_note += f'；面积 {_fmt(area_mil2, 0)} mil² 与 _gates.independent.json 一致'
            else:
                board_note += (f'；⚠ 与 _gates.independent.json boardAreaMil2='
                               f'{_fmt(g_area, 0)} 不一致，请核对')

    # ---- PnP 实测：坐标跨度 / 贴装面 / 贴片与插件点数（原脚本算了却从不写出） ----
    xs, ys, smd_yes, tht = [], [], [], []
    smd_map = {}
    pnp_layers = set()
    for row in pnp:
        x, y = _num(row.get('Mid X') or row.get('X')), _num(row.get('Mid Y') or row.get('Y'))
        if x is not None and y is not None:
            xs.append(x)
            ys.append(y)
        lay = str(row.get('Layer') or '').strip()
        if lay:
            pnp_layers.add(lay)
        smd = str(row.get('SMD') or '').strip().lower()
        des = str(row.get('Designator') or '').strip()
        if smd in ('yes', 'no') and des:
            smd_map[des] = smd
        if smd == 'yes':
            smd_yes.append(des)
        elif smd == 'no':
            tht.append(des)

    span_txt = UNVERIFIED
    span_note = '未从 PnP.csv 读到 Mid X / Mid Y 坐标'
    x_neg = y_neg = False
    if xs and ys:
        sx, sy = max(xs) - min(xs), max(ys) - min(ys)
        span_txt = (f'X {_fmt(min(xs))} → {_fmt(max(xs))} mm（跨度 {_fmt(sx)} mm）、'
                    f'Y {_fmt(min(ys))} → {_fmt(max(ys))} mm（跨度 {_fmt(sy)} mm）')
        span_note = 'PnP.csv 位号中心点 min→max'
        x_neg, y_neg = min(xs) < 0, min(ys) < 0
        if board_ok:
            fit_x, fit_y = sx <= w_mil * MIL_TO_MM + 1e-6, sy <= h_mil * MIL_TO_MM + 1e-6
            if fit_x and fit_y:
                span_note += '；两向跨度均小于板框（在板内）'
            else:
                span_note += '；⚠ 跨度超出板框，请核对 PnP 与板框尺寸'

    # ---- Gerber 层核对（真实存在性，不再是常量断言） ----
    ext_set = {_ext(n) for n in gerber if _ext(n)}
    copper = [n for n in gerber if _is_copper(_ext(n))]
    drill = drill_files(gerber)
    drill_draw = [n for n in gerber if _ext(n) == 'GDD']
    bottom_smd = [d for d in smd_yes if str(
        next((r.get('Layer') or '' for r in pnp if str(r.get('Designator') or '').strip() == d), '')).upper() == 'B']

    REQUIRED = [
        ('顶层铜 (GTL)', ['GTL'], '顶层走线', '无法制造'),
        ('底层铜 (GBL)', ['GBL'], '底层走线', '无法制造'),
        ('顶层阻焊 (GTS)', ['GTS'], '开窗', '焊盘被油盖住，无法上锡'),
        ('底层阻焊 (GBS)', ['GBS'], '开窗', '同上'),
        ('顶层钢网 (GTP)', ['GTP'], 'SMT 刷锡', '贴片厂无法上锡膏'),
        ('底层钢网 (GBP)', ['GBP'], 'SMT 刷锡', '同上'),
        ('丝印 (GTO/GBO)', ['GTO', 'GBO'], '位号辨认', '装配时无法辨认器件位置'),
        ('板框 (GKO)', ['GKO'], '外形切割', '无法确定板子形状'),
        ('钻孔 (.DRL)', ['DRL'], '过孔/插件孔', '插件件装不上'),
    ]
    req_rows, miss, waived = [], [], []
    for label, exts, use, consequence in REQUIRED:
        have = [e for e in exts if e in ext_set]
        status = '有' if len(have) == len(exts) else ('部分有' if have else '缺')
        note = consequence
        if not have:
            if label.startswith('底层钢网') and not bottom_smd:
                note = '不需要：PnP 无底层贴装元件（Layer 全为 T）'
                waived.append(label)
                status = '不需要'
            else:
                miss.append(label)
        req_rows.append((label, '、'.join(exts), status, use, note))

    # ---- 位号三处交叉校验 ----
    bom_des = []
    for it in bom:
        for d in re.split(r'[,;\s，、]+', str(it.get('Designator') or '')):
            if d.strip():
                bom_des.append(d.strip())
    pnp_des = [str(r.get('Designator') or '').strip() for r in pnp if str(r.get('Designator') or '').strip()]
    set_nl, set_bom, set_pnp = set(designators), set(bom_des), set(pnp_des)
    xcheck_ok = set_nl == set_bom == set_pnp
    xcheck_txt = (f'Netlist {len(set_nl)} / BOM {len(set_bom)} / PnP {len(set_pnp)} 位号集合一致'
                  if xcheck_ok else
                  f'⚠ 位号集合不一致：Netlist {len(set_nl)} / BOM {len(set_bom)} / PnP {len(set_pnp)}'
                  f'（仅 BOM 有 {sorted(set_bom - set_nl)}，仅 Netlist 有 {sorted(set_nl - set_bom)}）')

    total_qty = 0
    for it in bom:
        try:
            total_qty += int(float(str(it.get('Quantity') or 0)))
        except Exception:
            pass

    # ---- BOM 里的工艺字段（有就写，没有就「未验证」） ----
    def bom_param(names, why):
        for n in names:
            if n in bom_header:
                for it in bom:
                    if not _blank(it.get(n)):
                        return str(it.get(n)).strip(), f'BOM「{n}」列'
        return None, why

    thickness, thickness_note = bom_param(('板厚', 'Board Thickness', 'Thickness'), '产物无板厚字段')
    finish, finish_note = bom_param(('表面处理', 'Surface Finish'), '产物无表面处理字段')
    mask, mask_note = bom_param(('阻焊颜色', 'Solder Mask'), '产物无阻焊颜色字段')

    # ---- 流水线自检门（_run.json / _gates.independent.json） ----
    g = run_meta.get('gates', {}) or {}
    ind = gates_ind.get('gates', {}) or {}
    ind_true = sum(1 for v in ind.values() if v is True)

    stamp = datetime.now().strftime('%Y-%m-%d %H:%M')
    run_name = os.path.basename(run_dir.rstrip('\\/'))

    # ===================================================================== #
    # 1. 打样检查清单
    # ===================================================================== #
    n_layers = len(copper)
    layer_txt = f'{n_layers} 层' if copper else UNVERIFIED
    layer_note = (f'Gerber.zip 铜层文件：{"、".join(copper)}' if copper
                  else '未在 Gerber.zip 中找到铜层文件（GTL/GBL）')

    L = []
    L.append(f'# 打样检查清单 — {run_name}')
    L.append('')
    L.append(f'生成时间：{stamp}　数据来源：{run_dir}')
    L.append('')
    L.append('> 本文档所有数字均由脚本从本次运行的产物读出；读不到的写「未验证（原因）」，不用常量代替。')
    L.append('')
    L.append('## 一、下单参数')
    L.append('')
    L.append('| 项目 | 值 | 依据 |')
    L.append('|---|---|---|')
    L.append(f'| 板框尺寸 | {board_txt} | {board_note} |')
    L.append(f'| 器件坐标跨度 | {span_txt} | {span_note} |')
    L.append(f'| 层数 | {layer_txt} | {layer_note} |')
    L.append(f'| Gerber 文件数 | {len(gerber)} | {layer_count_text(gerber)} |')
    L.append(f'| 钻孔文件数 | {len(drill)} | 扩展名 .DRL：{"、".join(drill) if drill else "无"} |')
    L.append(f'| 器件数 | {len(designators)} | Netlist.json components |')
    L.append(f'| BOM 物料行数 | {len(bom)} | BOM.xlsx 非空物料行（跳过全空行） |')
    L.append(f'| 物料总数量 | {total_qty} | BOM Quantity 列求和 |')
    L.append(f'| 贴片点数 | {len(smd_yes)} | PnP.csv SMD=Yes |')
    L.append(f'| 插件点数 | {len(tht)} | PnP.csv SMD=No：{"、".join(tht) if tht else "无"} |')
    L.append(f'| 板厚 | {thickness or UNVERIFIED} | {thickness_note} |')
    L.append(f'| 表面处理 | {finish or UNVERIFIED} | {finish_note} |')
    L.append(f'| 阻焊颜色 | {mask or UNVERIFIED} | {mask_note} |')
    L.append('')
    L.append('## 二、文件核对（按 Gerber.zip 实际内容逐条判定）')
    L.append('')
    L.append('| 层 | 扩展名 | 状态 | 用途 | 缺失后果 |')
    L.append('|---|---|---|---|---|')
    for label, exts, status, use, note in req_rows:
        L.append(f'| {label} | {exts} | {status} | {use} | {note} |')
    L.append('')
    n_req = len(REQUIRED)
    if miss:
        L.append(f'**核对结果：{n_req} 项中缺 {len(miss)} 项 → {"、".join(miss)}。缺失项必须补导出或按下单要求说明。**')
    else:
        L.append(f'**核对结果：{n_req} 项中 {n_req - len(waived)} 项已在 Gerber.zip 中确认存在'
                 + (f'，{len(waived)} 项（{"、".join(waived)}）因本板无底层贴装元件而不需要' if waived else '')
                 + '。**')
    L.append('')
    if drill:
        extra = (f'；{"、".join(drill_draw)} 是钻孔**图**（Gerber 层），不计入钻孔文件' if drill_draw else '')
        L.append(f'钻孔文件 {len(drill)} 个：{"、".join(drill)}{extra}')
    else:
        L.append('**未在 Gerber.zip 中找到 .DRL 钻孔文件** — 若确认无插件器件、无过孔属正常，否则说明漏导出。')
    L.append('')
    L.append('## 三、一致性与自检（只列能从产物数出来的项）')
    L.append('')
    L.append(f'- 位号交叉校验：{xcheck_txt}')
    L.append(f'- 物料合计：BOM 中 {len(bom)} 种 / {total_qty} 个；Netlist 位号 {len(set_nl)} 个'
             + ('，数量与位号数一致' if total_qty == len(set_nl) else '，⚠ 数量与位号数不一致'))
    if g:
        L.append(f'- 流水线自检（_run.json gates）：errors={g.get("errors", UNVERIFIED)}、'
                 f'mismatches={g.get("mismatches", UNVERIFIED)}、'
                 f'drcPassed={g.get("drcPassed", UNVERIFIED)}、'
                 f'drcTotalCount={g.get("drcTotalCount", UNVERIFIED)}、'
                 f'drcLeafCount={g.get("drcLeafCount", UNVERIFIED)}、'
                 f'schDrcErrors={g.get("schDrcErrors", UNVERIFIED)}')
        if g.get('exportsTotal'):
            L.append(f'- 产物导出：{g.get("exportsOk", UNVERIFIED)} / {g.get("exportsTotal")}（_run.json gates.exportsOk/exportsTotal）')
    else:
        L.append(f'- 流水线自检：{UNVERIFIED}（未找到 _run.json）')
    dr = netlist.get('designRule', {}) or {}
    if dr:
        L.append(f'- 设计规则：Netlist.designRule 顶层键 {len(dr)} 个（{"、".join(dr)}）；'
                 f'netRule 覆盖 {len(net_rule)} 个网络。'
                 f'「逐项规则通过数」产物未提供 → {UNVERIFIED}')
    if ind:
        L.append(f'- 独立校验门（_gates.independent.json）：{ind_true} / {len(ind)} 项为 true'
                 f'（{"、".join(k for k, v in ind.items() if v is True)}）')
    else:
        L.append(f'- 独立校验门：{UNVERIFIED}（未找到 _gates.independent.json）')
    L.append('')
    L.append('## 四、SMT 贴片注意（极性判词由料号/封装/脚数得出，同位号同料号判词一致）')
    L.append('')
    L.append('| 位号 | 型号 (Manufacturer Part) | 值 | 封装 | 脚数 | 极性/方向 |')
    L.append('|---|---|---|---|---|---|')
    for des in designators:
        p = props_by_des[des]
        mpn = p.get('Manufacturer Part') or p.get('DeviceName') or UNVERIFIED
        val = p.get('Value') or p.get('Name') or UNVERIFIED
        fp = p.get('FootprintName') or p.get('Supplier Footprint') or UNVERIFIED
        pc = len(pins_by_des[des])
        note, _k = orientation_note(p, pc)
        L.append(f'| {des} | {mpn} | {val} | {fp} | {pc} | {note} |')
    L.append('')
    L.append('## 五、下单前最后 3 件事')
    L.append('')
    L.append('1. 用 Gerber 查看器（如嘉立创在线预览）打开 Gerber.zip，确认板框外形和丝印清晰')
    L.append('2. 确认 BOM 里每个物料都有库存、且「基础库/扩展库」贴片费可接受')
    if not (xs and ys):
        origin_txt = f'PnP.csv 未读到坐标，原点无法判定 → {UNVERIFIED}'
    elif x_neg or y_neg:
        origin_txt = ('PnP.csv 未提供原点字段；实测坐标出现负值（' +
                      ('X 最小 %.3f mm，' % min(xs) if x_neg else '') +
                      ('Y 最小 %.3f mm' % min(ys) if y_neg else '') +
                      '），故原点不是板框左下角；实际原点定义未验证')
        origin_txt = origin_txt.replace('，），', '），')
    else:
        origin_txt = ('PnP.csv 未提供原点字段；实测坐标均为非负，可能是左下角原点'
                      '（未验证），下单前须与贴片厂书面确认')
    L.append(f'3. 确认 PnP 坐标原点与工厂约定一致：{origin_txt}')
    L.append('')
    L.append('## 六、未验证项（产物里没有对应数据，下单前必须人工确认）')
    L.append('')
    if not thickness:
        L.append(f'- 板厚：{thickness_note}')
    if not finish:
        L.append(f'- 表面处理：{finish_note}')
    if not mask:
        L.append(f'- 阻焊颜色：{mask_note}')
    L.append('- DRC 逐项规则通过数：Netlist.designRule 只保存规则组（trackPhysics / netRule），无逐项通过记录')
    L.append('- PnP 坐标原点定义：PnP.csv 无原点字段；只能由坐标符号判定"是否为左下角"')
    L.append('- 贴片厂工艺能力与报价档位：无对应产物')
    L.append('')

    checklist_path = os.path.join(out_dir, '打样检查清单.md')
    with open(checklist_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(L))

    # ===================================================================== #
    # 2. 装配说明
    # ===================================================================== #
    A = []
    A.append(f'# 装配说明 — {run_name}')
    A.append('')
    A.append(f'生成时间：{stamp}')
    A.append('')
    A.append(f'板框尺寸：{board_txt}　器件 {len(designators)} 个　'
             f'贴装面：{"、".join(sorted(pnp_layers)) if pnp_layers else UNVERIFIED}　'
             f'贴片 {len(smd_yes)} / 插件 {len(tht)}')
    A.append('')
    A.append(f'尺寸依据：{board_note}')
    A.append('')
    A.append('> 本文档不含写死的设计专属内容：物料来自 BOM.xlsx，网络与器件来自 Netlist.json，'
             '坐标与贴装面来自 PnP.csv；缺数据处标「未验证」。')
    A.append('')
    A.append('## 一、物料清单（按 BOM.xlsx 合并口径）')
    A.append('')
    A.append('| 位号 | 型号 (Manufacturer Part) | 值 | 封装 | LCSC | 数量 |')
    A.append('|---|---|---|---|---|---|')
    for it in bom:
        des = it.get('Designator') or UNVERIFIED
        mpn = it.get('Manufacturer Part') or it.get('Value') or UNVERIFIED
        val = it.get('Value') or UNVERIFIED
        fp = it.get('Footprint') or UNVERIFIED
        lcsc = it.get('Supplier Part') or UNVERIFIED
        qty = it.get('Quantity')
        A.append(f'| {des} | {mpn} | {val} | {fp} | {lcsc} | {qty if not _blank(qty) else UNVERIFIED} |')
    A.append('')
    A.append(f'合计：{len(bom)} 种 / {total_qty} 个。')
    A.append('')

    # 贴装顺序：从 PnP(BOM) 推导，不写死封装尺寸
    smd_two, smd_multi, tht_des = [], [], list(tht)
    for des in designators:
        if smd_map.get(des) != 'yes':
            continue
        (smd_two if len(pins_by_des[des]) <= 2 else smd_multi).append(des)
    fp_two = sorted({str(props_by_des[d].get('FootprintName') or '?') for d in smd_two})
    fp_multi = sorted({str(props_by_des[d].get('FootprintName') or '?') for d in smd_multi})
    polar = [d for d in designators if orientation_note(props_by_des[d], len(pins_by_des[d]))[1] == 'polar']
    orient = [d for d in smd_multi
              if orientation_note(props_by_des[d], len(pins_by_des[d]))[1] == 'orient']

    A.append('## 二、贴装顺序建议（按 PnP/BOM 的实际封装推导）')
    A.append('')
    step = 1
    if fp_two:
        A.append(f'{step}. **先贴两脚片式件（SMD）**：{"、".join(fp_two)}'
                 f'（位号 {"、".join(smd_two)}，共 {len(smd_two)} 个）')
        step += 1
    if fp_multi:
        A.append(f'{step}. **再贴多脚 SMD 封装**：{"、".join(fp_multi)}'
                 f'（位号 {"、".join(smd_multi)}，共 {len(smd_multi)} 个）')
        step += 1
    if tht_des:
        A.append(f'{step}. **最后手工焊插件件**：{"、".join(tht_des)}'
                 f'（PnP 标记 SMD=No，需过回流后手焊；脚序按 1 脚丝印对位）')
        step += 1
    if orient:
        A.append(f'{step}. **多脚 SMD 对位**：{"、".join(orient)} 按 1 脚丝印标记方向放置，不可镜像')
        step += 1
    if polar:
        A.append(f'{step}. **有极性件**：{"、".join(polar)} — 阴极/负极方向以丝印为准（判据：料号/描述关键词）')
    else:
        A.append(f'{step}. 本板网表与 BOM 中未识别出有极性器件')
    A.append('')
    A.append('## 三、上电前必做')
    A.append('')
    A.append('1. **万用表蜂鸣档测各电源网络对地是否短路** — 这一步跳过会烧板')
    A.append('2. 测各电源域对地电阻，读数为 0 或接近 0 即短路，禁止上电')
    A.append('3. 首次上电用**限流电源**（限流值按原理图额定电流自行设定，产物未给出额定值）')
    A.append('')
    A.append('## 四、网络清单与上电验证（网络名与脚数均来自 Netlist.json）')
    A.append('')
    A.append('| 网络 | 类型（按网络名推断） | 器件脚数 | 期望值 |')
    A.append('|---|---|---|---|')
    for n in nets:
        A.append(f'| {n} | {net_role(n)} | {net_pin_count.get(n, 0)} | {UNVERIFIED}（产物无电气参数） |')
    A.append('')
    pwr = [n for n in nets if net_role(n) == '电源候选']
    gnd = [n for n in nets if net_role(n) == '地']
    sig = [n for n in nets if net_role(n) == '信号']
    A.append(f'- 电源候选网络：{"、".join(pwr) if pwr else "无（网络名未匹配 +3V3 / 5V / VCC / VDD 这类命名模式）"}')
    A.append(f'- 地网络：{"、".join(gnd) if gnd else "无"}')
    A.append(f'- 信号网络：{"、".join(sig) if sig else "无"}')
    A.append('- 各网络期望电压/波形：产物未提供电气参数 → 未验证，按原理图填写后再上电')
    A.append('')
    # 设计专属步骤：按网表真实网络名单判断是否适用（A4：不再无条件套用充电/电池/总线那套叙述）
    SPECIAL = [('电池/充电', ('VBAT', 'BATT', 'BAT', 'CHRG', 'CHG', 'PROG', 'CELL')),
               ('两线串行总线', ('SDA', 'SCL'))]
    A.append('### 特殊功能网络扫描（按网表网络名单判定本板是否需要额外验证步骤）')
    A.append('')
    for label, keys in SPECIAL:
        hits = [n for n in nets if any(k in n.upper() for k in keys)]
        if hits:
            A.append(f'- **{label}**（扫描关键字 {"、".join(keys)}）：命中 {"、".join(hits)}'
                     f' → 需要按该功能逐项验证（期望值未验证，按原理图）')
        else:
            A.append(f'- **{label}**（扫描关键字 {"、".join(keys)}）：命中 0 个 → '
                     f'本板无此类网络，跳过相应验证步骤')
    A.append('')
    A.append('## 五、调试与测试点')
    A.append('')
    if tht:
        for d in tht:
            ns = sorted({str((p or {}).get('net') or '').strip()
                         for p in pins_by_des.get(d, {}).values()
                         if str((p or {}).get('net') or '').strip()})
            A.append(f'- 插件件 {d}（{len(pins_by_des.get(d, {}))} 脚）：连接网络 {"、".join(ns) if ns else "未验证"}')
    else:
        A.append('- PnP 未标记任何插件件（SMD=No 为空）')
    if tp_summary:
        A.append('- 测试点产物：`TestPoints.xlsx`（页签：'
                 + '、'.join(f'`{s}`' for s in tp_sheets) + '）')
        for k in ('网络总数', '有测试点的网络', '无测试点的网络', '测试点覆盖率', '顶面测试点', '底面测试点'):
            if k in tp_summary:
                A.append(f'  - {k}：{tp_summary[k]}')
        cov = str(tp_summary.get('测试点覆盖率') or '').strip()
        if cov in ('0', '0%'):
            A.append('  - 结论：**本板没有布置测试点**，调试须在焊接后的排针/焊盘上直接接触；'
                     '逐网络清单见 `TestPoints.xlsx` 的 `Nets Count` 页')
        else:
            A.append('  - 结论：测试点覆盖情况见 `TestPoints.xlsx` 的 `Testpoints Count` 页（坐标/层/孔径）')
    else:
        A.append(f'- 测试点：{UNVERIFIED}（未找到 TestPoints.xlsx）')
    A.append('')

    assembly_path = os.path.join(out_dir, '装配说明.md')
    with open(assembly_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(A))

    # ===================================================================== #
    # 3. 成本估算
    # ===================================================================== #
    ext_parts = sorted({props_by_des[d].get('Manufacturer Part') or d
                        for d in designators
                        if str(props_by_des[d].get('JLCPCB Part Class') or '').strip()
                        == 'Extended Part'})
    C = []
    C.append(f'# 成本估算 — {run_name}')
    C.append('')
    C.append(f'生成时间：{stamp}')
    C.append('')
    C.append('> **单价未自动填写**：立创商城价格随库存/批量浮动，脚本不编造数字。')
    C.append('> 下表已把"要买什么、买多少"列全，单价请按当日商城价或报价单填入。')
    C.append('')
    C.append('## 一、物料成本')
    C.append('')
    C.append('| 位号 | 型号 (Manufacturer Part) | LCSC | 数量 | 单价(元) | 小计(元) |')
    C.append('|---|---|---|---|---|---|')
    for it in bom:
        des = it.get('Designator') or UNVERIFIED
        mpn = it.get('Manufacturer Part') or it.get('Value') or UNVERIFIED
        lcsc = it.get('Supplier Part') or UNVERIFIED
        try:
            q = int(float(str(it.get('Quantity') or 0)))
        except Exception:
            q = 0
        C.append(f'| {des} | {mpn} | {lcsc} | {q} |  |  |')
    C.append('')
    C.append(f'**物料合计：{len(bom)} 种 / {total_qty} 个**（BOM.xlsx 非空物料行；单价待填）')
    C.append('')
    C.append('## 二、PCB 打样费')
    C.append('')
    C.append('| 项目 | 数量 | 单价(元) | 小计(元) |')
    C.append('|---|---|---|---|')
    pcb_item = (f'双面板 {board_txt}' if board_ok else f'双面板（板框尺寸{UNVERIFIED}）')
    C.append(f'| {pcb_item} | 5 |  |  |')
    C.append('| 菲林/工程费 | 1 |  |  |')
    C.append('')
    # 数量 5 是**占位**，不是产物推导：Gerber/BOM/PnP 里都没有"要打几片"这个字段，
    # 它取决于试产还是量产。留着不说明会被当成"板子规模算出来的 5 片"（实测 8/8 个
    # 产物目录都写死 5，读起来像有依据）。按本文件既有约定显式标"无产物可核验"。
    C.append('> 数量 **5 是占位**——产物无「打样片数」字段，按试产/量产需要改；'
             '单价与小计同样待填。')
    C.append('')
    if board_ok:
        C.append(f'> 板框 {board_txt}，面积 {_fmt(w_mil * MIL_TO_MM * h_mil * MIL_TO_MM / 100.0, 2)} cm²'
                 f'（{_fmt(w_mil * h_mil, 0)} mil²）；档位与单价请按工厂实际报价填。')
    else:
        C.append(f'> 板框尺寸{UNVERIFIED}，无法判断报价档位。')
    C.append('')
    C.append('## 三、SMT 贴片费')
    C.append('')
    C.append('| 项目 | 数量 | 单价(元) | 小计(元) | 依据 |')
    C.append('|---|---|---|---|---|')
    C.append('| 工程费（一次性） | 1 |  |  | 无产物可核验 |')
    C.append(f'| 贴片点数 | {len(smd_yes)} |  |  | PnP.csv SMD=Yes |')
    C.append(f'| 插件手焊点数 | {len(tht)} |  |  | PnP.csv SMD=No：{"、".join(tht) if tht else "无"} |')
    C.append(f'| 扩展库换料费 | {len(ext_parts)} |  |  | Netlist「JLCPCB Part Class」=Extended Part'
             f'{"：" + "、".join(ext_parts) if ext_parts else ""} |')
    C.append('')
    C.append('## 四、成本优化建议')
    C.append('')
    C.append(f'- **优先用基础库**：基础库无换料费；本板扩展库 {len(ext_parts)} 种'
             + (f'（{"、".join(ext_parts)}）' if ext_parts else '')
             + '，若可替换为基础库可省换料费')
    C.append(f'- **合并同阻值/同容值**：本板 BOM 已按物料合并为 {len(bom)} 行（{total_qty} 个）')
    C.append('- **减少器件种类**：种类数直接决定换料费和贴片效率')
    C.append('')
    C.append('## 五、未验证项')
    C.append('')
    C.append('- 所有单价、工程费、贴片单价：产物无价格字段')
    C.append('- 贴片厂工艺能力与最低起订量：无对应产物')
    C.append('')

    cost_path = os.path.join(out_dir, '成本估算.md')
    with open(cost_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(C))

    print('已生成:')
    print(f'  {checklist_path}')
    print(f'  {assembly_path}')
    print(f'  {cost_path}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
