# -*- coding: utf-8 -*-
"""给 artifact-consistency.py 补退出码。

发现方式：用它去复核两个 fabcheck 报 drilling.empty 的目录，它**确实**打出
  x 钻孔都在板框内  0 个孔：无 .DRL 或孔未被解析 —— 空集合不能当通过
但 shell 收到的是 exit=0。读 __main__ 末尾：全文没有任何 sys.exit()。

这正是我自己写进台账的那一类缺陷 ——「能报错的量具」不等于「能判定的量具」：
打印 FAIL 而退出 0，接进任何管道都是绿灯。

只写 .cand。
"""
import io, os, sys

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
SRC = os.path.join(ROOT, "out", "_probe", "artifact-consistency.py")
cand = SRC + ".cand"

raw = io.open(SRC, "rb").read()
crlf = b"\r\n" in raw
text = raw.decode("utf-8")
if crlf:
    text = text.replace("\r\n", "\n")

A = """    print("\\n合计 %d 个目录，全部交叉一致 %d 个" % (len(targets), npass))
"""
B = """    print("\\n合计 %d 个目录，全部交叉一致 %d 个" % (len(targets), npass))
    # 【能报错 ≠ 能判定】原来这里没有 sys.exit()，打印 FAIL 却一律退出 0：
    # 接进任何脚本/CI 都是绿灯。空目标列表同样不能算通过（空集合不是证据）。
    if not targets:
        sys.exit(2)
    sys.exit(0 if npass == len(targets) else 1)
"""
assert text.count(A) == 1, "锚点命中 %d 次" % text.count(A)
text = text.replace(A, B)

out = text.replace("\n", "\r\n") if crlf else text
io.open(cand, "wb").write(out.encode("utf-8"))
print("  写出 %s  %d B（原 %d B，%+d）换行=%s"
      % (cand, len(out.encode("utf-8")), len(raw),
         len(out.encode("utf-8")) - len(raw), "CRLF" if crlf else "LF"))
