// 列出当前所有工程 UUID + 名称，用于定位 grid-search 要复用的工程
const uuids = await eda.dmt_Project.getAllProjectsUuid();
const out = [];
for (const u of (uuids || [])) {
  let info = null, err = null;
  try { info = await eda.dmt_Project.getProjectInfo(u); } catch (e) { err = String(e && e.message).slice(0, 120); }
  out.push({ uuid: u, err, info: info ? JSON.parse(JSON.stringify(info)) : null });
}
return { count: out.length, list: out };
