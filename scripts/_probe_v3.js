const A = __CLI__.args;
await eda.dmt_Project.openProject(A.uuid);
await new Promise(r => setTimeout(r, 3000));
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
await new Promise(r => setTimeout(r, 2000));
const d = await eda.pcb_Drc.check(true, false, true);
const flat = [];
const walk = (n) => { if (!n) return; if (Array.isArray(n)) { n.forEach(walk); return; }
  if (n.errorType) flat.push(n); if (n.list) walk(n.list); };
walk(d);
const out = [];
for (const x of flat) {
  const ed = x.explanation?.errData || {};
  const rec = { o1: ed.obj1Type, o2: ed.obj2Type, s1: ed.obj1Suffix, s2: ed.obj2Suffix };
  for (const k of ['obj1', 'obj2']) {
    const id = ed[k]; const t = ed[k + 'Type'];
    if (!id) continue;
    try {
      if (t === 'Track') {
        const l = await eda.pcb_PrimitiveLine.get(id);
        if (l) rec[k] = { id, net: l.getState_Net?.(), layer: l.getState_Layer?.(),
          w: l.getState_LineWidth?.(),
          s: [+l.getState_StartX().toFixed(2), +l.getState_StartY().toFixed(2)],
          e: [+l.getState_EndX().toFixed(2), +l.getState_EndY().toFixed(2)] };
      } else if (t === 'SMD Pad') {
        const p = await eda.pcb_PrimitivePad.get(id);
        if (p) { const raw = p.getState_Pad?.();
          const verts = [];
          if (Array.isArray(raw) && Array.isArray(raw[1])) { const a = raw[1];
            for (let i = 0; i < a.length - 1; i++)
              if (typeof a[i] === 'number' && typeof a[i+1] === 'number') verts.push([a[i], a[i+1]]); }
          const xs = verts.map(q=>q[0]), ys = verts.map(q=>q[1]);
          rec[k] = { id, net: p.getState_Net?.(), num: p.getState_PadNumber?.(),
            x: p.getState_X?.(), y: p.getState_Y?.(), verts: verts.length,
            bbox: verts.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null };
        }
      }
    } catch (e) { rec[k+'Err'] = String(e && e.message).slice(0, 80); }
  }
  out.push(rec);
}
return { n: flat.length, out };
