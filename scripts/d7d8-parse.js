// d7d8-parse.js —— 从 logs\*.json（run-all 落盘的 invoke 信封）里抽取 PHASE 阶段耗时
// 用法: node scripts\d7d8-parse.js logs\xxx.json [logs\yyy.json ...]
// 纯只读分析，不接触 EDA。
const fs = require('fs');

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node d7d8-parse.js <log.json ...>');
  process.exit(2);
}

const out = [];
for (const f of files) {
  let env;
  try { env = JSON.parse(fs.readFileSync(f, 'utf8')); }
  catch (e) { out.push({ file: f, error: 'parse fail: ' + e.message }); continue; }
  const v = env && env.value ? env.value : null;
  if (!v || !Array.isArray(v.log)) { out.push({ file: f, error: 'no value.log', keys: Object.keys(env || {}) }); continue; }

  const phases = [];
  let prev = 0;
  for (const e of v.log) {
    if (e.s !== 'PHASE') continue;
    const ms = Number(e.v.ms) || 0;
    phases.push({ name: e.v.n, atMs: ms, durMs: ms - prev });
    prev = ms;
  }
  if (phases.length) phases[phases.length - 1].durMs = (Number(v.elapsedMs) || prev) - (phases[phases.length - 1].atMs - phases[phases.length - 1].durMs);

  const count = (s) => v.log.filter(e => e.s === s).length;
  const route = v.log.filter(e => e.s === 'route').map(e => ({ iter: e.v.iter, variant: e.v.variant, state: e.v.state, ms: e.v.ms }));
  const rec = {
    file: f,
    elapsedMs: v.elapsedMs,
    ok: v.ok,
    board: v.boardWidthMil + 'x' + v.boardHeightMil,
    routeState: v.routeState,
    drcPassed: v.drcPassed,
    drcDetailCount: v.drcDetailCount,
    phases: phases.map(p => ({ phase: p.name, startMs: p.atMs, durMs: p.durMs })),
    routeRuns: route,
    counters: {
      routeIter: count('routeIter'),
      stitchRound: count('stitchRound'),
      clearanceRound: count('clearanceRound'),
      drcAttempt: count('drcAttempt'),
      stitchFix: count('stitch'),
      trackThinned: count('trackThinned'),
      trackRerouted: count('trackRerouted'),
      viaDeleted: count('viaDeleted'),
    },
  };
  out.push(rec);
}

for (const r of out) {
  if (r.error) { console.log('=== ' + r.file + '  ERROR: ' + r.error); continue; }
  const total = (r.elapsedMs / 1000).toFixed(1);
  console.log(`=== ${r.file}`);
  console.log(`    elapsed=${total}s ok=${r.ok} board=${r.board} route=${r.routeState} drcPassed=${r.drcPassed} drcDetail=${r.drcDetailCount}`);
  console.log('    ' + r.phases.map(p => `${p.phase}=${(p.durMs / 1000).toFixed(1)}s`).join('  '));
  const tail = (r.elapsedMs - (r.phases.length ? r.phases[r.phases.length - 1].startMs : 0)) / 1000;
  console.log(`    [after last phase marker: ${tail.toFixed(1)}s]`);
  if (r.routeRuns.length) console.log('    routes: ' + r.routeRuns.map(x => `#${x.iter}/${x.variant}=${x.state}@${(x.ms / 1000).toFixed(0)}s`).join(' '));
  console.log('    counters: ' + JSON.stringify(r.counters));
}
