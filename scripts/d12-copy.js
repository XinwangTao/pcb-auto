// 探针：copyProject 调用形式
const A = __CLI__.args;
const out = { tries: [] };
const forms = [
  () => eda.dmt_Project.copyProject(A.uuid),
  () => eda.dmt_Project.copyProject(A.uuid, 'D12_SCRATCH_A'),
  () => eda.dmt_Project.copyProject(A.uuid, 'D12_SCRATCH_B', ''),
];
for (let i = 0; i < forms.length; i++) {
  try {
    const r = await forms[i]();
    out.tries.push({ i, ok: true, r: typeof r === 'object' ? JSON.stringify(r).slice(0, 300) : String(r) });
  } catch (e) { out.tries.push({ i, ok: false, err: String(e && e.message).slice(0, 200) }); }
}
try { const all = await eda.dmt_Project.getAllProjectsUuid(); out.projectCount = Array.isArray(all) ? all.length : all; } catch (e) { out.pErr = String(e && e.message).slice(0, 120); }
return out;
