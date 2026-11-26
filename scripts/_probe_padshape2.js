const out = {};
for (const [k, id] of [['pad4','46609f0319331ca3e16'], ['pad1','46609f0319331ca3e13'],
                       ['pad20','d3eee3098e609d32e183'], ['pad19','d3eee3091CA3e184']]) {
  try {
    const p = await eda.pcb_PrimitivePad.get(id);
    if (!p) { out[k] = 'nf'; continue; }
    const raw = p.getState_Pad?.();
    out[k] = { raw: JSON.stringify(raw).slice(0, 300), type: p.getState_PadType?.(),
      x: p.getState_X?.(), y: p.getState_Y?.(), rot: p.getState_Rotation?.(),
      net: p.getState_Net?.(), num: p.getState_PadNumber?.() };
  } catch (e) { out[k] = 'err: ' + String(e && e.message).slice(0, 80); }
}
// 顺便拿 pad19 正确 id
const all = [];
for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
  try { const p = await eda.pcb_PrimitivePad.get(id);
    if (String(p?.getState_Net?.()).toUpperCase() === 'GND' &&
        Math.abs(p.getState_X() - 1378.5) < 1 && Math.abs(p.getState_Y() + 201.4) < 1) {
      all.push({ id, raw: JSON.stringify(p.getState_Pad?.()).slice(0, 200) });
    }
  } catch (e) {}
}
out.pad19found = all;
return out;
