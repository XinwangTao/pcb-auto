// DRC + 生产资料导出
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });

const pcbUuid = A.pcbUuid;
await eda.dmt_EditorControl.openDocument(pcbUuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbUuid, 120000);
log('docReady');
await sleep(1500);

// ---- DRC ----
try { log('drcCheck', await eda.pcb_Drc.check(true, false, false)); }
catch (e) { log('drcErr', String(e && e.message)); }
try { log('drcResult', await eda.pcb_Drc.getDrcResult()); }
catch (e) { log('drcResErr', String(e && e.message)); }

// ---- 导出：必须用 saveFileToFileSystem ----
const outDir = A.outDir;
const fs = eda.sys_FileSystem;

function toBlob(data) {
  if (data instanceof Blob) return data;
  if (typeof data === 'string') return new Blob([data]);
  return new Blob([JSON.stringify(data)]);
}

const results = [];
async function exportOne(name, getter) {
  try {
    const data = await getter();
    if (!data) { results.push({ name, ok: false, why: 'null' }); return; }
    const blob = toBlob(data);
    const r = await fs.saveFileToFileSystem(outDir + '\\' + name, blob, name);
    results.push({ name, ok: !!r, size: blob.size, type: blob.type, r: String(r) });
  } catch (e) {
    results.push({ name, ok: false, err: String(e && e.message) });
  }
}

await exportOne('Gerber.zip', () => eda.pcb_ManufactureData.getGerberFile('AI_Board'));
await exportOne('BOM.xlsx', async () => await eda.pcb_ManufactureData.getBomFile());
await exportOne('PnP.csv', () => eda.pcb_ManufactureData.getPickAndPlaceFile('AI_Board', 'csv', 'mm'));
await exportOne('Netlist.json', () => eda.pcb_Net.getNetlist());
log('exports', results);

return L;
