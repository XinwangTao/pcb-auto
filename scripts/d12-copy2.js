// 探针2：打开工程后再 copyProject
const A = __CLI__.args;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = { tries: [] };
await eda.dmt_Project.openProject(A.uuid);
await sleep(2500);
try { await eda.dmt_Project.waitForReady(A.uuid, 60000); } catch (e) {}
try { out.before = await eda.dmt_Project.getAllProjectsUuid(); } catch (e) { out.beforeErr = String(e && e.message).slice(0, 100); }
try { out.info = await eda.dmt_Project.getProjectInfo(A.uuid); } catch (e) { out.infoErr = String(e && e.message).slice(0, 100); }
// 试 (uuid, name)
try { const r = await eda.dmt_Project.copyProject(A.uuid, 'D12_SCRATCH_A'); out.tries.push({ f: 'uuid,name', r: r === undefined ? 'undefined' : JSON.stringify(r).slice(0, 200) }); }
catch (e) { out.tries.push({ f: 'uuid,name', err: String(e && e.message).slice(0, 200) }); }
await sleep(2000);
try { out.after = await eda.dmt_Project.getAllProjectsUuid(); } catch (e) { out.afterErr = String(e && e.message).slice(0, 100); }
return out;
