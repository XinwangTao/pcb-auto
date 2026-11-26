// ============================================================
// 完整电路网表定义（AI 自主设计）
// USB-C 5V 输入 -> AMS1117-3.3 LDO -> 3V3 输出 -> LED 指示灯
// ============================================================
// 设计理由：
//  - 这是最小可验证的完整电源板，有输入/输出/指示，能验证 DRC/Gerber 全链路
//  - 全部 Basic Part，嘉立创免费贴片
//  - 双层板 0.2/0.2mm 常规工艺，成本最低

export const DESIGN = {
  name: 'USB-C_5V_to_3V3_LDO_LED',
  nets: {
    VBUS:  'USB 5V 输入',
    GND:   '地',
    V3V3:  '3.3V 输出',
    LED_A: 'LED 阳极',
    LED_K: 'LED 阴极',
  },
  // 器件清单（位号 -> 选料 key）
  components: [
    { des: 'J1', part: 'USB_C_16P',  note: 'USB-C 母座 16P，VBUS/GND 供电' },
    { des: 'C1', part: 'C_10uF_0805', note: 'VBUS 输入去耦' },
    { des: 'U1', part: 'LDO_3V3',    note: 'AMS1117-3.3' },
    { des: 'C2', part: 'C_10uF_0805', note: '3V3 输出去耦' },
    { des: 'C3', part: 'C_100nF_0402', note: '高频去耦' },
    { des: 'R1', part: 'R_1k_0402',  note: 'LED 限流' },
    { des: 'D1', part: 'LED_0805_G', note: '电源指示灯' },
    { des: 'R2', part: 'R_5k1_0402', note: 'USB-C CC 下拉（5.1k）' },
    { des: 'R3', part: 'R_5k1_0402', note: 'USB-C CC 下拉（5.1k）' },
  ],
  // 连接关系（引脚名必须与真实符号匹配，脚本会自动校验）
  connections: [
    // USB-C 供电
    ['J1', 'VBUS', 'VBUS'], ['J1', 'GND', 'GND'],
    ['C1', '1', 'VBUS'],    ['C1', '2', 'GND'],
    // LDO
    ['U1', 'VIN', 'VBUS'],  ['U1', 'GND', 'GND'], ['U1', 'VOUT', 'V3V3'],
    ['C2', '1', 'V3V3'],    ['C2', '2', 'GND'],
    ['C3', '1', 'V3V3'],    ['C3', '2', 'GND'],
    // LED 指示：V3V3 -> R1 -> LED -> GND
    ['R1', '1', 'V3V3'],    ['R1', '2', 'LED_A'],
    ['D1', '+', 'LED_A'],   ['D1', '-', 'GND'],
    // USB-C CC 下拉
    ['R2', '1', 'GND'], ['R3', '1', 'GND'],
  ],
};
