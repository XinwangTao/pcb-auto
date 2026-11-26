// 验证网表 + DRC（需先打开原理图图页）
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });

// 打开图页激活文档
await eda.dmt_EditorControl.openDocument(A.pageUuid);
await eda.dmt_EditorControl.waitForDocumentReady(A.pageUuid, 60000);
log('docReady');

// 网表
try {
  const netlist = await eda.sch_Netlist.getNetlist();
  log('netlist', typeof netlist === 'string' ? netlist.slice(0, 3000) : netlist);
} catch (e) { log('netlistErr', String(e && e.message)); }

// 原理图 DRC
try {
  const drc = await eda.sch_Drc.check();
  log('schDrc', drc);
} catch (e) { log('schDrcErr', String(e && e.message)); }

// 器件列表
try {
  const ids = await eda.sch_PrimitiveComponent.getAllPrimitiveId();
  log('primIds', ids);
} catch (e) { log('primErr', String(e && e.message)); }

return L;
