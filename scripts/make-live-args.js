// 把设计 JSON 转成 CLI invoke 的 args 文件，规避 CLI 沙箱无文件 IO 的限制。
// 用法: node scripts/make-live-args.js designs/d3-sht30-ldo.json out/live-args.json 150
const fs = require('fs');
const path = require('path');

const designPath = process.argv[2];
const outPath = process.argv[3] || 'out/live-args.json';
const stepMs = parseInt(process.argv[4] || '400', 10);
const maxWires = parseInt(process.argv[5] || '9999', 10);

if (!designPath) {
  console.error('用法: node make-live-args.js <design.json> [out.json] [stepMs] [maxWires]');
  process.exit(1);
}
const design = JSON.parse(fs.readFileSync(designPath, 'utf8'));
const args = { design, stepMs, maxWires };
fs.writeFileSync(outPath, JSON.stringify(args), 'utf8');
console.log('args 已写:', outPath, '(', fs.statSync(outPath).size, 'B )');
console.log('器件', design.components.length, '连接', design.connections.length, 'stepMs', stepMs);
