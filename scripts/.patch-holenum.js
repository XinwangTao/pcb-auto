// 修 Hole×Hole 处理者的读数缺失判定：Number(null) === 0 会让"缺读数"看起来
// 像"缺口 11.8 mil"，于是记成 holePairTooFar（近乎"无望"）。
// 「未取到」不能编码成「无望」—— 必须先进 noCoord。
const fs = require('fs');
const F = process.argv[2];
let s = fs.readFileSync(F, 'utf8');
function rep(name, from, to) {
  const n = s.split(from).length - 1;
  if (n === 0) { console.error('✗ 锚点缺失: ' + name); process.exit(3); }
  if (n > 1) { console.error('✗ 锚点不唯一(' + n + '): ' + name); process.exit(4); }
  s = s.replace(from, to);
  console.log('✓ ' + name);
}

rep('读数缺失先判 NaN',
`        const needDist = Number(e.clearance) * 10;      // 画布单位 mil/10 → mil
        const curDist = Number(e.minDistance) * 10;`,
`        // 【必须先排除缺失，再 Number()】Number(null) === 0、Number('') === 0，
        // 于是"这一条没给读数"会算成 cur=0、缺口 11.8 mil，被记成 holePairTooFar
        // —— 读起来像"物理上不可修"，而真相是"这一次没读到"。
        // 与 viaGeomErr / holePairNoVia 同理：未取到 ≠ 无望。
        const holeNumMil = (v) => {
          if (v === null || v === undefined || v === '') return NaN;
          const n = Number(v);
          return Number.isFinite(n) ? n * 10 : NaN;     // 画布单位 mil/10 → mil
        };
        const needDist = holeNumMil(e.clearance);
        const curDist = holeNumMil(e.minDistance);`);

fs.writeFileSync(F, s, 'utf8');
console.log('  ' + fs.statSync(F).size + ' B');
