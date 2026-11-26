const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = process.env.PCB_AUTO_LCEDA || process.env.LCEDA;
if (!CLI) {
  console.error('找不到 lceda-pro.exe。设置 PCB_AUTO_LCEDA 指向它（本项目只支持 4.1.111）。');
  process.exit(2);
}
const session = process.argv[2];

const body = `
const out = { groups: [], rotSamples: [], verify: null, errors: [] };
const ids = (await eda.pcb_PrimitivePad.getAllPrimitiveId()) || [];

const groups = new Map();
for (const id of ids) {
  try {
    const p = await eda.pcb_PrimitivePad.get(id);
    if (!p) continue;
    const raw = p.getState_Pad();
    if (!Array.isArray(raw)) continue;
    const kind = String(raw[0]).toUpperCase();
    const key = kind;
    if (!groups.has(key)) {
      groups.set(key, { kind, n: 0, raw0: JSON.stringify(raw).slice(0, 300),
        rot: p.getState_Rotation(), x: p.getState_X(), y: p.getState_Y(), id });
    }
    groups.get(key).n++;
  } catch (e) { out.errors.push(String(e && e.message).slice(0, 100)); }
}
out.groups = Array.from(groups.values());

// 不同 rotation 的 RECT 样例
for (const id of ids) {
  try {
    const p = await eda.pcb_PrimitivePad.get(id);
    const raw = p.getState_Pad();
    if (!Array.isArray(raw) || String(raw[0]).toUpperCase() !== 'RECT') continue;
    const rot = Number(p.getState_Rotation() || 0);
    if (out.rotSamples.some(r => Math.abs(r.rot - rot) < 0.5)) continue;
    out.rotSamples.push({ id, rot, w: raw[1], h: raw[2],
      x: p.getState_X(), y: p.getState_Y() });
    if (out.rotSamples.length >= 8) break;
  } catch (e) {}
}

// 交叉验证 d11 晶振 pad4（RECT 55.1x47.2 rot 180）
try {
  const p = await eda.pcb_PrimitivePad.get('46609f0319331ca3e16');
  const raw = p.getState_Pad();
  const w = Number(raw[1]), h = Number(raw[2]);
  const r = Number(p.getState_Rotation() || 0) * Math.PI / 180;
  const c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
  const bw = w * c + h * s, bh = w * s + h * c;
  const cx = Number(p.getState_X()), cy = Number(p.getState_Y());
  out.verify = { raw: JSON.stringify(raw), w, h, rot: p.getState_Rotation(),
    cx, cy, bw: +bw.toFixed(4), bh: +bh.toFixed(4),
    bbox: [+(cx-bw/2).toFixed(2), +(cy-bh/2).toFixed(2),
           +(cx+bw/2).toFixed(2), +(cy+bh/2).toFixed(2)],
    expect: 'x[1321.95,1377.05] y[-153.0,-105.8]' };
} catch (e) { out.verify = { err: String(e && e.message).slice(0, 150) }; }

return out;
`;

const tmp = path.join(ROOT, 'scripts', '_ps.js');
fs.writeFileSync(tmp, body, 'utf8');
const args = ['invoke', '--code-file', tmp, '--args', '{}', '--timeout', '180000'];
if (session) args.push('--session', session);
const r = spawnSync(CLI, args, { cwd: ROOT, encoding: 'utf8', timeout: 300000,
  maxBuffer: 32 * 1024 * 1024, windowsHide: true });
console.log((r.stdout || '').slice(0, 12000));
if (r.stderr) console.log('--- stderr ---\n' + r.stderr.slice(0, 2000));
fs.unlinkSync(tmp);
