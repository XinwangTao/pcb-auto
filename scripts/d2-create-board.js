// 诊断2：createBoard 无参自动建 原理图+PCB 对
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
let err = null;

// 1. 打开当前工程（bare editor 里可能没有工程）
let cur = null;
try { cur = await eda.dmt_Project.getCurrentProjectInfo(); L.push({ step: 'current', uuid: cur?.uuid, name: cur?.friendlyName }); }
catch (e) { L.push({ step: 'current', error: String(e && e.message) }); }

// 2. 用上次建的工程
const targetUuid = __CLI__.args.projectUuid;
if (targetUuid) {
  try {
    const opened = await eda.dmt_Project.openProject(targetUuid);
    L.push({ step: 'openProject', opened });
    await sleep(2000);
    await eda.dmt_Project.waitForReady(targetUuid, 60000);
  } catch (e) { err = { at: 'openProject', m: String(e && e.message) }; }
}

// 3. 无参 createBoard 自动建一对文档
try {
  const boardName = await eda.dmt_Board.createBoard();
  L.push({ step: 'createBoard()', boardName });
} catch (e) { err = { at: 'createBoard', m: String(e && e.message) }; }

await sleep(2000);
await eda.dmt_Project.waitForReady(undefined, 60000);

// 4. 回读工程树
try { const b = await eda.dmt_Board.getAllBoardsInfo(); L.push({ step: 'boards', v: b }); } catch (e) { err = { at: 'boards', m: String(e && e.message) }; }
try { const s = await eda.dmt_Schematic.getAllSchematicsInfo(); L.push({ step: 'schematics', v: s }); } catch (e) { err = { at: 'schematics', m: String(e && e.message) }; }
try { const p = await eda.dmt_Pcb.getAllPcbsInfo(); L.push({ step: 'pcbs', v: p }); } catch (e) { err = { at: 'pcbs', m: String(e && e.message) }; }
try { const c = await eda.dmt_Project.getCurrentProjectInfo(); L.push({ step: 'currentAfter', uuid: c?.uuid, name: c?.friendlyName }); } catch (e) { }

return { L, err };
