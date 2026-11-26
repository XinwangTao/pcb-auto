// 预热脚本：把 GUI 会话里所有慢操作先跑一遍，消除后续 invoke 的冷启动开销。
// 背景：GUI 模式下 openProject/waitForReady/openDocument 首次调用约 60s，
// 若直接开始录制会拍到 60s 空等画面。必须先热身，再录制。
// args: { projectUuid }

async function main() {
  const r = { steps: [] };
  const t0 = Date.now();
  const log = (k, v) => { r.steps.push({ k, v, t: Date.now() - t0 }); };
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  const D = __CLI__.args;

  log('start', D.projectUuid || '(none)');

  try {
    if (D.projectUuid) {
      await eda.dmt_Project.openProject(D.projectUuid);
      await eda.dmt_Project.waitForReady(D.projectUuid, 120000);
      log('openProject', 'ok');
    }
  } catch (e) { log('openProjectErr', String(e && e.message).slice(0, 120)); }
  await wait(500);

  const bs = await eda.dmt_Board.getAllBoardsInfo();
  const board = bs && bs[0];
  if (!board) { log('err', 'no board'); return r; }
  log('boards', bs.length);

  const pageUuid = board.schematic.page[0].uuid;
  const pcbUuid = board.pcb.uuid;

  // 两次文档切换都跑一遍，把渲染管线热起来
  for (const [name, u] of [['sch', pageUuid], ['pcb', pcbUuid], ['sch', pageUuid]]) {
    try {
      await eda.dmt_EditorControl.openDocument(u);
      await eda.dmt_EditorControl.waitForDocumentReady(u, 120000);
      log('warm_' + name, 'ok');
    } catch (e) { log('warm_' + name + 'Err', String(e && e.message).slice(0, 100)); }
  }

  // 热一次缩放，确认渲染通道可用
  try {
    await eda.dmt_EditorControl.zoomToAllPrimitives();
    log('warmZoom', 'ok');
  } catch (e) { log('warmZoomErr', String(e && e.message).slice(0, 80)); }

  log('totalMs', Date.now() - t0);
  return r;
}
return await main();
