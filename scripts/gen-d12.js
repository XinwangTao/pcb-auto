// 生成 designs/d12-usbc-typec.json —— USB Type-C 供电 + ESD 保护 + LDO
// 引脚依据实测：
//   C165948 TYPE-C-31-M-12（16 脚）：VBUS=A4B9/B4A9, GND=A1B12/B1A12,
//     CC1=A5, CC2=B5, DP1=A6, DN1=A7, DP2=B6, DN2=B7, SBU1=A8, SBU2=B8
//   C7519 USBLC6-2SC6（6 脚 ESD 阵列）：1/2/3 左，4/5/6 右
//   C6186 AMS1117-3.3：1=GND 2=VO 3=VI
const fs = require('fs');
const path = require('path');

const components = [
  // USB-C 母座（16P 卧贴）
  { des: 'J1', lcsc: 'C165948', value: 'TYPE-C-16P' },
  // ESD 保护阵列（USB D+/D- 各一对）
  { des: 'U1', lcsc: 'C7519', value: 'USBLC6-2SC6' },
  // 3.3V LDO
  { des: 'U2', lcsc: 'C6186', value: 'AMS1117-3.3' },
  // CC1/CC2 下拉 5.1k（Type-C 从设备标识，必须成对）
  { des: 'R1', lcsc: 'C25905', value: '5.1k' },
  { des: 'R2', lcsc: 'C25905', value: '5.1k' },
  // 输入/输出电容
  { des: 'C1', lcsc: 'C440198', value: '10uF' },
  { des: 'C2', lcsc: 'C440198', value: '10uF' },
  { des: 'C3', lcsc: 'C14663', value: '100nF' },
  { des: 'C4', lcsc: 'C14663', value: '100nF' },
  // 电源指示 LED
  { des: 'R3', lcsc: 'C11702', value: '1k' },
  { des: 'D1', lcsc: 'C2297', value: 'LED-Green' },
  // 输出排针
  { des: 'H1', lcsc: 'C9900192758', value: '2.54-1*6' },
];

const connections = [
  // ---- USB-C 供电（两个 VBUS 引脚都要接，否则载流不足）----
  ['J1', 'A4B9', 'VBUS'],
  ['J1', 'B4A9', 'VBUS'],
  ['J1', 'A1B12', 'GND'],
  ['J1', 'B1A12', 'GND'],
  // 外壳接地（4 个 EH 脚）
  ['J1', '1', 'GND'],
  ['J1', '2', 'GND'],
  ['J1', '3', 'GND'],
  ['J1', '4', 'GND'],

  // ---- CC 下拉（Type-C 设备端标识：5.1k 到 GND）----
  ['J1', 'A5', 'CC1'],
  ['R1', '1', 'CC1'],
  ['R1', '2', 'GND'],
  ['J1', 'B5', 'CC2'],
  ['R2', '1', 'CC2'],
  ['R2', '2', 'GND'],

  // ---- USB 数据线经 ESD 阵列 ----
  // USBLC6 是串联型：1/3 为线路侧，6/4 为连接器侧，2/5 接 GND/VBUS
  ['J1', 'A6', 'USB_DP_CONN'],
  ['J1', 'B6', 'USB_DP_CONN'],
  ['U1', '6', 'USB_DP_CONN'],
  ['U1', '1', 'USB_DP'],
  ['J1', 'A7', 'USB_DN_CONN'],
  ['J1', 'B7', 'USB_DN_CONN'],
  ['U1', '4', 'USB_DN_CONN'],
  ['U1', '3', 'USB_DN'],

  // ---- 电源输入侧 ----
  ['C1', '1', 'VBUS'],
  ['C1', '2', 'GND'],
  ['C3', '1', 'VBUS'],
  ['C3', '2', 'GND'],
  ['U2', '3', 'VBUS'],      // AMS1117 VI
  ['U2', '1', 'GND'],
  ['U2', '2', '3V3'],       // AMS1117 VO
  ['C2', '1', '3V3'],
  ['C2', '2', 'GND'],
  ['C4', '1', '3V3'],
  ['C4', '2', 'GND'],
  // USBLC6 的电源脚（2=GND, 5=VBUS）——钳位基准
  ['U1', '2', 'GND'],
  ['U1', '5', 'VBUS'],

  // ---- 电源指示 ----
  ['R3', '1', '3V3'],
  ['R3', '2', 'LED_A'],
  ['D1', '1', 'LED_A'],
  ['D1', '2', 'GND'],

  // ---- 输出排针 ----
  ['H1', '1', 'VBUS'],
  ['H1', '2', 'GND'],
  ['H1', '3', '3V3'],
  ['H1', '4', 'USB_DP'],
  ['H1', '5', 'USB_DN'],
  ['H1', '6', 'GND'],
];

const design = {
  name: 'USBC_Power_ESD',
  friendly: 'USB Type-C 供电与 ESD 保护板',
  _idea: 'USB Type-C 输入：双 VBUS 载流、CC1/CC2 5.1k 下拉做设备标识、USBLC6 ESD 阵列保护 D+/D-、AMS1117 转 3.3V、电源指示 LED、输出排针',
  _compiledBy: 'manual-with-verified-pins',
  _complexity: '接口防护',
  boardWidthMil: 1500,
  boardHeightMil: 1200,
  components,
  connections,
};

const out = path.join(__dirname, '..', 'designs', 'd12-usbc-typec.json');
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
