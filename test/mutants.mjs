#!/usr/bin/env node
/**
 * test/mutants.mjs — fabcheck 判据的突变覆盖运行器
 *
 * 回答一个别处回答不了的问题：scripts/fabcheck.js 定义的判据里，哪些**从来没有被证明过能亮**？
 *
 * 做法：拿一块干净的基准板（exit 0），复制到系统 temp，注入一个**具体故障**，
 * 用子进程跑 scripts/fabcheck.js（只信它的直接输出，不经过 core/ops.mjs），
 * 断言退出码 + blockers/warnings/notes 里的 id 多重集（结构化取，绝不用正则数 "id"）。
 *
 * 用法：
 *   node test/mutants.mjs                     # 跑 test/mutants/fabcheck.catalog.json
 *   node test/mutants.mjs --catalog <path>    # 跑别的 catalog（base 仍相对仓库根解析）
 *   node test/mutants.mjs --selftest          # 证明断言不是永远为真（坏期望必须退 1）
 *
 * 退出码：0 = 全部命中；1 = 有未命中（这是结论，不是环境错误）；
 *         2 = 没能测量（base 不存在或位于 out/ 之下/不干净、catalog 为空/非法、
 *             fabcheck 自身崩了、突变施加失败）。
 *
 * 样板必须随仓库版本化（当前是 test/mutants/base）。任何 base 指向 out/ 之下都退 2：
 * 见 assertBaseVersioned() 里的理由。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FABCHECK = path.join(ROOT, 'scripts', 'fabcheck.js');
const DEFAULT_CATALOG = path.join(ROOT, 'test', 'mutants', 'fabcheck.catalog.json');

const ARGS = process.argv.slice(2);
const SELFTEST = ARGS.includes('--selftest');
const CAT_ARG_I = ARGS.indexOf('--catalog');
const CATALOG = CAT_ARG_I >= 0 ? path.resolve(ARGS[CAT_ARG_I + 1] || '') : DEFAULT_CATALOG;

const AS_OF = new Date().toISOString();

class MeasureError extends Error {}

const TMPDIRS = [];
function mktmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMPDIRS.push(d);
  return d;
}
function cleanupTmp() {
  for (const d of TMPDIRS.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 尽力而为 */ }
  }
}

/* ------------------------------------------------------------------ *
 * 判据总数：从 fabcheck.js 的 B()/W()/N()/P() 注册点去重取，不硬编码。
 * 注意：gerber.extra 是裸 notes.push，不是 B/W/N/P 判据；它与基线“62”的口径一致。
 * ------------------------------------------------------------------ */
function totalCriteria() {
  const src = fs.readFileSync(FABCHECK, 'utf8');
  const ids = new Set();
  for (const m of src.matchAll(/\b[BWNP]\('([a-z0-9.]+)'/g)) ids.add(m[1]);
  if (!ids.size) throw new MeasureError('从 scripts/fabcheck.js 里一个判据 id 都读不到');
  return ids;
}
function sha12(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12).toUpperCase();
}

/* ------------------------------------------------------------------ *
 * ZIP（只读中央目录 + 只写 STORED）：只用 Node 内置 zlib，不 npm install。
 * 只服务 xlsx / Gerber.zip 的“解包—改文本—重打包”。
 * ------------------------------------------------------------------ */
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

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new MeasureError('不是合法 ZIP（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  if (count === 0xffff) throw new MeasureError('ZIP64 不支持');
  let off = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new MeasureError('ZIP 中央目录损坏');
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
    if (lho + 30 > buf.length) throw new MeasureError('ZIP 本地头越界: ' + name);
    const dstart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (dstart + csize > buf.length) throw new MeasureError('ZIP 数据越界: ' + name);
    const raw = buf.subarray(dstart, dstart + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new MeasureError(`ZIP 压缩方式 ${method} 不支持: ${name}`);
    if (crc32(data) !== crc) throw new MeasureError('ZIP CRC 校验失败: ' + name);
    entries.set(name, data);
  }
  return entries;
}

function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const body = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const crc = crc32(body);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(dosTime, 12); cd.writeUInt16LE(dosDate, 14);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(body.length, 20); cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    centrals.push(cd, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.size, 8); eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, eocd]);
}

function mutateZip(file, fn) {
  const entries = readZip(fs.readFileSync(file));
  const out = fn(entries);
  fs.writeFileSync(file, writeZip(out || entries));
}

/* ------------------------------------------------------------------ *
 * 文本编码：PnP.csv 实测是 UTF-16LE；Gerber / xlsx XML 是 UTF-8。
 * replace 必须保持原编码，否则会先把“编码错误”注入进去，测到的就不是目标判据。
 * ------------------------------------------------------------------ */
function decodeText(buf) {
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { enc: 'utf16le', text: buf.subarray(2).toString('utf16le') };
  }
  if (buf.length > 2 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { enc: 'utf8-bom', text: buf.subarray(3).toString('utf8') };
  }
  if (buf.length > 1 && buf[0] === 0xfe && buf[1] === 0xff) {
    const b = Buffer.from(buf.subarray(2));
    b.swap16();
    return { enc: 'utf16be', text: b.toString('utf16le') };
  }
  return { enc: 'utf8', text: buf.toString('utf8') };
}
function encodeText(text, enc) {
  if (enc === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (enc === 'utf16be') {
    const b = Buffer.from(text, 'utf16le');
    b.swap16();
    return Buffer.concat([Buffer.from([0xfe, 0xff]), b]);
  }
  if (enc === 'utf8-bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

/* ------------------------------------------------------------------ *
 * 突变施加
 * ------------------------------------------------------------------ */
function safePath(dir, rel) {
  const p = path.resolve(dir, rel);
  const root = path.resolve(dir) + path.sep;
  if (p !== path.resolve(dir) && !p.startsWith(root)) throw new MeasureError('突变路径越界: ' + rel);
  return p;
}

function replaceTextIn(text, op) {
  if (op.regex) {
    let flags = op.flags || '';
    if (op.all && !flags.includes('g')) flags += 'g';
    let re;
    try { re = new RegExp(op.find, flags); } catch (e) { throw new MeasureError('replace 正则非法: ' + e.message); }
    const out = text.replace(re, op.with == null ? '' : op.with);
    if (out === text) throw new MeasureError(`replace 正则未命中: ${op.find}`);
    return out;
  }
  if (!text.includes(op.find)) throw new MeasureError(`replace 未命中（find 不存在）: ${JSON.stringify(op.find)}`);
  const out = text.replace(op.find, op.with == null ? '' : op.with);
  if (out === text) throw new MeasureError(`replace 无变化: ${JSON.stringify(op.find)}`);
  return out;
}

function applyOp(dir, op) {
  const kind = op && op.op;
  if (kind === 'rm') {
    const p = safePath(dir, op.file);
    if (!fs.existsSync(p)) throw new MeasureError('rm 目标不存在: ' + op.file);
    fs.rmSync(p);
    return;
  }
  if (kind === 'truncate') {
    const p = safePath(dir, op.file);
    const buf = fs.readFileSync(p);
    const n = Number(op.bytes);
    if (!Number.isInteger(n) || n < 0) throw new MeasureError('truncate.bytes 必须是非负整数');
    if (buf.length <= n) throw new MeasureError(`truncate 无变化：${op.file} 只有 ${buf.length} 字节，目标 ${n}`);
    fs.writeFileSync(p, buf.subarray(0, n));
    return;
  }
  if (kind === 'move') {
    const from = safePath(dir, op.from);
    const to = safePath(dir, op.to);
    if (!fs.existsSync(from)) throw new MeasureError('move 源不存在: ' + op.from);
    if (fs.existsSync(to)) throw new MeasureError('move 目标已存在: ' + op.to);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return;
  }
  if (kind === 'replace') {
    if (!op.find) throw new MeasureError('replace.find 缺失');
    if (op.entry) {
      mutateZip(safePath(dir, op.file), (entries) => {
        if (!entries.has(op.entry)) throw new MeasureError(`ZIP 条目不存在: ${op.file}!${op.entry}`);
        const dec = decodeText(entries.get(op.entry));
        entries.set(op.entry, encodeText(replaceTextIn(dec.text, op), dec.enc));
      });
    } else {
      const p = safePath(dir, op.file);
      const dec = decodeText(fs.readFileSync(p));
      fs.writeFileSync(p, encodeText(replaceTextIn(dec.text, op), dec.enc));
    }
    return;
  }
  if (kind === 'setEntry') {
    mutateZip(safePath(dir, op.file), (entries) => {
      if (!entries.has(op.entry)) throw new MeasureError(`ZIP 条目不存在: ${op.file}!${op.entry}`);
      entries.set(op.entry, Buffer.from(String(op.text == null ? '' : op.text), 'utf8'));
    });
    return;
  }
  if (kind === 'dropLines') {
    if (!op.match) throw new MeasureError('dropLines.match 缺失');
    mutateZip(safePath(dir, op.file), (entries) => {
      if (!entries.has(op.entry)) throw new MeasureError(`ZIP 条目不存在: ${op.file}!${op.entry}`);
      const dec = decodeText(entries.get(op.entry));
      const eol = dec.text.includes('\r\n') ? '\r\n' : '\n';
      const lines = dec.text.split(/\r?\n/);
      const kept = lines.filter((l) => !l.includes(op.match));
      if (kept.length === lines.length) throw new MeasureError(`dropLines 未命中: ${op.match}`);
      entries.set(op.entry, encodeText(kept.join(eol), dec.enc));
    });
    return;
  }
  if (kind === 'write') {
    // 【用来构造「输入缺失/存在」型突变】比如天线净空需要
    // `_design.snapshot.json` 才能核，而 base 里原本没有这个文件 —— 没有
    // 这个 op 就永远无法证明那条判据会不会亮。
    const p = safePath(dir, op.file);
    const content = String(op.text == null ? '' : op.text);
    if (fs.existsSync(p)) {
      let same = false;
      try { same = fs.readFileSync(p, 'utf8') === content; } catch (_) { same = false; }
      if (same) throw new MeasureError(`write 无变化：${op.file} 内容已经相同`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
    return;
  }
  throw new MeasureError('未知突变 op: ' + kind);
}

function applyMutate(dir, mutate) {
  for (const op of mutate) applyOp(dir, op);
}

/* ------------------------------------------------------------------ *
 * fabcheck 调用 / 输出解析
 * ------------------------------------------------------------------ */
function runFabcheck(dir) {
  const r = spawnSync(process.execPath, [FABCHECK, dir, '--raw'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.error) return { bad: true, detail: 'spawn 失败: ' + r.error.message };
  const stdout = r.stdout || '';
  const stderr = (r.stderr || '').trim();
  const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{'));
  let json = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { json = JSON.parse(lines[i]); break; } catch (_) { /* 继续往前找最后一个能解析的 */ }
  }
  if (!json) {
    return { bad: true, detail: `stdout 里没有可解析 JSON（exit=${r.status}）stderr=${stderr.slice(0, 300)}` };
  }
  if (r.status !== 0 && r.status !== 1) {
    return { bad: true, detail: `fabcheck exit=${r.status}（0/1 之外）stderr=${stderr.slice(0, 300)}` };
  }
  return { bad: false, status: r.status, json, stderr };
}

// 结构化取 id 多重集：@($j.blockers) 的 JS 版。绝不用正则数 "id"。
function collectIds(json) {
  const arr = (v) => (Array.isArray(v) ? v : []);
  const blockers = arr(json && json.blockers);
  const warnings = arr(json && json.warnings);
  const notes = arr(json && json.notes);
  const all = new Set();
  for (const list of [blockers, warnings, notes]) {
    for (const e of list) if (e && typeof e.id === 'string') all.add(e.id);
  }
  return { blockers, warnings, notes, all };
}
const idsOf = (list) => list.map((e) => (e && e.id) || '?').join(',');

/* ------------------------------------------------------------------ *
 * catalog
 * ------------------------------------------------------------------ */

/**
 * 样板必须是版本化路径。
 *
 * 踩过的坑：之前的 base 是 `out/AI_RP2040_系统-…`——那批产物不在 git 里。
 * `scripts/cleanup.ps1`（由 run-overnight.ps1 每 3 轮调用）把它裁到最新 40 个目录，
 * 全新 git clone 里 out/ 一个目录都没有。于是这个运行器在作者机器上能给出 12/12，
 * 换台机器/过几天就只会退 2（"base 不存在"）——一个"迟早变成跑不了"的量具。
 *
 * 所以：base 落在 out/ 之下 = 没能测量，退 2，而不是等它哪天悄悄变成跑不了。
 */
function assertBaseVersioned(base, where) {
  const norm = (p) => path.resolve(p).toLowerCase();
  const outRoot = norm(path.join(ROOT, 'out')) + path.sep;
  const n = norm(path.resolve(ROOT, base));
  if (n === outRoot.slice(0, -1) || n.startsWith(outRoot)) {
    throw new MeasureError(
      `${where} 的 base 指向 out/ 之下: ${base}\n`
      + '  out/ 不是版本化的：scripts/cleanup.ps1 每 3 轮把它裁到最新 40 个目录，全新 git clone 里一个都没有。\n'
      + '  样板必须随仓库版本化（例如 test/mutants/base），否则跑到别的机器上只会变成"跑不了"。'
    );
  }
}

function loadCatalog(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { throw new MeasureError('catalog 读不到: ' + file); }
  let j;
  try { j = JSON.parse(raw); } catch (e) { throw new MeasureError('catalog 不是合法 JSON: ' + e.message); }
  const mutants = Array.isArray(j) ? j : j.mutants;
  if (!Array.isArray(mutants) || mutants.length === 0) {
    throw new MeasureError('catalog 为空（"mutants": []）：空集合不是"全部通过"，没能测量');
  }
  const names = new Set();
  mutants.forEach((m, i) => {
    const where = `catalog 第 ${i + 1} 条`;
    if (!m || typeof m !== 'object') throw new MeasureError(where + ' 不是对象');
    if (!m.name || typeof m.name !== 'string') throw new MeasureError(where + ' 缺 name');
    if (names.has(m.name)) throw new MeasureError('catalog name 重复: ' + m.name);
    names.add(m.name);
    if (!m.base || typeof m.base !== 'string') throw new MeasureError(where + ' 缺 base');
    assertBaseVersioned(m.base, where);
    if (!Array.isArray(m.mutate) || m.mutate.length === 0) throw new MeasureError(where + ' 缺 mutate');
    if (!m.expect || typeof m.expect !== 'object') throw new MeasureError(where + ' 缺 expect');
    if (m.expect.exit !== 0 && m.expect.exit !== 1) throw new MeasureError(where + ' expect.exit 只能是 0/1');
    if (!Array.isArray(m.expect.mustInclude) || m.expect.mustInclude.length === 0) {
      throw new MeasureError(where + ' expect.mustInclude 不能为空（空断言永远为真）');
    }
    if (!m.expect.mustInclude.every((x) => typeof x === 'string' && x)) {
      throw new MeasureError(where + ' expect.mustInclude 必须是非空字符串数组');
    }
  });
  return mutants;
}

/* ------------------------------------------------------------------ *
 * 引擎：base 自检 → 逐条突变 → 断言 → 分母
 * ------------------------------------------------------------------ */
function runCatalog({ catalogPath, print }) {
  const lines = [];
  const say = (s) => { lines.push(s); if (print) console.log(s); };

  const mutants = loadCatalog(catalogPath);
  const totalSet = totalCriteria();
  const baseFile = sha12(FABCHECK);
  say(`MUTANTS runner · fabcheck sha256_12=${baseFile} · 判据总数 ${totalSet.size}（B/W/N/P 注册去重）· @${AS_OF} · node ${process.version}`);
  say(`CATALOG ${path.relative(ROOT, catalogPath)} · ${mutants.length} 条突变`);

  const bases = [...new Set(mutants.map((m) => m.base))];
  const baseInfo = new Map();
  for (const base of bases) {
    const abs = path.resolve(ROOT, base);
    if (!fs.existsSync(abs)) {
      throw new MeasureError(`base 不存在: ${base}（out/ 会被 cleanup.ps1 裁剪；"没样本"不是"全部通过"）`);
    }
    if (!fs.statSync(abs).isDirectory()) throw new MeasureError(`base 不是目录: ${base}`);
    const tmp = mktmp('fabmut-base-');
    const work = path.join(tmp, 'copy');
    fs.cpSync(abs, work, { recursive: true });
    const r = runFabcheck(work);
    if (r.bad) throw new MeasureError(`base 自检时 fabcheck 没能跑出 JSON: ${base}: ${r.detail}`);
    if (r.status !== 0) {
      const j = r.json;
      const ids = collectIds(j);
      throw new MeasureError(
        `base 不干净: ${base} 未突变副本 exit=${r.status}（期望 0）· blockers=[${idsOf(ids.blockers)}] warnings=[${idsOf(ids.warnings)}] notes=[${idsOf(ids.notes)}]`
      );
    }
    const ids = collectIds(r.json);
    baseInfo.set(base, ids);
    const s = (r.json && r.json.summary) || {};
    say(`BASE ${base} 未突变副本 exit=0 · ${s.blockers || 0} 阻断 / ${s.warnings || 0} 警告 / ${s.notes || 0} 说明`);
  }

  const results = [];
  const proven = new Set();
  mutants.forEach((m, i) => {
    const tmp = mktmp('fabmut-case-');
    const work = path.join(tmp, 'work');
    fs.cpSync(path.resolve(ROOT, m.base), work, { recursive: true });
    applyMutate(work, m.mutate);
    const r = runFabcheck(work);
    if (r.bad) throw new MeasureError(`突变 ${m.name} 后 fabcheck 没能给出可解析 JSON: ${r.detail}`);

    const observed = collectIds(r.json);
    const baseIds = baseInfo.get(m.base).all;
    const dirty = m.expect.mustInclude.filter((id) => baseIds.has(id));
    if (dirty.length) {
      throw new MeasureError(`断言目标在干净 base 上已经亮了，这条突变无法证明它：${m.name}: ${dirty.join(', ')}`);
    }
    const exitOk = r.status === m.expect.exit;
    const missing = m.expect.mustInclude.filter((id) => !observed.all.has(id));
    const ok = exitOk && missing.length === 0;
    if (ok) for (const id of m.expect.mustInclude) proven.add(id);

    const incidental = [...observed.all].filter((id) => !baseIds.has(id) && !m.expect.mustInclude.includes(id));
    const tag = `[${String(i + 1).padStart(2)}/${mutants.length}]`;
    say(
      `${tag} ${m.name.padEnd(24)} → exit ${r.status}（期望 ${m.expect.exit}）· ${ok ? '命中' : '未命中'} ${m.expect.mustInclude.join(', ')}`
      + (ok && incidental.length ? ` · 附带 [${incidental.join(', ')}]` : '')
    );
    if (!ok) {
      if (!exitOk) say(`         ↳ 退出码不匹配：期望 ${m.expect.exit}，实际 ${r.status}`);
      if (missing.length) say(`         ↳ 输出里没出现：${missing.join(', ')}`);
      say(`         ↳ 实际 blockers=[${idsOf(observed.blockers)}] warnings=[${idsOf(observed.warnings)}] notes=[${idsOf(observed.notes)}]`);
    }
    results.push({ name: m.name, ok, exit: r.status, expectedExit: m.expect.exit, missing, observed });
  });

  const pass = results.filter((r) => r.ok).length;
  const total = totalSet.size;
  // 【覆盖率必须进判决】原来它只是打在结论行里的一个数字：12/69（17.4%）也照样 exit 0。
  // 对抗性审查实测：把 `antenna.keepout.copper` 那条判据敲坏
  //（`else if (false && copperBad)`）——寓言下渲染不了那个坑，而 **16 道闸门全绿**。
  // 现在它是棘轮：只许升不许降。底数 12 是**实测值**，不是目标值。
  const MIN_PROVEN = 14;   // 2026-11-27：补齐 drill.tool.missing 与 antenna.keepout.copper 后的实测值
// 只许升不许降。上一个实测值是 12。
  const pct = ((proven.size / total) * 100).toFixed(1);
  say(`覆盖只统计被 mustInclude 点名、且在该突变输出里真的出现的 id；base 自带的 id 不计入。`);
  if (pass === results.length) {
    say(`MUTANTS=PASS ${pass}/${results.length} 命中 · 覆盖判据 ${proven.size} / 共 ${total}（${pct}%）· 未命中 0`);
  } else {
    const failedNames = results.filter((r) => !r.ok).map((r) => r.name);
    say(`MUTANTS=FAIL ${pass}/${results.length} 命中 · 未命中 ${failedNames.length}（${failedNames.join(', ')}）`);
    say(`覆盖判据 ${proven.size} / 共 ${total}（${pct}%）`);
  }
  // 【只在「全部命中」的前提下才报棘轮】实测 2026-11-27：单条突变失败时
  // proven 也会少一条，于是输出里同时出现「未命中 1」和「棘轮被破 13/14」——
  // 后者是假的，会把人引向「删了用例」而不是「闸门坏了」。棘轮只对
  // 「全部命中但覆盖面变小」这种情形发声。
  if (pass === results.length && proven.size < MIN_PROVEN) {
    say(`MUTANTS=FAIL 覆盖棘轮被破：${proven.size} / ${MIN_PROVEN} —— 删掉变异用例就等于放宽了闸门`);
    return { code: 1, lines, results, proven, total };
  }
  return { code: pass === results.length ? 0 : 1, lines, results, proven, total };
}

/* ------------------------------------------------------------------ *
 * 元突变自检：坏期望必须退 1，证明断言不是永远为真
 * ------------------------------------------------------------------ */
function selftest() {
  const real = JSON.parse(fs.readFileSync(DEFAULT_CATALOG, 'utf8'));
  const mutants = Array.isArray(real) ? real : real.mutants;
  if (!Array.isArray(mutants) || !mutants.length) throw new MeasureError('正式 catalog 为空，selftest 没有 base 可借');
  const base = mutants[0].base;
  const mutation = [{ op: 'truncate', file: 'Board.pdf', bytes: 8 }]; // 已知必亮 pdf.pages

  const tmp = mktmp('fabmut-selftest-');
  const mk = (mustInclude) => ({
    mutants: [{
      name: 'selftest.pdf.pages',
      base,
      mutate: mutation,
      expect: { exit: 1, mustInclude },
    }],
  });
  const goodPath = path.join(tmp, 'good.json');
  const badPath = path.join(tmp, 'bad.json');
  fs.writeFileSync(goodPath, JSON.stringify(mk(['pdf.pages']), null, 2));
  fs.writeFileSync(badPath, JSON.stringify(mk(['no.such.id']), null, 2));

  const good = runCatalog({ catalogPath: goodPath, print: false });
  const bad = runCatalog({ catalogPath: badPath, print: false });

  if (good.code !== 0) {
    throw new MeasureError('selftest 控制组没通过：已知会亮的 pdf.pages 突变被判未命中\n' + good.lines.join('\n'));
  }
  if (bad.code !== 1) {
    throw new MeasureError(
      `selftest 失败：mustInclude=["no.such.id"] 的坏期望没有让整轮退 1（实际 exit=${bad.code}）——断言可能永远为真\n`
      + bad.lines.join('\n')
    );
  }
  if (!bad.lines.join('\n').includes('no.such.id')) {
    throw new MeasureError('selftest 失败：坏期望退 1 了，但输出里没点名 no.such.id');
  }
  console.log('MUTANTS-SELFTEST=PASS 断言真的在读输出：好期望(pdf.pages)→0 / 坏期望(no.such.id)→1');
  return 0;
}

/* ------------------------------------------------------------------ */
function main() {
  if (!fs.existsSync(FABCHECK)) throw new MeasureError('找不到 scripts/fabcheck.js: ' + FABCHECK);
  if (CAT_ARG_I >= 0 && !ARGS[CAT_ARG_I + 1]) throw new MeasureError('--catalog 需要一个路径参数');
  if (SELFTEST) return selftest();
  return runCatalog({ catalogPath: CATALOG, print: true }).code;
}

let code = 2;
try {
  code = main();
} catch (e) {
  if (e instanceof MeasureError) {
    console.error('MUTANTS=ERROR ' + e.message);
  } else {
    console.error('MUTANTS=ERROR 未预期异常: ' + (e && e.stack ? e.stack : e));
  }
  code = 2;
} finally {
  cleanupTmp();
}
process.exit(code);
