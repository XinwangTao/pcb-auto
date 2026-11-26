// 探针：打开工程 → 枚举焊盘形状（RECT/POLYGON/其它）→ 抓 getState_Pad 原始结构 → DRC 概况
// 用法：lceda-pro invoke --code-file scripts/d12-probe.js --args '{"uuid":"..."}'
const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { uuid: A.uuid };

await eda.dmt_Project.openProject(A.uuid);
await sleep(3000);
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
out.pcbUuid = pcbs?.[0]?.uuid;
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 120000);
await sleep(2000);

// ---- 1. 焊盘形状普查 ----
const pads = [];
const byShape = {};
for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
  try {
    const p = await eda.pcb_PrimitivePad.get(id);
    if (!p) continue;
    const raw = p.getState_Pad?.();
    const shape = Array.isArray(raw) ? String(raw[0]) : typeof raw;
    byShape[shape] = (byShape[shape] || 0) + 1;
    pads.push({
      id,
      shape,
      raw: JSON.stringify(raw).slice(0, 400),
      x: p.getState_X?.(), y: p.getState_Y?.(),
      rot: p.getState_Rotation?.(),
      net: p.getState_Net?.(),
      num: p.getState_PadNumber?.(),
      layer: p.getState_Layer?.(),
    });
  } catch (e) { }
}
out.byShape = byShape;
out.padCount = pads.length;
// 每类取样 3 个，外加所有 RECT（含 rotation 非 0 的更值钱）
out.samples = [];
const seen = {};
for (const p of pads) {
  const k = p.shape;
  seen[k] = (seen[k] || 0) + 1;
  if (seen[k] <= 3 || (p.shape === 'RECT' && Number(p.rot) !== 0)) out.samples.push(p);
}
out.rectAll = pads.filter(p => p.shape === 'RECT').slice(0, 40);
out.polyCount = pads.filter(p => p.shape === 'POLYGON').length;

// ---- 2. 目标焊盘（USB-C 屏蔽壳）----
const target = pads.find(p => /e6e35/i.test(p.id));
out.targetPad = target || null;

// ---- 3. DRC ----
async function scan() {
  const passed = await eda.pcb_Drc.check(true, false, false);
  const d = await eda.pcb_Drc.check(true, false, true);
  const flat = [];
  const walk = (n) => { if (!n) return; if (Array.isArray(n)) { n.forEach(walk); return; } if (n.errorType) flat.push(n); if (n.list) walk(n.list); };
  walk(d);
  return {
    passed,
    total: flat.length,
    broken: flat.filter(x => x.errorType === 'Connection Error').length,
    clearance: flat.filter(x => x.errorType === 'Clearance Error').length,
    others: [...new Set(flat.map(x => x.errorType))],
    flat: flat.map(x => {
      const ed = x.explanation?.errData || {};
      return { errorType: x.errorType, errorObjType: x.errorObjType,
        obj1: ed.obj1, obj1Type: ed.obj1Type, obj1Suffix: ed.obj1Suffix,
        obj2: ed.obj2, obj2Type: ed.obj2Type, obj2Suffix: ed.obj2Suffix,
        position: ed.position, minDistance: ed.minDistance, net: x.net || ed.net,
        param: x.explanation?.param };
    }),
  };
}
const s = await scan();
out.before = s;
return out;
