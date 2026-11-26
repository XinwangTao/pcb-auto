# -*- coding: utf-8 -*-
"""给 pipeline3.js 的 copperPour 补一次「仅在 poured===0 时」的重建。

依据（实测，非推测）：
  - 含 outlineExpandPlan 的尝试 24 次，自述 ok=true 0 次
  - 有 pourMeasured 的 134 次尝试里，pouredCount=0 的 19 次全部落在扩板尝试上；
    未扩板的 115 次里 pouredCount=0 出现 0 次（与板面积无关，300 万 mil² 不扩板也正常）
  - 同一目录的下一次尝试用同样的板框、铺铜 poured=2、ok=true（14/15）
⇒ 板本身没问题，是「扩板与铺铜在同一次会话里」的时序问题。

安全性论证（为什么可以改）：
  新代码的触发条件 pouredAfter === 0，而 poured===0 的尝试历史成功率是 0/24，
  即该分支内的一切行为都不会把「本来能过」变成「过不了」。
  未失败路径一个字节都不受影响（只在原有 if 之后追加）。

只写 .cand，不装盘。
"""
import io, os, sys

ROOT = r"D:\Users\陶鑫旺\Documents\deepseek-harness\default-workspace\pcb-auto"
SRC = os.path.join(ROOT, "scripts", "pipeline3.js")
cand = sys.argv[1] if len(sys.argv) > 1 else SRC + ".cand"

raw = io.open(SRC, "rb").read()
crlf = b"\r\n" in raw
text = raw.decode("utf-8")
if crlf:
    text = text.replace("\r\n", "\n")

# ---- 锚点 1：把 poured 值提到外层作用域 ----
A1 = """  log('copperPours', { count: pourCount });
  if (pourCount > 0) {
"""
B1 = """  log('copperPours', { count: pourCount });
  let pouredAfter = null;
  if (pourCount > 0) {
"""
assert text.count(A1) == 1, "锚点1 命中 %d 次" % text.count(A1)
text = text.replace(A1, B1)

# ---- 锚点 2：现有测量写入 pouredAfter ----
A2 = """      try {
        const ids0 = await eda.pcb_PrimitivePoured.getAllPrimitiveId();
        log('pourRebuilt', { poured: Array.isArray(ids0) ? ids0.length : null });
      } catch (e) {
        log('pourRebuilt', { poured: null, m: String(e && e.message).slice(0, 120) });
      }
    } catch (e) { log('pourRebuildErr', String(e && e.message).slice(0, 200)); }
  }
"""
B2 = """      try {
        const ids0 = await eda.pcb_PrimitivePoured.getAllPrimitiveId();
        pouredAfter = Array.isArray(ids0) ? ids0.length : null;
        log('pourRebuilt', { poured: pouredAfter });
      } catch (e) {
        log('pourRebuilt', { poured: null, m: String(e && e.message).slice(0, 120) });
      }
    } catch (e) { log('pourRebuildErr', String(e && e.message).slice(0, 200)); }
  }
  // 实测：本次尝试刚扩过板时铺铜重算 100% 返回 0（扩板 24/24 失败，未扩板 0/115 为空），
  // 而同一几何在下一次尝试里 poured=2 正常。⇒ 不是板的问题，是同一次会话里的时序问题。
  // 只在已确定为空时补，且副作用从小到大：
  //   ① 强制激活 PCB 后重建一次（不动任何图元）
  //   ② 仍为空才重建覆铜框再 rebuild
  // 该分支历史成功率 0/24，改动不可能伤到能过的路径。
  if (pouredAfter === 0) {
    let n1 = null;
    try {
      await cam('pcb', true);
      await sleep(800);
      await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
      await sleep(1500);
      try {
        const idsR = await eda.pcb_PrimitivePoured.getAllPrimitiveId();
        n1 = Array.isArray(idsR) ? idsR.length : null;
      } catch (e) {}
      log('pourRetry1', { poured: n1 });
      if (n1 !== null) pouredAfter = n1;
    } catch (e) { log('pourRetry1Err', String(e && e.message).slice(0, 160)); }
    if (pouredAfter === 0) {
      try {
        for (const plan2 of gndPlan) {
          try {
            const poly2 = eda.pcb_MathPolygon.createPolygon(
              ['R', x0 + plan2.inset, y0 + plan2.inset,
               w - plan2.inset * 2, h - plan2.inset * 2, 0, 0]);
            await eda.pcb_PrimitivePour.create(
              plan2.net, plan2.layer, poly2, 'solid', false,
              'AI2_' + plan2.net + '_L' + plan2.layer, plan2.priority || 5, 8, false);
          } catch (e) {}
        }
        await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
        await sleep(2000);
        let n2 = null;
        try {
          const idsY = await eda.pcb_PrimitivePoured.getAllPrimitiveId();
          n2 = Array.isArray(idsY) ? idsY.length : null;
        } catch (e) {}
        log('pourRetry2', { first: n1, poured: n2 });
        if (n2 !== null) pouredAfter = n2;
      } catch (e) { log('pourRetry2Err', String(e && e.message).slice(0, 160)); }
    }
  }
"""
assert text.count(A2) == 1, "锚点2 命中 %d 次" % text.count(A2)
text = text.replace(A2, B2)

out = text.replace("\n", "\r\n") if crlf else text
io.open(cand, "wb").write(out.encode("utf-8"))
print("  写出 %s  %d B（原 %d B，+%d）" % (cand, len(out.encode("utf-8")), len(raw), len(out.encode("utf-8")) - len(raw)))
print("  换行 %s" % ("CRLF" if crlf else "LF"))
