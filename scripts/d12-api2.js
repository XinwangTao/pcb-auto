// 反射：几何/DRC/工程模块方法清单（不打开工程，快）
const out = {};
const list = (o) => { if (!o) return null; const s = new Set(); let p = o; let d = 0;
  while (p && d < 4) { for (const k of Object.getOwnPropertyNames(p)) if (typeof p[k] === 'function' || /^get|^set/.test(k)) s.add(k); p = Object.getPrototypeOf(p); d++; }
  return [...s].sort(); };
for (const k of ['pcb_Primitive', 'pcb_PrimitiveObject', 'pcb_PrimitivePad', 'pcb_PrimitiveLine', 'pcb_Drc', 'pcb_PrimitivePour', 'dmt_Project', 'dmt_Pcb', 'pcb_Document'])
  out[k] = list(eda[k]);
out.copyProjectSrc = String(eda.dmt_Project.copyProject).slice(0, 500);
out.drcCheckSrc = String(eda.pcb_Drc.check || '').slice(0, 300);
out.padModifySrc = String(eda.pcb_PrimitivePad.modify || '').slice(0, 300);
return out;
