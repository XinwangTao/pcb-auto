# PCB 产物打样可行性独立审计

纯文件分析：Gerber 用 `Expand-Archive` 解到 `%TEMP%\fabaudit` 逐层解析；未开 EDA 会话、未调 lceda-pro.exe。
取样：`out\` 按 mtime 最新 3 个含完整 6 产物的目录（`ESP32C3_Minimal-185851` 为空）。交叉源：`_run.json`（实际板框）、`designs\*.json`（意图）、`Netlist.json` 的 pinInfoMap（还原网络）。

## 1 总结表

| 工程 | Gerber层 | 铜 D01+D03 | BOM行/位号 | PnP跨度 | 网表连通 | 结论 |
|---|---|---|---|---|---|---|
| SHT30_I2C_TempHumidity-185516 | 10 层齐 | 顶514 / 底324 | 3 / 3 | 184×134 mil | 4 网9 脚，SDA·SCL 各 1 脚 | **FAIL** |
| SHT30_Module_Full-185314 | 10 层齐 | 顶570 / 底387 | 4 / 5 | 155×292 mil | 4 网15 脚 | **PASS** |
| AI_传感器___充电___显示-184722 | 10 层齐 | 顶1859 / 底947 | 14 / 19 | 901×1345 mil | 11 网49 脚 | **PASS**(带缺陷) |

## 2 逐设计

### A. SHT30_I2C_TempHumidity-185516 → FAIL
- 铜 494+20 / 315+9，GTO 67 线，距板边 0.358mm；GKO 4 段闭合 25.4×19.05mm = 1000×750mil。**GBO 0 图元**。
- 钻孔 PTH 9（0.305×1、1.0×8），VIA 1 孔与 PTH (13.42,-5.47) 重复 → 唯一 9 孔。
- BOM 3 行/C1,J1,U1，数量 3，无重复、无空位号、无 0 数量、LCSC 齐（U1 Value 空但有 MPN）。PnP 3 行，X 183.9mil × Y 134.4mil，全在板内，无 NaN/全 0。
- 网表 GND4/VDD3/**SDA1/SCL1**，与设计 9 条连接逐脚零差异。
- **FAIL 证据**：`SDA={J1.3}`、`SCL={J1.4}` 仅 1 脚，U1(SHT30 DFN-8) 的 **pin2/pin3 网络为空** → 排针 I2C 在板上无去向，传感器悬空，打样测不到数据。同库 d2/d13 都接了 U1.2/U1.3，可证漏连；`d1-sht30.json` 只写 9 条，"设计⇄网表一致"救不了。
- TestPoints.csv 实为 **xlsx 二进制**（PK 头，3 sheet），Summary 自述 0 测试点/0%。PDF `%PDF-1.4`、6 页、`%%EOF` 完整。

### B. SHT30_Module_Full-185314 → PASS
- 铜 543+27 / 375+12，GTO 117 线，GKO 闭合 25.4×20.32mm = 1000×800mil；GTS 23 闪 = 23 顶面焊盘、GBS 8 = J1 8 插件孔、GTP 11 闪+4 区域 = 15 SMD 焊盘，三层自洽。
- 钻孔 PTH 12 + VIA 4（全与 PTH 重复）。BOM 4 行/5 位号（R1,R2 合并），数量 5，位号集合 = Netlist = 设计。PnP 5 行、155×292mil、板内。网表 GND4/VDD5/SDA3/SCL3 = 设计，无单脚网，U1.2/U1.3/U1.9 已接。
- 非阻断：R1/R2 标 **4.7k** 但 MPN=`0402WGF1001TCE`（1001=**1kΩ**，LCSC C11702）→ 实发 1k（3.3V 下 3.3mA，能用但偏离）；GBO 空层。

### C. AI_传感器___充电___显示-184722 → PASS（带缺陷）
- 铜 1783+76 / 919+28（顶层 2 个 G36 区：主板大面积铺铜 + 29.3~31.4/-10.8~-9.0 一处 24 点独立铜岛）；GTO 599 线；GKO 闭合 57.15×41.275mm = 2250×1625mil。
- 阻焊自洽：GTS 56 = 56 顶面焊盘，GBS 8 = DS1 4+H1 2+H2 2，GTP 32 闪+16 区域 = 48 SMD 焊盘。
- PTH 28（0.305×20、0.9×4、1.05×4）+ VIA 20（全与 PTH 重复）+ NPTH 4×2.5mm；四角安装孔周围铺铜 36~38 点挖空，不碰铜。BOM 14 行/19 位号 = Netlist = 设计；PnP 19 行、901×1345mil、板内。
- 网表 11 网 49 脚 = 设计，无单脚网；SOLAR_IN→D1→VIN_CHG→TP4056→VBAT→AMS1117→3V3 完整，CE 接 VIN、TEMP 接地，符合典型应用。
- **缺陷**：R1/R2 标 4.7k、R4 标 **1.2k**，三者 LCSC 全是 **C11702(1k)** → 实发 1k。R4 为 PROG 电阻，I=1200/R：1.2k→1A，1k→**1.2A**，超 TP4056 典型值，发热/热调节加剧。LED2 标 "LED-Red" 实为 C2297 `KT-0805G`（绿）。U2 TAB(pin4)、U1 EP(pin9) 未接网（TAB 与 VOUT 同电位，可用，散热只剩单脚）。板上无 MCU，记录仪需外部主控经 I2C 读取。

## 3 结论：按当前产物**不能直接下单**

- **P0 阻断**：SHT30_I2C 的 SDA/SCL 未连传感器。补 `d1-sht30.json` 的 `["U1","2","SDA"]`、`["U1","3","SCL"]` 后重跑，否则 PCB+贴片全废。
- **P1 会错件**：电阻值↔LCSC 不符（B 的 4.7k、C 的 4.7k/1.2k 实为 1k）。`designs\_catalog.json` 里没有 4.7k/1.2k 条目，需补真实 LCSC 或改设计值并重算 PROG。
- **P2 格式**：`TestPoints.csv` 是 xlsx 改名；`PnP.csv` 为 UTF-16LE + TAB + 全字段加引号 + 坐标带 "mm"、Layer 仅 `T`，按逗号解析只读到 1 列。
- **P3 干净度**：两份 DRL 过孔重复登记（唯一 9/12/28，声明 10/16/52）；GBO 空层；GDD 画到 X=211~244mm（4 倍板宽，仅影响合层）。

## 4 verify-artifacts.js 漏检 + 可粘检查

它已解析铜层 D01/D03、PnP 跨度与重叠、BOM 位号集合、电气合理性；但三份全判 0 失败，而 A 是废板。漏检：① TestPoints 不校验 ② 钻孔只数文件名不数孔 ③ 元件值↔物料不比对 ④ 板框只要 `d01+d03≥3`，不验闭合 ⑤ 空层不查、丝印阈值 3 太松 ⑥ PDF 只看字节数 ⑦ PnP 单位写死 mm×39.37 且不断言表头列。

粘到 `main()` 输出区之前（同作用域已有 `fails/passes/notes/bom/runDir/boardW/boardH/boardSrc`）：

```js
const os = require('os'), tp = path.join(runDir, 'TestPoints.csv');
if (!fs.existsSync(tp)) fails.push('缺 TestPoints.csv');
else if (fs.readFileSync(tp).subarray(0, 2).toString('hex') === '504b') fails.push('TestPoints.csv 是 xlsx 二进制');
const pb = fs.readFileSync(path.join(runDir, 'Board.pdf'));
if (pb.subarray(0, 4).toString() !== '%PDF') fails.push('Board.pdf 少 %PDF 头');
else if (!/\/Type\s*\/Page[^s]/.test(pb.toString('latin1'))) fails.push('Board.pdf 无页面');
const dx = fs.mkdtempSync(path.join(os.tmpdir(), 'ga-'));
const rl = (e) => { const f = fs.readdirSync(dx).find((x) => x.toUpperCase().endsWith('.' + e));
  return f ? fs.readFileSync(path.join(dx, f), 'utf8') : ''; };
const N = (s) => (s.match(/D0*[13]\*/g) || []).length;
try {
  execFileSync('pwsh', ['-NoProfile', '-Command',
    `Add-Type -A System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::ExtractToDirectory("${path.join(runDir, 'Gerber.zip')}","${dx}")`]);
  const seen = new Map(); let holes = 0;
  for (const f of fs.readdirSync(dx).filter((x) => /\.DRL$/i.test(x))) {
    const pts = fs.readFileSync(path.join(dx, f), 'utf8').match(/^X-?[\d.]+Y-?[\d.]+/gm) || [];
    if (!pts.length) fails.push(`${f} 无任何孔坐标`);
    holes += pts.length;
    for (const h of pts) { if (seen.has(h)) notes.push(`重复孔 ${h}: ${seen.get(h)} & ${f}`); else seen.set(h, f); }
  }
  if (!holes) fails.push('全部钻孔文件孔数=0');
  for (const e of ['GTL', 'GBL', 'GTS', 'GBS', 'GTO', 'GTP']) if (!N(rl(e))) fails.push(`${e} 是空层`);
  const sil = (rl('GTO').match(/D0*1\*/g) || []).length;
  if (sil < 10) fails.push(`顶丝印仅 ${sil} 段(<10)，近似空`);
  const mk = [...rl('GKO').matchAll(/X(-?[\d.]+)Y(-?[\d.]+)D0?([123])\*/g)];
  const mv = mk.find((m) => m[3] === '2'), dr = mk.filter((m) => m[3] === '1');
  if (dr.length < 3) fails.push('板框 D01<3，未成形');
  else if (!mv || Math.abs(+dr.at(-1)[1] - +mv[1]) > 1e-6 || Math.abs(+dr.at(-1)[2] - +mv[2]) > 1e-6)
    fails.push('板框未闭合：末段终点≠起点');
  else {
    const xs = dr.map((m) => +m[1]), ys = dr.map((m) => +m[2]);
    const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
    if (Math.abs(w - boardW * 0.0254) > 0.05 || Math.abs(h - boardH * 0.0254) > 0.05)
      fails.push(`板框 ${w.toFixed(2)}×${h.toFixed(2)}mm ≠ ${boardSrc} ${boardW}×${boardH}mil`);
  }
} catch (e) { notes.push('Gerber 深检未完成: ' + e.message); }
finally { try { fs.rmSync(dx, { recursive: true, force: true }); } catch (_) {} }
const ohm = (s) => { const m = String(s || '').match(/^([\d.]+)\s*([kKmM]?)/); if (!m || !m[1]) return null;
  const v = parseFloat(m[1]); return m[2].toLowerCase() === 'k' ? v * 1e3 : m[2].toLowerCase() === 'm' ? v * 1e6 : v; };
const code = (s) => { const m = String(s || '').match(/(\d{3})(\d)(?=[A-Z]*$)/); return m ? +m[1] * 10 ** +m[2] : null; };
for (const it of bom) { const a = ohm(it.comment || it.value), b = code(it.mpn);
  if (a && b && Math.abs(a - b) / b > 0.01) fails.push(`值↔物料不符: ${it.designators.join(',')} 标 ${it.comment || it.value} 实为 ${b}Ω (${it.mpn})`); }
```
