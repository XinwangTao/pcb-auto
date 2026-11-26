// 想法编译器回归：能做的必须生成，做不了的必须明确拒绝并列出缺口。
// 关键教训：曾出现"想法要太阳能+锂电+OLED，实际只做了温湿度，还报全绿"，
// 以及"点名 TP4056 却产出 2 个电阻"——都是静默丢弃需求。
// 本测试锁死这两类退化。
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.dirname(__dirname);
const NODE = process.execPath;

// want: 0=应成功编译, 1=应拒绝
const CASES = [
  { idea: '做一个 SHT30 温湿度传感器，带 LED 指示和排针引出', want: 0 },
  { idea: '做一个 RP2040 最小系统板，带 QSPI Flash', want: 0 },
  { idea: '做一个 8 路 LED 流水灯，每个 LED 带限流电阻', want: 0 },
  { idea: '做一个 USB-C 供电的 3.3V 电源板，带 ESD 保护', want: 0 },
  { idea: '做一个太阳能充电的户外温湿度记录仪，带锂电池充电管理和 OLED 显示', want: 0 },
  { idea: '做一个 TP4056 锂电池充电板，带电池座和状态灯', want: 0 },
  { idea: '做一个带 OLED 显示的锂电池供电的温湿度计', want: 0 },
  // 以下功能目录里确实没有器件，必须拒绝而不是硬凑一块缺功能的板
  { idea: '做一个带蓝牙的温湿度传感器', want: 1, mustMention: '无线通信' },
  { idea: '做一个温湿度采集板，带 EEPROM 存储和 RTC 时钟', want: 1, mustMention: 'EEPROM' },
  { idea: '做一个电机驱动板，带按键控制', want: 1, mustMention: '电机驱动' },
  { idea: '做一个 FPGA 高速采集卡', want: 1 },
  { idea: '做一个带继电器的控制板', want: 1, mustMention: '继电器' },
];

// 点名了就必须真的在器件里——防"要 TP4056 却给了电阻"
const MUST_INCLUDE = [
  { idea: '做一个 TP4056 锂电池充电板，带电池座和状态灯', lcsc: ['C16581', 'C131337', 'C2297'] },
  { idea: '做一个太阳能充电的户外温湿度记录仪，带锂电池充电管理和 OLED 显示',
    lcsc: ['C16581', 'C5248080', 'C191023', 'C86346'] },
  { idea: '做一个带 OLED 显示的锂电池供电的温湿度计', lcsc: ['C5248080', 'C86346', 'C6186'] },
  { idea: '做一个 RP2040 最小系统板，带 QSPI Flash', lcsc: ['C2040', 'C131025'] },
];

function run(idea) {
  try {
    const out = execFileSync(NODE, [path.join(ROOT, 'scripts', 'idea2design.js'), idea, '--dry'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status === undefined ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

let pass = 0, fail = 0;
const fails = [];

for (const c of CASES) {
  const r = run(c.idea);
  if (r.code !== c.want) {
    fail++;
    fails.push(`判定错: "${c.idea}" 期望 exit=${c.want} 实际 exit=${r.code}`);
    continue;
  }
  if (c.want === 1 && c.mustMention && !r.out.includes(c.mustMention)) {
    fail++;
    fails.push(`拒绝理由不点名: "${c.idea}" 未提到「${c.mustMention}」`);
    continue;
  }
  if (c.want === 0) {
    const m = r.out.match(/器件\s*:\s*(\d+)\s*个/);
    const nComp = m ? parseInt(m[1], 10) : 0;
    if (nComp < 2) {
      fail++;
      fails.push('器件数异常: "' + c.idea + '" 只生成了 ' + nComp + ' 个');
      continue;
    }
  }
  pass++;
}

for (const c of MUST_INCLUDE) {
  const r = run(c.idea);
  if (r.code !== 0) { fail++; fails.push(`点名器件用例编译失败: "${c.idea}"`); continue; }
  const miss = c.lcsc.filter((l) => !r.out.includes(l));
  if (miss.length) {
    fail++;
    fails.push(`点名器件被丢弃: "${c.idea}" 缺 ${miss.join(',')}`);
  } else pass++;
}

console.log(`想法编译器回归: ${pass} 通过 / ${fail} 失败`);
if (fail) { for (const f of fails) console.log('  [FAIL] ' + f); process.exit(1); }
console.log('  能做的都生成了，做不了的都明确拒绝并列缺口');
process.exit(0);
