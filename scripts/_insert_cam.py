import io

p = 'scripts/pipeline3.js'
src = open(p, encoding='utf-8').read()
lines = src.split('\n')

# 在指定行号(1-based)之前插入 cam 调用；从后往前插避免行号漂移
inserts = [
    (821, "await cam('pcb');   // 导出前回到全板视图"),
    (810, "await cam('pcb');   // DRC 后全板视图"),
    (562, "await cam('pcb');   // 布线前全板视图"),
    (502, "await cam('pcb');   // 铺铜前全板视图"),
    (358, "await cam('pcb');   // 布局前全板视图"),
    (279, "await cam('sch');   // 网表核对前回原理图全图"),
    (201, "await cam('sch');   // 连接前原理图全图"),
    (121, "await cam('sch');   // 放件前原理图全图"),
]

for ln, code in sorted(inserts, key=lambda x: -x[0]):
    lines.insert(ln - 1, code)

open(p, 'w', encoding='utf-8', newline='').write('\n'.join(lines))
print('inserted', len(inserts), 'cam calls')
