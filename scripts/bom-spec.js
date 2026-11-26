// BOM 需求：USB-C 供电 + AMS1117-3.3 + LED 指示板
// 结构：USB-C(5V) -> C1(10uF输入) -> U1(AMS1117-3.3) -> C2(10uF输出) -> C3(100nF)
//       LED 链：3V3 -> R1(1k) -> D1(LED) -> GND
/*
 * 【历史文件】这是早期草稿里的选料表，已被 `designs/*.json` 取代，
 * 当前流水线不引用它（`node test/syntax-gate.mjs` 会告诉你它有没有被引用）。
 * 保留是因为 `out/_build-ledger.md` 里有它的来历；改回 CommonJS 是因为
 * 它曾经在 `scripts\` 下用 `export` —— 那违反 AGENTS.md 第一条禁令，
 * 而且在 CommonJS 目录里 Node 根本加载不了它。
 */
const BOM_SPECS = [
  { key: 'C_10uF_0805',  kw: '10uF 0805',   footprint: '0805', value: '10uF',  minVoltage: 10, descHas: '容值' },
  { key: 'C_100nF_0402', kw: '100nF 0402',  footprint: '0402', value: '100nF', minVoltage: 16, descHas: '容值' },
  { key: 'R_1k_0402',    kw: '1k 0402',     footprint: '0402', value: '1kΩ',   descHas: '电阻' },
  { key: 'R_5k1_0402',   kw: '5.1k 0402',   footprint: '0402', value: '5.1kΩ', descHas: '电阻' },
  { key: 'LDO_3V3',      kw: 'AMS1117-3.3', footprint: 'SOT-223', value: '3.3V' },
  { key: 'LED_0805_R',   kw: 'LED 0805 red', footprint: '0805', descHas: '发光颜色:红色' },
  { key: 'USB_C_16P',    kw: 'USB Type-C 16P', footprint: '', descHas: 'USB' },
];

module.exports = { BOM_SPECS };
