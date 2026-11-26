#!/usr/bin/env node
'use strict';
/**
 * fabcheck.js —— **纯离线**打样可行性检查器（DFM gate）
 *
 * 与 verify-artifacts.js 的分工：
 *   verify-artifacts 判「电路/设计意图对不对」（要 designs/*.json，BOM 要 openpyxl）；
 *   本工具判「这堆文件能不能直接拿去嘉立创下单」——只看 out/<run>/ 内的产物本身，
 *   不读 designs/，不要求 python/openpyxl/xlsx/pwsh，全部用 Node 内置模块解析
 *   （ZIP 自己解、xlsx 按 OOXML 手工读、Gerber/NC 自己解）。
 *
 * 用法：
 *   node scripts/fabcheck.js <产物目录>
 *   node scripts/fabcheck.js <产物目录> --quiet          # 只输出一行人类摘要
 *   node scripts/fabcheck.js --selftest <产物目录>       # 自证：构造坏样本并断言 exit 1
 *   node scripts/fabcheck.js --help
 *
 * 退出码：0 = 可打样（无阻断项，警告不影响下单）
 *         1 = 有阻断问题（至少一条 blocker）
 *         2 = 参数 / 环境错误（路径不存在、文件读不了、解析器崩了）
 *
 * 输出：stdout 一个 JSON（--quiet 时改为一行摘要）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const REQUIRED = ['Gerber.zip', 'BOM.xlsx', 'PnP.csv', 'Netlist.json', 'Board.pdf'];
const GERBER_REQUIRED = ['GTL', 'GBL', 'GTS', 'GBS', 'GTO', 'GBO', 'GTP', 'GKO'];
// 铜/阻焊/钢网层超框 = 板子做不出来；丝印超框 = 印刷时裁掉，可接受
const COPPER_LAYERS = ['GTL', 'GBL', 'GTS', 'GBS', 'GTP'];
const SILK_LAYERS = ['GTO', 'GBO'];
const EPS_MM = 0.02;   // 坐标容差（Gerber 4.5 格式 + 线宽中心线取整）

/* ============================ ZIP（只读 + 只存写） ============================ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 读 ZIP → Map<name, Buffer>。CRITICAL：csize/crc 一律取中央目录，不信本地头。 */
function readZip(buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法 ZIP（找不到 EOCD）');
  let count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff) throw new Error('ZIP64 中心目录不支持');
  const out = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const csize = buf.readUInt32LE(off + 20);
    const nlen = buf.readUInt16LE(off + 28);
    const elen = buf.readUInt16LE(off + 30);
    const clen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nlen);
    off += 46 + nlen + elen + clen;
    if (name.endsWith('/')) continue;
    if (lho + 30 > buf.length) throw new Error('ZIP 本地头越界: ' + name);
    const dstart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (dstart + csize > buf.length) throw new Error('ZIP 数据越界: ' + name);
    const raw = buf.subarray(dstart, dstart + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`ZIP 压缩方式 ${method} 不支持: ${name}`);
    if (crc32(data) !== crc) throw new Error('ZIP CRC 校验失败: ' + name);
    out.set(name, data);
  }
  return out;
}

/** 只写 STORED 的 ZIP（仅 --selftest 构造坏样本用） */
function writeZipStored(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

/* ============================ xlsx（OOXML 手工解析） ============================ */

function unesc(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&amp;/g, '&');
}
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 读第一个 worksheet，返回二维单元格数组（字符串/数字）。
 * 只支持嘉立创 BOM 总会用到的子集：sharedStrings、inlineStr、数值。
 */
function readXlsxFirstSheet(buf) {
  const z = readZip(buf);
  const pick = (re) => [...z.keys()].filter((k) => re.test(k)).sort((a, b) => {
    const na = +(a.match(/(\d+)\.xml$/) || [, 0])[1];
    const nb = +(b.match(/(\d+)\.xml$/) || [, 0])[1];
    return na - nb;
  })[0];
  const ssRaw = z.get('xl/sharedStrings.xml');
  const shared = [];
  if (ssRaw) {
    const xml = ssRaw.toString('utf8');
    for (const si of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const parts = [...si[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1]));
      shared.push(parts.join(''));
    }
  }
  const sheetName = z.has('xl/worksheets/sheet1.xml') ? 'xl/worksheets/sheet1.xml' : pick(/^xl\/worksheets\/sheet\d+\.xml$/);
  if (!sheetName) throw new Error('xlsx 里找不到 worksheet');
  const xml = z.get(sheetName).toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
      let v;
      if (t === 'inlineStr') {
        v = [...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('');
      } else {
        const vm = body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        if (!vm) { v = ''; } else if (t === 's') { v = shared[+vm[1]] ?? ''; } else if (t === 'str') { v = unesc(vm[1]); } else { v = vm[1]; }
      }
      const ci = colIndex(ref);
      if (ci >= 0) cells[ci] = v;
    }
    rows.push(cells);
  }
  return rows;
}

/* ============================ 分隔文本（PnP.csv） ============================ */

function decodeText(buf) {
  let enc = 'utf8';
  let text;
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe) { enc = 'utf16le'; text = buf.toString('utf16le'); }
  else if (buf.length > 2 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { enc = 'utf8-bom'; text = buf.toString('utf8'); }
  else if (buf.length > 1 && buf[0] === 0xfe && buf[1] === 0xff) { enc = 'utf16be'; text = buf.subarray(2).swap16().toString('utf16le'); }
  else text = buf.toString('utf8');
  return { enc, text: text.replace(/^\uFEFF/, '') };
}
function splitLine(line, sep) {
  // 支持带引号字段（EasyEDA 会整行加引号）
  if (!line.includes('"')) return line.split(sep).map((s) => s.trim());
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (ch === sep && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function parseTable(buf) {
  const { enc, text } = decodeText(buf);
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('文件为空');
  const first = lines[0];
  const tabs = (first.match(/\t/g) || []).length;
  const commas = (first.match(/,/g) || []).length;
  const sep = tabs > commas ? '\t' : ',';
  const head = splitLine(first, sep);
  const rows = lines.slice(1).map((l) => {
    const cells = splitLine(l, sep);
    const o = {};
    head.forEach((h, i) => { o[h] = cells[i] === undefined ? '' : cells[i]; });
    return o;
  });
  return { enc, sep, head, rows };
}
/** 表头名归一化：去空格/大小写/非字母数字，便于 'Mid X' vs 'MidX' */
const normHead = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function pickCol(head, cands) {
  const map = new Map(head.map((h, i) => [normHead(h), i]));
  for (const c of cands) {
    const k = normHead(c);
    if (map.has(k)) return head[map.get(k)];
  }
  for (const h of head) { const n = normHead(h); if (cands.some((c) => n.includes(normHead(c)))) return h; }
  return null;
}

/* ============================ Gerber / NC 钻孔 ============================ */

function parseGerber(text) {
  const fsm = text.match(/%FSLAX(\d)(\d)Y(\d)(\d)\*%/) || text.match(/%FSLAX(\d)(\d)Y(\d)(\d)\*%/);
  const dec = fsm ? +fsm[2] : 5;
  const inch = /%MOIN\*%/.test(text);
  const scale = inch ? 25.4 : 1;
  // 先剥掉扩展命令（%FSLAX45Y45*%、%MOMM*%、%ADD..*%）和注释（G04 ...*）。
  // 不剥的话，格式说明符 `%FSLAX45Y45*%` 里的 `X45Y45` 会被当成坐标 (0.00045, 0.00045)，
  // 于是板框 bbox 被钉在原点附近：w/h 变成"绝对坐标"而不是"尺寸"，
  // 任何不包含原点的板子还会被误报"图元越框"。
  // 实测 AI_OLED_底板_5p5g6m 的板框被报成 59.97×67.10mm，真实是 51.84×38.89mm。
  const body = text
    .replace(/%[^*]*\*%/g, ' ')
    .replace(/G04[^*]*\*/g, ' ');
  const coords = [];
  for (const m of body.matchAll(/X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)/g)) {
    const px = m[1].includes('.') ? parseFloat(m[1]) : parseInt(m[1], 10) / 10 ** dec;
    const py = m[2].includes('.') ? parseFloat(m[2]) : parseInt(m[2], 10) / 10 ** dec;
    coords.push({ x: px * scale, y: py * scale });
  }
  const count = (re) => (text.match(re) || []).length;
  // 供板框闭合判定复用：把 Gerber 原始整数按 FS 声明的隐含小数位换成 mm
  const toMm = (sx, sy) => ({
    x: (sx.includes('.') ? parseFloat(sx) : parseInt(sx, 10) / 10 ** dec) * scale,
    y: (sy.includes('.') ? parseFloat(sy) : parseInt(sy, 10) / 10 ** dec) * scale,
  });
  return {
    d01: count(/D0*1\*/g),
    d02: count(/D0*2\*/g),
    d03: count(/D0*3\*/g),
    regions: count(/G36\*/g),
    coords,
    bytes: text.length,
    fsFound: !!fsm,
    inch,
    dec,
    toMm,
  };
}

function parseDrill(text) {
  const fm = text.match(/METRIC,LZ,(\d+)\.(\d+)/) || text.match(/METRIC,(?:TZ|LZ),(\d+)\.(\d+)/);
  const dec = fm ? +fm[2] : null;
  const inch = /^INCH/m.test(text) || /,INCH/.test(text);
  const scale = inch ? 25.4 : 1;
  const tools = new Map();
  const marks = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^T0*(\d+)C([\d.]+)/.exec(line);
    if (m) { tools.set(+m[1], parseFloat(m[2]) * scale); continue; }
    m = /^T0*(\d+)$/.exec(line);
    if (m) { cur = +m[1]; continue; }
    m = /^X(-?[\d.]+)Y(-?[\d.]+)/.exec(line);
    if (m) {
      const conv = (s) => (s.includes('.') ? parseFloat(s) : (dec !== null ? parseInt(s, 10) / 10 ** dec : parseFloat(s))) * scale;
      marks.push({ x: conv(m[1]), y: conv(m[2]), tool: cur, dia: cur !== null && tools.has(cur) ? tools.get(cur) : null });
    }
  }
  return { tools, marks, dec, inch };
}

/* ============================ 检查主体 ============================ */

function check(dir, opts) {
  opts = opts || {};
  const blockers = [];
  const warns = [];
  const notes = [];
  const passes = [];
  const B = (id, msg, ev) => blockers.push({ id, level: 'blocker', msg, evidence: ev });
  const W = (id, msg, ev) => warns.push({ id, level: 'warn', msg, evidence: ev });
  const N = (id, msg, ev) => notes.push({ id, level: 'note', msg, evidence: ev });
  const P = (id, msg, ev) => passes.push({ id, level: 'pass', msg, evidence: ev });
  const facts = { dir, files: {}, board: null };

  // ---------- 0. 目录 ----------
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('目录不存在: ' + dir);

  // ---------- 1. 必需文件齐全 + 非空 + magic ----------
  const present = new Map();
  for (const n of REQUIRED) {
    const p = path.join(dir, n);
    if (!fs.existsSync(p)) { B('file.missing', `缺必需文件 ${n}`); continue; }
    const st = fs.statSync(p);
    if (!st.isFile()) { B('file.missing', `${n} 不是文件`); continue; }
    if (st.size === 0) { B('file.empty', `${n} 是 0 字节`); continue; }
    present.set(n, { p, size: st.size, buf: fs.readFileSync(p) });
    facts.files[n] = st.size;
  }
  // TestPoints：流水线实测导出的是 xlsx，fix-artifacts 会改名 → 两种名字都接受
  const tpCsv = path.join(dir, 'TestPoints.csv');
  const tpXlsx = path.join(dir, 'TestPoints.xlsx');
  let tpPath = null;
  let tpIsZip = false;
  if (fs.existsSync(tpXlsx) && fs.statSync(tpXlsx).size > 0) { tpPath = tpXlsx; tpIsZip = true; }
  else if (fs.existsSync(tpCsv) && fs.statSync(tpCsv).size > 0) {
    tpPath = tpCsv;
    const b = fs.readFileSync(tpCsv);
    tpIsZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b;
    if (tpIsZip) W('testpoints.format', 'TestPoints.csv 实际是 xlsx（PK 头）：任何 CSV 解析器都会崩，应改名 .xlsx', { magic: '504b' });
  } else B('file.missing', '缺 TestPoints.csv / TestPoints.xlsx（测试点报告）');
  if (tpPath) facts.files[path.basename(tpPath)] = fs.statSync(tpPath).size;

  const magic = (name, want) => {
    const e = present.get(name);
    if (!e) return;
    const b = e.buf;
    let ok;
    if (want === 'zip') ok = b.length > 3 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
    else if (want === 'json') ok = b.length > 1 && (b[0] === 0x7b || (b[0] === 0xef && b[1] === 0xbb));
    else if (want === 'pdf') ok = b.subarray(0, 5).toString('latin1') === '%PDF-';
    if (!ok) B('file.magic', `${name} 文件头不是 ${want}`, { head: hexHead(b) });
  };
  magic('Gerber.zip', 'zip');
  magic('BOM.xlsx', 'zip');
  magic('Netlist.json', 'json');
  magic('Board.pdf', 'pdf');
  {
    const e = present.get('PnP.csv');
    if (e) {
      const isZip = e.buf.length > 3 && e.buf[0] === 0x50 && e.buf[1] === 0x4b;
      if (isZip) B('file.magic', 'PnP.csv 是 xlsx/zip（不是 CSV）', { head: hexHead(e.buf) });
    }
  }
  if (blockers.length === 0) P('files.present', `${REQUIRED.length + 1} 个交付文件齐全且非空`);

  // ---------- 2. _run.json（板框真值） ----------
  let runMeta = null;
  try {
    const p = path.join(dir, '_run.json');
    if (fs.existsSync(p)) {
      runMeta = JSON.parse(fs.readFileSync(p, 'utf8'));
      facts.run = {
        designName: runMeta.designName || null,
        boardWidthMil: runMeta.boardWidthMil || null,
        boardHeightMil: runMeta.boardHeightMil || null,
        generatedAt: runMeta.generatedAt || null,
        ok: runMeta.ok,
      };
    } else W('run.missing', '_run.json 缺失：无法核对"本次实际生效"的板框（自愈会放大板框，设计文件里的原值不可信）');
  } catch (e) { W('run.parse', '_run.json 解析失败: ' + e.message); }

  // ---------- 3. Gerber：层、铜、阻焊、丝印、板框、超框 ----------
  const layers = new Map();   // ext -> parsed
  let board = null;           // GKO bbox (mm)
  if (present.has('Gerber.zip')) {
    let z = null;
    try { z = readZip(present.get('Gerber.zip').buf); }
    catch (e) { B('gerber.zip.invalid', 'Gerber.zip 解不开: ' + e.message); }
    if (z) {
      if (!z.size) B('gerber.zip.invalid', 'Gerber.zip 里没有任何文件');
      const byExt = new Map();
      for (const [name, data] of z) {
        const ext = (name.match(/\.([A-Za-z0-9]{3})$/) || [, ''])[1].toUpperCase();
        if (GERBER_REQUIRED.includes(ext)) byExt.set(ext, { name, data });
      }
      facts.gerberFiles = [...z.keys()].sort();
      for (const ext of GERBER_REQUIRED) {
        if (!byExt.has(ext)) { B('gerber.layer.missing', `Gerber 缺 ${ext} 层`); continue; }
        layers.set(ext, parseGerber(byExt.get(ext).data.toString('utf8')));
      }
      // 板框先解析：其它所有层的超框判定都依赖它
      if (layers.has('GKO')) {
        const g = layers.get('GKO');
        const xs = g.coords.map((c) => c.x);
        const ys = g.coords.map((c) => c.y);
        if (!xs.length) B('gerber.outline.empty', 'GKO 板框层没有任何坐标');
        else {
          board = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
          board.w = board.maxX - board.minX;
          board.h = board.maxY - board.minY;
          facts.board = { minX: r3(board.minX), maxX: r3(board.maxX), minY: r3(board.minY), maxY: r3(board.maxY), w: r3(board.w), h: r3(board.h), src: 'GKO' };
        }
        if (g.d01 + g.d03 < 3) B('gerber.outline.d01', `板框 GKO 只有 ${g.d01} 段 D01，板框未成形`, { d01: g.d01 });
        else {
          // 闭合：**逐轮廓**判定。旧实现（取全文件第一个 D02 起点比全文件最后一个 D01
          // 终点）只在 GKO 恰好只有一个轮廓时成立，而这个前提是错的：GKO 是
          // BoardOutlineLayer，同一个文件里同时承载 BoardOutline 与 BoardCutout
          // （见 Gerber 文件头 `G04 Object Configs:` 一行自己列了 BoardCutout）。
          // 带槽孔的板子必然有 >=2 个轮廓，于是旧实现拿**外框的起点**去比**槽的终点**。
          // 实测 ESP32S3_Wireless_Mic_V3-20261126-175901 报「差 89.6047mm」，而它 GKO 里
          // 两个轮廓各自闭合、缺口都是 0.000000mm —— 那唯一的阻断项是量具自己的缺陷。
          // 全语料复核（2026-11-26，70 个 Gerber.zip / 78 个轮廓）：旧实现判未闭合 8 个，
          // 逐轮廓判 0 个，真阳性 0 个。这 8 个全是「矩形 + 一个 stadium 槽」。
          // 注意不是把容差放宽：是旧实现**原理上没有**正确能力。
          const line = byExt.get('GKO').data.toString('utf8')
            // 先剥掉参数块与注释，否则 `%FSLAX45Y45*%` 里的 `X45Y45` 会被当成坐标。
            .replace(/%[^*]*\*%/g, ' ')
            .replace(/G04[^*]*\*/g, ' ');
          // `[^XD]*?` 负责吸收圆弧（G02/G03）夹带的 I/J 参数：一次带圆弧的画线长成
          // `G02X..Y..I..J..D01*`，只写 `X..Y..D01` 会把槽轮廓的封闭段整段漏掉，
          // 那样算出来的「闭合」是假的。排除 X 和 D 是为了不跨越到下一条命令。
          const contours = [];
          let cur = null;
          for (const m of line.matchAll(/X(-?\d+(?:\.\d+)?)Y(-?\d+(?:\.\d+)?)[^XD]*?D0?([123])\*/g)) {
            const pt = g.toMm(m[1], m[2]);
            const d = m[3];
            if (d === '2') {
              if (cur) contours.push(cur);
              cur = { start: pt, last: pt, draws: 0 };
            } else if (d === '3') {
              // 区域填充的闪光点不是轮廓线：它只定位，不画线
              if (!cur) cur = { start: pt, last: pt, draws: 0 };
            } else if (cur) {
              cur.last = pt;
              cur.draws += 1;
            }
          }
          if (cur) contours.push(cur);
          // **必须滤掉 0 画线的空轮廓**。文件末尾那条 `X..Y..D02*` 会留下一个
          // start===last 的空轮廓，缺口恒为 0；若把它算进分母，「末段 D01 改成 D02」
          // 这类真断口会被这个空轮廓静默放行 —— 那正是 test/mutants 里
          // gerber.outline.closed 的突变形状，等于把闸门自己弄瞎。
          const drawn = contours.filter((c) => c.draws > 0);
          if (!drawn.length) B('gerber.outline.closed', '板框找不到任何画线段（D02 起点 + D01 终点），无法确认闭合');
          else {
            const measured = drawn.map((c) => ({ c, gap: Math.hypot(c.start.x - c.last.x, c.start.y - c.last.y) }));
            const unclosed = measured.filter((x) => x.gap > EPS_MM);
            const worst = measured.reduce((a, b) => (b.gap > a.gap ? b : a));
            if (unclosed.length) {
              B('gerber.outline.closed', `板框有轮廓未闭合：${unclosed.length}/${drawn.length} 个轮廓，最大缺口 ${worst.gap.toFixed(4)}mm`, {
                contours: drawn.length,
                unclosed: unclosed.length,
                gap: r3(worst.gap),
                from: [r3(worst.c.start.x), r3(worst.c.start.y)],
                to: [r3(worst.c.last.x), r3(worst.c.last.y)],
              });
            } else {
              P('gerber.outline', `GKO 闭合，${drawn.length} 个轮廓（${g.d01} 段 D01），尺寸 ${board ? board.w.toFixed(2) : '?'}×${board ? board.h.toFixed(2) : '?'}mm`);
            }
          }
        }
        // 与 _run.json 实际板框对齐（±0.1mm）
        if (board && runMeta && runMeta.boardWidthMil && runMeta.boardHeightMil) {
          const bw = runMeta.boardWidthMil * 0.0254;
          const bh = runMeta.boardHeightMil * 0.0254;
          const dw = Math.abs(board.w - bw);
          const dh = Math.abs(board.h - bh);
          // 不一致只报 WARN，不报 blocker。
          // 理由：PCB 厂按 **Gerber** 生产，不按 `_run.json`。板框比声明大或小都仍然能做；
          // 真正致命的是"图元落在板框外会被裁掉"，那是 gerber.coord.outside，另一处独立检查。
          // 实测（106 个目录）：`outlineFit.fits=false`（器件装不下、板框被强行撑大）的目录里
          // Gerber 总比 `_run.json` 大 —— 那是声明没有回写，属记录缺陷。
          // 把它判成"不能下单"会让每一块被撑过板框的板子都被误判，而它们其实是能做的。
          if (dw > 0.1 || dh > 0.1) {
            W('gerber.outline.size', `板框 ${board.w.toFixed(2)}×${board.h.toFixed(2)}mm ≠ _run.json ${bw.toFixed(2)}×${bh.toFixed(2)}mm（声明与 Gerber 不一致；按 Gerber 生产，可能是 _run.json 陈旧）`, { dw: r3(dw), dh: r3(dh) });
          } else P('gerber.outline.size', `板框尺寸与 _run.json 一致（${bw.toFixed(2)}×${bh.toFixed(2)}mm）`);
        }
      }
      // 铜/阻焊/钢网：非空 + 超框
      for (const ext of COPPER_LAYERS.concat(SILK_LAYERS)) {
        const g = layers.get(ext);
        if (!g) continue;
        const n = g.d01 + g.d03 + g.regions;
        facts.layers = facts.layers || {};
        facts.layers[ext] = { d01: g.d01, d02: g.d02, d03: g.d03, regions: g.regions, elems: n, bytes: g.bytes };
        if (n === 0) {
          const silk = SILK_LAYERS.includes(ext);
          N('gerber.layer.empty', `${ext} 是 0 图元层（只有文件头，${g.bytes} 字节）`, { d01: 0, d03: 0 });
        }
        if (board && g.coords.length) {
          const out = g.coords.filter((c) => c.x < board.minX - EPS_MM || c.x > board.maxX + EPS_MM || c.y < board.minY - EPS_MM || c.y > board.maxY + EPS_MM);
          if (out.length) {
            const ev = { count: out.length, example: out.slice(0, 3).map((c) => [r3(c.x), r3(c.y)]) };
            if (COPPER_LAYERS.includes(ext)) B('gerber.coord.outside', `${ext} 有 ${out.length} 个图元落在板框外（板子做不出来/会被裁掉）`, ev);
            else W('gerber.coord.outside.silk', `${ext} 有 ${out.length} 个图元超出板框（丝印会被裁，可接受）`, ev);
          }
        }
      }
      // 铜层必须有内容
      const gtl = layers.get('GTL');
      const gbl = layers.get('GBL');
      if (gtl && gtl.d01 + gtl.d03 === 0) B('gerber.copper.empty', 'GTL 顶层铜 0 图元：板上没有铜');
      else if (gtl && gtl.d01 === 0) B('gerber.traces.empty', `GTL 有 ${gtl.d03} 个焊盘闪但没有一条 D01 走线：未布线`, { d01: 0, d03: gtl.d03 });
      if (gbl && gbl.d01 + gbl.d03 === 0) N('gerber.bottom.empty', 'GBL 底层无铜（单面板布局，属正常）');
      if (gtl && gbl && (gtl.d01 + gtl.d03 + gbl.d01 + gbl.d03) < 40) {
        B('gerber.copper.thin', `总铜图元 ${gtl.d01 + gtl.d03 + gbl.d01 + gbl.d03} < 40，疑似零铜`);
      } else if (gtl) P('gerber.copper', `GTL ${gtl.d01} 线/${gtl.d03} 焊盘, GBL ${gbl ? gbl.d01 : '-'} 线/${gbl ? gbl.d03 : '-'} 焊盘`);
    }
  }

  // ---------- 4. NC 钻孔：孔径种类 / 每类孔数 / 重复孔位 ----------
  let drillInfo = null;
  if (present.has('Gerber.zip')) {
    try {
      const z = readZip(present.get('Gerber.zip').buf);
      // 钻孔文件识别：`.TXT` 这一支曾经把厂商说明 `PCB下单必读.txt` 当成钻带，
      // 它当然解析出 0 个孔 → 触发 drill.empty 阻断。
      // 结果把「这块板没有钻孔文件」（本该是 note，无过孔/无插件孔属正常）
      // 误报成「有 1 个钻孔文件但里面一个孔都没有」—— 消息本身就是错的。
      // 实测 5 个目录因此被判不能下单，其中 3 个自述 ok=true。
      const isDrillName = (n) => /\.(DRL|NC|DRR)$/i.test(n)
        || (/\.TXT$/i.test(n) && !/必读|readme|说明/i.test(n) && /drill|pth|npth|via|hole/i.test(n));
      const drillFiles = [...z.keys()].filter(isDrillName);
      const nonDrill = [...z.keys()].filter((n) => !isDrillName(n));
      if (nonDrill.some((n) => /必读|readme/i.test(n))) notes.push({ id: 'gerber.extra', level: 'note', msg: `Gerber.zip 里附带厂商说明文件: ${nonDrill.filter((n) => /必读|readme/i.test(n)).join(',')}` });
      if (!drillFiles.length) {
        N('drill.none', 'Gerber.zip 里没有 NC 钻孔文件（无过孔/无插件孔的单面板属正常）');
      } else {
        const files = [];
        const all = [];
        for (const n of drillFiles) {
          const d = parseDrill(z.get(n).toString('utf8'));
          const kind = /NPTH/i.test(n) ? 'NPTH' : /Via/i.test(n) ? 'VIA' : /PTH/i.test(n) ? 'PTH' : 'UNKNOWN';
          files.push({ name: n, kind, tools: [...d.tools.entries()], marks: d.marks });
          for (const m of d.marks) all.push({ ...m, file: n, kind });
        }
        const byDia = new Map();
        for (const m of all) {
          const k = m.dia === null ? 'null' : m.dia.toFixed(5);
          byDia.set(k, (byDia.get(k) || 0) + 1);
        }
        const uniq = new Map();
        const dups = [];
        for (const m of all) {
          const k = `${m.x.toFixed(5)},${m.y.toFixed(5)},${m.dia === null ? 'null' : m.dia.toFixed(5)}`;
          if (uniq.has(k)) dups.push({ at: [r3(m.x), r3(m.y)], dia: m.dia, firstFile: uniq.get(k).file, dupFile: m.file });
          else uniq.set(k, m);
        }
        const noTool = all.filter((m) => m.dia === null);
        drillInfo = {
          files: files.map((f) => ({ name: f.name, kind: f.kind, holes: f.marks.length, tools: f.tools })),
          declared: all.length,
          unique: uniq.size,
          byDia: [...byDia.entries()].sort((a, b) => +a[0] - +b[0]).map(([dia, n]) => ({ dia: dia === 'null' ? null : +dia, holes: n })),
          duplicateHoles: dups.length,
        };
        facts.drill = drillInfo;
        if (!all.length) B('drill.empty', `有 ${drillFiles.length} 个钻孔文件但里面一个孔都没有`);
        if (noTool.length) B('drill.tool.missing', `${noTool.length} 个孔坐标没有有效刀具（T 定义缺失/未选择刀具），孔会打不出来`, { example: noTool.slice(0, 3).map((m) => [r3(m.x), r3(m.y)]) });
        if (board) {
          const out = all.filter((m) => m.x < board.minX - EPS_MM || m.x > board.maxX + EPS_MM || m.y < board.minY - EPS_MM || m.y > board.maxY + EPS_MM);
          if (out.length) B('drill.outside', `${out.length} 个孔落在板框外`, { example: out.slice(0, 3).map((m) => [r3(m.x), r3(m.y)]) });
        }
        if (dups.length) {
          W('drill.duplicate', `同一孔位被登记了 ${dups.length} 次（声明 ${all.length} 孔 / 唯一 ${uniq.size} 孔）：嘉立创 CAM 通常自动去重，但孔数计费翻倍，且不去重的厂会二次钻孔`,
            { pairs: dups.slice(0, 5).map((d) => ({ at: d.at, dia: d.dia, files: [d.firstFile, d.dupFile] })) });
        } else {
          P('drill.unique', `钻孔无重复：${uniq.size} 孔 / ${byDia.size} 种孔径`);
        }
        // 插件孔数（PTH 去 Via）应等于 GBS 底层开窗闪数
        const gbs = layers.get('GBS');
        const pth = files.filter((f) => f.kind === 'PTH');
        const via = files.filter((f) => f.kind === 'VIA');
        if (pth.length && gbs) {
          const key = (m) => `${m.x.toFixed(5)},${m.y.toFixed(5)}`;
          const pset = new Set(pth.flatMap((f) => f.marks.map(key)));
          for (const f of via) for (const m of f.marks) pset.delete(key(m));
          const tht = pset.size;
          if (tht !== gbs.d03) {
            W('drill.tht.mismatch', `插件焊盘孔 ${tht} 个，但 GBS 底层阻焊开窗闪只有 ${gbs.d03} 个（不一致：可能少开窗或孔被并档）`, { thtHoles: tht, gbsFlashes: gbs.d03 });
          } else if (tht) P('drill.tht', `插件孔 ${tht} = GBS 开窗 ${gbs.d03}，两层自洽`);
        }
      }
    } catch (e) { B('drill.parse', '钻孔解析失败: ' + e.message); }
  }

  // ---------- 5. 阻焊 / 丝印 语义化判定 ----------
  const pnpLater = { rows: [] };
  // 先记下 GTS/GBS/GTO/GBO 图元数，等 PnP 读完再判"底层该不该有内容"
  const layerCount = (ext) => {
    const g = layers.get(ext);
    return g ? g.d01 + g.d03 + g.regions : null;
  };

  // ---------- 6. BOM.xlsx（手工 OOXML） ----------
  let bom = null;
  if (present.has('BOM.xlsx')) {
    try {
      const rows = readXlsxFirstSheet(present.get('BOM.xlsx').buf);
      let hi = -1;
      let hdr = null;
      for (let i = 0; i < rows.length; i++) {
        const idx = (rows[i] || []).findIndex((c) => String(c == null ? '' : c).trim().toLowerCase() === 'designator');
        if (idx >= 0) { hi = i; hdr = rows[i].map((c) => String(c == null ? '' : c).trim()); break; }
      }
      if (hi < 0) B('bom.parse', 'BOM.xlsx 找不到 Designator 表头（不是嘉立创 BOM 模板）');
      else {
        const ix = (name) => hdr.findIndex((h) => h.toLowerCase() === name.toLowerCase());
        const di = ix('Designator');
        const qi = ix('Quantity');
        const si = ix('Supplier Part');
        const vi = ix('Value');
        const ci = ix('Comment');
        const mi = ix('Manufacturer Part');
        const items = [];
        for (const r of rows.slice(hi + 1)) {
          const desRaw = r && r[di] !== undefined ? String(r[di]).trim() : '';
          if (!desRaw) continue;
          const designators = desRaw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
          const q = qi >= 0 && r[qi] !== undefined ? Number(String(r[qi]).trim()) : null;
          items.push({
            designators,
            qty: Number.isFinite(q) ? q : null,
            lcsc: si >= 0 && r[si] !== undefined ? String(r[si]).trim() : '',
            value: vi >= 0 && r[vi] !== undefined ? String(r[vi]).trim() : '',
            comment: ci >= 0 && r[ci] !== undefined ? String(r[ci]).trim() : '',
            mpn: mi >= 0 && r[mi] !== undefined ? String(r[mi]).trim() : '',
          });
        }
        const allDes = items.flatMap((it) => it.designators);
        const set = new Set(allDes);
        const qtySum = items.reduce((s, it) => s + (it.qty || 0), 0);
        bom = { items, designators: set, designatorList: allDes, qtySum, rows: items.length };
        facts.bom = { rows: items.length, designators: allDes.length, qtySum, lcscMissing: items.filter((it) => !it.lcsc).length };
        if (!allDes.length) B('bom.empty', 'BOM 没有任何位号');
        if (new Set(allDes).size !== allDes.length) {
          const dup = allDes.filter((d, i) => allDes.indexOf(d) !== i);
          B('bom.duplicate', `BOM 位号重复: ${[...new Set(dup)].join(',')}`);
        }
        if (qtySum && qtySum !== allDes.length) W('bom.qty', `BOM Quantity 求和 ${qtySum} ≠ 位号个数 ${allDes.length}（数量与位号自相矛盾）`);
        const noLcsc = items.filter((it) => !it.lcsc);
        if (noLcsc.length) W('bom.lcsc', `${noLcsc.length} 行没有 LCSC 编号，无法备料: ${noLcsc.map((it) => it.designators.join(',')).join(' / ')}`);
        else P('bom.lcsc', `BOM ${items.length} 行全部带 LCSC 编号`);
        // 值 ↔ 物料型号（FAB-AUDIT §3 P1：标 4.7k 却发 1k 的 0402WGF1001TCE = 会错件）
        const mism = [];
        for (const it of items) {
          const v = parsePassiveValue(it.value || it.comment);
          const m = parseMpnCode(it.mpn);
          if (!v || !m || v.kind !== m.kind) continue;
          if (Math.abs(v.v - m.v) / Math.max(m.v, 1e-12) > 0.02) {
            mism.push({ des: it.designators.join(','), value: it.value || it.comment, mpn: it.mpn, lcsc: it.lcsc, parsedValue: v.v, parsedMpn: m.v, unit: v.kind });
          }
        }
        facts.bomValueCheck = { checked: items.length, mismatches: mism.length };
        if (mism.length) {
          W('bom.value.mismatch', `${mism.length} 行"标注值"与"物料型号"不符：实发件会让电路参数偏离（例：${mism[0].des} 标 ${mism[0].value}，${mism[0].mpn} 实为 ${fmtSI(mism[0].parsedMpn, mism[0].unit)}）`, { rows: mism.slice(0, 6) });
        } else {
          const n = items.filter((it) => parsePassiveValue(it.value || it.comment) && parseMpnCode(it.mpn)).length;
          P('bom.value', n ? `阻容标注值与物料编码一致（核对 ${n} 行）` : '无可核对的阻容标注值');
        }
      }
    } catch (e) { B('bom.parse', 'BOM.xlsx 解析失败: ' + e.message); }
  }

  // ---------- 7. PnP.csv ----------
  let pnp = null;
  if (present.has('PnP.csv')) {
    try {
      const t = parseTable(present.get('PnP.csv').buf);
      const cDes = pickCol(t.head, ['Designator', 'RefDes', 'Ref']);
      const cX = pickCol(t.head, ['Mid X', 'Ref X', 'CenterX', 'PosX', 'X']);
      const cY = pickCol(t.head, ['Mid Y', 'Ref Y', 'CenterY', 'PosY', 'Y']);
      const cLayer = pickCol(t.head, ['Layer', 'Side']);
      if (!cDes || !cX || !cY) {
        B('pnp.header', `PnP 表头缺列（Designator/Mid X/Mid Y），实际表头: ${t.head.join(' | ')}`);
      } else {
        const numUnit = (s) => {
          const v = String(s == null ? '' : s).trim().replace(/"/g, '');
          const m = /^(-?[\d.]+)\s*(mm|mil|in)?$/i.exec(v);
          if (!m) return { v: NaN, unit: null };
          return { v: parseFloat(m[1]), unit: (m[2] || '').toLowerCase() || null };
        };
        const rows = t.rows.map((r) => {
          const x = numUnit(r[cX]);
          const y = numUnit(r[cY]);
          return { des: String(r[cDes] || '').trim(), x: x.v, y: y.v, xUnit: x.unit, yUnit: y.unit, layer: cLayer ? String(r[cLayer] || '').trim() : '', raw: r };
        }).filter((r) => r.des);
        // 单位判定：显式后缀最权威；否则默认 mm（导出头写死 Dimensions in millimeters）。
        // 只有当 mm 完全落不进板框、而 mil 能落进、且数值全是整数（mil 导出习惯）时才改判 mil。
        const units = [...new Set(rows.flatMap((r) => [r.xUnit, r.yUnit]).filter(Boolean))];
        let unit = units.length === 1 ? units[0] : null;
        let unitSrc = units.length === 1 ? 'suffix' : null;
        if (!unit) {
          const allInt = rows.every((r) => Number.isInteger(r.x) && Number.isInteger(r.y));
          const fitsAt = (mult) => board && rows.every((r) => {
            const x = r.x * mult;
            const y = r.y * mult;
            return x >= board.minX - 0.5 && x <= board.maxX + 0.5 && y >= board.minY - 0.5 && y <= board.maxY + 0.5;
          });
          if (fitsAt(1)) { unit = 'mm'; unitSrc = 'fit-mm'; }
          else if (allInt && fitsAt(0.0254)) { unit = 'mil'; unitSrc = 'fit-mil'; }
          else { unit = 'mm'; unitSrc = 'default'; }
        }
        const mult = unit === 'mil' ? 0.0254 : unit === 'in' ? 25.4 : 1;
        const pts = rows.map((r) => ({ des: r.des, x: r.x * mult, y: r.y * mult, layer: r.layer }));
        pnp = { rows: pts, sep: t.sep, enc: t.enc, head: t.head, unit, unitSrc };
        facts.pnp = { rows: pts.length, unit, unitSrc, sep: t.sep === '\t' ? 'tab' : 'comma', encoding: t.enc, designators: pts.map((p) => p.des) };
        if (t.sep === '\t') W('pnp.sep', 'PnP.csv 是 TAB 分隔（贴片机按逗号解析会只读到 1 列）');
        if (t.enc === 'utf16le' || t.enc === 'utf16be') W('pnp.encoding', `PnP.csv 是 ${t.enc} 编码（ERP/贴片机普遍只吃 UTF-8）`);
        if (unitSrc !== 'suffix') N('pnp.unit', `PnP 坐标没写单位，按板框拟合判定为 ${unit}（${unitSrc}）`);
        const nan = pts.filter((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y));
        if (nan.length) B('pnp.nan', `${nan.length} 行坐标不是数字: ${nan.slice(0, 3).map((p) => p.des).join(',')}`);
        if (board) {
          const out = pts.filter((p) => Number.isFinite(p.x) && (p.x < board.minX - 0.5 || p.x > board.maxX + 0.5 || p.y < board.minY - 0.5 || p.y > board.maxY + 0.5));
          if (out.length) B('pnp.outside', `${out.length} 个器件中心在板框外（贴不上/板子装不下）`, { parts: out.slice(0, 5).map((p) => ({ des: p.des, at: [r3(p.x), r3(p.y)] })), board: facts.board });
          else P('pnp.inside', `${pts.length} 个器件中心全部落在板框内`);
        }
        const seen = new Map();
        const overlap = [];
        for (const p of pts) {
          const k = p.x.toFixed(3) + ',' + p.y.toFixed(3);
          if (seen.has(k) && seen.get(k) !== p.des) overlap.push([seen.get(k), p.des]);
          else seen.set(k, p.des);
        }
        if (overlap.length) B('pnp.overlap', `${overlap.length} 对器件坐标完全重合（必然贴不了）`, { pairs: overlap.slice(0, 5) });
      }
    } catch (e) { B('pnp.parse', 'PnP.csv 解析失败: ' + e.message); }
  }

  // ---------- 8. BOM 位号集合 ⇄ PnP 位号集合（互等） ----------
  const nlDes = (() => {
    try {
      const j = JSON.parse(present.get('Netlist.json') && present.get('Netlist.json').buf.toString('utf8'));
      const comps = j.components || {};
      const list = Object.values(comps).map((c) => String((c.props || {}).Designator || '').trim()).filter(Boolean);
      facts.netlist = { components: Object.keys(comps).length, designators: list.length };
      return new Set(list);
    } catch (e) { B('netlist.parse', 'Netlist.json 解析失败: ' + e.message); return null; }
  })();
  if (bom && pnp) {
    const pset = new Set(pnp.rows.map((r) => r.des));
    const missingInPnp = [...bom.designators].filter((d) => !pset.has(d));
    const missingInBom = [...pset].filter((d) => !bom.designators.has(d));
    facts.bomVsPnp = { bom: bom.designators.size, pnp: pset.size, missingInPnp, missingInBom };
    if (missingInPnp.length) B('bom.pnp.missing', `BOM 有但 PnP 没有 ${missingInPnp.length} 个位号（这些器件不会贴片）: ${missingInPnp.slice(0, 8).join(',')}`);
    if (missingInBom.length) B('pnp.bom.missing', `PnP 有但 BOM 没有 ${missingInBom.length} 个位号（没料可贴/无法备料）: ${missingInBom.slice(0, 8).join(',')}`);
    if (!missingInPnp.length && !missingInBom.length) P('bom.pnp', `BOM 与 PnP 位号集合互等（各 ${pset.size} 个）`);
  }
  if (bom && nlDes) {
    const onlyBom = [...bom.designators].filter((d) => !nlDes.has(d));
    const onlyNl = [...nlDes].filter((d) => !bom.designators.has(d));
    if (onlyBom.length || onlyNl.length) {
      W('bom.netlist', `BOM 与 Netlist 位号不一致（BOM独有 ${onlyBom.length}，Netlist独有 ${onlyNl.length}）`, { onlyBom: onlyBom.slice(0, 8), onlyNl: onlyNl.slice(0, 8) });
    }
  }

  // ---------- 9. 阻焊/丝印"空层"语义判定（依赖 PnP 的层面信息） ----------
  {
    const bottomParts = pnp ? pnp.rows.filter((r) => /^b|bottom|^2$/i.test(String(r.layer || '').trim())) : [];
    const gts = layerCount('GTS');
    const gbs = layerCount('GBS');
    const gto = layerCount('GTO');
    const gbo = layerCount('GBO');
    facts.maskSilk = { GTS: gts, GBS: gbs, GTO: gto, GBO: gbo, bottomParts: bottomParts.length };
    if (gts === 0) B('gerber.mask.top.empty', 'GTS 顶层阻焊 0 图元：所有焊盘都会被盖油，焊不上');
    else P('gerber.mask.top', `GTS 顶层阻焊 ${gts} 图元`);
    if (gto === 0) B('gerber.silk.top.empty', 'GTO 顶层丝印 0 图元：位号/极性无法辨认');
    else P('gerber.silk.top', `GTO 顶层丝印 ${gto} 图元`);
    if (gbs === 0) {
      if (bottomParts.length) B('gerber.mask.bottom.empty', `GBS 底层阻焊 0 图元，但有 ${bottomParts.length} 个底面器件：底面焊盘全被盖油`);
      else N('gerber.mask.bottom.empty', 'GBS 底层阻焊 0 图元（全贴装顶面且无插件孔，属正常）');
    } else P('gerber.mask.bottom', `GBS 底层阻焊 ${gbs} 图元`);
    if (gbo === 0) {
      if (bottomParts.length) B('gerber.silk.bottom.empty', `GBO 底层丝印 0 图元，但有 ${bottomParts.length} 个底面器件：背面位号缺失`);
      else N('gerber.silk.bottom.empty', 'GBO 底层丝印 0 图元（全是顶面器件，属正常）');
    }
  }

  // ---------- 10. Board.pdf ----------
  if (present.has('Board.pdf')) {
    const b = present.get('Board.pdf').buf;
    const lat = b.toString('latin1');
    const pages = (lat.match(/\/Type\s*\/Page[^s]/g) || []).length;
    facts.pdf = { bytes: b.length, pages, eof: /%%EOF/.test(lat.slice(-2048)) };
    if (!pages) B('pdf.pages', 'Board.pdf 没有页面对象（/Type /Page 0 个）');
    else if (!/%%EOF/.test(lat.slice(-2048))) W('pdf.eof', 'Board.pdf 结尾缺 %%EOF（可能被截断）');
    else P('pdf.ok', `Board.pdf ${b.length} 字节 / ${pages} 页`);
  }

  // ---------- 结果 ----------
  const verdict = blockers.length ? 'FAIL' : 'PASS';
  return {
    tool: 'fabcheck',
    version: 1,
    dir: path.resolve(dir),
    run: facts.run || null,
    verdict,
    exit: blockers.length ? 1 : 0,
    summary: {
      blockers: blockers.length,
      warnings: warns.length,
      notes: notes.length,
      passes: passes.length,
      line: blockers.length
        ? `不能下单：${blockers.length} 项阻断 / ${warns.length} 项警告`
        : `可打样：0 阻断 / ${warns.length} 项警告 / ${notes.length} 项说明`,
    },
    blockers,
    warnings: warns,
    notes,
    passes,
    facts,
  };
}

const r3 = (v) => Math.round(v * 1000) / 1000;
/** '1kΩ' / '4.7k' / '0R' → {kind:'R', v:ohms}；'100nF' / '4.7uF' → {kind:'C', v:farads} */
function parsePassiveValue(s) {
  const t = String(s == null ? '' : s).replace(/\s+/g, '');
  let m = /^([\d.]+)\s*([pnuµmkKM]?)(?:Ω|ohm|ohms|R|欧)?$/.exec(t);
  if (m && m[1]) {
    const mult = { p: 1e-12, n: 1e-9, u: 1e-6, µ: 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6 }[m[2]] || 1;
    const v = parseFloat(m[1]) * mult;
    // 带 F 的当电容，否则必须是 R/Ω 结尾或纯数字才算电阻
    if (/F$/i.test(t)) return { kind: 'C', v };
    if (/[ΩR]$/i.test(t) || /^[\d.]+$/.test(t)) return { kind: 'R', v };
    if (/^[\d.]+[pnuµmkKM]$/.test(t)) return { kind: 'R', v }; // '1k' '4.7k'
  }
  return null;
}
/** '0402WGF1001TCE' → 1000Ω；'CL05B104KO5NNNC' → 100nF（EIA 三位码最后一位是指数） */
function parseMpnCode(mpn) {
  const s = String(mpn || '').toUpperCase().trim();
  if (!s) return null;
  const m = /(\d{3})(\d)(?=[A-Z]*$)/.exec(s);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  const exp = parseInt(m[2], 10);
  if (base < 10 || exp > 6) return null;
  const raw = base * 10 ** exp;
  if (/^(CL|CC|GRM|C0|CC0|TMK|JMK|EMK)/.test(s)) return { kind: 'C', v: raw * 1e-12 }; // pF 码
  return { kind: 'R', v: raw }; // 电阻码：Ω
}
function fmtSI(v, kind) {
  const unit = kind === 'C' ? 'F' : 'Ω';
  for (const [p, n] of [[1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']]) {
    if (v >= p) return `${+(v / p).toFixed(4)}${n}${unit}`;
  }
  return `${v}${unit}`;
}
function hexHead(buf, n) {
  return [...buf.subarray(0, n || 12)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/* ============================ 自证：构造坏样本 ============================ */

function selftest(goodDir) {
  const log = [];
  const ok = (c, m) => { log.push({ ok: !!c, msg: m }); if (!c) throw new Error('SELFTEST 断言失败: ' + m); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fabcheck-bad-'));
  const bad = path.join(tmp, 'bad-sample');
  fs.cpSync(goodDir, bad, { recursive: true });
  log.push({ ok: true, msg: `坏样本: ${bad}（从 ${path.basename(goodDir)} 复制并注入故障）` });

  // 故障 1：删掉 TestPoints → 缺文件
  for (const n of ['TestPoints.xlsx', 'TestPoints.csv']) {
    const p = path.join(bad, n);
    if (fs.existsSync(p)) { fs.rmSync(p); log.push({ ok: true, msg: `删掉 ${n}` }); break; }
  }
  // 故障 2：PnP 丢掉最后一行 → BOM/PnP 位号集合不互等
  // 故障 3：PnP 第一行 X 推到 999mm → 器件在板外
  {
    const p = path.join(bad, 'PnP.csv');
    const t = decodeText(fs.readFileSync(p));
    const lines = t.text.split(/\r?\n/).filter((l) => l.trim());
    const sep = lines[0].includes('\t') ? '\t' : ',';
    const head = splitLine(lines[0], sep);
    const xi = head.findIndex((h) => normHead(h) === 'midx');
    const dropped = lines.pop();
    const cells = splitLine(lines[1], sep);
    if (xi >= 0) cells[xi] = '999.0';
    lines[1] = cells.join(sep);
    fs.writeFileSync(p, lines.join('\r\n') + '\r\n', 'utf8');
    log.push({ ok: true, msg: `PnP 删掉一行(${dropped.split(sep)[0]}) + 首行 X=999mm` });
  }
  // 故障 4：Gerber.zip 里 GTS 抽空 + GTL 加一个超框图元 + 钻孔加重复孔
  {
    const zp = path.join(bad, 'Gerber.zip');
    const z = readZip(fs.readFileSync(zp));
    const out = [];
    for (const [name, data] of z) {
      let d = data;
      if (/\.GTS$/i.test(name)) {
        d = Buffer.from(data.toString('utf8').replace(/^.*D0?3\*.*$/gm, ''), 'utf8');
        log.push({ ok: true, msg: `${name} 抽空全部 D03 → 阻焊 0 图元` });
      } else if (/\.GTL$/i.test(name)) {
        d = Buffer.from(data.toString('utf8').replace('M02*', 'G01X9990000Y-9990000D01*\nM02*'), 'utf8');
        log.push({ ok: true, msg: `${name} 插入 999mm 超框图元` });
      } else if (/Via\.DRL$/i.test(name)) {
        const txt = data.toString('utf8');
        const first = (txt.match(/^X-?[\d.]+Y-?[\d.]+/m) || [])[0];
        d = Buffer.from(txt.replace('M30', (first || 'X0Y0') + '\nM30'), 'utf8');
        log.push({ ok: true, msg: `${name} 重复登记一个已有孔` });
      }
      out.push({ name, data: d });
    }
    fs.writeFileSync(zp, writeZipStored(out));
  }

  // 真跑一遍（子进程，验证真实 exit code）
  const r = require('child_process').spawnSync(process.execPath, [__filename, bad, '--raw'], { encoding: 'utf8' });
  let got = null;
  try { got = JSON.parse(r.stdout); } catch (_) {}
  ok(r.status === 1, `坏样本 exit=${r.status}（期望 1）`);
  ok(got && got.verdict === 'FAIL', `坏样本 verdict=${got && got.verdict}（期望 FAIL）`);
  const ids = new Set((got && got.blockers || []).map((b) => b.id));
  for (const want of ['file.missing', 'bom.pnp.missing', 'pnp.outside', 'gerber.mask.top.empty', 'gerber.coord.outside']) {
    ok(ids.has(want), `坏样本命中 ${want}`);
  }
  const wids = new Set((got && got.warnings || []).map((b) => b.id));
  ok(wids.has('drill.duplicate'), '坏样本命中警告 drill.duplicate');

  // 再跑一次好样本，必须 exit 0
  const r2 = require('child_process').spawnSync(process.execPath, [__filename, goodDir, '--raw'], { encoding: 'utf8' });
  ok(r2.status === 0, `好样本 exit=${r2.status}（期望 0）`);

  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  return { tool: 'fabcheck', selftest: 'PASS', good: path.resolve(goodDir), exitGood: r2.status, exitBad: r.status, cases: log };
}

/* ============================ CLI ============================ */

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法: node scripts/fabcheck.js <产物目录> [--raw|--quiet]\n'
      + '      node scripts/fabcheck.js --selftest <产物目录>\n'
      + '退出码: 0=可打样 1=有阻断问题 2=参数/环境错误');
    return 0;
  }
  if (!argv.length) {
    console.error('用法: node scripts/fabcheck.js <产物目录> [--raw|--quiet] | --selftest <产物目录>');
    return 2;
  }
  const raw = argv.includes('--raw');
  const quiet = argv.includes('--quiet');
  if (argv.includes('--selftest')) {
    const i = argv.indexOf('--selftest');
    const goodDir = argv[i + 1];
    if (!goodDir) { console.error('--selftest 需要一个好样本目录'); return 2; }
    try {
      const res = selftest(path.resolve(goodDir));
      console.log(JSON.stringify(res, null, 2));
      return 0;
    } catch (e) {
      console.error(JSON.stringify({ tool: 'fabcheck', selftest: 'FAIL', error: e.message }, null, 2));
      return 1;
    }
  }
  const dir = argv.find((a) => !a.startsWith('--'));
  if (!dir) { console.error('缺少产物目录参数'); return 2; }
  let res;
  try {
    res = check(dir, { raw });
  } catch (e) {
    console.error(JSON.stringify({ tool: 'fabcheck', verdict: 'ERROR', exit: 2, dir: path.resolve(dir), error: e.message }, null, 2));
    return 2;
  }
  if (quiet) {
    console.log(`${res.verdict} ${path.basename(res.dir)} — ${res.summary.line}`);
  } else {
    // --raw 只用于自证时子进程解析；正常情况都是完整 JSON
    console.log(JSON.stringify(res, null, raw ? 0 : 2));
  }
  return res.exit;
}

process.exitCode = main();
