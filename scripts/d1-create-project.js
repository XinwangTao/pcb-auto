// 增量诊断：只建工程
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const friendly = __CLI__.args.friendly;
let projectUuid = null, err = null;
try {
  projectUuid = await eda.dmt_Project.createProject(friendly, undefined, undefined, undefined, 'AI auto');
  L.push({ step: 'createProject', projectUuid });
} catch (e) { err = { at: 'createProject', m: String(e && e.message), stack: String(e && e.stack).slice(0, 500) }; }

if (projectUuid) {
  try { L.push({ step: 'waitForReady', r: await eda.dmt_Project.waitForReady(projectUuid, 60000) }); }
  catch (e) { err = { at: 'waitForReady', m: String(e && e.message) }; }

  try { L.push({ step: 'boards', r: await eda.dmt_Board.getAllBoardsInfo() }); }
  catch (e) { err = { at: 'getAllBoardsInfo', m: String(e && e.message) }; }

  try { L.push({ step: 'projectInfo', r: await eda.dmt_Project.getProjectInfo(projectUuid) }); }
  catch (e) { err = { at: 'getProjectInfo', m: String(e && e.message) }; }
}
return { projectUuid, L, err };
