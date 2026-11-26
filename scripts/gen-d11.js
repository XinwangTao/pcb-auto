// 生成 designs/d11-crystal-rtc.json —— 12MHz 主时钟 + 32.768kHz RTC 时钟电路
// 这是之前完全没有的拓扑：时钟树。引脚依据实测：
//   C9002 X322512MSB4SI（12MHz 4 脚）：1=OSC1 2=GND 3=OSC2 4=GND
//   C32346 Q13FC13500004（32.768kHz 2 脚）：1 / 2
//   C1548 = 15pF 0402
const fs = require('fs');
const path = require('path');

const components = [
  // 12MHz 主晶振（RP2040 XIN/XOUT 常用规格）
  { des: 'Y1', lcsc: 'C9002', value: '12MHz' },
  { des: 'C1', lcsc: 'C1548', value: '15pF' },   // XIN 负载电容
  { des: 'C2', lcsc: 'C1548', value: '15pF' },   // XOUT 负载电容
  // 32.768kHz RTC 晶振
  { des: 'Y2', lcsc: 'C32346', value: '32.768kHz' },
  { des: 'C3', lcsc: 'C1548', value: '15pF' },
  { des: 'C4', lcsc: 'C1548', value: '15pF' },
  // 主控 MCU（用 RP2040 真实 XIN/XOUT 引脚）
  { des: 'U1', lcsc: 'C2040', value: 'RP2040' },
  // 供电去耦
  { des: 'C5', lcsc: 'C14663', value: '100nF' },
  { des: 'C6', lcsc: 'C14663', value: '100nF' },
  { des: 'C7', lcsc: 'C440198', value: '10uF' },
  // 引出排针，供示波器/外部时钟注入
  { des: 'H1', lcsc: 'C9900192758', value: '2.54-1*8' },
];

const connections = [
  // ---- 12MHz 主时钟（RP2040: XIN=20, XOUT=21）----
  ['U1', '20', 'XIN'],
  ['U1', '21', 'XOUT'],
  ['Y1', '1', 'XIN'],       // OSC1
  ['Y1', '3', 'XOUT'],      // OSC2
  ['Y1', '2', 'GND'],       // 晶振外壳接地
  ['Y1', '4', 'GND'],
  ['C1', '1', 'XIN'],
  ['C1', '2', 'GND'],
  ['C2', '1', 'XOUT'],
  ['C2', '2', 'GND'],

  // ---- 32.768kHz RTC 时钟 ----
  ['Y2', '1', 'RTC_XIN'],
  ['Y2', '2', 'RTC_XOUT'],
  ['C3', '1', 'RTC_XIN'],
  ['C3', '2', 'GND'],
  ['C4', '1', 'RTC_XOUT'],
  ['C4', '2', 'GND'],

  // ---- 供电 ----
  ['U1', '1', '3V3'],       // IOVDD
  ['U1', '10', '3V3'],
  ['U1', '22', '3V3'],
  ['U1', '33', '3V3'],
  ['U1', '42', '3V3'],
  ['U1', '49', '3V3'],
  ['U1', '23', '1V1'],      // DVDD
  ['U1', '50', '1V1'],
  ['U1', '44', '3V3'],      // VREG_IN
  ['U1', '45', '1V1'],      // VREG_VOUT
  ['U1', '43', '3V3'],      // ADC_AVDD
  ['U1', '48', '3V3'],      // USB_VDD
  ['U1', '19', 'GND'],      // TESTEN
  ['U1', '57', 'GND'],      // 中心地
  ['C5', '1', '3V3'],
  ['C5', '2', 'GND'],
  ['C6', '1', '1V1'],
  ['C6', '2', 'GND'],
  ['C7', '1', '3V3'],
  ['C7', '2', 'GND'],

  // ---- 时钟引出排针（便于测量/外部注入）----
  ['H1', '1', '3V3'],
  ['H1', '2', 'GND'],
  ['H1', '3', 'XIN'],
  ['H1', '4', 'XOUT'],
  ['H1', '5', 'RTC_XIN'],
  ['H1', '6', 'RTC_XOUT'],
  // 未用的 QSPI/RUN 不能悬空 —— 大网络必须有端点，这里接到排针备用
  ['H1', '7', 'RUN'],
  ['H1', '8', 'GND'],
  ['U1', '26', 'RUN'],
];

const design = {
  name: 'Crystal_RTC_Clock',
  friendly: '12MHz + 32.768kHz 时钟电路',
  _idea: '双时钟电路：12MHz 主晶振给 RP2040 XIN/XOUT，32.768kHz RTC 晶振，负载电容匹配，时钟引出排针',
  _compiledBy: 'manual-with-verified-pins',
  _complexity: '时钟电路',
  boardWidthMil: 1400,
  boardHeightMil: 1100,
  components,
  connections,
};

const out = path.join(__dirname, '..', 'designs', 'd11-crystal-rtc.json');
fs.writeFileSync(out, JSON.stringify(design, null, 2), 'utf8');
console.log('已生成:', out);
console.log('器件:', components.length, '连接:', connections.length);

const byNet = {};
for (const [des, pin, net] of connections) (byNet[net] = byNet[net] || []).push(des + '.' + pin);
const single = Object.entries(byNet).filter(([, v]) => v.length < 2);
if (single.length) { console.log('!! 单点网络:', JSON.stringify(single)); process.exit(1); }
const desSet = new Set(components.map((c) => c.des));
const unknown = connections.filter((c) => !desSet.has(c[0]));
if (unknown.length) { console.log('!! 未知位号:', JSON.stringify(unknown)); process.exit(1); }
if (!byNet['GND'] || byNet['GND'].length < 2) { console.log('!! 缺 GND'); process.exit(1); }
console.log('自检通过:', Object.keys(byNet).length, '个网络，全部 ≥2 点');
console.log('网络:', Object.keys(byNet).join(', '));
