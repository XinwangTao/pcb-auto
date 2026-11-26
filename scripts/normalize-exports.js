#!/usr/bin/env node
/**
 * normalize-exports.js — 导出产物「打样前」格式归一化（离线脚本，不碰 LCEDA、不碰设备）
 *
 * 修复四类会被打样厂拒单/做错板的问题：
 *   1) PnP.csv 单位混杂（mil / mm 混用、坐标带 mm 后缀）→ 统一 mm、保留 4 位小数、表头写 unit:mm
 *   2) PnP.csv 编码/分隔符不一致（TAB/分号、UTF-16/GBK/UTF-8 BOM）→ UTF-8 无 BOM + 逗号 + CRLF
 *   3) PnP.csv 缺列/列名漂移 → 保证 Designator,Val,Package,Mid X,Mid Y,Layer,Rotation 七列在前且顺序稳定，
 *      多余列原样保留在后面；表头缺失的七列补空列；未识别列只警告、不丢内容
 *   4) DRL 钻孔文件重复孔（同一坐标 + 同一孔径出现多次，含 G85 槽孔）→ 去重，保留 M48…% 文件头与 METRIC/INCH 声明
 *
 * 用法：
 *   node scripts/normalize-exports.js --check    <dir>   只检查，有问题 exit 1，干净 exit 0
 *   node scripts/normalize-exports.js --fix      <dir>   规范化（默认模式）
 *   node scripts/normalize-exports.js --selftest <dir>   规范化 + 自断言四类问题已消失（exit 0/1）
 *   node scripts/normalize-exports.js <dir>              同 --fix
 *
 * 退出码：0 = 通过/干净；1 = 断言失败或检查发现问题；2 = 用法错误或目录不存在。
 *
 * 设计约束：
 *   - 幂等：二次运行对已规范化的文件不写入任何字节（输出与首次运行结果完全一致）。
 *   - 缺某类文件 = 跳过，不算失败。
 *   - 未识别内容一律保留，只在 stderr 警告。
 *   - DRL 既处理独立 *.drl 文件，也处理 Gerber.zip 内的 *.DRL 条目（真实产物里钻孔都在 zip 里）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

/* ============================================================================
 * 常量
 * ==========================================================================*/

const CANON = [
  { key: 'Designator', alias: ['designator', 'refdes', 'ref des', 'ref', 'reference', 'part', 'part number', '位号', '元件位号', '器件位号', 'reference designator'] },
  { key: 'Val', alias: ['val', 'value', 'comment', '值', '规格', '标称值', 'value/comment'] },
  { key: 'Package', alias: ['package', 'footprint', '封装', 'pcb 封装', 'pcb封装'] },
  { key: 'Mid X', alias: ['mid x', 'midx', 'x', 'center x', 'centre x', 'midpoint x', '中点 x', '中间 x', 'x 坐标', 'x坐标'] },
  { key: 'Mid Y', alias: ['mid y', 'midy', 'y', 'center y', 'centre y', 'midpoint y', '中点 y', '中间 y', 'y 坐标', 'y坐标'] },
  { key: 'Layer', alias: ['layer', 'side', 'tb', '层', '面', '装配面', 'layer t/b'] },
  { key: 'Rotation', alias: ['rotation', 'rot', 'angle', 'rotate', '旋转', '角度'] },
];

/** 额外列里"其实也是坐标"的列名：同样要统一成 mm/4 位小数（但保持位置不变） */
const COORD_COL_RE = /^(mid|ref|pad|center|centre|pos|position|mount)?\s*[xy]$/;

/** 已知的多余列（不乱警告） */
const KNOWN_EXTRA = new Set([
  'device', 'type', 'supplier', 'datasheet', 'pins', 'pin count', 'smd', 'description',
  'quantity', 'qty', 'mpn', 'manufacturer', 'lcpl', 'lcsc', '备注', '说明', 'ref x', 'ref y',
  'pad x', 'pad y', 'value', 'comment', 'footprint', 'package', 'units', 'unit',
]);

const UNIT_FACTOR = { mm: 1, mil: 0.0254, in: 25.4, um: 0.001, cm: 10 };
const CANON_NUM_RE = /^-?\d+\.\d{4}$/;

const EOL = '\r\n';

/* ============================================================================
 * 小工具
 * ==========================================================================*/

function crc32(buf) {
  if (!crc32.tbl) {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    crc32.tbl = t;
  }
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crc32.tbl[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const warn = (msg) => process.stderr.write('[warn] ' + msg + '\n');

/** 数值 → 4 位小数（-0 归一为 0） */
function fmt4(n) {
  let s = n.toFixed(4);
  if (s === '-0.0000') s = '0.0000';
  return s;
}

const n5 = (n) => n.toFixed(5);

/* ============================================================================
 * 文本解码（UTF-8 / UTF-8 BOM / UTF-16LE / UTF-16BE / GBK）
 * ==========================================================================*/

function decodeBuffer(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le', bom: 'utf16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const body = Buffer.from(buf.subarray(2));
    for (let i = 0; i + 1 < body.length; i += 2) { const t = body[i]; body[i] = body[i + 1]; body[i + 1] = t; }
    return { text: body.toString('utf16le'), encoding: 'utf16be', bom: 'utf16be' };
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), encoding: 'utf8', bom: 'utf8' };
  }
  // 无 BOM 的 UTF-16LE：奇数位大量 0x00
  const probe = Math.min(buf.length, 4096);
  let oddZero = 0;
  let evenZero = 0;
  for (let i = 0; i < probe; i++) if (buf[i] === 0) { if (i & 1) oddZero++; else evenZero++; }
  if (probe >= 32 && oddZero > probe * 0.15 && evenZero < probe * 0.02) {
    return { text: buf.toString('utf16le'), encoding: 'utf16le-nobom', bom: null };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf8', bom: null };
  } catch (_) { /* 继续往下试 */ }
  try {
    return { text: new TextDecoder('gbk', { fatal: true }).decode(buf), encoding: 'gbk', bom: null };
  } catch (_) { /* 继续 */ }
  return { text: buf.toString('latin1'), encoding: 'binary', bom: null };
}

/* ============================================================================
 * CSV
 * ==========================================================================*/

function detectSep(text) {
  const line = text.split(/\r\n|\n|\r/, 1)[0] || '';
  const cands = [',', '\t', ';', '|'];
  const counts = { ',': 0, '\t': 0, ';': 0, '|': 0 };
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && counts[c] !== undefined) counts[c]++;
  }
  let best = ',';
  let bestN = 0;
  for (const k of cands) if (counts[k] > bestN) { bestN = counts[k]; best = k; }
  return best;
}

function parseCsv(text, sep) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQ = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === sep) { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(cell); cell = ''; rows.push(row); row = []; i++; continue;
    }
    if (c === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; i++; continue; }
    cell += c; i++;
  }
  row.push(cell);
  rows.push(row);
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0].trim() === '') rows.pop();
  return rows;
}

function csvCell(s) {
  s = String(s == null ? '' : s);
  if (/[",;\t\r\n]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function serializeCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join(EOL) + EOL;
}

/* ============================================================================
 * PnP 解析 / 归一化
 * ==========================================================================*/

function normHeaderCell(s) {
  return String(s == null ? '' : s)
    .replace(/\uFEFF/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s*[（(]\s*(mm|mil|inch|in|um)\s*[)）]\s*$/g, '')
    .replace(/\s*[（(].*?[)）]\s*$/g, '')
    .replace(/[_\s]+/g, ' ')
    .trim();
}

/** "29.928mm" / "-3.531" / "656.25mil" → { value, unit } */
function parseCoord(s) {
  const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(mm|mil|inches|inch|in|um|µm|μm|cm)?\s*$/i.exec(String(s == null ? '' : s));
  if (!m) return null;
  let u = m[2] ? m[2].toLowerCase().replace(/[µμ]/, 'u') : null;
  if (u === 'inches' || u === 'inch') u = 'in';
  return { value: Number(m[1]), unit: u };
}

function isCoordHeader(norm) {
  return COORD_COL_RE.test(norm) || norm === 'mid x' || norm === 'mid y';
}

/** 单位声明列（我们自己写的 unit:mm，或原始表里的 unit/units 列）——不算"多余列"，避免重复追加 */
const UNIT_DECL_RE = /^unit\s*[:=]?\s*(mm|mil|inch|in)?$/;

/** 解析出的表格 → { rows, header, norm, take, consumed, extras } */
function mapHeader(rows) {
  const header = (rows[0] || []).map((s) => s.replace(/\uFEFF/g, '').trim());
  const norm = header.map(normHeaderCell);
  const take = Object.create(null);
  const consumed = new Set();
  // 按别名优先级（而不是列顺序）匹配：Value 优先于 Comment，Footprint 优先于其它
  for (const c of CANON) {
    for (const alias of c.alias) {
      const ix = norm.findIndex((h, i) => !consumed.has(i) && h === alias);
      if (ix >= 0) { take[c.key] = ix; consumed.add(ix); break; }
    }
  }
  // 单位声明列：既不算七列，也不算"多余列"（输出时统一写成 unit:mm）
  for (let i = 0; i < norm.length; i++) if (!consumed.has(i) && UNIT_DECL_RE.test(norm[i])) consumed.add(i);
  const extras = [];
  for (let i = 0; i < header.length; i++) if (!consumed.has(i)) extras.push(i);
  return { header, norm, take, consumed, extras };
}

/**
 * 分析一个坐标列：解析每个单元格、推断缺省单位、发现"混用"。
 *
 * 单位判定规则（离线、无外部信息，仅凭本列数值自洽）：
 *   1. 单元格自带单位后缀（29.928mm / 656.25mil / 1.2in）→ 直接换算成 mm；
 *   2. 裸数值：若本列存在显式单位，取"换算后更接近本列已定 mm 中位数"的那种解释
 *      （1000mil 与裸值 25.4 同列时，25.4 按 mm 解释才自洽；25.4 按 mil 只有 0.65mm，明显偏离）；
 *   3. 若整列都没有单位：按量级判（PCB 坐标 mm 一般 < 300；全列中位数 > 300 视为 mil）；
 *   4. 仍判不出 → 按 mm，并记一条警告。
 * `mixed` 表示本列同时出现了两种单位（需要换算 + 统一）。
 */
function analyzeCoordColumn(rows, idx) {
  const cells = new Map();
  const units = new Set();
  const bare = [];
  const warnings = [];
  let unparsed = 0;
  for (let r = 1; r < rows.length; r++) {
    const raw = rows[r][idx] == null ? '' : String(rows[r][idx]).trim();
    if (raw === '') continue;
    const p = parseCoord(raw);
    if (!p) { unparsed++; cells.set(r, { raw, mm: null, unit: null, bad: true }); continue; }
    if (p.unit) units.add(p.unit);
    else bare.push(r);
    cells.set(r, { raw, val: p.value, unit: p.unit, mm: null });
  }

  const medianOf = (arr) => {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // 1) 显式单位 → mm
  for (const [, c] of cells) if (!c.bad && c.unit) c.mm = c.val * (UNIT_FACTOR[c.unit] || 1);
  const knownAbs = [...cells.values()].filter((c) => c.mm != null && c.mm !== 0).map((c) => Math.abs(c.mm));
  const knownMedian = medianOf(knownAbs);

  // 2) 裸数值：在 mm / mil 两种解释里挑更接近已知量级的
  const bareAbs = bare.map((r) => Math.abs(cells.get(r).val)).filter((v) => v > 0);
  const bareMedian = medianOf(bareAbs);
  const scaleGuess = knownMedian;                 // 有显式单位时以它为参照量级
  const bareAsMil = knownMedian === 0 && bareMedian > 300; // 整列无单位：中位数 > 300 视为 mil
  for (const r of bare) {
    const c = cells.get(r);
    const asMm = Math.abs(c.val);
    const asMil = Math.abs(c.val) * UNIT_FACTOR.mil;
    let pickMm;
    if (knownMedian > 0) {
      const dMm = asMm > 0 ? Math.abs(Math.log(asMm / scaleGuess)) : Infinity;
      const dMil = asMil > 0 ? Math.abs(Math.log(asMil / scaleGuess)) : Infinity;
      pickMm = dMm <= dMil;
    } else {
      pickMm = !bareAsMil;
    }
    c.unit = pickMm ? 'mm' : 'mil';
    c.mm = pickMm ? c.val : c.val * UNIT_FACTOR.mil;
    c.reclassified = !pickMm;
  }

  if (units.size > 1) warnings.push(`坐标列 ${idx} 混用单位 ${[...units].join('+')}（已统一换算为 mm）`);
  const used = new Set([...cells.values()].filter((c) => c.unit).map((c) => c.unit));
  const mixed = used.size > 1;
  if (mixed) {
    const seen = [...used].join('+');
    if (!warnings.length) warnings.push(`坐标列 ${idx} 混用单位（${seen}，已统一换算为 mm）`);
  }
  if (unparsed) warnings.push(`坐标列 ${idx} 有 ${unparsed} 个单元格无法解析（已原样保留）`);
  const medianAbs = knownMedian || bareMedian;
  return { cells, units, mixed, unparsed, medianAbs, usedUnits: used, warnings };
}

function analyzePnp(buf) {
  const dec = decodeBuffer(buf);
  const sep = detectSep(dec.text);
  const rows = parseCsv(dec.text, sep);
  const issues = [];
  const counts = { rows: Math.max(0, rows.length - 1), coordCells: 0, nonCanonCells: 0, crossUnitCells: 0, mixedFiles: 0, unparsedCells: 0 };

  if (dec.encoding === 'utf16le' || dec.encoding === 'utf16be' || dec.encoding === 'utf16le-nobom') issues.push({ code: 'pnp.encoding.utf16', msg: `编码是 ${dec.encoding}（贴片机/ERP 只吃 UTF-8）` });
  else if (dec.encoding === 'gbk') issues.push({ code: 'pnp.encoding.gbk', msg: '编码不是 UTF-8（疑似 GBK/GB18030）' });
  else if (dec.encoding === 'binary') issues.push({ code: 'pnp.encoding.binary', msg: '编码无法识别' });
  if (dec.bom === 'utf8') issues.push({ code: 'pnp.encoding.bom', msg: '带 UTF-8 BOM（多数字段解析器会把 BOM 读进第一个列名）' });

  if (sep !== ',') issues.push({ code: 'pnp.sep.' + (sep === '\t' ? 'tab' : sep === ';' ? 'semicolon' : 'other'), msg: `分隔符是 ${JSON.stringify(sep)}（应为逗号）` });

  if (/\n/.test(dec.text.replace(/\r\n/g, '')) || /\r(?!\n)/.test(dec.text.replace(/\r\n/g, ''))) {
    issues.push({ code: 'pnp.eol', msg: '换行不是 CRLF' });
  }

  if (!rows.length) { issues.push({ code: 'pnp.empty', msg: '文件为空' }); return { dec, sep, rows, issues, counts, header: [], coordIdx: [] }; }

  const { header, norm, take, consumed, extras } = mapHeader(rows);
  const missing = CANON.map((c) => c.key).filter((k) => take[k] === undefined);
  if (missing.length) issues.push({ code: 'pnp.header.missing', msg: `缺列: ${missing.join(', ')}` });
  const orderOk = CANON.every((c, i) => take[c.key] === i);
  if (!orderOk && !missing.length) {
    const where = CANON.map((c) => `${header[take[c.key]]}@${take[c.key]}`).join(' | ');
    issues.push({ code: 'pnp.header.order', msg: `七列顺序漂移: 实际 ${where}` });
  }
  if (!header.some((h) => /^unit\s*[:=]\s*mm$/i.test(h.trim()))) issues.push({ code: 'pnp.header.unit', msg: '表头未声明 unit:mm' });

  // 坐标列（含多余列里的 Ref/Pad X/Y）
  const coordIdx = [];
  for (let i = 0; i < header.length; i++) if (isCoordHeader(norm[i])) coordIdx.push(i);
  const cols = new Map();
  const unitNotes = [];
  for (const i of coordIdx) {
    const a = analyzeCoordColumn(rows, i);
    cols.set(i, a);
    if (a.mixed) counts.mixedFiles = 1;
    if (a.unparsed) counts.unparsedCells += a.unparsed;
    for (const w of a.warnings) unitNotes.push(w);
    for (const [r, c] of a.cells) {
      if (c.bad) continue;
      counts.coordCells++;
      if (c.unit && c.unit !== 'mm') counts.crossUnitCells++;
      if (!CANON_NUM_RE.test(c.raw)) counts.nonCanonCells++;
    }
  }
  if (counts.mixedFiles) {
    const sample = [...new Set(unitNotes.filter((w) => /混用单位/.test(w)))].slice(0, 3).join('；');
    issues.push({ code: 'pnp.unit.mixed', msg: '同一文件里 mil 与 mm 混用' + (sample ? `（${sample}）` : '') });
  }
  if (counts.crossUnitCells) issues.push({ code: 'pnp.unit', msg: `${counts.crossUnitCells} 个坐标单元格不是 mm` });
  if (counts.nonCanonCells) issues.push({ code: 'pnp.unit.format', msg: `${counts.nonCanonCells} 个坐标单元格不是「mm + 4 位小数」规范形式` });
  if (counts.unparsedCells) issues.push({ code: 'pnp.cell.unparsed', msg: `${counts.unparsedCells} 个坐标单元格无法解析（已原样保留）` });

  const hlen = header.length;
  let ragged = 0;
  for (let r = 1; r < rows.length; r++) if (rows[r].length !== hlen) ragged++;
  if (ragged) issues.push({ code: 'pnp.rows.ragged', msg: `${ragged} 行列数与表头不一致` });

  return { dec, sep, rows, issues, counts, header, norm, take, consumed, extras, cols, coordIdx, missing, orderOk };
}

/**
 * 归一化一个 PnP.csv 的字节。
 * 返回 { out: Buffer, changed, warnings:[], addedCols:[], droppedCols:[] }
 */
function normalizePnp(buf) {
  const a = analyzePnp(buf);
  const warnings = [];
  if (!a.rows.length) return { out: buf, changed: false, warnings: ['空文件，已跳过'] };

  const { header, take, extras, rows } = a;
  const missing = a.missing;

  // 坐标列格式化的公共函数
  const fmtCoordCell = (colIdx, rowIdx) => {
    const raw = rows[rowIdx][colIdx] == null ? '' : String(rows[rowIdx][colIdx]).trim();
    if (raw === '') return '';
    const col = a.cols.get(colIdx);
    const c = col && col.cells.get(rowIdx);
    if (!c || c.bad) { warnings.push(`无法解析的坐标 "${raw}"（${header[colIdx]} 第 ${rowIdx} 行），已原样保留`); return raw; }
    return fmt4(c.mm);
  };

  const outHeader = CANON.map((c) => c.key).concat(['unit:mm'], extras.map((i) => header[i]));
  const outRows = [outHeader];

  for (let r = 1; r < rows.length; r++) {
    const src = rows[r];
    const canon = CANON.map((c) => {
      const ix = take[c.key];
      if (ix === undefined) {
        // 兜底：Val 取 Value/Comment/Device，Package 取 Footprint
        if (c.key === 'Val') {
          for (const k of ['Value', 'Comment', 'Device']) {
            const j = header.findIndex((h) => normHeaderCell(h) === k.toLowerCase());
            if (j >= 0 && src[j] && String(src[j]).trim()) return String(src[j]).trim();
          }
          return '';
        }
        if (c.key === 'Package') {
          const j = header.findIndex((h) => /^(footprint|封装)$/.test(normHeaderCell(h)));
          if (j >= 0 && src[j]) return String(src[j]).trim();
          return '';
        }
        return '';
      }
      return a.coordIdx.includes(ix) ? fmtCoordCell(ix, r) : String(src[ix] == null ? '' : src[ix]).trim();
    });
    const extraVals = extras.map((i) => (a.coordIdx.includes(i) ? fmtCoordCell(i, r) : String(src[i] == null ? '' : src[i]).trim()));
    outRows.push(canon.concat([''], extraVals));
  }

  // 未识别列：提醒但保留
  for (const [, col] of a.cols) for (const w of col.warnings) if (!warnings.includes(w)) warnings.push(w);
  for (let i = 0; i < header.length; i++) {
    if (!a.consumed.has(i) || a.extras.includes(i)) continue;
    if (UNIT_DECL_RE.test(a.norm[i])) warnings.push(`原单位列 "${header[i]}" 已并入表头 unit:mm（数值已换算成 mm）`);
  }
  for (const i of extras) {
    const n = a.norm[i];
    if (!KNOWN_EXTRA.has(n) && !isCoordHeader(n) && !UNIT_DECL_RE.test(n)) warnings.push(`未识别列 "${header[i]}"（已原样保留在末尾）`);
  }
  for (const k of missing) warnings.push(`表头缺列 ${k}（已补空列并把可推断的值填入）`);

  const text = serializeCsv(outRows);
  const out = Buffer.from(text, 'utf8');
  const changed = !out.equals(buf);
  return { out, changed, warnings, addedCols: missing, extras: extras.map((i) => header[i]) };
}

/* ============================================================================
 * DRL 解析 / 归一化
 * ==========================================================================*/

function splitKeepEol(text) {
  const lines = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] !== '\n' && text[j] !== '\r') j++;
    const content = text.slice(i, j);
    let eol = '';
    if (text[j] === '\r' && text[j + 1] === '\n') { eol = '\r\n'; j += 2; }
    else if (j < text.length) { eol = text[j]; j += 1; }
    lines.push({ content, eol });
    i = j;
  }
  return lines;
}

const joinLines = (lines) => lines.map((l) => l.content + l.eol).join('');

function findHeadEnd(lines) {
  for (let i = 0; i < lines.length; i++) if (lines[i].content.trim() === '%') return i;
  return -1;
}

function parseTools(lines) {
  const tools = Object.create(null);
  for (const l of lines) {
    const m = /^T(\d+)\s*C\s*([\d.]+)/i.exec(l.content.trim());
    if (m) tools['T' + m[1]] = m[2];
  }
  return tools;
}

function detectUnitDecl(text) {
  const m = /^\s*(METRIC|INCH)\b/im.exec(text);
  return m ? m[1].toUpperCase() : null;
}

function detectPlating(name, text) {
  const n = String(name || '').toUpperCase();
  if (/NPTH|NON[_ ]?PLATED|NON[_ ]?PLATE/.test(n)) return 'npth';
  if (/VIA/.test(n)) return 'via';
  if (/PTH|PLATED/.test(n)) return 'pth';
  const h = text.slice(0, 500).toUpperCase();
  if (/TYPE\s*=\s*NON[_ ]?PLATED/.test(h)) return 'npth';
  return 'other';
}

const PLATING_PRIORITY = { pth: 0, via: 1, other: 2, npth: 3 };

/**
 * 对一个"钻孔组"（同一产物目录下的全部 .drl，含 Gerber.zip 里的条目）去重。
 * - 同一坐标 + 同一孔径 = 同一个孔，只保留一次（跨文件也算：PTH 优先，Via 里重复的被丢）
 * - G85 槽孔按「起点+终点」四元组去重，不能当单点处理
 * - 文件头（M48…%、METRIC/INCH 声明、工具定义）一个字节都不动
 */
function processDrlGroup(sources) {
  const parsed = sources.map((s, i) => {
    const lines = splitKeepEol(s.text);
    const headEnd = findHeadEnd(lines);
    const headerText = lines.slice(0, headEnd + 1).map((l) => l.content + l.eol).join('');
    return Object.assign({}, s, {
      i,
      lines,
      headEnd,
      headerText,
      headerHash: sha1(Buffer.from(headerText, 'latin1')),
      tools: parseTools(lines),
      plating: s.plating || detectPlating(s.name, s.text),
      unitDecl: detectUnitDecl(s.text),
    });
  });

  const order = parsed.slice().sort((a, b) => (PLATING_PRIORITY[a.plating] ?? 2) - (PLATING_PRIORITY[b.plating] ?? 2) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seenPlated = new Map();
  const seenNpth = new Map();

  for (const src of order) {
    const seen = src.plating === 'npth' ? seenNpth : seenPlated;
    const kept = [];
    const st = { hits: 0, slots: 0, dupHits: 0, dupSlots: 0, dups: 0 };
    let curTool = null;
    for (let li = 0; li < src.lines.length; li++) {
      const raw = src.lines[li];
      const t = raw.content.trim();
      let key = null;
      let slot = false;
      if (li > src.headEnd) {
        let m;
        if ((m = /^T(\d+)\s*C\s*([\d.]+)/i.exec(t))) {
          curTool = 'T' + m[1];
        } else if ((m = /^T(\d+)\s*$/.exec(t))) {
          curTool = 'T' + m[1];
        } else if (/G85/i.test(t)) {
          slot = true;
          const nums = [...t.matchAll(/[XY]([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g)].map((x) => Number(x[1]));
          const ap = curTool && src.tools[curTool] != null ? src.tools[curTool] : '?';
          key = 'S|' + ap + '|' + nums.map(n5).join(',');
        } else if ((m = /^X([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*Y([+-]?(?:\d+(?:\.\d*)?|\.\d+))/.exec(t))) {
          const ap = curTool && src.tools[curTool] != null ? src.tools[curTool] : '?';
          key = 'H|' + ap + '|' + n5(Number(m[1])) + '|' + n5(Number(m[2]));
        }
      }
      if (key) {
        if (seen.has(key)) {
          st.dups++;
          if (slot) st.dupSlots++; else st.dupHits++;
          continue; // 丢掉重复行
        }
        seen.set(key, src.name);
        if (slot) st.slots++; else st.hits++;
      }
      kept.push(raw);
    }
    src.stats = st;
    src.outText = joinLines(kept);
    src.changed = src.outText !== src.text;
  }

  return {
    sources: parsed,
    totals: parsed.reduce((a, s) => ({
      hits: a.hits + s.stats.hits,
      slots: a.slots + s.stats.slots,
      dupHits: a.dupHits + s.stats.dupHits,
      dupSlots: a.dupSlots + s.stats.dupSlots,
      dups: a.dups + s.stats.dups,
      hitsBefore: a.hitsBefore + s.stats.hits + s.stats.dupHits,
      slotsBefore: a.slotsBefore + s.stats.slots + s.stats.dupSlots,
    }), { hits: 0, slots: 0, dupHits: 0, dupSlots: 0, dups: 0, hitsBefore: 0, slotsBefore: 0 }),
  };
}

/* ============================================================================
 * ZIP 读写（只重写被改动的条目，其余条目原始压缩字节原样搬运）
 * ==========================================================================*/

function findEocd(buf) {
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

function readZip(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('找不到 EOCD，不是有效 zip');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const commentLen = buf.readUInt16LE(eocd + 20);
  if (cdOff + cdSize > buf.length) throw new Error('中央目录越界');
  const entries = [];
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏（第 ' + k + ' 项）');
    const ch = Buffer.from(buf.subarray(p, p + 46));
    const nameLen = ch.readUInt16LE(28);
    const extraLen = ch.readUInt16LE(30);
    const cLen = ch.readUInt16LE(32);
    const nameBuf = Buffer.from(buf.subarray(p + 46, p + 46 + nameLen));
    const cExtra = Buffer.from(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
    const cComment = Buffer.from(buf.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + cLen));
    const lo = ch.readUInt32LE(42);
    if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地头损坏: ' + nameBuf.toString('utf8'));
    const lh = Buffer.from(buf.subarray(lo, lo + 30));
    const lNameLen = lh.readUInt16LE(26);
    const lExtraLen = lh.readUInt16LE(28);
    const dataStart = lo + 30 + lNameLen + lExtraLen;
    const method = ch.readUInt16LE(10);
    const csize = ch.readUInt32LE(20);
    const usize = ch.readUInt32LE(24);
    const raw = buf.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error('不支持的压缩方法 ' + method + ': ' + nameBuf.toString('utf8'));
    entries.push({
      nameBuf,
      fileName: nameBuf.toString('utf8'),
      localHeader: lh,
      localName: Buffer.from(buf.subarray(lo + 30, lo + 30 + lNameLen)),
      localExtra: Buffer.from(buf.subarray(lo + 30 + lNameLen, dataStart)),
      centralHeader: ch,
      centralExtra: cExtra,
      centralComment: cComment,
      method,
      crc: ch.readUInt32LE(16),
      flags: ch.readUInt16LE(8),
      usize,
      data,
      raw: Buffer.from(raw),
      changed: false,
    });
    p += 46 + nameLen + extraLen + cLen;
  }
  return { entries, comment: Buffer.from(buf.subarray(eocd + 22, eocd + 22 + commentLen)) };
}

function writeZip(model) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const e of model.entries) {
    let comp;
    if (e.changed) {
      comp = e.method === 0 ? e.data : zlib.deflateRawSync(e.data, { level: 9 });
    } else {
      comp = e.raw; // 未改动的条目：原始压缩字节原样搬运（保证与原文一致）
    }
    const crc = e.changed ? crc32(e.data) : e.crc;
    const csize = comp.length;
    const usize = e.changed ? e.data.length : e.usize;
    const flags = e.flags & ~0x0008;

    const lh = Buffer.from(e.localHeader);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(csize >>> 0, 18);
    lh.writeUInt32LE(usize >>> 0, 22);

    chunks.push(lh, e.localName, e.localExtra, comp);

    const ch = Buffer.from(e.centralHeader);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(csize >>> 0, 20);
    ch.writeUInt32LE(usize >>> 0, 24);
    ch.writeUInt32LE(offset >>> 0, 42);
    centrals.push(Buffer.concat([ch, e.nameBuf, e.centralExtra, e.centralComment]));

    offset += lh.length + e.localName.length + e.localExtra.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(model.entries.length, 8);
  eocd.writeUInt16LE(model.entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(model.comment.length, 20);
  return Buffer.concat([...chunks, cd, eocd, model.comment]);
}

/* ============================================================================
 * 目录扫描 / 分组
 * ==========================================================================*/

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

function collectFiles(dir) {
  const all = [];
  walk(dir, all);
  const res = { pnp: [], drl: [], zip: [] };
  for (const p of all) {
    const base = path.basename(p);
    if (/^pnp.*\.csv$/i.test(base)) res.pnp.push(p);
    else if (/\.drl$/i.test(base)) res.drl.push(p);
    else if (/\.zip$/i.test(base)) res.zip.push(p);
  }
  return res;
}

/** 按目录把钻孔来源（独立 .drl + zip 内 DRL 条目）分组，并缓存 zip 模型 */
function buildDrlGroups(dir, files) {
  const groups = new Map();
  const ensure = (d) => {
    if (!groups.has(d)) groups.set(d, { dir: d, sources: [], zips: [] });
    return groups.get(d);
  };

  for (const p of files.drl) {
    const text = fs.readFileSync(p).toString('latin1');
    ensure(path.dirname(p)).sources.push({
      origin: 'file',
      path: p,
      name: path.basename(p),
      text,
      plating: detectPlating(path.basename(p), text),
    });
  }

  for (const zp of files.zip) {
    let model;
    try {
      model = readZip(fs.readFileSync(zp));
    } catch (e) {
      warn(`zip 读取失败，跳过 ${zp}: ${e.message}`);
      continue;
    }
    const drlEntries = model.entries.filter((e) => /\.drl$/i.test(e.fileName));
    if (!drlEntries.length) continue;
    const g = ensure(path.dirname(zp));
    const zrec = { path: zp, model, entries: drlEntries, buf: null };
    g.zips.push(zrec);
    for (const e of drlEntries) {
      const text = e.data.toString('latin1');
      g.sources.push({
        origin: 'zip',
        zip: zrec,
        entry: e,
        path: zp,
        name: `${path.basename(zp)}:${e.fileName}`,
        text,
        plating: detectPlating(e.fileName, text),
      });
    }
  }
  return [...groups.values()];
}

/* ============================================================================
 * 扫描 / 修复
 * ==========================================================================*/

function scanDir(dir) {
  const files = collectFiles(dir);
  const rep = {
    dir,
    pnp: [],
    drlGroups: [],
    counts: {
      pnpFiles: 0, pnpBadEncoding: 0, pnpTab: 0, pnpSemi: 0, pnpOtherSep: 0, pnpBom: 0, pnpUtf16: 0,
      pnpGbk: 0, pnpEol: 0, pnpHeaderBad: 0, pnpMissingCol: 0, pnpNonCanon: 0, pnpCrossUnit: 0,
      pnpMixedFiles: 0, pnpCoordCells: 0, pnpUnparsed: 0, pnpRagged: 0,
      drlSources: 0, drlZips: 0, drlHits: 0, drlSlots: 0, drlDupHits: 0, drlDupSlots: 0,
      drlDupTotal: 0, drlUnitDecl: 0, drlNoUnitDecl: 0, drlHeaderOk: 0,
    },
    issues: [],
  };

  /* ---- PnP ---- */
  for (const p of files.pnp) {
    const buf = fs.readFileSync(p);
    const a = analyzePnp(buf);
    const rec = { path: p, issues: a.issues, counts: a.counts, sep: a.sep, encoding: a.dec.encoding, header: a.header };
    rep.pnp.push(rec);
    const c = rep.counts;
    c.pnpFiles++;
    if (a.dec.bom === 'utf8') c.pnpBom++;
    if (a.dec.encoding.startsWith('utf16')) c.pnpUtf16++;
    if (a.dec.encoding === 'gbk') c.pnpGbk++;
    if (a.sep === '\t') c.pnpTab++;
    else if (a.sep === ';') c.pnpSemi++;
    else if (a.sep !== ',') c.pnpOtherSep++;
    if (a.issues.some((x) => x.code === 'pnp.eol')) c.pnpEol++;
    if (a.missing.length || !a.orderOk) { c.pnpHeaderBad++; c.pnpMissingCol += a.missing.length; }
    c.pnpNonCanon += a.counts.nonCanonCells;
    c.pnpCrossUnit += a.counts.crossUnitCells;
    c.pnpMixedFiles += a.counts.mixedFiles;
    c.pnpCoordCells += a.counts.coordCells;
    c.pnpUnparsed += a.counts.unparsedCells;
    if (a.issues.some((x) => x.code === 'pnp.rows.ragged')) c.pnpRagged++;
    for (const it of a.issues) rep.issues.push({ scope: p, ...it });
  }

  /* ---- DRL ---- */
  const groups = buildDrlGroups(dir, files);
  for (const g of groups) {
    const r = processDrlGroup(g.sources);
    rep.drlGroups.push({ dir: g.dir, zips: g.zips, sources: r.sources, totals: r.totals });
    const c = rep.counts;
    c.drlSources += r.sources.length;
    c.drlZips += g.zips.length;
    c.drlHits += r.totals.hits;
    c.drlSlots += r.totals.slots;
    c.drlDupHits += r.totals.dupHits;
    c.drlDupSlots += r.totals.dupSlots;
    c.drlDupTotal += r.totals.dups;
    for (const s of r.sources) {
      if (s.unitDecl) c.drlUnitDecl++;
      else c.drlNoUnitDecl++;
      if (s.headEnd >= 0) c.drlHeaderOk++;
      if (s.stats.dupSlots > 0) rep.issues.push({ scope: s.name, code: 'drl.dup.slot', msg: `${s.stats.dupSlots} 个 G85 槽孔重复` });
      if (s.stats.dupHits > 0) rep.issues.push({ scope: s.name, code: 'drl.dup.hit', msg: `${s.stats.dupHits} 个孔重复（同坐标+同孔径）` });
    }
  }
  // 文件头哈希（用于断言"文件头一个字节都没动"）
  const hp = [];
  for (const g of rep.drlGroups) for (const s of g.sources) hp.push(`${s.name}#${s.headerHash}`);
  rep.drlHeaderHash = hp.sort().join('|');
  return rep;
}

function fixDir(dir) {
  const files = collectFiles(dir);
  const res = { written: [], bytes: 0, pnpFixed: 0, drlFixed: 0, zipFixed: 0, warnings: [], errors: [] };

  /* ---- PnP ---- */
  for (const p of files.pnp) {
    const before = fs.readFileSync(p);
    const n = normalizePnp(before);
    for (const w of n.warnings) warn(`${p}: ${w}`);
    if (n.changed) {
      fs.writeFileSync(p, n.out);
      res.written.push(p);
      res.bytes += n.out.length;
      res.pnpFixed++;
    }
  }

  /* ---- DRL ---- */
  const groups = buildDrlGroups(dir, files);
  for (const g of groups) {
    const r = processDrlGroup(g.sources);
    for (const s of r.sources) {
      if (!s.changed) continue;
      if (s.origin === 'file') {
        fs.writeFileSync(s.path, Buffer.from(s.outText, 'latin1'));
        res.written.push(s.path);
        res.bytes += Buffer.byteLength(s.outText, 'latin1');
        res.drlFixed++;
      } else {
        s.entry.data = Buffer.from(s.outText, 'latin1');
        s.entry.changed = true;
      }
    }
    for (const z of g.zips) {
      const touched = z.entries.filter((e) => e.changed);
      if (!touched.length) continue;
      try {
        const out = writeZip(z.model);
        // 写前自校验：重读必须与原结构一致、每个条目解压内容符合预期
        const chk = readZip(out);
        if (chk.entries.length !== z.model.entries.length) throw new Error('zip 重写校验失败（条目数）');
        for (let i = 0; i < chk.entries.length; i++) {
          const a = chk.entries[i];
          const b = z.model.entries[i];
          if (!a.data.equals(b.data)) throw new Error('zip 重写校验失败（内容）: ' + b.fileName);
          if (a.fileName !== b.fileName) throw new Error('zip 重写校验失败（条目名）');
        }
        fs.writeFileSync(z.path, out);
        res.written.push(z.path);
        res.bytes += out.length;
        res.zipFixed++;
      } catch (e) {
        // 宁可不动 zip，也不能写坏交付件
        res.errors.push(`${z.path}: ${e.message}（已放弃重写，zip 保持原样）`);
        warn(`${z.path}: ${e.message}（已放弃重写）`);
      }
    }
  }
  return res;
}

/* ============================================================================
 * 输出
 * ==========================================================================*/

function printScan(rep) {
  const c = rep.counts;
  console.log(`目录: ${rep.dir}`);
  console.log(`PnP.csv: ${c.pnpFiles} 个文件`);
  if (!c.pnpFiles) console.log('  (跳过：未找到 PnP.csv)');
  else {
    console.log(`  编码: UTF-8 BOM ${c.pnpBom} / UTF-16 ${c.pnpUtf16} / GBK ${c.pnpGbk}`);
    console.log(`  分隔: TAB ${c.pnpTab} / 分号 ${c.pnpSemi} / 其他 ${c.pnpOtherSep}`);
    console.log(`  表头: 缺列或顺序漂移 ${c.pnpHeaderBad} 个文件（缺列合计 ${c.pnpMissingCol}）`);
    console.log(`  坐标: 单元格 ${c.pnpCoordCells}，非 mm ${c.pnpCrossUnit}，非「mm+4位」规范 ${c.pnpNonCanon}，混用文件 ${c.pnpMixedFiles}`);
  }
  console.log(`DRL: 来源 ${c.drlSources} 个（含 Gerber.zip ${c.drlZips} 个），孔 ${c.drlHits} 个 / 槽孔 ${c.drlSlots} 个，单位声明 ${c.drlUnitDecl} 个，文件头完整 ${c.drlHeaderOk} 个`);
  console.log(`     重复孔: 普通 ${c.drlDupHits} + G85 槽孔 ${c.drlDupSlots} = ${c.drlDupTotal}`);
  if (rep.issues.length) {
    console.log(`问题 ${rep.issues.length} 项:`);
    for (const i of rep.issues) console.log(`  [${i.code}] ${i.scope}: ${i.msg}`);
  } else {
    console.log('问题 0 项');
  }
}

function printFix(res) {
  if (res.errors && res.errors.length) {
    console.log(`重写错误 ${res.errors.length} 项（相关文件保持原样）：`);
    for (const e of res.errors) console.log('  ' + e);
  }
  if (!res.written.length) {
    console.log('已规范化：无需改写任何文件（0 字节写入）');
    return;
  }
  console.log(`已改写 ${res.written.length} 个文件（${res.bytes} 字节）：PnP ${res.pnpFixed}，DRL 文件 ${res.drlFixed}，Gerber.zip ${res.zipFixed}`);
  for (const p of res.written) console.log('  ' + p);
}

function fileHashes(dir) {
  const files = collectFiles(dir);
  const map = new Map();
  for (const p of files.pnp.concat(files.drl)) map.set(p, sha1(fs.readFileSync(p)));
  for (const z of files.zip) map.set(z, sha1(fs.readFileSync(z)));
  return map;
}

function selftest(dir) {
  console.log('=== [selftest] 规范化前 ===');
  const before = scanDir(dir);
  printScan(before);

  console.log('\n=== [selftest] 规范化 ===');
  const fix1 = fixDir(dir);
  printFix(fix1);

  console.log('\n=== [selftest] 规范化后（重新解析） ===');
  const after = scanDir(dir);
  printScan(after);

  const hashes1 = fileHashes(dir);
  const fix2 = fixDir(dir);
  const hashes2 = fileHashes(dir);
  let hashSame = hashes1.size === hashes2.size;
  for (const [k, v] of hashes1) if (hashes2.get(k) !== v) hashSame = false;

  const bc = before.counts;
  const ac = after.counts;
  const asserts = [];
  const A = (name, cond, detail) => asserts.push({ name, cond, detail });

  const pnpSkipped = bc.pnpFiles === 0;
  A('1) PnP 单位统一为 mm/4 位小数',
    ac.pnpNonCanon === 0 && ac.pnpCrossUnit === 0 && ac.pnpMixedFiles === 0,
    `${bc.pnpNonCanon} → ${ac.pnpNonCanon} 个非规范单元格（跨单位 ${bc.pnpCrossUnit} → ${ac.pnpCrossUnit}，混用文件 ${bc.pnpMixedFiles} → ${ac.pnpMixedFiles}）${pnpSkipped ? ' [跳过：无 PnP]' : ''}`);
  A('2) PnP 编码/分隔符统一（UTF-8 无 BOM + 逗号 + CRLF）',
    ac.pnpBom === 0 && ac.pnpUtf16 === 0 && ac.pnpGbk === 0 && ac.pnpTab === 0 && ac.pnpSemi === 0 && ac.pnpOtherSep === 0 && ac.pnpEol === 0,
    `BOM ${bc.pnpBom}→${ac.pnpBom}，UTF-16 ${bc.pnpUtf16}→${ac.pnpUtf16}，GBK ${bc.pnpGbk}→${ac.pnpGbk}，TAB ${bc.pnpTab}→${ac.pnpTab}，分号 ${bc.pnpSemi}→${ac.pnpSemi}，非CRLF ${bc.pnpEol}→${ac.pnpEol}`);
  A('3) PnP 七列齐备且顺序稳定 + unit:mm',
    ac.pnpHeaderBad === 0 && ac.pnpRagged === 0,
    `缺列/顺序漂移文件 ${bc.pnpHeaderBad}→${ac.pnpHeaderBad}（缺列合计 ${bc.pnpMissingCol}→${ac.pnpMissingCol}），行列数不一致 ${bc.pnpRagged}→${ac.pnpRagged}`);
  A('4) DRL 重复孔清零（含 G85 槽孔）',
    ac.drlDupTotal === 0,
    `重复孔 ${bc.drlDupHits + bc.drlDupSlots} → ${ac.drlDupTotal}（普通 ${bc.drlDupHits}→${ac.drlDupHits}，槽孔 ${bc.drlDupSlots}→${ac.drlDupSlots}）${bc.drlSources === 0 ? ' [跳过：无 DRL]' : ''}`);
  A('5) DRL 文件头与单位声明逐字节未被改动',
    ac.drlUnitDecl === bc.drlUnitDecl && ac.drlHeaderOk === bc.drlHeaderOk && ac.drlHeaderHash === bc.drlHeaderHash,
    `METRIC/INCH 声明 ${bc.drlUnitDecl}→${ac.drlUnitDecl}，M48…% 文件头 ${bc.drlHeaderOk}→${ac.drlHeaderOk}，文件头哈希一致=${ac.drlHeaderHash === bc.drlHeaderHash}`);
  A('6) 幂等：二次运行 0 字节写入、文件哈希不变',
    fix2.written.length === 0 && hashSame && fix2.bytes === 0,
    `二次写入 ${fix2.written.length} 个文件/${fix2.bytes} 字节，哈希一致=${hashSame}`);
  A('7) 无重写错误（zip 损坏等一律不改写）',
    fix1.errors.length === 0 && fix2.errors.length === 0,
    `${fix1.errors.length + fix2.errors.length} 个错误${fix1.errors.concat(fix2.errors).map((e) => ' / ' + e).join('')}`);

  console.log('\n=== [selftest] 断言 ===');
  let ok = true;
  for (const a of asserts) {
    console.log(`[${a.cond ? 'PASS' : 'FAIL'}] ${a.name} — ${a.detail}`);
    if (!a.cond) ok = false;
  }
  if (ac.pnpFiles === 0 && ac.drlSources === 0) console.log('[note] 该目录既没有 PnP.csv 也没有 DRL，全部跳过（不算失败）');
  console.log(ok ? '\nRESULT: PASS' : '\nRESULT: FAIL');
  return ok ? 0 : 1;
}

/* ============================================================================
 * main
 * ==========================================================================*/

function usage() {
  console.log(`用法:
  node scripts/normalize-exports.js --check    <产物目录>   只检查，有问题 exit 1，干净 exit 0
  node scripts/normalize-exports.js --fix      <产物目录>   规范化（默认）
  node scripts/normalize-exports.js --selftest <产物目录>   规范化 + 自断言四类问题已消失
  node scripts/normalize-exports.js <产物目录>              同 --fix

退出码: 0 通过 / 1 断言失败或检查到问题 / 2 用法错误或目录不存在`);
}

function main(argv) {
  const args = argv.slice(2);
  let mode = null;
  const positional = [];
  for (const a of args) {
    if (a === '--check') mode = mode && mode !== 'check' ? mode : 'check';
    else if (a === '--fix') mode = mode && mode !== 'fix' ? mode : 'fix';
    else if (a === '--selftest') mode = mode && mode !== 'selftest' ? mode : 'selftest';
    else if (a === '-h' || a === '--help') { usage(); return 0; }
    else if (a.startsWith('-')) { console.error('未知参数: ' + a); usage(); return 2; }
    else positional.push(a);
  }
  if (!positional.length) { usage(); return 2; }
  const dir = path.resolve(positional[0]);
  let st;
  try { st = fs.statSync(dir); } catch (_) { console.error('目录不存在: ' + dir); return 2; }
  if (!st.isDirectory()) { console.error('不是目录: ' + dir); return 2; }

  if (mode === 'check') {
    const rep = scanDir(dir);
    printScan(rep);
    console.log(rep.issues.length ? '\nRESULT: DIRTY（--check 发现问题，退出 1）' : '\nRESULT: CLEAN（退出 0）');
    return rep.issues.length ? 1 : 0;
  }
  if (mode === 'selftest') return selftest(dir);

  const rep = scanDir(dir);
  printScan(rep);
  const res = fixDir(dir);
  console.log('');
  printFix(res);
  return res.errors.length ? 1 : 0;
}

module.exports = {
  CANON, decodeBuffer, analyzePnp, normalizePnp, processDrlGroup, readZip, writeZip, scanDir, fixDir, main,
  splitKeepEol, collectFiles,
};

if (require.main === module) {
  process.exitCode = main(process.argv);
}
