#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""独立重算 audit-placement.mjs 的 10 条摆放判据。只用标准库。

设计目标：**不复用被测实现**。本文件不 import、不调用、不读 scripts/audit-placement.mjs；
几何、分母、阈值全部按本文件自己的理解重写（理解写在 RULES 里，逐条可核）。

用法：
    python audit-crosscheck.py designs/mic-esp32s3-v4.json designs/mic-esp32s3-v3.json
    python audit-crosscheck.py designs/mic-esp32s3-v4.json --json
    python audit-crosscheck.py designs/mic-esp32s3-v4.json --focus   # 打印 4 项重点复核的明细

坐标约定（前提给定，不重发现）：
    板框 ['R',0,0,W,H] ⇒ X ∈ [0,W]，Y ∈ [-H,0]。上边 y=0，下边 y=-H。无 Y 取反。
    _placement 是 dict：键=位号，值 {x, y, rot, lock}。rot ∈ {0,90,180,270}（度，逆时针）。

尺寸表来源（见 AUDIT-CROSSCHECK.md §0）：
    scripts/relayout.mjs 顶部 SIZES 常量（注释声明出自 scripts/_probe-sizes.js 逐器件实测包围盒）。
    本文件没有 EDA 会话，无法重新实测；这是一个**已知的独立性缺口**，已在报告里写明。
"""

import json
import math
import sys

MIL2MM = 0.0254

# 自然朝向（rot=0）实测包围盒 [宽X, 高Y]，mil。键 = LCSC 料号。
SIZES = {
    'C2913199': (748, 1030),   # ESP32-S3-WROOM-1
    'C165948':  (388, 329),    # TYPE-C-31-M-12
    'C25905':   (80, 45),      # 5.1k 0402
    'C11702':   (80, 45),      # 1k 0402
    'C6186':    (362, 268),    # AMS1117-3.3
    'C440198':  (161, 77),     # 10uF
    'C14663':   (119, 66),     # 100nF
    'C3850164': (119, 66),     # 2.2nF
    'C2912107': (189, 205),    # MPU-6050
    'C910544':  (142, 151),    # MAX98357A
    'C49023793': (305, 284),   # SPK-2P 排针
    'C2832146': (217, 128),    # 轻触开关
    'C25804':   (115, 58),     # 10k
    'C2297':    (176, 91),     # LED
    'C2875567': (143, 167),    # I2S MEMS 麦克风
}

# U1 实测：总包围盒 748×1030，焊盘区 748×748，天线延伸 282，封装原点在焊盘区中心。
# 旋转方向：0→+Y, 180→−Y, 90→−X, 270→+X（天线朝向）。
U1_LCSC = 'C2913199'
PAD_HALF = 374
ANT_LEN = 282

# 判据阈值（本复核的取值，理由见各 rule 的 why）
TOL_CONNECTOR_EDGE = 100.0      # mil，连接器对口面到板边
TH_USB_END_RATIO = 0.25        # 可用跨度的 25%
TH_IMU_RATIO = 0.10            # 板宽的 10%
TH_MIC_SPK_MM = 50.0           # mm
TH_BTN_RATIO = 0.10            # 板宽的 10%

# 天线朝向量：rot → 自然 +Y 轴在板坐标里的方向
ROT_DIR = {0: (0, 1), 90: (-1, 0), 180: (0, -1), 270: (1, 0)}


# ── 几何 ────────────────────────────────────────────────────────────────
def box(x0, y0, x1, y1):
    return {'x0': min(x0, x1), 'y0': min(y0, y1), 'x1': max(x0, x1), 'y1': max(y0, y1)}


def comp_geom(des, x, y, rot, lcsc):
    """返回 {'full','pad','ant','dir'}。full = 整只器件的轴对齐包围盒。"""
    rot = int(rot) % 360
    if lcsc == U1_LCSC:
        pad = box(x - PAD_HALF, y - PAD_HALF, x + PAD_HALF, y + PAD_HALF)
        dx, dy = ROT_DIR[rot]
        ax0, ay0, ax1, ay1 = pad['x0'], pad['y0'], pad['x1'], pad['y1']
        if dy > 0:      # 天线朝 +Y
            ant = box(ax0, ay1, ax1, ay1 + ANT_LEN)
        elif dy < 0:    # 天线朝 -Y
            ant = box(ax0, ay0 - ANT_LEN, ax1, ay0)
        elif dx < 0:    # 天线朝 -X
            ant = box(ax0 - ANT_LEN, ay0, ax0, ay1)
        else:           # 天线朝 +X
            ant = box(ax1, ay0, ax1 + ANT_LEN, ay1)
        full = box(min(pad['x0'], ant['x0']), min(pad['y0'], ant['y0']),
                   max(pad['x1'], ant['x1']), max(pad['y1'], ant['y1']))
        return {'des': des, 'lcsc': lcsc, 'x': x, 'y': y, 'rot': rot,
                'full': full, 'pad': pad, 'ant': ant, 'dir': (dx, dy)}
    w, h = SIZES[lcsc]
    if rot % 180 == 90:          # 90 / 270：宽高互换
        w, h = h, w
    b = box(x - w / 2.0, y - h / 2.0, x + w / 2.0, y + h / 2.0)
    return {'des': des, 'lcsc': lcsc, 'x': x, 'y': y, 'rot': rot,
            'full': b, 'pad': b, 'ant': None, 'dir': ROT_DIR[rot], 'natWH': (w, h)}


def inter(a, b):
    """两盒相交区域；无交返回 None。"""
    x0 = max(a['x0'], b['x0']); x1 = min(a['x1'], b['x1'])
    y0 = max(a['y0'], b['y0']); y1 = min(a['y1'], b['y1'])
    if x1 > x0 and y1 > y0:
        return {'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1,
                'w': x1 - x0, 'h': y1 - y0, 'area': (x1 - x0) * (y1 - y0)}
    return None


def gap(a, b):
    """两盒的分离间隙：>0 不接触，≤0 重叠（负值 = 负间隙深度）。取两轴较大者。"""
    gx = max(b['x0'] - a['x1'], a['x0'] - b['x1'])
    gy = max(b['y0'] - a['y1'], a['y0'] - b['y1'])
    return max(gx, gy)


def inside(b, W, H, eps=1e-9):
    return (b['x0'] >= -eps and b['x1'] <= W + eps
            and b['y0'] >= -H - eps and b['y1'] <= eps)


# ── 载入 ────────────────────────────────────────────────────────────────
def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        d = json.load(f)
    W = float(d['boardWidthMil']); H = float(d['boardHeightMil'])
    lcsc = {c['des']: c['lcsc'] for c in d.get('components', [])}
    pl = d['_placement']
    comps, unsized = [], []
    for des, p in pl.items():
        code = lcsc.get(des)
        if code not in SIZES:
            unsized.append({'des': des, 'lcsc': code})
            continue
        comps.append(comp_geom(des, float(p['x']), float(p['y']),
                               int(p.get('rot', 0) or 0), code))
    comps.sort(key=lambda c: c['des'])
    return {'path': path, 'raw': d, 'W': W, 'H': H, 'comps': comps,
            'unsized': unsized, 'lcsc': lcsc,
            'band': d.get('_antennaKeepout') or {}}


def by_des(ctx, des):
    for c in ctx['comps']:
        if c['des'] == des:
            return c
    return None


# ── 10 条判据 ────────────────────────────────────────────────────────────
# 每条都写清「我在算什么」。判据名沿用审计脚本，语义是我自己的推断。

def r_antenna_band_empty(ctx, out):
    """带子 [-3700,-3690] 内除 allowDesignators 外不许有任何器件的包围盒。
    倒置盒子（y1<=y0 或 x1<=x0）在这里判 fail —— 空集合不能算「干净」。"""
    band, W, H = ctx['band'], ctx['W'], ctx['H']
    if not band:
        return dict(verdict='fail', detail='设计里没有 _antennaKeepout', nums={})
    x0, x1 = float(band['x0']), float(band['x1'])
    y0, y1 = float(band['y0']), float(band['y1'])
    allow = set(band.get('allowDesignators') or [])
    nums = {'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1,
            'inverted': (y1 <= y0) or (x1 <= x0),
            'bandW': x1 - x0, 'bandH': y1 - y0}
    if nums['inverted']:
        return dict(verdict='fail', nums=nums,
                    detail='净空盒倒置（x1<=x0 或 y1<=y0）：几何上不覆盖任何面积，'
                           '不能据此宣布「带内无器件」')
    bx = box(x0, y0, x1, y1)
    intruders, allowed_hits, nearest = [], [], None
    for c in ctx['comps']:
        if c['des'] in allow:
            if inter(bx, c['full']):
                allowed_hits.append(c['des'])
            continue
        if inter(bx, c['full']):
            intruders.append({'des': c['des'], 'overlapArea': round(inter(bx, c['full'])['area'], 1)})
        g = gap(bx, c['full'])
        if nearest is None or g < nearest[1]:
            nearest = (c['des'], g)
    nums['intruders'] = intruders
    nums['allowedHits'] = allowed_hits
    nums['nearestOther'] = nearest
    nums['minGapMilToOthers'] = band.get('minGapMilToOthers', 0)
    if intruders:
        return dict(verdict='fail', nums=nums,
                    detail='带内除 %s 外还有 %d 个器件：%s'
                           % ('/'.join(sorted(allow)) or '(无)', len(intruders),
                              ', '.join(i['des'] for i in intruders)))
    return dict(verdict='pass', nums=nums,
                detail='带子 [%g,%g] × [%g,%g] 内只有 %s；其余最近者 %s 距带子 %.1f mil'
                       % (x0, x1, y0, y1, '/'.join(sorted(allowed_hits)) or '(无)',
                          nearest[0], nearest[1]))


def r_antenna_overhang(ctx, out):
    """U1 天线尖端越过板边多少。板边取设计标称 -H；悬出量 = 板边 − 尖端。"""
    u1 = by_des(ctx, 'U1')
    if not u1 or u1['lcsc'] != U1_LCSC:
        return dict(verdict='unknown', detail='没有 U1 / 不是 ESP32 模组', nums={})
    H, W = ctx['H'], ctx['W']
    dx, dy = u1['dir']
    if dy < 0:
        edge, tip, axis, over = -H, u1['ant']['y0'], 'Y-', -H - u1['ant']['y0']
    elif dy > 0:
        edge, tip, axis, over = 0.0, u1['ant']['y1'], 'Y+', u1['ant']['y1'] - 0.0
    elif dx < 0:
        edge, tip, axis, over = 0.0, u1['ant']['x0'], 'X-', 0.0 - u1['ant']['x0']
    else:
        edge, tip, axis, over = W, u1['ant']['x1'], 'X+', u1['ant']['x1'] - W
    nums = {'axis': axis, 'tipMil': round(tip, 1), 'boardEdgeMil': round(edge, 1),
            'overhangMil': round(over, 1), 'overhangMm': round(over * MIL2MM, 2),
            'antLenMil': ANT_LEN, 'padBottomMil': round(u1['pad']['y0'], 1),
            'u1cy': u1['y'], 'u1rot': u1['rot']}
    if over > 0:
        return dict(verdict='pass', nums=nums,
                    detail='天线朝 %s 悬出 %.1f mil (%.2f mm)：尖端 %.1f，板边 %.1f'
                           % (axis, over, over * MIL2MM, tip, edge))
    return dict(verdict='fail', nums=nums,
                detail='天线朝 %s 但没有悬出板边：尖端 %.1f，板边 %.1f（差 %.1f）'
                       % (axis, tip, edge, -over))


def r_band_covers_antenna(ctx, out):
    """净空带必须盖住「板边 → 天线内缘（焊盘区底）」这一条缝。
    我在算：缝的跨度 = |焊盘区底 − 板边|；带子对这条缝的覆盖长度（Y 与 X 都要够）。"""
    u1 = by_des(ctx, 'U1')
    band, H = ctx['band'], ctx['H']
    if not u1 or not band:
        return dict(verdict='unknown', detail='缺 U1 或 _antennaKeepout', nums={})
    x0, x1 = float(band['x0']), float(band['x1'])
    y0, y1 = float(band['y0']), float(band['y1'])
    nums = {'bandY': [y0, y1], 'bandX': [x0, x1]}
    if y1 <= y0 or x1 <= x0:
        nums.update({'gapMil': None, 'coveredMil': 0})
        return dict(verdict='fail', nums=nums,
                    detail='净空盒倒置（[%g,%g]×[%g,%g]）：覆盖长度 0' % (x0, x1, y0, y1))
    dx, dy = u1['dir']
    # 天线沿哪根轴伸出：rot 0/180 → Y；rot 90/270 → X。
    # 「缝」= 板边 → 焊盘区外缘（天线内缘），需要在同一根轴上量；
    # 垂直方向还要要求带子罩住焊盘（=天线）的整个宽度。
    if dy:
        gap_lo, gap_hi = ((-ctx['H'], u1['pad']['y0']) if dy < 0
                          else (u1['pad']['y1'], 0.0))
        band_lo, band_hi = min(y0, y1), max(y0, y1)
        perp_need = (u1['pad']['x0'], u1['pad']['x1'])
        perp_band = (min(x0, x1), max(x0, x1))
        axis = 'Y'
    else:
        gap_lo, gap_hi = ((0.0, u1['pad']['x0']) if dx < 0
                          else (u1['pad']['x1'], ctx['W']))
        band_lo, band_hi = min(x0, x1), max(x0, x1)
        perp_need = (u1['pad']['y0'], u1['pad']['y1'])
        perp_band = (min(y0, y1), max(y0, y1))
        axis = 'X'
    need = abs(gap_hi - gap_lo)
    covered = max(0.0, min(max(gap_lo, gap_hi), band_hi) - max(min(gap_lo, gap_hi), band_lo))
    x_need = abs(perp_need[1] - perp_need[0])
    x_covered = max(0.0, min(max(perp_need), perp_band[1]) - max(min(perp_need), perp_band[0]))
    nums.update({'axis': axis,
                 'gapMil': round(need, 1),
                 'gapSpan': [round(min(gap_lo, gap_hi), 1), round(max(gap_lo, gap_hi), 1)],
                 'coveredMil': round(covered, 1),
                 'xNeedMil': round(x_need, 1), 'xCoveredMil': round(x_covered, 1),
                 'padBottomMil': round(u1['pad']['y0'], 1)})
    ok = covered >= need - 1e-9 and x_covered >= x_need - 1e-9
    detail = ('带子覆盖 %s → %s 这一缝 %.1f mil 中的 %.1f mil；X 向需 %.1f / 覆盖 %.1f'
              % (nums['gapSpan'][0], nums['gapSpan'][1], need, covered, x_need, x_covered))
    return dict(verdict='pass' if ok else 'fail', detail=detail, nums=nums)


def r_all_inside_board(ctx, out):
    """所有器件在板内。U1 只允许**天线段**悬出 —— 焊盘区仍然必须在板内。
    这是我与审计脚本可能分歧的地方：排除的是天线，不是整只 U1。"""
    W, H = ctx['W'], ctx['H']
    bad, u1info = [], None
    for c in ctx['comps']:
        if c['des'] == 'U1' and c['lcsc'] == U1_LCSC:
            pad_ok = inside(c['pad'], W, H)
            full_ok = inside(c['full'], W, H)
            u1info = {'padInside': pad_ok, 'fullBoxInside': full_ok,
                      'pad': [round(c['pad'][k], 1) for k in ('x0', 'y0', 'x1', 'y1')],
                      'full': [round(c['full'][k], 1) for k in ('x0', 'y0', 'x1', 'y1')]}
            if not pad_ok:
                bad.append({'des': 'U1(焊盘区)', 'box': u1info['pad']})
            continue
        if not inside(c['full'], W, H):
            bad.append({'des': c['des'],
                        'box': [round(c['full'][k], 1) for k in ('x0', 'y0', 'x1', 'y1')]})
    nums = {'checked': len(ctx['comps']), 'unsized': len(ctx['unsized']),
            'violations': bad, 'u1': u1info}
    if bad:
        return dict(verdict='fail', nums=nums,
                    detail='%d 个越界：%s' % (len(bad), ', '.join(b['des'] for b in bad)))
    return dict(verdict='pass', nums=nums,
                detail='%d 个器件全在板内（U1 只排除天线段：焊盘区 %s 在板内，整只含天线 %s）'
                       % (len(ctx['comps']), '是' if u1info and u1info['padInside'] else '无 U1',
                          '在板内' if u1info and u1info['fullBoxInside'] else '越界(预期)'))


def r_no_bbox_overlap(ctx, out):
    """两两包围盒不许相交。旋转 90/270 时宽高互换（轴对齐矩形）。"""
    cs = ctx['comps']
    pairs = 0
    hits = []
    minpairs = []
    for i in range(len(cs)):
        for j in range(i + 1, len(cs)):
            pairs += 1
            a, b = cs[i], cs[j]
            it = inter(a['full'], b['full'])
            if it:
                hits.append({'a': a['des'], 'b': b['des'],
                             'w': round(it['w'], 1), 'h': round(it['h'], 1),
                             'area': round(it['area'], 1)})
            else:
                minpairs.append((gap(a['full'], b['full']), a['des'], b['des']))
    minpairs.sort()
    nums = {'pairs': pairs, 'overlaps': hits,
            'closest': [{'a': a, 'b': b, 'gapMil': round(g, 1)} for g, a, b in minpairs[:8]],
            'rotatedComps': [{'des': c['des'], 'rot': c['rot'],
                              'boxWH': [round(c['full']['x1'] - c['full']['x0'], 1),
                                        round(c['full']['y1'] - c['full']['y0'], 1)]}
                             for c in cs if c['rot'] % 180 == 90 or c['rot'] == 180]}
    if hits:
        return dict(verdict='fail', nums=nums,
                    detail='%d/%d 对相交：%s' % (len(hits), pairs,
                                              ', '.join('%s↔%s' % (h['a'], h['b']) for h in hits)))
    return dict(verdict='pass', nums=nums,
                detail='%d 对全部不相交；最近一对 %s↔%s 仍留 %.1f mil'
                       % (pairs, minpairs[0][1], minpairs[0][2], minpairs[0][0]))


def _faces(c, W, H):
    b = c['full']
    return {'左': b['x0'], '右': W - b['x1'], '上': -b['y1'], '下': b['y0'] + H}


def r_connector_at_edge(ctx, out):
    """连接器的**对口面**要贴板边（≤100 mil）。
    我的推断：Type-C 的对口方向垂直于它的长边（388 mil 那条），自然朝向是 ±Y；
    rot 把这条方向映射到 ±X 或 ±Y。这里两种口径都算：
      (a) 包围盒到四条板边的**最小**距离（审计脚本报告的数看起来是这个口径）
      (b) 只用两面对口面（自然 ±Y 经 rot 映射后的两面）里的近者
    """
    W, H = ctx['W'], ctx['H']
    usb = by_des(ctx, 'USB1')
    if not usb:
        return dict(verdict='unknown', detail='没有 USB1', nums={})
    faces = _faces(usb, W, H)
    min_face, min_name = min((v, k) for k, v in faces.items())
    # 自然 ±Y 两面对口面：rot=0/180 → 上/下；rot=90/270 → 左/右
    if usb['rot'] in (0, 180):
        pair = {'上': faces['上'], '下': faces['下']}
    else:
        pair = {'左': faces['左'], '右': faces['右']}
    mate, mate_name = min((v, k) for k, v in pair.items())
    h1 = by_des(ctx, 'H1')
    nums = {'usbFaces': {k: round(v, 1) for k, v in faces.items()},
            'bboxMinFace': {'face': min_name, 'mil': round(min_face, 1)},
            'matingFace': {'face': mate_name, 'mil': round(mate, 1),
                           'candidates': {k: round(v, 1) for k, v in pair.items()}},
            'usbBox': [round(usb['full'][k], 1) for k in ('x0', 'y0', 'x1', 'y1')],
            'usbRot': usb['rot'], 'usbCenter': [usb['x'], usb['y']],
            'h1FaceDist': round(min(_faces(h1, W, H).values()), 1) if h1 else None}
    ok = min_face <= TOL_CONNECTOR_EDGE
    return dict(verdict='pass' if ok else 'fail', nums=nums,
                detail='USB1 包围盒最近板边=%s %.1f mil；对口面(%s)=%s %.1f mil（阈值 %.0f）'
                       % (min_name, min_face, '+'.join(pair), mate_name, mate, TOL_CONNECTOR_EDGE))


def r_usb_at_end(ctx, out):
    """USB 要靠近某一端。我在算：USB 中心到「可用跨度」两端的较小距离 / 可用跨度。
    可用跨度 = 板高 − 天线净空带厚度（带子占掉的那 10 mil 不可用）。
    同时给出四个组合（距离口径 × 分母口径），用来判断结论是否依赖分母。"""
    W, H = ctx['W'], ctx['H']
    usb = by_des(ctx, 'USB1')
    band = ctx['band'] or {}
    y0, y1 = float(band.get('y0', -H)), float(band.get('y1', 0.0))
    band_h = max(0.0, y1 - y0) if y1 > y0 else 0.0
    usable_top = y1 if y1 > y0 else 0.0          # 可用区的上端（带子上沿）
    span = H - band_h                             # 3690
    cy = usb['y']
    d_band = min(abs(cy - 0.0), abs(cy - usable_top))   # 到「上端 0 / 带子上沿 -3690」
    d_full = min(abs(cy - 0.0), abs(cy + H))            # 到「上端 0 / 下边 -H」
    combos = {
        'bandEnd_spanUsable': d_band / span,
        'bandEnd_spanFull': d_band / H,
        'fullEnd_spanUsable': d_full / span,
        'fullEnd_spanFull': d_full / H,
    }
    nums = {'centerY': cy, 'bandY': [y0, y1], 'bandThickness': round(band_h, 1),
            'usableSpanMil': round(span, 1), 'boardH': H,
            'distToTop': round(abs(cy), 1), 'distToBandTop': round(abs(cy - usable_top), 1),
            'distToBoardBottom': round(abs(cy + H), 1),
            'distBandEnd': round(d_band, 1), 'distFullEnd': round(d_full, 1),
            'ratios': {k: round(v * 100, 2) for k, v in combos.items()},
            'thresholdPct': TH_USB_END_RATIO * 100,
            'verdicts': {k: ('pass' if v <= TH_USB_END_RATIO else 'fail') for k, v in combos.items()}}
    ok = combos['bandEnd_spanUsable'] <= TH_USB_END_RATIO
    return dict(verdict='pass' if ok else 'fail', nums=nums,
                detail='USB1 中心 y=%.0f；到最近端 %.0f mil = 可用跨度 %.0f 的 %.1f%%（阈值 %.0f%%）'
                       '[换成整板 %.0f 分母=%.1f%%；换到整板端点=%.0f mil → %.1f%%]'
                       % (cy, d_band, span, combos['bandEnd_spanUsable'] * 100,
                          TH_USB_END_RATIO * 100, H, combos['bandEnd_spanFull'] * 100,
                          d_full, combos['fullEnd_spanFull'] * 100))


def r_imu_near_centerline(ctx, out):
    """IMU 必须靠近板中线。偏轴 = |U5.x − W/2|，容差 = 板宽 10%。"""
    W = ctx['W']
    u5 = by_des(ctx, 'U5')
    if not u5:
        return dict(verdict='unknown', detail='没有 U5', nums={})
    off = abs(u5['x'] - W / 2.0)
    tol = TH_IMU_RATIO * W
    nums = {'u5x': u5['x'], 'centerline': W / 2.0, 'offsetMil': round(off, 1),
            'offsetMm': round(off * MIL2MM, 2), 'tolMil': round(tol, 1)}
    ok = off <= tol
    return dict(verdict='pass' if ok else 'fail', nums=nums,
                detail='U5 x=%.0f，中线 %.0f，偏轴 %.1f mil (%.2f mm)，容差 %.0f mil'
                       % (u5['x'], W / 2.0, off, off * MIL2MM, tol))


def r_mic_speaker_apart(ctx, out):
    """麦克风与扬声器口的中心距 ≥ 50 mm。"""
    u4, h1 = by_des(ctx, 'U4'), by_des(ctx, 'H1')
    if not u4 or not h1:
        return dict(verdict='unknown', detail='缺 U4 或 H1', nums={})
    d = math.hypot(u4['x'] - h1['x'], u4['y'] - h1['y'])
    nums = {'u4xy': [u4['x'], u4['y']], 'h1xy': [h1['x'], h1['y']],
            'distMil': round(d, 1), 'distMm': round(d * MIL2MM, 2),
            'thresholdMm': TH_MIC_SPK_MM, 'thresholdMil': round(TH_MIC_SPK_MM / MIL2MM, 1)}
    ok = d * MIL2MM >= TH_MIC_SPK_MM
    return dict(verdict='pass' if ok else 'fail', nums=nums,
                detail='U4↔H1 中心距 %.0f mil (%.1f mm) vs 阈值 %.0f mm'
                       % (d, d * MIL2MM, TH_MIC_SPK_MM))


def r_buttons_centered(ctx, out):
    """三颗用户键（SW1/SW2/SW3）关于板中线对称。均位 = 三者 x 的均值；跨距 = max−min。"""
    W = ctx['W']
    des = ['SW1', 'SW2', 'SW3']
    cs = [by_des(ctx, d) for d in des]
    if any(c is None for c in cs):
        return dict(verdict='unknown', detail='缺 SW1/SW2/SW3 之一', nums={})
    xs = [c['x'] for c in cs]
    mean = sum(xs) / len(xs)
    off = abs(mean - W / 2.0)
    tol = TH_BTN_RATIO * W
    span = max(xs) - min(xs)
    nums = {'xs': xs, 'mean': round(mean, 1), 'centerline': W / 2.0,
            'offsetMil': round(off, 1), 'tolMil': round(tol, 1),
            'spanMil': round(span, 1),
            'symPair': round((xs[0] + xs[2]) / 2.0, 1)}
    ok = off <= tol
    return dict(verdict='pass' if ok else 'fail', nums=nums,
                detail='三键 x=%s 均位 %.0f vs 中线 %.0f（偏 %.0f，容差 %.0f）；跨距 %.0f mil'
                       % (['%g' % v for v in xs], mean, W / 2.0, off, tol, span))


RULES = [
    ('antenna_band_empty', r_antenna_band_empty),
    ('antenna_overhang', r_antenna_overhang),
    ('band_covers_antenna', r_band_covers_antenna),
    ('all_inside_board', r_all_inside_board),
    ('no_bbox_overlap', r_no_bbox_overlap),
    ('connector_at_edge', r_connector_at_edge),
    ('usb_at_end', r_usb_at_end),
    ('imu_near_centerline', r_imu_near_centerline),
    ('mic_speaker_apart', r_mic_speaker_apart),
    ('buttons_centered', r_buttons_centered),
]


def run(path):
    ctx = load(path)
    results = []
    for rid, fn in RULES:
        try:
            r = fn(ctx, None)
        except Exception as e:      # 单条判据崩了不许拖垮其它 9 条
            r = dict(verdict='unknown', detail='实现异常: %s: %s' % (type(e).__name__, e), nums={})
        results.append(dict(id=rid, verdict=r['verdict'], detail=r['detail'], nums=r['nums']))
    cnt = {'pass': 0, 'fail': 0, 'unknown': 0}
    for r in results:
        cnt[r['verdict']] = cnt.get(r['verdict'], 0) + 1
    return {'design': path, 'board': {'w': ctx['W'], 'h': ctx['H'],
                                      'mmW': round(ctx['W'] * MIL2MM, 2),
                                      'mmH': round(ctx['H'] * MIL2MM, 2)},
            'components': len(ctx['comps']), 'unsized': ctx['unsized'],
            'rules': results, 'summary': {'total': len(results), **cnt}}


def focus(path):
    ctx = load(path)
    print('─' * 100)
    print('FOCUS  %s   板 %g × %g' % (path, ctx['W'], ctx['H']))
    u1 = by_des(ctx, 'U1')
    print('\n[1] U1 几何（rot=%d）' % u1['rot'])
    print('    焊盘区 (pad)    x[%8.1f,%8.1f] y[%8.1f,%8.1f]  高 %.1f'
          % (u1['pad']['x0'], u1['pad']['x1'], u1['pad']['y0'], u1['pad']['y1'],
             u1['pad']['y1'] - u1['pad']['y0']))
    depth = (u1['ant']['y1'] - u1['ant']['y0']) if u1['dir'][1] else (u1['ant']['x1'] - u1['ant']['x0'])
    print('    天线段 (ant)    x[%8.1f,%8.1f] y[%8.1f,%8.1f]  沿天线方向深 %.1f'
          % (u1['ant']['x0'], u1['ant']['x1'], u1['ant']['y0'], u1['ant']['y1'], depth))
    print('    整只 (full)     x[%8.1f,%8.1f] y[%8.1f,%8.1f]  高 %.1f'
          % (u1['full']['x0'], u1['full']['x1'], u1['full']['y0'], u1['full']['y1'],
             u1['full']['y1'] - u1['full']['y0']))
    print('    pad 在板内=%s   full 在板内=%s   板 y∈[%g,0] x∈[0,%g]'
          % (inside(u1['pad'], ctx['W'], ctx['H']), inside(u1['full'], ctx['W'], ctx['H']),
             -ctx['H'], ctx['W']))
    print('\n[2] 旋转器件包围盒（rot 90/180/270）')
    for c in ctx['comps']:
        if c['rot'] in (90, 180, 270):
            print('    %-4s rot=%3d  盒 %.0f×%.0f  x[%.1f,%.1f] y[%.1f,%.1f]'
                  % (c['des'], c['rot'], c['full']['x1'] - c['full']['x0'],
                     c['full']['y1'] - c['full']['y0'], c['full']['x0'], c['full']['x1'],
                     c['full']['y0'], c['full']['y1']))
    print('\n    与 U1 的分离间隙（负=相交）：')
    for d in ('SW1', 'SW2', 'SW3', 'SW4', 'SW5'):
        c = by_des(ctx, d)
        print('      U1↔%-4s gap=%8.1f mil' % (d, gap(u1['full'], c['full'])))
    print('\n[3] USB1 四个面到板边的距离')
    usb = by_des(ctx, 'USB1')
    for k, v in _faces(usb, ctx['W'], ctx['H']).items():
        print('    %s: %.1f mil' % (k, v))
    print('\n[4] 净空带')
    print('    %s' % json.dumps(ctx['band'], ensure_ascii=False)[:300])
    print('─' * 100)


def main(argv):
    args = [a for a in argv[1:] if not a.startswith('--')]
    as_json = '--json' in argv
    do_focus = '--focus' in argv
    if not args:
        args = ['designs/mic-esp32s3-v4.json', 'designs/mic-esp32s3-v3.json']
    reports = [run(p) for p in args]
    if as_json:
        print(json.dumps(reports if len(reports) > 1 else reports[0],
                         ensure_ascii=False, indent=1))
        return 0
    for rep in reports:
        print('\n=== %s   板 %g×%g mil (%.1f×%.1f mm)   器件 %d / 尺寸未知 %d ==='
              % (rep['design'], rep['board']['w'], rep['board']['h'],
                 rep['board']['mmW'], rep['board']['mmH'],
                 rep['components'], len(rep['unsized'])))
        for r in rep['rules']:
            print('  %-22s %-7s %s' % (r['id'], r['verdict'].upper(), r['detail']))
        s = rep['summary']
        print('  合计 %d：pass %d / fail %d / unknown %d'
              % (s['total'], s['pass'], s['fail'], s['unknown']))
    if do_focus:
        for p in args:
            focus(p)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
