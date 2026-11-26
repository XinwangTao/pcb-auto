const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
console.log('  ok=' + j.ok + '  durationMs=' + j.durationMs);
console.log('  typeof value=' + typeof j.value + '  isArray=' + Array.isArray(j.value));
console.log('  typeof logs=' + typeof j.logs + '  isArray=' + Array.isArray(j.logs));
if (typeof j.value === 'object' && !Array.isArray(j.value)) {
  console.log('  value keys: ' + Object.keys(j.value).join(','));
}
if (typeof j.logs === 'object' && j.logs && !Array.isArray(j.logs)) {
  console.log('  logs keys: ' + Object.keys(j.logs).join(','));
}
if (Array.isArray(j.logs) && j.logs.length) {
  console.log('  logs[0]=' + JSON.stringify(j.logs[0]).slice(0,200));
}
