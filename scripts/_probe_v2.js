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
return { items: flat.map(x => { const ed = x.explanation?.errData || {};
  return { type: x.errorType, objType: x.errorObjType, rule: x.ruleName,
    o1: ed.obj1Type, o2: ed.obj2Type, s1: ed.obj1Suffix, s2: ed.obj2Suffix,
    min: x.explanation?.param?.minDistance, should: x.explanation?.param?.shouldBe,
    layer: ed.layerIds, sameComp: ed.isInSameComponent }; }) };
