import re

p = 'scripts/pipeline3.js'
src = open(p, encoding='utf-8').read()

# 只在真正需要驱动 PCB 编辑器行为的节点强制 openDocument；
# 其余保持纯 zoom（分屏下两边都可见，且 openDocument 每次额外 3-8s）。
repl = [
    # PCB 导入完成后：必须把 PCB 设为激活文档，后续 importChanges/布局都作用在它上面
    ("await cam('pcb');\nlet imported = false;",
     "await cam('pcb', true);   // 强制激活 PCB：后续 importChanges/布局都作用于它\nlet imported = false;"),
    # 布线前：路由器需要 PCB 为激活文档，否则布线结果不落盘（实测 23 处 Connection Error）
    ("await cam('pcb');   // 布线前全板视图",
     "await cam('pcb', true);   // 强制激活 PCB：否则布线结果不落盘"),
]

for a, b in repl:
    if a in src:
        src = src.replace(a, b)
        print('OK  ', a.split('\n')[0][:60])
    else:
        print('MISS', a.split('\n')[0][:60])

open(p, 'w', encoding='utf-8', newline='').write(src)
