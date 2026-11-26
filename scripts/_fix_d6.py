# 修复 d6：RP2040 最小系统原本 QSPI 六线全悬空（没有 Flash 无法启动）、
# RUN 无上拉、SWCLK/SWD 无引出。独立校验器的"电气合理性"检查抓到了这些真实缺陷。
# 修法：补 QSPI Flash + Flash 去耦 + RUN 上拉 + SWD 排针引出。
import json

p = 'designs/d6-rp2040-minimal.json'
d = json.load(open(p, encoding='utf-8'))
conns = d['connections']
comps = d['components']
des_set = {c['des'] for c in comps}

def add_comp(des, lcsc, value):
    if des not in des_set:
        comps.append({'des': des, 'lcsc': lcsc, 'value': value})
        des_set.add(des)

# 1) QSPI Flash（RP2040 启动必需）
add_comp('U3', 'C131025', 'W25Q16JVSSIQ')
add_comp('C7', 'C14663', '100nF')
qspi = [(1, 'QSPI_SS'), (2, 'QSPI_SD1'), (3, 'QSPI_SD2'),
        (5, 'QSPI_SD0'), (6, 'QSPI_SCLK'), (7, 'QSPI_SD3')]
for fp, net in qspi:
    conns.append(['U3', str(fp), net])
conns.append(['U3', '8', '3V3'])
conns.append(['U3', '4', 'GND'])
conns.append(['C7', '1', '3V3'])
conns.append(['C7', '2', 'GND'])

# 2) RUN 上拉（否则芯片可能反复复位）
add_comp('R4', 'C11702', '1k')
conns.append(['R4', '1', '3V3'])
conns.append(['R4', '2', 'RUN'])

# 3) SWD 调试口引出（SWCLK/SWD/GND/3V3）
add_comp('H1', 'C9900192758', '2.54-1*8')
for pin, net in [('1', '3V3'), ('2', 'SWCLK'), ('3', 'SWD'), ('4', 'GND'),
                 ('5', 'RUN'), ('6', 'USB_DP'), ('7', 'USB_DM'), ('8', 'GND')]:
    conns.append(['H1', pin, net])

d['components'] = comps
d['connections'] = conns
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

from collections import defaultdict
occ = defaultdict(list)
for c in conns:
    occ[c[2]].append('%s.%s' % (c[0], c[1]))
single = {n: v for n, v in occ.items() if len(v) < 2}
print('d6: %d 器件 / %d 连接 / %d 网络' % (len(comps), len(conns), len(occ)))
print('  单点网络:', single if single else '无')
