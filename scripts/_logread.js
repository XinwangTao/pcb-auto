const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const v = j.value;
const logs = v.log || [];
console.log('  ok=' + j.ok + ' drcPassed=' + v.drcPassed + ' 条目=' + logs.length + ' 耗时=' + j.durationMs + 'ms');
console.log('=== 阶段耗时 ===');
let prev = 0;
for (const p of logs.filter(x => x.s === 'PHASE')) {
  const i = p.v.ms >= 0 ? p.v.ms : 0;
  console.log('  ' + String(p.v.n).padEnd(18) + i + ' ms' + (prev ? '  (+' + (i - prev) + ')' : ''));
  prev = i;
}
console.log('=== 关键证据 ===');
for (const k of ['routeRulesProof','valueMismatch','clearanceDone','clearanceFixes','drcCheck','mismatches','layoutState']) {
  const e = logs.filter(x => x.s === k);
  if (e.length) for (const x of e) console.log('  ' + k + ' = ' + JSON.stringify(x.v).slice(0, 260));
}
