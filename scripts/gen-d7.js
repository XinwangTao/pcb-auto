// 生成 d7：RP2040 + QSPI Flash（真实产品最小系统）
// 用途：验证「MCU + 外部 Flash + 双电源域 + LED」这类的完整拓扑能否全自动打通
const fs = require('fs');
const path = require('path');

const comps = [
  { des: 'U1', lcsc: 'C2040',  value: 'RP2040' },
  { des: 'U2', lcsc: 'C131025', value: 'W25Q16JVSSIQ' },
  { des: 'U3', lcsc: 'C6186',  value: 'AMS1117-3.3' },
  { des: 'C1', lcsc: 'C440198', value: '10uF' },
  { des: 'C2', lcsc: 'C14663', value: '100nF' },
  { des: 'C3', lcsc: 'C14663', value: '100nF' },
  { des: 'C4', lcsc: 'C440198', value: '10uF' },
  { des: 'R1', lcsc: 'C11702', value: '1k' },
  { des: 'R2', lcsc: 'C11702', value: '1k' },
  { des: 'D1', lcsc: 'C2297',  value: 'LED-Green' },
];

const C = [];
const add = (des, pin, net) => C.push([des, String(pin), net]);

// --- RP2040 电源 ---
// IOVDD x6 / ADC_AVDD / VREG_IN / USB_VDD 全部接 3V3
for (const p of [1, 10, 22, 33, 42, 43, 44, 48, 49]) add('U1', p, '3V3');
// DVDD x2 由内部 VREG 输出的 1V1 供电
for (const p of [23, 50, 45]) add('U1', p, '1V1');
// GND / TESTEN
for (const p of [19, 57]) add('U1', p, 'GND');

// --- QSPI 总线：RP2040 <-> Flash ---
// W25Q16 SOIC-8: 1=CS 2=DO/IO1 3=WP/IO2 4=GND 5=DI/IO0 6=CLK 7=HOLD/IO3 8=VCC
const qspi = [
  [56, 1, 'QSPI_SS'],
  [53, 5, 'QSPI_SD0'],
  [55, 2, 'QSPI_SD1'],
  [54, 3, 'QSPI_SD2'],
  [51, 7, 'QSPI_SD3'],
  [52, 6, 'QSPI_SCLK'],
];
for (const [rp, fp, net] of qspi) { add('U1', rp, net); add('U2', fp, net); }

// --- Flash 供电 ---
add('U2', 8, '3V3');
add('U2', 4, 'GND');

// --- LDO 3.3V：5V -> 3V3 ---
add('U3', 3, '5V');
add('U3', 1, 'GND');
add('U3', 2, '3V3');

// --- 去耦 ---
add('C1', 1, '5V');  add('C1', 2, 'GND');
add('C2', 1, '3V3'); add('C2', 2, 'GND');
add('C3', 1, '1V1'); add('C3', 2, 'GND');
add('C4', 1, '3V3'); add('C4', 2, 'GND');

// --- RUN 上拉 + 状态灯 ---
add('R1', 1, '3V3'); add('R1', 2, 'RUN'); add('U1', 26, 'RUN');
add('R2', 1, '3V3'); add('R2', 2, 'LED_A');
add('D1', 1, 'LED_A'); add('D1', 2, 'GND');

const nets = [...new Set(C.map((x) => x[2]))].sort();
const design = {
  name: 'RP2040_QSPI_Flash',
  friendly: 'RP2040_QSPI_Flash',
  _compiledBy: 'gen-d7.js',
  _complexity: 'hard',
  boardWidthMil: 2400,
  boardHeightMil: 1800,
  components: comps,
  connections: C,
};
const out = path.join(__dirname, '..', 'designs', 'd7-rp2040-flash.json');
fs.writeFileSync(out, JSON.stringify(design, null, 1), 'utf8');
console.log(`${comps.length} 器件 / ${C.length} 连接 / ${nets.length} 网络`);
console.log('网络:', nets.join(', '));
console.log('->', out);
