const fs = require('fs');
const path = require('path');
const files = ['d2-sht30-module', 'd3-sht30-ldo', 'd4-sht30-header', 'd13-solar-oled-logger'];
for (const f of files) {
  const p = path.join('designs', f + '.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const nets = new Map();
  for (const [des, pin, net] of (d.connections || [])) {
    if (!nets.has(des)) nets.set(des, []);
    nets.get(des).push(String(net).toUpperCase());
  }
  const acts = [];
  for (const c of d.components) {
    if (String(c.lcsc) !== 'C11702') continue;
    const n = nets.get(c.des) || [];
    const isPullup = n.includes('SDA') || n.includes('SCL');
    const isProg = n.includes('PROG');
    if (isPullup) {
      acts.push(`${c.des}: I2C上拉 ${c.value}/C11702(1k) -> 5.1k/C25905`);
      c.lcsc = 'C25905'; c.value = '5.1k';
    } else if (isProg) {
      acts.push(`${c.des}: PROG ${c.value}/C11702(1k=1.2A超额定) -> 5.1k/C25905(235mA)`);
      c.lcsc = 'C25905'; c.value = '5.1k';
    }
  }
  if (d._idea) d._idea = d._idea.replace(/4\.7\s*k/g, '5.1k').replace(/1\.2\s*k/g, '5.1k');
  if (acts.length) {
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
    console.log('  ' + f + ':');
    acts.forEach(a => console.log('    ' + a));
  } else {
    console.log('  ' + f + ': 无需改动');
  }
}