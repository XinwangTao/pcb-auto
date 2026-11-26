// PCB 自动布局 + 自动布线（作业模型）
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
const log = (s, v) => L.push(v === undefined ? { s } : { s, v });

const pcbUuid = A.pcbUuid;

// 激活 PCB
await eda.dmt_EditorControl.openDocument(pcbUuid);
await eda.dmt_EditorControl.waitForDocumentReady(pcbUuid, 120000);
log('docReady');

// 轮询作业的通用函数
async function waitJob(jobId, maxMs = 300000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    let st = null;
    try { st = await eda.pcb_Document.getAutoJobStatus(jobId); } catch (e) { return { err: String(e && e.message), last }; }
    last = st;
    const state = st?.state ?? st?.status;
    if (state && ['completed', 'failed', 'cancelled', 'canceled'].includes(String(state).toLowerCase())) {
      return { state, st, elapsed: Date.now() - t0 };
    }
    await sleep(1500);
  }
  return { state: 'TIMEOUT', last, elapsed: Date.now() - t0 };
}

// ---- 1. 自动布局 ----
let layoutJob = null;
try {
  layoutJob = await eda.pcb_Document.startAutoLayout();
  log('layoutJob', layoutJob);
} catch (e) { log('layoutStartErr', String(e && e.message)); }

if (layoutJob?.jobId) {
  const r = await waitJob(layoutJob.jobId, 240000);
  log('layoutResult', r);
}

// ---- 2. 读板框/元件位置 ----
try {
  const comps = await eda.pcb_PrimitiveComponent.getAll();
  log('compsAfterLayout', (comps || []).map(c => ({
    des: c.getState_Designator?.(), x: c.getState_X?.(), y: c.getState_Y?.(),
  })));
} catch (e) { log('compsErr', String(e && e.message)); }

// ---- 3. 自动布线（ULTRA_FAST 极速引擎）----
let routeJob = null;
try {
  routeJob = await eda.pcb_Document.startAutoRouting({
    optimization: EPCB_AutoRoutingOptimization.ULTRA_FAST,
    existingPrimitiveMode: EPCB_AutoRoutingExistingPrimitiveMode.REMOVE,
    engineConfig: {
      layers: [{ id: 1, dir: 'V' }, { id: 2, dir: 'H' }],
    },
  });
  log('routeJob', routeJob);
} catch (e) {
  log('routeStartErr', String(e && e.message));
  // 回退：常规引擎
  try {
    routeJob = await eda.pcb_Document.startAutoRouting({});
    log('routeJobFallback', routeJob);
  } catch (e2) { log('routeFallbackErr', String(e2 && e2.message)); }
}

if (routeJob?.jobId) {
  const r = await waitJob(routeJob.jobId, 400000);
  log('routeResult', r);
  try { log('routeLog', (await eda.pcb_Document.getAutoJobLog(routeJob.jobId) || '').slice?.(0, 2000)); } catch (e) { }
}

await eda.pcb_Document.save();

// ---- 4. 网络长度（判断是否真的布通）----
try {
  const names = await eda.pcb_Net.getAllNetsName();
  const lens = [];
  for (const n of (names || []).slice(0, 20)) {
    try { lens.push({ n, len: await eda.pcb_Net.getNetLength(n) }); } catch (e) { }
  }
  log('netLengths', lens);
} catch (e) { log('netLenErr', String(e && e.message)); }

return L;
