// 设计静态电气审计：在送去 EDA 跑流水线之前，先用图论查设计本身的电气错误。
//
// 动机：流水线跑一次 90~300 秒，如果设计本身电气就是错的（电池不供电、
// 网络悬空、器件没接地），跑完 DRC 照样可能"通过"——DRC 只查几何，不查电路。
// 这个检查不碰 EDA，毫秒级返回，能挡掉最贵的一类错误。
//
// 检查项：
//   1. 电源网必须能追溯到源件（稳压器/充电IC/电池/连接器）
//   2. 每个网络至少 2 个引脚（半截网络）
//   3. 有电源脚的 IC 必须有地脚
//   4. 引脚号必须在器件真实引脚集合内（防封装映射错）
//   5. 同一器件的同一引脚不能接两个网络
//   6. 重复位号
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const CAT = JSON.parse(fs.readFileSync(path.join(ROOT, 'designs', '_catalog.json'), 'utf8'));
const byLcsc = new Map(CAT.parts.map((p) => [String(p.lcsc), p]));

const GND_RE = /^(GND|AGND|DGND|VSS|GROUND)$/i;
// 电源轨名字。**必须包含核心轨 xVyY（1V1/1V8/2V5）和太阳能入口**，否则这两类轨
// 从来不进检查 —— 旧版只认 VDD/VCC/3V3/5V/VBAT/VIN*/VOUT/AVDD/DVDD，
// 于是 `1V1`（RP2040 内核轨）和 `SOLAR_IN`（充电板唯一能量入口）是**从来没被审过**的。
// 不写 `.*_IN`：那会把 MISO_IN 之类的信号网误当电源轨。
const PWR_RE = /^(VDD|VCC|3V3|5V|VBAT|VIN.*|VOUT|AVDD|DVDD|VBUS|SOLAR_IN|\d+V\d+|\+.*|.*_VCC)$/i;
const SOURCE_ROLE = /稳[压压]|ldo|regulator|充电|charger|电池管理|电[池池]|battery|连接器|connector|排针|header|座/;

function audit(design, label) {
  const fails = [];
  const notes = [];
  const nets = new Map();   // net -> [{des, pin}]
  const pinSeen = new Map(); // `${des}.${pin}` -> net
  const desSet = new Set();

  const comps = design.components || [];
  const conns = design.connections || [];

  for (const c of comps) {
    if (desSet.has(c.des)) fails.push(`重复位号 ${c.des}`);
    desSet.add(c.des);
    // 目录只是"已核实引脚"的子集，不是器件白名单：d10/d11/d12 用了目录外器件
    // 照样能在 EDA 里跑通。降级为备注，避免把"没登记"误判成"器件不存在"。
    if (!byLcsc.has(String(c.lcsc))) notes.push(`${c.des} 的 LCSC ${c.lcsc} 未登记在 _catalog（无法校验引脚，其余检查照常）`);
    // 值↔器件一致性（硬失败）。动机：d2/d3/d4/d13 共 11 处声明 4.7k / 1.2k，
    // 但 lcsc 全是 C11702 = 0402WGF1001TCE = 1kΩ。目录里根本没有 4.7k 可选，
    // 于是"声明 4.7k、买回 1k"，原理图/BOM 与实际板子不一致。
    // 这种错 DRC 永远发现不了（它只看几何），必须在这一层拦。
    // 只比较"能明确解析出阻容值"的标称，避免把 IC 型号误判成冲突。
    const meta = byLcsc.get(String(c.lcsc));
    if (meta && c.value) {
      const actual = String(meta.role || '').match(/([\d.]+\s*[kKmMuµnNpP]?\s*(?:Ω|R|F|H)?)\s*$/);
      const want = String(c.value).trim();
      // 归一化必须与 pipeline3.js 里那份**逐字一致**，否则同一块板子
      // 一处判通过、一处判冲突。这里多覆盖了工程界常用写法：
      //   5.1kΩ->5.1K  4R7->4.7  1k2->1.2K  2n2->2.2NF  10µF->10UF  1R->1
      const norm = (s) => {
        let t = String(s).replace(/µ/g, 'u').toUpperCase().replace(/Ω|OHM/g, '').replace(/\s+/g, '');
        const m = t.match(/^(\d+)([RKMNPV])(\d+)(.*)$/);
        if (m) t = m[1] + '.' + m[3] + m[2] + m[4];
        t = t.replace(/R$/, '');
        return t.replace(/^(\d+(?:\.\d+)?)([NPU])$/, '$1$2F');
      };
      const NOMINAL = /^\d+(\.\d+)?(M|K|U|N|P|F|H|MF|UF|NF|PF|MH|UH)?$/;
      const av = norm(actual ? (actual[1] || '') : '');
      const wv = norm(want);
      if (av && wv && NOMINAL.test(av) && NOMINAL.test(wv) && wv !== av) {
        fails.push(`${c.des} 声明值 ${want} 与器件 ${c.lcsc}(${meta.name}=${meta.role}) 不符 —— 要么换对应 LCSC，要么把声明值改成 ${actual[1].trim()}`);
      }
    }
  }

  for (const t of conns) {
    if (!Array.isArray(t) || t.length !== 3) { fails.push(`连接格式错: ${JSON.stringify(t)}`); continue; }
    const [des, pin, net] = t.map(String);
    if (!desSet.has(des)) { fails.push(`连接引用了不存在的器件 ${des}`); continue; }
    const key = `${des}.${pin}`;
    if (pinSeen.has(key) && pinSeen.get(key) !== net) {
      fails.push(`${key} 同时接到 ${pinSeen.get(key)} 和 ${net}（引脚短路）`);
    }
    pinSeen.set(key, net);
    if (!nets.has(net)) nets.set(net, []);
    nets.get(net).push({ des, pin });
  }

  // 引脚号合法性：对照目录里的真实引脚
  // 注意：目录里引脚值可能是数组（如 C2040 的 IOVDD = ["1","10",...] 表示多个脚同名），
  // 必须展开后再判断，直接 String() 会得到 "1,10,..." 这种串，导致所有引脚都判为不存在。
  const expandPins = (pinsObj) => {
    const out = [];
    for (const v of Object.values(pinsObj || {})) {
      if (Array.isArray(v)) out.push(...v.map(String));
      else if (v !== null && v !== undefined && v !== '') out.push(String(v));
    }
    return out;
  };

  for (const c of comps) {
    const meta = byLcsc.get(String(c.lcsc));
    if (!meta || !meta.pins) continue;
    const valid = new Set(expandPins(meta.pins));
    if (valid.size === 0) continue;
    for (const [key, net] of pinSeen) {
      const dot = key.indexOf('.');
      const des = key.slice(0, dot);
      const pin = key.slice(dot + 1);
      if (des !== c.des) continue;
      if (!valid.has(pin)) {
        fails.push(`${des}(${c.lcsc}) 引脚 ${pin} 不存在，该器件实际引脚: ${[...valid].join(',')}`);
      }
    }
  }

  // 网络完整性
  // 注意：只连 1 个引脚不一定是错误——如果那一个引脚在连接器/排针上，
  // 信号是从外部灌进来的（如 USB_DP 引到调试排针），这是合法端点。
  // 只有落在普通器件（IC/阻容）上的单脚网络才是真的没接完。
  //
  // 【实测教训】这条规则的"连接器豁免"曾是一个 fail-open 漏洞：
  // d1-sht30 的想法是「SHT30 温湿度模块，I2C 四线接口」，但设计里
  // SDA={J1.3}、SCL={J1.4} 各自只有 1 个引脚 —— J1 是排针，于是被判为
  // "外部接入，非错误" 并放行。结果：整块板 DRC 全绿、Gerber 齐全、
  // 六项产物都导出正常，而传感器 SDA/SCL 根本没有去任何地方，板子是废的。
  // 关键结论：**"设计⇄网表一致"只能证明流水线忠实实现了设计，
  // 不能证明设计本身成立。** 必须直接查 IC 引脚悬空。
  const isConnector = (des) => {
    const c = comps.find((x) => x.des === des);
    if (!c) return false;
    const meta = byLcsc.get(String(c.lcsc));
    return !!(meta && /连接器|connector|排针|header|座/.test(String(meta.role || '')));
  };
  for (const [net, pins] of nets) {
    if (pins.length >= 2) continue;
    if (isConnector(pins[0].des)) {
      // 不再无条件放行：单脚网络落在连接器上时，若同名的功能脚在板上 IC 侧
      // 完全悬空，下面「悬空引脚」检查会把它抓出来。这里只留提示。
      notes.push(`网络 ${net} 只引到连接器 ${pins[0].des}.${pins[0].pin}（若无对应 IC 侧连接则为漏连）`);
    } else {
      fails.push(`网络 ${net} 只有 1 个引脚（${pins[0].des}.${pins[0].pin}），半截网络`);
    }
  }

  // 悬空引脚：目录声明过的引脚，要么接入某个网络，要么在设计里显式声明 noConnect。
  // 分类处置：
  //   · 致命类（GND/EP/EPAD/PAD/THERMAL/VSS）悬空 → FAIL。
  //     DFN/QFN 的散热焊盘不接地，SHT30 直接不工作；QFN 的 EP 更是电气必需。
  //   · 建议类（TAB）悬空 → NOTE。SOT-223 的 TAB 电气上等于 VOUT，悬空不影响
  //     出电（输出走 pin2），只丢散热通路，属于该修但不该拦流水线。
  //   · 信号类 → 允许悬空，但必须在 design.noConnect 里写出来。
  //     不写就是"忘了接"，写了才是"有意不用"。沉默与决策必须区分开。
  // 原实现的 `if (allPins.length < 6) continue` 把 SHT30（目录只声明 5 个脚）
  // 整个跳过，d1/d4 的 SDA/SCL 悬空正是从这条缝里漏过去的。
  const FATAL_OPEN = /^(GND|AGND|DGND|VSS|GROUND|EP|EPAD|PAD|THERMAL|EXPOSED)$/i;
  const WARN_OPEN = /^(TAB)$/i;
  const ncRaw = [].concat(design.noConnect || []);
  const ncSet = new Set(ncRaw.map((x) => (typeof x === 'string' ? x : `${x.des}.${x.pin}`)));
  for (const c of comps) {
    const meta = byLcsc.get(String(c.lcsc));
    if (!meta || !meta.pins) continue;
    const named = meta.pins;
    const pinNames = Object.keys(named);
    if (!pinNames.length) continue;
    const usedPins = new Set();
    for (const [key] of pinSeen) {
      const dot = key.indexOf('.');
      if (key.slice(0, dot) === c.des) usedPins.add(key.slice(dot + 1));
    }
    const floatingFatal = [];
    const floatingWarn = [];
    const floatingSig = [];
    for (const nm of pinNames) {
      const v = named[nm];
      const nums = (Array.isArray(v) ? v.map(String) : [String(v)]).filter(Boolean);
      if (!nums.length) continue;
      // 【必须要求"全部"物理脚都连上，不能 any】
      // 旧实现 `nums.some(p => usedPins.has(p))` —— 一个引脚名对应多个物理脚时
      // （C2040 的 IOVDD 就有 6 个：1/10/22/33/42/49），只要其中**任意一个**接上，
      // 整组就被判为已连接，剩下 5 个悬空也不报警。
      // 这正是这道闸门存在的意义所在（"沉默=忘了，声明=决定"），any 等于把闸门开成漏斗。
      const usedHere = nums.filter((p) => usedPins.has(p));
      if (usedHere.length === nums.length) continue;
      const missing = nums.filter((p) => !usedPins.has(p)).join(',');
      const tag = `${nm}(${missing})`;
      if (usedHere.length > 0) {
        // 部分连接是最危险的情况：看起来"接过了"，实际有脚悬空。
        if (FATAL_OPEN.test(nm)) floatingFatal.push(tag + ' 部分悬空');
        else if (!ncSet.has(`${c.des}.${nm}`)) floatingSig.push(tag + ' 部分悬空');
      } else if (FATAL_OPEN.test(nm)) floatingFatal.push(tag);
      else if (WARN_OPEN.test(nm)) floatingWarn.push(tag);
      else if (!ncSet.has(`${c.des}.${nm}`)) floatingSig.push(tag);
    }
    if (floatingFatal.length) {
      fails.push(`${c.des}(${meta.name}) 致命脚悬空: ${floatingFatal.join(' ')} — 地/散热焊盘必须接`);
    }
    if (floatingWarn.length) {
      notes.push(`${c.des}(${meta.name}) ${floatingWarn.join(' ')} 悬空（建议接到 VOUT 以获散热通路）`);
    }
    if (floatingSig.length) {
      // 提示里只能给**裸脚名**：floatingSig 里带 "(49) 部分悬空" 这样的装饰，
      // 直接拼进去会生成 noConnect 里无法识别的字符串。
      const bare = String(floatingSig[0]).split(/[（(]/)[0];
      fails.push(`${c.des}(${meta.name}) 引脚未接且未声明不用: ${floatingSig.join(',')}`
        + ` — 若确实不用，请在设计里加 "noConnect": ["${c.des}.${bare}", ...]`);
    }
  }

  // 电源来源
  // 5V/VDD 从排针或连接器灌进来同样是"有源"——很多小板就是靠外接电源，
  // 不能因为板上没稳压器就判它没电。
  const srcRoleOf = (des) => {
    const c = comps.find((x) => x.des === des);
    if (!c) return '';
    const meta = byLcsc.get(String(c.lcsc));
    return meta ? String(meta.role || '') : '';
  };
  const pwrNets = [...nets.keys()].filter((n) => PWR_RE.test(n) && !GND_RE.test(n));

  // 电源来源：**能量可达性**，不是"网上挂了一颗看起来像电源的器件"。
  //
  // 旧判据 `pins.some(p => SOURCE_ROLE.test(role(p.des)))` 把「变换器」当成「能源」：
  // 只要电源网上挂着一颗 AMS1117 / TP4056 / 电池座就算"有源"。可它连上的往往是
  // 那颗芯片的**输入脚**——是负载，不是源。实测三块板因此全被判 PASS：
  //   d6     5V = {U2.3(AMS1117 VIN), C1.1}            5V 没来源（USB 只引到排针）
  //   d7     5V = {U3.3(VIN), C1.1}                    整板 0 个连接器
  //   TP4056 5V = {U1.4(VCC), U1.8(CE), R2.1, C1.1}    充电口悬空 ⇒ 充不了电
  // 三块板电气都不成立，回归里却都是 PASS —— 因为 DRC 只查几何，而这道闸门当时
  // 只问"网上有没有角色名像电源的器件"，没问"能量到底能不能流到这里"。
  //
  // 正确判据：从**入口**（连接器/排针/座/电池）出发，沿供电器件的**输出脚**传播，
  // 迭代到不动点；只有传播到的网络才算带电。
  //   · 入口件：所有脚都向外供能（所以"5V 从排针灌进来"依然算有源，这是对的）
  //   · 稳压器/充电IC：输入脚 VIN/VI/VCC/VBUS/VREG_IN，输出脚 VOUT/VO/OUT/VREG_VOUT/BAT
  //   · 二极管：A 进 K 出（太阳能防反接就是靠这一条，漏了会把 VIN_CHG 误判成无源）
  //   · 其它登记过的 IC：内部稳压输出（RP2040 的 VREG_VOUT）也算源
  const ENTRY_ROLE = /连接器|connector|排针|header|座|接口|电池|battery/i;
  const DIODE_ROLE = /二极管|diode|肖特基|schottky/i;
  // 【分类顺序是会改变结论的】第一版按 ENTRY → DIODE → CONV 判，结果
  // TP4056（role=「锂电池充电管理 IC」）因为 role 里有「电池」被 ENTRY_ROLE 先抓走，
  // 当成能量入口 ⇒ 它所在的 5V 网直接算带电 ⇒ 那块「充电口悬空」的板子照样 PASS。
  // 所以必须是 **DIODE → 变换器 → 入口**，而且变换器用不含「电池」的专用正则：
  //   「锂电池充电管理 IC」含 充电 ⇒ 变换器
  //   「锂电池接口 2P」不含 充电/稳压 ⇒ 入口（电池座必须算入口，否则 VBAT 会误报）
  const CONV_ROLE = /稳压|ldo|regulator|充电|charger/i;
  const CONV_IN = ['VIN', 'VI', 'VCC', 'VBUS', 'VREG_IN', 'EN', 'CE'];
  const CONV_OUT = ['VOUT', 'VO', 'OUT', 'VREG_VOUT', 'BAT'];
  const up = (s) => String(s || '').toUpperCase();
  const energyOf = (des) => {
    const c = comps.find((x) => x.des === des);
    if (!c) return null;
    const m = byLcsc.get(String(c.lcsc));
    const role = String((m && m.role) || '');
    if (DIODE_ROLE.test(role)) return { kind: 'diode', ins: ['A'], outs: ['K'] };
    if (CONV_ROLE.test(role)) return { kind: 'conv', ins: CONV_IN, outs: CONV_OUT };
    if (ENTRY_ROLE.test(role)) return { kind: 'entry', ins: [], outs: 'ALL' };
    if (m && m.pins) return { kind: 'ic', ins: CONV_IN, outs: CONV_OUT };
    return null;
  };
  const pinNameOf = (des, pin) => {
    const c = comps.find((x) => x.des === des);
    const m = c && byLcsc.get(String(c.lcsc));
    const named = m && m.pins;
    if (!named) return null;
    const want = String(pin);
    for (const [nm, v] of Object.entries(named)) {
      const nums = (Array.isArray(v) ? v.map(String) : [String(v)]);
      if (nums.includes(want)) return nm;
    }
    return null;
  };
  // 入口：连接器/电池所在网络直接带电
  const powered = new Set();
  for (const [net, ps] of nets) {
    for (const p of ps) {
      const e = energyOf(p.des);
      if (e && e.kind === 'entry') { powered.add(net); break; }
    }
  }
  const inNetsOf = (des, ins) => {
    const out = [];
    for (const [net, ps] of nets) {
      for (const q of ps) {
        if (q.des !== des) continue;
        const nm = pinNameOf(q.des, q.pin);
        if (nm && ins.some((k) => up(k) === up(nm))) { out.push(net); break; }
      }
    }
    return out;
  };
  // 不动点传播。轮数上限只是防御自激，正常链长 < 6。
  let chg = true, rnd = 0;
  while (chg && rnd++ < 24) {
    chg = false;
    for (const [net, ps] of nets) {
      if (powered.has(net)) continue;
      for (const p of ps) {
        const e = energyOf(p.des);
        if (!e || e.kind === 'entry') continue;
        const nm = pinNameOf(p.des, p.pin);
        const isOut = e.outs === 'ALL' || (nm && e.outs.some((k) => up(k) === up(nm)));
        if (!isOut) continue;
        const ins = inNetsOf(p.des, e.ins);
        // 供电器自己的输入脚一个都没接 ⇒ 它不可能往外送电（不是"默认算有电"）
        if (!ins.length) continue;
        if (!ins.some((n) => powered.has(n))) continue;
        powered.add(net); chg = true; break;
      }
    }
  }
  for (const net of pwrNets) {
    if (powered.has(net)) continue;
    const members = (nets.get(net) || []).map((p) => {
      const nm = pinNameOf(p.des, p.pin);
      return `${p.des}.${p.pin}${nm ? '(' + nm + ')' : ''}`;
    });
    fails.push(`电源网 ${net} 没有能量来源（既无连接器/电池入口，也无法经稳压器/二极管从别的带电网络得到）`
      + ` — 成员: ${members.join(', ') || '(空)'}`);
  }

  // IC 必须有地
  for (const c of comps) {
    const meta = byLcsc.get(String(c.lcsc));
    if (!meta || !meta.pins) continue;
    const allPins = expandPins(meta.pins);
    if (allPins.length < 6) continue; // 只查多脚 IC
    const prefix = c.des + '.';
    const myNets = [...pinSeen.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    const hasPwr = myNets.some((n) => PWR_RE.test(n));
    const hasGnd = myNets.some((n) => GND_RE.test(n));
    if (hasPwr && !hasGnd) fails.push(`${c.des}(${c.lcsc}) 接了电源但没有地连接`);
  }

  const usedPins = pinSeen.size;
  const orphanComps = comps.filter((c) => ![...pinSeen.keys()].some((k) => k.startsWith(c.des + '.')));
  if (orphanComps.length) notes.push(`悬空器件（一个引脚都没接）: ${orphanComps.map((c) => c.des).join(',')}`);

  return { label, name: design.name || '?', comps: comps.length, conns: conns.length, nets: nets.size, usedPins, fails, notes };
}

function main() {
  const targets = [];
  const args = process.argv.slice(2);

  if (args.length) {
    for (const a of args) targets.push({ file: a, label: path.basename(a) });
  } else {
    const dir = path.join(ROOT, 'designs');
    for (const f of fs.readdirSync(dir)) {
      if (!/\.json$/.test(f)) continue;
      if (f === '_catalog.json' || f.startsWith('_catalog.bak')) continue;
      targets.push({ file: path.join(dir, f), label: f });
    }
  }

  let totalFails = 0;
  // 【跳过 ≠ 通过】此前解析失败与「components 不是数组」都走 continue，
  // 不计入 totalFails，于是 totalFails===0 → exit 0 → run-all 打印
  // 「静态电气审计通过（引脚合法性 / 网络完整性 / 电源来源 / IC 接地）」，
  // 而实际**一行都没审**。最隐蔽的一条：d.components 不是数组时连输出都没有
  // （不是 [SKIP] 也不是任何提示），run-all 侧按「退出码 + [FAIL] 行数」判，
  // 于是「审计器自己没跑」被读成「审计通过」。
  // Node 的 readFileSync(...,'utf8') 会保留 U+FEFF（PowerShell 的 Get-Content 会剥掉），
  // 所以带 BOM 的设计文件在 PS 侧能解析、在这支审计里 JSON.parse 抛错 —— 不是假想。
  // 修法：跳过必须计入失败并显式打印 [FAIL]，让"没审"在退出码上等价于"不合格"。
  let skipped = 0;
  const rows = [];
  for (const t of targets) {
    let d;
    try {
      // 与 fabcheck.js 的 BOM 处理保持一致（那里专门识别 utf8-bom 并剥掉）
      let txt = fs.readFileSync(t.file, 'utf8');
      if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
      d = JSON.parse(txt);
    } catch (e) {
      skipped++;
      console.log(`[FAIL] ${t.label} 未能审计：解析失败 ${e.message}`);
      continue;
    }
    if (!d || !Array.isArray(d.components)) {
      skipped++;
      const kind = d === null || d === undefined ? String(d)
        : (Array.isArray(d.components) ? 'array' : typeof d.components);
      console.log(`[FAIL] ${t.label} 未能审计：components 不是数组（实为 ${kind}）`);
      continue;
    }
    const r = audit(d, t.label);
    rows.push(r);
    totalFails += r.fails.length;
  }

  console.log('设计静态电气审计');
  console.log('='.repeat(64));
  for (const r of rows) {
    const mark = r.fails.length === 0 ? 'PASS' : 'FAIL';
    console.log(`${mark} ${r.label}  ${r.comps}器件/${r.conns}连接/${r.nets}网络`);
    for (const f of r.fails) console.log(`     [FAIL] ${f}`);
    for (const n of r.notes) console.log(`     [note] ${n}`);
  }
  console.log('='.repeat(64));
  console.log(`合计 ${rows.length} 个设计，${totalFails} 个电气问题，${skipped} 个设计未能审计`);

  // 额外：把想法编译器能产出的设计也扫一遍
  let ideas = [];
  try {
    const t = fs.readFileSync(path.join(ROOT, 'scripts', 'test-idea2design.js'), 'utf8');
    const re = /\{ idea: '([^']+)', want: 0/g;
    let m;
    while ((m = re.exec(t))) ideas.push(m[1]);
  } catch (_) { /* 没测试文件就跳过 */ }

  if (ideas.length && !args.length) {
    const { execFileSync } = require('child_process');
    console.log('\n想法编译产物审计');
    console.log('='.repeat(64));
    let ideaFails = 0;
    for (const idea of ideas) {
      let out;
      try {
        out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'idea2design.js'), idea, '--dry'],
          { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { continue; }
      const idx = out.indexOf('--- design JSON (dry) ---');
      if (idx < 0) continue;
      const jsonTxt = out.slice(idx + '--- design JSON (dry) ---'.length).trim();
      let d;
      try { d = JSON.parse(jsonTxt); } catch (_) { continue; }
      const r = audit(d, idea.slice(0, 30));
      if (r.fails.length) {
        ideaFails += r.fails.length;
        console.log(`FAIL ${idea.slice(0, 34)}…`);
        for (const f of r.fails) console.log(`     [FAIL] ${f}`);
      }
    }
    console.log('='.repeat(64));
    console.log(`想法产物：${ideaFails} 个电气问题`);
    totalFails += ideaFails;
  }

  // skipped > 0 必须判失败：'审计器没跑成' 与 '审计通过' 绝不能同一个退出码
  process.exit((totalFails === 0 && skipped === 0) ? 0 : 1);
}

main();
