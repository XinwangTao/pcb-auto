const A = __CLI__.args;
await eda.dmt_Project.openProject(A.uuid);
await new Promise(r => setTimeout(r, 3000));
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
await eda.dmt_EditorControl.openDocument(pcbs[0].uuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbs[0].uuid, 60000);
await new Promise(r => setTimeout(r, 2000));

const before = await eda.pcb_Drc.check(true, false, false);

// 删掉贯穿 GND 焊盘的斜线
await eda.pcb_PrimitiveLine.delete('086aad2da5f0fc2e');

// pad20 (1362.7,-201.4) → 下方 → 左侧走廊 x=1306 → 上行 → pad1 (1349.5,-62.4)
const W = 6.5, NET = 'XTAL_IN', L = 1;
const pts = [
  [1362.7, -201.4],
  [1362.7, -232.0],
  [1306.0, -232.0],
  [1306.0, -62.4],
  [1349.5, -62.4],
];
for (let i = 0; i < pts.length - 1; i++) {
  await eda.pcb_PrimitiveLine.create(NET, L, pts[i][0], pts[i][1], pts[i+1][0], pts[i+1][1], W);
}
await eda.pcb_Document.save();
await new Promise(r => setTimeout(r, 1500));
try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) {}
await new Promise(r => setTimeout(r, 2500));

const after = await eda.pcb_Drc.check(true, false, false);
const d = await eda.pcb_Drc.check(true, false, true);
const flat = [];
const walk = (n) => { if (!n) return; if (Array.isArray(n)) { n.forEach(walk); return; }
  if (n.errorType) flat.push({ t: n.errorType, s1: n.explanation?.errData?.obj1Suffix,
    s2: n.explanation?.errData?.obj2Suffix, min: n.explanation?.param?.minDistance,
    should: n.explanation?.param?.shouldBe }); if (n.list) walk(n.list); };
walk(d);
return { before, after, remaining: flat };
