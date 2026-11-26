const args = (typeof __CLI__ !== 'undefined' && __CLI__.args) || {};
const uuid = String(args.uuid || '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (typeof eda === 'undefined') return { ok: false, err: 'no eda' };
await eda.dmt_Project.openProject(uuid);
await sleep(3000);
try { await eda.dmt_Project.waitForReady(uuid, 60000); } catch (e) { }
await sleep(1500);
const boards = await eda.dmt_Board.getAllBoardsInfo();
const pcbs = await eda.dmt_Pcb.getAllPcbsInfo();
return { boards, pcbs, boardKeys: boards && boards[0] ? Object.keys(boards[0]) : null, pcbKeys: pcbs && pcbs[0] ? Object.keys(pcbs[0]) : null };
