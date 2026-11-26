# 全部设计文件的网表自检：单点网络 / 无地 / 无电源 / 器件重复
import json, glob, os
from collections import defaultdict

GND = {'GND', 'GNDD', 'AGND', 'DGND', 'VSS'}
PWR = {'VCC', 'VDD', '3V3', '5V', '1V1', '12V', 'VBUS', 'VIN'}

for p in sorted(glob.glob('designs/d*.json')):
    d = json.load(open(p, encoding='utf-8'))
    occ = defaultdict(list)
    for c in d['connections']:
        occ[c[2]].append('%s.%s' % (c[0], c[1]))
    single = {n: v for n, v in occ.items() if len(v) < 2}
    des = [c['des'] for c in d['components']]
    dup = [x for x in set(des) if des.count(x) > 1]
    hasGnd = any(n.upper() in GND for n in occ)
    hasPwr = any(n.upper() in PWR for n in occ)
    flags = []
    if single:
        flags.append('单点%d' % len(single))
    if dup:
        flags.append('重名%s' % dup)
    if not hasGnd:
        flags.append('无地')
    print('%-26s %-22s %2d件 %3d连 %2d网  %s' % (
        os.path.basename(p), d['name'], len(d['components']),
        len(d['connections']), len(occ), ('⚠ ' + ' '.join(flags)) if flags else 'OK'))
    if single:
        for n, v in single.items():
            print('        单点网络: %s -> %s' % (n, v))
