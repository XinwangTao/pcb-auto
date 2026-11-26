import io

p = 'scripts/pipeline3.js'
src = open(p, encoding='utf-8').read()
lines = src.split('\n')

# 在 placeParts / connect 循环内每隔几个器件切一次镜头，让原理图画面持续有变化。
# 找 placeParts 内的 placed.push 和 connect 内的循环体插入点。
out = []
in_place = False
in_connect = False
cnt = 0
for i, line in enumerate(lines):
    s = line.strip()
    if s.startswith("phase('placeParts')"):
        in_place = True
    if s.startswith("phase('netlistCheck')"):
        in_place = False
    if s.startswith("phase('connect')"):
        in_connect = True
    if s.startswith("phase('netlistCheck')"):
        in_connect = False
    out.append(line)

open(p, 'w', encoding='utf-8', newline='').write('\n'.join(out))
print('no-op scaffold; will insert via targeted edits instead')
