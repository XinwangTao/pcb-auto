// 生成 designs/d10-esp32c3.json —— ESP32-C3-WROOM-02 最小系统板
// 引脚依据实测 lib_Symbol.getGeometry（C2934560，19 脚）：
//   1=3V3  2=EN  3=IO4  4=IO5  5=IO6  6=IO7  7=IO8  8=IO9  9=GND
//   10=IO10 11=RXD 12=TXD 13=IO18 14=IO19 15=IO3 16=IO2 17=IO1 18=IO0 19=EP
const fs = require('fs');
const path = require('path');

const components = [
  // ESP32-C3-WROOM-02-N4 模组（2.4GHz WiFi+BLE，板载天线）
  { des: 'U1', lcsc: 'C2934560', value: 'ESP32-C3-WROOM-02' },
  // 3.3V LDO（800mA 级，够 C3 峰值电流）
  { des: 'U2', lcsc: 'C6186', value: 'AMS1117-3.3' },
  // 输入输出电容
  { des: 'C1', lcsc: 'C440198', value: '10uF' },   // 5V 输入
  { des: 'C2', lcsc: 'C440198', value: '10uF' },   // 3V3 输出
  { des: 'C3', lcsc: 'C14663', value: '100nF' },   // C3 去耦
  { des: 'C4', lcsc: 'C14663', value: '100nF' },   // 3V3 通用去耦
  // EN 上拉 + 复位按键等效（用 RC 复位，无按键）
  { des: 'R1', lcsc: 'C11702', value: '1k' },      // EN 上拉
  { des: 'C5', lcsc: 'C14663', value: '100nF' },   // EN 延时电容
  // 状态 LED（IO8 驱动）
  { des: 'R2', lcsc: 'C25905', value: '5.1k' },    // LED 限流
  { des: 'D1', lcsc: 'C2297', value: 'LED-Green' },
  // 串口调试 + 供电排针
  { des: 'H1', lcsc: 'C9900192758', value: '2.54-1*6' },
  // BOOT 上拉（IO9 高电平 = 正常启动）
  { des: 'R3', lcsc: 'C25905', value: '5.1k' },
  { des: 'C6', lcsc: 'C14663', value: '100nF' },
];

const connections = [
  // ---- 电源 ----
  ['U2', '3', '5V'],       // AMS1117 VI
  ['U2', '1', 'GND'],      // AMS1117 GND
  ['U2', '2', '3V3'],      // AMS1117 VO
  ['C1', '1', '5V'],
  ['C1', '2', 'GND'],
  ['C2', '1', '3V3'],
  ['C2', '2', 'GND'],
  ['C3', '1', '3V3'],
  ['C3', '2', 'GND'],
  ['C4', '1', '3V3'],
  ['C4', '2', 'GND'],
  ['U1', '1', '3V3'],      // 模组 3V3
  ['U1', '9', 'GND'],      // 模组 GND
  ['U1', '19', 'GND'],     // 模组 EP（散热焊盘，必须接地）

  // ---- 复位（EN）----
  ['R1', '1', '3V3'],
  ['R1', '2', 'EN'],
  ['C5', '1', 'EN'],
  ['C5', '2', 'GND'],
  ['U1', '2', 'EN'],       // 模组 EN

  // ---- 状态 LED ----
  ['R2', '1', '3V3'],
  ['R2', '2', 'LED_A'],
  ['D1', '1', 'LED_A'],    // 阳极
  ['D1', '2', 'GND'],      // 阴极
  ['U1', '7', 'LED_A'],    // IO8 驱动

  // ---- 串口调试口（UART0：TXD=12, RXD=11）----
  ['U1', '12', 'TXD'],     // 模组 TXD
  ['U1', '11', 'RXD'],     // 模组 RXD
  ['H1', '1', '5V'],
  ['H1', '2', 'GND'],
  ['H1', '3', '3V3'],
  ['H1', '4', 'TXD'],
  ['H1', '5', 'RXD'],
  ['H1', '6', 'EN'],

  // ---- 启动模式（IO9 = BOOT，上拉保证正常启动）----
  ['U1', '8', 'BOOT'],     // IO9
  ['R3', '1', '3V3'],
  ['R3', '2', 'BOOT'],
  ['C6', '1', 'BOOT'],
  ['C6', '2', 'GND'],
];

const design = {
  name: 'ESP32C3_Minimal',
  friendly: 'ESP32-C3 最小系统板',
  _idea: 'ESP32-C3 最小系统：3.3V LDO 供电、EN 复位 RC、BOOT 上拉、状态 LED、UART 调试排针',
  _compiledBy: 'manual-with-verified-pins',
  _complexity: 'ESP32 模组系统',
  boardWidthMil: 1600,
  boardHeightMil: 1300,
  components,
  connections,
};

const out = path.join(__dirname, '..', 'designs', 'd10-esp32c3.json');
fs.writeFileSync(out, JSON.stringify(design, null, 2), 'utf8');
console.log('已生成:', out);
console.log('器件:', components.length, '连接:', connections.length);

// 自检：每个网络至少 2 个点
const byNet = {};
for (const [des, pin, net] of connections) {
  (byNet[net] = byNet[net] || []).push(des + '.' + pin);
}
const single = Object.entries(byNet).filter(([, v]) => v.length < 2);
if (single.length) {
  console.log('!! 单点网络:', JSON.stringify(single));
  process.exit(1);
}
const desSet = new Set(components.map((c) => c.des));
const unknown = connections.filter((c) => !desSet.has(c[0]));
if (unknown.length) {
  console.log('!! 引用了不存在的位号:', JSON.stringify(unknown));
  process.exit(1);
}
if (!byNet['GND'] || byNet['GND'].length < 2) { console.log('!! 缺 GND'); process.exit(1); }
console.log('自检通过:', Object.keys(byNet).length, '个网络，全部 ≥2 点');
console.log('网络:', Object.keys(byNet).join(', '));
