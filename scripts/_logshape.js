const fs = require('fs');
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
function shape(o, d) {
  if (d > 2 || o === null) return;
  const t = Array.isArray(o) ? 'array(' + o.length + ')' : typeof o;
  console.log('  ' + '  '.repeat(d) + (Array.isArray(o) ? t : Object.keys(o).slice(0, 12).join(',') + '  [' + t + ']'));
  if (Array.isArray(o) && o.length && d < 2) shape(o[0], d + 1);
}
console.log('  顶层:');
shape(j, 0);
