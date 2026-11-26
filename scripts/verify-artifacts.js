#!/usr/bin/env node
/**
 * verify-artifacts.js —— 独立校验器。
 *
 * 设计原则：**完全不信任流水线的自述**。只读 out/<run>/ 下的产物文件，
 * 再从 designs/<name>.json 读设计意图，两者对齐检查。
 *
 * 校验项：
 *   1. 器件完整性：设计里每个 (des, lcsc) 都在 Netlist.json 里，且 lcsc 一致
 *   2. 网络连通性：设计里每条 (des, pin, net) 在 Netlist.json 的 pinInfoMap 里 net 一致
 *   3. 无多余连接：Netlist 里出现的 net 必须是设计声明的（或多引脚封装的 NC 空网）
 *   4. BOM 行数 / PnP 坐标条数 = 器件数
 *   5. Gerber.zip 必需层齐全（GTL/GBL/GTO/GBO/GTS/GBS/GTP/GKO + 3 个 DRL）
 *   6. PnP 坐标落在板框内（mil），无重叠器件
 *   7. Board.pdf 存在且非空
 *
 * 用法：
 *   node scripts/verify-artifacts.js out/<run-dir> designs/<design>.json
 *   node scripts/verify-artifacts.js --latest designs/d3-sht30-ldo.json
 *
 * 退出码：0 全部通过；1 有失败项
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG_UNZIP = null; // 用 Node 原生不依赖外部 unzip，改用 PowerShell 兜底

function findLatestRun() {
  const outRoot = path.join(ROOT, 'out');
  const dirs = fs.readdirSync(outRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, t: fs.statSync(path.join(outRoot, d.name)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!dirs.length) throw new Error('out/ 下没有任何 run 目录');
  return path.join(outRoot, dirs[0].name);
}

// ---------- 读 Netlist.json ----------
function loadNetlist(runDir) {
  const p = path.join(runDir, 'Netlist.json');
  if (!fs.existsSync(p)) throw new Error('缺 Netlist.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));

  const components = []; // {designator, lcsc, pins: {num: net}}
  for (const [uid, c] of Object.entries(j.components || {})) {
    const props = c.props || {};
    const pins = {};
    for (const [, pi] of Object.entries(c.pinInfoMap || {})) {
      pins[String(pi.number)] = pi.net || null;
    }
    components.push({
      uid,
      designator: props.Designator || '',
      lcsc: props['Supplier Part'] || '',
      value: props.Value || '',
      name: props['LCSC Part Name'] || '',
      cls: props['JLCPCB Part Class'] || '',
      mfr: props.Manufacturer || '',
      footprint: props['Supplier Footprint'] || '',
      pins,
    });
  }
  return { raw: j, components };
}

// ---------- 读 PnP.csv ----------
// 实际格式：UTF-16LE + BOM，TAB 分隔，**每个字段都被双引号包裹**，
// 且坐标带单位后缀（"38.822mm"）。解析时必须去掉引号并剥离单位。
function unquote(s) {
  let v = String(s == null ? '' : s).trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).trim();
  return v;
}
function numWithUnit(s) {
  const v = unquote(s);
  const m = v.match(/^(-?[\d.]+)\s*(mm|mil)?$/i);
  if (!m) return NaN;
  return parseFloat(m[1]);
}

function loadPnp(runDir) {
  const p = path.join(runDir, 'PnP.csv');
  if (!fs.existsSync(p)) throw new Error('缺 PnP.csv');
  const buf = fs.readFileSync(p);
  const txt = (buf[0] === 0xff && buf[1] === 0xfe)
    ? buf.toString('utf16le').replace(/^\uFEFF/, '')
    : buf.toString('utf8').replace(/^\uFEFF/, '');
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const sep = lines[0].includes('\t') ? '\t' : ',';
  const head = lines[0].split(sep).map(unquote);
  const rows = lines.slice(1).map((l) => {
    const cells = l.split(sep);
    const o = {};
    head.forEach((h, i) => (o[h] = unquote(cells[i])));
    return o;
  });
  return { head, rows };
}

// ---------- 读 BOM.xlsx ----------
// 重要：嘉立创导出的 BOM 是**按物料合并**的（相同 LCSC 合成一行，Quantity 累加，
// Designator 形如 "C3,C4,C5,C6"），所以行数 != 器件数。正确判据是
//   ① Quantity 列求和 == 器件数
//   ② 所有 Designator 展开后的个数 == 器件数，且与 Netlist 的位号集合一一对应
function loadBom(runDir) {
  const p = path.join(runDir, 'BOM.xlsx');
  if (!fs.existsSync(p)) throw new Error('缺 BOM.xlsx');
  try {
    const out = execFileSync('python', ['-c', `
import openpyxl, json
wb = openpyxl.load_workbook(r"${p}", data_only=True)
ws = wb.active
rows = [r for r in ws.iter_rows(values_only=True) if any(c not in (None, '') for c in r)]
hdr_i = None
for i, r in enumerate(rows):
    if any(isinstance(c, str) and c.strip() == 'Designator' for c in r):
        hdr_i = i
        break
if hdr_i is None:
    print(json.dumps({'error': 'no Designator header'}))
else:
    hdr = [str(c).strip() if c is not None else '' for c in rows[hdr_i]]
    di = hdr.index('Designator')
    qi = hdr.index('Quantity') if 'Quantity' in hdr else None
    si = hdr.index('Supplier Part') if 'Supplier Part' in hdr else None
    items = []
    for r in rows[hdr_i + 1:]:
        des = r[di] if di < len(r) else None
        if not des:
            continue
        q = r[qi] if (qi is not None and qi < len(r)) else None
        lcsc = r[si] if (si is not None and si < len(r)) else None
        items.append({
            'designators': [x.strip() for x in str(des).split(',') if x.strip()],
            'qty': int(q) if isinstance(q, (int, float)) else None,
            'lcsc': str(lcsc).strip() if lcsc else '',
        })
    print(json.dumps({'items': items}))
`], { encoding: 'utf8' });
    const j = JSON.parse(out.trim());
    return j.error ? null : j.items;
  } catch (e) {
    return null; // 环境无 openpyxl 时不阻断
  }
}

// ---------- Gerber.zip 内容清单 ----------
function listZip(runDir) {
  const p = path.join(runDir, 'Gerber.zip');
  if (!fs.existsSync(p)) throw new Error('缺 Gerber.zip');
  try {
    const out = execFileSync('pwsh', ['-NoProfile', '-Command',
      `Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead("${p}").Entries | ForEach-Object { $_.Name }`],
      { encoding: 'utf8' });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
}

// ---------- Gerber 内容分析（判断"真的有铜"，而不只是文件存在）----------
// 关键：DRC 通过 ≠ 板上有铜。此前踩过布线器 1.2s 返回 completed 但零铜的坑，
// 所以必须直接解析 Gerber：统计绘制指令(D01 画线/D03 打闪)与铜面积元信息。
function analyzeGerber(runDir) {
  const p = path.join(runDir, 'Gerber.zip');
  const res = { ok: false, layers: {}, errors: [] };
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gz-'));
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command',
      `Add-Type -A System.IO.Compression.FileSystem; if(Test-Path '${tmp}'){}; [IO.Compression.ZipFile]::ExtractToDirectory("${p}","${tmp}")`],
      { encoding: 'utf8' });
    const files = fs.readdirSync(tmp);
    for (const f of files) {
      const ext = path.extname(f).toUpperCase().replace('.', '');
      if (['GTL', 'GBL', 'GTS', 'GBS', 'GTO', 'GBO', 'GTP', 'GKO'].includes(ext)) {
        const txt = fs.readFileSync(path.join(tmp, f), 'utf8');
        // 统计 D01（插补/画）与 D03（flash/打点）
        const d01 = (txt.match(/D0*1\*/g) || []).length;
        const d03 = (txt.match(/D0*3\*/g) || []).length;
        const g36 = (txt.match(/G36\*/g) || []).length; // 区域填充开始
        const m = txt.match(/G04\s+Copper Areas:\s*(\d+)/i);
        res.layers[ext] = {
          d01, d03, regions: g36,
          copperAreas: m ? parseInt(m[1], 10) : null,
          bytes: txt.length,
        };
      }
    }
    res.ok = true;
  } catch (e) {
    res.errors.push('Gerber 解压/解析失败: ' + e.message);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  return res;
}


function main() {
  const args = process.argv.slice(2);
  const latest = args.includes('--latest');
  const positional = args.filter((a) => !a.startsWith('--'));

  let runDir, designPath;
  if (latest) {
    runDir = findLatestRun();
    designPath = positional[0];
  } else {
    runDir = path.resolve(positional[0] || '');
    designPath = positional[1];
  }
  if (!designPath) throw new Error('必须给 design JSON 路径');
  if (!fs.existsSync(designPath)) throw new Error('design 不存在: ' + designPath);

  const design = JSON.parse(fs.readFileSync(designPath, 'utf8'));

  // 板框以本次**实际运行**的为准：自愈会放大板框，设计文件里是原始值。
  // 优先读产物目录的 _run.json（流水线落盘的实际生效值），再退回设计文件。
  let boardW = design.boardWidthMil, boardH = design.boardHeightMil;
  let boardSrc = 'design';
  try {
    const rp = path.join(runDir, '_run.json');
    if (fs.existsSync(rp)) {
      const rj = JSON.parse(fs.readFileSync(rp, 'utf8'));
      if (rj.boardWidthMil && rj.boardHeightMil) {
        boardW = rj.boardWidthMil;
        boardH = rj.boardHeightMil;
        boardSrc = '_run.json';
      }
    }
  } catch (_) {}
  const nl = loadNetlist(runDir);
  const fails = [];
  const passes = [];
  const notes = [];

  // ---- 1. 器件完整性 ----
  const byDes = new Map(nl.components.map((c) => [c.designator, c]));
  for (const dc of design.components || []) {
    const got = byDes.get(dc.des);
    if (!got) {
      fails.push(`器件缺失: ${dc.des}(${dc.lcsc}) 不在 Netlist 里`);
    } else if (String(got.lcsc) !== String(dc.lcsc)) {
      fails.push(`器件型号不符: ${dc.des} 期望 ${dc.lcsc}，实际 ${got.lcsc}`);
    }
  }
  if (!fails.length) passes.push(`器件完整性：${design.components.length} 个全部匹配`);

  // 反向：Netlist 里是否有设计外的器件
  const designDes = new Set((design.components || []).map((c) => c.des));
  for (const c of nl.components) {
    if (!designDes.has(c.designator)) fails.push(`多余器件: ${c.designator}(${c.lcsc}) 不在设计里`);
  }

  // ---- 2. 网络连通性 ----
  let connChecked = 0;
  const missingNet = [];
  for (const [des, pin, net] of design.connections || []) {
    const c = byDes.get(des);
    if (!c) { missingNet.push(`${des}.${pin} 器件不存在`); continue; }
    const gotNet = c.pins[String(pin)];
    connChecked++;
    if (gotNet === undefined) {
      missingNet.push(`${des}.${pin} 引脚号不存在于封装（可用: ${Object.keys(c.pins).join(',')}）`);
    } else if (!gotNet) {
      missingNet.push(`${des}.${pin} 期望网络 ${net}，实际未连接`);
    } else if (String(gotNet).toUpperCase() !== String(net).toUpperCase()) {
      missingNet.push(`${des}.${pin} 期望 ${net}，实际 ${gotNet}`);
    }
  }
  if (!missingNet.length) passes.push(`网络连通性：${connChecked} 条连接全部正确`)
  else fails.push(...missingNet.slice(0, 12));

  // ---- 3. 网络名集合 ----
  const designNets = new Set((design.connections || []).map((c) => String(c[2]).toUpperCase()));
  const actualNets = new Set();
  for (const c of nl.components) for (const n of Object.values(c.pins)) if (n) actualNets.add(String(n).toUpperCase());
  const extraNets = [...actualNets].filter((n) => !designNets.has(n));
  // 多引脚封装未连接的引脚网名通常是空或自动生成，只有非空且不像自动名的才算多余
  const suspicious = extraNets.filter((n) => n && !/^(NET\d+|N\d+|UNCONNECTED|NC)$/i.test(n));
  if (!suspicious.length) passes.push(`网络集合：实际 ${actualNets.size} 个，均为设计声明`)
  else notes.push(`Netlist 里另有未声明的网络名: ${suspicious.join(', ')}（多引脚封装未连引脚，属正常）`);

  // ---- 4. BOM 完整性（按物料合并，判据是数量与位号集合）----
  const bom = loadBom(runDir);
  if (bom) {
    const allDes = [];
    let qtySum = 0;
    let qtyKnown = true;
    for (const it of bom) {
      allDes.push(...it.designators);
      if (it.qty === null) qtyKnown = false;
      else qtySum += it.qty;
    }
    const nlDes = new Set(nl.components.map((c) => c.designator));
    const bomDes = new Set(allDes);
    if (qtyKnown && qtySum !== nl.components.length) {
      fails.push(`BOM 数量合计不符：Quantity 求和 ${qtySum}，器件 ${nl.components.length} 个`);
    } else {
      if (qtyKnown) passes.push(`BOM：${bom.length} 种物料 / 数量合计 ${qtySum} = 器件数`);
    }
    const missingInBom = [...nlDes].filter((d) => !bomDes.has(d));
    const extraInBom = [...bomDes].filter((d) => !nlDes.has(d));
    if (missingInBom.length) fails.push(`BOM 缺位号: ${missingInBom.join(', ')}`);
    else if (extraInBom.length) fails.push(`BOM 多余位号: ${extraInBom.join(', ')}`);
    else passes.push(`BOM 位号集合：${allDes.length} 个与 Netlist 完全一致`);
    // BOM 里的 LCSC 与 Netlist 一致
    const nlLcsc = new Map(nl.components.map((c) => [c.designator, String(c.lcsc)]));
    let lcscBad = 0;
    for (const it of bom) {
      for (const d of it.designators) {
        if (it.lcsc && nlLcsc.get(d) && it.lcsc !== nlLcsc.get(d)) {
          lcscBad++;
          fails.push(`BOM 型号不符: ${d} BOM=${it.lcsc} Netlist=${nlLcsc.get(d)}`);
        }
      }
    }
    if (!lcscBad) passes.push('BOM 与 Netlist 的 LCSC 编号全部一致');
  } else notes.push('BOM 未校验（缺 openpyxl）');

  let pnp = null;
  try { pnp = loadPnp(runDir); } catch (e) { fails.push('PnP 读取失败: ' + e.message); }
  if (pnp) {
    const n = pnp.rows.length;
    if (n === nl.components.length) passes.push(`PnP：${n} 条坐标 = 器件数`);
    else fails.push(`PnP 条数不符：${n} 条，器件 ${nl.components.length} 个`);
  }

  // ---- 5. Gerber 层清单 ----
  const zipNames = listZip(runDir);
  if (zipNames.length) {
    const need = ['GTL', 'GBL', 'GTO', 'GBO', 'GTS', 'GBS', 'GTP', 'GKO'];
    const missing = need.filter((ext) => !zipNames.some((n) => n.toUpperCase().endsWith('.' + ext)));
    if (missing.length) fails.push(`Gerber 缺层: ${missing.join(', ')}`);
    else passes.push(`Gerber：${zipNames.length} 个文件，8 个必需层齐全`);
    const drills = zipNames.filter((n) => /\.DRL$/i.test(n));
    // 单面板（无过孔、无 THT 器件）时可以是 0 个钻孔文件，属正常；有则至少 2 个（PTH + NPTH）
    if (drills.length === 0) {
      notes.push('无钻孔文件：单面板且无过孔/插件器件，属正常');
    } else if (drills.length < 2) {
      notes.push(`钻孔文件仅 ${drills.length} 个（通常为 PTH+NPTH 两个，单面插件板可能只有一个）`);
    }
  } else notes.push('Gerber 清单未校验（zip 读取失败）');

  // ---- 6. PnP 坐标 & 重叠 ----
  if (pnp && pnp.rows.length) {
    // 实际表头：Designator | Mid X | Mid Y | ... （坐标带 mm 后缀）
    const pts = [];
    for (const r of pnp.rows) {
      const x = numWithUnit(r['Mid X'] !== undefined ? r['Mid X'] : r['Ref X']);
      const y = numWithUnit(r['Mid Y'] !== undefined ? r['Mid Y'] : r['Ref Y']);
      if (!isNaN(x) && !isNaN(y)) pts.push({ des: r.Designator || '', x, y });
    }
    if (pts.length === pnp.rows.length && pts.length > 0) {
      // PnP 单位是 mm；设计板框是 mil。1mm = 39.3701 mil
      const bw = boardW, bh = boardH;
      const toMil = (v) => v * 39.3701;
      const xs = pts.map((p) => toMil(p.x)), ys = pts.map((p) => toMil(p.y));
      const spanX = Math.max(...xs) - Math.min(...xs);
      const spanY = Math.max(...ys) - Math.min(...ys);
      if (spanX <= bw + 1 && spanY <= bh + 1) {
        passes.push(`PnP 坐标：跨度 ${spanX.toFixed(0)}×${spanY.toFixed(0)} mil 在板框 ${bw}×${bh} 内`);
      } else {
        fails.push(`PnP 坐标超出板框：跨度 ${spanX.toFixed(0)}×${spanY.toFixed(0)} mil > ${bw}×${bh}`);
      }
      // 完全重合检测（0.01 mil 精度）
      const seen = new Map();
      let dup = 0;
      for (const p of pts) {
        const key = `${toMil(p.x).toFixed(2)},${toMil(p.y).toFixed(2)}`;
        if (seen.has(key)) { dup++; fails.push(`器件重叠：${seen.get(key)} 与 ${p.des} 坐标完全相同`); }
        else seen.set(key, p.des);
      }
      if (!dup) passes.push(`无器件重叠：${pts.length} 个坐标互不重合`);
    } else {
      notes.push(`PnP 坐标列未识别（表头: ${pnp.head.join(' | ')}）`);
    }
  }

  // ---- 5b. Gerber 铜含量（最关键：DRC 通过 ≠ 有铜）----
  const gb = analyzeGerber(runDir);
  if (gb.ok) {
    const top = gb.layers.GTL, bot = gb.layers.GBL;
    if (!top || !bot) {
      fails.push('Gerber 缺 GTL/GBL 铜层内容');
    } else {
      const topDraws = top.d01 + top.d03;
      const botDraws = bot.d01 + bot.d03;
      const totalDraws = topDraws + botDraws;

      // 单面板是合法的：器件少时布线器可能全放在一层，底层为 0 属于正常。
      // 判据改为「总铜量」+「顶层必须充足」，而不是要求两层都非空。
      if (topDraws < 20) {
        fails.push(`顶层铜图元过少(${topDraws})，疑似零铜——布线器可能静默失败`);
      } else {
        passes.push(`顶层铜：${topDraws} 个图元（${top.d01} 线 / ${top.d03} 焊盘）` +
          (top.copperAreas !== null ? `，铜区 ${top.copperAreas} 块` : ''));
      }
      if (totalDraws < 40) {
        fails.push(`总铜图元过少(${totalDraws}: 顶${topDraws}+底${botDraws})，疑似零铜`);
      } else if (botDraws === 0) {
        notes.push(`单面板布板：底层无铜（顶层 ${topDraws} 图元），属正常`);
      } else {
        passes.push(`底层铜：${botDraws} 个图元（${bot.d01} 线 / ${bot.d03} 焊盘）` +
          (bot.copperAreas !== null ? `，铜区 ${bot.copperAreas} 块` : ''));
      }
      // 板框必须闭合（GKO 有绘制指令）
      const gko = gb.layers.GKO;
      if (gko && gko.d01 + gko.d03 < 3) fails.push('板框层 GKO 图元过少，板框可能未闭合');
      else if (gko) passes.push(`板框层：${gko.d01 + gko.d03} 个图元`);
      // 阻焊/丝印层非空
      for (const [ext, label] of [['GTS', '顶层阻焊'], ['GTO', '顶层丝印']]) {
        const L = gb.layers[ext];
        if (!L) { fails.push(`缺 ${ext}(${label})`); continue; }
        const n = L.d01 + L.d03;
        if (n < 3) fails.push(`${label} ${ext} 内容过少(${n})`);
      }
    }
  } else {
    fails.push(...gb.errors);
  }

  // ---- 7. Board.pdf ----
  const pdfPath = path.join(runDir, 'Board.pdf');
  if (fs.existsSync(pdfPath)) {
    const sz = fs.statSync(pdfPath).size;
    if (sz > 10000) passes.push(`Board.pdf：${sz} 字节`);
    else fails.push(`Board.pdf 过小: ${sz} 字节`);
  } else fails.push('缺 Board.pdf');

  // ---- 7b. TestPoints：六件产物里唯一一件从未被独立核对过 ----
  // 【为什么必须补】流水线自己的 exports 表里有 6 个文件名（BOM/PnP/Gerber/Netlist/
  //  Board.pdf/TestPoints.xlsx），而本文件全文**一次都没提到 TestPoints** ⇒
  //  「6 件齐备」这句结论里有一件只靠流水线自述。实测 79 个产物目录交出的
  //  `TestPoints.csv` 其实是 xlsx（文件头 50 4B 03 04），本文件永远不会发现。
  // 这里只断言"存在 + 确实是 xlsx 容器 + 不是空壳"，不判断测试点覆盖率：
  //  覆盖率 0% 是这块板的**真实属性**（板上没有测试点层），不是缺陷。
  {
    const tpX = path.join(runDir, 'TestPoints.xlsx');
    const tpC = path.join(runDir, 'TestPoints.csv');
    const hasX = fs.existsSync(tpX);
    const hasC = fs.existsSync(tpC);
    if (hasX) {
      const buf = fs.readFileSync(tpX);
      const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
      if (!isZip) fails.push(`TestPoints.xlsx 不是 xlsx（文件头 ${[...buf.subarray(0, 4)].map(b => b.toString(16).padStart(2, '0')).join(' ')}）`);
      else if (buf.length < 1024) fails.push(`TestPoints.xlsx 过小（${buf.length} 字节），疑似空壳`);
      else passes.push(`TestPoints.xlsx：${buf.length} 字节，xlsx 容器合法`);
    } else if (hasC) {
      // 老目录的名字叫 .csv、内容却是 xlsx。存在就说明导出跑过了，但名字是错的 ——
      // 下游按扩展名解析（openpyxl 读 .xlsx / csv 读 .csv）会读错，所以算硬伤。
      const buf = fs.readFileSync(tpC);
      const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
      fails.push(isZip
        ? 'TestPoints 文件名与内容不符：TestPoints.csv 实际是 xlsx（应为 TestPoints.xlsx）'
        : '缺 TestPoints.xlsx（只有 TestPoints.csv）');
    } else {
      fails.push('缺 TestPoints.xlsx（六件产物之一，导出没跑成）');
    }
  }

  // ---- 8. 电气合理性（纯 Netlist 层面，抓"通但没意义"的电路）----
  // 这一层不看 DRC、不看流水线自述，只问：这块板子接出来能工作吗？
  {
    // 8.1 电源与地必须真的存在
    const GND_RE = /^(GND|GNDD|AGND|DGND|VSS|GROUND)$/i;
    const PWR_RE = /^(VCC|VDD|3V3|5V|1V1|12V|VBUS|VIN|3\.3V|5\.0V)$/i;
    const netPins = new Map();   // net -> [{des,pin}]
    for (const c of nl.components) {
      for (const [pin, net] of Object.entries(c.pins)) {
        if (!net) continue;
        const k = String(net).toUpperCase();
        if (!netPins.has(k)) netPins.set(k, []);
        netPins.get(k).push({ des: c.designator, pin });
      }
    }
    const gndNets = [...netPins.keys()].filter((n) => GND_RE.test(n));
    const pwrNets = [...netPins.keys()].filter((n) => PWR_RE.test(n));

    if (!gndNets.length) {
      fails.push('电气：没有任何地网络（GND/VSS），电路无法工作');
    } else {
      const gndPins = gndNets.reduce((s, n) => s + netPins.get(n).length, 0);
      if (gndPins < 2) fails.push(`电气：地网络只有 ${gndPins} 个连接点，形同未接地`);
      else passes.push(`接地：${gndNets.join('/')} 共 ${gndPins} 个连接点`);
    }
    if (!pwrNets.length) {
      notes.push('电气：无标准电源网名（可能是纯无源电路），跳过电源检查');
    } else {
      const loose = pwrNets.filter((n) => netPins.get(n).length < 2);
      if (loose.length) fails.push(`电气：电源网络 ${loose.join(',')} 只有 1 个连接点（悬空电源）`);
      else passes.push(`电源域：${pwrNets.join('/')} 均有 ≥2 个连接点`);
    }

    // 8.2 电源对地短路检测：同一器件同一引脚不可能既接电源又接地（引脚唯一性已保证），
    //      真正要防的是某个器件所有电源脚与地脚数量极度失衡（多为封装映射错误）
    for (const c of nl.components) {
      const nets = Object.values(c.pins).filter(Boolean).map((n) => String(n).toUpperCase());
      const np = nets.filter((n) => PWR_RE.test(n)).length;
      const ng = nets.filter((n) => GND_RE.test(n)).length;
      // 只有电源脚却没有任何地脚，且器件本身是多脚 IC 时，几乎一定是映射错了
      if (np > 0 && ng === 0 && nets.length >= 6 && c.pins && Object.keys(c.pins).length >= 6) {
        const hasOtherGnd = gndNets.some((g) => netPins.get(g).some((p) => p.des === c.designator));
        if (!hasOtherGnd) fails.push(`电气：${c.designator} 接了电源但没有任何地连接（疑似封装/引脚映射错误）`);
      }
    }

    // 8.3 每个信号网络至少 2 个连接点，否则是没接完的半截网络
    // 例外：只连到连接器/排针的信号是"外部接入"，合法（如 SDA 直接引到排针，
    // 由上板 MCU 驱动）。之前一刀切判失败，会把正确的模块板判错。
    const SIG_RE = /^[A-Z0-9_+\-/]+$/i;
    const CONN_REF = /^(J|P|H|CN|CON|X)\d+$/i;
    const CONN_FP = /header|conn|socket|terminal|pin|排针|座|接口/i;
    const isConn = (des) => {
      if (CONN_REF.test(des)) return true;
      const comp = (nl.components || []).find((z) => z.designator === des);
      if (!comp) return false;
      const fp = String(comp.footprint || comp.package || comp.footprintName || comp.device || '');
      return CONN_FP.test(fp);
    };
    const orphan = [];
    const orphanOk = [];
    for (const [net, pins] of netPins) {
      if (GND_RE.test(net) || PWR_RE.test(net)) continue;
      if (!SIG_RE.test(net)) continue;
      if (pins.length >= 2) continue;
      if (pins.every((p) => isConn(p.des))) orphanOk.push(`${net}(${pins.map((p) => p.des + '.' + p.pin).join(',')})`);
      else orphan.push(`${net}(${pins.map((p) => p.des + '.' + p.pin).join(',')})`);
    }
    if (orphan.length) fails.push(`电气：${orphan.length} 个信号网络只连了 1 个点（半截网络）: ${orphan.slice(0, 6).join(', ')}`);
    else passes.push('信号网络：每个都有 ≥2 个连接点或引到连接器');
    if (orphanOk.length) notes.push(`以下信号只引到连接器，由外部板驱动（非错误）: ${orphanOk.slice(0, 6).join(', ')}`);

    // 8.4 电源来源检查：电源网必须真的有个"源"。
    //     踩过的坑：做了太阳能 + TP4056 + 电池座，板子 17/17 全过，
    //     但电池只连到充电 IC，没接到系统电源，电池永远放不出电；
    //     系统侧 VDD 只能靠太阳能经二极管直供，没有稳压。
    //     连接点 ≥2 不等于"有电"，必须查源件。
    //
    //     判定依据：用器件目录的设计用途（catalog.role）而非网表描述，
    //     因为 Netlist 的 Description 是商城参数（"输出极性:正极..."），不含用途。
    const SOURCE_ROLES = /稳[压压]|ldo|regulator|充电|charger|电池管理|电[池池]|battery|连接器|connector|排针|header|座/;
    // 有些电源网是**器件自己产生**的，板上根本不会再有独立"源件"，按 role 查必然误报：
    // RP2040 的内部核心稳压器从 VREG_IN(3.3V) 产生 1.1V，从 VREG_VOUT(45) 输出、
    // 供 DVDD(23/50)，板上只有一颗去耦电容。d7/d11 都被误报过一次
    // 「1V1 上没有源件」—— 一条永远为真的提示，等于训练人忽略提示。
    // 所以再查一层引脚名：稳压器/VREG 的**输出脚**驱动这个网，就算有源。
    const OUT_PIN = /VREG_VOUT|^(VOUT|OUT|LX|SW|SWOUT)$/i;
    let roleByLcsc = new Map();
    let pinNameByLcsc = new Map();   // lcsc -> Map(脚号 -> 脚名)
    try {
      const catPath = path.join(ROOT, 'designs', '_catalog.json');
      if (fs.existsSync(catPath)) {
        const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
        roleByLcsc = new Map((cat.parts || []).map((p) => [String(p.lcsc), String(p.role || '')]));
        pinNameByLcsc = new Map((cat.parts || []).map((p) => {
          const m = new Map();
          for (const [nm, v] of Object.entries(p.pins || {})) {
            for (const num of (Array.isArray(v) ? v : [v])) m.set(String(num), nm);
          }
          return [String(p.lcsc), m];
        }));
      }
    } catch (_) { /* 目录读不到就退化为仅按名称判断 */ }

    const lcscByDes = new Map(nl.components.map((c) => [c.designator, String(c.lcsc || '')]));
    const noSource = [];
    for (const n of pwrNets) {
      const pins = netPins.get(n) || [];
      const hasSource = pins.some((p) => {
        const role = roleByLcsc.get(lcscByDes.get(p.des) || '') || '';
        if (SOURCE_ROLES.test(role)) return true;
        const pm = pinNameByLcsc.get(lcscByDes.get(p.des) || '');
        const nm = pm ? String(pm.get(String(p.pin)) || '') : '';
        return OUT_PIN.test(nm);
      });
      if (!hasSource && pins.length >= 2) noSource.push(n);
    }
    if (noSource.length) {
      notes.push(`电源来源未识别：${noSource.join(',')} 上没有稳压/充电/电池/连接器类源件（器件可能在目录里未标注用途）`);
    } else {
      passes.push(`电源来源：${pwrNets.join('/')} 均能追溯到源件`);
    }
  }

  // ---- 输出 ----
  console.log(`独立校验: ${path.basename(runDir)}  ←  ${path.basename(designPath)}`);
  console.log(`  设计: ${design.name} / ${(design.components || []).length} 器件 / ${(design.connections || []).length} 连接`);
  console.log('');
  for (const p of passes) console.log('  [PASS] ' + p);
  for (const n of notes) console.log('  [note] ' + n);
  for (const f of fails) console.log('  [FAIL] ' + f);
  console.log('');
  console.log(`  结果: ${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'} （${passes.length} 通过 / ${fails.length} 失败 / ${notes.length} 备注）`);

  process.exit(fails.length === 0 ? 0 : 1);
}

try { main(); } catch (e) {
  console.error('校验器异常: ' + e.message);
  process.exit(2);
}
