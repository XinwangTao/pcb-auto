# 修复 d2/d3：SHT30 的 SDA(pin2)/SCL(pin3) 原本完全没接，上拉电阻连到悬空网络名。
# 独立校验器（电气合理性检查）抓到了这个真实设计缺陷 —— DRC 和流水线都没报。
import json

for name in ['d2-sht30-module', 'd3-sht30-ldo']:
    p = f'designs/{name}.json'
    d = json.load(open(p, encoding='utf-8'))
    conns = d['connections']
    added = []
    for pin, net in [('2', 'SDA'), ('3', 'SCL')]:
        if not any(c[0] == 'U1' and c[1] == pin for c in conns):
            conns.append(['U1', pin, net])
            added.append(['U1', pin, net])
    # 上拉电阻另一端应接电源，确保不是悬空
    d['connections'] = conns
    json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    nets = sorted(set(c[2] for c in conns))
    ncomp = len(d['components'])
    print('%s: 补 %s -> %d 器件 / %d 连接 / %d 网络' % (name, added, ncomp, len(conns), len(nets)))
    print('   网络:', ', '.join(nets))
