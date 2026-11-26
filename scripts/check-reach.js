#!/usr/bin/env node
// check-reach.js —— 量「信号网是否通得到板外」，**先量不设闸**。
//
// 为什么需要它：audit-design.js 已经能查「电源网没有能量来源」，但查不出
// 「信号网通不到板外」。8 路 LED 板就是这么过去的 —— 每网都有 ≥2 个引脚、
// DRC 全绿、六道闸门全绿，可外部只能碰到第 1 路（LED_A2..A8 是 R→LED
// 之间的内部网）。那是第八类失败：拓扑自洽但接口缺失。
//
// 本脚本只输出判定与证据，不 exit 1、不改任何文件。要变成闸门，先看这份
// 报表有没有把好板判成坏板。
//
// 用法: node scripts/check-reach.js [designs 目录]

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'designs');

// 与 audit-design.js 同口径的电源/地判据，避免把 GND 当成"信号没引出"
const PWR_RE = /^(VDD|VCC|3V3|5V|VBAT|VIN.*|VOUT|AVDD|DVDD|VBUS|SOLAR_IN|\d+V\d+|\+.*|.*_VCC)$/i;
const GND_RE = /^(GND|AGND|DGND|VSS|0V|EARTH)$/i;

// 「板外接口」= 用户/线缆能碰到的那一端。判据用的是**器件角色**，
// 不是网络名 —— 网络名看不出来它通到哪儿。
const OFFBOARD_ROLE = /连接器|排针|排插|插针|header|connector|端子|接口|座|电池|battery|引出/i;

let catalog = { parts: [] };
try {
  catalog = JSON.parse(fs.readFileSync(path.join(dir, '_catalog.json'), 'utf8'));
} catch (e) {
  console.error('读不到 _catalog.json: ' + e.message);
  process.exit(2);
}
const roleByLcsc = new Map();
for (const p of catalog.parts || []) roleByLcsc.set(p.lcsc, p.role || p.name || '');

const files = fs.readdirSync(dir).filter((f) =>
  f.endsWith('.json') && !f.startsWith('_')
).sort();

const rows = [];
for (const f of files) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }
  if (!Array.isArray(d.connections) || !Array.isArray(d.components)) continue;

  const offboard = new Set();
  const unknownRole = [];
  for (const c of d.components) {
    const role = roleByLcsc.get(c.lcsc);
    if (role === undefined) unknownRole.push(c.des + '(' + c.lcsc + ')');
    if (role && OFFBOARD_ROLE.test(role)) offboard.add(c.des);
  }

  // 网 → 引脚集合
  const netPins = new Map();
  for (const [des, pin, net] of d.connections) {
    if (!netPins.has(net)) netPins.set(net, []);
    netPins.get(net).push(des + '.' + pin);
  }

  const signalNoExit = [];
  let signalTotal = 0;
  for (const [net, pins] of netPins) {
    if (PWR_RE.test(net) || GND_RE.test(net)) continue;
    signalTotal++;
    const desSet = new Set(pins.map((p) => p.split('.')[0]));
    let reach = false;
    for (const des of desSet) if (offboard.has(des)) { reach = true; break; }
    if (!reach) signalNoExit.push({ net, pins });
  }

  rows.push({
    file: f,
    name: d.name,
    comps: d.components.length,
    offboard: [...offboard],
    unknownRole,
    signalTotal,
    signalNoExit,
  });
}

// ---- 报表 ----
const bad = rows.filter((r) => r.signalNoExit.length > 0);
const noExitAtAll = rows.filter((r) => r.offboard.length === 0);

console.log('设计 ' + rows.length + ' 个（' + dir + '）');
console.log('');
console.log('=== 有信号网通不到板外: ' + bad.length + ' 个 ===');
for (const r of bad) {
  console.log('  ' + r.file + '  [' + r.name + ']  ' + r.comps + ' 器件');
  console.log('    板外接口件: ' + (r.offboard.join(', ') || '【一个都没有】'));
  for (const s of r.signalNoExit) {
    console.log('    ✗ 网 ' + s.net + ' = ' + s.pins.join(' '));
  }
}
console.log('');
console.log('=== 完全没有板外接口件: ' + noExitAtAll.length + ' 个 ===');
for (const r of noExitAtAll) {
  console.log('  ' + r.file + '  [' + r.name + ']  ' + r.comps + ' 器件 / ' + r.signalTotal + ' 个信号网');
}
console.log('');
console.log('=== 角色未知（目录里没这个 lcsc）===');
const unk = rows.filter((r) => r.unknownRole.length);
if (!unk.length) console.log('  无');
for (const r of unk) console.log('  ' + r.file + ': ' + r.unknownRole.join(' '));
