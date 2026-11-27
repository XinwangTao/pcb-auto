#!/usr/bin/env node
/**
 * scripts/measure-sizes.mjs · 从**成品 Gerber** 反量每个器件的铜范围，和 SIZES 表对账
 *
 * 为什么需要它
 * ------------
 * `scripts/relayout.mjs` 的 `SIZES` 是布局器的输入：它决定器件占多大、能放多近、
 * 板框要留多少边。这张表此前**没有任何东西核对过**，而 2026-11-27 的几何审查实测：
 * 0603（C14663）表里写 `w:119`，成品 Gerber 里的铜宽只有 **76**
 * —— 于是 `bypass_cap_distance` 把 155.5 mil 的脚到脚距离读成 76，结论差 2.05 倍。
 *
 * 量的是**成品**，不是设计意图：拿 PnP 的器件位置把 Gerber 铜图元按「最近器件」归堆，
 * 每堆的包围盒就是这个器件实际占的铜。这与 fabcheck 「量成品、不信意图」的口径一致。
 *
 * 用法：
 *   node scripts/measure-sizes.mjs --design designs/x.json --out out/<某次运行>
 *   node scripts/measure-sizes.mjs --design ... --out ... --json
 *
 * 退出码：0 = 量完（哪怕有偏差，偏差是结论）；2 = 量具跑不起来（缺文件/解析不了）
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIL = 39.37007874015748; // 1 mm = 39.3701 mil

/* ── 最小 ZIP 读取（Gerber.zip / 只需要 stored 与 deflate）───────────── */
function readZip(p) {
  const buf = fs.readFileSync(p);
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 ZIP（找不到 EOCD）：' + p);
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    // 本地头：30 字节 + name + extra
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('不支持的压缩方式 ' + method);
    out.set(name, data);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/* ── Gerber 解析：只取 D01 线段与 D03 闪点的毫米坐标 ─────────────────── */
function parseGerber(text) {
  const fmt = /%FSLAX(\d)(\d)Y(\d)(\d)\*%/.exec(text);
  const xi = fmt ? Number(fmt[1]) : 4;
  const xd = fmt ? Number(fmt[2]) : 5;
  const yi = fmt ? Number(fmt[3]) : 4;
  const yd = fmt ? Number(fmt[4]) : 5;
  const unitMm = /%MOMM\*%/.test(text) ? 1 : (/%MOIN\*%/.test(text) ? 25.4 : 1);
  const toMm = (v, dec) => (Number(v) / Math.pow(10, dec)) * unitMm;

  const body = text.replace(/%[^*]*\*%/g, ' ').replace(/G04[^*]*\*/g, ' ');
  // 【只取 D03 闪点 = 焊盘/过孔】实测 2026-11-27 第一版把 D01 线段也算进去，
  // 于是走线与铺铜也被“归给最近的器件”—— 0603 量出 971 mil（表里是 119），差一个量级。
  // 焊盘才属于器件；走线连接焊盘，不能当成器件的尺寸。
  //
  // 【但 D03 只给中心，不给尺寸】实测：只算中心会得到 0603 = 55.1 mil，
  // 而它的实际铜宽是 **中心距 + 2×焊盘半宽** = 55.2 + 2×10.4 ≈ 76。所以必须读光圈（aperture）。
  const aps = new Map();
  for (const m of text.matchAll(/%ADD(\d+)([A-Za-z]+),([0-9.X]+)\*%/g)) {
    aps.set('D' + m[1], { shape: m[2].toUpperCase(), params: m[3].split('X').map(Number) });
  }
  const halfOf = (ap) => {
    if (!ap) return { hw: 0, hh: 0 };
    const p = ap.params;
    if (ap.shape === 'C') { const r = (p[0] || 0) / 2 * unitMm; return { hw: r, hh: r }; }
    if (ap.shape === 'R' || ap.shape === 'O') {
      return { hw: (p[0] || 0) / 2 * unitMm, hh: (p[1] || 0) / 2 * unitMm };
    }
    if (ap.shape === 'P') { const r = (p[0] || 0) / 2 * unitMm; return { hw: r, hh: r }; }
    return { hw: 0, hh: 0 };
  };

  const pts = [];
  let ap = null;
  const TOK = /(?:D(\d+)\*)|(?:X(-?\d+)Y(-?\d+)[^XD]*?D0?([123])\*)/g;
  for (const m of body.matchAll(TOK)) {
    if (m[1] !== undefined) { ap = aps.get('D' + m[1]) || null; continue; }
    if (m[4] !== '3') continue;
    const x = toMm(m[2], xd), y = toMm(m[3], yd);
    const { hw, hh } = halfOf(ap);
    // 用焊盘的**四角**代表它占的铜，而不是用中心点。
    pts.push({ x: x - hw, y: y - hh }, { x: x + hw, y: y - hh }, { x: x - hw, y: y + hh }, { x: x + hw, y: y + hh });
  }
  return pts;
}

/* ── PnP：designator -> {x, y, layer} ────────────────────────────────── */
// 【PnP 有三种形态，不能假设是 UTF-8 + 逗号】实测 2026-11-27：
// 同一个仓库里同时存在 UTF-8/逗号（test/mutants/base）与 **UTF-16LE + TAB + 带单位**（真实产物）。
// 只按 UTF-8 读会得到一串临字节，报错还指向「表头缺字段」—— 与真因无关。
function readText(p) {
  const buf = fs.readFileSync(p);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  let zeros = 0;
  for (let i = 1; i < Math.min(buf.length, 400); i += 2) if (buf[i] === 0) zeros++;
  if (zeros > 50) return buf.toString('utf16le');
  return buf.toString('utf8');
}
const numOf = (v) => {
  // 去单位（mm / mil）与引号，但不碰负号与小数点
  const s = String(v == null ? '' : v).replace(/[^\d.+-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
};
function readPnp(p) {
  const txt = readText(p);
  const lines = txt.split(/\r?\n/).filter((l) => l.trim());
  const delim = (lines[0].split('\t').length > lines[0].split(',').length) ? '\t' : ',';
  const head = lines[0].split(delim).map((s) => s.replace(/^["']|["']$/g, '').trim());
  const idx = (n) => head.findIndex((h) => h.toLowerCase() === n.toLowerCase());
  const iD = idx('Designator'); const iX = idx('Mid X'); const iY = idx('Mid Y'); const iL = idx('Layer');
  if (iD < 0 || iX < 0 || iY < 0) throw new Error('PnP 表头缺 Designator/Mid X/Mid Y：' + head.join(','));
  const out = new Map();
  for (const l of lines.slice(1)) {
    const c = l.split(delim);
    const des = String(c[iD] || '').replace(/^["']|["']$/g, '').trim();
    if (!des) continue;
    out.set(des, {
      x: numOf(c[iX]), y: numOf(c[iY]),
      layer: iL >= 0 ? String(c[iL] || '').trim() : '',
    });
  }
  return out;
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */
const argv = process.argv.slice(2);
const opt = { design: null, out: null, json: false };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--design') opt.design = argv[++i];
  else if (a === '--out') opt.out = argv[++i];
  else if (a === '--json') opt.json = true;
}
function bail(msg) { console.error('  MEASURE-SIZES=ENVSKIP  ' + msg); process.exit(2); }

if (!opt.design || !opt.out) bail('用法：node scripts/measure-sizes.mjs --design <json> --out <产物目录>');
const designPath = path.isAbsolute(opt.design) ? opt.design : path.join(ROOT, opt.design);
const outDir = path.isAbsolute(opt.out) ? opt.out : path.join(ROOT, opt.out);

let design;
try { design = JSON.parse(fs.readFileSync(designPath, 'utf8')); }
catch (e) { bail('读不了设计 ' + opt.design + '：' + e.message); }

const gz = path.join(outDir, 'Gerber.zip');
const pnpF = path.join(outDir, 'PnP.csv');
for (const p of [gz, pnpF]) if (!fs.existsSync(p)) bail('缺文件：' + p);

let zip, pnp;
try { zip = readZip(gz); } catch (e) { bail('解不开 Gerber.zip：' + e.message); }
try { pnp = readPnp(pnpF); } catch (e) { bail('读不了 PnP：' + e.message); }

// 铜层：GTL / GBL（内层 G1..Gn 也收，本设计是双层）
const copperEntries = [...zip.keys()].filter((n) => /\.(GTL|GBL)$/.test(n) || /\.G\d+$/.test(n));
if (!copperEntries.length) bail('Gerber.zip 里没有铜层');

// 所有铜点，标上所属层（顶层/底层）
const points = [];
for (const name of copperEntries) {
  const layerTop = /\.GTL$/.test(name) || /\.G1$/.test(name);
  let pts;
  try { pts = parseGerber(zip.get(name).toString('utf8')); } catch (e) { bail('解析 ' + name + ' 失败：' + e.message); }
  for (const p of pts) points.push({ x: p.x, y: p.y, top: layerTop });
}
if (!points.length) bail('铜层里一个图元都没解析出来（格式变了？）');

// 器件位置：只认 PnP 里有的
const des = (design.components || []).map((c) => ({ des: c.des, lcsc: c.lcsc }));
const missing = des.filter((c) => !pnp.has(c.des)).map((c) => c.des);
if (missing.length === des.length) bail('PnP 里一个器件都对不上：' + missing.join(','));

const pos = [];
for (const c of des) {
  const p = pnp.get(c.des);
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) pos.push({ ...c, x: p.x, y: p.y, top: p.layer !== 'B' });
}
if (!pos.length) bail('没有可用的器件坐标');

// 把每个铜点归给最近的器件（同层优先），得到每个器件的铜包围盒
// 【必须有半径】否则板子边缘的剩余焊盘会被归给远处那个最近的器件，把它撑大。
// 10 mm 足以包住本仓库用到的所有封装（最大的是 ESP32-S3 模组 748 mil ≈ 19 mm 的对角，
// 但 PnP 的 Mid 在封装中心，半径取 12 mm 就够）。
const MAX_R_MM = 12;
const boxes = new Map();
for (const pt of points) {
  let best = null; let bestD = Infinity;
  for (const c of pos) {
    if (c.top !== pt.top) continue;              // 不同层直接不归
    const d = Math.hypot(pt.x - c.x, pt.y - c.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best || bestD > MAX_R_MM) continue;
  const b = boxes.get(best.des) || { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, n: 0 };
  b.x0 = Math.min(b.x0, pt.x); b.x1 = Math.max(b.x1, pt.x);
  b.y0 = Math.min(b.y0, pt.y); b.y1 = Math.max(b.y1, pt.y);
  b.n++;
  boxes.set(best.des, b);
}

// 按 LCSC 汇总（同一料号可能有多个器件位号，取各自的 bbox 尺寸再取中位数）
const byLcsc = new Map();
for (const c of pos) {
  const b = boxes.get(c.des);
  if (!b || b.n < 2) continue;
  const w = (b.x1 - b.x0) * MIL;
  const h = (b.y1 - b.y0) * MIL;
  const arr = byLcsc.get(c.lcsc) || [];
  arr.push({ des: c.des, w, h, n: b.n });
  byLcsc.set(c.lcsc, arr);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const result = [];
for (const [lcsc, arr] of byLcsc) {
  result.push({
    lcsc,
    des: arr.map((x) => x.des),
    wMil: Math.round(median(arr.map((x) => x.w)) * 10) / 10,
    hMil: Math.round(median(arr.map((x) => x.h)) * 10) / 10,
    samples: arr.length,
    spreadWMil: Math.round((Math.max(...arr.map((x) => x.w)) - Math.min(...arr.map((x) => x.w))) * 10) / 10,
    spreadHMil: Math.round((Math.max(...arr.map((x) => x.h)) - Math.min(...arr.map((x) => x.h))) * 10) / 10,
  });
}
result.sort((a, b) => a.lcsc.localeCompare(b.lcsc));

if (opt.json) {
  console.log(JSON.stringify({
    tool: 'measure-sizes',
    design: path.relative(ROOT, designPath).replace(/\\/g, '/'),
    outDir: path.relative(ROOT, outDir).replace(/\\/g, '/'),
    copperLayers: copperEntries,
    copperPoints: points.length,
    componentsInPnp: pos.length,
    measured: result,
  }, null, 2));
  process.exit(0);
}

console.log('');
console.log('  ── 从成品 Gerber 反量的铜范围 ──');
console.log(`  设计 ${path.relative(ROOT, designPath)}  产物 ${path.relative(ROOT, outDir)}`);
console.log(`  铜层 ${copperEntries.join(', ')}；铜点 ${points.length} 个；对上的器件 ${pos.length} 个`);
console.log('');
console.log('  ' + 'LCSC'.padEnd(12) + 'w(mil)'.padStart(8) + 'h(mil)'.padStart(8) + '  样本  位号');
for (const r of result) {
  console.log('  ' + r.lcsc.padEnd(12) + String(r.wMil).padStart(8) + String(r.hMil).padStart(8)
    + '  ' + String(r.samples).padStart(4) + '  ' + r.des.join(','));
}
console.log('');
console.log(`  MEASURE-SIZES=OK  量到 ${result.length} 种料号`);
process.exit(0);
