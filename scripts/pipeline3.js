// ============================================================
// pcb-auto 全流程 v3 —— 设计只给 LCSC 编号，运行时解析器件
// 输入 __CLI__.args:
//   design : {
//     name, friendly, boardWidthMil, boardHeightMil,
//     components: [{ des, lcsc, value? }],
//     connections: [[des, pinKey, net], ...]
//   }
//   outDir
// ============================================================
const L = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = __CLI__.args;
// 【每条遥测都带 ms】T0 必须在 log 之前定义，否则 log 里引用它就是一个
// 靠“没人提前调用”才不爆的 TDZ 引用。之前只有 phase() 打 ms，
// 于是整条流水线的总耗时**无法归因到阶段** —— 而“这个修复阶段值不值得留”
// 恰恰只能靠归因回答。实测 2026-11-27：136 条条目里 0 条带时间。
const T0 = Date.now();
const log = (s, v) => L.push(v === undefined ? { s, ms: Date.now() - T0 } : { s, v, ms: Date.now() - T0 });
const phase = n => log('PHASE', { n, ms: Date.now() - T0 });

// ---------- 总预算：外部 invoke --timeout 的镜像 ----------
// 外部 CLI 的 --timeout 到期**不会**中断 render 里的代码，CLI 原文是
// "gave up waiting; the code may still be running in the render, and its result will be
//  discarded"。所以必须让流水线自己在外层掐断之前收尾并 return；否则留下幽灵调用，
// 紧接着的下一次 invoke 撞上它 → 非 JSON（REQUEST_TIMEOUT / SESSION_CLOSED）→
// run-all 报「输出不是 JSON」，一个设计超时会把后面所有设计拖成「无声失败、策略=?」。
// 实测：d7 生产 r2 跑满 1316.6s 两次 REQUEST_TIMEOUT，紧接着 d8 直接 SESSION_NOT_FOUND。
// run-all.ps1 传 budgetMs（= --timeout - 60s），缺省 530000 与 590000 对齐。
const BUDGET = Number((A && A.budgetMs) || 530000);
const left = () => BUDGET - (Date.now() - T0);
log('budget', { totalMs: BUDGET });

// 录屏模式（args.recordMode）：让录制画面始终能看清 AI 在做什么。
//
// 踩过的坑（都实测过，别再走回头路）：
//  1) 只调用 zoomToAllPrimitives 不够——placeParts/connect 期间前台文档是 PCB，
//     原理图在后台被 API 修改，画面停在**空白 PCB 画布**上，录出来是死画面。
//  2) activateDocument 也不行——实测画面依旧空白，而且把 connect 阶段从 9s 拖到 128s。
//  3) tileAllDocumentToSplitScreen() 曾被认为是解法，**实测是错的**：它把画布切成
//     左右两半，PCB 只剩 737x204，板子缩在中间一条；而原理图那一半在无头环境下
//     渲出来是空网格（d13 的 0000-sch-wired.png 只有标尺、零器件）。分屏两头都亏。
//     视频只讲 PCB，所以现在**不分屏**，PCB 独占整个画布。
const REC = !!(A && A.recordMode);
const DOC = { sch: null, pcb: null };
// cam() 用：每个文档只 openDocument 一次（openDocument 会重载文档，中途重载会
// 打断正在写入的几何，实测把 d7 从 280s/0违规拖到 742s/52违规）
const openedDoc = { sch: false, pcb: false };
// force: 是否强制 openDocument 切换激活文档。
//   - PCB 侧只在真正要驱动编辑器动作前后需要一次（布线前后），否则布线结果不落盘
// 实测：每次 openDocument 额外 3–8s；高频调用把 connect 从 9s 拖到 127s，
// 而完全不用 openDocument 会让 DRC 报 23 处 Connection Error。所以只在关键点强制。
async function cam(what, force) {
  if (!REC) return;
  // 【不再分屏】tileAllDocumentToSplitScreen 把画布切成左右两半，PCB 只剩
  // 737x204（实测 d7 录制），板子缩在中间一条，做视频没法看；而原理图那一半
  // 在无头环境下渲出来是空网格（实测 d13 的 0000-sch-wired.png 只有标尺与
  // 网格、没有任何器件），所以分屏两头都亏。视频只讲 PCB，直接占满整个画布。
  //
  // 【openDocument 必须节制】原实现只在 force 时开文档，另有一次性分屏开两种。
  // 曾试图"每次 cam 都开一次"以保证画面同步，实测代价极大：d7 录制从 280s 涨到
  // 742s，且最终 DRC 从 0 违规恶化到 52 处 —— openDocument 会重新加载文档，
  // 布线中途重载会打断正在进行的几何写入（这正是注释里"高频调用把 connect
  // 从 9s 拖到 127s"的同一种副作用）。所以：每个文档只开一次，其余只在 force 时开。
  const uuid = DOC[what];
  try {
    if (uuid && (force || !openedDoc[what])) {
      await eda.dmt_EditorControl.openDocument(uuid);
      await eda.dmt_EditorControl.waitForDocumentReady(uuid, force ? 30000 : 60000);
      await sleep(force ? 250 : 800);
      openedDoc[what] = true;
    }
    if (what === 'pcb') {
      // zoomToBoardOutline 可能返回 false 也可能抛错。原实现整段被 catch 吞掉且
      // **不留任何日志**，于是"相机没动"和"相机成功"在日志里长得一模一样 ——
      // 与 shot() 里那个 TDZ 是同一种病：失败被降级成无记录。
      let zok = null, zerr = null;
      try { zok = await eda.pcb_Document.zoomToBoardOutline(); }
      catch (e) { zerr = String(e && e.message).slice(0, 80); }
      log('cam', { what, force: !!force, zoom: zok, zoomErr: zerr });
    } else {
      // 原理图：只 fit 全图。**不要**叠 zoomToRegion——坐标语义未验证，
      // 传大矩形等于缩到极小（拍到一片空白）。
      let zerr = null;
      try { await eda.dmt_EditorControl.zoomToAllPrimitives(); }
      catch (e) { zerr = String(e && e.message).slice(0, 80); }
      log('cam', { what, force: !!force, zoomErr: zerr });
    }
  } catch (e) {
    // 相机失败不阻断主流程，但**必须留痕**，否则又是静默失败
    log('camErr', { what, m: String(e && e.message).slice(0, 120) });
  }
  await sleep(150);
}

// ---------- 录制：把画布真实渲染帧落盘 ----------
// 为什么不用桌面录屏当素材：实测 gdigrab 拍到的画面 60~75% 是冻结帧，
// 因为流水线连续调用 API 写图元期间浏览器拿不到合成帧，只有 waitJob 的
// 空闲间隙才会出画面，原理图区甚至整段全黑。
// 而 `getCurrentRenderedAreaImage` 是 EDA 自己把画布**渲染**成图像，
// 不依赖桌面是否重绘，因此每次调用都必然拿到当前真实画面。
// 它还顺带强制了一次渲染 pass —— 这正是让 gdigrab 同时拍活的关键。
// 目录必须预先存在（PowerShell 侧创建），因为这里无法 mkdir。
const FRAMES = REC ? String((A && A.framesDir) || '') : '';
let shotN = 0;
// 【TDZ 陷阱，已经真踩过，别再挪走】
// `fs` 原先声明在文件末尾第 10 节「导出」里，而 shot() 在第 4~9 节就被调用。
// `const` 的初始化不提升，于是每次 shot() 都在 `fs.saveFileToFileSystem` 抛
// "Cannot access 'fs' before initialization"，被 shot() 自己的 catch 吞成一条
// shotErr。真实后果：录制模式整轮跑完、产出 0 张 PNG，而日志里看不到堆栈。
// 取证 logs/SHT30_LDO_Module-20261125-205233.json：10 条 shotErr 全是这句话。
// 注意顺序证明的画面事实：同一函数里 L100 的 getCurrentRenderedAreaImage() 与
// L102 的 new Blob([await img.arrayBuffer()]) **都已成功**（否则错误会停在那两行），
// 即 EDA 在 headless 下确实能把画布渲染成图像 —— 唯一障碍就是这个声明位置。
// 所以 `fs` 必须声明在所有 shot() 调用之前，不能为了"就近使用"再挪回导出段。
const fs = eda.sys_FileSystem;
async function shot(tag) {
  if (!REC || !FRAMES) return null;
  // 独立判据：`fs` 不可用要单独记 shotNoFs，不能和"画布拿不到图"混成一条 shotErr。
  // 上一次的静默失败就是被笼统的 catch 掩掉的（详见上面的 TDZ 注释）。
  if (!fs || typeof fs.saveFileToFileSystem !== 'function') {
    log('shotNoFs', { tag, hasFs: !!fs });
    return null;
  }
  try {
    // 【偶发空图要重试，不能一次就丢帧】getCurrentRenderedAreaImage 在切镜头后
    // 的第一拍常常返回空（画布还没重绘完）。此前一次空就 shotNone 收工，
    // 于是"这一轮没有原理图帧/布线帧"。重试**必须有上限**：用无界等待会把
    // 一次渲染故障变成整轮超时。
    let img = null;
    for (let t = 0; t < 4 && !img; t++) {
      if (t > 0) await sleep(250);
      try { img = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(); } catch (e) { img = null; }
    }
    if (!img) { log('shotNone', { tag }); return null; }   // beta 接口，可能不可用
    const blob = new Blob([await img.arrayBuffer()], { type: img.type || 'image/png' });
    const name = `${String(shotN++).padStart(4, '0')}-${tag}.png`;
    // 【目录判定只认正斜杠 "/"，反斜杠会静默丢 fileName —— 这坑比 TDZ 更阴】
    // api.js 里 saveFileToFileSystem 的真实实现是：
    //   let r = !/\/$/.test(uri);
    //   if (!r && !fileName) return false;
    //   r || (uri = uri + fileName);
    //   fetch(`app://api/client/writeFileSync?path=${uri}...`)
    // 即 uri 以 "/" 结尾才算目录、才会拼 fileName；而 uri 以 "\" 结尾时 r=true，
    // **fileName 被整个丢弃**，最终去写名为 "<目录>\" 的路径 → 落到目录上 →
    // 返回 false，**不抛异常**。于是表现为"调用成功、日志正常、一个文件都没有"。
    // JSDoc 写的是"Windows 下 uri 结尾带反斜杠即识别为目录"，与实现不一致，不能信。
    // 所以这里改用**全路径**写法（与导出段已验证可用、6 件产物全部落盘的
    // :2281 / :2341 完全同形）：uri 不以 "/" 结尾 → r=true → uri 原样当文件路径。
    const full = FRAMES + '\\' + name;
    const ok = await fs.saveFileToFileSystem(full, blob, name);
    log('shot', { tag, bytes: img.size, name, ok });
    // 写入被拒（返回 false 而非抛错）必须单独记一个键，否则与"成功"在日志里分不清
    if (!ok) log('shotWriteFalse', { tag, path: full, bytes: blob.size });
    return ok ? name : null;
  } catch (e) {
    log('shotErr', { tag, m: String(e && e.message).slice(0, 100) });
    return null;
  }
}
// 只逼重绘、不落盘：放在长流程中间，让外部录屏能持续拿到新帧
async function pulse() {
  if (!REC) return;
  try { await eda.dmt_EditorControl.getCurrentRenderedAreaImage(); } catch (e) { }
}

const D = A.design;
const OUT = A.outDir;
// 工程名必须唯一：同名已存在时 createProject 会静默返回 undefined（不抛错）
const friendly = (D.friendly || ('AI_' + (D.name || 'Board'))) + '_' + Date.now().toString(36);
const errors = [];
const warns = [];
const artifacts = [];
// 环境故障（库服务网络错误/超时）与设计缺陷必须分开记。
// 实测 2026-11-26T19:13 那轮：1 条 Network Error 派出 13 条下游 errors，
// 而 `gates` 里只有 errors 一个通道 —— 读盘者无法分辨"板子不行"和"网络断了"。
const envFaults = [];

// ---------- 开工前先证明「EDA 能写进 OUT」----------
// 实测 2026-11-27（另一台机器 DESKTOP-K087HI9，与本机同版 EDA 4.1.111）：
//   把仓库装在 `D:\projects\pcb-auto` 时，六个导出全部 `ok:false`，
//   但每一个都带着**真实的 size**（Gerber.zip 113614 / Board.pdf 773881）——
//   因为 size 是 blob.size，而写盘失败只是一个 false。于是整轮跑完、
//   产物目录里只有 PowerShell 写的那三个文件，而结论只说“自述未通过”。
// 逐位定位出来的真相：`eda.sys_FileSystem.saveFileToFileSystem` **只允许写 Documents 目录下**。
//   C:\Users\Administrator\Documents\_probe_fs\a.bin  -> true
//   D:\projects\pcb-auto\out\_probe.bin                -> false
//   C:\Users\...\AppData\Local\Temp\_probe.bin        -> false（本机同样 false）
// 这个限制不在任何文档里，而失败是**静默**的。所以开工前先写一个探针：
// 写不进就把它归到 **envFaults**（环境问题）并提前返回，
// 而不是跑一遍 355 秒后把“写不出去”报成“设计未通过”。
let writeProbe = { ok: null, why: null };
try {
  if (!OUT) writeProbe = { ok: false, why: 'outDir 为空' };
  else if (!fs || typeof fs.saveFileToFileSystem !== 'function') writeProbe = { ok: false, why: 'eda.sys_FileSystem 不可用' };
  else {
    const probeBlob = toBlob(new Uint8Array([0x50, 0x42]));
    const probePath = String(OUT).replace(/[\\/]+$/, '') + '\\._write_probe.bin';
    const wr = await fs.saveFileToFileSystem(probePath, probeBlob, '._write_probe.bin');
    writeProbe = { ok: !!wr, why: wr ? null : ('saveFileToFileSystem 对 ' + probePath + ' 返回 ' + String(wr)) };
    if (wr) { try { await fs.deleteFileInFileSystem(probePath); } catch (e) { /* 探针残留无害 */ } }
  }
} catch (e) {
  writeProbe = { ok: false, why: String(e && e.message).slice(0, 160) };
}
log('writeProbe', writeProbe);
if (!writeProbe.ok) {
  envFaults.push('EDA 写盘不可用（' + writeProbe.why + '）。已知限制：'
    + 'eda.sys_FileSystem.saveFileToFileSystem 只允许写入 Documents 目录下的路径。'
    + '请把仓库（或 -OutDir）放到 %USERPROFILE%\\Documents 下再跑。');
  return {
    ok: false, components: 0, connections: 0, mismatches: 0, mismatchCount: 0,
    netSummary: [], errors, envFaults, warns, exports: [], artifacts: artifacts,
    drcPassed: false, drcLeafCount: 0, drcDetailCount: 0, writeProbe, log: L,
  };
}

async function waitDoc(uuid, ms = 120000) {
  await eda.dmt_EditorControl.openDocument(uuid);
  await eda.dmt_EditorControl.waitForDocumentReady(uuid, ms);
}
async function waitJob(jobId, maxMs = 600000, tag = 'job') {
  const t = Date.now();
  let n = 0;
  while (Date.now() - t < maxMs) {
    let st = null;
    try { st = await eda.pcb_Document.getAutoJobStatus(jobId); }
    catch (e) { return { state: 'ERR', err: String(e && e.message) }; }
    const s = String(st?.state ?? st?.status ?? '').toLowerCase();
    if (['completed', 'failed', 'cancelled', 'canceled'].includes(s)) return { state: s, st, ms: Date.now() - t };
    // 视频素材：布局/布线是**过程**（几十秒到几分钟），只在末尾拍一张看不出"怎么画的"。
    // 轮询里每隔 ~6 次（≈7s）抓一帧画布，得到的是布线器真实推进的连续画面。
    // 原来是 %10（≈12s）：d7 整跑 165s、布线只占 40s，只采到 3 张，凑不满 9 段。
    // getCurrentRenderedAreaImage 由 EDA 自己渲染，不依赖桌面合成（这是之前 gdigrab
    // 抓到 60~75% 静止帧的根因），所以无头也能出图。
    if (REC && (++n % 6 === 0)) {
      try { await shot(`${tag}-t${Math.round((Date.now() - t) / 1000)}s`); } catch (e) { }
    }
    await sleep(1200);
  }
  return { state: 'TIMEOUT', ms: Date.now() - t };
}
function toBlob(d) {
  if (d instanceof Blob) return d;
  if (typeof d === 'string') return new Blob([d]);
  return new Blob([JSON.stringify(d)]);
}

// ---------- 0. 解析器件（唯一可信来源）----------
phase('resolveParts');
const lcscList = [...new Set(D.components.map(c => c.lcsc))];
// 库服务是网络依赖：一次抖动会让**整批**器件解析失败，早退成 stage:'resolveParts'，
// 看起来像"料号不存在"。同一类故障在 add 阶段已实测出现过。
let devs = null;
for (let at = 1; at <= 3; at++) {
  let err = null;
  try { devs = await eda.lib_Device.getByLcscIds(lcscList); }
  catch (e) { err = String(e && e.message).slice(0, 160); devs = null; }
  const got = Array.isArray(devs) ? devs.length : 0;
  if (got > 0) { if (at > 1) log('resolveRetry', { attempt: at, got, asked: lcscList.length }); break; }
  log('resolveAttempt', { attempt: at, got, err, asked: lcscList.length });
  if (at === 3) { envFaults.push(`resolveParts: 重试 3 次仍拿不到器件（asked=${lcscList.length}, last=${err || 'empty'})`); break; }
  await sleep(800 * at);
}
const byLcsc = {};
for (const d of (devs || [])) {
  const p = d.otherProperty || {};
  byLcsc[p['Supplier Part']] = {
    lcsc: p['Supplier Part'],
    name: d.name,
    value: p.Value || p['Manufacturer Part'] || d.name,
    klass: p['JLCPCB Part Class'],
    mfr: p['Manufacturer'],
    datasheet: p['Datasheet'],
    footprint: p['Supplier Footprint'],
    symbolUuid: d.symbolUuid,
    footprintUuid: d.footprintUuid,
    libraryUuid: d.libraryUuid,
  };
}
log('resolvedParts', byLcsc);
for (const c of D.components) {
  if (!byLcsc[c.lcsc]) errors.push(`unresolved lcsc ${c.lcsc} for ${c.des}`);
  // 社区上传件（无原厂/datasheet）常见于连接器/定制件：不阻断流程，但记入 warns 供人工复核。
  // 只有「查不到器件」才是致命错误（无法取 symbol/footprint，流程根本跑不下去）。
  else if (!byLcsc[c.lcsc].mfr && !byLcsc[c.lcsc].datasheet) {
    warns.push(`low-trust part ${c.lcsc} for ${c.des} (社区上传件，无原厂/datasheet，下单前建议人工复核)`);
  }
}
if (errors.some(e => e.startsWith('unresolved'))) {
  return { ok: false, stage: 'resolveParts', errors, log: L };
}

// ---------- 1. 建工程 ----------
phase('createProject');
let projectUuid = null;
for (let i = 0; i < 5 && !projectUuid; i++) {
  // 每次重试都用新名字，避免同名静默返回 undefined
  const nm = friendly + (i ? '_r' + i : '');
  try {
    const u = await eda.dmt_Project.createProject(nm, null, null, null, 'AI 全自动生成：' + (D.name || ''));
    if (typeof u === 'string' && u.length > 20) { projectUuid = u; log('projectName', nm); }
    else { log('createProjectEmpty', { attempt: i, name: nm, got: String(u) }); }
  } catch (e) { log('createProjectErr', { attempt: i, m: String(e && e.message) }); }
  if (!projectUuid) await sleep(1200);
}
if (!projectUuid) throw new Error('createProject failed after 5 attempts');
await eda.dmt_Project.openProject(projectUuid);
await sleep(2000);
await eda.dmt_Project.waitForReady(projectUuid, 60000);
log('projectUuid', projectUuid);

// ---------- 2. 建 Board ----------
phase('createBoard');
let board = null;
let boardsCreated = 0;
const existingBoards = (await eda.dmt_Board.getAllBoardsInfo()) || [];
log('boardInventoryStart', { count: existingBoards.length,
  names: existingBoards.map(b => b.name) });
// 预算陷阱：本轮 8 次迭代、每次两个 waitForReady(…,60000)，理论上限
//   8 × (60000 + 2200 + 60000) ≈ 976s —— 比外部 invoke 的 590s 掐断线还长一倍。
// 一旦板子迟迟不出现，整次调用会被外部掐断，CLI 却**不中断** render 里已在跑的代码
// （见文件开头 run-all.ps1 L20 的原文说明），于是留下幽灵调用、
// 紧接的下一次必然 "输出不是 JSON"。d6 正是白跑 976s 后才走到这步。
// 所以每一处等待都必须以剩余预算为上界，留 180s 给后续真正要干的活。
const waitCap = (reserveMs) => Math.max(Math.min(60000, left() - reserveMs), 5000);
for (let i = 0; i < 8 && !board; i++) {
  if (left() < 400000) { log('boardWaitBudgetSkip', { attempt: i, leftMs: left() }); break; }
  let bs = (await eda.dmt_Board.getAllBoardsInfo()) || [];
  if (bs.length === 0 && boardsCreated === 0) {
    // 只有**真没抛异常**才算建过。原实现 `createBoard()` 后立刻 boardsCreated++，
    // 一次静默失败就永久停手，之后 8 轮 × 2 次 waitForReady 白等（远超外部 590s 掐断线），
    // 连「no board」都报不出来。
    try {
      await eda.dmt_Board.createBoard();    // 全程仅此一处建板
      boardsCreated++;
      log('boardCreated', { attempt: i });
    } catch (e) {
      log('boardCreateErr', { attempt: i, m: String(e && e.message).slice(0, 120) });
      await sleep(1500);
      continue;                            // 没建成就还能再试，不消耗建板配额
    }
  } else {
    // 已有板（或用例刚建）→ 等工程树异步刷新，绝不再建
    await eda.dmt_Project.waitForReady(projectUuid, waitCap(180000));
  }
  await sleep(2200);
  await eda.dmt_Project.waitForReady(projectUuid, waitCap(180000));
  bs = (await eda.dmt_Board.getAllBoardsInfo()) || [];
  // 取**第一块同时有原理图页和 PCB** 的板，而不是盲取 bs[0]
  board = bs.find(b => b.schematic?.page?.length && b.pcb) || null;
  if (!board) log('boardWait', { attempt: i, boards: bs.length,
    states: bs.map(b => ({ n: b.name, pages: b.schematic?.page?.length, pcb: !!b.pcb })) });
}
if (!board) throw new Error('no board');
log('boardsCreated', boardsCreated);
const allPcbs = (await eda.dmt_Pcb.getAllPcbsInfo()) || [];
log('pcbInventory', { count: allPcbs.length,
  pcbs: allPcbs.map(p => ({ name: p.name, uuid: p.uuid })) });
if (allPcbs.length > 1) {
  log('pcbDuplicateWarn', { count: allPcbs.length,
    msg: '工程里有多块 PCB，后续一律用 board.pcb.uuid 而非 getAllPcbsInfo()[0]' });
}
const schName = board.schematic.name;
const pageName = board.schematic.page[0].name;
const pageUuid = board.schematic.page[0].uuid;
const schUuid = board.schematic.uuid;
const pcbUuid = board.pcb.uuid;
DOC.sch = schUuid;
DOC.pcb = pcbUuid;
log('board', { name: board.name, schName, pageName, pageUuid, schUuid, pcbUuid });

// ---------- 3. 放器件 ----------
// 网格布局：标准图页约 1200x900 mil（A4 横向），一字排开会超出页面触发
// OBJECTOUTSIDESHEET 警告。列数随器件数放大（最多 7 列），避免器件多时纵向溢出。
await cam('sch');   // 放件前原理图全图
phase('placeParts');
const placed = [];
const nComp = D.components.length;

// 关键修复：布局必须按每个符号的**真实包围盒**排，不能用固定格子。
// 之前固定 DX=160/DY=150，而 RP2040 符号约 250x260、ESP32-WROOM 约 140x280，
// 大符号会压进相邻器件的区域，导致新加的网络标志落在别人的 GND 引脚桩上，
// 整条网络被并进 GND（d11 的 XTAL_IN 4 点全变 GND 就是这么来的）。
// 现在先查 symbol 几何，取半宽/半高参与排版，符号之间留 GAP。
const GAP = 70;          // 符号边缘间距（mil）
const SHEET_W = 1050;    // 单页可用宽度
const extents = [];      // 每个器件的 {hw, hh}
for (let i = 0; i < D.components.length; i++) {
  const part = byLcsc[D.components[i].lcsc];
  let hw = 40, hh = 30;   // 查不到几何时的保守默认值
  try {
    const geo = await eda.lib_Symbol.getGeometry(part.symbolUuid, part.libraryUuid);
    const bb = geo?.bodyBBox || geo?.fullBBox;
    // bodyBBox 形如 {x,y,width,height}；pins 里也带绝对坐标，取两者最大值兜底
    if (bb && isFinite(bb.width) && isFinite(bb.height)) {
      hw = Math.max(hw, Math.abs(bb.width) / 2);
      hh = Math.max(hh, Math.abs(bb.height) / 2);
    }
    for (const p of (geo?.pins || [])) {
      const px = Math.abs(p.x ?? 0), py = Math.abs(p.y ?? 0);
      hw = Math.max(hw, px + 20);   // 引脚端点也要算进来
      hh = Math.max(hh, py + 20);
    }
  } catch (e) { /* 用默认值 */ }
  extents.push({ hw, hh });
}
log('symbolExtents', D.components.map((c, i) => ({ des: c.des, hw: Math.round(extents[i].hw), hh: Math.round(extents[i].hh) })));

// 行式排版：逐行填，放不下就换行；每行高度取该行最高符号
const positions = [];
let curX = 100, curY = 120, rowH = 0;
for (let i = 0; i < extents.length; i++) {
  const { hw, hh } = extents[i];
  const w = hw * 2 + GAP;
  if (curX > 100 && (curX + w - 100) > SHEET_W) {
    curX = 100;
    curY += rowH + GAP;
    rowH = 0;
  }
  positions.push({ x: Math.round(curX + hw), y: Math.round(curY + hh) });
  curX += w;
  rowH = Math.max(rowH, hh * 2);
}
log('placePositions', positions.map((p, i) => ({ des: D.components[i].des, x: p.x, y: p.y })));

for (let i = 0; i < D.components.length; i++) {
  const item = D.components[i];
  const part = byLcsc[item.lcsc];
  const cx = positions[i].x;
  const cy = positions[i].y;
  let r = null;
  try {
    const props = {};
    // 值必须来自**真实器件**，不能照抄设计里手写的标称值。
    // 实测 d2/d3/d4/d13 共 11 处声明 4.7k/1.2k，但 lcsc 全是 C11702（0402WGF1001TCE = 1kΩ），
    // 照抄就会让原理图和 BOM 写着 4.7k、买回来的是 1k —— 交付物自相矛盾，
    // 打样出来的板子与原理图不一致（I2C 用 1k 上拉在 3.3V 下约 3.3mA，还略超标准模式 3mA）。
    // 现在统一取库内该器件的 Value，设计声明只用来做**冲突告警**。
    const real = part && part.value ? String(part.value) : '';
    if (real) props.Value = real;
    // 只在**真的不同**时告警。实测库里的值是 "1kΩ"/"5.1kΩ"，设计写 "1k"/"5.1k"，
    // 直接字符串比较会把 4 个器件全报成冲突，日志被噪声淹没，真冲突反而看不见。
    // 比较前先把**等价的工程写法**折成同一个量（漏掉一种 = 静默漏报）：
    //   100nF == 0.1uF == 100000pF    5.1kΩ -> 5100Ω   4R7 -> 4.7Ω   1k2 -> 1200Ω
    //   2n2 -> 2.2nF                  10µF -> 10uF     1R -> 1Ω      0Ω -> 0Ω
    // 旧实现在这里有 4 个坑，全部已修：
    //   a) 整体 toUpperCase() → 10M(兆) 与 10m(毫) 塌成同一个，真实差异被放过；
    //   b) [RKMNPV] 当小数点时没排除料号 → 1N4148 被读成 1.4148N；
    //   c) 紧跟的 ([NPU])$ -> $1F 又把 b) 的产物补成"合法标称值" 1.4148NF，
    //      于是料号被当成数值参与比较；
    //   d) 100nF 与 0.1uF 归一化后不相等 → 假"错料"（直接 push errors，整轮 ok:false）。
    // 现在改成「先分类、再按量纲归一化」，并把**语法错**与**值不相等**拆成不同日志键。
    if (item.value && real) {
      // 分类 + 归一化。kind 的含义：
      //   num    → 可与同 kind 按 (dim, v) 比数值
      //   code   → 料号（1N4148 / 2N3904 / SS34 / MPN），只做字符串比较，绝不按数值解释
      //   marker → NC/DNP 这类装配标记，不是取值
      //   empty  → 空白
      //   bad    → 像数值却写坏了（1.2.3），这是**语法错**，不是错料
      const parseValue = (s) => {
        const VCH = /^[0-9.RrKkMmNnPpUuFfHhVv]+$/;   // 只由"数值+单位"字符组成 → 可能是写坏的数值
        const MULT = { M: 1e6, m: 1e-3, K: 1e3, k: 1e3, U: 1e-6, u: 1e-6, N: 1e-9, n: 1e-9, P: 1e-12, p: 1e-12 };
        // µ(U+00B5) / μ(U+03BC) 必须先换成 u：两者的大写都是希腊字母 Μ，会和 M(兆) 混淆。
        // 这里**不整体大写** —— M 与 m 的区别（10^6 / 10^-3）要留到 MULT 里判。
        const t = String(s == null ? '' : s).trim()
          .replace(/[µμ]/g, 'u')
          .replace(/[Oo][Hh][Mm][Ss]?/g, '')          // 5.1kOHM / 5.1kohms
          .replace(/Ω/g, '')
          .replace(/[\s\u00a0]+/g, '');
        if (!t) return { kind: 'empty', token: '' };
        // NC/DNP 是装配标记，不是标称值：与任何取值都不可比，更不许算错料。
        if (/^(NC|DNP|DNM|NONE|N\/A|NA|TBD|NULL|-+|\?+)$/i.test(t)) return { kind: 'marker', token: t.toUpperCase() };
        // JEDEC 料号族（1N4148 / 1N4007 / 2N3904 / 1N60）必须在小数点规则**之前**拦下，
        // 否则 1N4148 会被读成 1.4148nF。判据用 JEDEC 命名「1N/2N/3N + ≥2 位数字」：
        // 阈值取 2 位，才能同时放过电容的 1N5（=1.5nF）。
        if (/^[1-3][Nn]\d{2,}/.test(t)) return { kind: 'code', token: t.toUpperCase() };
        let num = null, unit = '';
        // R/K/M/N/P/U 作小数点占位（4R7=4.7Ω、1N5=1.5nF、1k2=1.2kΩ、2n2=2.2nF、1M5=1.5MΩ）。
        // 只在「数字-字母-数字」形状下生效，所以 10M / 10K 走下面的普通分支。
        const rkm = t.match(/^(\d+)([RrKkMmNnPpUu])(\d+)([A-Za-z]*)$/);
        if (rkm) { num = Number(rkm[1] + '.' + rkm[3]); unit = rkm[2] + rkm[4]; }
        else {
          const plain = t.match(/^(\d+(?:\.\d+)?)([A-Za-z]*)$/);
          // 不是"数字开头"的串按料号处理（LM358 / SS34 / CL10B104KO5NNNC 都是这一族）。
          if (!plain) return (VCH.test(t) && /^[0-9]/.test(t)) ? { kind: 'bad', token: t } : { kind: 'code', token: t.toUpperCase() };
          num = Number(plain[1]); unit = plain[2];
        }
        // 拆「前缀 + 基准」：F=电容、H=电感、V=电压、R=电阻；没有基准字母就是「只有前缀」。
        const last = unit.slice(-1);
        const hasBase = /[FfHhVvRr]/.test(last);
        const base = hasBase ? last.toUpperCase() : '';
        const pre = hasBase ? unit.slice(0, -1) : unit;
        if (pre && !(pre in MULT))   // 10KK / 1M5X 这类：前缀不是合法 SI 前缀
          return (VCH.test(t) && /^[0-9]/.test(t)) ? { kind: 'bad', token: t } : { kind: 'code', token: t.toUpperCase() };
        // 量纲：写了 F/H/V/R 就按它定；只写前缀时，N/P/U 量级按电容读（沿用旧实现
        // ([NPU])$ -> $1F 的意图：2n2=2.2nF、8P=8pF），M/K 量级按电阻读。
        // 按"大写 M = 10^6"的规则，'MF' 读作兆法；毫法必须写 'mF'。
        const dim = base === 'F' ? 'C' : base === 'H' ? 'L' : base === 'V' ? 'V'
          : base === 'R' ? 'R' : /[UNPunp]/.test(pre) ? 'C' : 'R';
        // 10 位有效数字归一：100nF(=1e-7) 与 0.1uF(0.1*1e-6 在 IEEE754 里有尾差) 必须落在同一个数上。
        return { kind: 'num', dim, bare: !unit,
          v: Number((num * (pre ? MULT[pre] : 1)).toPrecision(10)), token: t.toUpperCase() };
      };
      const A = parseValue(item.value), B = parseValue(real);
      const shown = { des: item.des, lcsc: item.lcsc, declared: String(item.value), actual: real };
      if (A.kind === 'bad' || B.kind === 'bad') {
        // 写法坏了 ≠ 值不一样：前者改写法，后者才是错料。独立日志键，避免把"写错"当"错料"去换物料。
        log('valueSyntax', { ...shown, badSide: A.kind === 'bad' ? 'declared' : 'actual',
          badToken: (A.kind === 'bad' ? A.token : B.token) });
        warns.push(`valueSyntax ${item.des}(${item.lcsc}): 取值写法无法解析 ` +
          `${A.kind === 'bad' ? '设计' : '器件实际'}="${A.kind === 'bad' ? item.value : real}"`);
      } else if (A.kind === 'empty' || B.kind === 'empty' || A.kind === 'marker' || B.kind === 'marker') {
        // NC/DNP/空白不是标称值：静默跳过。这类器件每板都有，记日志只会淹没真问题。
      } else if (A.kind === 'num' && B.kind === 'num') {
        if (A.dim === B.dim && A.v === B.v) {
          // 数值等价（100nF==0.1uF==100000pF、4R7==4.7Ω、1k2==1.2kΩ）：不报
        } else if (A.bare || B.bare) {
          // 有一侧没写单位 → 量纲是猜的（104 既是 100nF 的 EIA 三位码，也是 100kΩ 的电阻码）。
          // 这种情况**不判错料**，只留痕：按数值硬比会重演旧实现的假"错料"。
          log('valueUncomparable', { ...shown, declaredNorm: A.token, actualNorm: B.token,
            dimDeclared: A.dim, dimActual: B.dim });
        } else if (A.dim === B.dim) {
          // 同量纲且数值确实不同 = 真错料（100nF vs 1uF、4.7k vs 1k）。
          log('valueMismatch', { ...shown, declaredNorm: A.token, actualNorm: B.token });
          // 只 log 不够：这是**交付物自相矛盾**级别的问题，必须进 warns 让人看见。
          warns.push(`valueMismatch ${item.des}(${item.lcsc}): 设计写 ${item.value}，器件实际 ${real}`);
          // 但 warns 不参与 ok 判定 → 会带着错料"成功"出货。
          // 实测证据：SHT30_LDO_Module-20261125-193402 的 Netlist 里
          //   R1/R2  Value=4.7k  Supplier=C11702  MPN=0402WGF1001TCE（1kΩ）
          // 设计标 4.7k、实际装 1k，而该次运行 ok:true。
          // BOM 标称与实际物料不符 = 板子做出来必然错件，这不是警告是**致命**。
          // 注意：这类设计由 run-all.ps1 按 idea 现场生成，**从不经过 audit-design.js**
          //（那道 fail-closed 闸门只审 designs\*.json），所以这里是唯一能拦住它的地方。
          errors.push(`错料 ${item.des}(${item.lcsc}): 设计写 ${item.value}，器件实际 ${real}`);
        } else {
          // 两侧都带单位但量纲不同（1nF vs 1nH）：把量纲抹平会造出假等/假不等，只记录。
          log('valueDimMismatch', { ...shown, dimDeclared: A.dim, dimActual: B.dim });
        }
      } else if (A.kind === 'code' && B.kind === 'code') {
        // 料号走**字符串**比较：1M/1m 的兆/毫在这里没有意义，不做任何数值解释。
        // 用"包含"而不是等号：库里 Value 常带厂牌/封装后缀（1N4148 vs 1N4148WS-7-F）。
        if (!(A.token === B.token || A.token.includes(B.token) || B.token.includes(A.token))) {
          // 料号后缀差异太常见，只 warn 不 error —— 否则会把一批正常料报成错料。
          log('valueCodeMismatch', { ...shown, declaredNorm: A.token, actualNorm: B.token });
          warns.push(`valueCodeMismatch ${item.des}(${item.lcsc}): 设计写 ${item.value}，器件实际 ${real}`);
        }
      } else {
        // 一边数值一边料号：多数是库里 Value 直接填了 MPN（电容常见 CL10B104KB8NNNC），
        // 按错料报会把每个电容都报出来 —— 只留日志，交人工复核。
        log('valueKindMismatch', { ...shown, declaredKind: A.kind, actualKind: B.kind });
      }
    }
    const addArgs = {
      projectId: projectUuid, schematicName: schName, pageName,
      libraryUuid: part.libraryUuid, name: part.name,
      x: cx, y: cy, designator: item.des,
      ...(Object.keys(props).length ? { properties: props } : {}),
    };
    // `add` 有**两条**失败通道：抛异常，和返回 { ok:false, error }。
    // 实测这一轮走的是后者（INTERNAL_ERROR / Network Error!）。只覆盖一条通道的
    // 重试等于没重试，所以先把两条收敛成同一个形状。
    const callAdd = async () => {
      try { return await eda.sch_SourcePrimitiveComponent.add(addArgs); }
      catch (e) {
        return { ok: false, error: { code: 'THROWN', message: String(e && e.message).slice(0, 200) } };
      }
    };
    const blob = (x) => { try { return JSON.stringify(x); } catch (_) { return String(x); } };
    const isTransient = (s) => /Network Error|INTERNAL_ERROR|ETIMEDOUT|ECONNRESET|socket hang up|timeout/i.test(s || '');
    r = await callAdd();
    if (!r?.ok) {
      let msg = blob(r);
      for (let at = 1; at <= 3 && isTransient(msg); at++) {
        log('addAttempt', { des: item.des, attempt: at, msg: msg.slice(0, 160) });
        if (at === 3) break;
        await sleep(800 * at);
        r = await callAdd();
        if (r && r.ok) break;
        msg = blob(r);
      }
      if (!r?.ok) {
        if (isTransient(msg)) envFaults.push(`add ${item.des}: ${msg}`);
        log('addFailed', { des: item.des, env: isTransient(msg), msg: msg.slice(0, 200) });
        errors.push(`add ${item.des}: ${msg}`);
        continue;
      }
    }
  } catch (e) { errors.push(`add ${item.des}: ${e && e.message}`); continue; }
  const g = await eda.sch_SourcePrimitiveComponent.get({
    projectId: projectUuid, schematicName: schName, pageName, primitiveId: r.value.primitiveId });
  placed.push({ des: r.value.designator, lcsc: item.lcsc, primitiveId: r.value.primitiveId,
    pins: g.value.pins, props: g.value.properties });
}
log('placed', placed.map(p => ({ des: p.des, lcsc: p.lcsc,
  pins: p.pins.map(x => `${x.pinNumber}:${x.pinName}`) })));
if (!placed.length) throw new Error('no parts placed');
await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
await sleep(1200);

// ---------- 4. 连通 ----------
// 关键：必须按引脚所在边(side)引出，否则同边多引脚会走线重叠被合并成同一网络
await cam('sch');   // 连接前原理图全图
phase('connect');
const pinGeo = {};   // primitiveId -> { pinNumber: {side,length,x,y} }
for (const p of placed) {
  try {
    const g = await eda.sch_SourcePin.getGeometry({
      projectId: projectUuid, schematicName: schName, pageName, primitiveId: p.primitiveId });
    if (g?.ok && Array.isArray(g.value)) {
      pinGeo[p.primitiveId] = {};
      for (const item of g.value) {
        pinGeo[p.primitiveId][String(item.pinNumber)] = item;
      }
    }
  } catch (e) { log('pinGeoErr', { des: p.des, m: String(e && e.message) }); }
}
log('pinGeoSample', pinGeo[placed[0]?.primitiveId] ? Object.entries(pinGeo[placed[0].primitiveId])
  .slice(0, 4).map(([k, v]) => ({ n: k, side: v.side, len: v.length, x: v.x, y: v.y })) : null);

function findPinCtx(des, key) {
  const c = placed.find(p => p.des === des);
  if (!c) return null;
  const k = String(key);
  const pin = c.pins.find(p => String(p.pinNumber) === k)
    || c.pins.find(p => String(p.pinName).toUpperCase() === k.toUpperCase())
    || null;
  if (!pin) return null;
  const geo = pinGeo[c.primitiveId]?.[String(pin.pinNumber)] || null;
  return { c, pin, geo };
}

const connSteps = [];
const connList = D.connections || [];
for (let ci = 0; ci < connList.length; ci++) {
  const [des, pinKey, net] = connList[ci];
  const ctx = findPinCtx(des, pinKey);
  if (!ctx) { errors.push(`pin missing ${des}.${pinKey}`); continue; }
  const { pin, geo } = ctx;
  const up = String(net).toUpperCase();
  const isGnd = up.startsWith('GND') || up === 'VSS';
  const type = isGnd ? 'Ground' : 'Power';

  // 按 side 决定引出方向；没有 side 时退化为用符号几何推断
  const side = geo?.side || 'left';
  const stub = 20;
  let ex = pin.x, ey = pin.y;
  if (side === 'left') ex = pin.x - stub;
  else if (side === 'right') ex = pin.x + stub;
  else if (side === 'top') ey = pin.y + stub;
  else if (side === 'bottom') ey = pin.y - stub;
  else ex = pin.x + stub;

  // 网络符号放在引出线端点；rotation 由符号方向决定
  //  - 引出线水平（left/right）→ 符号需旋转 90/270 使引脚朝向器件
  //  - 引出线垂直（top/bottom）→ rotation 0（电源朝上/地朝下）
  const horizontal = (side === 'left' || side === 'right');
  let rotation = 0;
  if (horizontal) rotation = (side === 'left') ? 90 : 270;
  else rotation = (isGnd ? 0 : 180);   // 引脚在下方(向上引出)→180；向下引出→0

  let wireOk = false, flagOk = false;
  try {
    const w = await eda.sch_SourcePrimitiveWire.add({
      projectId: projectUuid, schematicName: schName, pageName,
      line: [pin.x, pin.y, ex, ey], net });
    wireOk = !!w?.ok;
  } catch (e) { errors.push(`wire ${des}.${pinKey}: ${e && e.message}`); }
  try {
    const f = await eda.sch_SourcePrimitiveComponent.addNetFlag({
      projectId: projectUuid, schematicName: schName, pageName,
      type, net, x: ex, y: ey, rotation });
    flagOk = !!f?.ok;
  } catch (e) { errors.push(`flag ${des}.${pinKey}: ${e && e.message}`); }
  connSteps.push({ des, pinKey, net, side, seg: [pin.x, pin.y, ex, ey], rotation, wireOk, flagOk });
}
log('connect', { total: connSteps.length,
  wireFail: connSteps.filter(c => !c.wireOk).length,
  flagFail: connSteps.filter(c => !c.flagOk).length });
await eda.sch_SourceDocument.waitForPersistReady(projectUuid, 60000);
await sleep(1800);

// ---------- 5. 网表校验 + 原理图 DRC ----------
await cam('sch');   // 网表核对前回原理图全图
await cam('sch', true);
// 【原理图这一帧必须等页面文档真的就绪再截】原顺序是先 shot、到下一段才
// waitDoc(pageUuid)，于是取图时原理图页还没打开，getCurrentRenderedAreaImage()
// 返回空 → shotNone{tag:"sch-wired"}。同一轮里 PCB 侧每一帧都成功，唯一差别
// 就是原理图页在截图这一刻还没就绪（2026-11-26 01:29 实测 11 帧全落盘、唯独
// 原理图缺失）。等待放在截图前，且失败也要留痕，不许静默当成"这版没有原理图"。
try { await waitDoc(pageUuid, 60000); } catch (e) {
  log('schShotWaitFail', { m: String(e && e.message).slice(0, 90) });
}
await sleep(1200);
await shot('sch-wired');
phase('netlistCheck');
let netSummary = null, schDrc = null, mismatches = [];
try {
  await waitDoc(pageUuid, 90000);
  await sleep(2500);
  const nl = JSON.parse(await eda.sch_Netlist.getNetlist());
  netSummary = [];
  for (const c of Object.values(nl.components || {})) {
    const pins = {};
    for (const [pn, pi] of Object.entries(c.pinInfoMap || {})) pins[pn] = pi.net || '';
    netSummary.push({ des: c.props?.Designator, lcsc: c.props?.['Supplier Part'], pins });
  }
  log('netlist', netSummary);
  for (const [des, pinKey, net] of (D.connections || [])) {
    const row = netSummary.find(r => r.des === des);
    if (!row) { mismatches.push({ des, pinKey, want: net, got: 'NO_COMP' }); continue; }
    const got = row.pins[String(pinKey)] ?? row.pins[pinKey];
    if (String(got).toUpperCase() !== String(net).toUpperCase()) mismatches.push({ des, pinKey, want: net, got });
  }
  log('netMismatches', mismatches);
} catch (e) { errors.push('netlist: ' + (e && e.message)); }
// 原理图 DRC：strict=true 时 warning 也算不通过（未连接引脚 CHECKFLOATPIN 就是 warn）。
// 官方文档明确说明这是预期行为，因此这里按 type 分级：fatalError/error 才算真错。
let schDrcViolations = [], schDrcErrors = 0, schDrcWarns = 0;
try {
  await waitDoc(pageUuid, 90000);
  const raw = await eda.sch_Drc.check(true, false, true);
  schDrcViolations = Array.isArray(raw) ? raw : [];
  for (const v of schDrcViolations) {
    if (v?.type === 'fatalError' || v?.type === 'error') schDrcErrors++;
    else schDrcWarns++;
  }
  schDrc = schDrcErrors === 0;
  log('schDrc', { errors: schDrcErrors, warns: schDrcWarns,
    rules: [...new Set(schDrcViolations.map(v => v?.rule))] });
} catch (e) { errors.push('schDrc: ' + (e && e.message)); }

// ---------- 6. PCB 导入 + 板框 ----------
phase('pcbImport');
await waitDoc(pcbUuid, 120000);
await sleep(1200);
await cam('pcb', true);   // 强制激活 PCB：后续 importChanges/布局都作用于它
let imported = false;
let outlineOk = false;
for (let i = 0; i < 4 && !imported; i++) {
  try { imported = await eda.pcb_Document.importChanges(schUuid, true); } catch (e) { }
  if (!imported) await sleep(2000);
}
log('importChanges', imported);
await sleep(1800);

// ---------- 6.5 先按设计意图画板框（布局引擎需要板框才正常摆放）----------
// 关键：板框必须在 autoLayout **之前**存在。没有板框时布局引擎把器件压成细长条，
// 布线器随后直接放弃（1.2s "completed" 但零铜）。
const bw0 = D.boardWidthMil || 1000, bh0 = D.boardHeightMil || 800;
let outlineInfo = null;
// 板框填充率：实际器件占用面积 / 板框面积。低于 0.5 说明初始板框估大了，
// 外层可用更小的初始板框重跑（必须在布局**之前**缩小，布局后剪会毁布线）。
let outlineFillRatio = null;
try {
  const poly = eda.pcb_MathPolygon.createPolygon(['R', 0, 0, bw0, bh0, 0, 0]);
  outlineOk = !!(await eda.pcb_PrimitivePolyline.create('', 11, poly, 10, false));
  outlineInfo = { w: bw0, h: bh0, stage: 'preLayout' };
} catch (e) { errors.push('outline: ' + (e && e.message)); }
log('outline0', { ok: outlineOk, ...outlineInfo });

// ---------- 7. 摆放：有显式摆放表就按表摆，没有才交给自动布局 ----------
await cam('pcb');   // 布局前全板视图
await cam('pcb', true); await shot('pcb-imported');
phase('autoLayout');
let layoutState = null;

// 显式摆放：设计文件里给了 _placement（位号 -> {x, y, rot}）就按它摆。
// 为什么这不是"多余的一层"：
//   startAutoLayout 是单次黑盒调用，没有 keepout、没有锁定、没有分区约束。
//   它按线长优化，于是把 ESP32-S3 模组摆到板子中间、天线四周全是器件与铺铜，
//   而 Espressif 官方**明确禁止**这个形态（"模组不能放在板子中间，四周挖空来提供净空区"）。
//   设计文件里写坐标也没用：布局阶段会把它们推翻。所以只能整段跳过自动布局。
// 坐标口径：mil、笛卡尔、y 向上。与 getState_X/Y 同口径，**不要**塞 mm。
const placementMode = (D._placement && typeof D._placement === 'object'
  && Object.keys(D._placement).length > 0) ? 'explicit' : 'auto';

// 按表摆放并**逐个复读核对**。不核对等于换了一种不负责的方式：
// modify 不抛异常不代表器件真的到了那个坐标（本项目已被"没抛异常≠成功"坑过多次）。
async function placeExplicitly(table) {
  const rep = { requested: 0, moved: 0, notFound: [], missed: [], maxErrMil: 0 };
  // 没有"按位号查 id"的接口（IPCB_FindPrimitivesOptions 只有 bbox/layers/types/net/locked/cursor/limit），
  // 只能全量取 id 再比对 Designator。
  const ids = (await eda.pcb_PrimitiveComponent.getAllPrimitiveId()) || [];
  const objs = await eda.pcb_PrimitiveComponent.get(ids);
  const arr = (Array.isArray(objs) ? objs : [objs]).filter(Boolean);
  const byDes = new Map();
  for (const c of arr) {
    const d = c.getState_Designator?.();
    if (d != null) byDes.set(String(d), c);
  }
  for (const des of Object.keys(table)) {
    const t = table[des];
    if (!t || !Number.isFinite(Number(t.x)) || !Number.isFinite(Number(t.y))) continue;
    rep.requested++;
    const c = byDes.get(String(des));
    if (!c) { rep.notFound.push(String(des)); continue; }
    const pid = c.getState_PrimitiveId();
    const beforeRot = Number(c.getState_Rotation?.() || 0);
    const wantRot = Number.isFinite(Number(t.rot)) ? Number(t.rot) : beforeRot;
    try {
      await eda.pcb_PrimitiveComponent.modify(pid, {
        x: Number(t.x), y: Number(t.y), rotation: wantRot,
      });
      // 文档示例明确写了：modify 之后必须重新 get 才读得到新值。
      // 用 modify 的返回值或缓存对象判定，读到的可能还是旧坐标 —— 那会让"已到位"永远为真。
      const c2 = await eda.pcb_PrimitiveComponent.get(pid);
      const gx = Number(c2?.getState_X?.()), gy = Number(c2?.getState_Y?.());
      const err = Math.max(Math.abs(gx - Number(t.x)), Math.abs(gy - Number(t.y)));
      if (Number.isFinite(err)) {
        rep.maxErrMil = Math.max(rep.maxErrMil, err);
        if (err <= 1) rep.moved++;
        else rep.missed.push({ des: String(des), want: [Number(t.x), Number(t.y)],
          got: [Math.round(gx), Math.round(gy)], errMil: Math.round(err) });
      } else {
        rep.missed.push({ des: String(des), why: 'readback NotANumber' });
      }
    } catch (e) {
      rep.missed.push({ des: String(des), why: String(e && e.message).slice(0, 90) });
    }
  }
  return rep;
}

let explicitPlacement = null;
if (placementMode === 'explicit') {
  try {
    explicitPlacement = await placeExplicitly(D._placement);
    log('explicitPlacement', { mode: placementMode, requested: explicitPlacement.requested,
      moved: explicitPlacement.moved, notFound: explicitPlacement.notFound,
      missed: explicitPlacement.missed, maxErrMil: Math.round(explicitPlacement.maxErrMil) });
    if (explicitPlacement.requested === 0) errors.push('explicitPlacement: 摆放表为空');
    if (explicitPlacement.notFound.length > 0) {
      errors.push('explicitPlacement: 板上找不到 ' + explicitPlacement.notFound.join(','));
    }
    if (explicitPlacement.missed.length > 0) {
      errors.push('explicitPlacement: 坐标未到位 '
        + explicitPlacement.missed.map(m => m.des).join(','));
    }
  } catch (e) { errors.push('explicitPlacement: ' + String(e && e.message).slice(0, 120)); }
}
log('placementMode', placementMode);
try {
  // 显式摆放模式下**不调用**自动布局：它会推翻手工坐标。
  // 置 null 让下面 `if (job?.jobId)` 整段跳过，layoutState 保持 null —— 这是诚实的，
  // 因为自动布局确实没跑过；把它填成 'completed' 就是让一个字段兼两种含义。
  const job = placementMode === 'explicit' ? null : await eda.pcb_Document.startAutoLayout();
  // 420000 是硬上限，与外部 590s 掐断线不匹配：布局一旦慢，调用会被外部掐断，
  // 而 render 里的代码仍在跑 → 幽灵调用。改成以剩余预算为上界。
  if (job?.jobId) {
    const r = await waitJob(job.jobId, Math.max(Math.min(420000, left() - 240000), 30000), 'layout');
    layoutState = r.state; log('layout', r);
    // 等超时不等于布局停了。不取消就往下走，覆铜/布线是在**一块还在被改写的板子**上干活，
    // 之后所有判定（覆铜是否重建完、DRC、断连）都建在中间态上 —— 本项目已被这类误判坑过多次。
    // cancelAutoJob 是协作式取消（置位取消标记后返回，引擎在检查点退出；写回前被取消则已算出的
    // 几何不落画布），且 api-types.d.ts 明确它同时适用于 startAutoLayout 作业。
    // 关键：这里**不把 layoutState 改成 completed** —— 取消 = 布局没做完，
    // 所以 computeOK() 里的 layoutState === 'completed' 仍为假，取消过的布局不可能假通过。
    if (r.state === 'TIMEOUT' || r.state === 'ERR') {
      try {
        const cc = await eda.pcb_Document.cancelAutoJob(job.jobId);
        log('layoutCancelled', { state: r.state, ok: cc });
        // 协作式取消是"请求"不是"完成"：再等一小会儿确认它真进终态。
        // 上限同时受剩余预算约束（扣掉 120s 收尾），预算不够时上限为 0 → 立即返回，不抢收尾时间。
        const rc = await waitJob(job.jobId, Math.max(Math.min(20000, left() - 120000), 0), 'layout-cancel');
        log('layoutCancelConfirm', { state: rc.state, ms: rc.ms, partial: rc.st?.partial });
        // 唯一例外：作业在取消生效前就自己正常跑完了 —— 这不是"因为取消成功就写 completed"，
        // 而是作业自己报告的终态（只有 completed 代表几何已提交）。
        if (rc.state === 'completed' && rc.st?.partial !== true) {
          layoutState = 'completed';
          log('layoutCompletedAfterCancel', { why: 'job finished before cancel took effect' });
        }
      } catch (e) { log('layoutCancelErr', { m: String(e && e.message).slice(0, 80) }); }
    }
  }
} catch (e) { errors.push('autoLayout: ' + (e && e.message)); }
await sleep(1500);

// ---------- 7.2 板框复核：仅当布局结果真的超出板框时才扩大 ----------
// 已验证：布局前固定板框 (0,0,bw,bh) 能正常布局+布线（d1/d2/d3 全部 DRC 零违规）。
// 只有连接器过大导致器件跑到板框外时才需要扩板 —— 扩板后必须重建覆铜。
try {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity, padN = 0;
  for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
    try {
      const p = await eda.pcb_PrimitivePad.get(id);
      const x = p?.getState_X?.(), y = p?.getState_Y?.();
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      const w = Number(p?.getState_Width?.() || 20), h = Number(p?.getState_Height?.() || 20);
      xMin = Math.min(xMin, x - w / 2); xMax = Math.max(xMax, x + w / 2);
      yMin = Math.min(yMin, y - h / 2); yMax = Math.max(yMax, y + h / 2);
      padN++;
    } catch (e) { }
  }
  // 注意：布局产物常在负 Y（如 -671..-229），这**不是**问题 —— d1/d2/d3 都这样且全部通过。
  // 唯一要判的是"器件范围是否超出板框尺寸"，用尺寸比较，不用绝对坐标比较。
  const spanW = padN > 0 ? (xMax - xMin) : 0;
  const spanH = padN > 0 ? (yMax - yMin) : 0;
  const fits = padN > 0 && spanW <= bw0 - 40 && spanH <= bh0 - 40;
  log('outlineFit', { fits, padN,
    bbox: padN ? [xMin, yMin, xMax, yMax].map(v => Math.round(v)) : null,
    span: [Math.round(spanW), Math.round(spanH)],
    board: [bw0, bh0] });
  // 【跨度合格 != 都落在板上】`fits` 比的是焊盘 bbox 的**尺寸**，不是位置。
  // 实测 2026-11-26T15:44 的 V2：spanH=3708 只比 bh0-40=3660 大 48，于是报的是
  // 「超 48 mil —— 只差一点」；而真实缺陷是焊盘最低点 -3827 对板边 -3700，
  // **127 mil 的焊盘整排挂在板外**，布线器根本没有可连的端点。
  // 尺寸略大和位置错位被混成一句话，且 48 这个数看起来无害。位置才是致命的那个。
  // 容差取 50 mil：远大于板框线宽/取整带来的几个 mil，又远小于 127。
  const PAD_OFFBOARD_TOL = 50;
  const padOff = padN > 0 ? {
    left: Math.max(0, -xMin), right: Math.max(0, xMax - bw0),
    bottom: Math.max(0, -bh0 - yMin), top: Math.max(0, yMax),
  } : null;
  const padOffMax = padOff
    ? Math.max(padOff.left, padOff.right, padOff.bottom, padOff.top) : 0;
  log('padOffBoard', padOff ? {
    left: Math.round(padOff.left), right: Math.round(padOff.right),
    bottom: Math.round(padOff.bottom), top: Math.round(padOff.top),
    maxMil: Math.round(padOffMax), board: [bw0, bh0], tol: PAD_OFFBOARD_TOL,
  } : { measured: false, why: '没有读到焊盘' });
  if (padN > 0 && padOffMax > PAD_OFFBOARD_TOL) {
    errors.push('outlineFit: 焊盘有 ' + Math.round(padOffMax) + ' mil 落在板框 ' + bw0 + 'x' + bh0
      + ' 之外（左 ' + Math.round(padOff.left) + ' / 右 ' + Math.round(padOff.right)
      + ' / 下 ' + Math.round(padOff.bottom) + ' / 上 ' + Math.round(padOff.top)
      + ' mil）—— 板外焊盘接不到线，布线器会一条都画不出来');
  }
  // 【显式摆放时不许扩板框】实测 2026-11-26 15:36（ESP32S3_Wireless_Mic_V2）：
  // 布局表按 1000x3700 算好，U1 rot=180 让天线朝 -Y、焊盘边压在 y=-3700、
  // 天线整段落在板外 —— 这是 Espressif 指南「强烈推荐天线伸出板边」的落地。
  // 但焊盘跨度 3708 > bh0-40=3660 被判"不合"，下面这段把板框放大到 1035x3828，
  // 新下边 -3887.3，于是天线被推回基板上：overhangMil 从正数变成 **-3603**。
  // 一个为"容纳连接器"写的自愈，静默推翻了这块板唯一的设计意图。
  // 显式摆放时板框与布局表是一个整体，都由设计者给出，这一段无权改。
  if (!fits && padN > 0 && Number.isFinite(xMin) && placementMode === 'explicit') {
    const overW = Math.max(0, Math.round(spanW - (bw0 - 40)));
    const overH = Math.max(0, Math.round(spanH - (bh0 - 40)));
    log('outlineFit.explicitFixed', {
      board: [bw0, bh0], span: [Math.round(spanW), Math.round(spanH)],
      over: [overW, overH], note: '显式摆放：板框是设计意图，不放大',
    });
    // 真的超出去要判失败，不许"换块更大的板"糊过去 —— 那会把缺陷变成沉默。
    if (overW > 0 || overH > 0) {
      errors.push('outlineFit: 显式摆放的焊盘跨度 ' + Math.round(spanW) + 'x' + Math.round(spanH)
        + ' 超出板框 ' + bw0 + 'x' + bh0 + '（显式摆放不改板框，请修布局表或板框）');
    }
  } else if (!fits && padN > 0 && Number.isFinite(xMin)) {
    try {
      // delete 返回 false 时不抛。删不掉旧的板框 = 板上会**同时存在两个板框**，
      // 而板框层有两条闭合轮廓时 DRC / 可打样检查看到的是哪一条并不确定。
      // 以前这里不看返回值，删失败与删成功完全同形。
      let plDelFail = 0, plDelOk = 0;
      for (const id of (await eda.pcb_PrimitivePolyline.getAllPrimitiveId()) || []) {
        const pl = await eda.pcb_PrimitivePolyline.get(id);
        if (pl?.getState_Layer?.() !== 11) continue;
        if ((await eda.pcb_PrimitivePolyline.delete(id)) === true) plDelOk++;
        else plDelFail++;
      }
      log('outlineDelOld', { ok: plDelOk, fail: plDelFail });
    } catch (e) { log('outlineDelErr', String(e && e.message).slice(0, 120)); }
    const MARGIN = 60;
    // 只贴合布局跨度会做出细长条板（实测 1220x140 焊盘跨度 -> 1340x260 板），
    // 太薄导致布线绕不开，最终 DRC 断网。改为：按需要放大的那一维求出等比系数，
    // 保持原板框长宽比放大，并保证两维都不小于布局跨度 + 边距。
    const needW = (xMax - xMin) + MARGIN * 2;
    const needH = (yMax - yMin) + MARGIN * 2;
    const baseRatio = bh0 > 0 ? bw0 / bh0 : 1;   // 原始设计意图的长宽比
    // 以原始板框为基准等比放大到刚好容纳 needW/needH 的最小倍数
    let scale = Math.max(needW / Math.max(bw0, 1), needH / Math.max(bh0, 1), 1);
    let ow = Math.ceil(bw0 * scale);
    let oh = Math.ceil(bh0 * scale);
    // 兜底：等比放大后若某一维仍不足，只补该维（避免极端长条形设计被压扁）
    if (ow < needW) ow = Math.ceil(needW);
    if (oh < needH) oh = Math.ceil(needH);
    // 居中对齐到布局中心
    const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
    const ox = cx - ow / 2, oy = cy - oh / 2;
    log('outlineExpandPlan', { baseTheory: [bw0, bh0], baseRatio: Math.round(baseRatio * 100) / 100,
      need: [Math.round(needW), Math.round(needH)], scale: Math.round(scale * 100) / 100,
      result: [ow, oh] });
    try {
      const poly = eda.pcb_MathPolygon.createPolygon(['R', ox, oy, ow, oh, 0, 0]);
      outlineOk = !!(await eda.pcb_PrimitivePolyline.create('', 11, poly, 10, false));
      outlineInfo = { ox, oy, ow, oh, margin: MARGIN, padN, stage: 'expanded', scale };
    } catch (e) { errors.push('outlineExpand: ' + (e && e.message)); }
    log('outline', { ok: outlineOk, ...outlineInfo });
    await sleep(1200);
  } else if (fits && padN > 0 && Number.isFinite(xMin)) {
    // 板框是**估算**出来的（$estArea），实际布局往往紧凑得多，只扩不缩会留下大片空白。
    // 但实测：布局**之后**再剪板框会毁掉布线 —— 布局引擎按大板框排成细长条
    // （span 717×2167），剪到 1237 宽后扇出空间不足，fixClearance 把走线全删，
    // 68 个网络全部断开。所以这里**只记录不裁剪**，把收缩交给外层用更小的
    // 初始板框重跑一轮（布局阶段就按小板框排，才是对的顺序）。
    const usedArea = spanW * spanH;
    const boardArea = bw0 * bh0;
    const fillRatio = boardArea > 0 ? usedArea / boardArea : 1;
    outlineFillRatio = fillRatio;
    log('outlineFit.fill', {
      usedArea: Math.round(usedArea), boardArea: Math.round(boardArea),
      fillRatio: Math.round(fillRatio * 100) / 100,
      hint: fillRatio < 0.5 ? 'underfilled' : 'ok',
    });
  }
} catch (e) { errors.push('outlineCheck: ' + (e && e.message)); }

// ---------- 7.3 天线净空区 ----------
// 这块板的射频件是 ESP32-S3-WROOM-1，PCB 天线在模组**短端**（那一端没有邮票孔焊盘）。
// Espressif 硬件设计指南的三条要求，以及它们在 PCB 上能否落地：
//   ① 天线区及外扩 15mm 内严禁铺铜/走线/摆放元件 —— 侧向 15mm 在本板（宽 25.4mm）上
//      无解，只能由非金属壳体保证，属机械约束，PCB 表达不了。**这里不假装满足它。**
//   ② 天线端向内 6mm 全层无铜 —— 用 pcb_PrimitiveRegion 落地，见下。
//   ③ 强烈推荐天线伸出板边；**禁止**"模组放板中间、四周挖空" —— 由摆放表让天线整段悬出。
// 为什么必须显式建 region 而不是指望布线/铺铜自己避开：
//   布线引擎配置（IPCB_AutoRouteEngineConfig）**没有** keepout 概念，
//   铺铜也不会自动躲开天线。不罩住就是"知道要求但没执行"。
let antennaKeepout = null;
try {
  const K = D._antennaKeepout;
  if (K && typeof K === 'object' && Number.isFinite(K.x0) && Number.isFinite(K.y0)) {
    const kw = K.x1 - K.x0, kh = K.y1 - K.y0;
    // 【坐标系，别搞反】createPolygon 的 R 模式 (x, y) 是矩形**顶边左角**，
    // 映射到笛卡尔是 X∈[x, x+w]、Y∈[y-h, y]。
    // 实测（scripts/_probe-coord.js，2026-11-26，结论来自读回 bbox 而不是文档猜测）：
    //   ['R', 1200, 700, 400, 200] → bbox X[1200,1600] Y[500,700]
    //   ['R', 0, 0, 2600, 1900]    → bbox X[-5,2605] Y[-1905,5]（板框，两侧各多 5mil 线宽）
    // 所以给定笛卡尔 X[x0,x1]、Y[y0,y1]（y0 < y1），要写 ['R', x0, y1, w, h, 0, 0]。
    // 搞反了净空区会落到板外，而且**不会报错** —— 这正是要写死这条注释的原因。
    const poly = eda.pcb_MathPolygon.createPolygon(['R', K.x0, K.y1, kw, kh, 0, 0]);
    // layer 12 = MULTI：一次罩住所有铜层。
    // ruleType：2=禁元件 5=禁布线 6=禁填充 7=禁覆铜。
    // **故意不含 2**：模组自身必须坐在这个位置上，对它禁元件会与自身冲突，
    // 结果是一条永远为真的"违规" —— 永远为真的检查等于没有检查。
    const reg = await eda.pcb_PrimitiveRegion.create(12, poly, [5, 6, 7], 'ANT_KEEPOUT', 10, false);
    // 复核不信摆放表：读回真实 bbox，数出到底谁侵入了净空区。
    let intruders = [];
    let overhangMil = null;
    // 允许留在净空区里的器件（通常是模组自己）。为什么要把"谁被判过"记下来：
    // 下面 overhangMil 是一个有符号的差值，取错对象时它**看起来仍然像实测值**
    // （本次 -3603，而板框实测 minY=-3887.3）。不带依据的数字没法被复核。
    const allowSeen = [];
    let overhangDetail = null;
    try {
      const allow = new Set((K.allowDesignators || []).map(String));
      // 板边界用**实测**板框 bbox：7.2 的自愈可能放大过板框，拿设计值当板边界会判错对象。
      let bMinY = -bh0;
      for (const pid of (await eda.pcb_PrimitivePolyline.getAllPrimitiveId()) || []) {
        const pl = await eda.pcb_PrimitivePolyline.get(pid);
        if (pl?.getState_Layer?.() !== 11) continue;
        const bb = await eda.pcb_Primitive.getPrimitivesBBox([pid]);
        if (bb && Number.isFinite(bb.minY)) bMinY = bb.minY;
        break;
      }
      const cIds = (await eda.pcb_PrimitiveComponent.getAllPrimitiveId()) || [];
      const cObjs = await eda.pcb_PrimitiveComponent.get(cIds);
      for (const c of (Array.isArray(cObjs) ? cObjs : [cObjs]).filter(Boolean)) {
        const des = String(c.getState_Designator?.());
        let bb = null;
        try { bb = await eda.pcb_Primitive.getPrimitivesBBox([c.getState_PrimitiveId()]); } catch (e) { }
        if (!bb || !Number.isFinite(bb.minY)) continue;
        const hit = bb.minX < K.x1 && bb.maxX > K.x0 && bb.minY < K.y1 && bb.maxY > K.y0;
        if (!hit) continue;
        if (allow.has(des)) {
          allowSeen.push(des);
          overhangMil = Math.round(bMinY - bb.minY);
          overhangDetail = {
            des,
            boardMinY: Math.round(bMinY * 10) / 10,
            partMinY: Math.round(bb.minY * 10) / 10,
            partMaxY: Math.round(bb.maxY * 10) / 10,
            partMinX: Math.round(bb.minX), partMaxX: Math.round(bb.maxX),
          };
        } else intruders.push(des);
      }
    } catch (e) { log('antennaVerifyErr', String(e && e.message).slice(0, 120)); }
    // 【禁布区里不许有焊盘】上面那圈只查了「**别的**器件有没有闯进来」，
    // 没查这条带子有没有压住被豁免模组**自己的焊盘**。实测原来的带子是
    // y0=-3700, y1=-3460（240 mil 高、横贯全板），而 U1 焊盘区在 -3835..-3087 ——
    // 相当一批焊盘正落在带子里。带子的规则是 NO_WIRES(5)/NO_FILLS(6)/NO_POURS(7)，
    // 于是这些焊盘的出线方向被整段封死。
    // 同一轮 DRC 叶子正好对得上：Connection Error | SMD Pad 75、
    // Prohibited Region to Track 5、Clearance Error | SMD Pad to Track 14。
    // 只查了东侧没查西侧的判据，会给出 `intruders: []` 这种"看起来干净"的结果。
    let padsInBox = 0;
    const padsInBoxSample = [];
    try {
      for (const pid of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
        const pp = await eda.pcb_PrimitivePad.get(pid);
        const px = pp?.getState_X?.(), py = pp?.getState_Y?.();
        if (typeof px !== 'number' || typeof py !== 'number') continue;
        if (px > K.x0 && px < K.x1 && py > K.y0 && py < K.y1) {
          padsInBox++;
          if (padsInBoxSample.length < 5) padsInBoxSample.push([Math.round(px), Math.round(py)]);
        }
      }
    } catch (e) { log('antennaPadScanErr', String(e && e.message).slice(0, 120)); }
    antennaKeepout = { built: !!reg, ruleType: [5, 6, 7], layer: 12,
      box: [K.x0, K.y0, K.x1, K.y1], intruders, overhangMil,
      allowSeen, overhangDetail,
      padsInBox, padsInBoxSample };
    log('antennaKeepout', antennaKeepout);
    // "region 建出来了"不等于"净空有效"。器件侵入与天线未悬出都要让整轮失败，
    // 否则这块板会带着用户明确点出来的那个缺陷交付，而 _run.json 还写着 ok。
    if (!reg) errors.push('antennaKeepout: region 未创建');
    if (intruders.length > 0) {
      errors.push('antennaKeepout: 器件侵入净空区 ' + intruders.join(','));
    }
    // 【"没测到"不许和"测到了没问题"同形】
    // 设计里点名允许待在净空区的器件，如果在净空区里一个都没找到，
    // overhangMil 会保持 null。原来的代码对 null 什么都不做 ——
    // 于是「net 区里没有模组」和「模组悬出量合格」在 _run.json 里完全一样。
    const allowList = (K.allowDesignators || []).map(String);
    if (allowList.length > 0 && allowSeen.length === 0) {
      errors.push('antennaKeepout: 净空区内没找到应在此处的器件 '
        + allowList.join(',') + ' —— 悬出量无从测量，不能当作合格');
    }
    // 只在点了 allowDesignators 时才判（那就是天线净空带，模组本来就在这儿）——
    // 窄范围，不对别的设计类型下结论。
    if (allowList.length > 0 && padsInBox > 0) {
      errors.push('antennaKeepout: 净空带里有 ' + padsInBox + ' 个焊盘'
        + (padsInBoxSample.length ? '（如 ' + padsInBoxSample.map(s => s.join(',')).join(' / ') + '）' : '')
        + ' —— NO_WIRES 会把它们的出线全部拒掉，带子高度 ' + Math.round(K.y1 - K.y0)
        + ' mil 对板框 ' + bh0 + ' mil，请把带子收到焊盘外侧');
    }
    if (overhangMil != null && overhangMil <= 0) {
      errors.push('antennaKeepout: 天线未悬出板边 overhang=' + overhangMil + 'mil'
        + (overhangDetail ? '（板边 ' + overhangDetail.boardMinY + ' / 器件 ' + overhangDetail.partMinY + '）' : ''));
    }
  } else {
    log('antennaKeepout', { skipped: '设计文件没有 _antennaKeepout' });
  }
} catch (e) {
  errors.push('antennaKeepout: ' + String(e && e.message).slice(0, 120));
  log('antennaKeepoutErr', String(e && e.message).slice(0, 160));
}

// ---------- 7.35 声明式禁布区：封装自带的开口（声孔 / 传感窗 / 金腔）不许走铜 ----------
// 【为什么需要这个字段】v5 的 U4 是 MEMS 硅麦，它的封装内部自带一个 17x17mil 的开口。
// 实测（run -211421 的 slotGeoCmp 与 geoIdPrefix 两条 telemetry）：
//   obBBox [642,-260,658,-243]，obCenter [650,-251]，落在 U4 占位 x[578.5,721.5] y[-283.5,-116.5] 内；
//   DRC 把它记成 `Slot Region to Track`，clearDiag 实测 cur=0 need=11.811 —— 走线**压在**开口上。
// 它既不是焊盘孔（全板 holeTypes 只有 ROUND 8 / SLOT 4，4 个 SLOT 都在 TYPE-C 那侧），
// 也不是 Fill（idxSizes 实测 fill:0 pour:2 poured:2），所以在 slotKeepout 与 slotPadGeometry
// 里都不存在；geoIdPrefix 自己的原话是「前 16 位也不在图元索引里 -> 仍走 bbox 兜底」。
// => 封装内部的这段几何**读不出来**，只能由设计文件声明。这不是退让，是把读不到的东西
//    挪到读得到的地方，并且带上出处。
// 落地方式与 _antennaKeepout 完全一致（不新造机制）：pcb_PrimitiveRegion(layer=12 MULTI,
// ruleType=[5 禁线, 6 禁填充, 7 禁覆铜])。**故意不含 2(禁元件)**：器件本体必须坐在这儿。
//
// 三条必须记的账（缺任何一条，这个字段都会退化成"声明了就等于做到了"）：
//   1. 声明数与真正建成的数分开记（declared / built / skipped）；
//   2. 声明的盒子必须落在它自称的 owner 器件 bbox 内 —— 否则那个盒子保护的是空气；
//   3. 盒子里若压着焊盘必须报错 —— NO_WIRES 会把那些焊盘出线全部封死，
//      那比原来那条违规严重得多（_antennaKeepout 的 padsInBox 就是这么加上去的）。
// 另外 inflateMil 单独一个字段：实测开口尺寸与工艺净距是**两个量**，混在一个盒子里
// 就没法回答"这个盒子到底代表开口，还是代表开口加余量"。
let copperVoids = { declared: 0, built: 0, skipped: 0, list: [] };
try {
  const V = Array.isArray(D._copperVoids) ? D._copperVoids : [];
  copperVoids.declared = V.length;
  if (V.length === 0) log('copperVoids', { skipped: '设计文件没有 _copperVoids' });
  for (let vi = 0; vi < V.length; vi++) {
    const v = (V[vi] && typeof V[vi] === 'object') ? V[vi] : {};
    const rec = { i: vi, why: String(v.why || '').slice(0, 60), owner: v.owner == null ? null : String(v.owner) };
    const finite = [v.x0, v.y0, v.x1, v.y1].every(Number.isFinite);
    if (!finite || !(v.x1 > v.x0) || !(v.y1 > v.y0)) {
      copperVoids.skipped++;
      rec.err = '坐标不完整或宽高非正';
      rec.got = [v.x0, v.y0, v.x1, v.y1];
      copperVoids.list.push(rec);
      errors.push('copperVoids[' + vi + ']: 坐标不完整或宽高非正 ' + JSON.stringify(rec.got));
      continue;
    }
    const inflate = Number.isFinite(v.inflateMil) ? Math.max(0, v.inflateMil) : 0;
    const kx0 = v.x0 - inflate, kx1 = v.x1 + inflate;
    const ky0 = v.y0 - inflate, ky1 = v.y1 + inflate;
    rec.box = [Math.round(v.x0), Math.round(v.y0), Math.round(v.x1), Math.round(v.y1)];
    rec.keepoutBox = [Math.round(kx0), Math.round(ky0), Math.round(kx1), Math.round(ky1)];
    rec.inflateMil = inflate;
    if (rec.owner) {
      let ownerBox = null;
      try {
        const cIds = (await eda.pcb_PrimitiveComponent.getAllPrimitiveId()) || [];
        const cObjs = await eda.pcb_PrimitiveComponent.get(cIds);
        for (const c of (Array.isArray(cObjs) ? cObjs : [cObjs]).filter(Boolean)) {
          if (String(c.getState_Designator?.()) !== rec.owner) continue;
          const bb = await eda.pcb_Primitive.getPrimitivesBBox([c.getState_PrimitiveId()]);
          if (bb && Number.isFinite(bb.minX)) ownerBox = bb;
          break;
        }
      } catch (e) { log('copperVoidOwnerErr', String(e && e.message).slice(0, 90)); }
      if (!ownerBox) {
        rec.ownerCheck = 'ownerNotFound';
        errors.push('copperVoids[' + vi + ']: 自称属于 ' + rec.owner + '，但板上找不到这个位号'
          + ' —— 盒子保护的可能是一块空地');
      } else {
        const inside = v.x0 >= ownerBox.minX && v.x1 <= ownerBox.maxX
          && v.y0 >= ownerBox.minY && v.y1 <= ownerBox.maxY;
        rec.ownerCheck = inside ? 'inside' : 'outside';
        rec.ownerBox = [Math.round(ownerBox.minX), Math.round(ownerBox.minY),
          Math.round(ownerBox.maxX), Math.round(ownerBox.maxY)];
        if (!inside) {
          errors.push('copperVoids[' + vi + ']: 声明的盒子 ' + JSON.stringify(rec.box)
            + ' 不在 ' + rec.owner + ' 的占位 ' + JSON.stringify(rec.ownerBox) + ' 内');
        }
      }
    }
    let padsIn = 0; const padsSample = [];
    try {
      for (const pid of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
        const pp = await eda.pcb_PrimitivePad.get(pid);
        const px = pp?.getState_X?.(), py = pp?.getState_Y?.();
        if (typeof px !== 'number' || typeof py !== 'number') continue;
        if (px > kx0 && px < kx1 && py > ky0 && py < ky1) {
          padsIn++;
          if (padsSample.length < 5) padsSample.push([Math.round(px), Math.round(py)]);
        }
      }
    } catch (e) { log('copperVoidPadScanErr', String(e && e.message).slice(0, 90)); }
    rec.padsIn = padsIn;
    rec.padsInSample = padsSample;
    if (padsIn > 0) {
      errors.push('copperVoids[' + vi + ']: 禁布区里有 ' + padsIn + ' 个焊盘'
        + (padsSample.length ? '（如 ' + padsSample.map(s => s.join(',')).join(' / ') + '）' : '')
        + ' —— NO_WIRES 会把它们的出线全部拒掉，请把 inflateMil 收小或挪盒子');
    }
    let built = false;
    try {
      const vw = kx1 - kx0, vh = ky1 - ky0;
      const vpoly = eda.pcb_MathPolygon.createPolygon(['R', kx0, ky1, vw, vh, 0, 0]);
      const nm = 'VOID_' + (rec.owner || ('v' + vi)) + '_' + vi;
      const vreg = await eda.pcb_PrimitiveRegion.create(12, vpoly, [5, 6, 7], nm, 10, false);
      built = !!vreg;
      if (!built) errors.push('copperVoids[' + vi + ']: region 未创建（规则 5/6/7 未落地）');
    } catch (e) {
      rec.err = String(e && e.message).slice(0, 120);
      errors.push('copperVoids[' + vi + ']: ' + rec.err);
      log('copperVoidCreateErr', rec.err);
    }
    rec.built = built;
    if (built) copperVoids.built++; else copperVoids.skipped++;
    copperVoids.list.push(rec);
  }
  if (copperVoids.declared > 0) {
    if (copperVoids.built !== copperVoids.declared) {
      errors.push('copperVoids: 声明 ' + copperVoids.declared + ' 条，只建成 '
        + copperVoids.built + ' 条 —— 剩下的没有禁布保护');
    }
    log('copperVoids', copperVoids);
  }
} catch (e) {
  errors.push('copperVoids: ' + String(e && e.message).slice(0, 120));
  log('copperVoidsErr', String(e && e.message).slice(0, 160));
}

// ---------- 7.4 把板上的槽（Slot）罩成禁布区，让布线器一开始就绕开 ----------
// 实测依据：d13（太阳能+锂电+OLED）的失败特征反复是 `Clearance Error | Slot Region to Track`，
// 命中的永远是同一个 20 位 hex 的 Slot Region（实测 d6893410d653eee4e18）。
// 槽**不是**图元类型：它是 FILL，带 layerId 12(MULTI) + fillStyle SOLID。
// 根因：布线引擎配置 IPCB_AutoRouteEngineConfig（api-types.d.ts:8665）**没有** keepout 概念，
// 布线器事先不知道槽在哪，于是把走线画过槽，只能靠事后 fixClearance 去挪 —— 而它挪不动。
// API 侧的禁布区是存在的：IPCB_PrimitiveRegion.create(layer, polygon, ruleType) 的 ruleType
// 含 NO_WIRES=5（禁止布线）/ NO_POURS=7，且 TPCB_LayersOfRegion = 铜层 | MULTI（L19512/19519）。
// 于是在布线前，把每个 MULTI 填充按**它自己的几何**罩一层禁布区。
// 是否真被布线器尊重，只有跑出来才知道 ⇒ 必须记 found/created/failed/areas，
// 不许写一句"已加禁布区"就算完。
// 面积上限不是保险，是**必需的**：整板大小的 MULTI 填充若被罩成禁布区，
// 整块板会变成不可布区 —— 那比违反间距严重得多。
let slotKeepout = { found: 0, created: 0, failed: 0, skippedBig: 0, areas: [] };
try {
  const slotFillIds = await eda.pcb_PrimitiveFill.getAllPrimitiveId(12);
  slotKeepout.found = (slotFillIds || []).length;
  for (const sfid of (slotFillIds || [])) {
    try {
      const sf = await eda.pcb_PrimitiveFill.get(sfid);
      const spoly = sf?.getState_ComplexPolygon?.();
      if (!spoly) { slotKeepout.failed++; continue; }
      let sArea = 0;
      try {
        const spts = spoly.discretize({ step: 20 });
        if (Array.isArray(spts) && spts.length >= 3) {
          let acc = 0;
          for (let si = 0; si < spts.length; si++) {
            const sa = spts[si], sb = spts[(si + 1) % spts.length];
            acc += (Number(sa.x) || 0) * (Number(sb.y) || 0) - (Number(sb.x) || 0) * (Number(sa.y) || 0);
          }
          sArea = Math.abs(acc) / 2;
        }
      } catch (e) { }
      slotKeepout.areas.push(Math.round(sArea));
      if (sArea > 640000) { slotKeepout.skippedBig++; continue; }
      const sr = await eda.pcb_PrimitiveRegion.create(12, spoly, [5, 7], 'noWire-' + String(sfid).slice(-6));
      if (sr) slotKeepout.created++; else slotKeepout.failed++;
    } catch (e) { slotKeepout.failed++; }
  }
} catch (e) {
  log('slotKeepoutErr', String(e && e.message).slice(0, 120));
}
// 【found:0 有两种完全不同的原因，必须能分辨】
//   (a) 板上确实没有 MULTI 填充 —— 0 就是正确答案；
//   (b) 槽不是 MULTI 填充，或该过滤器不接受 12 —— 那是我们查错了地方。
// 只看 `found:0`，两者长得一模一样，于是"机制失效"会被当成"板上没槽"。
// 所以 found===0 时对**类型合法**的填充层（铜层 + MULTI）做一次普查：
// 任一铜层有填充而 12 层为 0 ⇒ 过滤条件错了；各层都为 0 ⇒ 槽根本不是 Fill。
// 只列 TPCB_LayersOfFill 允许的取值，避免拿非法枚举去试 API。
if (!slotKeepout.found) {
  try {
    const census = {};
    for (const L of [1, 2, 12, 15, 16, 17]) {
      try {
        const cids = await eda.pcb_PrimitiveFill.getAllPrimitiveId(L);
        census[L] = (cids || []).length;
      } catch (e) { census[L] = 'ERR'; }
    }
    slotKeepout.fillCensus = census;
    slotKeepout.censusEmpty = Object.keys(census).every((k) => census[k] === 'ERR' || census[k] === 0);
  } catch (e) {
    slotKeepout.fillCensusErr = String(e && e.message).slice(0, 80);
  }
}
log('slotKeepout', slotKeepout);
// 【槽孔是焊盘孔，不是填充图元 —— 这一条有 API 证据，不是推测】
//   EPCB_PrimitivePadHoleType.SLOT       （api-types.d.ts L9238）
//   TPCB_PrimitivePadHole = [SLOT, diameter, length]，单位 mil（L9280）
//   IPCB_PrimitivePad.getState_Hole()    （L9647），配 getState_X/Y/Rotation（L9535/9556/9577）
// 也就是说：封装自带的槽（USB-C 壳体 GND 长圆孔、连接器长圆孔）住在**焊盘**上，
// 上面那段按 pcb_PrimitiveFill(12) 找槽，对它们必然 found:0 —— 查的不是同一个东西。
// d12 的实测量：Gerber.zip → FlyingProbeTesting.json 里
//   J1_1 / J1_4 = "DIP GND … HOLE_SIZE 31.496 HOLE_LEN 59.055"（0.8 × 1.5 mm），
//   Gerber.zip → Drill_PTH_Through.DRL 里对应 T03 的 G85 槽段。两处互相印证。
// 所以这里**只普查、不建禁布区**：先量清楚有几条槽、在什么位置、多大、什么网。
// 直接罩禁布区风险更大 —— GND 壳体脚要靠铺铜或走线连通，罩偏了会把通道堵死，
// 而那块板可能是现在唯一能通过的。先测量，拿到数据再决定。
if (slotKeepout.found === 0) {
  try {
    const padIds2 = await eda.pcb_PrimitivePad.getAllPrimitiveId();
    const holeTypes = {};
    const slots = [];
    for (const pid2 of (padIds2 || [])) {
      try {
        const pd2 = await eda.pcb_PrimitivePad.get(pid2);
        if (!pd2 || typeof pd2.getState_Hole !== 'function') continue;
        const hole2 = pd2.getState_Hole();
        if (!hole2) continue;
        const ht2 = String(Array.isArray(hole2) ? hole2[0] : hole2);
        holeTypes[ht2] = (holeTypes[ht2] || 0) + 1;
        if (ht2 !== 'SLOT') continue;
        slots.push({
          net: String(pd2.getState_Net() || ''),
          num: String(pd2.getState_PadNumber()),
          layer: pd2.getState_Layer(),
          at: [Math.round(Number(pd2.getState_X()) || 0), Math.round(Number(pd2.getState_Y()) || 0)],
          rot: Math.round((Number(pd2.getState_Rotation()) || 0) * 10) / 10,
          d: Math.round((Number(hole2[1]) || 0) * 1000) / 1000,
          len: Math.round((Number(hole2[2]) || 0) * 1000) / 1000,
        });
      } catch (e) { }
    }
    slotKeepout.padTotal = (padIds2 || []).length;
    slotKeepout.holeTypes = holeTypes;
    // 【NPTH 定位柱普查】d13 那 2 处 `Slot Region to Track` 的 cur=0、need=11.811（0.3mm）、
    // net 全为 null，位置 (1187,-586)/(1233,-565)，两处打在同一块区域上。合理的怀疑是
    // 不镀铜的定位柱/安装孔：**没有任何走线需要连到不镀铜的孔**，所以给它罩 NO_WIRES
    // 禁区在电气上是自洽的（与"给排针罩禁区会堵死必须进焊盘的走线"完全不同）。
    // 但先量清楚再动手：这里只记录，不建任何图元。
    //   getState_Metallization(): boolean（api-types.d.ts L9734），false = 非镀铜。
    const npth = [];       // 只用于记录，最多 16 条
    const npthAll = [];    // ★ 全部位置，专供距离计算 —— 绝不能用截断后的样本算"最近"
    let npthCount = 0;
    for (const pid3 of (padIds2 || [])) {
      try {
        const pd3 = await eda.pcb_PrimitivePad.get(pid3);
        if (!pd3 || typeof pd3.getState_Hole !== 'function') continue;
        const hole3 = pd3.getState_Hole();
        if (!hole3) continue;
        let met = null;
        try { met = pd3.getState_Metallization(); } catch (e2) { met = null; }
        if (met !== false) continue;
        npthCount++;
        npthAll.push([Math.round(Number(pd3.getState_X()) || 0), Math.round(Number(pd3.getState_Y()) || 0)]);
        if (npth.length >= 16) continue;
        npth.push({
          id: pid3,
          num: String(pd3.getState_PadNumber?.() ?? ''),
          net: String(pd3.getState_Net?.() ?? ''),
          layer: pd3.getState_Layer?.(),
          at: [Math.round(Number(pd3.getState_X()) || 0), Math.round(Number(pd3.getState_Y()) || 0)],
          hole: String(Array.isArray(hole3) ? hole3[0] : hole3),
          d: Math.round((Number(hole3[1]) || 0) * 1000) / 1000,
        });
      } catch (e) { }
    }
    slotKeepout.npthCount = npthCount;
    slotKeepout.npth = npth;
    // 与 d13 那两处违规点对距离，直接把"柱子在不在违规点上"这件事量出来。
    // 那两个点是 Top(1187,-586) 与 Bottom(1233,-565)，取到最近的 NPTH 距离即可。
    // ★ 距离在 npthAll（全量）上算，不在 npth（截断样本）上算：
    //   否则孔数 >16 时会把"只搜了前 16 个"报成一个具体的距离，读起来像测过了。
    //   searched 字段把分母写出来，避免"nearest:null"被当成"板上没有 NPTH"。
    slotKeepout.npthNearest = [[1187, -586], [1233, -565]].map(([qx, qy]) => {
      let best = null;
      for (const at of npthAll) {
        const dx = at[0] - qx, dy = at[1] - qy;
        const dist = Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10;
        if (!best || dist < best.dist) best = { dist, at };
      }
      return { query: [qx, qy], searched: npthAll.length, nearest: best };
    });
    slotKeepout.slotCount = slots.length;
    slotKeepout.slots = slots.slice(0, 16);
  } catch (e) {
    slotKeepout.padSlotCensusErr = String(e && e.message).slice(0, 80);
  }
}// ---------- 7.5 给难连焊盘（如 DFN 中央散热焊盘 EP）预先打过孔 ----------
// 目的：EP 被本体包围，单层走线进不去；先在它上面打过孔，让它直接接到底层 GND 铜
await cam('pcb'); await shot('pcb-layout');
phase('preVia');
let viaCount = 0;
// EP 过孔溯源：clearance 会把它当间距违规删掉（语料 viaDeleted 45/45 都是 GND、d 恒 19.8），
// 【不要写成「stitchedTotal 恒为 0」——那是把线计数器读成孔计数器】stitchGaps 阶段
// **从不插过孔**（它唯一的 create 是 pcb_PrimitiveLine.create，换的是"补一段铜线"），
// stitchedTotal 数的就是补成的线段数。所以它不会缩放成"孔"：这个阶段压根没有孔这条路。
// 真正的时序断点在这里：stitchGaps 跑在 fixClearance **之前**，它复检 DRC 时板子是通的
//（语料 113/113 例 stitchDone.round=0 且 remaining=0），删孔发生在它之后。
// 于是那个 EP 过孔很可能是 L1/L2 GND 之间**仅有**的铜连接。删完没人补 → DRC 报 Connection Error。
//（不是必然报废：45 条 viaDeleted 里有 26 条最终仍 passed，GND 另有过孔通路。属高危路径。）
// 这里只记下"这孔属于哪个 EP 焊盘、朝哪个方向偏离最近邻、原来偏了多少"，供 clearance 之后重放。
const epViaRecs = [];
try {
  const padIds = await eda.pcb_PrimitivePad.getAllPrimitiveId();
  const padList = [];
  for (const id of (padIds || [])) {
    try {
      const p = await eda.pcb_PrimitivePad.get(id);
      padList.push({ id, net: p?.getState_Net?.(), x: p?.getState_X?.(), y: p?.getState_Y?.(),
        num: p?.getState_Number?.() });
    } catch (e) { }
  }
  log('padsBeforeVia', padList.map(p => ({ num: p.num, net: p.net, x: p.x, y: p.y })));
  // 只给「被本体包围的」GND 焊盘打过孔（DFN 中央 EP），其余 GND 焊盘走正常布线
  // 判据：同一器件内，该焊盘被其它焊盘的包围盒完全包住
  const gndPads = padList.filter(p => String(p.net).toUpperCase() === 'GND');
  const enclosed = [];
  // 只在焊盘密集的局部窗口里做包围判断，避免 40+ 焊盘时 O(n^2) 全量比较
  for (const g of gndPads) {
    const local = padList.filter(o =>
      o.id !== g.id && Math.abs(o.x - g.x) < 40 && Math.abs(o.y - g.y) < 40);
    if (!local.length) continue;
    const hasUp = local.some(o => o.y > g.y + 15);
    const hasDown = local.some(o => o.y < g.y - 15);
    const hasLeft = local.some(o => o.x < g.x - 15);
    const hasRight = local.some(o => o.x > g.x + 15);
    if ((hasUp && hasDown) || (hasLeft && hasRight)) enclosed.push(g);
  }
  log('enclosedGndPads', enclosed.map(p => ({ num: p.num, x: p.x, y: p.y })));
  // 【尺寸闸门：短路是这块板最贵的错误，这里就是它的现场】
  // 上面那个「被包围」判据只回答「上下/左右有没有邻居」，**完全不问焊盘自己有多大**。
  // 实测代价（run 203952）：U3(MAX98357A) 是 0.5mm 间距，相邻盘心 19.7mil，那一排的
  // 中间引脚天然左右都有邻居 ⇒ 被判成「被包围的 EP 焊盘」⇒ 在一块 10x24 mil 的普通
  // 引脚上打了外径 19.7 mil 的孔 —— 孔比焊盘还宽，必然压到相邻引脚的铜。
  // DRC 因此报出 4 条 `SMD Pad to Via cur=0`（625/-2041、591/-2095、729/-1744、
  // 729/-1676，与 epViaAt 逐点对上），cur=0 = 两块铜直接相接 = 短路。
  // 所以补一条**可量**的前置条件：焊盘实测包围盒必须在两个方向上都装得下
  // 「孔外径 + 两侧各一份间距」。装不下不打；读不到包围盒也不打（盲打正是那次
  // 短路的成因）；两种都留一条账，不沉默跳过。
  const EP_VIA_H = 11.8, EP_VIA_D = 19.7;
  // 6 mil 取自本板 DRC 实测 need（SMD Pad to Via need=6），不是口号
  const EP_VIA_CLEAR = 6;
  const EP_VIA_NEED = EP_VIA_D + 2 * EP_VIA_CLEAR;   // 31.7 mil
  const epSkip = [];
  for (const g of enclosed) {
    try {
      let pbb = null;
      try { pbb = await eda.pcb_Primitive.getPrimitivesBBox([String(g.id)]); } catch (e) { pbb = null; }
      const okBB = pbb && Number.isFinite(pbb.minX) && Number.isFinite(pbb.maxX)
        && Number.isFinite(pbb.minY) && Number.isFinite(pbb.maxY);
      const pw = okBB ? pbb.maxX - pbb.minX : null;
      const ph = okBB ? pbb.maxY - pbb.minY : null;
      const pwR = pw === null ? null : Math.round(pw * 100) / 100;
      const phR = ph === null ? null : Math.round(ph * 100) / 100;
      if (pw === null || ph === null) {
        epSkip.push({ num: g.num, why: 'noBBox', need: EP_VIA_NEED });
        log('epViaSkip', { num: g.num, at: [g.x, g.y], why: 'noBBox', need: EP_VIA_NEED,
          whyText: '读不到焊盘包围盒：瞎打孔会压住邻居，正是 run 203952 那 4 条短路的成因' });
        continue;
      }
      if (pw < EP_VIA_NEED || ph < EP_VIA_NEED) {
        epSkip.push({ num: g.num, w: pwR, h: phR, why: 'padTooSmall', need: EP_VIA_NEED });
        log('epViaSkip', { num: g.num, at: [g.x, g.y], why: 'padTooSmall',
          pad: [pwR, phR], need: EP_VIA_NEED,
          whyText: '焊盘装不下过孔：外径 ' + EP_VIA_D + ' + 两侧间距 ' + EP_VIA_CLEAR
            + 'x2 = ' + EP_VIA_NEED + ' mil，而该焊盘只有 ' + pwR + 'x' + phR
            + ' mil ⇒ 打孔必然侵入相邻焊盘的铜' });
        continue;
      }
      // 过孔取规则最小值：外径 0.5mm≈19.7mil，孔 0.3mm≈11.8mil
      // EP 焊盘窄，中心打孔会贴近相邻同排焊盘 → 沿"离最近非GND焊盘最远的方向"偏移
      const near = padList
        .filter(o => o.id !== g.id && String(o.net || '').toUpperCase() !== 'GND')
        .map(o => ({ o, d: Math.hypot(o.x - g.x, o.y - g.y) }))
        .sort((a, b) => a.d - b.d)[0];
      let vx = g.x, vy = g.y;
      if (near && near.d < 40) {
        const dx = g.x - near.o.x, dy = g.y - near.o.y;
        const len = Math.hypot(dx, dy) || 1;
        const off = 7;   // 偏移 7mil，留出 6mil 间距余量
        vx = g.x + (dx / len) * off;
        vy = g.y + (dy / len) * off;
      }
      const v = await eda.pcb_PrimitiveVia.create('GND', vx, vy, EP_VIA_H, EP_VIA_D);
      if (v) viaCount++;
      let epVid = null;
      try { epVid = v?.getState_PrimitiveId?.() ?? null; } catch (e) { epVid = null; }
      epViaRecs.push({ padId: g.id, num: g.num, x: g.x, y: g.y,
        off: Math.round(Math.hypot(vx - g.x, vy - g.y) * 100) / 100,
        near: near ? Math.round(near.d * 100) / 100 : null,
        nearX: near ? near.o.x : null, nearY: near ? near.o.y : null,
        viaId: epVid ? String(epVid) : null });
      log('epViaAt', { pad: [g.x, g.y], via: [vx, vy], near: near ? near.d : null,
        padSize: [pwR, phR] });
    } catch (e) { log('viaErr', { at: [g.x, g.y], m: String(e && e.message).slice(0, 120) }); }
  }
  // 【分母必须和分子一起出现】count 仍是「真的建出来的孔数」（语义与改前一致）；
  // candidates = 判据挑出的候选数 = count + skipped，缺任一项这个数字就读不出意义。
  const epSkipBy = {};
  for (const s of epSkip) epSkipBy[s.why] = (epSkipBy[s.why] || 0) + 1;
  log('epVias', { count: viaCount, candidates: enclosed.length,
    skipped: epSkip.length, skipBy: epSkipBy,
    note: 'candidates = count + skipped；skipped 说明判据挑中但物理上打不下孔' });
} catch (e) { log('preViaErr', String(e && e.message)); }
await sleep(800);

// ---------- 7.6 整板 GND 覆铜（两层）----------
// 关键：必须用 PCB_PrimitivePour（覆铜边框），不是 PrimitiveFill（填充）。
// 只有覆铜在 rebuildAllCopperRegions() 后会真正生成铜皮并连接同网焊盘。
await cam('pcb');   // 铺铜前全板视图
phase('copperPour');
// 【DRC 违规的归属与读数：全文件唯一一份实现】
// IPCB_ViolationBase 给了权威归属（api-types.d.ts:8342/8346 `obj1: string` / `obj2?: string`），
// 但两种形状都要认：explanation.errData 里是裸 id，顶层是 {typeName, suffix} 包装。
// 读一侧的网络/类型必须用 DRC 自己声明的 obj1Type/obj2Type 选类，不靠 get() 猜
// （get(id) 不校验归属，`got:true` 不是类型证据），取到后再核 getState_PrimitiveType。
// 这三个原本写在最终诊断块里（局部 const），而 stitchGaps 的异网短路复检也要用同一套 ——
// 两边各写一份必然漂移，所以提到顶层。
function objIdOf(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'string') return x || null;
  if (typeof x === 'object') return x.id || x.suffix || x.objId || x.primitiveId || null;
  return null;
}
function pickApi(ty) {
  const s = String(ty || '').toLowerCase();
  if (/track|line/.test(s)) return ['line', eda.pcb_PrimitiveLine];
  if (/via/.test(s)) return ['via', eda.pcb_PrimitiveVia];
  if (/pad|terminal/.test(s)) return ['pad', eda.pcb_PrimitivePad];
  return null;
}
async function readSide(ty, id) {
  const pk = pickApi(ty);
  if (!pk || !id || !pk[1] || typeof pk[1].get !== 'function') return null;
  const [kind, api] = pk;
  try {
    const prim = await api.get(id);
    if (!prim) return null;
    const gotType = String(prim.getState_PrimitiveType?.() || '').toUpperCase();
    const wantOk = kind === 'line' ? /LINE|TRACK/.test(gotType)
      : kind === 'via' ? /VIA/.test(gotType) : /PAD/.test(gotType);
    const net = prim.getState_Net?.();
    const d = { kind, gotType: gotType || null, typeOk: wantOk,
      net: (net === undefined || net === null || net === '') ? null : String(net).toUpperCase() };
    if (kind === 'pad') {
      d.padNum = prim.getState_PadNumber?.() ?? null;
      const h = prim.getState_Hole?.();
      d.hole = Array.isArray(h) ? String(h[0]) : null;
      d.holeD = Array.isArray(h) ? h[1] : null;
    } else if (kind === 'line') {
      d.layer = prim.getState_Layer?.() ?? null;
      d.w = prim.getState_LineWidth?.() ?? null;
    }
    return d;
  } catch (e) { return { kind, err: String(e && e.message).slice(0, 60) }; }
}
// 【为什么包成函数】下面的相位原来在 autoRouting **之前**就把两层铜铺满，
// 布线器随后带着 keep:true 进场，只能在 8mil 缝里挤 —— 实测 26 器件/111 连接的
// 板上，这个顺序让布线器永远差 12~14 根线布不通，并留下
// `Clearance Error | Slot Region to Track`（走线撞铺铜边界）。
// 所以改成：这里先铺（留出 pcb-pour 这一帧与 pourCount 语义），
// 布线前删掉覆铜边框，布通后再调用同一个函数补铺。
// 一个函数两处调用，避免「两处各自实现一遍然后漂移」。
async function doCopperPours() {
let pourCount = 0;
try {
  // 从板框 polyline 的 bbox 取实际范围，避免坐标系猜错
  let x0 = 0, y0 = 0, w = D.boardWidthMil || 1000, h = D.boardHeightMil || 800;
  try {
    const plIds = await eda.pcb_PrimitivePolyline.getAllPrimitiveId();
    for (const id of plIds) {
      const pl = await eda.pcb_PrimitivePolyline.get(id);
      if (pl?.getState_Layer?.() !== 11) continue;
      const src = pl?.getState_Polygon?.()?.getSource?.();
      if (Array.isArray(src) && src[0] === 'R') {
        x0 = src[1]; y0 = src[2]; w = src[3]; h = src[4];
        break;
      }
    }
  } catch (e) { log('outlineReadErr', String(e && e.message).slice(0, 120)); }
  const inset = 8;
  log('outlineBBox', { x0, y0, w, h, inset });
  // GND 铺满两层；其余电源网络（VDD/VCC/3V3/5V 等）在顶层单独铺一块小一点的
  const gndPlan = [
    { net: 'GND', layer: 1, inset },
    { net: 'GND', layer: 2, inset },
  ];
  const pwrNets = (D.connections || []).map(c => String(c[2]))
    .filter(n => {
      const u = String(n).toUpperCase();
      return u && !u.startsWith('GND')
        && (u.startsWith('VDD') || u.startsWith('VCC')
            || u === '3V3' || u === '3.3V' || u === '5V' || u.startsWith('+'));
    });
  const uniqPwr = [...new Set(pwrNets)];
  log('powerNets', uniqPwr);
  // 电源网络在顶层铺，内缩更大避免和 GND 抢空间；多于 1 个时逐个加优先级错开
  for (let i = 0; i < uniqPwr.length && i < 2; i++) {
    gndPlan.push({ net: uniqPwr[i], layer: 1, inset: inset + 14 + i * 12, priority: 8 + i });
  }
  for (const plan of gndPlan) {
    try {
      const poly = eda.pcb_MathPolygon.createPolygon(
        ['R', x0 + plan.inset, y0 + plan.inset,
         w - plan.inset * 2, h - plan.inset * 2, 0, 0]);
      const p = await eda.pcb_PrimitivePour.create(
        plan.net, plan.layer, poly, 'solid', false,
        'AI_' + plan.net + '_L' + plan.layer, plan.priority || 5, 8, false);
      if (p) pourCount++;
    } catch (e) { log('pourErr', { net: plan.net, layer: plan.layer, m: String(e && e.message).slice(0, 200) }); }
  }
  log('copperPours', { count: pourCount });
  if (pourCount > 0) {
    try {
      await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
      // 原来记的是常量 true（"没抛就算成功"），永远证明不了任何事 —— 常量日志不是证据。
      await sleep(800);
      try {
        const ids0 = await eda.pcb_PrimitivePoured.getAllPrimitiveId();
        log('pourRebuilt', { poured: Array.isArray(ids0) ? ids0.length : null });
      } catch (e) {
        log('pourRebuilt', { poured: null, m: String(e && e.message).slice(0, 120) });
      }
    } catch (e) { log('pourRebuildErr', String(e && e.message).slice(0, 200)); }
  }
} catch (e) { log('pourFail', String(e && e.message)); }
return pourCount;
}
let pourCount = await doCopperPours();
await sleep(2500);

// ---------- 8. 自动布线 ----------
// 极速引擎：layers 数组 + 地孔策略；EP(散热焊盘)被本体包围，必须打地过孔才能连出
await cam('pcb', true);   // 强制激活 PCB：否则布线结果不落盘
await shot('pcb-pour');

// ---------- 布线前清掉预先铺好的铜 ----------
// 删除的是**覆铜边框**（PrimitivePour）；填充的实铜（PrimitivePoured）由边框派生。
// 删完必须 rebuildAllCopperRegions()，否则实铜仍留在画布上，布线器还会撞它。
// 这里只是「让出空间」，不是取消铺铜：布线变体的 cfg 里带着 pours，
// 布线器会在自身结束时给 GND 铺铜；万一它没铺，下面还会补铺一次。
// 绝不动 pourCount 的主语义 —— 它记的是「我们主动铺过几块」，见文件末尾 pourRebuildOk。
let pourClearedForRouting = 0;
try {
  const pourIds = (await eda.pcb_PrimitivePour.getAllPrimitiveId()) || [];
  let pourDelFail = 0;
  for (const pid of pourIds) {
    // delete 在失败时 resolve(false) 而不是抛 —— try/catch 抓不到。
    // 不看返回值就自增，等于把"请求删除"记成"已删除"：
    // 随后 if (cleared > 0) 会跳过 rebuild，布线器就在一层自以为没了的铜上开工。
    try {
      if ((await eda.pcb_PrimitivePour.delete(pid)) === true) pourClearedForRouting++;
      else pourDelFail++;
    } catch (e) {
      pourDelFail++;
      log('pourDelErr', { pid, m: String(e && e.message).slice(0, 80) });
    }
  }
  if (pourDelFail > 0) log('pourDelFail', { fail: pourDelFail, ok: pourClearedForRouting });
  if (pourClearedForRouting > 0) {
    try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
    await sleep(800);
  }
  log('pourClearedForRouting', { found: pourIds.length, cleared: pourClearedForRouting });
} catch (e) {
  // 读不到/删不掉都不能当成「已经清干净」继续布 —— 那就等于在不知道的情况下铺满铜布线。
  log('pourClearFail', String(e && e.message).slice(0, 160));
}
phase('autoRouting');
let routeState = null, routeAttempts = [];
// ---------- 布线器规则覆盖 ----------
// 这是"事后修补"换成"事前约束"的关键。engineConfig.rules 覆盖的每一项
// 都正好对应一类事后修补的费劲、且常常修不动的 DRC 违规：
//   clearance    → Track to Track / Track to Via
//   padClearance → SMD Pad to Track
//   edge         → Slot Region to Track（槽/板边，d13 一共 5 处这类）
//   holeToHole   → Hole to Track
//   via          → 孔与铜盘尺寸（不打过小孔就不会 Hole to Track）
// 之前 baseEngine 一个 rules 都没传，布线器只能按自己的默认值走，于是
// 生成一堆"差 0.4~0.6mil"的擦边违规，fixClearance 再靠缩窄/绕行去补，
// 结果越补越糟（d13: 6 → 6 → 17）。
// DRC 要求 6mil，这里给 8mil 留 2mil 余量，让布线本身合规。
// via 特意取 d=24/h=12（而非事后修补里用的 19.7/11.8）：
// 既是 6mil 环宽的合规值，又能从成品过孔尺寸**直接验证 rules 真的生效了**——
// 若日志里过孔仍是 19.7，说明 rules 被静默忽略（官方文档明确警告过这种静默失效）。
const MARGIN_RULES = {
  // holeToHole 保持 10。曾经按"布线器余量小于 DRC 要求(11.811)"的理由把它提到 13，
  // 结果在 gen-rp2040 上**回归**：同样的设计前两次分别 182s / 244s 通过，改成 13 后
  // 跑了 441s 并以 routeState=TIMEOUT 失败（DRC 违规组仍是 0，说明不是违规多，
  // 而是布线器在更严的孔距下反复重试跑不完）。
  // 结论：d12 的 Hole×Hole 缺口确实存在，但"提高布线器孔距"不是安全的解法——
  // 它把 22 个已通过的设计一起拖慢/拖垮。要动它，必须单独拿 d12 做受控实验，
  // 先量成功率与耗时，不能顺手改。
  clearance: 8, padClearance: 8, edge: 15, holeToHole: 10,
  width: 10, via: { d: 24, h: 12 },
};
const baseEngine = {
  layers: [{ id: 1, dir: 'V' }, { id: 2, dir: 'H' }],
  rules: MARGIN_RULES,
  // 地孔策略：给 EP 焊盘自动打孔下到地层
  ground: {
    pattern: 'POUR',
    epVias: { pitch: 30, max: 9 },
  },
  // 整板 GND 正片铺铜（两层都铺）
  pours: [{ layer: 1, net: 'GND' }, { layer: 2, net: 'GND' }],
  // GND 用更宽的线
  classes: [{ name: 'GND', nets: ['GND'], width: 12, priority: 30 }],
};
const variants = [
  // 带间距余量的配置优先；布不通时后面还有不带 rules 的退路，
  // 所以"约束太紧导致布不完"不会比现在更差。
  { name: 'margin+ground+pours+keep', keep: true, cfg: baseEngine },
  { name: 'margin+ground+keep', keep: true, cfg: { layers: baseEngine.layers, rules: MARGIN_RULES, ground: baseEngine.ground, classes: baseEngine.classes } },
  { name: 'ground+pours+keep', keep: true, cfg: { layers: baseEngine.layers, ground: baseEngine.ground, pours: baseEngine.pours, classes: baseEngine.classes } },
  { name: 'margin+keep-only', keep: true, cfg: { layers: baseEngine.layers, rules: MARGIN_RULES } },
  { name: 'keep-only', keep: true, cfg: { layers: baseEngine.layers } },
  { name: 'ground+pours', keep: false, cfg: { layers: baseEngine.layers, ground: baseEngine.ground, pours: baseEngine.pours, classes: baseEngine.classes } },
  { name: 'plain', keep: false, cfg: { layers: baseEngine.layers } },
];
// 迭代：布线 → DRC → 若有断连则再布一次（keep 模式，保留已有铜只补缺）
// 优化级别：默认 ULTRA_FAST（快）。实测 d6 一上来就用 COMPLETION，
// 反而布不通 → 触发放大板框，最终 3104x2607（比 1925x1617 大 2.6 倍）且耗时翻倍。
// 所以策略是「先快后强」：常规轮次用极速，只有 3 轮变体全军覆没时才动用
// COMPLETION 兜底（那是真的布不通，此时慢也认了）。
const ROUTE_OPT = { FAST: EPCB_AutoRoutingOptimization.ULTRA_FAST, STRONG: EPCB_AutoRoutingOptimization.COMPLETION };
// 主循环 3 轮用 FAST；若 3 轮后仍有断连，再补 1 轮 STRONG（第 4 轮）。
// iter===3 就是那个保底轮次。
//
// 【曾经试过给保底轮 4 次机会（iter 3..6），实测**更差**，已回退，别再试】
// 对照同一块板 designs/mic-esp32s3.json（26 器件 / 111 连接 / 2600x1900 mil），
// 两次都是 attempt 1 即 [smart-fit]、同一个 pipeline、只有轮数不同：
//
//   iter 上限 4（现行）：连接错误 16（Track 3 / SMD 13）  间距错误  5
//   iter 上限 7（已回退）：连接错误 16（Track 2 / SMD 13 / TH 1）间距错误 31
//                                                         ↑ SMD Pad to Track 2→15
//                                                          新增 Slot Region to Track 7
// 多出来的 3 个 COMPLETION 轮对连通性**零改善**（都停在 14 个断连），
// 却把间距违规翻了 6 倍。那次还测到更反直觉的一点：
// STRONG 轮跑满 765 秒（正常跑完，未被取消）只把断连压到 14；
// 而预算小、151 秒就被 capRaw 掐断的那次反而压到 12。
// 即「给布线器更多时间」在这块板上是负收益 —— COMPLETION 模式在反复推翻自己。
// 所以本仓库那条「重试阶梯会让结果变差」不只在设计层成立，在**布线轮次**层也成立。
// 走线计数：判「这次 attempt 到底产出了什么」的唯一依据。
// 三个返回形态都要区分：数组（有走线，可能是 0 条）、非数组/抛异常（读不出来）。
// 0 和"读不出来"必须分开 —— 0 是有意义的结论（这次 attempt 空转），
// -1 不是结论，不能拿去驱动"换下一个变体"这种决定。
const countTracks = async () => {
  try {
    const ids = await eda.pcb_PrimitiveLine.getAllPrimitiveId();
    return Array.isArray(ids) ? ids.length : -1;
  } catch (e) { return -1; }
};
// 【上限：回到 4 = 只给一次强轮】
// 曾经写到 6，理由是"4 会在最有效的那一轮之后立刻收手"。2026-11-26T17:09 的实测
// 把这个理由推翻了。同设计、同板（1300x3700）、同一份脚本，前四轮逐字节一致，
// 之后每次强轮一好一坏地跳：
//   iter0 FAST  122 -> 72   tracksAdded 537
//   iter1 FAST   72 -> 72   tracksAdded  17
//   iter2 FAST   72 -> 72   tracksAdded   4
//   iter3 强轮   72 ->  6   tracksAdded 186   delta -66   ← 史上最好
//   iter4 强轮    6 -> 105  tracksAdded  12   delta +99   ← 15 倍恶化
//   iter5 强轮  105 -> 20   tracksAdded   1   delta -85
// 而 4 轮（iter<4）与 6 轮跑出来的 DRC **完全一样**：33/66，byType 逐项相同
// （Slot Region to Track 10 / SMD Pad to Track 7 / Connection Error SMD Pad 6 /
//   Track to Track 4 / Hole to Hole 3 / Connection Error Track 2 / SMD Pad to Via 1）。
// 多出来的两轮强轮花掉约 280s，换到的 DRC 收益是 0，还有一次把断连从 6 推到 105。
// 既然收益为 0、方差为正，"多跑几轮"就不是一个特性。
// 预算方向不放松：LEFT 闸 / capRaw 闸 / 零新增闸 / 清零闸四道全部保留（见下方）。
const MAX_ROUTE_ITERS = 4;
let prevUnconnected = null;
for (let iter = 0; iter < MAX_ROUTE_ITERS; iter++) {
  // iter 3 起都是 COMPLETION 强轮。多轮强轮各自仍受 capRaw 约束，
  // 且 capRaw = left() - 180000 随时间收缩，晚到的强轮自然被压短。
  const isStrong = (iter >= 3);
  if (isStrong) {
    // 只有在前面所有 FAST 轮次都没能清零断连时才走到这里。
    // 带 iter：否则三轮强轮会打出三条一模一样的日志，读的人分不清跑到第几次。
    log('routeEscalate', { iter, reason: 'FAST 轮后仍有断连，升级 COMPLETION 兜底' });
  }
  let tracksAddedThisIter = 0;
  // 连续「超时且零新增走线」的次数。见下方 TIMEOUT 分支里的长注释。
  let timeoutNoOpStreak = 0;
  for (const v of variants) {
    // 预算闸：变体数从 5 增到 7，且带间距余量的配置更容易布不完。
    // 不设闸的话最坏情况是 7×(600~900s) 远超外部 590s 的 invoke 超时，
    // 超时＝幽灵调用（EDA 里作业还在跑，进程状态被污染，后续设计连环失败）。
    // 留 240s 给 snapEnds/stitch/fixClearance/drc/export 这一大段收尾。
    if (left() < 240000) {
      log('routeBudgetStop', { iter, variant: v.name, leftMs: left(), done: routeAttempts.length });
      break;
    }
    try {
      const isFirstTry = isStrong;
      const opt = isStrong ? ROUTE_OPT.STRONG : ROUTE_OPT.FAST;
      const linesBefore = await countTracks();
      const job = await eda.pcb_Document.startAutoRouting({
        optimization: opt,
        existingPrimitiveMode: v.keep ? EPCB_AutoRoutingExistingPrimitiveMode.KEEP
                                     : EPCB_AutoRoutingExistingPrimitiveMode.REMOVE,
        engineConfig: v.cfg,
      });
      if (job?.jobId) {
        // COMPLETION 模式布线更彻底、明显更慢，给它 900s；极速模式 600s 足够。
        // 预算闸不能把"保底轮"一起掐掉 —— 这是本文件里最容易犯的一类错：
        // 用一个常数同时管两种量级完全不同的作业，结果把唯一能成的那一轮也毙掉。
        //
        // 实测（同板 1411x1411 的 RP2040_QSPI_Flash，5 次运行对照）：
        //   215630  left=399926 capRaw=219926 跑   routeIter=[40,37,37,0]  最终 DRC 2
        //   220801  left=400215 capRaw=220215 跑   routeIter=[40,37,37,0]  最终 DRC 0
        //   232022  left=497339 capRaw=317339 跑   routeIter=[40,37,37,0]  最终 DRC 0
        //   214200  left=275030 capRaw= 95030 跳   routeIter=[]           最终 DRC 52
        // 即：**每一次成功都是 iter 3（COMPLETION 保底轮）把 stillUnconnected 打到 0，
        // 且只花 21~31 秒**。214200 有 275 秒余量，却因为 95030 < 120000 把四轮全跳过
        // （routeAttempts 空、stillUnconnected 停在 41），收尾时还白剩 160 秒。
        // 那块板本来能布通 —— 这不是"预算不够"，是"门槛按错了量级"。
        //
        // 所以：保底轮只要还有 45s 余量就放行（覆盖实测 21~31s，约 1.5 倍余量），
        // 常规轮仍要 120s（FAST 变体可能要跑到分钟级，余量不足会 TIMEOUT 白烧时间）。
        // 等待时长仍由 capRaw 兜住（见下方 waitJob 的 Math.min），不会超 invoke 超时。
        const capRaw = left() - 180000;
        const capNeed = isStrong ? 45000 : 120000;
        if (capRaw < capNeed) {
          // 预算已不够给布线器一次像样的机会。旧代码 `Math.max(left()-180000, 60000)`
          // 把等待压到 60s，然后**照样** startAutoRouting 下一个变体 ——
          // 结果是同一个板子上两个布线器同时写铜，几何互相覆盖，比布线不完整糟得多。
          // 正确做法：不再启动新作业，并且把这个刚建的作业取消掉。
          // capRaw/capNeed 一起打出来：只记 leftMs 时看不出"差多少被跳过"，
          // 下次还得靠离线算术回放才能知道门槛卡在哪 —— 那是精度幻觉的一种。
          log('routeBudgetSkip', { iter, variant: v.name, leftMs: left(), capRaw, capNeed, isStrong });
          try { await eda.pcb_Document.cancelAutoJob(job.jobId); } catch (e) { }
          routeState = routeState || 'budget';
          break;
        }
        // 【FAST 轮的等待上限必须远小于 capRaw，否则保底轮会被饿死】
        // 实测 513 次 route 事件：FAST 变体（iter0~2）正常耗时 3.6~30s
        //   iter0 n=131 均 9.5s / iter1 n=127 最大 6.1s / iter2 n=127 最大 8.3s；
        // 唯一的离群值是 d11 的 317s TIMEOUT 和 207s completed（都是 Crystal RTC 那块板）。
        // 它一口气把整个布线预算吃掉，于是 capRaw 跌破 120s 门槛 ⇒ 之后每个变体都被
        // routeBudgetSkip 跳过，`left() < 240000` 又把 iter3 挡住 ⇒ **COMPLETION 保底轮
        // 一次都没跑**，板子带着 27 处断连被判死（fail-d11-...-r2.txt）。
        // 而全语料每一次真正布通都是保底轮用 21~31s 打平的（L1179 已记）。
        // 所以：FAST 轮最多等 120s（正常值的 4 倍余量），把预算留给保底轮。
        // 120s 这个数不是拍的：两次 FAST 超时 = 240s，加收尾 180s 仍在 530s 预算内，
        // 且此时 left≈257s > 240s、capRaw≈77s > capNeed 45s ⇒ 保底轮一定能跑。
        const fastCap = isStrong ? 900000 : 120000;
        const r = await waitJob(job.jobId, Math.min(fastCap, capRaw), isFirstTry ? 'route' : 'route2');
        // 【判据：真实新增的走线数，不是作业自报的 state】
        // 实测 2026-11-26 15:36（26 器件 / 111 连接 / 1000x3700 mil）：
        //   4 次 route 全部 state=completed，7.2 / 7.2 / 6.0 / 8.5 秒，
        //   stillUnconnected 恒为 121，走线一条都没画。
        // 原来这里无条件 break，于是 variants[1..6] 从来没执行过
        // （全语料 143 个目录里 129 个只出现过 variants[0] 一个名字）。
        // 作业状态回答"作业怎么结束的"，这里要问的是"板子通没通"。
        const linesAfter = await countTracks();
        const linesAdded = (linesBefore >= 0 && linesAfter >= 0) ? linesAfter - linesBefore : null;
        tracksAddedThisIter += (linesAdded === null ? 0 : Math.max(0, linesAdded));
        routeAttempts.push({ iter, variant: v.name, jobId: job.jobId, state: r.state, ms: r.ms, linesAdded });
        routeState = r.state;
        log('route', { iter, variant: v.name, state: r.state, ms: r.ms, linesAdded });
        if (r.state === 'completed') {
          if (linesAdded === 0) {
            // 空转：一个图元都没画。换下一份引擎配置 —— 这不是"重试同一个东西"。
            // keep=true 时已有铜不会被动，所以不会累加副作用。
            log('routeNoOp', { iter, variant: v.name, ms: r.ms, tracks: linesAfter });
          } else {
            // 有产出（或读不出来，保守）：保持原有行为，不加轮次。
            break;
          }
        }
        if (r.state === 'TIMEOUT' || r.state === 'ERR') {
          // 等超时不等于作业停了。不取消就换变体 → 同板双布线器。
          // cancelAutoJob 是协作式取消（EDA docs：写回前被取消则已算出的几何不会落到画布）。
          try {
            const cc = await eda.pcb_Document.cancelAutoJob(job.jobId);
            log('routeCancelled', { iter, state: r.state, ok: cc });
          } catch (e) { log('routeCancelErr', { iter, m: String(e && e.message).slice(0, 80) }); }
          // 【超时 ≠ 这份配置不适用】实测 2026-11-26T15:44–16:15
          // （ESP32S3_Wireless_Mic_V2，26 器件 / 111 连接 / 1000x3700 mil，预算 1740s）：
          //   7 份引擎配置全部 state=TIMEOUT，耗时 120681/120687/120828/120799/
          //   120765/120985/120946 ms —— 极差 304 ms，全都精确撞在上限上；
          //   linesAdded 全为 0。阶梯本身吃掉 937.1s（54.3% 预算），
          //   零产出；紧接着 drc 只剩 135s，6 个导出全部 skipped=budget。
          // 同极差 = 限制因素是时间不是配置，换配置只会把同样的 120s 再烧一遍。
          // 而 completed + 0 是另一回事：那才是「这份配置布不出来」的铁证，该换配置。
          // 所以这里按「超时且零新增走线」计数，连续两次就收手。
          if (r.state === 'ERR' || (r.state === 'TIMEOUT' && linesAdded !== null && linesAdded === 0)) {
            timeoutNoOpStreak++;
          } else {
            timeoutNoOpStreak = 0;
          }
          if (timeoutNoOpStreak >= 2) {
            const notTried = variants.length - routeAttempts.length;
            log('routeLadderAbort', {
              iter, after: routeAttempts.length, streak: timeoutNoOpStreak,
              tried: routeAttempts.map((a) => a.variant),
              notTried,
              why: '连续 2 次超时且零新增走线 —— 限制因素是时间不是配置，换配置不会更快',
              savedMsApprox: Math.max(0, notTried) * 120000,
            });
            break;
          }
        }
      }
    } catch (e) {
      routeAttempts.push({ iter, variant: v.name, err: String(e && e.message).slice(0, 200) });
      log('routeErr', { iter, variant: v.name, m: String(e && e.message).slice(0, 300) });
    }
    await sleep(800);
  }
  await eda.pcb_Document.save();
  await sleep(1000);

  // 检查是否还有 Connection Error；没有就停
  // 注意：check(true,false,true) 返回**分组树** —— 顶层是类别节点
  // （{name:'Connection Error', count:2, list:[...]}），真正断点在 list 深层，
  // 且只有深层节点才有 errorType。只匹配 errorType 会把 2 个断点算成 0，
  // 让循环误以为已布通而提前 break（d6/d7/d11/d12 全部栽在这）。
  // 初值必须是 Infinity 而不是 0：DRC 若抛异常，原实现停在 0 →
  // 下一行 `if (stillUnconnected === 0) break` 把「查不出来」当成「已布通」，
  // 直接跳过重建覆铜和后续所有轮次，断连一路拖到最终 DRC。
  // 「未知」必须比「确定有断连」更保守。
  let stillUnconnected = Infinity;
  try {
    const d = await eda.pcb_Drc.check(true, false, true);
    const leaves = [];
    const walk = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.errorType === 'Connection Error') leaves.push(n);
      if (n.list) walk(n.list);
    };
    walk(d);
    // 深层叶子才是真断点数；若树里只有类别层也可以退化用 count
    if (leaves.length) stillUnconnected = leaves.length;
    else {
      // 退化路径必须能区分「树读到了、count 真是 0」和「树读不懂」。
      // 原实现对不可解析节点返回 0 → 空树被读成「已布通」→ 下面
      // `if (stillUnconnected === 0) break` 直接跳出，断连一路拖到最终 DRC。
      // 这与本条上方注释「未知必须比确定有断连更保守」正好相反。
      let sum = 0, sawNode = false;
      const sumCount = (n) => {
        if (!n) return 0;
        if (Array.isArray(n)) return n.reduce((s, x) => s + sumCount(x), 0);
        sawNode = true;
        if (n.list) return sumCount(n.list);
        const c = Number(n.count);
        if (!Number.isFinite(c)) return 0;
        sum += c;
        return 0;
      };
      sumCount(d);
      // 读不懂 → 保持 Infinity（当作仍有断连，继续下一轮），绝不 break
      stillUnconnected = sawNode ? sum : Infinity;
    }
  } catch (e) {
    log('iterDrcErr', String(e && e.message).slice(0, 120));
    errors.push('iterDrc: ' + String(e && e.message).slice(0, 120));
    // 查不出断点数 → 视为仍有断连，继续下一轮（不要 break）
  }
  // delta 让"多跑一轮到底有没有用"成为一条可读证据。
  // 只记 absolute 值的话，判断趋势要靠把若干条 routeIter 摆在一起心算 ——
  // 而 prevUnconnected 的初值必须是 null 而不是 0，否则 iter0 会被算成 +122。
  const delta = (prevUnconnected == null) ? null : (stillUnconnected - prevUnconnected);
  log('routeIter', { iter, stillUnconnected, tracksAdded: tracksAddedThisIter,
    prevUnconnected, delta, isStrong });
  // 强轮不但没降幅、反而把断连推高 —— 实测过两次的形状（72->181、6->105）。
  // 只记 routeIter 的话，趋势要人把若干条摆在一起心算；而"哪一轮是拐点"
  // 恰恰是决定这个上限该写几的唯一依据。所以单列一条，并带上倍率。
  if (isStrong && delta != null && delta > 0) {
    log('routeRegressed', { iter, prevUnconnected, stillUnconnected, delta,
      factor: prevUnconnected > 0 ? Math.round(stillUnconnected / prevUnconnected * 10) / 10 : null });
  }
  prevUnconnected = stillUnconnected;
  // 一整轮 7 份引擎配置合计一条走线都没画出来 —— 再换轮次只会重复同一件事。
  // 不判这条的话，4 轮 x 7 变体 x ~8 秒 ≈ 224 秒纯空转，把收尾预算吃掉。
  if (tracksAddedThisIter === 0) {
    log('routeAllVariantsNoOp', { iter, variants: variants.length, stillUnconnected });
    break;
  }
  // 布线器作业的 state 说的是「作业怎么结束的」，闸门问的是「板子通没通」。
  // 实测事故（2026-11-26 01:09 gen-rp2040 / smart-fit）：COMPLETION 保底轮跑到
  // 133.6s 被我们按 capRaw **主动取消**（协作式取消，已算出的几何不落画布），
  // 于是 routeState=TIMEOUT；但紧接着的 DRC 证明断连数 = 0，而预算还白剩 179s。
  // 整块板就这样被判死，还白烧了两次取片。
  // 所以：只要 DRC **证明**断连为 0，就把 routeState 校正成 completed。
  // 边界必须严格：stillUnconnected 初值是 Infinity（「查不出来」比「确定有断连」
  // 更保守），除了严格等于 0 之外任何值 —— 包括 Infinity —— 都保持原判。
  if (stillUnconnected === 0 && routeState !== 'completed') {
    log('routeStateRecovered', { iter, was: routeState, stillUnconnected });
    routeState = 'completed';
  }
  if (stillUnconnected === 0) break;
  // 还有断连 → 重建覆铜（新铜可能遮挡）后再来一轮
  try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
  await sleep(800);
}
log('routeAttempts', routeAttempts);

// ---------- 布线结束后把铜铺回来 ----------
// 三种情况都要能分辨，不许混成一个数字：
//   repoured > 0  → 布线器没铺，我们自己补了（并累加 pourCount，让下游守卫继续生效）
//   kept    > 0   → 布线器已铺，我们只重建填充
//   neither       → 一块铜都没有；这是真缺陷，如实记 0 并让 pourRebuildOk 去判
try {
  let kept = 0;
  try { kept = ((await eda.pcb_PrimitivePour.getAllPrimitiveId()) || []).length; } catch (e) { kept = -1; }
  let repoured = 0;
  if (kept === 0) repoured = await doCopperPours();
  if (kept > 0 || repoured > 0) {
    await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
    await sleep(800);
  }
  pourCount += repoured;
  log('pourRestoredAfterRouting', { kept, repoured, pourCount });
} catch (e) { log('pourRestoreErr', String(e && e.message).slice(0, 160)); }
// ---------- 验证 engineConfig.rules 是否真的生效 ----------
// 官方文档明确警告：rules/layers 写错**不会报错**，只是该项静默不生效。
// 同一份文档也警告过 layers 的旧写法问题，说明这套配置有静默失效的历史。
// 所以这里不能"传了就假设生效"：把成品过孔的真实尺寸读出来，
// 和我们指定的 rules.via（d=24/h=12）对照。若过孔仍是 19.7 或别的数，
// 说明 rules 被忽略，那就不要在"间距余量"这个假设上继续优化——
// 直接看日志就知道，不必等十几个设计跑完再猜。
try {
  const viaIds = (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || [];
  const sizes = new Map();
  for (const vid of viaIds) {
    try {
      const v = await eda.pcb_PrimitiveVia.get(vid);
      const h = Number(v.getState_HoleDiameter?.());
      const dia = Number(v.getState_Diameter?.());
      const key = `${h}/${dia}`;
      sizes.set(key, (sizes.get(key) || 0) + 1);
    } catch (e) { }
  }
  const pairs = [...sizes.entries()].sort((a, b) => b[1] - a[1]);
  const specHit = pairs.some(([k]) => k === `${MARGIN_RULES.via.h}/${MARGIN_RULES.via.d}`);
  // 【一个字段不许表达两个意思】
  // `rulesApplied:false` 在 32/143 个目录里出现，但这个读数混杂了两件事：
  // 它数全部过孔，而其中唯一存在的往往是 ground.epVias 打的地孔
  // （实测 epViaAt 的 near 值 19.4~25.6；EP 地孔尺寸由 ground.epVias 控制，
  // 本来就不受 rules.via 约束）。
  // 所以 false 只证明「没有过孔符合 spec」，不能证明「rules 被引擎忽略了」。
  // 特别是布线器一条走线都没画时，根本不存在信号过孔，此时对 rules.via 无从判断。
  const tracksAddedTotal = routeAttempts.reduce((s, a) => s + (a.linesAdded || 0), 0);
  let rulesVerdict, rulesWhy;
  if (specHit) {
    rulesVerdict = 'applied';
    rulesWhy = '存在符合 spec 的过孔';
  } else if (tracksAddedTotal === 0 && viaIds.length > 0) {
    rulesVerdict = 'unmeasurable';
    rulesWhy = '布线器一条走线都没画，只有 EP 地孔，无法据此判断 rules.via';
  } else if (viaIds.length === 0) {
    rulesVerdict = 'unmeasurable';
    rulesWhy = '板上没有过孔，rules.via 无观测对象';
  } else {
    rulesVerdict = 'ignored';
    rulesWhy = '存在信号过孔但无一符合 spec';
  }
  log('routeRulesProof', {
    specVia: `${MARGIN_RULES.via.h}/${MARGIN_RULES.via.d}`,
    vias: viaIds.length,
    sizes: pairs.slice(0, 6).map(([k, n]) => ({ holeDia: k, n })),
    tracksAdded: tracksAddedTotal,
    verdict: rulesVerdict,
    why: rulesWhy,
    // 保留旧字段但**只表示"有 spec 过孔"这一件事**，不再兼任"rules 生效"的判决。
    specViasPresent: specHit,
  });
} catch (e) { log('routeRulesProofErr', { m: String(e && e.message).slice(0, 100) }); }
// 最后重建一次覆铜，确保铜皮反映最终走线
try {
  if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
} catch (e) { }
await eda.pcb_Document.save();
await sleep(1500);

// ---------- 8.2 走线端点吸附 ----------
// 极速引擎输出的端点有浮点误差（例：363.101 vs 焊盘 363.3），导致 DRC 判为"未连接"。
// 把每条走线端点吸附到最近的同网焊盘/过孔中心，误差阈值 1.5mil。
phase('snapEnds');
let snapCount = 0;
try {
  const anchors = [];
  for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId())) {
    const p = await eda.pcb_PrimitivePad.get(id);
    const net = p?.getState_Net?.();
    if (net) anchors.push({ net: String(net).toUpperCase(), x: p.getState_X(), y: p.getState_Y() });
  }
  for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId())) {
    const v = await eda.pcb_PrimitiveVia.get(id);
    const net = v?.getState_Net?.();
    if (net) anchors.push({ net: String(net).toUpperCase(), x: v.getState_X(), y: v.getState_Y() });
  }
  const SNAP = 1.5;
  // 按网络分桶：原来每条线都 anchors.filter(a => a.net === net) 全表扫描，
  // 复杂度 O(线数 × 锚点数)。实测该阶段 d7(2400×1800) 111.6s、d6 199.0s，
  // 是整条流水线最贵的一段，且与布线质量无关 —— 纯 CPU 浪费。分桶后 111.6s → 88.9s。
  const byNet = new Map();
  for (const a of anchors) {
    if (!byNet.has(a.net)) byNet.set(a.net, []);
    byNet.get(a.net).push(a);
  }
  const lineIds = await eda.pcb_PrimitiveLine.getAllPrimitiveId();
  const seen = new Set();           // net|layer|两端坐标 → 已吸附过的线，只用于统计重复
  let snapDup = 0, snapDot = 0, snapBudgetOut = false;
  // 退化线段只计数不够：必须知道它们从哪来、网是什么、多宽。实测 d11（11 器件、45 连接）
  // 一次删掉 63 条，比连接数还多 —— 说明布线器在每个焊盘/过孔处都可能吐一条零长段。
  // 不记录来源就只剩"63"这个数字，无法判断是布线器固有行为还是我们自己的 bug。
  const dotByNet = {}, dotByW = {}, dotSample = [];
  const noteDot = (net, sx, sy, w) => {
    dotByNet[net] = (dotByNet[net] || 0) + 1;
    const k = String(Math.round(w * 10) / 10);
    dotByW[k] = (dotByW[k] || 0) + 1;
    if (dotSample.length < 8) dotSample.push({ net,
      p: [Math.round(sx * 10) / 10, Math.round(sy * 10) / 10], w: Math.round(w * 10) / 10 });
  };
  for (const id of lineIds) {
    // 预算闸门：给 fixClearance / DRC / 导出留 120s。外部 --timeout 先到就会把这段代码
    // 丢在 render 里继续跑（幽灵调用），下一个 invoke 必挂，所以宁可提前收手。
    if (left() < 120000) { snapBudgetOut = true; break; }
    try {
      const l = await eda.pcb_PrimitiveLine.get(id);
      const net = String(l?.getState_Net?.() || '').toUpperCase();
      if (!net) continue;
      let sx = l.getState_StartX(), sy = l.getState_StartY();
      let ex = l.getState_EndX(), ey = l.getState_EndY();
      // 【退化线段：先于吸附、也先于锚点查表】长度 ~0 的线段作为铜没有意义：接不通任何东西，
      // 却会被 DRC 报成"死铜孤岛/未连接"。实测 d10 的 3V3 与 LED_A 五处 Connection Error
      // 全是这种线（长 0.01mil、宽 10mil），三层几何完全重合、coverage.covered=true 仍判不通。
      // 两个来源都要拦：(a) 下面的吸附把两端吸到同一锚点；(b) 布线器自己输出的零长线。
      // 所以放在 `!pool → continue` **之前**：该网络没有锚点也不能成为"留下一根零长线"的理由。
      // 注意更早还有一道 `if (!net) continue` —— 无网络名的零长线不会进这里（无网线本来
      // 也不参与网表连通判定，故不是缺口，但别误以为"所有零长线都被拦了"）。
      // 阈值 1mil 远小于布线器给的线宽（MARGIN_RULES.width=10，GND 类 12），删掉任何一条
      // 都不可能丢失有效铜：A→A 段不增加任何铜，链 A→A→B 删掉后仍是 A→B。
      if (Math.hypot(ex - sx, ey - sy) < 1) {
        const w0 = Number(l.getState_LineWidth?.() ?? l.getState_Width?.() ?? 0) || 0;
        noteDot(net, sx, sy, w0);
        // delete 的签名是 Promise<boolean>（api-types.d.ts：`@returns 删除操作是否成功`），
        // **失败时 resolve(false) 而不是抛错**。旧写法只看有没有异常就 snapDot++，
        // 于是一次"返回 false 的失败删除"会被记成"已删"——日志说删了，板线还在。
        // 只认 === true；false / undefined 都单独成键。宁可计数偏少，不能虚报。
        try {
          const ok = await eda.pcb_PrimitiveLine.delete(id);
          if (ok === true) snapDot++;
          else log('snapDotDelUnconfirmed', { id, net, w: w0, ret: String(ok) });
        }
        catch (e) { log('snapDotDelErr', String(e && e.message).slice(0, 100)); }
        continue;
      }
      const pool = byNet.get(net);
      if (!pool) continue;
      let changed = false;
      // 每个端点只吸到**最近**的那个锚点。旧写法遍历整池、后命中的覆盖先命中的，
      // 于是同一条线的两端可能被吸到同一个锚点上 → 把线压成"铜点"。
      const nearest = (x, y) => {
        let best = null, bd = SNAP;
        for (const a of pool) {
          const d = Math.hypot(x - a.x, y - a.y);
          if (d < bd) { bd = d; best = a; }
        }
        return best;
      };
      // 吸附前的原坐标：吸附失败时打日志要能说清"从哪到哪"，否则
      // snapModifyUnconfirmed 只有 id，看不出它本来想修什么。
      const pre = [sx, sy, ex, ey];
      const sA = nearest(sx, sy);
      if (sA && (sx !== sA.x || sy !== sA.y)) { sx = sA.x; sy = sA.y; changed = true; }
      const eA = nearest(ex, ey);
      if (eA && (ex !== eA.x || ey !== eA.y)) { ex = eA.x; ey = eA.y; changed = true; }
      if (!changed) continue;
      // 吸附后又被压成点：同样删掉（两端吸到同一锚点时长度为 0）。
      if (Math.hypot(ex - sx, ey - sy) < 1) {
        const w1 = Number(l.getState_LineWidth?.() ?? l.getState_Width?.() ?? 0) || 0;
        noteDot(net, sx, sy, w1);
        try {
          const ok = await eda.pcb_PrimitiveLine.delete(id);
          if (ok === true) snapDot++;
          else log('snapDotDelUnconfirmed', { id, net, w: w1, ret: String(ok) });
        }
        catch (e) { log('snapDotDelErr', String(e && e.message).slice(0, 100)); }
        continue;
      }
      // 【去重键必须带层号】原键是 net|两端坐标，漏了层。上下两层吸附到同一组焊盘/过孔后
      // 端点坐标天然相同，于是它们被判成"重复"，后一条被 `continue` 掉 —— 结果它既没被吸附
      // 也没被处理，端点误差原样留在板上，成了"半修"状态（实测通过的一次 snappedLines
      // 里 dupSkipped 高达 53，其中相当一部分其实是异层被误判）。
      // 键带上层号后，同网异层的两条都会被正常吸附：这不是重复，是打过孔换层的同一段铜。
      // 另外也不再 `continue` 跳过 —— 跳过的唯一效果是让这条线的端点误差留在这里。
      // 真正的同层同网完全重合（两块铜压一块）两边吸附到同一坐标，写回是幂等的，无害。
      const layerNow = Number(l.getState_Layer?.() ?? 1);
      const key = net + '|' + layerNow + '|' + [sx, sy, ex, ey].map(v => Math.round(v * 100)).join(',');
      if (seen.has(key)) snapDup++; else seen.add(key);
      // modify 是唯一能正确写回画布的接口；toAsync+done 会报"对象参数不正确"
      // ★ 但 `modify` 失败时 resolve **undefined 而不抛**（api-types.d.ts:25952 一族）。
      //   本段的 delete 已经改成 `=== true` 才计数，唯独 modify 没跟上 —— 于是
      //   snappedLines.snapped 会把"写回没生效"也数进去。后果不是假通过（最终判 DRC），
      //   而是**归因错**：统计看到"吸附了 N 条却仍断线"，会去怀疑吸附算法，
      //   而不是"modify 静默失败"。夹具也测不出来（_test-snap-dot.js 的桩恒返回对象）。
      const modRet = await eda.pcb_PrimitiveLine.modify(id, {
        startX: sx, startY: sy, endX: ex, endY: ey });
      if (modRet === undefined) {
        log('snapModifyUnconfirmed', { id: String(id), net, from: pre, to: [sx, sy, ex, ey] });
      } else {
        snapCount++;
      }
    } catch (e) { log('snapErr', String(e && e.message).slice(0, 100)); }
  }
  log('snappedLines', { snapped: snapCount, dupSeen: snapDup, dotDeleted: snapDot,
    dotByNet, dotByW, dotSample,
    budgetOut: snapBudgetOut, leftMs: left() });
} catch (e) { log('snapFail', String(e && e.message).slice(0, 150)); }
await sleep(1200);
try {
  if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
} catch (e) { }
await eda.pcb_Document.save();
await sleep(1200);

// ---------- 8.35 断线缺口补铜 ----------
// 实测 d6/d7/d11/d12 全部卡在同一种失败：DRC 只报 1 组 Connection Error，
// 但扩板 4 次（1.5x / 2.0x）都不通 —— 因为**缺口是几何上没铜**，板子大小无关。
//
// 真实案例（d11 GND / U1_19）：
//   焊盘 (2106.9,-624.7) → 走线到 (2106.9,-625.7)   ← 只走 1mil
//   另一段走线起点 (2130.5,-625.7)                  ← 中间 23.6mil 完全空白
//
// ## 算法必须是「跨孤岛」，不能只找最近锚点
// 第一版用过「找离断点最近的锚点」，失败：最近锚点只有 1mil 远（就是那条碎片
// 走线的另一端），于是每轮都在 1mil 的同一个口子上重复描线，6 轮补 12 条废线，
// DRC 仍然 false。真实缺口 23.6mil 并不是「离断点最近」的那个点。
// 正确做法：把同网同层铜按几何连通性聚成孤岛（并查集），只跨**不同孤岛**补线。
//
// ## 坐标换算
// DRC 返回的 position 是真实画布坐标的 **1/10**（实测 210.64 对应 2105.97），
// 不乘 10 会在错误位置找锚点，必然找不到。
await cam('pcb'); await shot('pcb-routed');

// 【补一帧真实的底层铜视图】这一帧不是为了凑数：成片需要"双面"这件事被看见，
// 而顶层视图里过孔只是些小圆点，底层走线一条都看不到。实测 2026-11-26 012933：
// 布线只花了 ~5 秒，4 次轮询拍到的画布哈希完全相同（布线器把改动成批提交，
// 过程中画布不刷新），而 stitchGaps 这一轮补 0 个过孔、首轮 DRC 又零违规，
// 于是 pcb-routed / pcb-stitched / pcb-drc 三帧同哈希 —— 一整套好板只出 6 个画面，
// 取片被判素材不足。**缺的不是图，是一个真正不同的视图。**
// 隐藏顶层 + 切到 BOTTOM：看到的是同一块真实板子的另一面，叙述也诚实。
// 图层显隐是 @beta，且必须在 finally 里恢复 —— 否则后面覆铜/缝补/DRC 的每一帧
// 都只剩底层，记录下来的视频会变成"AI 只画了一面"的假象。
if (REC) {
  let layerFlipped = false;
  try {
    // 切层前的基准字节数（拿不到就记 -1，后面的轮询会退化成"有图就拍"）
    let preSize = -1;
    try {
      const i0 = await eda.dmt_EditorControl.getCurrentRenderedAreaImage();
      if (i0 && Number.isFinite(i0.size)) preSize = i0.size;
    } catch (e) { preSize = -1; }
    const hid = await eda.pcb_Layer.setLayerInvisible(1);
    const sel = await eda.pcb_Layer.selectLayer(2);
    layerFlipped = true;
    // 轮询到画面真的变了为止；上限 8 次，防止一次渲染故障拖成整轮超时
    let postSize = -1;
    let redrawTries = 0;
    for (let t = 0; t < 8; t++) {
      redrawTries++;
      await sleep(400);
      let i1 = null;
      try { i1 = await eda.dmt_EditorControl.getCurrentRenderedAreaImage(); } catch (e) { i1 = null; }
      if (i1 && Number.isFinite(i1.size) && preSize > 0 && i1.size !== preSize) { postSize = i1.size; break; }
    }
    await shot('pcb-bottom');
    log('bottomView', { hid: String(hid), sel: String(sel), pre: preSize, post: postSize, tries: redrawTries });
  } catch (e) {
    log('bottomViewErr', { m: String(e && e.message).slice(0, 100) });
  } finally {
    if (layerFlipped) {
      try { await eda.pcb_Layer.setLayerVisible(1); } catch (e) {
        log('bottomViewRestoreErr', { m: String(e && e.message).slice(0, 100) });
      }
      try { await eda.pcb_Layer.selectLayer(1); } catch (e) { }
      await sleep(300);
    }
  }
}
phase('stitchGaps');
let stitchCount = 0;
// 【缝合线要能被自己造出来的异网短路反查到】stitchedIds / stitchNetById 记本阶段建过的
// 每一条线。依据（out\ESP32S3_Wireless_Mic_V5-20261126-201359 实测）：第 0 轮建的 2 条
// 缝合线里，3V3 那条 id=7ecb8a6ae1ff0b40 一条就占了 26 个 DRC leaf 里 8 条已诊断 clearDiag
// 中的 6 条，clearNet 判定它把 3V3 接到 IMU_REGOUT（cur=0）和 GND 过孔（cur=0），全是异网。
// 本函数在此之前没有任何间距检查：只看断点 12mil 内有没有锚点、对面孤岛在不在 MAX_GAP
// 内，然后直接 create。这里补上「事后按权威归属反查，异网就撤」。
let stitchRevertCount = 0;
let stitchKeptCount = 0;
const stitchedIds = new Set();
const stitchNetById = new Map();
const MERGE = 2;        // 同层 ≤2mil 视为已连通
const MAX_GAP = 150;    // 跨岛补线上限；更远属布局级问题，硬补会横穿板子
const STITCH_W = 12;
try {
  // 收集全部锚点：焊盘中心 / 过孔（两层都算）/ 走线两端与中点
  const anchorsByNet = new Map();
  const addAnchor = (net, x, y, layer, id) => {
    const k = String(net || '').toUpperCase();
    if (!k || !Number.isFinite(x) || !Number.isFinite(y)) return;
    if (!anchorsByNet.has(k)) anchorsByNet.set(k, []);
    anchorsByNet.get(k).push({ x, y, layer, id });
  };
  for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
    try {
      const p = await eda.pcb_PrimitivePad.get(id);
      const n = p?.getState_Net?.();
      if (n) addAnchor(n, Number(p.getState_X()), Number(p.getState_Y()),
        p.getState_Layer?.() ?? 1, id);
    } catch (e) { }
  }
  for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
    try {
      const v = await eda.pcb_PrimitiveVia.get(id);
      const n = v?.getState_Net?.();
      if (n) {
        const x = Number(v.getState_X()), y = Number(v.getState_Y());
        addAnchor(n, x, y, 1, id); addAnchor(n, x, y, 2, id);
      }
    } catch (e) { }
  }
  for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
    try {
      const l = await eda.pcb_PrimitiveLine.get(id);
      const n = l?.getState_Net?.();
      if (!n) continue;
      const layer = l.getState_Layer?.() ?? 1;
      const sx = Number(l.getState_StartX()), sy = Number(l.getState_StartY());
      const ex = Number(l.getState_EndX()), ey = Number(l.getState_EndY());
      addAnchor(n, sx, sy, layer, id); addAnchor(n, ex, ey, layer, id);
      // 中点也要登记，否则长线中段附近的断点找不到所属孤岛
      addAnchor(n, (sx + ex) / 2, (sy + ey) / 2, layer, id);
    } catch (e) { }
  }

  // 并查集把同网同层的锚点聚成孤岛
  const buildIslands = (pool) => {
    const parent = pool.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const uni = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        if (Math.hypot(pool[i].x - pool[j].x, pool[i].y - pool[j].y) <= MERGE) uni(i, j);
      }
    }
    const g = new Map();
    for (let i = 0; i < pool.length; i++) {
      const r = find(i);
      if (!g.has(r)) g.set(r, []);
      g.get(r).push(i);
    }
    return [...g.values()];
  };
  log('stitchAnchors', { nets: anchorsByNet.size,
    total: [...anchorsByNet.values()].reduce((s, a) => s + a.length, 0) });

  // 坑：anchorsByNet 在循环外只采集一次，循环内**从未更新**。
  // 于是每轮 buildIslands 都基于同一份旧锚点，同一处断点会被判为"仍然断开"，
  // 代码就把**完全相同的线段重复创建一次**。实测 d10：GND gap22
  // from[1411,-1290] to[1433,-1290] 连续画了 6 轮（stitchRound 0~5 各 fixed:2），
  // 共 14 条线，断点一处没修好，只是往板上堆了 6 条重合铜皮。
  // 用 drawn 去重：同网同层同端点的线段只画一次；一轮下来全是重复就收手。
  const drawn = new Set();
  let dupStitch = 0;
  const segKey = (net, layer, ax, ay, bx, by) => {
    const r = (v) => Math.round(v * 10) / 10;
    // 端点无序化，A→B 与 B→A 视为同一段
    const a = `${r(ax)},${r(ay)}`, b = `${r(bx)},${r(by)}`;
    return `${net}|${layer}|${a < b ? a + '~' + b : b + '~' + a}`;
  };
  for (let round = 0; round < 6; round++) {
    let details = null;
    try { details = await eda.pcb_Drc.check(true, false, true); } catch (e) { break; }
    const broken = [];
    // 【静默放弃必须计数】下面两个 continue 原来都是无声的：断点 12mil 内找不到锚点、
    // 或最近邻岛超过 MAX_GAP(150) 时直接跳过 —— 日志里既不算失败也不算跳过，
    // 于是"缝合没帮上忙"和"缝合压根没试"在文件层面完全一样。
    // 实测依据：conn-rca 复核 118 份日志，39 次"路由自报全连通"里有 6 次最终仍报断连；
    // 过去无法回答"stitch 到底跳过了多少处"。每轮清零，随 stitchRound 一起记。
    let skipNoAnchor = 0, skipTooFar = 0;
    const walk = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.errorType === 'Connection Error') broken.push(n);
      if (n.list) walk(n.list);
    };
    walk(details);
    // 【用本轮「本来就要跑」的这次 DRC 反查上一轮缝合线造出来的异网短路】
    // 依据见 stitchCount 处。位置必须在这里（`!broken.length` 的 break 之前），
    // 否则最后一轮造的线永远得不到检查。
    if (stitchedIds.size) {
      const clearNow = [];
      const walkClear = (n) => {
        if (!n) return;
        if (Array.isArray(n)) { n.forEach(walkClear); return; }
        if (n.errorType === 'Clearance Error') clearNow.push(n);
        if (n.list) walkClear(n.list);
      };
      walkClear(details);
      // 只统计「我自己画的线」参与的违规，并逐条判定对方是同网还是异网。
      const hit = new Map();   // 缝合线 id -> { n, crossNet, unknown, nets:Set }
      for (const v of clearNow) {
        const ed = v.explanation?.errData || {};
        const sides = [
          { ty: ed.obj1Type, id: objIdOf(ed.obj1) || objIdOf(v.obj1) },
          { ty: ed.obj2Type, id: objIdOf(ed.obj2) || objIdOf(v.obj2) },
        ];
        for (let i = 0; i < 2; i++) {
          const mine = sides[i], other = sides[1 - i];
          if (!mine.id || !stitchedIds.has(mine.id)) continue;
          const rec = hit.get(mine.id) || { n: 0, crossNet: false, unknown: 0, nets: new Set() };
          rec.n++;
          const myNet = stitchNetById.get(mine.id) || null;
          const o = await readSide(other.ty, other.id);
          const otherNet = o && o.net ? o.net : null;
          // 只有两侧都读到网络才敢判异网；读不到就记 unknown，不当成异网。
          if (otherNet && myNet) {
            rec.nets.add(otherNet);
            if (otherNet !== myNet) rec.crossNet = true;
          } else rec.unknown++;
          hit.set(mine.id, rec);
        }
      }
      for (const [sid, rec] of hit) {
        // 【同网不删】这块板的 DRC 确实会报同网自间距（语料里 Track↔SMD Pad cur=0 出现 49 次），
        // 而缝合线的本职就是贴着同网铜把两个孤岛连起来 —— 同网接触不是缺陷，删了就是白断。
        // 两侧网络读不到时（unknown>0 且未确认异网）也保留：不知道 ≠ 不同网，
        // 而误删不可逆（drawn 已占位，本轮不会再画同一条）。
        if (!rec.crossNet) {
          stitchKeptCount++;
          log('stitchKept', { id: String(sid), violations: rec.n, nets: [...rec.nets],
            unknown: rec.unknown,
            why: '违规对方是同网（或网络不可读）⇒ 这是缝合线本职的贴合，不删' });
          continue;
        }
        let delOk = false;
        try { delOk = (await eda.pcb_PrimitiveLine.delete(sid)) === true; }
        catch (e) { log('stitchRevertErr', { id: String(sid), err: String(e && e.message).slice(0, 120) }); }
        if (delOk) { stitchedIds.delete(sid); stitchCount--; stitchRevertCount++; }
        log('stitchReverted', {
          id: String(sid), violations: rec.n, crossNets: [...rec.nets], deleted: delOk,
          // delete 失败是 resolve(false)，不抛 —— 必须判 === true，否则「没删掉」会被记成
          // 「删掉了」，而那条线还在板上继续短路。
          why: '这条缝合线把两个不同网络接到一起（cur 可能为 0 = 铜直接相接）。删掉它，代价是该网重新断开 —— 断路可修，短路会烧板',
        });
      }
    }
    if (!broken.length) { log('stitchDone', { round, remaining: 0 }); break; }

    let fixed = 0;
    for (const v of broken) {
      if (fixed >= 6) break;
      const ed = v.explanation?.errData || {};
      // DRC 坐标 = 真实坐标 / 10
      const px = Number(ed.position?.x) * 10, py = Number(ed.position?.y) * 10;
      const net = String(v.net || ed.net || '').toUpperCase();
      const layers = Array.isArray(ed.layerIds) && ed.layerIds.length ? ed.layerIds : [1];
      if (!net || !Number.isFinite(px) || !Number.isFinite(py)) continue;
      const all = anchorsByNet.get(net) || [];

      for (const layer of layers) {
        const pool = all.filter(a => a.layer === layer);
        if (pool.length < 2) continue;
        const islands = buildIslands(pool);
        if (islands.length < 2) continue;

        // 断点落在哪个孤岛（取岛内最近锚点）
        let myIsland = -1, myD = Infinity, myAnchor = null;
        islands.forEach((idx, gi) => {
          for (const i of idx) {
            const d = Math.hypot(pool[i].x - px, pool[i].y - py);
            if (d < myD) { myD = d; myIsland = gi; myAnchor = pool[i]; }
          }
        });
        if (myIsland < 0 || myD > 12) { skipNoAnchor++; continue; }

        // 从别的孤岛里找离 myAnchor 最近的点
        let other = null, otherD = Infinity;
        islands.forEach((idx, gi) => {
          if (gi === myIsland) return;
          for (const i of idx) {
            const d = Math.hypot(pool[i].x - myAnchor.x, pool[i].y - myAnchor.y);
            if (d < otherD) { otherD = d; other = pool[i]; }
          }
        });
        if (!other || otherD > MAX_GAP) { if (other) skipTooFar++; else skipNoAnchor++; continue; }

        const k = segKey(net, layer, myAnchor.x, myAnchor.y, other.x, other.y);
        if (drawn.has(k)) { dupStitch++; continue; }   // 这段画过了，别再重画
        drawn.add(k);
        try {
          const m = await eda.pcb_PrimitiveLine.create(net, layer,
            myAnchor.x, myAnchor.y, other.x, other.y, STITCH_W);
          // create 的返回类型是 `Promise<IPCB_PrimitiveLine|undefined>`，失败时不抛异常、
          // 只返回 undefined。旧代码不看返回值，直接 stitchCount++ / fixed++，
          // 于是"补了 N 条"全是虚报，而断点一处没修（还会因为 drawn 已占位不再重试）。
          // 不重复画是 d10 的教训（同一段画了 6 轮、堆 6 条重合铜皮），
          // 所以这里**保留** drawn 占位，但绝不把它记成成功。
          const mId = m?.getState_PrimitiveId?.();
          if (!mId) {
            log('stitchNoObj', { net, layer, gap: Math.round(otherD),
              // create 失败时 resolve(undefined) 而不抛。只知道"差多少"、
              // 不知道"想画在哪"，等于无法复查这一段为什么没成。
              from: [Math.round(myAnchor.x), Math.round(myAnchor.y)],
              to: [Math.round(other.x), Math.round(other.y)] });
            continue;
          }
          stitchCount++; fixed++;
          // 供下一轮按权威归属反查异网短路（见 stitchCount 处）。必须在这里记：
          // 拿到 mId 之后、任何 continue/break 之前。
          stitchedIds.add(String(mId));
          stitchNetById.set(String(mId), String(net || '').toUpperCase());
          log('stitch', { net, layer, gap: Math.round(otherD), islands: islands.length,
            // ★ 补线的 primitive id。没有它，事后拿到一条 `SMD Pad to Track` 违规时，
            //   无法判断那条 Track 是布线器画的还是本函数补的 —— 于是
            //   "缝合有没有制造间距违规" 这个问题从来没被测量过。
            id: String(mId),
            from: [Math.round(myAnchor.x), Math.round(myAnchor.y)],
            to: [Math.round(other.x), Math.round(other.y)] });
        } catch (e) { log('stitchErr', String(e && e.message).slice(0, 120)); }
        break;   // 每个断点只补一层
      }
    }
    log('stitchRound', { round, broken: broken.length, fixed, dupSkipped: dupStitch, skippedNoAnchor: skipNoAnchor, skippedTooFar: skipTooFar });
    if (!fixed) break;
    try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
    await sleep(700);
  }
  // 【stitchedTotal 的语义】原含义是「建了几条」，现在是「**还在板上**几条」——
  // 被异网复检删掉的不计入（它们既没连上也没留下铜）。scripts/inspect-run.js 读这个数，
  // 所以形状保持数字不变，只把含义收窄，并配一份分解账，让「建了几条 / 撤了几条 /
  // 判为同网保留几条 / 还剩几条」四件事同时可读，不再互相顶替。
  log('stitchedTotal', stitchCount);
  log('stitchRevertTotal', { created: stitchCount + stitchRevertCount, reverted: stitchRevertCount,
    kept: stitchKeptCount, onBoard: stitchCount });
} catch (e) { errors.push('stitchGaps: ' + (e && e.message)); }
await sleep(1000);
try { if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
await eda.pcb_Document.save();
await sleep(1200);

// DRC 报 Clearance Error 时：先缩窄/缩过孔，仍冲突再绕行。
await shot('pcb-stitched');
phase('fixClearance');
let clearanceFixes = 0;
// 轮数不能写死成 3：修一处违规要**两轮**——第一轮只能缩窄（无损），
// 缩到最小仍违规，第二轮才走绕行。所以 7 处违规至少需要 6 轮。
// 实测 d12：`for round < 3` 在第 3 轮把 7 处违规留在板上就静默退出，
// 日志里只有 clearanceRound 0/1/2，看不出"是被轮数卡住"还是"修不动"。
// 现在给到 8 轮，并且真正的终止条件是"这一轮一处也没修成"（no progress）。
const MAX_CLEAR_ROUNDS = 8;
// 【越修越糟】守卫：实测 d13 的违规数是 6 → 6 → 17。绕行把一条线变成三条线，
// 在密集区反而制造更多冲突 —— 修得越多越糟。d12 同样只有"缩窄"那几处真实有效。
// 既然无法在每处修改后就重跑 DRC（太慢），就用**下一轮的开局 DRC 结果当裁判**：
// 违规数比上一轮多，说明上一轮是净损失，整轮回滚，然后停在最好的状态。
// 不回滚的代价是：本可停在 6 处违规的板子，被修成 17 处，连"接近通过"都不是。
let prevClearCount = null;
// 【断路与间距是两种货币，而且断路贵得多】回滚判据原先只比 clearance 条数。
// 实测 2026-11-26 01:24（gen-rp2040 / smart-fit）：本轮 7 条 clearance → 下轮 0 条，
// 判据认为"大幅改善"，于是不回滚；可这一轮里 viaDeleted 删掉了一个 GND 过孔，
// GND 因此断路，DRC 多了 2 条 Connection Error。总数从 7 降到 2，
// 用同一杆秤称就是"变好了"——**而其中两条是不可逆的断路**。
// 断路必须单独计数、单独触发回滚：间距违规还能下一轮继续修（或换板框重来），
// 断路是板上已经缺了一段铜。所以这里记一个独立的数。
let prevConnCount = null;
// 【无进展即停】上面三条出口（预算/清零/零动作）都拦不住"每轮都改成功、违规数不动"：
// 实测 d13 的 clearanceRound 是 4,4,3,3,3,3,3,3、fixed 是 4,3,3,3,3,3,3,3 —— 六轮
// 都在"修"，违规数一格没降，白烧 34s。根因是 fixed 只数"变更 API 接受了"，
// 与"这处间距真的变好了"完全脱钩（同一病根的另一半：动作后从不回读复测）。
// 所以用**违规数连续不降**当裁判，不问动作成功与否。两轮不降就停，把时间让给下一处。
let noProgressRounds = 0;
let lastClearCount = null;
// 回滚时如果不把上一轮记入的 fixed 一起退掉，clearanceFixes 会虚高：
// 日志读起来像"修了 14 处"，实际板上是回滚后的 6 处状态。
// 离线统计正是靠这个数下结论，虚高会直接误导策略判断。
let prevFixed = 0;
let roundMods = [];
let roundCreated = [];
// 【回滚失败必须可见】`modify(id, orig)` 失败时 resolve(undefined) 而不抛，那条线就停在
// 被截短的中间态：既没还原成原样，也没被删掉，成了板上一段悬空铜皮。
// 实测 d13（out\AI_传感器___充电___显示_19pia69-20261125-234319\_log-2-expand-1.25x.json）：
//   #71 clearanceReverted{deleted:2,restored:0,from:1,to:2}
//   #72 clearanceRevertLineRestoreFail{ids:["0e07a2ed4c87420a"]}
//   #90 clearDiag{at:[1356,-534],cur:0,need:4.0157}  #92 connDiag{同网 3V3, w:6.5, layer:2}
// 即：**回滚失败本身就让板的违规数变差**（1→2），而 computeOK() 对它完全不可见 ——
// fixClearance 整段 18 处 errors.push 一个都不在，唯一可能被"看见"的通道是下一轮 DRC 的偶然命中。
// 语义与 pourRebuildOk 一致（三态）：null = 本次没有回滚尝试（**不能读成通过**）
//   / true = 尝试过且全部还原 / false = 有铜留在中间态。
let clearanceRevertOk = null;
const danglingLines = new Set();   // 回滚失败后被留在板上的铜 id（本轮之后只读，供落盘与统计）
// kind 决定回滚时该调哪个 API：Line 靠 modify 改回尺寸/端点；Via 只能靠
// pcb_PrimitiveVia.modify({holeDiameter, diameter}) 改回原孔径/外径 —— create 会造出
// 一个**新 id**，等于换掉这个过孔，不算恢复；被删掉的 Via 没有任何 API 能复活。
// 旧记录只有 {id, lineWidth|endX/endY}，回滚循环一律按 Line 处理，
// 于是 via 的缩/删从来没进回滚清单，日志里的"已回滚"与板上状态脱钩。
const recMod = (id, orig) => {
  if (!id) return;
  const kind = (orig && orig.kind) || 'line';
  if (!roundMods.some(m => m.id === String(id))) roundMods.push({ id: String(id), kind, ...orig });
};
const recNew = (obj) => {
  try { const pid = obj && obj.getState_PrimitiveId && obj.getState_PrimitiveId(); if (pid) roundCreated.push(String(pid)); } catch (e) { }
};

// 绕行失败后的回滚：逐项核对每一步，不同成因用不同日志键。
// 旧实现把两次调用分别 `catch (e) { }` 吞掉：删不掉的新增铜留在板上变成悬空短线
// （自己还会触发新的间距违规），改不回的端点留下断头线（断网）；
// 而日志只有一句 trackDoglegRolledBack / trackRerouteRolledBack，与真正
// 回滚成功长得一模一样，离线统计会据此认为"绕行失败没留后遗症"。
// 不用 get() 复检删除结果：本节开头记的坑是 get() 对已不存在的 id 会抛
// 'primitiveId' TypeError，与"读不出"同一表现，拿它判定"已删"同样是猜。
//
// ★ 上面那段注释只解决了"不要用 get() 猜"，**没解决"失败了也看不出来"**：
//   `delete` → `Promise<boolean>`，失败时 resolve **false 而不抛**
//   `modify` → `Promise<IPCB_PrimitiveLine|undefined>`，失败时 resolve **undefined 而不抛**
//   （api-types.d.ts 的 delete 注释即 `@returns 删除操作是否成功`）。
//   原代码只在"抛异常"时才记失败，于是**回滚失败与回滚成功走同一行 rollbackOk** ——
//   而 rollbackOk 正是离线统计里"这次绕行没留后遗症"的唯一凭据。
//   返回值本身就是权威凭据，不需要猜，也不需要 get() 复检。
const rollbackLineFix = async (where, trackId, net, made, ex, ey) => {
  const lineFail = [];
  for (const id of made.slice().reverse()) {
    try {
      if ((await eda.pcb_PrimitiveLine.delete(id)) !== true) lineFail.push(String(id));
    } catch (e) { lineFail.push(String(id)); }
  }
  let modifyFail = null;
  try {
    if ((await eda.pcb_PrimitiveLine.modify(trackId, { endX: ex, endY: ey })) === undefined) {
      modifyFail = 'modify 返回 undefined（端点未写回）';
    }
  } catch (e) { modifyFail = String(e && e.message).slice(0, 100); }
  // 这条路径与轮末的 clearanceRevert* 是**同一病灶的两处**：modify 失败同样只打日志、
  // 同样把铜留在截短的中间态。只喂轮末那处会让 dogleg/L 形绕行的失败完全隐形。
  if (lineFail.length || modifyFail !== null) {
    for (const id of lineFail) danglingLines.add(String(id));   // 没删掉的多余铜
    if (modifyFail !== null) danglingLines.add(String(trackId)); // 被截短的悬空线
    clearanceRevertOk = false;
  }
  if (lineFail.length) log('rollbackLineFail', { where, line: trackId, net, made: made.length, n: lineFail.length, ids: lineFail });
  if (modifyFail !== null) log('rollbackModifyFail', { where, line: trackId, net, m: modifyFail });
  if (!lineFail.length && modifyFail === null) log('rollbackOk', { where, line: trackId, net, made: made.length });
};

// ---------- fixClearance 的障碍物真实几何（P0）----------
// 取证见 scripts/ROOTCAUSE-large-chip.md §2 F3、日志 logs/<name>-*.json：
//   旧实现只按 `pcb_PrimitivePad.get(obstacleId)` 解析障碍物几何。障碍其实是
//   Track / Slot Region / Hole 时拿不到 pad（Track-Track 时 obstacleId 干脆是 null），
//   于是退化成「违规点 ±max(need/2,4)」的 ~12mil 合成盒并标记 padKind:'UNKNOWN'，
//   走廊与 NEED 全建在假几何上 → 修间距反而把线搬到错误方向：
//   d12 首轮 1 处违规被"修"成 7 处、d13 6 处变 17 处，d12 的 VBUS 被搬上 GND 轨迹。
//   指纹：trackRerouted 里 padKind:"UNKNOWN" 在 d12/d13 占 100%。
//
// 现在的判据：**先确认 id 属于哪一类图元，再只对确认归属的类调 get()**；拿到真实
// 几何后按"到线段的距离 ≤ 线宽/2 + 间距"（Track）/ 圆心±半径（Via、Hole）/ 轮廓
// （Slot Region、Pad）判定走廊。任何一步取不到 → **不做 corridor 改道**，记
// clearanceSkipNoGeo 并放弃这一处（宁可留 1 处违规，也不制造 7 处）。
//
// 读取器来源（不靠猜）：
//   - api/methods.csv（本机从 EDA API 文档导出的索引）：PCB_PrimitiveLine / Via /
//     Pad / Region / Fill / Polyline 都存在 get 与 getAllPrimitiveId（状态 beta）。
//   - 本文件既有用法已证实可读：snapEnds L993-999 用 pcb_PrimitiveLine.get(id) +
//     getState_StartX/StartY/EndX/EndY/Net 吸附端点（日志 snappedLines 有计数）；
//     L1291 用 pcb_PrimitiveVia.get + getState_Diameter/HoleDiameter（日志 viaShrunk
//     能读到 from:[12,24]）；L705 与 `_outline.js` 用 getState_Polygon().getSource()
//     读轮廓（返回值形如 ['R',x,y,w,h,0,0]）。
//   - 坑：get() 对**已不存在/已被改写的 id** 会抛 "Cannot read properties of
//     undefined (reading 'primitiveId')"（L1396-1399 已记录）。所以每一处读取都
//     单独 try/catch，抛异常一律当"取不到几何"，不向上传播、不阻断整轮。
const geoPtSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const geoOrient = (ax, ay, bx, by, cx, cy) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
const geoSegCross = (ax, ay, bx, by, cx, cy, dx, dy) => {
  const o1 = geoOrient(ax, ay, bx, by, cx, cy);
  const o2 = geoOrient(ax, ay, bx, by, dx, dy);
  const o3 = geoOrient(cx, cy, dx, dy, ax, ay);
  const o4 = geoOrient(cx, cy, dx, dy, bx, by);
  return o1 * o2 < 0 && o3 * o4 < 0;
};
// 线段 ↔ 多边形 距离；相交或整条落在多边形内部 → 0
const geoDistSegPoly = (ax, ay, bx, by, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (geoSegCross(ax, ay, bx, by, xj, yj, xi, yi)) return 0;
    if ((yi > ay) !== (yj > ay)) {
      const xc = xj + ((ay - yj) * (xi - xj)) / ((yi - yj) || 1e-12);
      if (ax < xc) inside = !inside;
    }
  }
  if (inside) return 0;
  let m = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    m = Math.min(m, geoPtSeg(pts[i][0], pts[i][1], ax, ay, bx, by));
    m = Math.min(m, geoPtSeg(ax, ay, pts[i][0], pts[i][1], pts[j][0], pts[j][1]));
    m = Math.min(m, geoPtSeg(bx, by, pts[i][0], pts[i][1], pts[j][0], pts[j][1]));
  }
  return m;
};
// 线段 ↔ 障碍物 距离（mil）。这是"走廊安不安全"的唯一判据：
//   seg    → 先算中心线间距，再扣掉障碍物线宽的一半 → 正是"到线段的距离 ≤ 线宽/2 + 间距"；
//   circle → 圆心距 − 半径（Via 用外径/2，Hole 用孔径/2）；
//   poly   → 轮廓距离（Slot Region / Pad bbox）。
const geoDistSeg = (shape, ax, ay, bx, by) => {
  if (!shape) return Infinity;
  if (shape.kind === 'circle') {
    const d = geoPtSeg(shape.cx, shape.cy, ax, ay, bx, by) - shape.r;
    return d > 0 ? d : 0;
  }
  if (shape.kind === 'seg') {
    if (geoSegCross(ax, ay, bx, by, shape.x1, shape.y1, shape.x2, shape.y2)) return 0;
    let m = Math.min(
      geoPtSeg(ax, ay, shape.x1, shape.y1, shape.x2, shape.y2),
      geoPtSeg(bx, by, shape.x1, shape.y1, shape.x2, shape.y2),
      geoPtSeg(shape.x1, shape.y1, ax, ay, bx, by),
      geoPtSeg(shape.x2, shape.y2, ax, ay, bx, by));
    m -= (Number(shape.w) || 0) / 2;
    return m > 0 ? m : 0;
  }
  if (shape.kind === 'poly' && shape.pts && shape.pts.length >= 3) return geoDistSegPoly(ax, ay, bx, by, shape.pts);
  return Infinity;
};
const geoBBox = (shape) => {
  if (!shape) return null;
  if (shape.kind === 'circle') {
    return [shape.cx - shape.r, shape.cy - shape.r, shape.cx + shape.r, shape.cy + shape.r];
  }
  if (shape.kind === 'seg') {
    const hw = (Number(shape.w) || 0) / 2;
    return [Math.min(shape.x1, shape.x2) - hw, Math.min(shape.y1, shape.y2) - hw,
      Math.max(shape.x1, shape.x2) + hw, Math.max(shape.y1, shape.y2) + hw];
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of shape.pts || []) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
};
// 点表形式（`format-types` schema 原文：首两个数字是**起点**，之后是「指令名 + 参数」重复）。
// 只解析语义确定的 `L`（直线到点）。遇到 ARC/CARC/C 等曲线指令**直接放弃**：若只取曲线
// 端点，连出来的折线会**小于**真实轮廓，等于把禁布区算小 —— 那比拿不到几何更危险，
// 因为"算小了"会放行一条压线的走廊，而"拿不到"只是退回 bbox 保守兜底。
const geoPolyFromPointTable = (src) => {
  if (typeof src[0] !== 'number' || typeof src[1] !== 'number') return null;
  const x0 = Number(src[0]), y0 = Number(src[1]);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  const pts = [[x0, y0]];
  let i = 2;
  while (i < src.length) {
    const op = String(src[i] || '').toUpperCase();
    if (op !== 'L') return null;
    const x = Number(src[i + 1]), y = Number(src[i + 2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push([x, y]);
    i += 3;
  }
  return pts.length >= 3 ? pts : null;
};
// pcb_MathPolygon.getSource() 实证过的形式：矩形 ['R',x,y,w,h,...]（建铺铜/板框都用这个）。
// 另外补上点表与 CIRCLE；其余形式仍返回 null，绝不凭想象解析。
const geoPolyFromSource = (src) => {
  if (!Array.isArray(src)) return null;
  const head = String(src[0] || '').toUpperCase();
  if (head === 'R') {
    const x = Number(src[1]), y = Number(src[2]), w = Number(src[3]), h = Number(src[4]);
    if (![x, y, w, h].every(Number.isFinite) || w === 0 || h === 0) return null;
    return { kind: 'poly', pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] };
  }
  let ns = null;
  if (head === 'CIRCLE') {
    const cx = Number(src[1]), cy = Number(src[2]), r = Number(src[3]);
    if (![cx, cy, r].every(Number.isFinite) || r <= 0) return null;
    // 用 64 边形近似圆：geoDistSeg 对 poly 算的是轮廓距离，64 段误差 < 0.12%r
    // （r=50 时 <0.06mil），远小于 1mil 的设计余量，且不必引入新的 shape 类型。
    ns = [];
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2;
      ns.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return { kind: 'poly', pts: ns };
  }
  ns = geoPolyFromPointTable(src);
  return ns ? { kind: 'poly', pts: ns } : null;
};
// 从 IPCB_Polygon 取轮廓点。**discretize() 是唯一能统一处理 R/CIRCLE/L/ARC 的读法**：
// 它按弧长采样，圆弧也变成真实点；而 getSource() 的曲线形式本仓库没有取证。
// 取不到就返回 null（交给上层退回 bbox 或放弃），**绝不**合成几何。
const geoPolyFromPolygon = (pol, tag) => {
  if (!pol || typeof pol !== 'object') return null;
  if (typeof pol.discretize === 'function') {
    let d = null;
    try { d = pol.discretize({ step: 5 }); }
    catch (e) { log('geoDiscretizeErr', { tag: String(tag || ''), err: String((e && e.message) || e).slice(0, 60) }); }
    if (Array.isArray(d) && d.length >= 3) {
      const pts = [];
      for (const pt of d) {
        const x = Number(pt && pt.x), y = Number(pt && pt.y);
        if (Number.isFinite(x) && Number.isFinite(y)) pts.push([x, y]);
      }
      if (pts.length >= 3) return { kind: 'poly', pts };
    }
  }
  let src = null;
  try { src = pol.getSource?.(); } catch (e) { src = null; }
  return geoPolyFromSource(src);
};
// 图元 id → 所属类。每轮惰性建一次（只读 id 列表，6 次调用，不逐条 get）。
// 不靠 id 长相猜类型：Track/Via/Pad 的 id 都是 16 位 hex，实测 Slot Region 是 20 位，
// 只有"这是不是该类的 id"才是可靠判据。
// 【19 位 id = 父图元 id + 子元素序号】实测 d13 的 DRC 把 Slot Region 报成
// fb25ebec4ca8c8c8e17 / b7a0f094c2d072cee16 这种 19 位串，对 16 位的
// getAllPrimitiveId 集合永远查不到，于是每次都掉进 universalGeo 用 bbox 冒充轮廓。
// 这个日志位只用于"前缀命中/未命中"各记一条，不参与判定。
let geoPrefixLogged = false;
let geoIdx = null;
// 已经成功取到过一次真实轮廓的 owner 集合 —— 只用来把 geoOwnerOk 日志压到每类一条，
// 否则一次运行几百条会把真正有用的信息埋掉。不参与任何判定。
const geoOwnerOk = new Set();
const ensureGeoIdx = async () => {
  if (geoIdx) return geoIdx;
  const sets = {
    pad: new Set(), line: new Set(), via: new Set(),
    region: new Set(), polyline: new Set(),
    // 【fill 与 pour 不是同一个东西，两个都要】实测 2026-11-26T17:23 run 171654：
    //   pcb_PrimitiveFill.getAllPrimitiveId(L) 对 L∈{1,2,12,15,16,17} 全部返回 0 条，
    //   而 pouredCount = 2（pcb_PrimitivePoured 真返回 2 条）。
    // 只索引 fill 的后果：板上有 2 块实铜，几何索引里一块都没有，
    // 于是 resolveByOwner 里那个 `owner === 'pour'` 分支永远不可达 ——
    // 写好了的代码配一个永远为空的集合，等于死代码，而读起来是对的。
    fill: new Set(), pour: new Set(), poured: new Set(),
  };
  const errs = [];
  const load = async (key, api) => {
    try {
      const ids = await api.getAllPrimitiveId();
      if (Array.isArray(ids)) for (const id of ids) sets[key].add(String(id));
    } catch (e) { errs.push(key + ':' + String(e && e.message).slice(0, 50)); }
  };
  await load('pad', eda.pcb_PrimitivePad);
  await load('line', eda.pcb_PrimitiveLine);
  await load('via', eda.pcb_PrimitiveVia);
  await load('region', eda.pcb_PrimitiveRegion);
  await load('polyline', eda.pcb_PrimitivePolyline);
  await load('fill', eda.pcb_PrimitiveFill);
  await load('pour', eda.pcb_PrimitivePour);
  await load('poured', eda.pcb_PrimitivePoured);
  if (errs.length) log('geoIndexErr', { errs });
  geoIdx = sets;
  return sets;
};
// 按"已确认的归属类"取真实几何；取不到返回 null —— **绝不**返回合成盒。
const resolveByOwner = async (owner, id, obType) => {
  const t = String(obType || '').toLowerCase();
  if (owner === 'line') {
    const l = await eda.pcb_PrimitiveLine.get(id);
    if (!l) return null;
    const w = Number(l.getState_LineWidth?.() ?? l.getState_Width?.() ?? 0) || 6.5;
    const x1 = Number(l.getState_StartX()), y1 = Number(l.getState_StartY());
    const x2 = Number(l.getState_EndX()), y2 = Number(l.getState_EndY());
    if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
    return { kind: 'seg', x1, y1, x2, y2, w, owner, padKind: 'TRACK' };
  }
  if (owner === 'via') {
    const vv = await eda.pcb_PrimitiveVia.get(id);
    if (!vv) return null;
    const cx = Number(vv.getState_X?.()), cy = Number(vv.getState_Y?.());
    const dia = Number(vv.getState_Diameter?.() || 0);
    const hole = Number(vv.getState_HoleDiameter?.() || 0);
    // "Hole to X" 量的是孔径，"Via to X" 量的是外径；两者都是真实读数。
    const r = (/hole/.test(t) ? (hole || dia) : (dia || hole)) / 2;
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !(r > 0)) return null;
    return { kind: 'circle', cx, cy, r, owner, padKind: /hole/.test(t) ? 'HOLE' : 'VIA' };
  }
  if (owner === 'pad') {
    const pad = await eda.pcb_PrimitivePad.get(id);
    if (!pad) return null;
    const raw = pad.getState_Pad?.();
    const pk = Array.isArray(raw) ? String(raw[0] || '').toUpperCase() : '';
    const px = Number(pad.getState_X?.() ?? NaN);
    const py = Number(pad.getState_Y?.() ?? NaN);
    const rot = Number(pad.getState_Rotation?.() || 0);
    let box = null;
    if (Array.isArray(raw) && (pk === 'POLYGON' || pk === 'POLY')) {
      // POLYGON → ['POLYGON', [x,y,'L',x,y,...]]；顶点是画布绝对坐标
      const vidx = raw[1];
      if (Array.isArray(vidx)) {
        const vx = [], vy = [];
        for (let i = 0; i < vidx.length - 1; i++) {
          if (typeof vidx[i] === 'number' && typeof vidx[i + 1] === 'number') {
            vx.push(vidx[i]); vy.push(vidx[i + 1]);
          }
        }
        if (vx.length >= 3) {
          box = [Math.min(...vx), Math.min(...vy), Math.max(...vx), Math.max(...vy)];
        }
      }
    } else if (Array.isArray(raw) && (pk === 'RECT' || pk === 'OVAL' || pk === 'ROUND')) {
      // RECT/OVAL/ROUND → ['RECT', w, h, rot]；w/h 是**未旋转**尺寸
      const pw = Number(raw[1]), ph = Number(raw[2]);
      if (Number.isFinite(pw) && Number.isFinite(ph)
          && Number.isFinite(px) && Number.isFinite(py)) {
        const rad = (rot * Math.PI) / 180;
        const ac = Math.abs(Math.cos(rad)), as = Math.abs(Math.sin(rad));
        const bw = pw * ac + ph * as;
        const bh = pw * as + ph * ac;
        box = [px - bw / 2, py - bh / 2, px + bw / 2, py + bh / 2];
      }
    }
    if (!box) return null;
    // 焊盘用外接矩形当轮廓：bbox ⊇ 真实焊盘铜，走廊只会更远不会更近（保守方向安全）
    return {
      kind: 'poly', owner, padKind: pk || 'PAD',
      pts: [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]],
    };
  }
  if (owner === 'region' || owner === 'polyline' || owner === 'fill'
    || owner === 'pour' || owner === 'poured') {
    const api = owner === 'region' ? eda.pcb_PrimitiveRegion
      : owner === 'polyline' ? eda.pcb_PrimitivePolyline
        : owner === 'fill' ? eda.pcb_PrimitiveFill
          : owner === 'pour' ? eda.pcb_PrimitivePour
            : eda.pcb_PrimitivePoured;
    const obj = await api.get(id);
    // 【必须按类选访问器 —— 四个类的几何访问器不是同一个名字】api-types.d.ts 实证：
    //   Region  → getState_ComplexPolygon()  L19652
    //   Fill    → getState_ComplexPolygon()  L21136
    //   Pour    → getState_ComplexPolygon()  L20298
    //   Polyline→ getState_Polygon()         L21736  ← 只有它有这一个
    // 旧实现对所有 owner 一律调 getState_Polygon()，于是 Slot Region **永远**拿不到轮廓：
    // 实测 d13 的 geoUnparsedSrc 全是 owner:"region"/"polyline" + hasPoly:"undefined"，
    // 只能退回 getPrimitivesBBox 的 100×99 方盒去算绕行位置，而真实槽形不是那个盒子。
    // 两个都试而不是按 owner 写死：复合 id（父图元 id + 子 id 直接拼接）的归属由
    // getAllPrimitiveId 的 id 列表决定，实测同一 id 会同时出现在多个类的索引里，
    // "哪个 get() 返回了对象"不能证明归属（get 不校验归属，只返回壳）。
    let pol = null;
    const tryAcc = (accName) => {
      try {
        const fn = obj ? obj[accName] : null;
        return typeof fn === 'function' ? fn.call(obj) : null;
      } catch (e) {
        log('geoAccessorErr', { objId: id, owner, acc: accName, err: String((e && e.message) || e).slice(0, 60) });
        return null;
      }
    };
    pol = tryAcc('getState_ComplexPolygon') || tryAcc('getState_Polygon');
    const poly = geoPolyFromPolygon(pol, owner + ':' + id);
    if (poly) {
      // 每个 owner 只记第一条，既证明"真实多边形确实取到了"，又不把日志灌满
      if (!geoOwnerOk.has(owner)) {
        geoOwnerOk.add(owner);
        log('geoOwnerOk', { objId: id, owner, pts: poly.pts.length,
          acc: typeof (pol && pol.getSource) === 'function' ? 'polygon' : 'unknown' });
      }
      return { ...poly, owner, padKind: owner.toUpperCase() };
    }
    // 【区分三种"取不到"】旧日志只记 head，下面三种情况全都长成 head:"undefined"：
    //   (a) 对象根本不属于这个类 —— get(id) 返回 null（id 属于另一个图元类，
    //       实测 d13 的 Slot Region 是 20 位 hex，region/polyline/fill 三类索引里都查不到）
    //   (b) 类是对的，但没有该几何访问器（或返回的 polygon 对象是空壳）
    //   (c) 有 polygon 对象，但 getSource() 返回 undefined/曲线形式，discretize 也失败
    // 三者该补的代码完全不同，日志不区分就只能靠猜，下一次还是同样的失败。
    const src = (() => { try { return pol && pol.getSource ? pol.getSource() : null; } catch (e) { return null; } })();
    // ★ 19 位复合 id（父图元 id + 子元素序号）取到的往往是**空壳对象**：能拿到对象
    //   （got:true）但一个几何访问器都没有（hasCplx/hasPoly/hasDisc 全 "undefined"，
    //   polKeys:null）。实测 d13 四次尝试，四条日志全是这个形状。
    //   这里再探一次"截掉尾部子元素序号"的 16 位父图元，把结果写进同一条日志。
    //   【只记录、不改行为】—— 行为改动等这条证据到手再做，否则就是拿猜测去改几何修复。
    let prefixProbe = null;
    try {
      if (id.length > 16) {
        const pfx = id.slice(0, 16);
        const pfxObj = await api.get(pfx);
        let pfxPol = null;
        try {
          const f1 = (pfxObj && typeof pfxObj.getState_ComplexPolygon === 'function')
            ? pfxObj.getState_ComplexPolygon
            : ((pfxObj && typeof pfxObj.getState_Polygon === 'function') ? pfxObj.getState_Polygon : null);
          if (f1) pfxPol = f1.call(pfxObj);
        } catch (e3) { pfxPol = null; }
        const pfxPoly = pfxPol ? geoPolyFromPolygon(pfxPol, 'pfx:' + pfx) : null;
        let pfxBox = null;
        if (pfxPoly && Array.isArray(pfxPoly.pts) && pfxPoly.pts.length) {
          const xs = pfxPoly.pts.map((p) => Number(p[0])).filter((q) => Number.isFinite(q));
          const ys = pfxPoly.pts.map((p) => Number(p[1])).filter((q) => Number.isFinite(q));
          if (xs.length && ys.length) {
            pfxBox = [Math.round(Math.min(...xs)), Math.round(Math.min(...ys)),
              Math.round(Math.max(...xs)), Math.round(Math.max(...ys))];
          }
        }
        prefixProbe = pfxObj ? {
          parentId: pfx,
          got: true,
          hasCplx: typeof pfxObj.getState_ComplexPolygon,
          hasPoly: typeof pfxObj.getState_Polygon,
          pts: (pfxPoly && Array.isArray(pfxPoly.pts)) ? pfxPoly.pts.length : 0,
          box: pfxBox,
          // 【下一步的判据在这里】父图元轮廓必须与这块槽**同量级**才许拿来用。
          //   若父图元是整个封装，它的 box 会比槽大一圈 —— 那就只是换一种假几何，
          //   不是修好了。拿 box 和 DRC 报的位置 / 子元素 bbox 一比就知道。
          keys: Object.keys(pfxObj).slice(0, 10),
        } : { got: false };
      }
    } catch (e) {
      prefixProbe = { err: String((e && e.message) || e).slice(0, 60) };
    }
    log('geoUnparsedSrc', { objId: id, owner, prefixProbe,
      got: !!obj,
      hasCplx: typeof obj?.getState_ComplexPolygon,
      hasPoly: typeof obj?.getState_Polygon,
      hasDisc: typeof pol?.discretize,
      srcKind: Array.isArray(src) ? 'array' : typeof src,
      head: Array.isArray(src) ? String(src[0]) : String(typeof src),
      polyKeys: (pol && typeof pol === 'object') ? Object.keys(pol).slice(0, 12) : null });
    return null;
  }
  return null;
};
// 【通用按 id 取几何】上面 resolveByOwner 走的是"按归属类 get(id)"，而实测有图元
// 不属于任何已索引的类：d13 的 Slot Region（20 位 hex，region/polyline/fill 三类
// get() 全返回 null）。此时**不能**退回合成盒 —— 历史上合成 12mil 小盒、padKind
// 'UNKNOWN' 照样绕行，正是 d12 VBUS 被搬上 GND 轨迹、违规 1→7 的来源。
// 正确出路是让 API 自己回答，而不是靠 id 长相猜：
//   getPrimitiveTypeByPrimitiveId(id) → EPCB_PrimitiveType（权威类型）
//   getPrimitivesBBox([id])           → 真实 bbox，**单位 mil、笛卡尔坐标系**
//     （api-types.d.ts:15137 明确写明；与 getState_StartX 同一口径，可直接比较）
// 拿到真实 bbox 后绕行就是"按真实几何绕行"，与 pad 走外接矩形同一保守方向
// （bbox ⊇ 真实铜，走廊只会更远不会更近）。
// 安全阀：bbox 必须**真的包含违规点**（tol 只吸收 DRC 报点在边界上的取整误差）。
// 不包含就说明这个 id 的盒子跟这处违规无关 —— 宁可放弃这一处，也不用错盒子改道。
// 【槽孔的真实几何能不能读出来】DRC 报的 'Slot Region' 不属于任何已索引图元类，
// 只能落到下面的 bbox 兜底（本文件 L2173 的注释已承认这一点）。
// 但槽孔的真实形状**是可读的**：它是焊盘孔，`getState_Hole()` = ['SLOT', 直径, 长度]（mil），
// 外加 getState_X/Y/Rotation。实测 d13 最后一步的唯一违规就落在兜底路径上：
//   obBBox [967,-1295,1067,-1195]（100x100 mil，是**焊盘**外接盒）
//   而焊盘里的钻孔只有 31.5x59.1 mil（0.8mm x 1.5mm 槽）
// 绕 100x100 的方盒 → 1 处违规变 3 处 → 整轮回滚 → 板子带 1 处违规出厂。
// 这正好解释了为什么 d13 连续两轮都卡在"只差 1 处"。
// 但**几何一改就会动铜**，所以这里只测量：把候选槽孔真实几何与兜底方盒并排打出来，
// 先确认是"绕多了"还是"绕错了方向"，确认之后再决定换不换几何。
let slotPadCache = null;
const slotPadGeometry = async () => {
  if (slotPadCache) return slotPadCache;
  const out = [];
  try {
    for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
      let p = null;
      try { p = await eda.pcb_PrimitivePad.get(id); } catch (e) { continue; }
      let h = null;
      try { h = p?.getState_Hole?.(); } catch (e) { h = null; }
      if (!Array.isArray(h) || String(h[0]).toUpperCase() !== 'SLOT') continue;
      const d = Number(h[1]), len = Number(h[2]);
      const x = Number(p.getState_X?.()), y = Number(p.getState_Y?.());
      const rot = Number(p.getState_Rotation?.()) || 0;
      if (![d, len, x, y].every(Number.isFinite)) continue;
      // 槽孔只有两个朝向：rot 接近 0/180 时长轴沿 X，接近 90/270 时沿 Y。
      const horiz = Math.abs(((rot % 180) + 180) % 180) < 45;
      const hx = horiz ? len / 2 : d / 2, hy = horiz ? d / 2 : len / 2;
      // 焊盘铜的外接盒（孔的环形环 + 盘身）。只取孔会小于 DRC 真正指的铜。
      let padBox = null;
      try {
        const pb = await eda.pcb_Primitive?.getPrimitivesBBox?.([String(id)]);
        if (pb) {
          const px0 = Number(pb.minX), py0 = Number(pb.minY), px1 = Number(pb.maxX), py1 = Number(pb.maxY);
          if ([px0, py0, px1, py1].every(Number.isFinite) && px1 >= px0 && py1 >= py0) {
            padBox = [px0, py0, px1, py1];
          }
        }
      } catch (e) { padBox = null; }
      out.push({ id: String(id), num: p.getState_PadNumber?.() ?? null,
        net: p.getState_Net?.() ?? null, layer: p.getState_Layer?.() ?? null,
        x, y, rot, d, len, horiz,
        holeBox: [x - hx, y - hy, x + hx, y + hy], padBox });
    }
  } catch (e) { log('slotGeoErr', String(e && e.message).slice(0, 90)); }
  slotPadCache = out;
  return out;
};const universalGeo = async (id, violX, violY, needDist) => {
  const P = eda.pcb_Primitive;
  if (!P || typeof P.getPrimitivesBBox !== 'function') {
    log('uniGeoUnavailable', { hasPrim: !!P });
    return null;
  }
  if (!Number.isFinite(violX) || !Number.isFinite(violY)) return null;
  let type = null;
  try { type = await P.getPrimitiveTypeByPrimitiveId(id); } catch (e) {
    log('uniGeoTypeErr', { id: String(id), m: String(e && e.message).slice(0, 90) });
  }
  let bb = null;
  try { bb = await P.getPrimitivesBBox([id]); } catch (e) {
    log('uniGeoBBoxErr', { id: String(id), m: String(e && e.message).slice(0, 90) });
  }
  if (!bb) { log('uniGeoNoBBox', { id: String(id), type: type === undefined ? null : String(type) }); return null; }
  const x0 = Number(bb.minX), y0 = Number(bb.minY), x1 = Number(bb.maxX), y1 = Number(bb.maxY);
  if (![x0, y0, x1, y1].every(Number.isFinite) || !(x1 >= x0) || !(y1 >= y0)) {
    log('uniGeoBadBox', { id: String(id), box: [x0, y0, x1, y1] });
    return null;
  }
  // 【为什么不能写死 tol】净距违规点到障碍物边缘的距离**按定义就等于要求的净距**：
  // 铜离障碍物 11.81mil 才合规，那违规点就必然在盒子外 ≤11.81mil 处。
  // 实测 2026-11-26T19:21（v4 第 4 次尝试）：U4（MEMS 硅麦 DMM-4026）封装里那个
  // 16.83×16.83mil 的声孔区域，违规点 x=637 而盒子 x0=641.587 —— 只差 0.587mil，
  // 写死的 tol=4 判 contains:false ⇒ 几何当成"拿不到" ⇒ clearanceSkipNoGeo 拒绝绕线。
  // 3 条违规里 2 条栽在这 0.587mil 上（uniGeo contains:false ×2 / true ×1）。
  // 换成"违规点到盒子的真实距离 ≤ needDist + 2"——有物理含义，不是放宽常数：
  //   dist > needDist ⇒ 这盒子解释不了这条违规，仍拒绝（防 d12/d13 那种假盒）
  //   量不到 needDist ⇒ 退回 4mil，与打补丁前逐字节相同
  const distToBox = (px, py) => {
    const dx = px < x0 ? x0 - px : (px > x1 ? px - x1 : 0);
    const dy = py < y0 ? y0 - py : (py > y1 ? py - y1 : 0);
    return Math.hypot(dx, dy);
  };
  const violToBox = distToBox(violX, violY);
  const tol = (Number.isFinite(needDist) && needDist > 0) ? needDist + 2 : 4;
  const contains = violToBox <= tol;
  log('uniGeo', { id: String(id), type: type === undefined ? null : String(type),
    box: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)],
    wh: [Math.round(x1 - x0), Math.round(y1 - y0)],
    viol: [Math.round(violX), Math.round(violY)],
    distToBox: Math.round(violToBox * 100) / 100,
    need: Number.isFinite(needDist) ? Math.round(needDist * 100) / 100 : null,
    tol: Math.round(tol * 100) / 100, contains });
  if (!contains) return null;
  const w = x1 - x0, h = y1 - y0;
  // 退化盒（宽或高为 0）当线段处理没意义，也说明读到的不是面积型障碍物
  if (!(w > 0) && !(h > 0)) return null;
  // 只测量：把"兜底方盒"与"候选槽孔真实钻孔"并排打出来，供决定是否换几何。
  // 不改任何铜、不改返回值 —— 加了这一步之后行为与本条之前完全一致。
  try {
    const slots = await slotPadGeometry();
    if (!slots.length) {
      log('slotGeoCmp', { objId: String(id), slotsTotal: 0,
        note: '板上没有 SLOT 孔，这个兜底方盒与槽孔无关' });
    } else {
      const inBox = (b) => violX >= b[0] - tol && violX <= b[2] + tol && violY >= b[1] - tol && violY <= b[3] + tol;
      const hits = slots.filter(s => inBox(s.holeBox));
      const bx = (x0 + x1) / 2, by = (y0 + y1) / 2;
      const nearest = slots
        .map(s => ({ s, dd: Math.hypot(s.x - bx, s.y - by) }))
        .sort((a, b) => a.dd - b.dd).slice(0, 2)
        .map(o => ({ id: o.s.id, num: o.s.num, net: o.s.net, layer: o.s.layer,
          xy: [Math.round(o.s.x), Math.round(o.s.y)], rot: o.s.rot,
          holeD: o.s.d, holeLen: o.s.len, horiz: o.s.horiz,
          holeBox: o.s.holeBox.map(v => Math.round(v)),
          holeWH: [Math.round(o.s.holeBox[2] - o.s.holeBox[0]), Math.round(o.s.holeBox[3] - o.s.holeBox[1])],
          centerDist: Math.round(o.dd) }));
      // 【父图元解析】19/20 位 id 是「父图元 id(16) + 子元素序号」，只有前 16 位
      // 会出现在 getAllPrimitiveId 索引里。实测 v3 那 10 条 Slot Region 违规全在
      // e9965320fba7ed20e37 上，而它至今是个无名对象 —— ensureGeoIdx() 早就建好了
      // id→类索引，问一句就知道是哪一类。索引本身也可能全是空集（那才是真问题），
      // 所以把每类的大小一起打出来，免得"查不到这个 id"和"索引根本没建成"混成一条。
      let parentId = null, parentOwners = [], idxSizes = null;
      try {
        parentId = String(id).slice(0, 16);
        const gi = await ensureGeoIdx();
        parentOwners = Object.keys(gi).filter(k => gi[k].has(parentId));
        idxSizes = {};
        for (const k of Object.keys(gi)) idxSizes[k] = gi[k].size;
      } catch (_) { }
      log('slotGeoCmp', {
        objId: String(id),
        parentId, parentOwners, idxSizes,
        obBBox: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)],
        obWH: [Math.round(x1 - x0), Math.round(y1 - y0)],
        obCenter: [Math.round(bx), Math.round(by)],
        viol: [Math.round(violX), Math.round(violY)],
        // 这里原本写死 `true`。它是"可证常量的判断字段"：看着像一个结论，其实零信息，
        // 而且比缺字段更糟 —— 缺字段会被当成"没测"，常量会被当成"测过了、是"。
        // 真正有用的是：违规点到底落不落在那个**外接盒**里。
        //   落在里面 ⇒ 距离 0 这句话成立，是"铜真的压在障碍物上"，该去挪铜；
        //   落在外面 ⇒ 这个盒子根本没罩住违规点，用它算出来的距离不可信，
        //               要先怀疑 bbox 的来源，而不是继续按距离决策。
        // 这个区分正是判断 `Slot Region` 该取 16 字符父图元、还是该老实放弃的依据。
        violInFabricatedBox: (violX >= x0 && violX <= x1 && violY >= y0 && violY <= y1),
        violInRealHole: hits.length > 0,
        violInRealHoleOf: hits.map(s => s.num),
        slotsTotal: slots.length,
        nearest,
      });
    }
  } catch (e) { log('slotGeoCmpErr', String(e && e.message).slice(0, 90)); }
  return {
    kind: 'poly', owner: 'universal',
    // 【几何可信度标签】这里的 pts 是**外接盒四个角**，不是真实轮廓。
    // kind 仍必须是 'poly'：geoDistSeg 只认 circle/seg/poly，改成别的会返回 Infinity，
    // 于是所有 `< NEED` 判据恒假 → 静默放行每一条走廊（比现在糟得多）。
    // 但下游必须能分清"真轮廓"和"bbox 冒充的轮廓"：实测 d13/d12 的 3 处
    // Slot Region 全部落在这条路径上（geoUnparsedSrc ×63），"geoKind:'poly'" 字面诚实
    // （确实是四边形）却让人以为几何读到了。所以单独标一个来源位。
    src: 'bbox',
    padKind: String(type === undefined || type === null ? 'OBSTACLE' : type).toUpperCase(),
    pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
  };
};
const resolveObstacle = async (obType, obId, violX, violY, needDist) => {
  const id = obId ? String(obId) : '';
  if (!id) return null;
  const idx = await ensureGeoIdx();
  const owners = [];
  if (idx.line.has(id)) owners.push('line');
  if (idx.via.has(id)) owners.push('via');
  if (idx.pad.has(id)) owners.push('pad');
  if (idx.region.has(id)) owners.push('region');
  if (idx.polyline.has(id)) owners.push('polyline');
  if (idx.fill.has(id)) owners.push('fill');
  // 精确 id 查不到且比 16 位长 → 试一次"截掉尾部子元素序号"的父图元 id。
  // 命中就沿真实父图元的几何走；不命中则 lookupId 保持原值，行为与打补丁前逐字节相同。
  // 只在 owners 为空时执行，所以对 16 位 id（正常 Track/Via/Pad）零影响。
  let lookupId = id;
  try {
    if (!owners.length && id.length > 16) {
      const pfx = id.slice(0, 16);
      const hits = [];
      if (idx.line.has(pfx)) hits.push('line');
      if (idx.via.has(pfx)) hits.push('via');
      if (idx.pad.has(pfx)) hits.push('pad');
      if (idx.region.has(pfx)) hits.push('region');
      if (idx.polyline.has(pfx)) hits.push('polyline');
      if (idx.fill.has(pfx)) hits.push('fill');
      if (hits.length) {
        for (const h of hits) owners.push(h);
        lookupId = pfx;
      }
      if (!geoPrefixLogged) {
        geoPrefixLogged = true;
        log('geoIdPrefix', { drcId: id, parentId: pfx, hits,
          used: hits.length > 0 ? lookupId : null,
          note: hits.length ? '19 位 id 的前 16 位命中真实图元 → 用真几何，不再用 bbox'
            : '前 16 位也不在图元索引里 → 仍走 universalGeo 的 bbox 兜底' });
      }
    }
  } catch (e) {
    // 只是诊断：任何异常都不许影响净空修复主流程（lookupId 保持原值 = 打补丁前行为）。
    try { log('geoIdPrefixErr', String(e && e.message).slice(0, 90)); } catch (_) { }
  }
  if (!owners.length) {
    // 索引里查不到（该类 getAllPrimitiveId 不可用，或对象已被本流程删改）时，
    // 退回"按 DRC 报的类型挑读取器"，仍然只调已证实的 get()。
    const t = String(obType || '').toLowerCase();
    if (/track|line/.test(t)) owners.push('line');
    if (/via|hole/.test(t)) owners.push('via');
    if (/slot|region|edge|outline/.test(t)) owners.push('region', 'polyline', 'fill');
    if (/pad/.test(t)) owners.push('pad');
  }
  for (const owner of owners) {
    try {
      const g = await resolveByOwner(owner, lookupId, obType);
      if (g) return g;
    } catch (e) {
      // 对不存在/已改写的 id，get() 会抛 'primitiveId' TypeError —— 当"取不到"处理
      log('geoGetErr', { objId: id, owner, m: String(e && e.message).slice(0, 100) });
    }
  }
  // ★★ Slot Region：在退回"问 API 要 bbox"之前，先用**真槽孔几何**。
  //   理由不是"更好的兜底"，而是实测证明那个 bbox **不是这个障碍物**：
  //   d12 `_log-3-expand-1.25x-retry.json`，objId `a869159a45be9b29e55`：
  //     geoIdPrefix  {drcId …e55, parentId 前16位 …, hits:[], used:null}
  //                  → 前 16 位也不在图元索引里，拿不到父图元
  //     geoUnparsedSrc owner region/polyline/fill 三个都 got:true 但
  //                  hasCplx/hasPoly/hasDisc 全 "undefined"，pts:0，box:null，keys:[]
  //     uniGeo      box [1168,-1241,1192,-1217] (25×25)  type:null
  //     viol        [1196,-1229]  → 真包含判定为 **false**（1196 > 1192），
  //                  只因为 universalGeo 的 tol=4 才 contains:true；
  //                  同一条违规则若报 [1197,-1229]，contains 立刻变 false，obs 直接为 null。
  //   ⇒ 同一条违规的处理结果取决于 DRC 报点的 1mil 抖动，这是不可接受的。
  //   而真槽孔是**焊盘孔**，`getState_Hole()` 直接给 ['SLOT', 直径, 长度]，
  //   slotPadGeometry() 已经把板上所有 SLOT 孔的 d/len/x/y/rot 都读出来了。
  //   所以：按「违规点到槽孔矩形」的真实距离挑最近的那一个，只在足够近时才认领。
  //   门槛 20mil：DRC 这几条的 cur 是 0~5mil，真离得近；挑不到就老实交回下面的路径（不猜）。
  if (/slot/i.test(String(obType || '')) && Number.isFinite(violX) && Number.isFinite(violY)) {
    try {
      const slots = await slotPadGeometry();
      if (slots.length) {
        let pick = null, pickD = Infinity, cand20 = 0;
        for (const sl of slots) {
          const hx = sl.horiz ? sl.len / 2 : sl.d / 2;
          const hy = sl.horiz ? sl.d / 2 : sl.len / 2;
          const holeBox = [sl.x - hx, sl.y - hy, sl.x + hx, sl.y + hy];
          // 障碍物取「孔 ∪ 焊盘铜」的外接盒：
          //   · 只取孔 -> 小于 DRC 真正指的铜（孔外还有焊盘环），走廊可能仍压焊盘铜；
          //   · 只取焊盘盒 -> 可能远大于真铜（本文件见过 100x100 的盒对 31.5x59.1 的孔）。
          // 并集是唯一既「不小于真铜」、又不被单侧膨胀放大的口径。
          let box = holeBox.slice();
          if (Array.isArray(sl.padBox)) {
            box = [Math.min(box[0], sl.padBox[0]), Math.min(box[1], sl.padBox[1]),
                   Math.max(box[2], sl.padBox[2]), Math.max(box[3], sl.padBox[3])];
          }
          const rect = { kind: 'poly', pts: [
            [box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]] };
          const d = geoDistSeg(rect, violX, violY, violX, violY);
          if (d <= 20) cand20++;
          if (d < pickD) { pickD = d; pick = { sl, rect, box, holeBox, usedPadBox: Array.isArray(sl.padBox) }; }
        }
        if (pick && pickD <= 20) {
          log('slotHoleUsed', {
            drcId: id, obstacleType: String(obType || ''),
            slotId: pick.sl.id, slotNum: pick.sl.num, slotNet: pick.sl.net,
            hole: [pick.sl.d, pick.sl.len], horiz: pick.sl.horiz,
            slotXY: [Math.round(pick.sl.x), Math.round(pick.sl.y)],
            viol: [Math.round(violX), Math.round(violY)],
            distToBox: Math.round(pickD * 100) / 100,
            usedPadBox: pick.usedPadBox,
            holeBox: pick.holeBox.map(v => Math.round(v)),
            box: pick.box.map(v => Math.round(v)),
            boxWH: [Math.round(pick.box[2] - pick.box[0]), Math.round(pick.box[3] - pick.box[1])],
            cand20,
            why: '用真槽孔几何替代与槽孔无关的外接盒（盒含判定只靠 ±4 容差成立）',
          });
          return {
            kind: 'poly', owner: 'slotHole', src: 'slotHole', padKind: 'OBSTACLE',
            // 返回的是「孔 ∪ 焊盘铜」的外接盒，不小于其中任何一个。方向保守（算大不算小），
            // 但请以 boxWH 为准：若它明显大于真实焊盘，过大的障碍物会逼出多余绕行
            // （本文件记录过 100x100 的盒把 1 处违规变成 3 处的亏），届时由轮末
            // clearanceReverted 整轮兜底。usedPadBox=false 说明没读到焊盘盒，只用了孔。
            pts: pick.rect.pts,
          };
        }
      }
    } catch (e) { try { log('slotHoleErr', String(e && e.message).slice(0, 90)); } catch (_) { } }
  }
  // 按类都取不到 → 让 API 自己回答这个 id 是什么、bbox 在哪（见 universalGeo 注释）。
  // 只有这一条能覆盖"不属于任何已索引类"的图元，Slot Region 就是这一类。
  return await universalGeo(id, violX, violY, needDist);
};

for (let round = 0; round < MAX_CLEAR_ROUNDS; round++) {
  if (left() < 90000) { log('clearanceBudgetSkip', { round, leftMs: left() }); break; }
  let details = null;
  try { details = await eda.pcb_Drc.check(true, false, true); } catch (e) { break; }
  const flat = [];
  const walk = (n) => {
    if (!n) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.errorType) flat.push(n);
    if (n.list) walk(n.list);
  };
  walk(details);
  const clears = flat.filter(v => v.errorType === 'Clearance Error');
  // 与 clears 同源、同一次 DRC，不额外调用：断路数用来判断"上一轮是不是把板子改断了"。
  const connsNow = flat.filter(v => v.errorType === 'Connection Error').length;
  if (!clears.length) { log('clearanceDone', { round, remaining: 0 }); break; }
  // 【任一种变差都算变差，而且断路优先】原判据是"clearance 条数变多才回滚"。
  const clearWorsened = prevClearCount !== null && clears.length > prevClearCount;
  const connWorsened = prevConnCount !== null && connsNow > prevConnCount;
  if ((clearWorsened || connWorsened) && (roundMods.length || roundCreated.length)) {
    // 回滚要逐项核对：只有**确认改回去**的动作才能从 clearanceFixes 里扣。
    // 旧实现无条件 `clearanceFixes -= prevFixed`，把已删除的 via 也算作"已恢复"，
    // 于是"板上真实留下的修复数"被系统性低估 —— 离线统计正是拿它判断策略优劣。
    const rb = { deleted: 0, restored: 0, viaRestored: 0, from: prevClearCount, to: clears.length,
      connFrom: prevConnCount, connTo: connsNow,
      why: connWorsened
        ? '这一轮把板子改断了（Connection Error 变多）——断路比间距违规严重，整轮撤回'
        : '这一轮 clearance 越修越多，整轮撤回',
      fixedRequested: prevFixed, fixedGivenBack: 0 };
    const delFail = [], restoreFail = [], viaRestoreFail = [], viaUnrestorable = [];
    // 第三种结果：create 没抛、也确实回了对象，只是读不到 id。
    // 以前这种和「create 失败」混在 viaRestoreFail 里，而那个 catch 不记录异常消息，
    // 于是「孔到底补回来了没有」这个问题在日志里根本没有答案。
    // 实测 v5（2026-11-26T19:49）clearanceRevertViaRestoreFail n=4，四条 GND 缝合孔
    // 全部记成"补不回来"，同期 GND Connection Error 从 4 涨到 8 —— 两者是否同因，
    // 当时无法判定，因为唯一的证据被吞了。
    const viaRestoreUnverified = [];
    for (const cid of roundCreated.reverse()) {
      // ★ delete 失败是 resolve(false)，不抛。只要"没抛"就 rb.deleted++，
      //   rb.deleted 会虚高到"等于尝试数"，而离线统计拿它当"确实撤掉了多少铜"。
      try {
        if ((await eda.pcb_PrimitiveLine.delete(cid)) === true) rb.deleted++;
        else delFail.push(String(cid));
      } catch (e) { delFail.push(String(cid)); }
    }
    for (const m of roundMods.reverse()) {
      if (m.kind === 'via') {
        // 过孔尺寸只有 modify 能改回去；before 是改之前的真值（记录点见 viaShrunk）
        const b = m.before || {};
        try {
          // modify 失败同样 resolve(undefined) 而不抛；"没抛"不等于"改回去了"
          const mr = await eda.pcb_PrimitiveVia.modify(m.id, { holeDiameter: b.holeDiameter, diameter: b.diameter });
          if (mr === undefined) viaRestoreFail.push(m.id); else rb.viaRestored++;
        } catch (e) { viaRestoreFail.push(m.id); }
        continue;
      }
      if (m.kind === 'viaMoved') {
          // 【平移过的过孔要推回原坐标】与 viaDeleted 不同，这里不需要 create：
          // 对象还在板上，modify 回旧坐标就是精确的逆操作（旧坐标在 recMod 时已记下）。
          // modify 失败同样 resolve(undefined) 而不抛，"没抛"不等于"回去了"。
          const bx = Number(m.x), by = Number(m.y);
          if (!Number.isFinite(bx) || !Number.isFinite(by)) { viaUnrestorable.push(m.id); continue; }
          try {
            const mr = await eda.pcb_PrimitiveVia.modify(m.id, { x: bx, y: by });
            if (mr === undefined) viaRestoreFail.push(m.id); else rb.viaRestored++;
          } catch (e) { viaRestoreFail.push(m.id); }
          continue;
        }
      if (m.kind === 'viaDeleted') {
        // 【删掉的孔可以补回来，而且必须补】旧注释说"create 生成的是新 id，
        //   等于换掉一个过孔，不算恢复"—— 那是对**账目**的要求，不是对**板子**的
        //   要求。板子只认电学连通：同坐标、同网、同孔径重画一个孔，网就连回去了。
        //   实测 2026-11-26 012004 那次失败就是删了 GND 孔 → GND 断成 2 处 →
        //   而回滚只记 viaUnrestorable、把断路留在板上 → 整块板判失败。
        //   坐标缺失（旧格式记录）才退回"补不回来"，并如实记账。
        const b = m.before || {};
        if (!Number.isFinite(Number(m.x)) || !Number.isFinite(Number(m.y))
            || !(Number(b.diameter) > 0) || !(Number(b.holeDiameter) > 0)) {
          viaUnrestorable.push(m.id);
          continue;
        }
        // 【第 6 个参数必须是**数字**枚举，不能是字符串】
        // README-d11.md §2（doc api 实查）的签名：
        //   create(net, x, y, holeDiameter, diameter,
        //          viaType?, designRuleBlindViaName?, solderMaskExpansion?, primitiveLock?)
        //   viaType：0=VIA 通孔 / 1=BLIND 盲埋孔 / 2=SUTURE 缝合孔。
        // 记录侧（viaDeleted 的 recMod）用 String(getState_ViaType() ?? '') 存成字符串，
        // 这里原样传回去，于是 EDA 侧按枚举查表得 undefined，读 .primitiveId 直接抛：
        //   Cannot read properties of undefined (reading 'primitiveId')
        // 实测 v5（2026-11-26T20:05，out/...195631）：4 条 GND 缝合孔全部走 catch，
        // 一个都没补回来，同期 GND Connection Error 从 4 涨到 8。
        // 佐证：全文件另外 8 处 pcb_PrimitiveVia.create 都只传 5 个参数，全部成功——
        // 差别只在这第 6 个参数。
        // 现在：能解析成 0/1/2 的数字才传；解析不出来就只传 5 个，
        // 不要拿 undefined 占位（参数个数本身可能改变桥的行为）。
        let createArgs = null;
        try {
          const viaTypeNum = (() => {
            const rawVt = m.viaType;
            if (rawVt === undefined || rawVt === null || String(rawVt).trim() === '') return null;
            const n = Number(rawVt);
            return (Number.isFinite(n) && n >= 0 && n <= 2) ? n : null;
          })();
          createArgs = [
            m.net || '', Number(m.x), Number(m.y),
            Number(b.holeDiameter), Number(b.diameter),
          ];
          if (viaTypeNum !== null) createArgs.push(viaTypeNum);
          const nv = await eda.pcb_PrimitiveVia.create(...createArgs);
          // 【判定成功靠什么】旧写法只看 `nv?.getState_PrimitiveId?.()` 是否为真，
          // 而 create 真失败时返回 undefined、成功时可能返回一个读不到 id 的对象
          // （本版本大量 getState_* / getPrimitive*ById 接口是 @alpha，实测返回 null）。
          // 两种情况被记成同一个 viaRestoreFail，于是"补不回来"这个结论读不出原因。
          // 现在分开记：
          //   nv 假      → create 没给出对象 = 确实没补回来（viaRestoreFail）
          //   nv 真但无 id → 对象在，是否落板未证（viaRestoreUnverified，自带 create 返回形状）
          if (!nv) {
            viaRestoreFail.push(m.id);
            log('viaRestoreDiag', { id: m.id, at: [Math.round(Number(m.x)), Math.round(Number(m.y))],
              net: m.net || '', args: createArgs, viaTypeRaw: m.viaType === undefined ? null : String(m.viaType),
              ret: String(nv), why: 'create 返回空值：确实没补回来' });
          } else {
            const nid = nv?.getState_PrimitiveId?.();
            if (!nid) {
              viaRestoreUnverified.push(m.id);
              log('viaRestoreDiag', { id: m.id, at: [Math.round(Number(m.x)), Math.round(Number(m.y))],
                net: m.net || '', args: createArgs, viaTypeRaw: m.viaType === undefined ? null : String(m.viaType),
                ret: 'object', hasGetId: typeof nv?.getState_PrimitiveId,
                keys: (() => { try { return Object.keys(nv).slice(0, 8); } catch (e) { return null; } })(),
                why: 'create 回了对象但读不到 id：孔可能在板上，无法证实' });
            } else {
              rb.viaRestored++;
            }
          }
        } catch (e) {
          viaRestoreFail.push(m.id);
          log('viaRestoreDiag', { id: m.id, at: [Math.round(Number(m.x)), Math.round(Number(m.y))],
            net: m.net || '', args: createArgs,
            viaTypeRaw: m.viaType === undefined ? null : String(m.viaType),
            threw: String(e && e.message).slice(0, 200),
            why: 'create 抛异常：确实没补回来' });
        }
        continue;
      }
      const patch = {};
      if (m.endX !== undefined) { patch.endX = m.endX; patch.endY = m.endY; }
      if (m.lineWidth !== undefined) patch.lineWidth = m.lineWidth;
      if (!Object.keys(patch).length) continue;
      try {
        const ml = await eda.pcb_PrimitiveLine.modify(m.id, patch);
        if (ml === undefined) restoreFail.push(m.id); else rb.restored++;
      } catch (e) { restoreFail.push(m.id); }
    }
    // 一处修复只算一次：绕行走 = 1 条 modify + 2 条 create，删除新增线段是
    // "撤掉多出来的铜"的前置动作，按 create 计数会把一处修复扣成两三处。
    rb.fixedGivenBack = rb.restored + rb.viaRestored;
    log('clearanceReverted', rb);
    if (delFail.length) log('clearanceRevertDeleteFail', { n: delFail.length, ids: delFail });
    if (restoreFail.length) log('clearanceRevertLineRestoreFail', { n: restoreFail.length, ids: restoreFail });
    if (viaRestoreFail.length) log('clearanceRevertViaRestoreFail', { n: viaRestoreFail.length, ids: viaRestoreFail });
    if (viaUnrestorable.length) log('clearanceRevertViaUnrestorable', { n: viaUnrestorable.length, ids: viaUnrestorable });
    if (viaRestoreUnverified.length) log('clearanceRevertViaUnverified', { n: viaRestoreUnverified.length, ids: viaRestoreUnverified });
    // ★ 回滚失败不能只打日志：这条线已经没有任何补偿手段能救回来。
    //   为什么**不**改成 delete：删掉一条被截短的 Track 会让该网在这个位置**确定地**断开，
    //   而断网是不可逆的 PCB 事实；截短铜保留了恢复所需的一切（roundMods 里有 id +
    //   原 endX/endY 或原 lineWidth）。用不可逆换可观测，方向反了。
    //   （d11 已有先例：删掉信号网上的一个 via → 整网断开 → 4 种板框尺寸全失败。）
    //   所以唯一负责任的做法是让本条结论**知道它的存在**，而不是让日志与判定脱钩。
    // ★ 这个布尔量回答的是「本轮撤回有没有完全回退」。它原来只数 restoreFail / delFail，
    //   **把 viaRestoreFail 和 viaUnrestorable 两个桶整个漏掉了** —— 也就是说：
    //   删掉的过孔一个都没补回来时，只要线都接回去了，它照样报 true。
    //   这是「一个字段承载两种含义」的反面：一个字段只承载了四分之一的含义。
    //   实测 v5（2026-11-26T19:49）四个 GND 缝合孔全部 create 失败，若同时没有线失败，
    //   旧写法会给出 clearanceRevertOk=true —— 而板子上有 4 个孤岛。
    //   viaRestoreUnverified 单列且也计入 false：没证实 = 不能声明撤回成功。
    clearanceRevertOk = (restoreFail.length || delFail.length
      || viaRestoreFail.length || viaUnrestorable.length || viaRestoreUnverified.length) ? false : true;
    for (const id of restoreFail) danglingLines.add(String(id));   // 被截短的悬空线
    for (const id of delFail) danglingLines.add(String(id));      // 没删掉的多余铜（同一类残留）
    if (restoreFail.length || delFail.length) {
      log('clearanceRevertGaveUp', {
        round, n: restoreFail.length + delFail.length, restoreFail, delFail,
        dangling: [...danglingLines], from: prevClearCount, to: clears.length,
        why: 'modify/delete 返回 undefined/false（不抛异常）：铜留在中间态，本轮已无补偿手段',
      });
    }
    clearanceFixes -= rb.fixedGivenBack;      // 只退确认退掉的；删掉的 via 仍在板上
    if (clearanceFixes < 0) {
      // 负数 = 记录数比实际 fixed 多，属记账漂移；不能静默夹成 0 让人以为对得上
      log('clearanceFixesNegative', { fixes: clearanceFixes, givenBack: rb.fixedGivenBack });
      clearanceFixes = 0;
    }
    prevFixed = 0;
    try { if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
    await sleep(800);
    break;
  }
  prevClearCount = clears.length;
  prevConnCount = connsNow;
  roundMods = [];
  roundCreated = [];
  // 障碍物 id→类 索引每轮重建：上一轮的缩窄/绕行已经改过铜，旧索引会指向过期图元
  geoIdx = null;

  let fixed = 0;
  const seenVia = new Set();
  // 【无处理者的违规类 —— 必须可见】下面两个循环各自只认一侧：
  //   Via 环处理"含 Via"的违规，Track 环处理"含 Track"的违规。
  // 两侧都不是（Hole×Hole、Pad×Pad、Slot×Slot…）时**两个循环都静默 continue**，
  // 于是这类违规每轮原封不动被带过去；而 fixed 因为**别的**项在涨、
  // clearanceRound 也照常打印，日志读起来像"正在修"，实际没有一个处理者认领它。
  // 实测 d12（out\USBC_Power_ESD-20261126-002156\_log-2-expand-1.25x.json）：
  //   末障碍 Hole×Hole(11.7066/11.811)，两轮 fixed=2/2，违规 4→4 一格没降。
  // 「没有处理者」与「处理了但没用」是两种完全不同的缺陷，日志必须能分开。
  // 只计数、只打日志，不改变任何修复行为（先测量，再决定要不要加处理者）。
  // 判据只写一遍：两侧都不是 Via/Track ⇒ 两个环都认不了。
  const noSideIsViaOrTrack = (t1, t2) => {
    const a = String(t1 || ''), b = String(t2 || '');
    if (!a || !b) return false;   // 缺字段 = 看不出，不外推成"没人管"
    return a !== 'Via' && b !== 'Via' && a !== 'Track' && b !== 'Track';
  };
  const noHandler = new Map();
  // ★ 第三类账：**处理者存在、环也进到了，但当场失败**。
  //   它既不是 uncovered（两侧都不是 Via/Track ⇒ 根本没有处理者），
  //   也不是 covered（另一个环已认领 ⇒ 属正常分工）。类型对得上、Track 环也认领了它，
  //   只是 pcb_PrimitiveLine.get() 返回空，于是 continue。
  //   并进 covered 会把"失败"记成"正常分工"；并进 uncovered 会污染
  //   noSideIsViaOrTrack 那条判据。只能单列，并在轮次汇总里一起报出来。
  //   现场证据（d11-20261126-051342 尝试4）：Track×SMD Pad 的一条违规落在
  //   obj2="653f26ff2d962c4be17"（19 字符，父图元 id + 子元素下标），
  //   当轮 clearanceNoHandler 报 uncoveredTotal=0、covered 记 Track×SMD Pad n=6，
  //   而最终 DRC 仍有 11 条（Track to Track 4 + SMD Pad to Track 7）——
  //   uncoveredTotal=0 与"全部处理完"并不同义。
  const noLineFail = [];
  // ★ 记账口径：**按违规对象**去重，不按"跳过次数"。
  //   一条 SMD Pad×Hole 会被 Via 环跳过一次（无 Via 侧）、Track 环再跳一次（无 Track 侧），
  //   按次数记会得到 n=2 —— 实测 RP2040_Minimal-20261126-004202 就是这样，而那一轮
  //   DRC 只有 2 条违规、真正无人处理的只有 1 条（同轮 clearanceRound.fixed=1，
  //   说明 SMD Pad×Via 那条其实被 Via 环修好了）。口径错了会把分析整段带偏。
  const noHandlerSeen = new Set();
  const noteNoHandler = (v, t1, t2, why) => {
    if (noHandlerSeen.has(v)) return;      // 同一条违规只记一次
    noHandlerSeen.add(v);
    const k = String(t1 || '?') + '×' + String(t2 || '?');
    // 分栏：uncovered = 真没人管；covered = 另一个环已认领（正常分工，不是缺陷）
    const bucket = noSideIsViaOrTrack(t1, t2) ? 'uncovered' : 'covered';
    const rec = noHandler.get(k) || { pair: k, n: 0, why, bucket };
    rec.n++;
    noHandler.set(k, rec);
  };
  // ★ 上面那条只统计「某个环跳过了它」，不等于「全局无人处理」：
  //   含 Via 的违规会被 Via 环认领，Track 环仍会跳过它并记一笔 —— 那是正常分工。
  //   真正的问题是**两侧都不是** Via / Track，两个环都认不了。
  //   这个判据必须在两个循环之前、单看类型得出，不能从循环的跳过次数反推。
  // ★ 复用 noSideIsViaOrTrack：判据写两遍就是两个缺陷点，改一处漏一处。
  //   「类型缺失时不算无人认领」的理由保留在该函数里：早退的前提是
  //   「确定没有任何处理者会动它」，而字段缺失只能证明「我看不出谁来处理」。
  const unclaimable = clears.filter((v) => {
    const e = v.explanation?.errData || {};
    return noSideIsViaOrTrack(e.obj1Type, e.obj2Type);
  });
  if (unclaimable.length) {
    const hist = new Map();
    for (const v of unclaimable) {
      const e = v.explanation?.errData || {};
      const k = String(e.obj1Type || '?') + '×' + String(e.obj2Type || '?');
      hist.set(k, (hist.get(k) || 0) + 1);
    }
    // 字段名必须自解释：原来这里写 `total: clears.length`，读的人（包括我）
    // 会把它当成"无人认领的合计"，于是 {n:1,total:2} 看起来像脏数据。
    // 其实它是**分母**：本轮 clearance 违规总数。改名后两者关系一眼可见。
    log('clearanceUnclaimable', {
      round, n: unclaimable.length, clearanceTotal: clears.length,
      classes: [...hist.entries()].map(([pair, n]) => ({ pair, n })),
      why: '两侧都不是 Via/Track ⇒ 缩孔环与缩窄/绕行环都不会处理它',
    });
  }
  // 全部违规都无人认领 ⇒ 这一轮**无论做什么都不可能收敛**（板上的铜不会被改动），
  // 继续跑只会把同一个 DRC 结果再算一遍。d12 的 Hole×Hole(11.7066/11.811) 就是这样
  // 走完两轮、fixed 还报 2/2。标记下来，在本轮结果落日志**之后**退出，
  // 这样 clearanceRound 的时间序列不会缺环（缺失本身会被误读成"没跑这一轮"）。
  const allUnclaimable = unclaimable.length > 0 && unclaimable.length >= clears.length;
    // 【Hole × Hole 处理者：两侧都是孔，两个老环都不认领】
    // d12 实测（out\_d12-holepairs.md）：两条违规都在**流水线自己打的 GND 过孔**与
    // J1 USB-C 壳体槽孔之间，cur=11.701 / need=11.811，只差 0.11 mil。
    // obj1Type/obj2Type 都是 'Hole' ⇒ Via 环（要求含 Via）与 Track 环（要求含 Track）
    // 全部 continue，于是两轮 fixed=2/2 而违规 4→4 一格没降 —— 病根是**没有处理者**，
    // 不是修不动。过孔可动、槽孔不可动，所以按下述最小改动推开过孔：
    //   · 方向：at 是缺口最近点，过孔心相对 at 的方向就是"背离另一孔"。
    //     报告核对过 at 的取整位置与"缺口线段中点"反推值逐位吻合，12.2 mil 的距离也够定方向。
    //   · 步长：ceil(need - cur + 1) mil，封顶 6 mil。报告实测位移 >6 mil 时走线端帽
    //     会离开焊盘，必须同步改线端点；这里不改线，所以不越这条线。
    //   · 不用缩孔替代：12 → 11.8 只补 0.1 mil，仍差 0.0098，且 11.8 已是可制造下限。
    //     这就是"越缩越像能过、实际永远差一点"的量化陷阱。
    let holePairN = 0, holePairFixed = 0;
    const holePairs = clears.filter((v) => {
      const e = v.explanation?.errData || {};
      return e.obj1Type === 'Hole' && e.obj2Type === 'Hole';
    });
    if (holePairs.length) {
      holePairN = holePairs.length;
      // 过孔位置索引每轮建一次；get 失败/读数缺失一律跳过，不外推成"没有孔"
      let viaGeo = null;
      const loadVias = async () => {
        if (viaGeo) return viaGeo;
        viaGeo = [];
        try {
          const ids = await eda.pcb_PrimitiveVia.getAllPrimitiveId();
          for (const id of (ids || [])) {
            try {
              const o = await eda.pcb_PrimitiveVia.get(id);
              if (!o) continue;
              const x = Number(o.getState_X?.());
              const y = Number(o.getState_Y?.());
              if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
              viaGeo.push({ id: String(id), x, y });
            } catch (e) { }
          }
        } catch (e) {
          log('holePairViaIndexErr', { m: String(e && e.message).slice(0, 100) });
        }
        return viaGeo;
      };
      for (const v of holePairs) {
        const e = v.explanation?.errData || {};
        // 【必须先排除缺失，再 Number()】Number(null) === 0、Number('') === 0，
        // 于是"这一条没给读数"会算成 cur=0、缺口 11.8 mil，被记成 holePairTooFar
        // —— 读起来像"物理上不可修"，而真相是"这一次没读到"。
        // 与 viaGeomErr / holePairNoVia 同理：未取到 ≠ 无望。
        const holeNumMil = (v) => {
          if (v === null || v === undefined || v === '') return NaN;
          const n = Number(v);
          return Number.isFinite(n) ? n * 10 : NaN;     // 画布单位 mil/10 → mil
        };
        const needDist = holeNumMil(e.clearance);
        const curDist = holeNumMil(e.minDistance);
        const p = e.position || {};
        // 【position 与 clearance/minDistance 同一套单位：画布单位 = mil/10】
        // 2026-11-26 21:5x 实测（run -214236）：clearance=1.2、minDistance=0.8 经
        // holeNumMil ×10 得到 need=12 / cur=8，与钻孔实测边距 8.38 mil 吻合
        // （孔 0.305mm @x=88.95 ↔ 槽 0.8mm 左缘 x=103.32）；position 也是同一套：
        //   p = (9.914, -38.964) ×10 = (99.14, -389.64) mil，与 DRC 叶子 (99,-390) 对上。
        // 但下面遍历 viaGeo 用的是 getState_X/Y 的**mil**，旧代码把两者直接相减，
        // 于是 d 恒在 350 量级（主要是 y 差：-389 mil vs -38.96）、
        // 永远过不了 `best.d <= 40`，`holePairNudged` 一次都没出现过
        // （语料 holePairSummary 全 fixed:0，holePairNoVia 的 near 停在 79~90）。
        // 这不是「没有可动的孔」，是**拿画布单位的点去和 mil 单位的孔算距离**。
        // 改正后 d=10.2 → 过门；deficit=(12-8)=4 → delta=5 → 边距 8.38+5=13.38 > 12。
        const ax = Number(p.x) * 10, ay = Number(p.y) * 10;
        if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(needDist) || !Number.isFinite(curDist)) {
          log('holePairNoCoord', { need: String(e.clearance), cur: String(e.minDistance) });
          continue;
        }
        const deficit = needDist - curDist;
        if (!(deficit > 0)) { log('holePairOdd', { need: needDist, cur: curDist, at: [ax, ay] }); continue; }
        const delta = Math.min(6, Math.max(1, Math.ceil(deficit + 1)));
        if (deficit + 1 > 6) { log('holePairTooFar', { deficit, at: [ax, ay] }); continue; }
        // 找最近的、可动的过孔
        const vias = await loadVias();
        let best = null;
        for (const g of vias) {
          const d = Math.hypot(g.x - ax, g.y - ay);
          if (!best || d < best.d) best = { d, g };
        }
        if (!best || !(best.d <= 40)) {
          log('holePairNoVia', { at: [ax, ay], near: best ? Math.round(best.d * 100) / 100 : -1, vias: vias.length });
          continue;
        }
        const g = best.g;
        const ux = g.x - ax, uy = g.y - ay;
        const len = Math.hypot(ux, uy);
        if (!(len > 0.01)) { log('holePairDegenerate', { at: [ax, ay], via: [g.x, g.y] }); continue; }
        const ox = g.x, oy = g.y;
        const nx = Math.round((ox + (ux / len) * delta) * 1e4) / 1e4;
        const ny = Math.round((oy + (uy / len) * delta) * 1e4) / 1e4;
        try {
          // modify 失败 resolve(undefined) 而不抛 ⇒ 必须判返回值（staticcheck §1.5）
          const mr = await eda.pcb_PrimitiveVia.modify(g.id, { x: nx, y: ny });
          if (mr === undefined) { log('holePairModifyFail', { id: g.id, to: [nx, ny] }); continue; }
          // 回滚要能把它推回原位：记录旧坐标
          recMod(g.id, { kind: 'viaMoved', x: ox, y: oy, to: [nx, ny] });
          g.x = nx; g.y = ny;
          fixed++;
          holePairFixed++;
          log('holePairNudged', { id: g.id, delta, from: [ox, oy], at: [ax, ay], to: [nx, ny] });
        } catch (err) {
          log('holePairModifyErr', { id: g.id, m: String(err && err.message).slice(0, 100) });
        }
      }
      if (holePairN) log('holePairSummary', { total: holePairN, fixed: holePairFixed });
    }
  for (const v of clears) {
    const viaId = (v.objs || []).find(o => /^[0-9a-f]{18,20}$/.test(o) && o !== v.explanation?.errData?.obj1);
    // 直接找出这次违规里"Via"那侧的对象 id
    const ed = v.explanation?.errData || {};
    const viaObjId = ed.obj2Type === 'Via' ? ed.obj2 : (ed.obj1Type === 'Via' ? ed.obj1 : null);
    if (!viaObjId) { noteNoHandler(v, ed.obj1Type, ed.obj2Type, '无 Via 侧'); continue; }
    if (seenVia.has(viaObjId)) continue;
    seenVia.add(viaObjId);
    try {
      const vv = await eda.pcb_PrimitiveVia.get(viaObjId);
      if (!vv) continue;
      const curD = Number(vv.getState_Diameter?.() || 0);
      const curH = Number(vv.getState_HoleDiameter?.() || 0);
      // 【门槛必须是"可制造最小值"而不是 20.5mm 之类的约数】实测被删的 4 个孔全是
      // 19.8mil：它落在 (19.7, 20.5] 之间，旧门槛把它判成"已经最小、只能删"，
      // 而 19.8 明明还能无损缩到 19.7（0.5mm，嘉立创最小可制造外径）。
      // 19.75 是"离最小值还有意义"的下界：再小就只剩 0.05mil 的收益，不值得动刀。
      if (curD > 19.75) {
        // 先尝试缩到规则最小（0.5mm=19.7mil，孔 0.3mm=11.8mil）
        // ★ 「记在 modify 之后」这个理由只对一半：modify **失败时 resolve(undefined) 而不抛**，
        //   所以"抛异常时尺寸没变"成立，"返回 undefined 时尺寸没变"同样成立，而后者没有异常。
        //   原写法会在尺寸根本没变的情况下记 recMod + fixed++：回滚时去"恢复"一处不存在的
        //   改动（fixedGivenBack 虚高，clearanceFixes 被多扣），日志谎报 viaShrunk。
        const mv = await eda.pcb_PrimitiveVia.modify(viaObjId, { holeDiameter: 11.8, diameter: 19.7 });
        if (mv === undefined) {
          log('viaModifyUnconfirmed', { via: viaObjId, want: [11.8, 19.7], from: [curH, curD] });
        } else {
          recMod(viaObjId, { kind: 'via', before: { holeDiameter: curH, diameter: curD } });
          fixed++;
          log('viaShrunk', { via: viaObjId, from: [curH, curD], to: [11.8, 19.7] });
        }
      } else {
        // 删 via 前必须确认它不是"唯一通路"。注释说"GND 覆铜已保证连通"，
        // 但 via 也可能属于信号网 —— 实测 d11 的 XTAL_IN via 被删后整网断开，
        // DRC 报 Connection Error: XTAL_IN，4 种板框尺寸全部失败（假性 DRC 死循环）。
        // 只有 GND/覆铜网才允许删；信号网保留 via（宁可留 1 个间距违规，
        // 也不要断网 —— 断网是致命的，间距违规可人工微调）。
        let netName = '';
        try {
          netName = String(vv.getState_Net?.() || vv.getState_NetName?.() || '');
        } catch (e) {
          log('viaNetErr', { via: viaObjId, m: String(e && e.message).slice(0, 100) });
        }
        // 坑：原条件是 `if (!isPourNet && netName.trim()) continue` ——
        // 读不到网名时 netName 为空串，`netName.trim()` 为 falsy，整个条件短路成 false，
        // 于是**照样删 via**。而这正是注释里说的「删信号网 via 断整网」。
        // 保守原则：网名未知 = 可能是信号网 → 保留。
        // 留 1 个间距违规可人工微调，断网是致命的。
        if (!netName.trim()) {
          log('viaKept', { via: viaObjId, reason: 'net unreadable, keep to avoid breaking connectivity' });
          continue;
        }
        const isPourNet = /^(GND|GNDD|AGND|DGND|VSS|GROUND)$/i.test(netName.trim());
        if (!isPourNet) {
          // 【不要再建议"改成缩孔"】离线统计提过这条，但走不到这里：
          // 能进这个分支的过孔直径已经 <=19.7mil，而 19.7mil = 0.5mm 正是
          // 嘉立创的最小可制造外径（孔 0.3mm=11.8mil）。再缩就是做不出来的板子 ——
          // 用"不可制造"换"间距合规"是更坏的交易。
          // 真正可行的是沿走线方向**平移过孔**再补线，但那会改动铜形，
          // 无人值守下风险高于收益，故保持：宁可留 1 处间距违规（可人工微调）。
          log('viaKept', { via: viaObjId, net: netName.trim(), d: curD,
            reason: 'signal net at min diameter; shrinking would be unmanufacturable' });
          continue;
        }
        // 【覆铜网的过孔也不许删 · 本轮实测把它关掉】
        // 旧实现在这个分支里 delete 掉"挡间距"的 GND 过孔。理由写的是
        // "GND 覆铜已保证连通"—— 这对**缝合孔**成立，对 **EP 散热焊盘上的孔**完全不成立：
        // 实测（2026-11-26T20:21:44+08:00 那轮）viaDeleted ×4 全是 d=19.8 的 GND 孔，
        // 坐标 (729,-1737) (633,-2041) (591,-2103) (729,-1683)，正是 preVia 打在 EP 盘上的那 9 个里的 4 个。
        // 删掉后 4 个 EP 焊盘失去 L1→L2 的唯一铜通路 → GND Connection Error 4→8；
        // 整轮回滚又把这轮 viaShrunk ×2（无损缩孔）一起撤回，于是最终仍差 0.24mil。
        // 也就是说：删孔**没修好间距，还断了网，并且把好的改动一起赔进去了**。
        // 本文件自己的统计早就写着这条：语料 viaDeleted 45/45 全是 GND，
        // 其中 26 条最终仍 passed ⇒ 约 58% 成功率，属高危路径。
        //
        // 交易方向反过来才是对的：一个欠 0.2mil 的间距是**布局级缺陷**，如实报告、
        // 由人（或下一轮布局）处理；断网是致命的且无人值守下没人会补。
        // 缩径是无损的（同一坐标、同一网、更小的孔，电学上仍是同一个孔），删孔不是。
        log('viaKeptPour', { via: viaObjId, net: netName.trim(), d: curD, hole: curH,
          at: (() => { try { return [Math.round(Number(vv.getState_X?.())),
                                      Math.round(Number(vv.getState_Y?.()))]; }
                       catch (e) { return null; } })(),
          reason: 'pour-net via at min diameter; deleting it can detach an EP/isolated pad '
                + 'from the pour (measured: 4 GND vias deleted -> GND Connection Error 4->8). '
                + 'A sub-minimum clearance shortfall is a layout-level defect: report it, '
                + 'never trade it for a broken net' });
        continue;
      }
    } catch (e) { log('viaFixErr', { via: viaObjId, m: String(e && e.message).slice(0, 120) }); }
  }

  // ---- Track 侧：缩窄 → 仍不够则绕行 ----
  // 原实现只处理 Via，实测 d12 的违规是 Track↔SMD Pad（VBUS 走线贴住 USB-C
  // 屏蔽壳 GND 多边形焊盘 e6e35），缩窄到最小 6.5mil 后仍差 1.4mil。
  //
  // 实测数据（d12 err24/err25）：
  //   焊盘多边形 bbox x[325.98,349.60] y[-347.43,-296.24]
  //   t144 中心线到焊盘边缘 0.07mil（-3.18 边缘距，等于压在焊盘上）
  //   t146 中心线 7.84mil（4.59 边缘距，要求 6）
  // 修法必须**绕行**而不是继续缩窄：把斜穿焊盘的线段改造成 L 形，
  // 从焊盘左侧安全走廊绕过去（实测 2 处违规 → 0，DRC 通过）。
    for (const v of clears) {
    const ed = v.explanation?.errData || {};
    const trackId = ed.obj1Type === 'Track' ? ed.obj1
                  : (ed.obj2Type === 'Track' ? ed.obj2 : null);
    if (!trackId) { noteNoHandler(v, ed.obj1Type, ed.obj2Type, '无 Track 侧'); continue; }
    if (seenVia.has(trackId)) continue;
    seenVia.add(trackId);
    try {
      const tl = await eda.pcb_PrimitiveLine.get(trackId);
      if (!tl) {
        // 【静默放弃必须留痕】get() 返回空 ⇒ 这一处违规不会被任何手段处理，
        // 而旧实现直接 continue：日志里它与"根本没被看到"完全同形。
        // d13 那 2 处 Slot Region to Track（cur=0 / need=11.81 / net 全为 null）
        // 的排查就卡在这个歧义上 —— clearanceNoHandler.uncovered 为空、
        // clearanceSkipNoPush 也为空、clearanceSkipNoGeo 没有，看上去"有人处理"，
        // 实际铜一动不动。单独成键才能把这两种情形分开。
        const cD = Number(ed.minDistance) * 10;
        const nD = Number(ed.clearance) * 10;
        log('clearanceSkipNoLine', {
          line: trackId, t1: ed.obj1Type, t2: ed.obj2Type,
          obj1: String(ed.obj1 || ''), obj2: String(ed.obj2 || ''),
          net: ed.net || null,
          cur: Number.isFinite(cD) ? Math.round(cD) : null,
          need: Number.isFinite(nD) ? Math.round(nD) : null,
          reason: 'pcb_PrimitiveLine.get 返回空 ⇒ 这条违规无人处理',
        });
        // 入账（只记账、不改变行为）：让轮次汇总能看见"处理者失败了"这一档。
        noLineFail.push({ t1: ed.obj1Type, t2: ed.obj2Type,
          line: String(trackId), obj2: String(ed.obj2 || '') });
        continue;
      }
      const curW = Number(tl.getState_LineWidth?.() ?? tl.getState_Width?.() ?? 0);
      // ★ 把「这一处需要多大间距 / 现在差多少」提到缩窄**之前**算。
      //   它们只依赖 ed（不需要解析障碍物几何），本来就该早算；放在后面导致
      //   缩窄决策时看不到差距，只能"先缩了再说"，而缩窄成功后立刻 `continue`
      //   —— 同一处违规要再等一整轮才会被绕行处理。
      //   单位：minDistance / clearance 是画布单位（mil/10），×10 才是 mil。
      const curDist = Number(ed.minDistance) * 10;
      const needDist = Number(ed.clearance) * 10;

      // ★ 缩窄能不能成功，是可以**算出来**的，不该靠试：
      //   线宽从 curW 缩到 6.5，两侧各让出 (curW-6.5)/2，边缘距最多增加这么多。
      //   若 curDist + 增量 < needDist，缩窄在算术上不可能达标 —— 这时缩窄
      //   除了白烧一轮、并且把这一轮计入「无进展」（进而触发 noProgressRounds 提前停），
      //   没有任何作用。实测：纯净轮里缩窄 7 次、违规净减少 **0**。
      //   所以差距可证明补不上时直接跳到绕行。
      //   读数缺失（NaN/0）时**不能**判为无望：那只是"不知道"，不是"不可能"。
      const thinGain = curW > 6.5 ? (curW - 6.5) / 2 : 0;
      const thinKnowable = Number.isFinite(curDist) && Number.isFinite(needDist)
        && curDist >= 0 && needDist > 0;
      const thinHopeless = thinKnowable && (curDist + thinGain) < (needDist - 1e-3);

      // 第一步：先缩窄（无损 —— 铜还在，只是细一点，必然让间距变大）
      if (curW > 6.5 && thinHopeless) {
        // 只记录、不修改：这不是失败，是"已知这条路走不通"。
        // 单独成键，否则离线统计无法把「算准了不走」与「试了没用」分开。
        log('clearanceThinHopeless', {
          line: trackId, net: String(tl.getState_Net?.() || ''),
          curW, minW: 6.5, cur: Math.round(curDist * 100) / 100,
          need: Math.round(needDist * 100) / 100,
          gain: Math.round(thinGain * 100) / 100,
          why: '缩窄最多补 thinGain，仍够不到 need ⇒ 直接走绕行',
        });
      } else if (curW > 6.5) {
        // ★ 缩窄同样要判返回值：modify 失败 resolve(undefined)。原实现在失败时
        //   照样 fixed++ 并 `continue`，于是**放弃了本来还能生效的绕行**（下一步），
        //   同时把这处违规记成"已修"。计数虚高 + 少一次真实修复，两个方向都错。
        const mt = await eda.pcb_PrimitiveLine.modify(trackId, { lineWidth: 6.5 });
        if (mt === undefined) {
          // 缩窄没生效 → 不要 continue，让它继续走下面的绕行分支
          log('trackThinUnconfirmed', { line: trackId, from: curW, want: 6.5,
            net: String(tl.getState_Net?.() || '') });
        } else {
          recMod(trackId, { lineWidth: curW });
          fixed++;
          log('trackThinned', { line: trackId, from: curW, to: 6.5,
            net: String(tl.getState_Net?.() || '') });
          continue;
        }
      }

      // 第二步：已到最小线宽仍违规 → 绕行。需要异网障碍物的包围盒。
      // getState_Pad() 有多形态，必须分别解析 —— 早期实现只处理 POLYGON，
      // 导致 RECT 焊盘（如 d11 晶振 Y1_4 = ["RECT",55.1,47.2,0]）走
      // `verts.length < 3` 被静默跳过，绕行永不生效。
      //   RECT       → ['RECT', w, h, rot]      w/h 是**未旋转**尺寸
      //   POLYGON    → ['POLYGON', [x,y,'L',x,y,...]]
      //   OVAL/ROUND → 同 RECT，按外接矩形处理
      // 障碍物不只有 SMD Pad。实测 DRC 的 objXType 真实取值有：
      //   Track / Via / Hole / Slot Region / SMD Pad
      // （logs 取证：d13 的 `Hole` 与 `Via` 两条指的是**同一个过孔 id**；
      //   `Slot Region` 是 20 位 hex 的另一种图元 id，与 Track/Via 的 16 位不同源。）
      // 「不是本走线的那一个对象」就是障碍物。**Track-Track 时两边都是 Track**，
      // 旧判据 `obTypeX !== 'Track'` 在这类违规上两边都不成立 → obstacleId=null
      // → 直接掉进「违规点±4mil」假盒；d12/d13 的 Track-Track 违规 100% 走这里。
      // 所以必须用 id 区分哪条是违规线、哪条是障碍线。
      const obType1 = String(ed.obj1Type || '');
      const obType2 = String(ed.obj2Type || '');
      let obstacleId = null, obstacleType = 'Track';
      if (ed.obj1 && String(ed.obj1) === String(trackId) && ed.obj2) {
        obstacleId = ed.obj2; obstacleType = obType2 || 'Track';
      } else if (ed.obj2 && String(ed.obj2) === String(trackId) && ed.obj1) {
        obstacleId = ed.obj1; obstacleType = obType1 || 'Track';
      } else if (obType1 && obType1 !== 'Track') {
        obstacleId = ed.obj1; obstacleType = obType1;
      } else if (obType2 && obType2 !== 'Track') {
        obstacleId = ed.obj2; obstacleType = obType2;
      } else {
        obstacleId = ed.obj2 || ed.obj1 || null;
        obstacleType = obType2 || obType1 || 'Track';
      }
      if (obstacleId && String(obstacleId) === String(trackId)) obstacleId = null;
      // 单位陷阱：errData.minDistance / clearance / position 都是**画布单位**（mil/10）。
      // 实测 minDistance=0.46223 对应提示 "distance is 4.6mil"，
      // clearance=0.59843 对应 "should be >= 6mil"。×10 才是 mil。
      const vpos = ed.position || v.pos || {};
      const violX = Number(vpos.x) * 10;
      const violY = Number(vpos.y) * 10;
      // curDist / needDist 已在缩窄决策处（本 try 块开头）算过并声明，
      // 这里不再重复声明：同一份逻辑写两遍就是两个缺陷点，改一处漏一处。
      // ★ 按障碍物**真实类型**取几何：Track 线段（两端点+线宽）/ Via 圆（外径/2）/
      //   Hole 圆（孔径/2）/ Slot Region 轮廓 / Pad 外接矩形。取不到就是 null。
      const obs = await resolveObstacle(obstacleType, obstacleId, violX, violY, needDist);
      const obsBox = geoBBox(obs);
      // ★ 两种"几何不完整"必须**分开判**（曾被合并成一条，结果挡掉了一条真能通过的路径）。
      //
      //   (a) `!obs || !obsBox` —— 真拿不到几何，只能合成「违规点 ±max(need/2,4)」的
      //       ~12mil 小盒再绕行。这一条**有硬证据**：d12 的 VBUS 被搬上 GND 轨迹、
      //       d12 1→7、d13 6→17（上面的注释已记）。继续拒绝。
      //
      //   (b) `obs.src === 'bbox'` —— 几何**是 API 给的**（`getPrimitivesBBox`），只是
      //       形状用四个角近似，而 `universalGeo` 已校验过 `contains`（违规点确实在盒内）。
      //       此时绕行是「把压在障碍物上的铜挪开」，方向正确，只是盒子可能偏大。
      //       原先这里也一起拒绝，依据是单次观测：d13 家族 04:31 那轮把 2 处改成 7 处。
      //       **但那条依据已被反例推翻**：`AI_传感器___充电___显示_19pia69-20261126-025434`
      //       的 `_run-2-expand-1.25x.json` 是 `ok:true / drcLeafCount:0`，两次 bbox 绕行
      //       （objId 5bcc24d89…e19 / …e17，padBBox 均 100×100）把
      //       `clearanceRound {violations:2, fixed:2}` 干到 `clearanceDone {remaining:0}`。
      //       即：这条路**产出过真 PASS**。
      //       而那次的坏情况（2→7）本来就被 `clearanceReverted` 的整轮回滚抓住了
      //       （日志 `deleted:4 restored:2 from:2 to:7` 就是回滚成功的记录）——
      //       安全网已经在，预先拒绝等于**只去掉上限、不去掉下限**。
      //       故放行，坏情况交由既有的整轮回滚兜底。
      if (!obs || !obsBox) {
        // 旧实现在这里合成「违规点 ±max(need/2,4)」的 ~12mil 小盒、padKind:'UNKNOWN'，
        // 然后照样绕行 —— 这正是 d12 的 VBUS 被搬上 GND 轨迹、d12 1→7 / d13 6→17
        // 的来源。现在：安全盒**放大**（≥2×need 且 ≥20mil 半边长）只用于记录；
        // **禁止** corridor/dogleg 改道，直接放弃这一处自动修复（留 1 处违规给人工
        // 微调，好过把它变成 7 处）。缩窄已在上面独立完成，与本分支无关。
        const half = Math.max(Number.isFinite(needDist) && needDist > 0 ? needDist : 6, 10);
        log('clearanceSkipNoGeo', {
          line: trackId, net: String(tl.getState_Net?.() || ''),
          obstacleType, objId: String(obstacleId || ''),
          safeBox: (Number.isFinite(violX) && Number.isFinite(violY))
            ? [Math.round(violX - half), Math.round(violY - half),
               Math.round(violX + half), Math.round(violY + half)]
            : null,
          need: Number.isFinite(needDist) ? Math.round(needDist) : null,
          cur: Number.isFinite(curDist) ? Math.round(curDist) : null,
          obsSrc: obs ? (obs.src || 'contour') : null,
          // bbox 不再进入本分支（见上面 (a)/(b) 的拆分），这里只剩"真拿不到几何"
          reason: 'obstacle geometry unavailable; corridor reroute forbidden',
        });
        continue;
      }
      // padKind 保留给离线统计：不再出现 'UNKNOWN'，非焊盘障碍物记真实几何种类
      const padKind = String(obs.padKind || obs.kind).toUpperCase();
      const [bx0, by0, bx1, by1] = obsBox;

      const HALF = 3.25;              // 本走线线宽一半（上面已缩到 6.5mil）
      // 需求净距不能再写死 6：Track-Track 常是 6mil，而 Slot Region 实测要到 11.81mil
      // （errData.clearance=1.1811 → ×10）。写死会把"要求 11.8mil"的走廊放在只留
      // 10.25mil 的位置 —— 修完仍违规，下一轮换个方向再来一次，越修越多。
      const NEED_CLEAR = (Number.isFinite(needDist) && needDist > 0) ? needDist : 6;
      const NEED = NEED_CLEAR + HALF + 1.0;   // 净距 + 半线宽 + 1mil 余量
      const sx = Number(tl.getState_StartX()), sy = Number(tl.getState_StartY());
      const ex = Number(tl.getState_EndX()), ey = Number(tl.getState_EndY());
      const net = String(tl.getState_Net?.() || '');
      const layer = tl.getState_Layer?.() ?? 1;

      // 走廊：障碍物四侧各一条，取第一条**按真实几何**判定安全的
      const corridors = [
        { axis: 'x', at: bx0 - NEED },   // 左
        { axis: 'x', at: bx1 + NEED },   // 右
        { axis: 'y', at: by0 - NEED },   // 下
        { axis: 'y', at: by1 + NEED },   // 上
      ];
      let chosen = null;
      // 【诊断累加器】走廊被否的原因。这个循环里原先有 9 处 continue **一句日志都没有**，
      // 于是"找不到走廊"在账本里是一片空白 —— 分不清是几何不允许、还是被某个守卫挡了。
      // 实测语料：`clearanceThinHopeless` 在"剩余违规仍是间距类且只差 1~2 处"的 7 个尝试里
      // 7/7 出现（缩窄必然先失败才轮到走廊），但走廊为什么一条没选上，全语料零记录。
      // 只加记录，不改任何判定。
      const reject = [];
      for (const c of corridors) {
        if (!Number.isFinite(c.at)) { reject.push(c.axis + ':nan'); continue; }
        // 走廊必须真的在障碍物外侧（防止退化尺寸算出「走廊」压在障碍物上）
        const outside = c.axis === 'x'
          ? (c.at <= bx0 - 6 || c.at >= bx1 + 6)
          : (c.at <= by0 - 6 || c.at >= by1 + 6);
        if (!outside) { reject.push(c.axis + ':inside'); continue; }
        // 走廊两端都要能接回原线段（不能跑到板外或远处）
        const dS = c.axis === 'x' ? Math.abs(c.at - sx) : Math.abs(c.at - sy);
        const dE = c.axis === 'x' ? Math.abs(c.at - ex) : Math.abs(c.at - ey);
        if (Math.max(dS, dE) > 400) { reject.push(c.axis + ':far' + Math.round(Math.max(dS, dE))); continue; }
        // ★ 真判据：走廊中段（新 L 形里那条平行段）到障碍物的距离必须 ≥ NEED。
        //   障碍物是 Track 时 geoDistSeg 已扣掉它的半线宽，即"到线段距离 ≤ w/2+间距"；
        //   Via/Hole 扣半径；Slot Region/Pad 按轮廓算。bbox 只用来挑候选位置，
        //   是否安全一律看这个距离 —— 旧实现只看 bbox 侧偏，轨道障碍物根本没有 bbox。
        // 【L 形拓扑必须按轴区分】改道是 S → corner1 → corner2 → E 三段：
        //   axis='x'（走廊垂直于 x）：corner1=(at,sy) corner2=(at,ey)   腿1 水平/中段 竖直/腿2 水平
        //   axis='y'（走廊垂直于 y）：corner1=(sx,at) corner2=(ex,at)   腿1 竖直/中段 水平/腿2 竖直
        // 旧实现把中段写死成 [sx,c.at,sx,ey]（竖直）、后面 c1/c2 也按 axis='x' 写死，
        // 于是 axis='y' 时中段就是**原线自己**、c1 与改后的原线完全重合、c2 把原水平段
        // 原样重建 —— 净效果是"一根铜没动、还多出两条重合铜"，fixed++ 照样记成功。
        // 实测 d13：21 次 trackRerouted 全是 axis='y'，违规数 4→3 后再不动，就是这条。
        const corner1 = c.axis === 'x' ? [c.at, sy] : [sx, c.at];
        const corner2 = c.axis === 'x' ? [c.at, ey] : [ex, c.at];
        const mid = [corner1[0], corner1[1], corner2[0], corner2[1]];
        // 【退化段守卫】走廊法建的是 L 形三段：原线改成 S→corner1，再补
        // c1 = corner1→corner2，c2 = corner2→E（具体端点按 axis 算，见上）。
        // 任一段为 0 就会在板上留下一个"铜点"：接不通任何东西，却会被 DRC 报成
        // Connection Error（本文件顶部 snapEnds 里的退化线段就是同一个病）。
        // 实测：水平走线 + 焊盘 的几何下 at = bx0 − NEED，mid 是退化的点段，而
        // geoDistSeg 对 pad 轮廓不扣线宽，算出来恰好 = NEED，`< NEED` 为假 →
        // 这条完全无意义的走廊被采纳 → c1 建成长度 0、宽 6.5mil 的线。
        // 正确做法是**换一条走廊**（水平走线应该走 y 轴那条），不是事后清理。
        // 顺序也决定必须在这里拦：snapEnds 跑在 fixClearance 之前，同一轮里管不到这里。
        if (Math.hypot(mid[2] - mid[0], mid[3] - mid[1]) < 1) { reject.push(c.axis + ':midDegen'); continue; }   // 中段退化
        // 两条短腿也不能为 0：为 0 就说明这条走廊其实**没有把线挪开**。
        // 旧写法只验「c2 沿 x 的长度」(`Math.abs(ex - cX) < 1`)，对 axis='y' 恒等于
        // |ex - sx|，永远不为 0 —— 守卫看着在，实际对退化情形完全失效。
        if (Math.hypot(corner1[0] - sx, corner1[1] - sy) < 0.01) { reject.push(c.axis + ':leg1zero'); continue; }  // 腿1 长度 0
        if (Math.hypot(ex - corner2[0], ey - corner2[1]) < 0.01) { reject.push(c.axis + ':leg2zero'); continue; }  // 腿2 长度 0
        // 走廊是**按 NEED 精确构造**的（at = 边 ± NEED），所以中段到障碍物的距离
        // 天然等于 NEED。用 `< NEED` 判就等于让"恰好相等"去赌浮点舍入：−1199−16.061
        // 再减回去可能落在 NEED 下面 1e-12，于是唯一可行的走廊被拒，违规原地不动。
        // 留 1e-3 mil 容差（物理上无意义，只为消除这个抛硬币），语义仍是"必须达到 NEED"。
        const NEED_EPS = 1e-3;
        const dMid = geoDistSeg(obs, mid[0], mid[1], mid[2], mid[3]);
        if (dMid < NEED - NEED_EPS) { reject.push(c.axis + ':mid' + Math.round(dMid * 100) / 100); continue; }
        // 【两条短腿也要验 —— 与中段同口径】
        // 中段合格不代表整条改道合格：corner 按包围盒边界 ±NEED 构造，若原线两端都在
        // 障碍物**同一侧**，"把中段搬到另一侧"的那条腿必然横扫整个盒宽。它长度不为 0
        // （上面的退化守卫拦不住），DRC 照样报 —— 等于改道自己制造新违规。
        // 实测 d12 expand：VBUS 被搬到 x=1040（槽盒 [1056,-1241,1081,-1217] 左侧，
        // 距 16 ≥ NEED 12），下一轮违规点却仍在 [1084,-1229]（槽**右**侧），cur 仅 4.60。
        // 旧判据只看 mid，这两条腿从未被检查过。
        //
        // 阈值用 **NEED - NEED_EPS**（不是"只要不穿过"）：走廊分支的契约是"三段都让开
        // 障碍物"。中段要求 NEED 而腿只要求"不穿过"，契约就自相矛盾 —— 会出现中段合格、
        // 腿却只有 5mil 的改道，既没消除违规，还把原线截短、多造两段铜，净效果更差
        // （实测 d13 就是这样把 1 处违规做成 2 处）。
        // 腿达不到 NEED ⇒ 这条走廊**本来就不可能修好这处违规**，换下一条才是正解；
        // 全部不达标就落 dogleg，或如实跳过。
        const dL1 = geoDistSeg(obs, sx, sy, corner1[0], corner1[1]);
        if (dL1 < NEED - NEED_EPS) { reject.push(c.axis + ':leg1_' + Math.round(dL1 * 100) / 100); continue; }   // 腿1 不够远
        const dL2 = geoDistSeg(obs, corner2[0], corner2[1], ex, ey);
        if (dL2 < NEED - NEED_EPS) { reject.push(c.axis + ':leg2_' + Math.round(dL2 * 100) / 100); continue; }   // 腿2 不够远
        chosen = c;
        break;
      }
      if (!chosen) {
        // 【诊断】四条走廊全被否时如实记下原因分布。注意不要在这里引用 `len`：
        // 它在狗腿段落里用 const 声明，此处引用会踩 TDZ 直接 ReferenceError。
        log('clearanceCorridorNone', {
          line: trackId, net: String(tl.getState_Net?.() || ''),
          need: Math.round(NEED * 100) / 100,
          segLen: Math.round(Math.hypot(ex - sx, ey - sy) * 100) / 100,
          box: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)],
          reject,
        });
        // 兜底：保端点绕行（dog-leg）。
        // 走廊法要求「绕开整个焊盘包围盒」，障碍物太大或走线太短时找不到走廊；
        // 但违规量与需求净距往往只差几 mil，只要把线段整体**平移到障碍物另一侧**
        // 就够。关键约束：**两个端点必须留在原位**，否则会拉断与焊盘的连接。
        // 做法：start → start+法向偏移 → end+法向偏移 → end，中段平行、两端短桩。
        const dirX = ex - sx, dirY = ey - sy;
        const len = Math.hypot(dirX, dirY);
        // 【静默放弃必须留痕】下面三处 continue 都等于「这条 Track 的违规这一轮
        // 不会被任何手段处理」：缩窄要么已到下限要么被 thinHopeless 判死，走廊一个都没选上，
        // 兜底平移又因为线段太短/坐标不可用做不了。旧实现三处全静默，
        // 于是「处理者存在但放弃了」与「这处根本没被看到」在日志里长得一模一样。
        // 单独成键，才能回答"为什么这些 Track 违规修不掉"。
        if (!(len > 1)) {
          log('clearanceSkipDegenerate', {
            line: trackId, net: String(tl.getState_Net?.() || ''),
            len: Math.round(len * 100) / 100, need: Math.round(needDist), cur: Math.round(curDist),
            why: '起终点几乎重合，L 形与平移都会造出零长/叠合线段',
          });
          continue;
        }
        if (!Number.isFinite(violX) || !Number.isFinite(violY)) {
          log('clearanceSkipNoPos', {
            line: trackId, net: String(tl.getState_Net?.() || ''),
            violX: String(violX), violY: String(violY),
            why: 'DRC 没给出可用违规坐标，无法判断该往障碍物哪一侧平移',
          });
          continue;
        }
        const nx = -dirY / len, ny = dirX / len;          // 线段的法向单位向量
        const mx = (sx + ex) / 2, my = (sy + ey) / 2;
        // 违规点在法向的哪一侧，就往反方向推
        // 【两侧都试】旧实现只按"违规点在法向哪一侧"把方向定死。
        // cur=0（走线整段压在焊盘上）时 (violX−mx, violY−my)·n 几乎是 0，
        // 侧别由浮点误差决定 ⇒ 有 50% 概率朝**障碍物那一侧**推，
        // 而那一侧无论推多远都更靠近障碍物，永远搜不到安全位置，
        // 最后被记成 clearanceSkipNoPush（"几何不允许"）——把一次方向选错
        // 说成了不可能。实测 d12（USBC_Power_ESD-20261126-020219）正是如此：
        // VBUS 走线 4bf55c5b7faff38f 压在异网 SMD 焊盘 38efc03d85167ad4e36 上，
        // cur=0、need=5.98，缩窄只补 1.75mil、四条走廊双腿都不够、平移 40mil 也搜不到。
        // 两侧都试只会**多**找到可行解，不会引入新风险：安全与否仍由 geoDistSeg 判。
        let side = ((violX - mx) * nx + (violY - my) * ny) >= 0 ? -1 : 1;
        const base = Math.min(Math.max((Number.isFinite(needDist) && Number.isFinite(curDist))
          ? (needDist - curDist) + 4
          : 8, 6), 40);
        // 平移量必须由**真实几何**验证：从 base 起每 2mil 试探，取第一个让「中段」到
        // 障碍物 ≥ NEED 的量（上限 40mil：太小没用、太大毁布局）。
        // 旧实现只按 (need-cur)+4 平移、完全不看几何 —— 平移后可能仍压在障碍物上，
        // 于是"修完还是 minDistance:0"，而且下一轮还会再修一次。
        let push = 0;
        let pushSide = 0;
        for (const sd of [side, -side]) {
          for (let p = base; p <= 40.001; p += 2) {
            if (geoDistSeg(obs, sx + nx * sd * p, sy + ny * sd * p,
                           ex + nx * sd * p, ey + ny * sd * p) >= NEED) {
              push = p; pushSide = sd; break;
            }
          }
          if (push) break;
        }
        if (push && pushSide !== side) {
          // 记下来：这不是"锦上添花"，而是"原方向根本不可行"这一事实的证据。
          // 没有它，日志里只看得到一次成功，看不出旧实现会在这里放弃。
          log('clearanceFlippedSide', {
            line: trackId, net, obstacleType,
            first: side, used: pushSide, push: Math.round(push * 100) / 100,
            need: Math.round(needDist), cur: Math.round(curDist),
          });
          side = pushSide;
        }
        if (!push) {
          // 几何上平移不出安全位置（例如障碍物横穿线中点，只有断开重连才行）：
          // 放弃这一处，而不是做一个"看起来像修好了"的动作去制造新违规。
          // 【只增记录，不改铜】这一处为什么"平移不出解"必须自带证据，
          // 否则只能靠离线重建 Gerber 去猜障碍物真实形状 —— 猜错过一次，
          // 而且离线重建漏掉 G03 圆弧，"没找到"不等于"不存在"。
          // bestAt40 = 两侧各推到上限 40mil 时中段到障碍物的最大距离；
          // 与 need 的差才是"几何上差多少"，而不是"没试过"。
          let bestAt40 = -1;
          for (const sd40 of [side, -side]) {
            const d40 = geoDistSeg(obs, sx + nx * sd40 * 40, sy + ny * sd40 * 40,
                                        ex + nx * sd40 * 40, ey + ny * sd40 * 40);
            if (d40 > bestAt40) bestAt40 = d40;
          }
          log('clearanceSkipNoPush', {
            line: trackId, net, obstacleType, objId: String(obstacleId || ''),
            geoKind: obs.kind, need: Math.round(needDist), cur: Math.round(curDist),
            bothSidesTried: true,
            padKind, layerNo: Number(layer),
            obsSrc: obs.src || 'contour',
            obsBox: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)],
            obsWH: [Math.round(bx1 - bx0), Math.round(by1 - by0)],
            viol: [Math.round(violX), Math.round(violY)],
            mid: [Math.round(mx), Math.round(my)],
            segLen: Math.round(len), base: Math.round(base),
            bestAt40: Math.round(bestAt40 * 100) / 100,
          });
          continue;
        }
        // ★ 长度启发式补上**几何判据**（原来只有长度，没有几何）。
        //   `len < push*4` 是"端桩够不够长"的**代理量**，而端桩安不安全完全由几何决定：
        //   短线段 + 端桩本来就够远，是可做的。走廊分支对两条短腿验的是真几何
        //   （L3110-3113 的 dL1/dL2），这里却只看长度 —— 同一份判据两套口径。
        //   实测（d12 `USBC_Power_ESD-20261126-053328` 尝试2，`_log-2-expand-1.25x.json`）：
        //     clearanceSkipTooShort {line a3b2576ffbeedc59, net VBUS,
        //                            len 41.76, push 11.98, need 5.98, cur 0}
        //   4*push = 47.92 只是**刚刚**超过 len；走廊一条都没选上，平移又被这条长度
        //   规则否掉 ⇒ 这一处成为板上**唯一**违规，整块板判 FAIL（drcLeafCount 1）。
        //   严格化方向：腿不够远就照旧放弃（对本障碍物的净距不新增风险），腿够远才放行（纯加能力）。
        let legsOk = true, legA = -1, legB = -1;
        if (len < push * 4) {
          const legEps = 1e-3;
          legA = geoDistSeg(obs, sx, sy, sx + nx * side * push, sy + ny * side * push);
          legB = geoDistSeg(obs, ex, ey, ex + nx * side * push, ey + ny * side * push);
          legsOk = legA >= NEED - legEps && legB >= NEED - legEps;
          if (!legsOk) {
            // 长度短**且**端桩达不到 NEED ⇒ 几何确实不允许，如实放弃。
            log('clearanceSkipTooShort', {
              line: trackId, net: String(tl.getState_Net?.() || ''),
              len: Math.round(len * 100) / 100, push: Math.round(push * 100) / 100,
              need: Math.round(needDist), cur: Math.round(curDist),
              legA: Math.round(legA * 100) / 100, legB: Math.round(legB * 100) / 100,
              why: 'len < push*4 且两条端桩也达不到 NEED（几何不允许）',
            });
            continue;
          }
          // 放行时留痕：这条日志是"长度启发式在此案上过严"的证据，也是回归时可搜的键。
          log('clearanceShortDogleg', {
            line: trackId, net: String(tl.getState_Net?.() || ''),
            len: Math.round(len * 100) / 100, push: Math.round(push * 100) / 100,
            need: Math.round(needDist), cur: Math.round(curDist),
            legA: Math.round(legA * 100) / 100, legB: Math.round(legB * 100) / 100,
            why: 'len < push*4 但两条端桩都 ≥ NEED ⇒ 长度启发式过严，放行狗腿',
          });
        }
        const ox = nx * side * push, oy = ny * side * push;
        const wNow = Math.min(curW || 6.5, 6.5);
        // 和下面 L 形拐弯同样的危险性：modify 先把原走线截短到 (sx+ox, sy+oy)，
        // 一旦后面的 create 抛异常，原终点 (ex,ey) 就**没有铜连回去**了 ——
        // 修复动作自己造出一个断点，比原来的间距违规严重得多。
        // 实测 d13 的两条 Connection Error(obj1=VBAT 走线 5787848ddd4dfd27 /
        // 770556681b91782f，正是 trackFixErr 抛异常的那两条)就是这么来的。
        // 所以必须记下已建线段，失败时连同原终点一起回滚。
        const madeHere = [];
        try {
          // ★ modify 失败是 resolve(undefined) 而不抛；不判它就会带着"原样没变"的
          //   线继续 create，于是新建段与原线**重叠成铜**，可能制造新违规，
          //   再触发整轮回滚把本轮真修复一起退掉。抛出去交给下面的 catch 走回滚。
          const md = await eda.pcb_PrimitiveLine.modify(trackId, { endX: sx + ox, endY: sy + oy });
          if (md === undefined) throw new Error('dogleg modify returned undefined');
          // 确认真的截短之后才记"改之前的端点"：记在成功之前，一次静默失败
          // 就会让整轮回滚去"恢复"一处从未发生的改动（fixedGivenBack 虚高）。
          recMod(trackId, { endX: ex, endY: ey });
          const m1 = await eda.pcb_PrimitiveLine.create(net, layer, sx + ox, sy + oy, ex + ox, ey + oy, wNow);
          recNew(m1);
          const m1id = m1?.getState_PrimitiveId?.();
          if (m1id) madeHere.push(m1id);
          // create 失败是**静默**的（返回类型 IPCB_PrimitiveLine|undefined，不抛异常）。
          // 若 m1 没建出来却继续往下建 m2，原线已截短、m2 从偏移点起步，
          // 中间那 100% 是空的 —— 修复动作把一条线变成了断网，还照 fixed++ 记成功。
          // 抛出即交给下面的 catch 走完整回滚。
          if (!m1id) throw new Error('dogleg create1 returned no object');
          const m2 = await eda.pcb_PrimitiveLine.create(net, layer, ex + ox, ey + oy, ex, ey, wNow);
          recNew(m2);
          const m2id = m2?.getState_PrimitiveId?.();
          if (m2id) madeHere.push(m2id);
          if (!m2id) throw new Error('dogleg create2 returned no object');
        } catch (e4) {
          // 起因单独成键；回滚结果由 rollbackLineFix 逐项上报，不再混在一行里
          log('trackDoglegFixFail', { line: trackId, net,
            made: madeHere.length, m: String(e4 && e4.message).slice(0, 100) });
          await rollbackLineFix('dogleg', trackId, net, madeHere, ex, ey);
          continue;
        }
        fixed++;
        log('trackDogleg', { line: trackId, net, obstacle: obstacleType, obstacleType,
          objId: String(obstacleId || ''), geoKind: obs.kind, padKind,
          need: Math.round(needDist), cur: Math.round(curDist), push: Math.round(push),
          side, len: Math.round(len),
          bBox: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)] });
        continue;
      }

      // 原斜线改成「起点 → 走廊拐点」，再补两段回到原终点（L 形）
      // ★ 两个拐点必须按轴算，且与上面走廊选择里的 corner1/corner2 用同一套公式：
      //   axis='x' → (at,sy)、(at,ey)；axis='y' → (sx,at)、(ex,at)。
      //   旧写法 `cornerY = axis==='y' ? at : sy` 配上 `c1=(cornerX,cornerY)→(cornerX,ey)`
      //   与 `c2=(cornerX,ey)→(ex,ey)`，只对 axis='x' 成立；axis='y' 时三段全落在原线上。
      const lx1 = chosen.axis === 'x' ? chosen.at : sx;
      const ly1 = chosen.axis === 'x' ? sy : chosen.at;
      const lx2 = chosen.axis === 'x' ? chosen.at : ex;
      const ly2 = chosen.axis === 'x' ? ey : chosen.at;
      // 危险点：modify 先把原走线截短，后面 create 若抛异常，
      // 板上就剩一截断头线 —— **修复动作破坏了连通性**，比原来的间距违规严重得多。
      // 实测 trackFixErr 就是这个位置抛出来的（'primitiveId' of undefined）。
      // 所以失败必须回滚到原终点。
      // ★ 这一句原来在 try **之外**，且不看返回值。modify 失败时原线仍到 (ex,ey)，
      //   随后 create 的 c1/c2 与原线重叠成铜 —— 修复动作自己制造新违规。
      const mL = await eda.pcb_PrimitiveLine.modify(trackId, { endX: lx1, endY: ly1 });
      if (mL === undefined) {
        log('trackCornerUnconfirmed', { line: trackId, net,
          want: [Math.round(lx1 * 10) / 10, Math.round(ly1 * 10) / 10] });
        continue;   // 截短没生效 → 放弃这一处，不做重叠铜
      }
      // 同上：只有真的改了才记"改之前的端点"
      recMod(trackId, { endX: ex, endY: ey });
      const madeL = [];
      try {
        const c1 = await eda.pcb_PrimitiveLine.create(net, layer, lx1, ly1, lx2, ly2, 6.5);
        recNew(c1);
        const c1id = c1?.getState_PrimitiveId?.();
        if (c1id) madeL.push(c1id);
        // 同 dogleg：create 静默失败时不抛异常，只看返回值。
        if (!c1id) throw new Error('L create1 returned no object');
        const c2 = await eda.pcb_PrimitiveLine.create(net, layer, lx2, ly2, ex, ey, 6.5);
        recNew(c2);
        const c2id = c2?.getState_PrimitiveId?.();
        if (c2id) madeL.push(c2id);
        if (!c2id) throw new Error('L create2 returned no object');
      } catch (e2) {
        // 第一段成功、第二段失败时，第一段会变成一条**悬空短线**：
        // 它不连到原终点，白占铜、还可能自己触发新的间距违规。
        // 起因单独成键；删/改的结果由 rollbackLineFix 逐项上报（n + ids）。
        log('trackRerouteFixFail', { line: trackId, net, made: madeL.length,
          m: String(e2 && e2.message).slice(0, 100) });
        await rollbackLineFix('L', trackId, net, madeL, ex, ey);
        continue;
      }
      fixed++;
      log('trackRerouted', { line: trackId, net, corridor: chosen.axis,
        at: Math.round(chosen.at), padKind,
        obstacleType, objId: String(obstacleId || ''), geoKind: obs.kind,
        // 【这里已删除 geoTrusted 字段】它原先是 `obs.src !== 'bbox'`，用来从日志里
        // 分辨"几何读到了"和"几何是猜的"。但 L2880 的早退守卫已经把 src==='bbox'
        // 一律拦在上面（clearanceSkipNoGeo），所以到了这一行它**恒为 true** ——
        // 一个永远为真的判据没有判别力，比没有更糟：它看起来在报平安。
        // 需要判断几何来源时看 obsSrc / clearanceSkipNoGeo，那两个才真的会变。
        obsSrc: obs.src || 'contour',
        need: Math.round(needDist), cur: Math.round(curDist),
        padBBox: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)] });
    } catch (e) { log('trackFixErr', { id: trackId, m: String(e && e.message).slice(0, 120) }); }
  }
  // 本轮没有被任何处理者认领的违规类。非空 ⇒ 板上存在**结构性无人处理**的违规，
  // 无论 fixed 涨了多少都不可能收敛，必须换策略（加处理者 / 改规则 / 改器件）。
  if (noHandler.size || noLineFail.length) {
    // n 按违规条数计（已去重）。uncovered 合计应与本轮 clearanceUnclaimable.n 相等 ——
    // 两者用同一判据、同一数据源，对不上就说明记账又错了。
    const uncovered = [...noHandler.values()].filter(c => c.bucket === 'uncovered');
    const covered = [...noHandler.values()].filter(c => c.bucket === 'covered');
    log('clearanceNoHandler', {
      round, uncovered, covered,
      uncoveredTotal: uncovered.reduce((a, c) => a + c.n, 0),
      noLineTotal: noLineFail.length,
      noLineSample: noLineFail.slice(0, 4),
      noLineWhy: 'noLine = 处理者存在但当场失败（pcb_PrimitiveLine.get 返回空），'
              + '既不算 uncovered（两侧都不是 Via/Track）也不算 covered（另一环已认领）；'
              + '并进 covered 会把失败记成正常分工，所以单独一栏',
      why: 'uncovered = 两侧都不是 Via/Track，确实没有任何处理者，每轮原样带过；'
         + ' covered = 已由另一个环认领（正常分工，不是缺陷，列出来只为对账）',
    });
  }
  clearanceFixes += fixed;
  prevFixed = fixed;
  log('clearanceRound', { round, violations: clears.length, fixed });
  // 本轮全部违规都无人认领 ⇒ 板上没有任何铜会因为再跑一轮而改变。
  // 放在 clearanceRound **之后**退出，这样时间序列不缺环 —— 缺环会被离线统计
  // 误读成"这一轮没跑"，而事实是"跑了、且确定性地动不了"。
  if (allUnclaimable) {
    log('clearanceAllUnclaimable', {
      round, violations: clears.length,
      why: '本轮全部违规两侧都不是 Via/Track，无任何处理者；再跑轮次不会改动铜，提前退出',
    });
    break;
  }
  // 判据只看**板上结果**，不问动作成不成功：fixed 数的是"变更 API 接受了"，
  // 与"这处间距真的变好了"脱钩（本文件里 modify/delete 失败都是返回值不是异常，
  // 所以 fixed 从来只能证明"调用没报错"）。违规数连续两轮不降 = 这个方向修不动了。
  // 注意不能用 prevClearCount 当基准：它在**每轮开头**被赋成本轮的值（L1896），
  // 到轮末已经是自己，比出来恒等 —— 必须另记一个"上一轮末尾"的值。
  if (lastClearCount !== null && clears.length >= lastClearCount) noProgressRounds++;
  else noProgressRounds = 0;
  lastClearCount = clears.length;
  if (noProgressRounds >= 2) {
    log('clearanceNoProgress', { round, violations: clears.length, stuckAt: lastClearCount,
      fixes: clearanceFixes, rounds: round + 1 });
    break;
  }
  if (!fixed) break;
  try { if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
  await eda.pcb_Document.save();
  await sleep(1200);
}
// 轮数用完仍有残留时必须明说，否则日志里只有 0/1/2 轮，看起来像"自己好了"
if (clearanceFixes > 0 && left() < 90000) {
  log('clearanceBudgetStop', { fixes: clearanceFixes, leftMs: left() });
}
log('clearanceFixes', clearanceFixes);

// ---------- 8.5 兜底补线（连通性修复）----------
// 旧逻辑是 `if (pourCount > 0) 整段跳过`，理由写的是「覆铜本身会连接所有同网焊盘」。
// 但离线统计 86/86 个日志全部跳过、patchDrc 累计 0.0s —— 也就是说**唯一的连通性
// 修复通路等于全失效**；而 18 个失败设计里 14 个含连通错误（75 处 Track/Via/Pad 断开）。
// 「板上存在铺铜」不等于「铺铜连通了 DRC 报的这些焊盘」：DRC 既然仍报
// Connection Error，就说明确实没连通。所以不能因为有铺铜就放弃补线。
// 另有一处叠加 bug：net/pos 取的是扁平节点上的 v.net，而 DRC 实际把它们放在
// explanation.errData.net / .position 里，于是即便进了循环也会被 `if (!net || !pos)`
// 全部跳过。两处都修。补线本身可能制造间距违规（d6/d7 的老教训），
// 所以每轮补完**立即复检**：违规变多就整轮回滚，保证"修复"不会让板子更糟。
await shot('pcb-clearance');
// ---------- 8.4b clearance 之后重放被删掉的 EP 过孔 ----------
// 【为什么必须有这一步】clearance 把 EP 过孔当间距违规删掉是**对的**（有一例那个孔距相邻
// 焊盘只有 20.6mil，留着就是短路）。错的是删完之后没人补回来：缝合阶段(stitchGaps)在
// clearance **之前**就跑完了，而且**它本来就不插过孔**（只补铜线段，stitchedTotal 记的是线段数），
// 所以不存在"缝合会替我们补上孔"这条退路。删掉那一个 EP 过孔之后，若板上没有其它跨层 GND 通路，
// L1 的 GND 盘与 L2 的 GND 轨道就"贴合但跨层无连接" → DRC 报 Connection
// Error，板子报废。电学上 Clearance Error（能用、可人工微调）严格优于 Connection Error
// （断网、报废），所以"在原 EP 盘内换一个更远的位置重放一个孔"这个交易方向是对的。
// 判据本来就在本文件里：patchIslandPair 的 note 写着"两对象已贴合仍判不连通 → 死铜孤岛
// 或 过孔盘未覆盖线端；局部补铜无效"——它已经点名要补过孔，而当时只做了补铜然后撤回。
if (epViaRecs.length && left() > 120000) {
  phase('restitchEp');
  let restitched = 0;
  for (const rec of epViaRecs) {
    // alive 必须是**三态**：true=还在 / false=确实没了 / null=无法判定。
    // 旧写法把"读不到 id"当成 false，于是过孔明明还在也会再放一个 → 重复孔。
    // 一个重复孔是新增风险，而漏补只是维持已知失败。无法判定时允许漏补。
    let alive = null;
    if (rec.viaId) {
      try { alive = !!(await eda.pcb_PrimitiveVia.get(rec.viaId)); }
      catch (e) { alive = null; }
    }
    if (alive === true) { log('epViaAlive', { num: rec.num, via: rec.viaId }); continue; }
    if (alive === null) {
      log('epRestitchUnknown', { num: rec.num, pad: [Math.round(rec.x), Math.round(rec.y)],
        viaId: rec.viaId,
        why: '读不到过孔 id 或 get 抛异常 → 无法判定它是否还在；宁可漏补也不重复放孔' });
      continue;
    }
    // 朝"离最近非 GND 焊盘更远"的方向后退。
    // 【步长必须小、顺序必须由近到远】那个孔被删时 minDistance 8.556 / need 11.811，
    // 只差 3.25mil；所以"原偏移 +4"就够，一步挪到 37mil 是**新的扰动**（可能撞上别的铜），
    // 而扰动越小，越接近原设计意图。由近到远逐级退，第一个放得下的就用。
    const baseOff = Number.isFinite(rec.off) ? rec.off : 0;
    const startOff = baseOff > 0 ? baseOff + 4 : 8;
    let dx = 0, dy = 1;
    if (Number.isFinite(rec.nearX) && Number.isFinite(rec.nearY)) {
      const ex = rec.x - rec.nearX, ey = rec.y - rec.nearY;
      const el = Math.hypot(ex, ey);
      if (el > 1e-6) { dx = ex / el; dy = ey / el; }
    }
    let box = null;
    try {
      const bb = await eda.pcb_Primitive?.getPrimitivesBBox?.([String(rec.padId)]);
      if (bb) {
        const bx0 = Number(bb.minX), by0 = Number(bb.minY), bx1 = Number(bb.maxX), by1 = Number(bb.maxY);
        if ([bx0, by0, bx1, by1].every(Number.isFinite) && bx1 > bx0 && by1 > by0) box = [bx0, by0, bx1, by1];
      }
    } catch (e) { box = null; }
    const R = 9.85 + 2;   // 过孔半径 + 余量：位置必须留得下整个孔
    // 【读不到焊盘盒就不猜】孔必须落在 EP 盘铜上才能把 L1 盘接进 L2 覆铜。
    // 旧写法 `if (box && …)` 在 box 为 null 时会**放行所有候选**，等于
    // "不知道盘多大，那就随便放"——孔可能落到盘外，照样不连通，还多了个铜。
    // 未知的盒不能默认"都行"，这与本文件"算小了会放行压线的走廊"是同一条规矩。
    // 上限 40mil：EP 盘再小也能容下（40+11.85 = 51.85，对应 ≥104mil 宽的盘）。
    const cands = [];
    if (box) {
      for (let k = 0; k < 8; k++) {
        const off = startOff + k * 5;
        if (off > 40) break;
        const cx = rec.x + dx * off, cy = rec.y + dy * off;
        if (cx - R < box[0] || cx + R > box[2] || cy - R < box[1] || cy + R > box[3]) continue;
        cands.push({ off, cx, cy });
      }
    }
    let placed = null;
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci];
      try {
        const v2 = await eda.pcb_PrimitiveVia.create('GND', c.cx, c.cy, 11.8, 19.7);
        if (v2) { placed = c; break; }
        log('epRestitchEmpty', { num: rec.num, off: c.off });
      } catch (e) {
        log('epRestitchErr', { num: rec.num, off: c.off, m: String(e && e.message).slice(0, 90) });
        break;
      }
    }
    if (placed) {
      restitched++;
      log('epViaRestitched', { num: rec.num, pad: [Math.round(rec.x), Math.round(rec.y)],
        from: rec.off, to: placed.off, at: [Math.round(placed.cx), Math.round(placed.cy)],
        padWH: box ? [Math.round(box[2] - box[0]), Math.round(box[3] - box[1])] : null,
        why: 'clearance 删掉了 EP 唯一层间过孔，GND 缝合 stitchedTotal=0 不会补，必须在此重放' });
    } else {
      log('epRestitchNone', { num: rec.num, pad: [Math.round(rec.x), Math.round(rec.y)],
        box: box ? box.map(v => Math.round(v)) : null,
        cands: cands.map(c => c.off),
        why: box ? '所有候选位置都落在 EP 盘外（或 create 失败），宁可放弃也不把孔放到盘外'
                   : '读不到 EP 焊盘包围盒 → 无法保证孔落在盘铜上，放弃重放（不猜）' });
    }
  }
  log('epRestitch', { pads: epViaRecs.length, restitched });
  if (restitched) {
    try { await eda.pcb_Document.save(); } catch (e) { }
    await sleep(600);
  }
} else if (epViaRecs.length) {
  log('epRestitchBudgetSkip', { pads: epViaRecs.length, leftMs: left() });
}
phase('patchDrc');
let patchCount = 0;
for (let round = 0; round < 3; round++) {
  if (left() < 60000) { log('patchBudgetSkip', { round, leftMs: left() }); break; }
  let details = null;
  try { details = await eda.pcb_Drc.check(true, false, true); } catch (e) { break; }
  const flat = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.errorType) flat.push(node);
    if (node.list) walk(node.list);
  };
  walk(details);
  const beforeCount = flat.length;
  const connErrs = flat.filter(n => n.errorType === 'Connection Error');
  // 【免费测点：fixClearance 收尾后的第一手断连数】不额外调用 DRC —— 它取自
  // patchDrc 本来就要跑的这一次检查，所以对收尾耗时零成本。
  // 动机（实测）：conn-rca 统计 118 份日志，39 次"路由自报 stillUnconnected=0"里有 6 次
  // 最终 DRC 仍报断连；另有 4/14 次 SMD 断连运行在缝合阶段测到 0 条，断连是之后才出现的。
  // 也就是说"布不通"和"被后续阶段弄断"是两类病，而日志分不清它们。
  // 这条与 drc 阶段的 connBeforePour（patchDrc 之后）、最终 drcLeaves 三点连成一条线：
  //   fixClearance 弄断 → 这里就 >0
  //   patchDrc 弄断     → 这里 0 而 connBeforePour > 0
  //   覆铜重建弄断      → connBeforePour 0 而最终 > 0
  // 只记第 0 轮：后面几轮的数值受本轮补线影响，不能当"进入 patchDrc 时的状态"。
  if (round === 0) {
    log('connAfterClearance', {
      n: connErrs.length,
      clear: flat.filter(n => n.errorType === 'Clearance Error').length,
      total: flat.length, leftMs: left(),
    });
  }
  if (!connErrs.length) { log('patchDone', { round, remaining: flat.length }); break; }

  // ---- 本轮断连涉及的对象几何索引 ----
  // 只索引"有连通错误的那几个网"上的对象：全板对象有几百个，逐个 get 会把收尾拖爆。
  const connNets = new Set(connErrs
    .map(v => String((v.explanation?.errData || {}).net || '').toUpperCase()).filter(Boolean));
  const geo = new Map();
  try {
    for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
      try {
        const p = await eda.pcb_PrimitivePad.get(id);
        const n = String(p?.getState_Net?.() || '').toUpperCase();
        if (!connNets.has(n)) continue;
        geo.set(String(id), { k: 'pad', net: n, layer: Number(p.getState_Layer?.()),
          x: Number(p.getState_X()), y: Number(p.getState_Y()) });
      } catch (e) { }
    }
    for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
      try {
        const l = await eda.pcb_PrimitiveLine.get(id);
        const n = String(l?.getState_Net?.() || '').toUpperCase();
        if (!connNets.has(n)) continue;
        geo.set(String(id), { k: 'line', net: n, layer: Number(l.getState_Layer?.()),
          x: Number(l.getState_StartX()), y: Number(l.getState_StartY()),
          x2: Number(l.getState_EndX()), y2: Number(l.getState_EndY()) });
      } catch (e) { }
    }
    for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
      try {
        const vv = await eda.pcb_PrimitiveVia.get(id);
        const n = String(vv?.getState_Net?.() || '').toUpperCase();
        if (!connNets.has(n)) continue;
        // dia / viaType 是 slot-geo 在 api-types.d.ts:15434 / 15460 核实过的读法。
        // 内核判连通只看"线端是否落在过孔盘(dia/2)内"和"孔是否覆盖该层"，
        // 不看中心距 —— 少了这两个值就永远解释不了"贴在一起却报不连通"。
        geo.set(String(id), { k: 'via', net: n, layer: null,
          dia: Number(vv.getState_Diameter?.()), viaType: Number(vv.getState_ViaType?.()),
          x: Number(vv.getState_X()), y: Number(vv.getState_Y()) });
      } catch (e) { }
    }
  } catch (e) { log('patchGeoErr', String(e && e.message).slice(0, 100)); }

  // 把点投影到线段上（处理平行/共线的重叠走线，否则只看端点会算出一个假的大间距）
  const proj = (o, px, py) => {
    if (o.k !== 'line') return [o.x, o.y];
    const dx = o.x2 - o.x, dy = o.y2 - o.y;
    const L2 = dx * dx + dy * dy;
    if (!(L2 > 0)) return [o.x, o.y];
    let t = ((px - o.x) * dx + (py - o.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return [o.x + t * dx, o.y + t * dy];
  };
  const ptsOf = (o) => (o.k === 'line' ? [[o.x, o.y], [o.x2, o.y2]] : [[o.x, o.y]]);
  const closestPair = (o1, o2) => {
    let best = null;
    const consider = (ax, ay, bx, by) => {
      const d = Math.hypot(bx - ax, by - ay);
      if (!best || d < best.d) best = { d, ax, ay, bx, by };
    };
    for (const [ax, ay] of ptsOf(o1)) { const [bx, by] = proj(o2, ax, ay); consider(ax, ay, bx, by); }
    for (const [bx, by] of ptsOf(o2)) { const [ax, ay] = proj(o1, bx, by); consider(ax, ay, bx, by); }
    return best;
  };

  // 对每个断连对象：找同网最近的可达节点，用底层走线绕开顶层焊盘（最稳）
  const patchCreated = [];      // 本轮新建的过孔/走线，复检变差时整轮删掉
  const targets = [];           // 本轮"打算修"的断点，复检后逐个对账（见 patchPerErr）
  // 只删本条新建的对象。旧代码在 patchNoObj 分支直接 continue，
  // 已经把过孔 create 出来却留在板上（每次 1~2 个 24/12mil 无铜孤孔），
  // 而 patchCreated 只有"整轮总数变差"才清 —— 净值不变/变好时这些孤孔永久留下。
  // ★ `delete` 的失败方式是 **resolve false**，不是抛异常。
  //   原实现 `return true` 无条件写死 —— 只要不抛就算删成功，
  //   于是 24/12mil 无铜孤孔与大段补铜**永久留在板上**（正是上面注释点名的那个 bug
  //   换了个入口：以前是"不删"，现在是"以为删了"）。
  //   返回值是权威凭据，必须 `=== true` 才算成功。
  const delObj = async (c) => {
    try {
      const r = (c.kind === 'via')
        ? await eda.pcb_PrimitiveVia.delete(c.id)
        : await eda.pcb_PrimitiveLine.delete(c.id);
      return r === true;
    } catch (e) { return false; }
  };
  const rollbackMine = async (mine) => {
    if (!mine || !mine.length) return 0;
    let n = 0;
    const fail = [];
    for (const c of mine.slice().reverse()) {
      if (await delObj(c)) {
        n++;
        // 已删掉的不能再留在整轮回滚清单里，否则整轮回滚时会去删一个不存在的 id
        const k = patchCreated.findIndex(x => x.id === c.id);
        if (k >= 0) patchCreated.splice(k, 1);
      } else {
        // 删失败的对象**必须留在 patchCreated 里**：以前无论删没删都 splice，
        // 于是整轮回滚再也不会重试它，垃圾铜就成了板上永久残留。
        fail.push(String(c.id));
      }
    }
    if (fail.length) log('patchRollbackFail', { n: fail.length, ids: fail.slice(0, 12) });
    return n;
  };
  for (const v of connErrs) {
    // DRC 的 net / position 在 explanation.errData 里，不在扁平节点顶层。
    // 旧代码只取 v.net（永远是 undefined），所以即便绕过 pourCount 也会全部 continue。
    const ed = v.explanation?.errData || {};
    const net = v.net || ed.net || ed.objNet;
    // 【单位换算，不能省】DRC 的 position 是**画布单位**，1 mil = 10 单位
    // （本文件另有三处同款换算：L1074、L1311、L1719）。
    // 而下面 geo 里焊盘/过孔坐标是 mil。不换算直接比距离，最近节点会选到
    // 隔着十几毫米的另一个同网节点上，于是在跟断点毫无关系的位置打两个过孔、
    // 拉一条底层长铜 —— 面上的 net 对，实际全是垃圾铜，而且照 fixed++ 记成功。
    const edPos = ed.position;
    const pos = edPos ? { x: Number(edPos.x) * 10, y: Number(edPos.y) * 10 } : v.pos;
    if (!net || !pos) { log('patchNoNet', { err: String(ed.globalIndex || ''), obj1: String(ed.obj1 || '') }); continue; }
    // ---- 用 DRC 给的 obj1/obj2 定位"到底哪两段铜没连上" ----
    // 旧实现取"离断点最近的同网节点"与"第二近的同网节点"，而第二近的可能在板子另一头
    // （d6 实测 400mil），于是在底层拉一条贯穿整板的长铜：补前 2 处违规 → 补后 21 处，
    // 19 处是它自己造的。DRC 已经明确给出断开的是哪两个对象，
    // 正确做法就是连这两个对象之间**最近的一对点**，并对间距设上限。
    const nameNet = String(net).toUpperCase();
    // 【单对象断连：配对补出另一端】`IPCB_ViolationBase.obj2` 是**可选字段**
    // （api-types.d.ts:8346），内核不保证给全。d13 实测 2 处 SDA 断连各自只带 1 个
    // 对象（一条过孔 6a999d…、一条走线 56e379…），两者中心距 0，于是旧代码走
    // patchNoGeo 直接放弃。同网同时出现两条"各带一个不同 id 的单对象错误"，
    // 它们就是被拆开上报的同一对。这里只用于**诊断配对**，不据此直接补铜。
    const obj2Raw = String(ed.obj2 || '');
    let obj2Synth = '';
    if (!obj2Raw) {
      const myId = String(ed.obj1 || '');
      const peer = connErrs.find(w => {
        const d2 = w.explanation?.errData || {};
        if (String(w.net || d2.net || '').toUpperCase() !== nameNet) return false;
        const pid = String(d2.obj1 || '');
        return !!pid && pid !== myId && !String(d2.obj2 || '');
      });
      if (peer) {
        const pd = peer.explanation?.errData || {};
        obj2Synth = String(pd.obj1 || '');
        log('patchPairSynth', { net, o1: myId, o2: obj2Synth,
          t1: ed.obj1Type || null, t2: pd.obj1Type || null });
      }
    }
    const o1 = geo.get(String(ed.obj1 || ''));
    const o2 = geo.get(obj2Raw || obj2Synth || '');
    if (!o1 || !o2) {
      log('patchNoGeo', { net, o1: String(ed.obj1 || ''), t1: ed.obj1Type || null,
        o2: obj2Raw, t2: ed.obj2Type || null, synth: obj2Synth || null,
        has1: !!o1, has2: !!o2, indexed: geo.size });
      continue;
    }
    const cp = closestPair(o1, o2);
    if (!cp || !Number.isFinite(cp.d)) continue;
    // 【孤岛，不是断线】d6 实测：DRC 指认的两个对象是"D1_2 焊盘"与"走线 e446"，
    // connDiag 显示两者相距 0.5mil，且该焊盘同层还有 dist=0 的 GND 铜。
    // 两者都已贴在一起却判不连通 —— 它们是同一块**死铜孤岛**上的两个图元
    //（该板 GND 铺铜被切成了 82 块孤岛）。在这种情况里画一条 0.5mil 的线
    // 只是把孤岛内部接得更牢，孤岛仍然不接主网，DRC 一个也不会少。
    // d6 的 stitch 已经证过一次：它画了 44mil 铜去连远处的锚点，
    // 结果 round0 修了 2 个，round1 立刻 dupSkipped 2 个 —— 白干。
    // 所以这一类的正确处置是**如实记下来交给策略升级/改板**，而不是再画铜。
    if (cp.d <= 1.0) {
      // 【先分层，再谈孤岛】d<=1.0 只说明两者在 XY 上已经贴合，它**推不出**
      //   补铜无效。实测 2026-11-26 01:24（gen-rp2040 / smart-fit）：DRC 指认的
      //   两者是 GND 的 Track 与 SMD Pad、相距 0.01，判不连通。旧代码一律归入
      //   「死铜孤岛」跳过，可它们根本不在同一层 —— 差的是一个过孔，不是一段铜。
      //   下面二十多行本来就有跨层修复（两端各打一孔 + 底层直连），
      //   但被这个 continue 挡在门外，永远走不到。
      //
      //   跨层近距离**只打一个孔**：此时 cp 两端相距 0.01，若沿用「两端打孔 +
      //   连线」会造出一条 0.01mil 的线段，而零长线段会把网表变成断路
      //   （2026-11-25 实测事故）。一个孔径 24（半径 12）的孔已同时盖住两端。
      //
      //   层的读数必须**先排除缺失再转数字**：Number(null) === 0，直接 Number()
      //   会把「层未知」变成合法层号 0，于是和 1/2 层一比就成了跨层，在错的
      //   位置打一个孔。读数缺失绝不能编码成合法值。
      const layerNear = (o) => {
        if (o.k === 'via') return NaN;                 // 过孔本就跨层，不参与比层
        if (o.layer === null || o.layer === undefined || o.layer === '') return NaN;
        return Number(o.layer);
      };
      const laNear = layerNear(o1);
      const lbNear = layerNear(o2);
      const crossLayer = Number.isFinite(laNear) && Number.isFinite(lbNear) && laNear !== lbNear;
      if (crossLayer) {
        const cx = cp.ax, cy = cp.ay;
        const cv = await eda.pcb_PrimitiveVia.create(net, cx, cy, 12, 24);
        const cvid = cv?.getState_PrimitiveId?.();
        if (!cvid) {
          // create 的失败方式是返回 undefined，不抛 —— 不能记成修好了
          log('patchCrossLayerNoObj', { net, at: [Math.round(cx), Math.round(cy)],
            la: laNear, lb: lbNear });
        } else {
          // 只登进 patchCreated：本轮复检变差时由 patchReverted 统一删掉。
          // 本条之后才声明同名清理数组，这里绝不能提前引用。
          patchCreated.push({ kind: 'via', id: cvid });
          targets.push({ net, ids: [String(ed.obj1 || ''), String(ed.obj2 || '')], pos });
          log('patchedCrossLayer', { net, at: [Math.round(cx), Math.round(cy)],
            la: laNear, lb: lbNear, d: Math.round(cp.d * 100) / 100,
            t1: ed.obj1Type || null, t2: ed.obj2Type || null,
            why: '两对象已贴合但分处不同层 ⇒ 差一个过孔，不是孤岛' });
        }
        continue;
      }
      // 过孔盘覆盖诊断（只观测）。slot-geo 依据 api-types.d.ts:15371/15434/15460 指出：
      // 内核只认"线端落在过孔盘 dia/2 内"且"孔覆盖该层"，net 相同 + 中心距 0
      // 并不构成连通。所以"贴着还不通"有两种可能，处理方式完全相反：
      //   ① 死铜孤岛 → 补铜无效，只能重铺/改策略；
      //   ② 过孔盘没盖住线端（r < 端点距离）或孔是盲埋孔不覆盖该层 → 改过孔或挪线端。
      // 先只记账不动作，攒够样本再决定，避免又一次没有依据的盲目补铜（d6 已白干过）。
      const viaSide = (o1.k === 'via') ? o1 : ((o2.k === 'via') ? o2 : null);
      let coverage = null;
      if (viaSide) {
        const other = (viaSide === o1) ? o2 : o1;
        const r = Number.isFinite(viaSide.dia) ? viaSide.dia / 2 : null;
        let dEnd = Infinity;
        for (const [px, py] of ptsOf(other)) {
          dEnd = Math.min(dEnd, Math.hypot(px - viaSide.x, py - viaSide.y));
        }
        coverage = { r, dEnd: Math.round(dEnd * 100) / 100,
          covered: r !== null && dEnd <= r, viaType: viaSide.viaType, other: other.k };
      }
      log('patchIslandPair', { net, d: Math.round(cp.d * 100) / 100,
        t1: ed.obj1Type || null, t2: ed.obj2Type || null,
        synth: obj2Synth || null, coverage,
        note: '两对象已贴合仍判不连通 → 死铜孤岛 或 过孔盘未覆盖线端；局部补铜无效' });
      continue;
    }
    if (cp.d > 80) {
      log('patchTooFar', { net, gap: Math.round(cp.d), t1: ed.obj1Type || null, t2: ed.obj2Type || null });
      continue;
    }
    // 选层：能同层就同层直连（不新增孔，避免孔到孔/孔到铜违规）；
    // 一端是过孔则可以走到另一端那层；两端都是过孔走底层即可；只有跨层且都不是过孔才必须打孔。
    const la = o1.k === 'via' ? null : Number(o1.layer);
    const lb = o2.k === 'via' ? null : Number(o2.layer);
    let useLayer = null;
    if (la !== null && lb !== null) useLayer = (la === lb) ? la : null;
    else useLayer = (la !== null) ? la : lb;
    if (useLayer !== null && !Number.isFinite(useLayer)) useLayer = null;
    // 本条新建的对象单独记账：失败时只撤本条，不能整轮全删也不能留着
    const mine = [];
    try {
      let made = 0;
      if (useLayer !== null) {
        const ln = await eda.pcb_PrimitiveLine.create(net, useLayer, cp.ax, cp.ay, cp.bx, cp.by, 8, false);
        const lid = ln?.getState_PrimitiveId?.();
        if (lid) { patchCreated.push({ kind: 'line', id: lid }); mine.push({ kind: 'line', id: lid }); made++; }
      } else {
        // 需要换层：两端各打一个过孔（都在 80mil 以内），底层直连。
        if (la !== null) {
          const v1 = await eda.pcb_PrimitiveVia.create(net, cp.ax, cp.ay, 12, 24);
          const v1id = v1?.getState_PrimitiveId?.();
          if (v1id) { patchCreated.push({ kind: 'via', id: v1id }); mine.push({ kind: 'via', id: v1id }); }
        }
        if (lb !== null) {
          const v2 = await eda.pcb_PrimitiveVia.create(net, cp.bx, cp.by, 12, 24);
          const v2id = v2?.getState_PrimitiveId?.();
          if (v2id) { patchCreated.push({ kind: 'via', id: v2id }); mine.push({ kind: 'via', id: v2id }); }
        }
        const ln = await eda.pcb_PrimitiveLine.create(net, 2, cp.ax, cp.ay, cp.bx, cp.by, 10, false);
        const lid = ln?.getState_PrimitiveId?.();
        if (lid) { patchCreated.push({ kind: 'line', id: lid }); mine.push({ kind: 'line', id: lid }); made++; }
      }
      // create 静默失败（返回 undefined 不抛）—— 旧代码 `made++` 无条件加，
      // 于是一条也没连上却记成修好了。只认真拿到 id 的。
      if (!made) {
        const back = await rollbackMine(mine);
        log('patchNoObj', { net, rolledBack: back });
        continue;
      }
      // 【不再在这里 fixed++】补线成功 ≠ 这处断连消失。是否真修好要等第 1 次复检
      // 逐条对账（patchPerErr），否则"补了 A 又造了 B、总数不变"会被记成修好了 N 处。
      targets.push({ net, ids: [String(ed.obj1 || ''), String(ed.obj2 || '')], pos });
      log('patched', { net, gap: Math.round(cp.d), layer: useLayer,
        t1: ed.obj1Type || null, t2: ed.obj2Type || null,
        from: [Math.round(cp.ax), Math.round(cp.ay)],
        to: [Math.round(cp.bx), Math.round(cp.by)] });
    } catch (e) {
      const back = await rollbackMine(mine);
      log('patchErr', { net, rolledBack: back, m: String(e && e.message).slice(0, 100) });
    }
  }
  log('patchRound', { round, violations: beforeCount, connErrs: connErrs.length, attempted: targets.length });
  if (!targets.length) { log('patchNoProgress', { round, leftMs: left() }); break; }

  // 补完立即复检：补线制造间距违规是 d6/d7 的老教训，所以必须证明这一轮
  // 是净改善才留下。变多就删掉本轮新建的全部过孔/走线，回到补之前的状态。
  try {
    if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
    await sleep(1500);
    const after2 = await eda.pcb_Drc.check(true, false, true);
    const flat2 = [];
    const walk2 = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk2); return; }
      if (n.errorType) flat2.push(n);
      if (n.list) walk2(n.list);
    };
    walk2(after2);
    log('patchVerify', { round, before: beforeCount, after: flat2.length });
    if (flat2.length > beforeCount) {
      let del = 0;
      for (const c of patchCreated.slice().reverse()) { if (await delObj(c)) del++; }
      log('patchReverted', { round, deleted: del, total: patchCreated.length,
        from: beforeCount, to: flat2.length });
      try { if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e9) { }
      break;
    }
    // 【逐条对账 —— "不假通过"的关键】"违规总数没变差"不等于"这一处连上了"。
    // 补 A 的同时造出 B，总数可能持平甚至略降，旧代码就把本轮**全部**计成修好，
    // 于是板上断网仍在，而 patchTotal 与最终判定都以为已连通（唯一一条假通过路径）。
    // 这里改为：只认"复检里确实不再报这一处"的才算修好。
    // 同一个断点复检后可能换了 obj id（新补的线成了参与者），
    // 所以 id 对不上时退化为"同网 + 位置 30mil 内"，宁可少算也不多算。
    const eNet = (n) => String(n.net || (n.explanation?.errData || {}).net || '').toUpperCase();
    const eIds = (n) => { const d = n.explanation?.errData || {};
      return [String(d.obj1 || ''), String(d.obj2 || '')].sort().join('|'); };
    const ePos = (n) => { const p = (n.explanation?.errData || {}).position;
      return p ? { x: Number(p.x) * 10, y: Number(p.y) * 10 } : null; };
    const afterConn = flat2.filter(n => n.errorType === 'Connection Error');
    const beforeKeys = new Set(connErrs.map(n => eNet(n) + '#' + eIds(n)));
    let stillBroken = 0;
    for (const t of targets) {
      const tid = t.ids.map(String).sort().join('|');
      const tNet = String(t.net).toUpperCase();
      const hit = afterConn.some(n => {
        if (eNet(n) !== tNet) return false;
        if (eIds(n) === tid) return true;
        const p = ePos(n);
        return !!p && Number.isFinite(p.x) && Math.hypot(p.x - t.pos.x, p.y - t.pos.y) <= 30;
      });
      if (hit) stillBroken++;
      log('patchPerErr', { net: t.net, cleared: !hit, obj: tid });
    }
    const actuallyFixed = targets.length - stillBroken;
    const newConn = afterConn.filter(n => !beforeKeys.has(eNet(n) + '#' + eIds(n))).length;
    patchCount += actuallyFixed;
    log('patchRoundNet', { round, attempted: targets.length, actuallyFixed, stillBroken,
      newConn, before: beforeCount, after: flat2.length });
    // 一处也没真修好 = 本轮白画铜。把本轮新建的全撤掉再退出，
    // 否则"没有进展"会以垃圾铜的形式永久留在板上。
    if (actuallyFixed === 0) {
      let del = 0;
      for (const c of patchCreated.slice().reverse()) { if (await delObj(c)) del++; }
      log('patchNoProgress', { round, leftMs: left(), attempted: targets.length,
        stillBroken, rolledBack: del });
      try { if (pourCount > 0) await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e10) { }
      break;
    }
  } catch (e) { log('patchVerifyErr', { m: String(e && e.message).slice(0, 100) }); }
}
log('patchTotal', patchCount);

// ---------- 9. DRC（显式执行 + 详细违规）----------
// 关键：判定前必须**重建覆铜并等它落定**，否则是在中间态上判 DRC。
// 实测 d6/d7 流水线报 FAIL（还因此白扩了 4 次板框），但工程存盘后
// 在流水线外独立复核是 passed=true、0 违规 —— 误判来自「覆铜还没重建完就检查」。
// 覆铜重建是异步的，rebuild 返回后仍需给渲染层时间，故这里重试到稳定为止。
await cam('pcb');   // DRC 后全板视图
await shot('pcb-patched');
phase('drc');
let drc = null, drcDetails = null, drcPassed = null;
// 这三个必须和上面三个**同层**声明。它们描述"这棵 DRC 树到底读出了什么"，要进返回对象；
// 原来写在下面 `try {` 块里（缩进 2 的 let），而 return 在函数作用域 —— 静态看不出来、
// 语法也合法，但一跑就是 ReferenceError: drcLeafCount is not defined：整轮白跑 400~600s，
// 6 件产物全导出了却判失败。scripts\staticcheck.js 现在专门查这一类。
let drcLeafCount = null;
let drcTotalCount = null;      // 类别层 count 之和：只看叶子数会被类别树骗过去
let drcTreeUsable = false;     // 这棵树到底有没有被我们读懂
// 【覆铜是否真的产出实铜】rebuildAllCopperRegions 的 await 早于铜皮生成，所以
// "没抛异常"不等于"板上有铜"。三家离线脚本（verify-drc / audit-drc / README-drc）
// 的既有做法都是"重建 → 固定 sleep → 再 check"，说明这一点被反复踩过。
// 这里只**测量并留痕**，暂不进 computeOK —— 先拿基线，再决定闸门怎么写：
// 判据写错会把现在能通过的板子全判失败，比没有闸门更糟。
let pourRebuildOk = null;      // null=未测（预算跳过等）；true=实铜非空；false=确实试过但没铜
let pouredCount = null;        // pcb_PrimitivePoured.getAllPrimitiveId() 的真实条数
try {
  // 【重建前先测一次断连数】动机（实测 USBC_Power_ESD-20261126-014623）：
  //   布线 iter=3 打到 stillUnconnected=0；snapEnds/stitchGaps 之后 fixClearance
  //   回滚时测得 connFrom=0 / connTo=0（此刻板子是通的）；patchDrc 打了 0 个补丁；
  //   然后**最终 DRC 变成 11 条 Connection Error、0 条间距**。
  //   也就是说：断路是在 fixClearance 之后、最终 DRC 之前产生的。
  //   这一段里唯一会动铜的调用就是下面的 rebuildAllCopperRegions()，而它
  //   在本例 attempt 0 抛了 "Cannot read properties of null (reading 'map')"。
  // 但"抛错"不等于"毁铜"，"connDiag 里 near 为空"也不算证据（near 只扫同网
  // 的焊盘/走线/过孔，**不含覆铜**，靠覆铜连的焊盘必然 near 为空）。
  // 所以要的是**同一次运行内、重建前后各一次**的断连数：
  //   重建前 0 → 重建后 N>0  = 覆铜重建毁铜（该在重建失败时回退或重试）
  //   重建前就 N>0           = 上游阶段弄断的（与覆铜重建无关）
  // 只在还有 90s 预算时测，避免把收尾拖过 invoke 超时（一次详细检查约 5~8s）。
  let connBeforePour = null;
  let connBeforePourNote = null;
  if (left() > 90000) {
    try {
      const tPre = await eda.pcb_Drc.check(true, false, true);
      const preLeaves = [];
      const wkPre = (n) => {
        if (!n) return;
        if (Array.isArray(n)) { n.forEach(wkPre); return; }
        if (n.errorType === 'Connection Error') preLeaves.push(n);
        if (n.list) wkPre(n.list);
      };
      wkPre(tPre);
      connBeforePour = preLeaves.length;
      // 树读不懂时 leaves 会是 0 —— 那不能算"板子是通的"，必须与"确实为 0"区分开。
      if (preLeaves.length === 0) {
        // 【空结果 ≠ 读不到】实测 d8（AI_纯分立_19pl4cd-022851）通过那次：
        // drc 阶段的 detailLen 由 Array.isArray(drcDetails) ? .length : null 算出 0，
        // 即 check(true,false,true) 在"无违规"时返回的是**空数组**，空数组是合法回答。
        // 旧写法把它也归成"读不懂"，于是干净的板子被记成 null —— 过于保守，
        // 恰好会把"重建前确实是通的"这条关键证据抹掉。三种情形必须分开：
        //   数组（含空数组）= API 可读回答，空就是真 0
        //   非空对象        = 嵌套树，walk 过就是真 0
        //   null/undefined  = 真拿不到数据 ⇒ 用一次便宜的布尔检查消歧，仍不确定才记 null
        const readable = Array.isArray(tPre) || (tPre !== null && typeof tPre === 'object');
        if (readable) {
          connBeforePourNote = 'ok';
        } else {
          try {
            const okCheap = await eda.pcb_Drc.check(true, false, false);
            if (okCheap === true) { connBeforePourNote = 'cleanByCheap'; }
            else { connBeforePourNote = 'noData'; connBeforePour = null; }
          } catch (e) {
            connBeforePourNote = 'noData';
            connBeforePour = null;
          }
        }
      }
    } catch (e) {
      log('connBeforePourErr', String(e && e.message).slice(0, 120));
    }
    log('connBeforePour', { n: connBeforePour, note: connBeforePourNote, leftMs: left() });
  } else {
    // 预算不够也要留痕：否则"没测"和"测了是 0"在日志层面完全一样。
    log('connBeforePourSkip', { leftMs: left() });
  }
  // 最多 4 次：重建覆铜 → 等待 → 检查，取最后一次稳定结果
  for (let attempt = 0; attempt < 4; attempt++) {
    // 复跑一次 DRC 约 3~8s，跑满 4 次会把收尾拖过外部 timeout → 幽灵调用
    if (attempt > 0 && left() < 60000) { log('drcBudgetSkip', { attempt, leftMs: left() }); break; }
    try {
      await eda.pcb_PrimitivePour.rebuildAllCopperRegions();
    } catch (e) {
      // 原来这里是纯空 catch：失败连日志都没有，"没报错"因此推不出"没失败"
      pourRebuildOk = false;
      log('pourRebuildErr', { attempt, m: String(e && e.message).slice(0, 200) });
    }
    await sleep(attempt === 0 ? 2500 : 1500);
    // 只在第 0 次测一次（多测要多付一次画布查询）；且必须在这段 sleep **之后**测，
    // 否则铜皮还没生成，量到的恒为 0 —— 那会把"没等够"误判成"覆铜坏了"。
    if (attempt === 0 && pourRebuildOk !== false) {
      try {
        const pouredIds = await eda.pcb_PrimitivePoured.getAllPrimitiveId();
        pouredCount = Array.isArray(pouredIds) ? pouredIds.length : null;
        // pourCount<=0 = 本次压根没建过覆铜区域，"覆铜产出"这项不适用，记 true
        pourRebuildOk = (pourCount <= 0) ? true : (pouredCount > 0);
        log('pourMeasured', { pourCount, pouredCount, ok: pourRebuildOk });
        if (pourRebuildOk !== true) log('pourRebuildEmpty', { pourCount, pouredCount });
      } catch (e) {
        log('pourMeasureErr', String(e && e.message).slice(0, 160));
      }
    }
    const p = await eda.pcb_Drc.check(true, false, false);
    drcPassed = p;
    log('drcAttempt', { attempt, passed: p });
    if (p === true) break;
  }
  await eda.pcb_Document.save();
  await sleep(1200);
  // 存盘后再确认一次：以落盘状态为准，避免内存态假阴性
  const persisted = await eda.pcb_Drc.check(true, false, false);
  if (persisted === true && drcPassed !== true) {
    log('drcPersistedOverride', { was: drcPassed, now: persisted });
  }
  if (persisted === true) drcPassed = true;
  drcDetails = await eda.pcb_Drc.check(true, false, true);
  log('drcCheck', { passed: drcPassed, detailLen: Array.isArray(drcDetails) ? drcDetails.length : null });

  // ---------- 假阴性兜底 ----------
  // 实测 d6/d7：drcPassed=false，但 includeVerboseError=true 的详细检查返回 0 条违规 ——
  // 自相矛盾。本文件 L1558 一带的注释早记过这个坑：
  // 「流水线报 FAIL（还因此白扩了 4 次板框），存盘后在流水线外独立复核是 passed=true、0 违规，
  //   误判来自覆铜还没重建完就检查」。
  // 判据：详细检查是**更严格**的 API（它能一条条列出违规），它说 0 条就是真没有；
  // 布尔版此时是在中间态上判的。但"空数组"也可能是调用内部失败，所以：
  //   1) 要求**两次**间隔重试（中间重建覆铜）都为空才采信；
  //   2) run-all 之后还会用 verify-drc.js 独立复核 —— 这里只是解除误判，不是放宽标准。
  // 若两次里有任何一次报出违规，就立刻放弃兜底并用新数字（绝不把有违规的板子判通过）。
  // 【失败必须自带判据】DRC 只说"15 条违规"，不说是哪个 errorType、哪个坐标、哪个对象类型。
  // 实测 2026-11-25 d13：两次尝试里 15 条违规全部来自**同一个** Slot Region 对象
  // （d6893410d653eee4e18，20 位 hex），而 _log.json 里连"Slot Region"这四个字都没有 ——
  // 只能从 clearDiag 的 obstacleType 反推，还推不全（12 条 skipped，剩 3 条查不到）。
  // _log.json 又是唯一会在 healPlan 之间被覆盖的东西（现在已按尝试留存副本）。
  // 没有这条日志，"又失败了"和"没测"在文件层面完全一样，下一条该修什么只能靠猜。
  // 只在失败时打；通过路径零成本。
  const compactLeaves = (root, cap) => {
    const out = [];
    const walk = (n) => {
      if (!n || out.length >= cap) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.errorType) {
        const ed = (n.explanation && n.explanation.errData) || {};
        const p = ed.position || n.position || n.pos || {};
        const num = (v, k) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * k) : null);
        out.push({
          t: n.errorType,
          ot: ed.errorObjType || n.errorObjType || null,
          net: ed.net || n.net || null,
          // position 是画布单位（mil/10），×10 才是 mil —— 与 patchDrc 的 violX/violY 同一口径
          x: num(p.x, 10), y: num(p.y, 10),
          layer: Array.isArray(n.layerIds) ? n.layerIds : (n.layer !== undefined ? n.layer : (ed.layer ?? null)),
          cur: num(ed.minDistance, 10), need: num(ed.clearance, 10),
          // 【DRC 自己会说人话，我们却一直没记】explanation 里有人可读的 errMsg 之类文本，
          // 而 clearDiag 只落下 {rule,t1,t2,net,cur,need,at,o1,o2} —— 面对一个 19 位
          // 复合 id（fb25ebec4ca8c8c8e17）时，谁也看不出它到底是槽孔、覆铜孤岛还是焊盘。
          // 这里只做取证：把 explanation 里的短字符串字段原样抄出来，不参与任何判决。
          why: (() => {
            const ex = n.explanation;
            if (!ex) return null;
            if (typeof ex === 'string') return ex.slice(0, 200);
            if (typeof ex !== 'object') return null;
            const parts = [];
            for (const k of Object.keys(ex)) {
              const vv = ex[k];
              if (typeof vv === 'string' && vv.trim() && vv.length <= 160) parts.push(k + '=' + vv);
            }
            return parts.length ? parts.join('; ').slice(0, 260) : null;
          })(),
        });
      }
      if (n.list) walk(n.list);
    };
    walk(root);
    return out;
  };
  const countLeaves = (root) => {
    const flat = [];
    let sum = 0, sawNode = false;
    const walk = (n) => {
      if (!n) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      sawNode = true;
      if (n.errorType) flat.push(n);
      // 类别层节点只有 {name, count, list}，count 是它下面的真实违规数。
      // fresh-review 指出的死法：drcLeafCount===0 就判"干净"，
      // 而 DRC 完全可能只返回类别层（本文件 L885 一带早记过这个形状），
      // 于是 drcPassed=false 被自己推翻成 true —— 坏板通过。
      if (!n.errorType && n.count != null) sum += Number(n.count) || 0;
      if (n.list) walk(n.list);
    };
    walk(root);
    return { leaves: flat.length, sum, sawNode };
  };
  try {
    const r = countLeaves(drcDetails);
    drcLeafCount = r.leaves;
    drcTotalCount = r.sum;
    // 空数组 `[]` 要算"读懂了"：数组存在但为空 = API 明确回答"0 条违规"，
    // 这是真证据。只有 null/undefined/既无 list 又无 count 的垃圾形状才是"读不懂"。
    // 区分这两者的意义：前者可以把假阴性救回来，后者绝不能。
    drcTreeUsable = r.sawNode || Array.isArray(drcDetails);
  } catch (e) { }

  // "干净"必须两个数都为 0 且树确实读到了节点。
  // 空树/读不懂的树不算干净 —— 「未知」永远不能当成「通过」，
  // 这正是这一整段兜底逻辑存在的理由，不能反过来成了漏网通道。
  const looksClean = drcTreeUsable && drcLeafCount === 0 && drcTotalCount === 0;
  if (drcPassed !== true && looksClean && left() > 45000) {
    let confirmed = 0;
    let contradict = null;
    for (let i = 0; i < 2; i++) {
      await sleep(1800);
      try { await eda.pcb_PrimitivePour.rebuildAllCopperRegions(); } catch (e) { }
      await sleep(1500);
      let d2 = null;
      try { d2 = await eda.pcb_Drc.check(true, false, true); } catch (e) { break; }
      const r2 = countLeaves(d2);
      if (r2.sawNode && r2.leaves === 0 && r2.sum === 0) confirmed++;
      else { contradict = (r2.leaves || r2.sum || 1); break; }
    }
    if (confirmed === 2) {
      drcPassed = true;
      log('drcFalseNegative', { was: false, detailLeaves: 0, detailSum: 0, confirmed,
        note: 'boolean check said false while verbose check found 0 violations twice' });
    } else if (contradict !== null) {
      drcLeafCount = contradict;
      log('drcFalseNegativeRejected', { leaves: contradict });
    }
  }
  log('drcLeafCount', { passed: drcPassed, leaves: drcLeafCount, total: drcTotalCount, usable: drcTreeUsable });
  if (drcPassed !== true) {
    try {
      const cl = compactLeaves(drcDetails, 200);
      const byType = {};
      for (const x of cl) { const k = x.t + ' | ' + (x.ot || '?'); byType[k] = (byType[k] || 0) + 1; }
      const sameObj = {};
      for (const x of cl) { const k = x.net || '?'; sameObj[k] = (sameObj[k] || 0) + 1; }
      log('drcLeaves', { n: cl.length, byType, byNet: sameObj, sample: cl.slice(0, 24) });
    } catch (e) { log('drcLeavesErr', String(e && e.message).slice(0, 120)); }
  }

  // 诊断：最终 DRC 仍有 Connection Error 时，把断点两侧对象的**真实几何**落地。
  // 动机：d10 的 GND 焊盘 U1_19 与走线 e213 坐标几乎重合（都是 141.1,-129.0）、
  // 同网、DRC 却判不连通；stitch 连画 6 轮同一条 22mil 线毫无效果。
  // 只凭日志无法区分「层不同 / 铜未重建 / position 不是真实端点 / 焊盘被挖空」，
  // 所以在这里把 id→类型/net/层/端点 的索引打出来。只在失败时触发，
  // 通过路径不付任何代价。
  if (drcPassed !== true && left() > 60000) {
    try {
      const flatD = [];
      const walkD = (n) => {
        if (!n) return;
        if (Array.isArray(n)) { n.forEach(walkD); return; }
        if (n.errorType) flatD.push(n);
        if (n.list) walkD(n.list);
      };
      walkD(drcDetails);
      // 间距违规诊断：d12 实测 7 处 clearance，fixClearance 每轮只修好 1 处，
      // 日志里只有 "fixed:1" 看不出为什么其余 6 处绕行失败。
      // 这里把每处违规的对象类型/层/缺口/位置打出来，用来区分
      // 「线已是最细但绕不开」vs「障碍物几何解析失败」vs「根本没人处理这个类型」。
      // DRC 报的是**坐标**，不是对象。只打 at 时，同一个（或每轮漂移一点的）坐标
      // 在宽障碍物上会映射到不同邻居，于是"N 次修复、净进展 0"看起来像修复无效 ——
      // 这是精度幻觉。IPCB_ViolationBase 其实给了权威归属（api-types.d.ts:8342/8346
      // `obj1: string` / `obj2?: string`），只是以前没落进日志。
      // 两种形状都要认：顶层是 {typeName, suffix} 包装，explanation.errData 里是裸 id。
      // objIdOf 已提到顶层（见 doCopperPours 之前），与缝合阶段的复检共用一份实现。
      const clearsD = flatD.filter((v) => v.errorType === 'Clearance Error');
      for (const v of clearsD.slice(0, 8)) {
        const ed = v.explanation?.errData || {};
        const pp = ed.position || v.pos || {};
        log('clearDiag', {
          rule: ed.name || v.ruleName || null,
          t1: ed.obj1Type || null, t2: ed.obj2Type || null,
          net: ed.net || v.net || null,
          layer: ed.layerIds ?? v.layer ?? null,
          cur: Number(ed.minDistance) * 10, need: Number(ed.clearance) * 10,
          at: [Math.round(Number(pp.x) * 10), Math.round(Number(pp.y) * 10)],
          // 违规双方的**对象 id**：有了它才能回答"这条线改了几次、是不是同一条"，
          // 而不是靠坐标反推。没有 id 时保持 null（不编造）。
          o1: objIdOf(ed.obj1) || objIdOf(v.obj1),
          o2: objIdOf(ed.obj2) || objIdOf(v.obj2),
        });
        // 【同网违规还是跨网短路】DRC 的 `net` 字段恒为 null（语料里每一条 clearance 都是），
        // 所以 clearDiag 一直在报"间距违规"，却答不出这**两个对象是不是同一个网络**。
        // 而这个答案决定修法完全相反：
        //   同网 ⇒ 是网络内部的自间距，移开/缩窄都只是白折腾几何（还会把网络改断）；
        //   异网 ⇒ 真短路，必须移开。
        // 语料里 `Track to SMD Pad / cur=0 / need=5.98` 出现 49 次（9 份日志），一直没人确认过归属。
        // 读取器用 **DRC 自己声明的 obj1Type/obj2Type** 选类，不靠 get() 猜
        // （get(id) 不校验归属，`got:true` 不是类型证据），取到后再核 getState_PrimitiveType。
        try {
          // pickApi / readSide 已提到顶层（见 doCopperPours 之前）：读一侧的网络只有一份实现。
          const idA = objIdOf(ed.obj1) || objIdOf(v.obj1);
          const idB = objIdOf(ed.obj2) || objIdOf(v.obj2);
          const A = await readSide(ed.obj1Type, idA);
          const B = await readSide(ed.obj2Type, idB);
          const nA = A && A.net ? A.net : null, nB = B && B.net ? B.net : null;
          log('clearNet', {
            t1: ed.obj1Type || null, t2: ed.obj2Type || null,
            A, B, n1: nA, n2: nB,
            // 只有两侧都取到网络才敢下结论；取不到就如实 null（未知 ≠ 不同网）。
            sameNet: (nA && nB) ? (nA === nB) : null,
            cur: Number(ed.minDistance) * 10, need: Number(ed.clearance) * 10,
            at: [Math.round(Number(pp.x) * 10), Math.round(Number(pp.y) * 10)],
          });
        } catch (e) { log('clearNetErr', String(e && e.message).slice(0, 90)); }
      }
      const conns = flatD.filter((v) => v.errorType === 'Connection Error');
      if (conns.length) {
        const connNets = new Set(conns
          .map((v) => String((v.explanation?.errData || {}).net || '').toUpperCase())
          .filter(Boolean));
        const geo = new Map();
        for (const id of (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || []) {
          try {
            const p = await eda.pcb_PrimitivePad.get(id);
            const n = String(p?.getState_Net?.() || '').toUpperCase();
            if (!connNets.has(n)) continue;
            geo.set(String(id), { k: 'pad', net: n, layer: p.getState_Layer?.(),
              x: Number(p.getState_X()), y: Number(p.getState_Y()) });
          } catch (e) { }
        }
        for (const id of (await eda.pcb_PrimitiveLine.getAllPrimitiveId()) || []) {
          try {
            const l = await eda.pcb_PrimitiveLine.get(id);
            const n = String(l?.getState_Net?.() || '').toUpperCase();
            if (!connNets.has(n)) continue;
            geo.set(String(id), { k: 'line', net: n, layer: l.getState_Layer?.(),
              x: Number(l.getState_StartX()), y: Number(l.getState_StartY()),
              x2: Number(l.getState_EndX()), y2: Number(l.getState_EndY()),
              w: l.getState_LineWidth?.() });
          } catch (e) { }
        }
        for (const id of (await eda.pcb_PrimitiveVia.getAllPrimitiveId()) || []) {
          try {
            const v = await eda.pcb_PrimitiveVia.get(id);
            const n = String(v?.getState_Net?.() || '').toUpperCase();
            if (!connNets.has(n)) continue;
            geo.set(String(id), { k: 'via', net: n, layer: '1/2',
              x: Number(v.getState_X()), y: Number(v.getState_Y()) });
          } catch (e) { }
        }
        for (const v of conns.slice(0, 4)) {
          const ed = v.explanation?.errData || {};
          const px = Number(ed.position?.x) * 10, py = Number(ed.position?.y) * 10;
          const objId = String(ed.obj1 || (Array.isArray(v.objs) ? v.objs[0] : '') || '');
          const me = geo.get(objId) || null;
          const near = [...geo.entries()]
            .filter(([id]) => id !== objId)
            .map(([id, o]) => ({
              id, k: o.k, layer: o.layer,
              dist: Math.round(Math.hypot(((o.x + (o.x2 ?? o.x)) / 2) - px, ((o.y + (o.y2 ?? o.y)) / 2) - py) * 10) / 10,
            }))
            .filter((o) => o.dist <= 40)
            .sort((a, b) => a.dist - b.dist)
            .slice(0, 6);
          log('connDiag', { net: ed.net, at: [Math.round(px), Math.round(py)], me, near });
        }
      }
    } catch (e) { log('connDiagErr', String(e && e.message).slice(0, 120)); }
  }
  try { drc = await eda.pcb_Drc.getDrcResult(); } catch (e) { }
  log('drcResult', drc ? { state: drc.state, n: drc.totalCount } : null);
} catch (e) { errors.push('drc: ' + (e && e.message)); }

// ---------- 10. 导出 ----------
await cam('pcb');   // 导出前回到全板视图
await shot('pcb-drc');
phase('export');
// `fs` 已在文件前部（shot() 定义之前）声明，这里**不能**再声明一次。
// 原先声明就在这一行，而 shot() 在第 4~9 节被调用 10 次；`const` 不提升初始化，
// 于是每次 shot() 都抛 "Cannot access 'fs' before initialization"，
// 又被 shot() 自己的 catch 吞成一条 shotErr —— 录制模式整轮跑完、0 张 PNG、
// 日志里没有任何异常堆栈。取证：logs/SHT30_LDO_Module-20261125-205233.json
// 的 10 条 shotErr 全是这句话。详见 shot() 上方的注释。
async function ex(name, getter) {
  try {
    const data = await getter();
    if (!data) return { name, ok: false, why: 'null' };
    const blob = toBlob(data);
    const ok = !!(await fs.saveFileToFileSystem(OUT + '\\' + name, blob, name));
    if (ok) artifacts.push({ name, size: blob.size });
    return { name, ok, size: blob.size };
  } catch (e) { return { name, ok: false, err: String(e && e.message) }; }
}
const exports = [];
// 导出实测 20~51s（6 个文件），是收尾最后一段。预算不够时明确记 skipped，
// 让 ok:false 说得清原因，而不是拖过内部预算后被外部 timeout 变成幽灵调用。
const EXPORT_PLAN = [
  ['Gerber.zip', () => eda.pcb_ManufactureData.getGerberFile('AI_Board')],
  ['BOM.xlsx', () => eda.pcb_ManufactureData.getBomFile()],
  ['PnP.csv', () => eda.pcb_ManufactureData.getPickAndPlaceFile('AI_Board', 'csv', 'mm')],
  ['Netlist.json', () => eda.pcb_Net.getNetlist()],
  // 名字必须写 .xlsx：getTestPointFile() 返回的是 **xlsx 字节**（文件头 50 4B 03 04 = ZIP），
  // 写成 .csv 会让任何 CSV 解析器崩、打样厂上传判格式错。
  // 实测 84 份产物里 80 份是"改名的 xlsx"，全靠 fix-artifacts.js 事后补救；
  // 而那个补丁只在 run-all.ps1「自述通过」分支被调用，直调 pipeline3 的路径全漏掉 ——
  // 在源头写对，补丁就不必存在。
  ['TestPoints.xlsx', () => eda.pcb_ManufactureData.getTestPointFile('AI_Board')],
  ['Board.pdf', () => eda.pcb_ManufactureData.getPdfFile('AI_Board')],
];
for (const [nm, getter] of EXPORT_PLAN) {
  if (left() < 45000) {
    exports.push({ name: nm, ok: false, skipped: 'budget', leftMs: left() });
    log('exportSkipped', { name: nm, leftMs: left() });
    continue;
  }
  exports.push(await ex(nm, getter));
}
log('exports', exports);

// ---------- 布线作业状态 ≠ 板子是否真的通了 ----------
// routeState 是**布线器作业**的自述：它怎么结束的。闸门要回答的是「板子通没通」。
// 这两件事在下游阶段之后会分叉：布线循环以 TIMEOUT 结束，但循环之后的
// stitchGaps / fixClearance / patchDrc 仍会继续补铜、改线，最终 DRC 看到的才是成品。
// 实测（out\AI_RP2040_系统_15pqy38-20261126-010233，441.3s）：
//   drcPassed=true, drcLeafCount=0, drcTotalCount=0, errors=0, mismatches=0,
//   outlineOk=true, imports/exports 6/6, pourRebuildOk=true —— 每一项都绿，
//   只有 routeState=TIMEOUT，于是 ok=false，一块干净的板被判死并白烧 441s。
// 所以：**只在最终 DRC 证明「零违规」时**，把这种状态记为已恢复。
// 为什么安全：最终 DRC 的零违规同时覆盖间距与断连；真有断连必然产生
// Connection Error，drcPassed 就不会是 true、两个计数也不会是 0。
// 边界严格：drcTreeUsable 必须为 true（空树/读不懂的树一律不算干净，与本文件
// L3648 一带的兜底同一口径，否则这里就成了新的漏网通道）；routeState 只认
// 「作业没收敛」那两个取值 —— failed/error 之类意味着别处真的坏了，不许被抹平。
// routeState 字段保持**原始观测**不变，恢复与否单独记 routeRecovered，两件事不混。
let routeRecovered = false;
if ((routeState === 'TIMEOUT' || routeState === 'budget')
    && drcTreeUsable === true && drcPassed === true
    && drcLeafCount === 0 && drcTotalCount === 0) {
  routeRecovered = true;
  log('routeStateRecoveredFinal', { was: routeState, leaves: drcLeafCount, total: drcTotalCount,
    note: '布线作业未收敛，但最终 DRC 证明零违规（含零断连），按已布通计' });
}
// ---------- 唯一判定 ----------
// 坑：此前 `_run.json` 里的 ok 用的是 `errors.length === 0`（弱版），
// 而真正的判定是那串还要求「导出 6 件全 ok + DRC 通过 + 布线/布局 completed」的表达式。
// 同一个 run 里出现两个语义不同的 ok，且**落盘的是弱版** —— 实测 d9：
//   导出全成功、DRC 通过，_run.json 写的是 ok:true，
//   但紧接着构建返回值时抛 drcLeafCount is not defined，整轮被判失败。
// 于是"文件说通过、日志说失败"两者并存，任何读文件的人（包括我）都会被误导。
//
// 做成函数而不是常量：`_run.json` 写失败时 catch 里会 push 进 errors，
// 若把 OK 算成一个提前求值的常量，那次失败就不会进判定 —— 等于新开一个漏洞。
// 两处都调 computeOK()，永远按「当下」的 errors 算，不可能分叉。
// 布局是否真的完成，两种模式各自的证据不同，**不能共用一个字段**：
//   自动模式：layoutState === 'completed' 是自动布局作业自己报告的终态。
//   显式模式：不调用自动布局（它会推翻手工坐标），layoutState 恒为 null。
//            此时"完成"由 placeExplicitly 的逐个复读坐标证明：
//            请求数与到位数相等，且没有找不到的位号。
// 以前这里直接判 layoutState，一旦引入显式模式就会出现「摆好了但判定为假」，
// 或者更糟：为了让判定通过而把 layoutState 填成 'completed'，那是对读者撒谎。
const placementOk = placementMode === 'explicit'
  ? (!!explicitPlacement && explicitPlacement.requested > 0
     && explicitPlacement.moved === explicitPlacement.requested
     && explicitPlacement.notFound.length === 0)
  : (layoutState === 'completed');
const computeOK = () => errors.length === 0 && mismatches.length === 0 && !!outlineOk
    && (routeState === 'completed' || routeRecovered === true)
    && drcPassed === true && schDrcErrors === 0
    && placementOk === true && imported === true
    && exports.length === 6 && exports.every(e => e && e.ok === true)
    && artifacts.length >= 6;

// 把本次**实际生效**的板框等信息落盘到产物目录，作为独立校验的唯一可信来源。
// 自愈会放大板框，设计文件里的原值已不代表本次实际使用值。
try {
  const meta = JSON.stringify({
    kind: 'pipeline',            // 与"设计生成摘要"区分，避免被当成同一回事
    ok: computeOK(),
    boardWidthMil: bw0, boardHeightMil: bh0,
    designName: D.name || null, idea: D._idea || null,
    components: (D.components || []).length, connections: (D.connections || []).length,
    elapsedMs: Date.now() - T0,
    projectUuid, generatedAt: new Date().toISOString(),
    // 【证据分字段落地】`ok` 是唯一结果布尔量，而它的语义已经漂移过一次：
    // 旧版是 errors.length===0（不含 DRC），新版是 12 项合取。两者都叫 ok，
    // 于是"文件说通过、日志说 DRC 失败"并存（实测 d9、17 个旧目录）。
    // 单个布尔量一旦漂移，读盘者无从分辨；把 computeOK() 的每个输入分别写下来，
    // 漂移就只能发生在"某个字段缺失"，而缺失是可检测的。
    // 消费方（accept.ps1）据此可以独立核对 DRC，不必相信 ok。
    gates: {
      // 【必须带原文，不能只带个数】实测 2026-11-26T15:44 那一轮：gates.errors=2，
      // 而这两条错误的文本在磁盘上任何一处都不存在 —— `errors.push` 全文件 30 处
      // 没有一处 `log()`，`gates` 只存了 `.length`，run-all.ps1 把文本打到控制台就结束。
      // 于是"这次为什么没通过"只能靠重跑一次来回答（28 分钟，且未必复现）。
      // 个数进了结论、原因没进证据 —— 这跟"读不到输入却保持沉默"是同一类错。
      errors: errors.length, errorList: errors.slice(0, 40),
      // 环境故障单独成字段：它和 errors 的处置完全相反（重试 vs 改设计）。
      envFaults: envFaults.length, envFaultList: envFaults.slice(0, 10),
      warns: warns.length, warnList: warns.slice(0, 40),
      mismatches: mismatches.length,
      outlineOk: !!outlineOk,
      routeState, routeRecovered, layoutState, imported,
      // 摆放证据：显式模式下 layoutState 恒为 null，只看它会把摆好的板判成没布局。
      placementMode, placementOk,
      placements: explicitPlacement ? {
        requested: explicitPlacement.requested, moved: explicitPlacement.moved,
        notFound: explicitPlacement.notFound, missed: explicitPlacement.missed,
        maxErrMil: Math.round(explicitPlacement.maxErrMil) } : null,
      // 天线净空：null = 设计没给这块信息（不能读成通过）
      antennaKeepout,
      // 声明式禁布区（封装内部开口）：declared 与 built 分开记，不许互相当证明
      copperVoids,
      drcPassed, drcLeafCount, drcTotalCount, schDrcErrors,
      exportsOk: exports.filter(e => e && e.ok === true).length, exportsTotal: exports.length,
      artifacts: artifacts.length,
      // 覆铜产出：null = 未测（不能读成通过），false = 确实试过但没铜
      pourRebuildOk, pouredCount,
      // 回滚三态：null = 本次没有回滚尝试（**不能读成通过**）/ true = 全部还原
      // / false = 有铜留在中间态。与 pourRebuildOk 同一契约，**故意不进 computeOK()**：
      // 先把基线拿到手，再决定要不要并进判定（否则一改就把眼下能过的板子全判死）。
      clearanceRevertOk,
      clearanceRevertDangling: [...danglingLines],
    },
  }, null, 1);
  // 同一份内容再进 _log.json（那是独立复核最常读的入口）。
  // 注意：_run.json/_log.json **自身写失败**产生的 errors 是在这之后才 push 的，
  // 不会出现在这两个字段里 —— 它们分别有 runMetaFail / runLogFail 兜底。
  log('runErrors', { n: errors.length, list: errors.slice(0, 40),
    warns: warns.length, warnList: warns.slice(0, 40) });
  await fs.saveFileToFileSystem(OUT + '\\_run.json', toBlob(meta), '_run.json');
} catch (e) {
  // 不能吞：_run.json 是独立校验器唯一可信的板框来源。写失败后校验器会退回
  // 设计文件里的**原始**板框，而自愈放大的实际板框丢失 → 判定比错对象。
  errors.push('_run.json: ' + String(e && e.message).slice(0, 120));
  log('runMetaFail', String(e && e.message).slice(0, 120));
}

// 把本次**完整遥测**落到产物目录。这是独立复核的前提。
// 此前详细日志只作为 invoke 的返回值存在于内存里，而 run-overnight 只在**失败**时
// 才把 stdout 存成 fail-*.txt —— 于是通过的那些运行，磁盘上只剩一个 ok:true 的
// 紧凑摘要，无法回答"patchDrc 到底真修好了几处""DRC 是真绿还是树没读懂"。
// 判据与结论必须落在同一份可复查的文件里，否则 ok:true 就是个悬空断言。
// 写失败要算进 errors：一份无法复核的产物不该被判成"已验证通过"。
try {
  const trace = JSON.stringify({ kind: 'pipeline-log', ok: computeOK(), entries: L });
  await fs.saveFileToFileSystem(OUT + '\\_log.json', toBlob(trace), '_log.json');
} catch (e) {
  errors.push('_log.json: ' + String(e && e.message).slice(0, 120));
  log('runLogFail', String(e && e.message).slice(0, 120));
}

log('budgetEnd', { totalMs: BUDGET, leftMs: left(), elapsedMs: Date.now() - T0 });

return {
  budgetMs: BUDGET, budgetLeftMs: left(),
  // 判定统一用 computeOK()，绝不在这里重写一遍表达式 —— 两份副本迟早分叉，
  // 而分叉时落盘的那份恰好是最容易被当成结论的那份。
  ok: computeOK(),
  boardWidthMil: bw0, boardHeightMil: bh0,
  outlineFillRatio,
  projectUuid, boardName: board.name, schName, pageName, pageUuid, schUuid, pcbUuid,
  components: placed.map(p => ({ des: p.des, lcsc: p.lcsc, value: p.props?.Value })),
  netSummary, mismatchCount: mismatches.length, mismatches,
  schDrc,
  schDrcErrors, schDrcWarns,
  schDrcRules: [...new Set((schDrcViolations || []).map(v => v?.rule))],
  imported, outlineOk, layoutState, placementMode, placementOk,
  placements: explicitPlacement, antennaKeepout, copperVoids, routeState,
  drcPassed,
  drcDetailCount: Array.isArray(drcDetails) ? drcDetails.length : null,
  // 叶子级违规数：顶层"违规组"计数会把 1 组 5 条显示成 1，看不出严重程度
  drcLeafCount,
  pourRebuildOk, pouredCount,
  // 回滚三态 + 残留铜 id：与 _run.json 的 gates 同源，进程内也能读到
  clearanceRevertOk, clearanceRevertDangling: [...danglingLines],
  drcDetails: Array.isArray(drcDetails) ? drcDetails.slice(0, 40) : drcDetails,
  drc: drc ? { state: drc.state, totalCount: drc.totalCount } : null,
  exports, artifacts, errors, warns, elapsedMs: Date.now() - T0, log: L,
};


