// GUI 录屏演示脚本 v3：先在 GUI 里真实打开工程、逐阶段展示，再录。
// 依据 api/methods.csv 实测修正：
//   - waitForDocumentReady / zoomToAllPrimitives 在 dmt_EditorControl
//   - SCH_Net 无方法，网络高亮只在 PCB 侧
//   - pcb_Document.zoomToBoardOutline 存在
// args: { projectUuid, nets:[...], stepMs }

async function main() {
  const r = { steps: [] };
  const t0 = Date.now();
  const log = (k, v) => { r.steps.push({ k, v, t: Date.now() - t0 }); };
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));

  const D = __CLI__.args;
  const STEP = D.stepMs || 1200;

  try {
    await eda.dmt_Project.openProject(D.projectUuid);
    await eda.dmt_Project.waitForReady(D.projectUuid, 60000);
  } catch (e) { log('openErr', String(e && e.message).slice(0, 100)); }
  await wait(2000);

  const bs = await eda.dmt_Board.getAllBoardsInfo();
  const board = bs && bs[0];
  if (!board) { log('err', 'no board'); return r; }
  const pageUuid = board.schematic.page[0].uuid;
  const pcbUuid = board.pcb.uuid;

  // ---- 原理图 ----
  await eda.dmt_EditorControl.openDocument(pageUuid);
  await eda.dmt_EditorControl.waitForDocumentReady(pageUuid, 60000);
  log('openSch', 'ok');
  await wait(STEP);

  await eda.dmt_EditorControl.zoomToAllPrimitives();
  log('zoomSch', 'ok');
  await wait(STEP * 2);

  // 原理图分区域放大巡览（制造镜头移动感，证明是真在操作）
  for (const z of [0.7, 1.0, 1.4, 1.0]) {
    try {
      await eda.dmt_EditorControl.zoomTo(z);
      log('zoom', z);
    } catch (e) { log('zoomErr', String(e && e.message).slice(0, 60)); }
    await wait(STEP);
  }

  // ---- PCB ----
  await eda.dmt_EditorControl.openDocument(pcbUuid);
  await eda.dmt_EditorControl.waitForDocumentReady(pcbUuid, 60000);
  log('openPcb', 'ok');
  await wait(STEP * 2);

  await eda.pcb_Document.zoomToBoardOutline();
  log('zoomPcb', 'ok');
  await wait(STEP * 2);

  // 逐网络高亮：最能体现「布线是怎么连起来的」
  const nets = D.nets || [];
  for (const net of nets) {
    try {
      await eda.pcb_Net.highlightNet(net);
      log('hlPcb', net);
    } catch (e) { log('hlPcbErr', net); }
    await wait(STEP);
  }
  try { await eda.pcb_Net.unhighlightAllNets(); } catch (e) {}
  await wait(400);

  // 收尾全板
  await eda.pcb_Document.zoomToBoardOutline();
  log('final', 'ok');
  await wait(STEP * 2);

  return r;
}
return await main();
