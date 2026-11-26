// 产物格式规范化：只由流水线自带的 EDA 导出决定不了格式，但导出后可以修。
// 动机（实测 out\USBC_Power_ESD-*）：
//   1. TestPoints.csv 其实是 **xlsx**（文件头 80 4B 03 04 = ZIP）。名字写 .csv 是骗人的，
//      任何 CSV 解析器都会崩，打样厂上传也会失败。
//   2. PnP.csv 是 UTF-16LE + 制表符 + 全字段加引号 + 坐标带 "mm" 后缀，
//      贴片机的解析器读不了 "21.935mm" 这种值。
// 这两项直接决定"能不能拿去下单"，所以必须修。转换保持幂等，重复跑无副作用。
//
// 用法：node scripts\fix-artifacts.js <产物目录>
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
if (!dir) { console.error('用法: node fix-artifacts.js <产物目录>'); process.exit(2); }
if (!fs.existsSync(dir)) { console.error('目录不存在: ' + dir); process.exit(2); }

const acts = [];
const problems = [];

// ---------- 1. TestPoints.csv 实为 xlsx ----------
{
  const p = path.join(dir, 'TestPoints.csv');
  if (fs.existsSync(p)) {
    const b = fs.readFileSync(p);
    const isZip = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
    if (isZip) {
      const dst = path.join(dir, 'TestPoints.xlsx');
      fs.renameSync(p, dst);
      acts.push(`TestPoints.csv 实为 xlsx，改名 -> TestPoints.xlsx (${b.length}B)`);
    } else {
      acts.push('TestPoints.csv 是真文本，保持原名');
    }
  }
}

// ---------- 2. PnP.csv 规范化 ----------
{
  const p = path.join(dir, 'PnP.csv');
  if (fs.existsSync(p)) {
    const buf = fs.readFileSync(p);
    const utf16 = buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe;
    let txt = (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^\uFEFF/, '');
    const lines = txt.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) {
      problems.push('PnP.csv 为空');
    } else {
      const sep = lines[0].includes('\t') ? '\t' : ',';
      let stripped = 0;
      const out = lines.map((l) => {
        const cells = l.split(sep);
        // 单元格内容里没有逗号时不需要引号；有逗号的保留引号。
        // 同时去掉数值后的 mm/mil 单位，让贴片机能直接读数字。
        const fixed = cells.map((c) => {
          let s = c;
          const m = /^"(-?[\d.]+)(mm|mil)"$/i.exec(s);
          if (m) { stripped++; return m[1]; }
          if (s.includes(',')) return s.startsWith('"') ? s : `"${s}"`;
          return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
        });
        return fixed.join(',');
      });
      const body = out.join('\r\n') + '\r\n';
      const changed = utf16 || sep !== ',' || stripped > 0;
      if (changed) {
        fs.writeFileSync(p, '\uFEFF' + body, 'utf8');
        acts.push(`PnP.csv 规范化为 UTF-8/逗号/去单位：编码${utf16 ? 'UTF-16LE->UTF-8' : '已是UTF-8'}`
          + `, 分隔符${sep === '\t' ? 'TAB->逗号' : '逗号'}, 去单位 ${stripped} 处`);
      } else {
        acts.push('PnP.csv 已是规范格式');
      }
      // 自检：转换后必须能按逗号切出与表头等长的列
      const chk = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
      const hc = chk[0].split(',').length;
      const bad = chk.slice(1).filter((l) => l.split(',').length !== hc);
      if (bad.length) problems.push(`PnP 转换后 ${bad.length} 行列数与表头(${hc})不符`);
      if (/mm"/i.test(chk.slice(1).join('\n'))) problems.push('PnP 仍残留带单位的值');
    }
  }
}

// ---------- 3. 交付清单的自洽性 ----------
{
  const need = ['Gerber.zip', 'BOM.xlsx', 'PnP.csv', 'Netlist.json', 'Board.pdf'];
  const miss = need.filter((n) => !fs.existsSync(path.join(dir, n)));
  if (miss.length) problems.push('缺产物: ' + miss.join(', '));
  const pdf = path.join(dir, 'Board.pdf');
  if (fs.existsSync(pdf)) {
    const b = fs.readFileSync(pdf);
    if (b.slice(0, 5).toString('latin1') !== '%PDF-') problems.push('Board.pdf 头不是 %PDF');
  }
}

for (const a of acts) console.log('  [修正] ' + a);
for (const p of problems) console.log('  [问题] ' + p);
console.log(JSON.stringify({ ok: problems.length === 0, dir: path.basename(dir), acts, problems }));
process.exit(problems.length ? 1 : 0);
