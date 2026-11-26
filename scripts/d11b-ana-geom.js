// 离线分析：读 d11b-01-probe.js 的输出 JSON，打印指定网络的焊盘/走线/过孔关系
// 用法: node d11b-ana-geom.js <probe.json> [NET ...]
const fs = require('fs');
const file = process.argv[2];
const nets = process.argv.slice(3);
const v = JSON.parse(fs.readFileSync(file, 'utf8')).value;
const R = n => Math.round(n * 10) / 10;

const targets = nets.length ? nets : ['XTAL_IN'];
for (const net of targets) {
  console.log(`\n===== ${net} =====`);
  const pads = v.pads.filter(p => p.net === net);
  const lines = v.lines.filter(l => l.net === net);
  const vias = v.vias.filter(x => x.net === net);
  console.log('pads:');
  for (const p of pads) console.log(' ', p.id, `(${R(p.x)},${R(p.y)})`, p.shape?.t, 'rot', p.rot, 'abs', JSON.stringify(p.abs), 'layer', p.layer);
  console.log('lines:');
  for (const l of lines) console.log(' ', l.id, 'L' + l.layer, `(${R(l.x1)},${R(l.y1)})->(${R(l.x2)},${R(l.y2)})`, 'w', l.w);
  console.log('vias:');
  for (const x of vias) console.log(' ', x.id, `(${R(x.x)},${R(x.y)})`, 'd', x.d, 'hole', x.hole);
  // 端点重合度统计（同层）
  const ends = [];
  for (const l of lines) {
    ends.push({ id: l.id, x: l.x1, y: l.y1, layer: l.layer });
    ends.push({ id: l.id, x: l.x2, y: l.y2, layer: l.layer });
  }
  const dangle = [];
  for (const e of ends) {
    const same = ends.filter(o => o !== e && o.layer === e.layer && Math.hypot(o.x - e.x, o.y - e.y) < 0.6);
    const onPad = pads.some(p => Math.hypot(p.x - e.x, p.y - e.y) < 6);
    const onVia = vias.some(p => Math.hypot(p.x - e.x, p.y - e.y) < 6);
    if (!same.length && !onPad && !onVia) dangle.push({ id: e.id, x: R(e.x), y: R(e.y), L: e.layer });
  }
  console.log('dangling ends (not touching line/pad/via):', dangle.length);
  for (const d of dangle) console.log('  ', d);
  if (v.leaves) {
    const rel = v.leaves.filter(l => l.net === net);
    console.log('DRC leaves for net:', JSON.stringify(rel));
  }
}
