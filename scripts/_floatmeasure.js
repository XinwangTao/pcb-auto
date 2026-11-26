// 量测：每个设计里，多脚 IC 有多少引脚在任何网络里都没出现（悬空）。
// 目的：用真实数据校准阈值，避免拍脑袋定一个会误报的数字。
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const cat = JSON.parse(fs.readFileSync(path.join(root, 'designs', '_catalog.json'), 'utf8'));
const byLcsc = new Map(cat.parts.map((p) => [String(p.lcsc), p]));

function expandPins(v) {
  const out = new Set();
  const walk = (x) => {
    if (x == null) return;
    if (Array.isArray(x)) return x.forEach(walk);
    if (typeof x === 'object') return Object.values(x).forEach(walk);
    String(x).split(/[\s,]+/).filter(Boolean).forEach((t) => out.add(t));
  };
  walk(v);
  return [...out];
}

const rows = [];
for (const f of fs.readdirSync(path.join(root, 'designs')).filter((n) => /^d\d+.*\.json$/.test(n)).sort()) {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(root, 'designs', f), 'utf8')); } catch (e) { continue; }
  const used = new Map(); // des -> Set(pin)
  for (const t of d.connections || []) {
    if (!Array.isArray(t) || t.length < 3) continue;
    const [des, pin] = t;
    if (!used.has(des)) used.set(des, new Set());
    used.get(des).add(String(pin));
  }
  for (const c of d.components || []) {
    const meta = byLcsc.get(String(c.lcsc));
    if (!meta || !meta.pins) continue;
    const all = expandPins(meta.pins);
    if (all.length < 6) continue;              // 只看多脚 IC，与现有检查口径一致
    const u = used.get(c.des) || new Set();
    const float = all.filter((p) => !u.has(p));
    rows.push({
      design: f.replace(/\.json$/, ''), des: c.des, part: meta.name,
      total: all.length, used: all.length - float.length,
      floating: float.length, ratio: +(float.length / all.length).toFixed(2),
      floatPins: float.join(' '),
    });
  }
}

rows.sort((a, b) => b.ratio - a.ratio);
console.log('比值  悬空/总  设计                      器件  型号');
for (const r of rows) {
  console.log(
    String(r.ratio).padEnd(5) + String(r.floating + '/' + r.total).padEnd(9) +
    r.design.padEnd(26) + r.des.padEnd(5) + r.part
  );
}
console.log('\n=== 悬空比例 >= 0.40 的（候选 FAIL 线）===');
const bad = rows.filter((r) => r.ratio >= 0.4);
for (const r of bad) console.log(`  ${r.design} ${r.des}(${r.part}) 悬空 ${r.floating}/${r.total}: ${r.floatPins}`);
console.log(`  共 ${bad.length} 条；设计数 ${new Set(bad.map((r) => r.design)).size}`);
console.log('\n=== 悬空比例 < 0.40 的（应保持通过）===');
for (const r of rows.filter((x) => x.ratio < 0.4)) console.log(`  ${r.design} ${r.des}(${r.part}) ${r.floating}/${r.total}`);
