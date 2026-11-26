#!/usr/bin/env node
/**
 * idea2design.js —— 把一句自然语言想法编译成可跑通的 design JSON。
 *
 * 这不是"随便生成"，而是基于本仓库已实测通过的设计配方（d1–d6）做模式匹配 + 参数填充：
 *   配方来源：designs/d2（传感器模块）、d3（传感器+LDO+LED）、d4（+排针）、d6（RP2040 系统）
 *   器件来源：designs/_catalog.json（每条都经 lib_Device.getByLcscIds 实际校验存在）
 *
 * 用法：
 *   node scripts/idea2design.js "做一个 SHT30 温湿度传感器模块，带电源指示 LED，用排针引出"
 *   node scripts/idea2design.js "..." -o designs/d7-xxx.json
 *   node scripts/idea2design.js "..." --dry     只打印不落盘
 *
 * 退出码：0 成功编译；1 无法识别（缺器件/无匹配配方）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, 'designs/_catalog.json'), 'utf8'));

// ---------- 关键词 -> 器件映射 ----------
// 顺序敏感：先匹配更具体的词，避免 "10uF" 被 "电容" 抢先。
const KEYWORDS = [
  { re: /温湿度|sht30|温湿/i, lcsc: 'C86346' },
  { re: /rp2040|树莓派|pico/i, lcsc: 'C2040' },
  { re: /flash|w25q|存储|闪存/i, lcsc: 'C131025' },
  { re: /ldo|稳压|3\.3\s*v|3v3/i, lcsc: 'C6186' },
  { re: /led|指示灯|发光|状态灯|.*灯|跑马/i, lcsc: 'C2297' },
  { re: /10\s*uf/i, lcsc: 'C440198' },
  { re: /100\s*nf|0\.1\s*uf|去耦/i, lcsc: 'C14663' },
  // 目录里**只有**两种电阻：C11702=1kΩ、C25905=5.1kΩ（都是已核实的真实料号）。
  // 所以匹配规则必须按"电气上正确"来分，不能凭 `1k` 字样：
  // 上拉/分压/PROG 这类用 5.1k——1k 会把 I2C 上拉电流推到 3.3mA（超标准模式 3mA），
  // 用在 TP4056 的 PROG 上更是直接 1.2A，超过芯片 1A 额定。
  { re: /5\.1\s*k|usb.?c|cc\s*下拉|上拉|分压|prog|4\.7\s*k/i, lcsc: 'C25905' },
  // (?<![\d.]) 是必需的，不是保险：`5.1k` 里含有 `1k` 子串。
  // 没有这个否定后行断言时，用户说"用 5.1k 上拉"会被判成"还点名了 1k 电阻"，
  // 于是被"想法点名但配方装不上"那道闸误报成漏装器件（实测触发过：
  // 想法"…用 5.1k 上拉，带 TVS…"报出 C11702(电阻 1k)，而用户从没要 1k）。
  { re: /(?<![\d.])1\s*k|限流|电阻|阻值/i, lcsc: 'C11702' },
  { re: /22\s*p|22\s*针/i, lcsc: 'C20610231' },
  { re: /排针|排插|连接器|header|引出/i, lcsc: 'C9900192758' },
  { re: /tvs|esd|防静电|保护/i, lcsc: 'C2827625' },
  { re: /红外|ir\b/i, lcsc: 'C2843303' },
  // 「充电」单独也要认：目录里 TP4056 的 tags 早就写了 太阳能/光伏/mppt，
  // 而这里原来只认「充电管理」，于是「太阳能充电的温湿度记录仪」只命中二极管、
  // 不命中充电 IC，配方把二极管串到不存在的充电入口上 → 网表出现悬空网络。
  // 实测 2026-11-26 04:xx：该想法被 finish() 的单脚网络护栏拦住，报"5V 只连了 D1.1"。
  { re: /充电|锂电|电池|charg|tp4056|lipo|li-ion/i, lcsc: 'C16581' },
  { re: /oled|显示屏|屏幕|显示/i, lcsc: 'C5248080' },
  { re: /太阳能|光伏|solar|防反接|肖特基|二极管/i, lcsc: 'C191023' },
  { re: /电池座|电池接口|锂电接口|battery.?holder/i, lcsc: 'C131337' },
];

const byLcsc = new Map(CATALOG.parts.map((p) => [p.lcsc, p]));
const part = (lcsc) => byLcsc.get(lcsc);
const has = (idea, re) => re.test(idea);

// ---------- 需求覆盖审计 ----------
// 血的教训：想法里写"太阳能充电 + 锂电池充电管理 + OLED 显示"，但目录里
// 没有这三类器件，编译器只认出"温湿度"就出了块只有 SHT30 的板子，
// 还照样报「通过 True / DRC 0 违规」。**全绿但做的不是用户要的东西**，
// 比直接失败危险得多——用户会拿着这块板去打样。
// 所以：每个"功能词"必须有对应器件，认不出就明确报错并列出缺口。
const FEATURES = [
  { re: /太阳能|光伏|solar/i,                    need: '太阳能充电管理', why: '需 MPPT/充电管理 IC + 电感 + 二极管' },
  { re: /锂电|电池|充电管理|charg|tp4056/i,      need: '锂电池充电管理', why: '需 TP4056 类充电 IC + 状态灯 + 保护电阻' },
  { re: /oled|显示屏|屏幕|lcd|显示/i,            need: '显示屏',         why: '需 OLED/LCD 模组（I2C 或 SPI 接口）' },
  { re: /蓝牙|ble|无线|wifi|wi-fi|2\.4g|射频/i,   need: '无线通信',       why: '需 ESP32/BLE 模组或射频前端' },
  { re: /电机|马达|motor|舵机|驱动/i,            need: '电机驱动',       why: '需 H 桥/驱动 IC + 续流二极管' },
  { re: /继电器|relay/i,                        need: '继电器',         why: '需继电器 + 驱动三极管 + 续流二极管' },
  { re: /蜂鸣|buzzer|喇叭|扬声器|音频/i,          need: '发声器件',       why: '需蜂鸣器/功放 + 驱动管' },
  { re: /按键|按钮|button|开关|拨码/i,            need: '按键输入',       why: '需轻触按键 + 上拉/去抖电容' },
  { re: /存储卡|sd\s*卡|tf\s*卡|flash\s*卡/i,    need: '存储卡槽',       why: '需 microSD 卡座 + 上拉电阻' },
  { re: /can\b|rs485|rs232|串口转|uart\s*转/i,    need: '工业总线收发',   why: '需 CAN/RS485 收发器 + 终端电阻' },
  { re: /dc-?dc|升降压|boost|buck|电源模块/i,     need: 'DC-DC 变换',     why: '需 DC-DC IC + 电感 + 反馈电阻' },
  { re: /eeprom|存储芯片|非易失/i,               need: 'EEPROM',        why: '需 EEPROM 芯片（I2C/SPI）' },
  { re: /rtc|实时时钟|时钟芯片/i,                need: 'RTC',           why: '需 RTC 芯片 + 32.768kHz 晶振 + 备电' },
  { re: /晶振|振荡器|crystal|时钟源/i,            need: '晶振',           why: '需晶体 + 匹配电容' },
];

// 该功能词是否已被目录里的某个器件覆盖
function featureCovered(f, picked) {
  const parts = [...picked].map((l) => byLcsc.get(l)).filter(Boolean);
  return parts.some((p) => (p.tags || []).some((t) => f.re.test(t)));
}

function auditCoverage(idea, picked) {
  const missing = [];
  for (const f of FEATURES) {
    if (!f.re.test(idea)) continue;
    if (!featureCovered(f, picked)) missing.push({ feature: f.need, why: f.why });
  }
  return missing;
}

// 想法里"点名"到的器件（KEYWORDS 命中的料号集合）。
// 单一真源：compile() 用它决定配方开关，main 用它核对"板上到底装了没"。
// 两处各写一遍 KEYWORDS 循环就是两个缺陷点，改一处漏一处。
function matchedParts(idea) {
  const s = new Set();
  for (const k of KEYWORDS) if (has(idea, k.re)) s.add(k.lcsc);
  // 【别名归一】「22P 排针」同时命中 `/22\s*p/`(C20610231) 和 `/排针|引出/`(C9900192758)，
  // 两个都进结果；配方只装 22P，于是命令行层「点名却没装」那道闸把 C9900192758 报成漏装，
  // 任何写了"22P 排针"的想法都编不出来（实测 2026-11-26 04:05）。
  // 22P 排针本身就是排针，装 22P 已经满足"要排针"，所以从需求集里去掉泛称那条。
  // 归一必须放在这里而不是 compile() 里：那道闸自己又调了一遍 matchedParts，
  // 在 compile() 里归一管不到它（实测第一次改完 #10 的报错一字未变）。
  // 只对这一对归一，不推广：其它同义词对是两件不同器件，谁都不能顶替谁。
  if (s.has('C20610231')) s.delete('C9900192758');
  // 【纯电阻分压】想法明说"纯电阻/电阻分压/不要 LDO"时，把 C6186 从命中集里去掉。
  // 关键词 `转 3.3V` 同时映射到 LDO，于是"做一个纯电阻分压电路，5V 转 3.3V"
  // 会被要求装一颗 AMS1117 —— 与用户明确说的"纯电阻"相反，且命令行层那道闸
  // 会因 C6186 未装而拒绝**所有**这类想法（实测 #11，改前改后都拒绝）。
  // 归一只能放在这里：那道闸自己会重算一遍 matchedParts。
  if (/纯电阻|电阻分压|不用\s*ldo|不要\s*ldo/i.test(idea)) s.delete('C6186');
  return s;
}

// ---------- 充电 / 显示 装配块 ----------
// 两个配方（传感器、RP2040）都要用，抽出来避免复制粘贴走样。
function addCharger(addPart, connections, supplyNet, noConnect) {
  // TP4056 实测引脚：1=TEMP 2=PROG 3=GND 4=VCC 5=BAT 6=STDBY# 7=CHRG# 8=CE 9=EP
  const U = addPart('C16581', 'TP4056');
  connections.push(
    [U, '4', supplyNet],       // VCC 自 5V 取电
    [U, '3', 'GND'],
    [U, '9', 'GND'],           // EP 散热焊盘必须接地
    [U, '8', supplyNet],       // CE 拉高使能充电
    [U, '1', 'GND'],           // TEMP 接地=屏蔽温度检测（否则悬空会停充）
    [U, '5', 'VBAT'],
  );
  // PROG 电阻定充电电流：I = 1200/R_PROG(mA)。
  // 目录里没有 1.2k，只有 1k 和 5.1k。用 1k 会得到 1.2A，**超过 TP4056 的 1A 额定**；
  // 所以取 5.1k → 约 235mA，虽慢但绝对在规格内（慢充对无人值守的太阳能/电池板无影响）。
  const Rp = addPart('C25905', '5.1k');
  connections.push([Rp, '1', 'PROG'], [Rp, '2', 'GND'], [U, '2', 'PROG']);
  // 电池座
  const H = addPart('C131337', 'BATT-2P');
  connections.push([H, '1', 'VBAT'], [H, '2', 'GND']);
  // 充电状态灯：CHRG# 拉低点亮
  const Rc = addPart('C11702', '1k');
  const Dc = addPart('C2297', 'LED-Red');
  connections.push([Rc, '1', supplyNet], [Rc, '2', 'CHRG_A'], [Dc, '1', 'CHRG_A'], [Dc, '2', 'CHRG']);
  connections.push([U, '7', 'CHRG']);
  // STDBY# 是开漏状态输出，本配方只用 CHRG# 一路指示，另一路确实不用。
  // 不用就必须显式写进 noConnect，否则静态审计分不清「忘了接」和「有意不接」。
  if (noConnect) noConnect.push(`${U}.STDBY`);
  return U;
}

function addOled(addPart, connections, supplyNet) {
  // OLED 实测引脚：1=GND 2=VCC 3=SCL 4=SDA
  const DS = addPart('C5248080', 'OLED-0.96');
  connections.push(
    [DS, '1', 'GND'], [DS, '2', supplyNet],
    [DS, '3', 'SCL'], [DS, '4', 'SDA'],
  );
  const C = addPart('C14663', '100nF');
  connections.push([C, '1', supplyNet], [C, '2', 'GND']);
  return DS;
}



// 位号分配：按目录里的 designator 前缀递增
function makeAllocator() {
  const used = {};
  return (prefix) => {
    used[prefix] = (used[prefix] || 0) + 1;
    return `${prefix}${used[prefix]}`;
  };
}

function compile(idea, opts) {
  const allowPartial = !!(opts && opts.allowPartial);
  const warnings = [];
  const picked = matchedParts(idea);

  if (picked.size === 0) {
    // 先看是不是"有功能需求但目录里一个都没有"，那样报缺口比报"认不出器件"有用得多
    const missAll = FEATURES.filter((f) => f.re.test(idea));
    if (missAll.length > 0) {
      return {
        ok: false,
        reason:
          '想法里的功能在器件目录里一个都没有对应器件：\n' +
          missAll.map((m) => `  ✗ ${m.need} —— ${m.why}`).join('\n') +
          '\n\n请在 designs/_catalog.json 增补器件，或改写想法。',
        missing: missAll.map((m) => ({ feature: m.need, why: m.why })),
      };
    }
    return { ok: false, reason: '想法里认不出任何已核实器件，无法编译。请在 _catalog.json 增补器件或改写想法。' };
  }

  // 需求覆盖审计：认不出的功能必须拦下，绝不允许"少做了功能还报全绿"
  const missing = auditCoverage(idea, picked);
  if (missing.length > 0 && !allowPartial) {
    return {
      ok: false,
      reason:
        '想法里有 ' + missing.length + ' 项需求在器件目录中没有对应器件，' +
        '拒绝生成（否则会做出一块缺少这些功能的板子却照样报通过）：\n' +
        missing.map((m) => `  ✗ ${m.feature} —— ${m.why}`).join('\n') +
        '\n\n解决方式（任选）：\n' +
        '  1) 在 designs/_catalog.json 增补上述器件（需含 lcsc/package/pins/tags），再重跑；\n' +
        '  2) 改写想法，去掉这些功能；\n' +
        '  3) 加 --allow-partial 明确接受"只做已覆盖的功能"。',
      missing,
    };
  }
  if (missing.length > 0) {
    for (const m of missing) warnings.push(`已跳过未覆盖功能（--allow-partial）：${m.feature}`);
  }

  // ---------- 决定配方级别 ----------
  const wanted = new Set(picked);
  const isMcu = wanted.has('C2040');
  const isSensor = wanted.has('C86346');
  const wantsLdo = wanted.has('C6186');
  const wantsLed = wanted.has('C2297');
  const wantsHeader = wanted.has('C9900192758') || wanted.has('C20610231');
  // 新增能力（引脚均已用 lib_Symbol.getGeometry 实测，不是猜的）
  const wantsCharger = wanted.has('C16581');   // TP4056 锂电充电
  const wantsOled = wanted.has('C5248080');    // 0.96" I2C OLED
  const wantsDiode = wanted.has('C191023');    // 1N5819WS 肖特基（太阳能防反接/续流）
  const wantsBattConn = wanted.has('C131337'); // 2P 电池座
  // Flash 默认必带（RP2040 无内置 Flash，不挂 Flash 无法启动）；用户点名 W25Q 时也算
  const wantsFlash = true;

  // 连接器口径：想过"22P"就优先长排针
  const headerLcsc = wanted.has('C20610231') ? 'C20610231' : (wanted.has('C9900192758') ? 'C9900192758' : null);
  // 想引出的信号条数决定用几 P
  const headerPins = headerLcsc === 'C20610231' ? 22 : 8;

  const des = makeAllocator();
  const components = [];
  const connections = [];
  // 有意不接的引脚（位号.引脚名）。必须由配方显式登记——绝不在 finish() 里
  // 按"审计没要求"自动补 NC，那等于用 noConnect 掩盖漏连。
  const noConnect = [];
  const addPart = (lcsc, value, designatorOverride) => {
    const p = part(lcsc);
    if (!p) throw new Error(`catalog 缺 ${lcsc}`);
    const d = designatorOverride || des(p.designator);
    components.push({ des: d, lcsc, value: value || p.name });
    if (!p.trusted) warnings.push(`${d}=${lcsc} 是社区上传件（无原厂/datasheet），下单前需人工复核`);
    return d;
  };

  // ---------- RP2040 系统配方 ----------
  if (isMcu) {
    const U1 = addPart('C2040', 'RP2040');
    const p = part('C2040');
    for (const n of p.pins.IOVDD) connections.push([U1, n, '3V3']);
    for (const n of p.pins.DVDD) connections.push([U1, n, '1V1']);
    connections.push([U1, p.pins.VREG_VOUT, '1V1']);
    connections.push([U1, p.pins.VREG_IN, '3V3']);
    connections.push([U1, p.pins.ADC_AVDD, '3V3']);
    connections.push([U1, p.pins.USB_VDD, '3V3']);
    for (const n of p.pins.GND) connections.push([U1, n, 'GND']);
    for (const k of ['QSPI_SCLK','QSPI_SD0','QSPI_SD1','QSPI_SD2','QSPI_SD3','QSPI_SS','USB_DP','USB_DM','RUN','SWCLK','SWD']) {
      connections.push([U1, p.pins[k], k]);
    }
    // XIN/XOUT：本配方不带晶振，RP2040 可走内部环形振荡器，这两脚确实不用。
    // 但必须显式声明 noConnect，否则静态审计无法区分「忘了接」和「有意不接」。
    noConnect.push(`${U1}.XIN`, `${U1}.XOUT`);

    // QSPI Flash：RP2040 必须外挂 Flash 才能启动，QSPI 六根线必须接到真实器件。
    // 拓扑已由 designs/d7-rp2040-flash.json 实测通过（W25Q16 SOIC-8 引脚映射）。
    if (wantsFlash || true) {
      const UF = addPart('C131025', 'W25Q16JVSSIQ');
      const fmap = [
        [1, 'QSPI_SS'], [2, 'QSPI_SD1'], [3, 'QSPI_SD2'],
        [5, 'QSPI_SD0'], [6, 'QSPI_SCLK'], [7, 'QSPI_SD3'],
      ];
      for (const [fp, net] of fmap) connections.push([UF, String(fp), net]);
      connections.push([UF, '8', '3V3'], [UF, '4', 'GND']);
      // Flash 也需要就近去耦
      const CF = addPart('C14663', '100nF');
      connections.push([CF, '1', '3V3'], [CF, '2', 'GND']);
    }

    // LDO 供电
    if (wantsLdo || true) {
      const U2 = addPart('C6186', 'AMS1117-3.3');
      connections.push([U2, '1', 'GND'], [U2, '2', '3V3'], [U2, '3', '5V']);
      const C1 = addPart('C440198', '10uF');
      connections.push([C1, '1', '5V'], [C1, '2', 'GND']);
      const C2 = addPart('C440198', '10uF');
      connections.push([C2, '1', '3V3'], [C2, '2', 'GND']);
    }
    // 去耦
    for (const net of ['3V3', '3V3', '3V3', '1V1']) {
      const C = addPart('C14663', '100nF');
      connections.push([C, '1', net], [C, '2', 'GND']);
    }
    // USB CC 下拉
    for (const net of ['USB_DP', 'USB_DM']) {
      const R = addPart('C25905', '5.1k');
      connections.push([R, '1', net], [R, '2', 'GND']);
    }
    // 状态 LED
    if (wantsLed) {
      const R = addPart('C11702', '1k');
      const D = addPart('C2297', 'LED-Green');
      connections.push([R, '1', '3V3'], [R, '2', 'LED_A'], [D, '1', 'LED_A'], [D, '2', 'GND']);
    }
    // RP2040 排针不是可选件：RUN/SWCLK/SWD 是烧录口、USB_DP/DM 是数据口，
    // 不引出就等于板子无法调试和使用。所以无条件加，不依赖想法里有没有写"排针"。
    {
      const H = addPart(headerLcsc || 'C9900192758', `${headerPins}P`);
      // QSPI 六根线已经在 RP2040 与 Flash 之间连好，不需要再引到排针；
      // 之前把 QSPI 塞进排针表，8 脚排针接不下就被截断，
      // 导致 RUN/SWCLK/SWD 或 QSPI_* 只连一个引脚，板子烧不进程序。
      const sigs = ['5V', 'GND', '3V3', 'RUN', 'SWCLK', 'SWD', 'USB_DP', 'USB_DM'];
      let pin = 1;
      for (const s of sigs) {
        if (pin > headerPins) break;
        connections.push([H, String(pin++), s]);
      }
      while (pin <= headerPins) connections.push([H, String(pin++), 'GND']);
    }
    return finish(idea, components, connections, warnings,
      { boardWidthMil: 1600, boardHeightMil: 1200, complexity: 'RP2040 系统' }, noConnect);
  }

  // ---------- 纯充电板配方（只有 TP4056 / 电池座，没有传感器和 MCU）----------
  // 之前的坑：想法写"做一块 TP4056 充电板"却落到下面"纯分立"分支，
  // 产出 2 个电阻 + 1 个 LED，TP4056 和电池座一个都没上——用户点名的器件被丢了。
  if (!isSensor && !isMcu && wantsCharger) {
    const chgIn = wantsDiode ? 'VIN_CHG' : '5V';
    if (wantsDiode) {
      const Ds = addPart('C191023', '1N5819WS');
      connections.push([Ds, '2', 'SOLAR_IN'], [Ds, '1', 'VIN_CHG']);
      const Hs = addPart('C131337', 'SOLAR-2P');
      connections.push([Hs, '1', 'SOLAR_IN'], [Hs, '2', 'GND']);
      const Cin = addPart('C440198', '10uF');
      connections.push([Cin, '1', 'SOLAR_IN'], [Cin, '2', 'GND']);
    }
    addCharger(addPart, connections, chgIn, noConnect);
    // 充电输入连接器：**没有它这块板子插不上电**。
    // 旧实现只在 `if (wantsHeader)` 里加排针，而 wantsHeader 是"用户是否点名要
    // 排针/22P"，跟"有没有电源入口"完全无关；且排针信号表里硬编码了 'VIN_CHG'，
    // 而无太阳能二极管时输入网络叫 '5V' —— 两处叠加，编译出的"TP4056 充电板"
    // 的 5V 上只有 {TP4056.VCC, TP4056.CE, 状态灯电阻, 滤波电容}，
    // 每个网络都 ≥2 引脚、静态审计过、DRC 干净、回归判 PASS，但**充不了电**。
    // 有太阳能二极管时 SOLAR_IN 已有 2P 入口，不重复加。
    if (!wantsDiode) {
      const Hin = addPart('C131337', '5V-IN-2P');
      connections.push([Hin, '1', chgIn], [Hin, '2', 'GND']);
    }
    // 输入/输出滤波
    const Cin2 = addPart('C440198', '10uF');
    connections.push([Cin2, '1', chgIn], [Cin2, '2', 'GND']);
    const Cout = addPart('C440198', '10uF');
    connections.push([Cout, '1', 'VBAT'], [Cout, '2', 'GND']);
    // 电池电压引出，便于外部监测
    if (wantsHeader) {
      const H = addPart(headerLcsc, `${headerPins}P`);
      // 用 chgIn 而不是硬编码 'VIN_CHG'：无二极管时输入网络是 '5V'，硬编码会让排针引出错误的网络名
      const sigs = ['VBAT', 'GND', chgIn];
      let pin = 1;
      for (const s of sigs) if (pin <= headerPins) connections.push([H, String(pin++), s]);
      while (pin <= Math.min(headerPins, 4)) connections.push([H, String(pin++), 'GND']);
    }
    return finish(idea, components, connections, warnings,
      { boardWidthMil: 900, boardHeightMil: 700, complexity: '锂电池充电板' }, noConnect);
  }

  // ---------- 纯稳压板配方（只有 LDO + 电容 + 指示灯，无传感器/MCU/充电）----------
  // 在这之前"做一个 5V 转 3.3V 稳压小板"**编译不出来**：sensor/MCU/charger 三个配方
  // 都不匹配，落到纯分立分支，C6186(LDO) 被"点名却没装"那道闸拒绝。
  // 而这恰恰是最基础的一块板。电源入口必须**无条件**给：LDO 只有输入端有电才成立，
  // 而入口只能来自连接器/排针 —— 与纯充电板配方同一个教训。
  // "纯电阻分压 / 降压电阻"要的是**电阻**分压，不是 LDO —— 不能只因为想法里出现
  // "转 3.3V" 就当成稳压板。实测"做一个纯电阻分压电路，5V 转 3.3V"会被稳压配方截走，
  // 产出一块 AMS1117 板，与用户明确要的电阻分压相反（虽然闸门照样会因 C6186 报缺件）。
  const asksDivider = /分压|降压电阻/.test(idea);
  if (!isSensor && !isMcu && !wantsCharger && !wantsOled && wantsLdo && !asksDivider) {
    const U = addPart('C6186', 'AMS1117-3.3');
    const p = part('C6186');
    connections.push([U, p.pins.VIN, '5V'], [U, p.pins.GND, 'GND'],
      [U, p.pins.VOUT, '3V3'], [U, p.pins.TAB, '3V3']);
    // 输入 10uF / 输出 10uF + 100nF。AMS1117 手册要输出至少 22uF 才保证稳定，
    // 这里是最小可用组合 —— 属**已知折中**，不假装是手册推荐值，下单前应加大。
    const Cin = addPart('C440198', '10uF');
    connections.push([Cin, '1', '5V'], [Cin, '2', 'GND']);
    const Cout = addPart('C440198', '10uF');
    connections.push([Cout, '1', '3V3'], [Cout, '2', 'GND']);
    const Cd = addPart('C14663', '100nF');
    connections.push([Cd, '1', '3V3'], [Cd, '2', 'GND']);
    warnings.push('LDO 输出电容按最小可用给（10uF+100nF）；AMS1117 手册建议 ≥22uF');
    const sigs = ['5V', 'GND', '3V3'];
    if (wantsLed) {
      const R = addPart('C11702', '1k');
      const Dp = addPart('C2297', 'LED-Green');
      connections.push([R, '1', '3V3'], [R, '2', 'LED_A'], [Dp, '1', 'LED_A'], [Dp, '2', 'GND']);
      sigs.push('LED_A');
    }
    const needPins = sigs.length;
    const hdrLcsc = needPins > 8 ? 'C20610231' : (headerLcsc || 'C9900192758');
    const hdrPins = hdrLcsc === 'C20610231' ? 22 : 8;
    const H = addPart(hdrLcsc, `${hdrPins}P`);
    let pin = 1;
    for (const s of sigs) { if (pin > hdrPins) break; connections.push([H, String(pin++), s]); }
    while (pin <= hdrPins) connections.push([H, String(pin++), 'GND']);
    return finish(idea, components, connections, warnings,
      { boardWidthMil: 800, boardHeightMil: 600, complexity: '稳压板' }, noConnect);
  }

  // ---------- OLED 底板配方（只有 OLED + 去耦，无传感器/MCU/充电）----------
  // 同样在之前编译不出来：OLED 只被当成"传感器配方的丰富度因子"，
  // 单说"OLED 显示模块底板"会落到纯分立分支，C5248080 被当漏装拒绝。
  if (!isSensor && !isMcu && !wantsCharger && wantsOled) {
    // 要 LDO 就一起上，OLED 从 3V3 取电；否则直接 5V。
    const vcc = wantsLdo ? '3V3' : '5V';
    if (wantsLdo) {
      const U = addPart('C6186', 'AMS1117-3.3');
      const p = part('C6186');
      connections.push([U, p.pins.VIN, '5V'], [U, p.pins.GND, 'GND'],
        [U, p.pins.VOUT, '3V3'], [U, p.pins.TAB, '3V3']);
      const Ci = addPart('C440198', '10uF');
      connections.push([Ci, '1', '5V'], [Ci, '2', 'GND']);
      const Co = addPart('C440198', '10uF');
      connections.push([Co, '1', '3V3'], [Co, '2', 'GND']);
    }
    const DS = addPart('C5248080', 'OLED-0.96');
    const p = part('C5248080');
    connections.push([DS, p.pins.VCC, vcc], [DS, p.pins.GND, 'GND'],
      [DS, p.pins.SCL, 'SCL'], [DS, p.pins.SDA, 'SDA']);
    const Cd = addPart('C14663', '100nF');
    connections.push([Cd, '1', vcc], [Cd, '2', 'GND']);
    // I2C 上拉**不加**：HS96L03W2C03 这类 OLED 是**模组**，板上自带 4.7k 上拉；
    // 底板再并 5.1k 会降到约 2.5k，抬高灌电流。底板只负责引出与去耦。
    warnings.push('I2C 上拉依赖 OLED 模组自带的 4.7k；若换成裸屏需自行补上拉');
    // 去重：vcc==='5V' 时表里会出现两个 5V，白白占掉一个排针脚
    // （实测"OLED 底板 5V 供电"的 5V 网同时挂在 H1.1 和 H1.3 上）。
    const sigs = [...new Set(['5V', 'GND', vcc, 'SCL', 'SDA'])];
    if (wantsLed) {
      const R = addPart('C11702', '1k');
      const Dp = addPart('C2297', 'LED-Green');
      connections.push([R, '1', vcc], [R, '2', 'LED_A'], [Dp, '1', 'LED_A'], [Dp, '2', 'GND']);
      sigs.push('LED_A');
    }
    const needPins = sigs.length;
    const hdrLcsc = needPins > 8 ? 'C20610231' : (headerLcsc || 'C9900192758');
    const hdrPins = hdrLcsc === 'C20610231' ? 22 : 8;
    const H = addPart(hdrLcsc, `${hdrPins}P`);
    let pin = 1;
    for (const s of sigs) { if (pin > hdrPins) break; connections.push([H, String(pin++), s]); }
    while (pin <= hdrPins) connections.push([H, String(pin++), 'GND']);
    return finish(idea, components, connections, warnings,
      { boardWidthMil: 800, boardHeightMil: 600, complexity: 'OLED 底板' }, noConnect);
  }

  // ---------- 传感器模块配方 ----------
  if (isSensor) {
    // 电源域：带充电时系统必须从 VBAT 取电（电池才是真正的电源），
    // 经 LDO 稳到 3V3。之前直接写 supplyNet='VDD' 导致电池只充电不供电，
    // 板子能过 DRC 但放不出电——这是"全绿但不可用"的典型陷阱。
    const sysFromBatt = wantsCharger;
    const supplyNet = (sysFromBatt || wantsLdo) ? '3V3' : 'VDD';

    const U1 = addPart('C86346', 'SHT30');
    const p = part('C86346');
    connections.push([U1, p.pins.VDD, supplyNet], [U1, p.pins.GND, 'GND']);
    // DFN-8 的 EP 是散热焊盘，电气上是 GND：悬空会让 SHT30 不工作（不是"建议"是必需）
    connections.push([U1, p.pins.EP, 'GND']);
    connections.push([U1, p.pins.SDA, 'SDA'], [U1, p.pins.SCL, 'SCL']);

    // I2C 上拉。用 5.1k（C25905，真实料号）：3.3V 下灌电流 0.65mA，
    // 远低于标准模式 3mA 上限；目录里没有 4.7k，过去用 C11702(1k) 会到 3.3mA 超限。
    for (const sig of ['SDA', 'SCL']) {
      const R = addPart('C25905', '5.1k');
      connections.push([R, '1', sig], [R, '2', supplyNet]);
    }
    // 去耦
    const C1 = addPart('C14663', '100nF');
    connections.push([C1, '1', supplyNet], [C1, '2', 'GND']);

    if (wantsLdo || sysFromBatt) {
      // AMS1117-3.3：1=GND 2=VOUT 3=VIN
      const U2 = addPart('C6186', 'AMS1117-3.3');
      const ldoIn = sysFromBatt ? 'VBAT' : '5V';
      connections.push([U2, '1', 'GND'], [U2, '2', '3V3'], [U2, '3', ldoIn]);
      const C2 = addPart('C440198', '10uF');
      const C3 = addPart('C440198', '10uF');
      connections.push([C2, '1', ldoIn], [C2, '2', 'GND'], [C3, '1', '3V3'], [C3, '2', 'GND']);
    }
    if (wantsLed) {
      const R = addPart('C11702', '1k');
      const D = addPart('C2297', 'LED-Green');
      connections.push([R, '1', supplyNet], [R, '2', 'LED_A'], [D, '1', 'LED_A'], [D, '2', 'GND']);
    }
    // 太阳能输入：肖特基防反接 —— 串在充电 IC 的 VCC 入口前，
    // 不是串到系统电源上。太阳能只负责给 TP4056 供电充电，系统电从 VBAT 出。
    let chgSupply = '5V';
    if (wantsCharger) chgSupply = 'VIN_CHG';
    if (wantsDiode) {
      const Ds = addPart('C191023', '1N5819WS');
      // 【落点必须是真实存在的电源入口】旧写法无条件串到 chgSupply，
      // 而 chgSupply 在"没有充电管理"时停在 '5V' —— 那块板上没有任何器件往 5V 供源，
      // 于是 5V 只剩二极管阴极一个引脚（悬空）。实测想法「太阳能充电的温湿度记录仪」。
      // 正确落点：有充电 IC → 充电入口；没有充电 IC 但有 LDO → LDO 的 5V 输入；
      // 两者都没有 → 系统电源网 VDD（此时排针会引出 VDD，二极管就是唯一电源通路）。
      const diodeOut = wantsCharger ? chgSupply : (wantsLdo ? '5V' : 'VDD');
      connections.push([Ds, '2', 'SOLAR_IN'], [Ds, '1', diodeOut]);
      const Cin = addPart('C440198', '10uF');
      connections.push([Cin, '1', 'SOLAR_IN'], [Cin, '2', 'GND']);
      const Hs = addPart('C131337', 'SOLAR-2P');
      connections.push([Hs, '1', 'SOLAR_IN'], [Hs, '2', 'GND']);
    }
    if (wantsCharger) addCharger(addPart, connections, chgSupply, noConnect);
    // 【充电输入必须有板外入口 —— 这条在纯充电配方里早就修过，传感器配方漏了】
    // 实测（2026-11-26 05:2x）：想法「做一个 TP4056 充电的 OLED 便携温湿度记录仪，
    // 5.1k 上拉，带电池座和指示 LED」编译出的板子，VIN_CHG = {U3.4(VCC), U3.8(CE), R5.1}
    // 三个引脚 —— 单脚护栏看不见、DRC 干净，但**没有任何器件往 VIN_CHG 供源**，
    // 这块板插不上电、充不了电。audit-design.js 报「电源网 VIN_CHG 没有能量来源」。
    // 根因：chgSupply 在有充电 IC 时是 'VIN_CHG'，但只有 wantsDiode（太阳能）那条分支
    // 才加输入口（L501 的 SOLAR-2P），排针信号表里也没有 VIN_CHG。
    // 所以"有充电 IC 但没有太阳能"就断路了。照纯充电配方（L350~353）的做法补一个 2P 输入座。
    if (wantsCharger && !wantsDiode) {
      const Hin = addPart('C131337', '5V-IN-2P');
      connections.push([Hin, '1', chgSupply], [Hin, '2', 'GND']);
      warnings.push('充电输入经 ' + Hin + '（C131337，2P）引入 ' + chgSupply + '；无太阳能二极管');
    }
    if (wantsOled) addOled(addPart, connections, supplyNet);

    // 【传感器模块必须能连到板外，连接器不是可选项】
    // 实测缺陷（2026-11-26 04:0x）：想法「带 LDO 稳压和电源指示灯的 SHT30 温湿度模块：
    // 5V 输入 → AMS1117-3.3 → 3.3V 给 SHT30…」不含"排针/引出"，于是这里整块被跳过，
    // 生成了一块**没有任何对外引脚**的板：
    //   5V  = {U2.3(VIN), C2.1}          ← LDO 没有电源来源
    //   SDA = {U1.2, R1.1}、SCL = {U1.3, R2.1}  ← 只连上拉电阻，外部读不到
    // 网表自洽（每网 ≥2 引脚，单脚护栏看不见）、DRC 会过、六道闸门全绿，却完全不能用。
    // 这比"少装一个器件"更隐蔽：网络是完整的，只是**通不到板外**。
    // 同时修 sigs：旧写法在"有 LDO 但没有电池"时把 VBAT 引到排针上，
    // 而那块板根本没有电池网络 ⇒ 只要补上连接器，那个脚立刻变成单脚网络。
    // 只有 sysFromBatt（系统真的从电池取电）才该出现 VBAT。
    {
      const H = addPart(headerLcsc || 'C9900192758', `${headerPins}P`);
      const sigs = sysFromBatt
        ? ['3V3', 'GND', 'VBAT', 'SDA', 'SCL']
        : (wantsLdo ? ['5V', 'GND', '3V3', 'SDA', 'SCL'] : ['VDD', 'GND', 'SDA', 'SCL']);
      let pin = 1;
      for (const s of sigs) if (pin <= headerPins) connections.push([H, String(pin++), s]);
      while (pin <= Math.min(headerPins, 4)) connections.push([H, String(pin++), 'GND']);
    }
    const big = wantsLdo && wantsLed && wantsHeader;
    // 带充电/太阳能/OLED 的板子器件多，给小板框会被自愈反复放大，直接给大一点
    const rich = (wantsCharger ? 1 : 0) + (wantsOled ? 1 : 0) + (wantsDiode ? 1 : 0);
    const bw = rich >= 2 ? 1800 : (big ? 1000 : 800);
    const bh = rich >= 2 ? 1300 : (big ? 800 : 600);
    const cplx = rich >= 2 ? '传感器 + 充电 + 显示' : (wantsLdo ? '传感器 + LDO' : '传感器模块');
    return finish(idea, components, connections, warnings,
      { boardWidthMil: bw, boardHeightMil: bh, complexity: cplx }, noConnect);
  }

  // ---------- 纯分立配方（LED / 电阻 / 排针，无 IC） ----------
  const hasDiscrete = wanted.has('C2297') || wanted.has('C11702') || wanted.has('C25905')
    || wanted.has('C1525') || wanted.has('C14663');
  if (hasDiscrete) {
    // 用户要"几路 LED"就真的给几路（识别"8 路/4 路/N 路"或"流水灯"）
    const ledMatch = idea.match(/(\d{1,2})\s*(?:路|个|只)?\s*(?:led|灯)/i) || idea.match(/(\d{1,2})\s*路/i);
    const ledCount = wantsLed ? Math.min(16, Math.max(1, ledMatch ? parseInt(ledMatch[1], 10) : 1)) : 0;

    // 第一个 LED 的网名，**单一来源**：ledCount===1 时叫 LED_A，否则 LED_A1/A2…
    // 排针必须用同一个表达式取名字。曾经两边各写一份常量，于是 ledCount===1 的板：
    // LED 的网叫 LED_A，排针却硬编码成 LED_A1 ⇒ LED_A1 只挂 H1.3（一根什么都不接的网），
    // 而真正的 LED_A 根本没引到排针 —— 这块板唯一的信号脚是死的，外部无法开关 LED。
    // 实测命中 2 个目录，含 2026-11-26 03:04 那次。它不会让任何闸门变红（网表一致、DRC 为 0）。
    const ledNetName = (i) => (ledCount === 1 ? 'LED_A' : `LED_A${i + 1}`);

    for (let i = 0; i < ledCount; i++) {
      const net = ledNetName(i);
      const R = addPart('C11702', '1k');
      const D = addPart('C2297', 'LED-Green');
      connections.push([R, '1', '5V'], [R, '2', net], [D, '1', net], [D, '2', 'GND']);
    }

    // 分压/限流电阻网络：用户提到分压、转电压、5V 转 3.3V 时给真实电阻分压
    // `限流` **不能**当分压触发词：想法里"每个 LED 串一个 1k 限流电阻"说的是 LED 限流，
    // 与电阻分压毫无关系。实测 8 路 LED 板因此凭空多出 R9+R10+C1 一套分压网络，
    // 还把排针上的一个脚占成了 DIV_MID。真正的分压说法是"分压/降压/基准/转 3.3V"。
    const wantsDivider = /分压|转\s*3\.3|转\s*1\.8|降压电阻|基准/i.test(idea);
    if (wantsDivider) {
      const R1 = addPart('C11702', '1k');
      const R2 = addPart('C25905', '5.1k');
      connections.push(
        [R1, '1', '5V'], [R1, '2', 'DIV_MID'],
        [R2, '1', 'DIV_MID'], [R2, '2', 'GND'],
      );
      // 分压点去耦，实际电路通常都要
      const C = addPart('C14663', '100nF');
      connections.push([C, '1', 'DIV_MID'], [C, '2', 'GND']);
    }

    // 兜底：什么具体功能都没识别出来时，至少给一个可观测的电阻网络，不产空板
    if (components.length === 0) {
      const R1 = addPart('C11702', '1k');
      const R2 = addPart('C25905', '5.1k');
      connections.push([R1, '1', '5V'], [R1, '2', 'MID'], [R2, '1', 'MID'], [R2, '2', 'GND']);
      warnings.push('想法只识别到电阻，已生成通用分压网络');
    }

    // 供电入口：只要板上有电源网，就必须有地方把电接进来。
    // 之前的坑：想法里没写"排针"就不加连接器，8 路 LED 板的 5V 只连了 9 个电阻，
    // 焊好之后无处供电——DRC 全过、审计/回归都能过，但板子是死的。
    const hasPowerNet = connections.some(([, , n]) => /^(5V|3V3|VDD|VCC|VBAT|VIN.*)$/i.test(String(n)));
    if (wantsHeader || hasPowerNet) {
      // 信号脚必须先占位，GND 只能补剩下的空位。
      // 之前的坑：sigs 里只放了 ledNetName(0)，于是"8 路流水灯"只有第 1 路能引出，
      // LED_A2…LED_A8 变成只在 R→LED 之间、2 个引脚的内部网 ——
      // 网表自洽、静态审计过、DRC 干净、回归 PASS，但外部只能开关 1 个灯。
      // 同一类缺陷在 d13 也出现过（3V3/SDA/SCL 通不到任何连接器）。
      const sigs = ['5V', 'GND'];
      for (let i = 0; i < ledCount; i++) sigs.push(ledNetName(i));
      if (wantsDivider) sigs.push('DIV_MID');
      // 目录里只有 8P 与 22P 两种排针：选能容下全部信号的那一种，
      // **不是先截断信号再补 GND**（截断是静默丢功能，而且不会让任何闸门变红）。
      const needPins = sigs.length;
      const hdrLcsc = needPins > 8 ? 'C20610231' : (headerLcsc || 'C9900192758');
      const hdrPins = hdrLcsc === 'C20610231' ? 22 : 8;
      if (needPins > hdrPins) {
        warnings.push(`需要 ${needPins} 个信号脚，但目录里最长的排针只有 ${hdrPins}P，`
          + `${needPins - hdrPins} 个信号引不出来（板子是功能残缺的）`);
      }
      const H = addPart(hdrLcsc, `${hdrPins}P`);
      let pin = 1;
      for (const s of sigs) { if (pin > hdrPins) break; connections.push([H, String(pin++), s]); }
      // 剩余脚接地，避免大面积浮空铜
      while (pin <= hdrPins) connections.push([H, String(pin++), 'GND']);
    }
    const many = components.length > 6;
    return finish(idea, components, connections, warnings,
      { boardWidthMil: many ? 1400 : 800, boardHeightMil: many ? 1000 : 600, complexity: '纯分立' }, noConnect);
  }

  return { ok: false, reason: '识别到器件但无法匹配任何已实测配方。' };
}

function finish(idea, components, connections, warnings, board, noConnect) {
  // ★ TVS 防护修饰：想法明说 TVS / ESD / 防浪涌时，在**输入电源轨**上并一颗 TVS 到地。
  //   动机：C2827625 在 designs\_catalog.json 里，却**没有任何配方会装它** ——
  //   于是「带 ESD 防护」「加个 TVS」这类想法一律被"点名却没装"那道闸拒掉。
  //   放在 finish() 顶部而不是 6 个配方里各改一遍：finish 是所有成功路径的唯一出口，
  //   配方不需要知道这件事；而且下面的单脚网守卫会在这之后再算一遍，
  //   并上去的 TVS 一样受约束（接到不存在的轨 → 立刻报单脚网，不会悄悄漏过）。
  //   只在关键词命中时动作，所以**不含这些词的既有想法输出逐字节不变**（已 A/B 验证）。
  if (/tvs|esd|防浪涌|浪涌|静电|surge/i.test(String(idea || '')) &&
      !components.some((c) => c.lcsc === 'C2827625')) {
    // 电源轨词表**不能自己另抄一份**：第一版手写 ['VBUS','5V','VIN',…]，
    // 结果传感器板的轨叫 VDD —— TVS 没装上，反而触发"点名却没装"那道闸，
    // 把「SHT30 + TVS」直接拒掉（实测）。这里与 audit-design.js 的 PWR_RE 同口径，
    // 先按常见命名优先挑，挑不到再按正则兜底。
    const PWR_LIKE = /^(VDD|VCC|3V3|5V|3\.3V|VBAT|VIN.*|VOUT|AVDD|DVDD|VDDA|VBUS|SOLAR_IN|\d+V\d+|\+.*|.*_VCC)$/i;
    const netNames = [...new Set(connections.map((c) => c[2]))];
    const railPref = ['VBUS', '5V', 'VIN', 'SOLAR_IN', 'VBAT', '3V3'];
    let rail = railPref.find((r) => netNames.includes(r));
    if (!rail) rail = netNames.find((x) => PWR_LIKE.test(x));
    const hasGnd = connections.some((c) => c[2] === 'GND');
    if (!rail || !hasGnd) {
      warnings.push('想法提到 TVS/ESD 防护，但这块板没有可识别的输入电源轨或 GND ⇒ 未装 TVS');
    } else {
      // 位号从现有 D<n> 里推下一个，不依赖配方自己的分配器（finish 拿不到它）。
      let maxD = 0;
      for (const c of components) {
        const m = /^D(\d+)$/.exec(String(c.des));
        if (m) maxD = Math.max(maxD, Number(m[1]));
      }
      const tvsDes = 'D' + (maxD + 1);
      components.push({ des: tvsDes, lcsc: 'C2827625', value: 'TPNSQA6V8AW5T2G' });
      // 引脚号必须是字符串：本文件其它所有 push 都写 String(pin) / 目录里的字符串引脚名。
      // pipeline3.js 的网表比对用 `row.pins[String(pinKey)] ?? row.pins[pinKey]` 兜底，
      // 所以数字字面量不会当场炸，但它让 schema 不一致 —— 实测只有 TVS 这两条是数字。
      connections.push([tvsDes, '1', rail]);
      connections.push([tvsDes, '2', 'GND']);
      warnings.push(tvsDes + ' 是 TVS（C2827625，SOD-523），并 ' + rail + ' 到地做 ESD/浪涌防护');
    }
  }

  const nets = [...new Set(connections.map((c) => c[2]))];

  // ★ 出厂前守卫：只有一个引脚的网络 = 一根什么都不接的导线。
  //   它不是"少连一根"，而是**信号走不到任何地方**：排针上有个脚、
  //   板上却没有第二个器件认这个网，外部无法驱动、也无法测量。
  //   这类缺陷不会让任何闸门变红 —— 网表自洽、DRC 0 违规、产物齐全、六门全绿。
  //   实测：gen-led 的 LED_A1 只挂 H1.3，而真正的 LED_A 没引到排针；
  //   另有 SDA/SCL 各 10 个目录、SWCLK/SWD/RUN 各 1 个目录命中同类。
  //   所以放在 finish() 这个**所有成功路径的唯一出口**上，按网算引脚数。
  //   有意不接的引脚必须走 noConnect 显式登记，不能靠在网里留孤点表达（见下）。
  const pinCount = new Map();
  const pinWho = new Map();
  for (const [des, pin, net] of connections) {
    pinCount.set(net, (pinCount.get(net) || 0) + 1);
    if (!pinWho.has(net)) pinWho.set(net, []);
    pinWho.get(net).push(`${des}.${pin}`);
  }
  const dangling = nets.filter((n) => pinCount.get(n) < 2);
  if (dangling.length > 0) {
    return {
      ok: false,
      reason:
        '生成的网表里有 ' + dangling.length + ' 个网络只连了一个引脚（等于没接）：\n' +
        dangling.map((n) => `  ✗ ${n} —— ${pinWho.get(n).join(', ')}`).join('\n') +
        '\n\n拒绝产出（这种板闸门会全绿但功能不通）。请修配方：' +
        '要么把该网连到第二个引脚，要么用 noConnect 显式声明哪个引脚有意不接。',
    };
  }
  // ★ 板框适配：单排排针长度 = 引脚数 × 100 mil（2.54mm 间距）。
  //   动机：C20610231 是 1X22P = 2200 mil，本编译器最小的板框只有 800 mil 宽。
  //   不拦的话，写"22P 排针"会拿到一块排针伸出板外 1400 mil 的设计，
  //   布线器要么放弃要么绕到板外，最后报一个和"排针太长"毫无关系的 DRC 错。
  //   也绝不"装不下就悄悄换 8P"—— 那正是覆盖闸要防的「点名却没装」。
  //   阈值 1.6×：自愈阶梯是 smart-fit + 1.25× 三连，缺口超过 1.6× 靠放大补不回来，
  //   必须当场拒绝；只超一点则记警告，交给自愈去试。
  const pinSetOf = new Map();
  for (const [des, pin] of connections.map((c) => [c[0], String(c[1])])) {
    if (!pinSetOf.has(des)) pinSetOf.set(des, new Set());
    pinSetOf.get(des).add(pin);
  }
  const headerTooBig = [];
  const headerCramped = [];
  for (const c of components) {
    const meta = part(c.lcsc);
    if (!meta || !/排针|header/i.test(String(meta.role || ''))) continue;
    const used = pinSetOf.has(c.des) ? pinSetOf.get(c.des).size : 0;
    if (!used) continue;
    // 长度取**器件本身的孔位**，不是"接了几根"：C20610231 是 22 孔件，
    // 就算只接 5 个网络，它的塑壳和焊盘也还是 2200 mil 长。
    // 第一版拿 used 算 → 5 脚算出 500 mil，把一块排针伸出板外 1400 mil 的板子放行了（实测 04:09）。
    // 孔位来自料号名（1X22P / 2.54-1*8）：2.54mm 间距 × N = N×100 mil，这是 GB/T 排针命名，
    // 不是猜测；仍待拿真实 footprint 复核，已记入待验清单。
    const nameStr = String(meta.name || '');
    const mh = nameStr.match(/([12])\s*[xX*×]\s*(\d+)\s*[pP]?/);
    const rows = mh ? Number(mh[1]) : 1;
    const holes = mh ? Number(mh[2]) : used;
    const lenMil = Math.ceil(Math.max(holes, used) / rows) * 100;
    const line = c.des + '=' + meta.name + ' 用 ' + used + ' 脚' +
      (rows > 1 ? '（' + rows + ' 排）' : '') + '，长约 ' + lenMil + ' mil，板框 ' +
      board.boardWidthMil + '×' + board.boardHeightMil + ' mil';
    if (lenMil > board.boardWidthMil * 1.6) headerTooBig.push(line);
    else if (lenMil > board.boardWidthMil - 150) headerCramped.push(line);
  }
  if (headerTooBig.length > 0) {
    return {
      ok: false,
      reason:
        '排针物理上装不进板框，拒绝产出：\n' +
        headerTooBig.map((x) => '  ✗ ' + x).join('\n') +
        '\n\n这不是"放大一点就能解决"：缺口超过 1.6×，跑流水线只会拖到超时再报一个看不懂的几何错。' +
        '\n请改用更短的排针（如 8P），或换一个自带更大板框的配方（如 RP2040 系统的 1600 mil）。',
    };
  }
  for (const x of headerCramped) {
    warnings.push('排针接近板框宽度，靠 smart-fit 放大才放得下：' + x);
  }
  // 设计名必须唯一：只按复杂度命名会让所有"纯分立"设计都叫 AI_纯分立，
  // 产物目录同名混淆、独立校验会拿错目录。用复杂度 + 器件构成摘要区分。
  const sig = components
    .map((c) => c.lcsc)
    .sort()
    .join('_');
  let h = 0;
  for (let i = 0; i < sig.length; i++) h = (h * 31 + sig.charCodeAt(i)) | 0;
  const hash = Math.abs(h).toString(36).slice(0, 4);
  const base = board.complexity.replace(/[^\w\u4e00-\u9fa5]/g, '_');
  return {
    ok: true,
    design: {
      name: 'AI_' + base + '_' + components.length + 'p' + hash,
      friendly: 'AI_' + base + '_' + components.length + 'p' + hash,
      _idea: idea,
      _compiledBy: 'idea2design.js',
      _complexity: board.complexity,
      boardWidthMil: board.boardWidthMil,
      boardHeightMil: board.boardHeightMil,
      components,
      connections,
      // 只在真有声明时才写字段，避免空数组噪声
      ...(noConnect && noConnect.length ? { noConnect } : {}),
    },
    stats: { components: components.length, connections: connections.length, nets: nets.length, netsList: nets },
    warnings,
  };
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const idea = argv.find((a) => !a.startsWith('-'));
if (!idea) {
  console.error('用法: node scripts/idea2design.js "<想法>" [-o out.json] [--dry]');
  process.exit(1);
}
const outIdx = argv.indexOf('-o');
const outFile = outIdx >= 0 ? argv[outIdx + 1] : null;
const dry = argv.includes('--dry');
const allowPartial = argv.includes('--allow-partial');

const r = compile(idea, { allowPartial });
if (!r.ok) {
  console.error('编译失败: ' + r.reason);
  process.exit(1);
}

// ★ 「想法点名了、配方却没装上」必须拦下，不能静默丢弃。
//   背景：picked 来自 KEYWORDS 命中 = 想法提到的器件，它驱动各 wants* 开关；
//   但**没有任何开关消费 C2827625(TVS) / C2843303(红外)** —— 命中后直接被丢掉，
//   仍然 exit 0 全绿。原有需求覆盖审计只问"目录里有没有这类器件"，
//   而它判定用的 picked 恰恰就是想法本身 ⇒ 自己证明自己存在，永远查不出来。
//   实测触发：想法"…带 TVS 防静电保护和排针引出"编译出的板上一个 TVS 都没有。
//   这里改问"板上到底装没装"，这是唯一能区分"目录没有"与"有但没放"的判据。
//   放在写盘之前：拒绝时不会产生任何文件。10 个既有真实想法实测丢弃数 = 0，
//   所以这道闸不会退化已有设计。
const placedLcsc = new Set(r.design.components.map((c) => c.lcsc));
// 排针：目录里只有 8P 与 22P 两种，**长度是配方按实际信号数选的**。
// 想法写"排针"时关键词默认指向 8P，配方若因信号多而改选 22P，
// 上一行那种"逐料号比对"会把 8P 报成漏装 —— 明明是同一族、同一间距的连接器，
// 只是长度不同。实测触发：想法"…8 路 LED…用排针引出供电"需要 10 个信号脚，
// 配方换 22P 后被假拒绝。所以对这两种长度做等价，只对这两个料号，不推广。
const HEADER_EQUIV = new Set(['C9900192758', 'C20610231']);
const placedHeader = [...placedLcsc].some((x) => HEADER_EQUIV.has(x));
const placedOk = (l) => placedLcsc.has(l) || (HEADER_EQUIV.has(l) && placedHeader);
const droppedParts = [...matchedParts(idea)].filter((l) => !placedOk(l));
if (droppedParts.length > 0) {
  const nm = droppedParts
    .map((l) => {
      const p = byLcsc.get(l);
      return l + '(' + (p ? p.role || p.name : '不在目录') + ')';
    })
    .join(', ');
  if (!allowPartial) {
    console.error(
      '编译失败: 想法里点名了 ' + droppedParts.length + ' 个器件，但当前配方装不上去：\n  ✗ ' + nm +
        '\n\n拒绝生成（否则会做出一块少了这些器件的板子却照样报通过）。\n' +
        '解决方式（任选）：\n' +
        '  1) 改写想法，去掉这些器件；\n' +
        '  2) 加 --allow-partial 明确接受"这些器件不做"。',
    );
    process.exit(1);
  }
  console.error('[warn] 已跳过想法点名但配方未支持的器件（--allow-partial）：' + nm);
}

for (const w of r.warnings) console.error('[warn] ' + w);

console.log(`想法   : ${idea}`);
console.log(`复杂度 : ${r.design._complexity}`);
console.log(`器件   : ${r.stats.components} 个 / 连接 ${r.stats.connections} 条 / 网络 ${r.stats.nets} 条`);
console.log(`  网络 : ${r.stats.netsList.join(', ')}`);
console.log(`  器件 : ${r.design.components.map((c) => `${c.des}=${c.lcsc}(${c.value})`).join(', ')}`);

if (dry) {
  console.log('\n--- design JSON (dry) ---');
  console.log(JSON.stringify(r.design, null, 2));
} else {
  let target = outFile;
  if (!target) {
    const slug = idea.replace(/[^\w\u4e00-\u9fa5]+/g, '-').slice(0, 30);
    target = path.join(ROOT, 'designs', `gen-${slug}.json`);
  }
  fs.writeFileSync(target, JSON.stringify(r.design, null, 2) + '\n', 'utf8');
  console.log(`\n已写入 : ${target}`);
}
