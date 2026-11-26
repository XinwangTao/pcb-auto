# Adversarial review — `scripts/idea2design.js` UNSUPPORTED patch (2026-11-26)

## Verdict

The patch fixes the one sentence that motivated it (T0) and is mechanically safe (pure insertion,
syntax OK, zero output change on the 25-idea corpus). But it is **net-negative**:

* **10 of 20 plausible candidate sentences I tried are now FALSE REFUSALS** (old `exit 0` with a board that
  actually does what was asked → new `exit 1`). 9 of those 10 are the same defect: the user
  **excluded** a part ("不用运放"), and the regex reads the exclusion as a request.
* It does **not** touch the real generic failure mode. 11 further sentences still compile to a board
  missing the requested device with `exit 0`, including two Chinese synonyms of nouns the patch
  *does* list (`光电耦合器` for `光耦`, `六轴姿态传感器` for `IMU`).
* The claim that "adding a part to `_catalog.json` auto-disables the block" is **false**; I proved it
  by adding a real NTC part to a catalog copy and still getting `exit 1`.
* The served-branch is **dead code over today's catalog**: 0/18 entries match any of the 12 regexes.

Recommendation: do not ship as a hard gate. Make it opt-in (`--strict-unsupported`) and at minimum
apply Fix 1 + Fix 3 below (negation awareness, and stop treating 降压 as unsupported), or replace the
blacklist with the capability-completeness check in §7.

## Facts verified first

| item | value | how |
|---|---|---|
| patched file | 53,283 B, sha256_12 `4CA45BBD6A2D`, 0 CR / 925 LF, no BOM | `Get-FileHash`, `[System.IO.File]::ReadAllBytes` |
| pre-patch file | 49,832 B, sha256_12 `7EEBF0152C04` | same |
| diff shape | **59 added lines, 0 deleted, 0 changed** | `Compare-Object` → `old-only = 0`, `new-only = 59` |
| isolation | pre-patch copy cannot run in place (`ROOT=__dirname/..` → `out/designs` missing); ran both from `F:\cache\temp\rev\{old,new}\{scripts,designs}` with identical catalog (`F520CAE88EF9` both) | hash of copies |
| syntax | `node --check` exit 0 on both | `E:\APP\nodejs24\node.exe --check` |
| repo catalog untouched | `F520CAE88EF9` before and after all experiments | `Get-FileHash` |

Because the diff is insertion-only, any behavioural delta can only be "new refusal" or "new warning".

## 1. FALSE REFUSALS (highest priority) — 10 confirmed

Command per row: `node <old|new>/scripts/idea2design.js "<idea>" -o <temp dir>/x.json`, exit code quoted.
"OLD parts" is the stdout `器件 :` line.

| # | idea | old | new | what the new gate struck | OLD board |
|---|---|---|---|---|---|
| F1 | 做一个 5V **降压**到 3.3V 的稳压小板，带 LED 电源指示和排针进出 | **0** | 1 | `✗ 降压变换` | U1=C6186(AMS1117) C1/C2=10uF C3=100nF R1=1k LED1 H1 — the board *is* the 5V→3.3V regulator; "降压" is exactly what an LDO does |
| F2b | 做一个纯电阻分压电路，把 5V 分压到 4.2V 给 ADC 采样，不要 LDO，也**不要电感** | **0** | 1 | `✗ 电感` | R1=1k R2=5.1k C1=100nF H1 (1k/5.1k = 4.18 V, satisfies 4.2 V) |
| F3b | 做一个 SHT30 温湿度模块，I2C 上拉 5.1k，**不用运放**，直接接 MCU 的 ADC，4 脚排针引出 | **0** | 1 | `✗ 运放/比较器` | U1=SHT30 R1/R2=5.1k C1=100nF H1 |
| F6 | 做一个 TP4056 锂电池充电板，带电池座和状态灯，**不需要升压** | **0** | 1 | `✗ 升压变换` | TP4056 + BATT-2P + red LED + 1k + 5.1k + in/out headers |
| F7 | 做一个 LED 指示灯板，限流电阻加排针，**不要数码管也不要光耦** | **0** | 1 | `✗ 光敏电阻/光耦` + `✗ 数码管` | R1=1k LED1 H1 |
| F8b | `A 3.3V LDO module for SHT30, I2C pull-ups 5.1k, 4-pin header, no op-amp conditioning` | **0** | 1 | `✗ 运放/比较器` | SHT30 + 2×5.1k + 100nF + AMS1117 + 2×10uF + 8P |
| F9 | `RP2040 minimal board with QSPI flash, 3.3V LDO and SWD header; GPIO drives the status LED, no MOSFET needed` | **0** | 1 | `✗ MOSFET 开关管` | RP2040 + W25Q16 + AMS1117 + 7 caps + 3 R + LED + 8P |
| F11 | 做一块 RP2040 主控板，USB 供电，LDO 稳压，状态指示灯，排针引出，板载**不用麦克风** | **0** | 1 | `✗ 麦克风` | same RP2040 system board |
| F13 | 做一个 4 路 LED 指示灯板，带排针引出，**不做数码管** | **0** | 1 | `✗ 数码管` | 4× (1k+LED) + 8P |
| F16 | 做一块 4 路 LED 指示灯板，带排针，模拟信号直接从 ADC 读，**不用比较器** | **0** | 1 | `✗ 运放/比较器` | 4× (1k+LED) + 8P |

Diagnosis: **9/10 are negation blindness.** The gate tests the raw idea string, so
"不用/不要/不需要/no X" is indistinguishable from "要 X". A refusal that says *"the catalog has no
op-amp, so I refuse"* when the user wrote *"I don't need an op-amp"* is self-refuting. F1 is the tenth
case: 降压 is the everyday Chinese word for a linear step-down, and the catalog's AMS1117 *is* that
function — the entry is a semantic error, not a missing-device fact.

### Candidates that did NOT regress (already refused pre-patch — reported for honesty, not as defects)

| idea | old | new | old reason (unchanged) |
|---|---|---|---|
| RP2040 板，GPIO 直接驱动 LED，不需要 MOSFET | 1 | 1 | `✗ 电机驱动` — pre-existing FEATURES `/驱动/` over-match |
| 不用热敏电阻，改用 SHT30 … | 1 | 1 | `✗ C11702(电阻 1k)` — pre-existing `droppedParts` gate |
| USB-C 3.3V 电源板，CC 下拉 5.1k，不要光耦隔离 | 1 | 1 | `✗ C25905` — pre-existing `droppedParts` gate |
| 5V 转 3.3V，纯 LDO 方案，无开关电源、无电感 | 1 | 1 | `✗ 按键输入` — pre-existing FEATURES `/开关/` over-match |
| 压力传感器采集板，提升压力测试的复现性 | 1 | 1 | 认不出任何已核实器件 |

### Asymmetry that proves the gate is lexical, not semantic

* ZH `做一个 5V 降压到 3.3V 的 LDO 模块…4 脚排针` → **exit 1** (`✗ 降压变换`)
* EN `An LDO module that steps down 5V to 3.3V for a SHT30 sensor, 4-pin header` → **exit 0**, board = SHT30 + AMS1117 + caps + 8P

Same request, same board, opposite verdict: `/step-?down/` does not match "**steps down**" (the space),
so the English phrasing escapes while the Chinese one is refused. (`boost`/`buck` are caught earlier by
FEATURES, which is why EN attempts mostly do not reach this gate.)

### Blast radius of a false refusal

`run-all.ps1` `-Idea` mode (line ~377-390) calls `idea2design.js $Idea -o $genTarget` with **no
`--allow-partial`** and then:

```
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $genTarget)) {
  throw "想法编译失败（exit=$LASTEXITCODE）。请扩充 designs\_catalog.json 或改写想法。"
}
```

So on the live path a false refusal aborts the whole run *and* the operator is told to "expand the
catalog", which is the wrong remedy. `--allow-partial` exists but nothing passes it
(`grep allow-partial` → only inside `idea2design.js`), so the escape hatch is unreachable from the
pipeline. Note also that the one flag now waives two different things (coverage gap + "the device does
not exist at all") with a single warning line.

## 2. FALSE NEGATIVES — the blacklist does not close the hole

All rows below compile with **exit 0** on **both** versions (patch is blind to them) and produce a
board that cannot do what was asked. Verified with `-o` into `F:\cache\temp\rev\out\`.

| # | idea | resulting board | what is missing |
|---|---|---|---|
| G1 | 做一个 5V 输入带**自恢复保险丝**的 SHT30 温湿度模块，带排针引出 | SHT30 + 2×5.1k + 100nF + 8P | the fuse that was the point of the sentence |
| G2 | 做一个 **WS2812B 灯带**控制小板，带排针进出 | 1k + one KT-0805G + 8P | addressable LED + level shift (generic `/.*灯/` keyword matched "灯带") |
| G3 | 做一个 8 路 LED 流水灯，用 **74HC595** 扩展 IO，带排针引出 | 8× (1k + LED) + 22P | the shift register / drive capability |
| G4 | 做一个 SHT30 温湿度模块，用 5.1k 上拉，带**电位器**调报警阈值，4 脚排针引出 | SHT30 + 2×5.1k + 100nF + 8P | potentiometer |
| G5 | 做一个 5V **加热片**恒温小板，带 LED 电源指示和排针进出 | 1k + LED + 8P | heater + switch element (an LED board for a heater) |
| G6 | 做一个 5V 输入的**压敏电阻**分压采样板，带排针引出 | 1k + 5.1k + 100nF + 8P | varistor |
| G7 | 做一个锂电池**电量指示**板，带电池座和排针 | TP4056 charge board + 2P×2 + LED | fuel gauge / level indication (charge LED ≠ battery level) |
| G8 | 做一个 SHT30 温湿度模块，配 **LCD1602** 显示，带排针引出 | SHT30 + **OLED** + 2×100nF + 8P | wrong display type substituted silently |
| G9 | 做一个**光电耦合器**隔离的 SHT30 采集板，排针引出 | SHT30 + 2×5.1k + 100nF + 8P | optocoupler — **the patch lists 光耦 but not 光电耦合器** |
| G10 | 做一个 SHT30 温湿度模块，加**六轴姿态传感器**，排针引出 | SHT30 + 2×5.1k + 100nF + 8P | IMU — **the patch lists IMU/陀螺/加速度计 but not 姿态/六轴** |
| G11 | 做一个 SHT30 温湿度模块，加**磁场传感器**测转速，排针引出 | same 5-part module | Hall-class sensor — patch has 霍尔 but not 磁场传感器 |
| G12 | 做一个 SHT30 温湿度模块，加**数字显示管**显示温度 | SHT30 + **OLED** | 7-seg numeric display, again substituted by OLED |
| G13 | 做一个 SHT30 模块，带 **5V 风扇接口** / **INA219** 电流检测 / **旋转编码器** / **超声波测距** (4 separate runs) | each: SHT30 + 2×5.1k + 100nF + 8P | every named peripheral |

G9–G12 are the decisive ones: even *within* its own 12 concepts the blacklist is defeated by Chinese
synonymy. An enumeration cannot be closed by adding entries — G3/G4/G5/G13 are open-set.

Nouns I tried that were already refused (so **not** gaps, though the reason is sometimes wrong):
蜂鸣器/喇叭 (`✗ 发声器件`), 触摸按键/拨码开关 (`✗ 按键输入`), 蓝牙/无线 (`✗ 无线通信`),
继电器 (`✗ 继电器`), 电机 (`✗ 电机驱动`), SD/TF 卡 (`✗ 存储卡槽`), 晶振 (`✗ 晶振`),
摄像头/超声波-only/风扇-only/电位器-only (picked empty → `认不出任何已核实器件`),
光电二极管 (`识别到器件但无法匹配任何已实测配方` — C191023 got picked), 压敏电阻+保护
(`✗ C2827625(TVS)` — the pre-existing droppedParts gate gives an absurd "TVS 装不上去" message for a
*protection-IC* request; unchanged by this patch, worth its own ticket).

## 3. AUTO-DISABLE CORRECTNESS — the claim is false

Code path (patched file line numbers):

* L56 `const byLcsc = new Map(CATALOG.parts…)` — catalog index, module scope.
* L218 `const picked = matchedParts(idea);` — **this is the only source of `picked`**: a `Set` of
  LCSC ids hit by the `KEYWORDS` table (L24-54). No catalog part enters it any other way.
* L236-254 the new block; L237 `auditUnsupported(idea, picked)`.
* L302 `const addPart = …` is only *defined* here and first *called* at L312 (RP2040), L391 (charger),
  L4xx/5xx (sensor/discrete). So at L237 **no recipe part exists yet**.
* L107-110 `unsupportedUnserved` looks up `picked` in `byLcsc` and tests `name`, `role`, `tags`.

Instrumented proof (copy at `F:\cache\temp\rev\t3c`, one `console.error` inserted before L237):

```
[probe] picked=["C86346","C2297","C9900192758"] (auditUnsupported runs BEFORE any addPart)
  器件 : U1=C86346(SHT30), R1=C25905(5.1k), R2=C25905(5.1k), C1=C14663(100nF),
         R3=C11702(1k), LED1=C2297(LED-Green), H1=C9900192758(8P)
```

`picked` has 3 ids; the recipe placed 7 parts — 4 of them (both pull-ups, the 100nF, the LED resistor)
are invisible to the audit. So `picked` is **the keyword-hit set only, never the recipe output**.

Experiment A — catalog alone (copy `t3a`, catalog gains a genuine part; **no code change**):

```
C999001 NTCG103JF103FT1S  role 热敏电阻 NTC 10k  tags [ntc,thermistor,热敏,温度,sensor]
node <t3a>/scripts/idea2design.js '做一个热敏电阻温度采集板，用运放放大后经排针输出'
exit=1   ✗ 热敏电阻/NTC   ✗ 运放/比较器
```

Adding the part therefore does **not** auto-disable anything: `C999001` is not in `KEYWORDS`, so it
never reaches `picked`. A second code edit (a `KEYWORDS` entry) is required, and a third (a recipe that
calls `addPart('C999001')`) before the idea actually compiles — the main-level `droppedParts` gate
(L885-904) then rejects it with `装不上去`. "Auto-disable, no code change" needs **three** edits.

Experiment B — the inverse failure (copy `t3b`, only tags added to an existing keyword target):
appending `光敏`,`ldr` to `C11702`'s tags (the 1k resistor, reachable via `/电阻/`) made

```
'做一个光敏电阻分压采样板，带排针引出' → exit=0
  器件 : R1=C11702(1k), R2=C25905(5.1k), C1=C14663(100nF), H1=C9900192758(8P)
```

i.e. a bogus tag on an unrelated resistor silently disables the photoresistor gate. The predicate is a
free-text tag match, not a capability check, so it is simultaneously too strict (real part present, not
keyword-reachable → still refused) and too weak (any tag mentions the word → allowed).

Additionally: **0 of the 18 catalog parts match any of the 12 regexes** today, so
`unsupportedUnserved` currently always returns `true` — the served branch is unreachable dead code.

## 4. REGRESSION ON THE 25-IDEA CORPUS — clean, but the corpus cannot validate the gate

`F:\cache\temp\idea-corpus.json` (25 strings), both versions, `-o` to temp:

* **exit codes identical: 25 / 25** (differing: 0).
* 21 ideas exit 0 on both; for those, **files are BYTE-IDENTICAL (SHA-256 equal) in all 21 cases** —
  the patch changes no output for supported ideas.
* 4 ideas exit 1 on both (`#01 ESP32-C3`, `#02 RP2040 minimal`, `#03 USB-C/USBLC6`, `#23 双时钟/RTC`) —
  pre-existing refusals, unchanged, same messages.

Caveat that matters for the review: **not one of the 25 contains a negation, a 降压/升压 phrase, or any
of the 12 nouns.** "25/25 identical" therefore proves the patch is inert on the corpus; it proves
nothing about the new gate's safety, and the 10 false refusals in §1 are all outside this corpus.
A regression set for this feature must be built from negation/exclusion sentences.

## 5. CODE QUALITY / RUNTIME RISK

Checked and **not** defects:

* `node --check` exit 0 (both versions).
* Scope: `byLcsc` (L56) and `part`/`has` are module consts; `picked` (L218), `warnings` (L217),
  `allowPartial` (L216), `idea` are all in scope at L237. No undeclared identifier.
* Ordering: the block (L237-254) runs **after** `const warnings = []` (L217); the `warnings.push`
  at L253 is safe.
* The error object's extra key `unservable` is read by nobody: `main` uses only `r.ok`, `r.reason`,
  `r.design`, `r.stats`, `r.warnings`; repo-wide grep for `unservable` outside this file → 0 hits
  (the `\.missing` hits are unrelated `fabcheck.js` diagnostics). Same for the existing `missing` key:
  it is inert. No collision.
* `/光敏|光耦|optocoupler|photodiode|\bldr\b/i` is a valid **regex literal inside an array literal**
  (not inside a template literal), so `\b` is a word boundary, not a backspace:
  `光敏电阻`→true, `光耦隔离`→true, `LDR`→true, `Photodiode`→true, `elder`→false, `白ldr白`→true.
* No catastrophic backtracking: plain alternations of literals, no nested quantifiers. All 12 regexes
  over a 100,000-char pathological string: **0.46 ms**.
* File hygiene preserved: no BOM, 0 CR, 925 LF, shebang intact; no `module.exports`/`require` of this
  file anywhere, so no double-CLI-execution hazard.
* The project's own `scripts/test-idea2design.js` fails 1/16 — but it fails **identically on the
  pre-patch build** (`做一个 USB-C 供电的 3.3V 电源板，带 ESD 保护` → old exit 1, new exit 1, both
  `✗ C25905(电阻 5.1k)`), i.e. a pre-existing broken expectation, **not** a patch regression.

Observed weaknesses (not crashes):

1. **Dead branch** (§3) — `unsupportedUnserved` can never return false with today's catalog.
2. **One flag, two semantics** — `--allow-partial` now waives both "coverage gap" and "the device
   simply does not exist", with only a `[warn]` line distinguishing them.
3. **Message conflation** — "目录里没有可用料号" is printed even when the catalog *does* have the part
   (Exp A) or when the part was merely negated (F1-F16). Remedy text then says "增补料号", which Exp A
   shows does not help.
4. **Semantic error in the list** — `降压` (F1) and, via `/step-?down/` vs "steps down", language-
   dependent detection.
5. **Chinese synonym holes inside the covered set** — 光电耦合器, 光电二极管, 姿态传感器/六轴, 磁场传感器
   (§2 G9-G12).
6. Entries carry `need` but no `why`, unlike `FEATURES`, so the refusal gives no engineering hint.

## 6. MINIMAL FIXES (not applied) — exact old/new string pairs

### Fix 1 (must-have): stop reading exclusions as requests

old:
```
function auditUnsupported(idea, picked) {
  const out = [];
  for (const u of UNSUPPORTED) {
    if (!u.re.test(idea)) continue;
```
new:
```
// 「不用 X / 不要 X / 无 X / no X」是在排除该器件，不是在点名它（实测 F2b/F3b/F6-F13/F16 全是误拒）。
function stripNegated(idea) {
  return String(idea)
    .replace(/(不|无|没|非|免)(用|要|需|须|做|加|带|装|使用)?[^，。；、,;.\s]{0,8}/g, ' ')
    .replace(/\bno\s+(?:onboard\s+|external\s+|extra\s+)?[a-z][a-z0-9\-]{0,20}/gi, ' ');
}
function auditUnsupported(idea, picked) {
  const out = [];
  const affirm = stripNegated(idea);
  for (const u of UNSUPPORTED) {
    if (!u.re.test(affirm)) continue;
```
Verified in isolation: T0 still fires (`fires(stripped)=true`), F2b/F3b no longer fire. This alone
removes 9 of the 10 false refusals.

### Fix 2: make the "auto-disable" claim true, or delete it

The block must judge **placed** parts, so it belongs in `finish()` (after `components` is built), not
at L237. Two edits:

(a) delete the early block — old:
```
  // 目录里根本没有的器件：先于覆盖审计拦下（这是更根本的原因）
  const unservable = auditUnsupported(idea, picked);
  if (unservable.length > 0 && !allowPartial) {
```
new:
```
  // 目录里根本没有的器件：延后到 finish()，那里才知道配方到底装了什么（见 finish 内的同名检查）
```
…and keep only the `missing`/FEATURES block here. (b) in `finish()`, immediately before
`  return {\n    ok: true,` (L829) insert:
```
  // 用「真正装到板上的器件」判定，而不是 KEYWORDS 命中集：picked 里没有配方件，
  // 补料若不配 KEYWORDS + 配方永远不会进 picked（实测 C999001 加进目录仍被拒）；
  // 也不能看 tags 文案，随便打一个 tag 就能放行（实测 C11702 打上「光敏」即 exit 0）。
  const unservable = auditUnsupported(idea, new Set(components.map((c) => c.lcsc)));
  if (unservable.length > 0 && !allowPartial) { /* same return {ok:false, reason, unservable} */ }
```
and rewrite the doc comment at L105-106 (old):
```
// 已装器件若自报了同名能力（name/role/tags），就不算「目录里没有」。
// 这样将来往 _catalog.json 补了料，这条拦截会自动失效，不必再改代码。
```
new:
```
// 只有「配方真的会把它装到板上」的器件才算服务了该需求。
// 补一个料号到 _catalog.json 不会自动解锁：还必须加 KEYWORDS 行 + 配方里的 addPart。
```

### Fix 3 (must-have): 降压 is not an unsupported capability

old:
```
  { re: /升压|step-?up/i,                                need: '升压变换' },
  { re: /降压|step-?down/i,                              need: '降压变换' },
```
new:
```
  // LDO 就是线性降压：用户写「5V 降压到 3.3V」而目录明明有 AMS1117（实测 F1 误拒）。
  // 只有点名开关拓扑才算缺 DC-DC；FEATURES 的 boost/buck/dc-dc 也会兜住。
  { re: /开关(电源|稳压)|升降压|buck|boost|dc-?dc|step-?up|step-?down/i, need: '开关电源(DC-DC)' },
```

### Fix 4 (band-aid only): close the Chinese-synonym holes it already noticed

old: `  { re: /光敏|光耦|optocoupler|photodiode|\bldr\b/i,      need: '光敏电阻/光耦' },`
new: `  { re: /光敏|光耦|光电耦合|光电二极管|optocoupler|photodiode|\bldr\b/i, need: '光敏电阻/光耦' },`
old: `  { re: /陀螺|加速度计|mpu-?6050|\bimu\b/i,               need: 'IMU' },`
new: `  { re: /陀螺|加速度计|姿态(传感器|模块)|六轴|九轴|mpu-?6050|\bimu\b/i, need: 'IMU' },`
old: `  { re: /霍尔|\bhall\b/i,                               need: '霍尔传感器' },`
new: `  { re: /霍尔|磁场传感器|磁传感器|\bhall\b/i,             need: '霍尔传感器' },`

## 7. What to do instead (the approach is the problem)

A 12-item blacklist over open-ended natural language cannot converge: §2 shows it missing 13 device
nouns, 4 of them synonyms of its own entries, while §1 shows it firing 10 times on exclusions of the
same nouns. The repo already contains the correct primitive — `main()`'s `droppedParts` gate
(L885-904) compares *what the idea named* against *what was actually placed*. Unify on that, once:

1. **Declare capabilities, not tags.** Add `capabilities: ["sensor.temp", "ldo.3v3", …]` to every
   catalog entry (explicit ids, no free text). Delete the `u.re.test(name/role/tags)` shortcut; tag
   prose is how Exp B defeated the gate.
2. **Extract requirements positively.** Reuse `KEYWORDS` as the device dictionary and grow it, plus a
   device-noun table that may point at a *capability id with no LCSC* (that is precisely "the catalog
   lacks it"). Normalise negations (§6 Fix 1) **before** extracting, and keep units/values
   (`4.7k`, `8P`, `22P`) as requirements too.
3. **Prove completeness at one point.** In `finish()`, check `requirements ⊆ union(capabilities of
   placed parts)`; on failure return `{ok:false, unserved:[{id,why,kind}]}` where `kind` separates
   `catalog-missing` (act: add part) from `recipe-missing` (act: extend recipe) from
   `waived` — three different remedies that the current single message conflates.
4. **Fail-open by default on the new class.** Per the brief, a false refusal is worse than a wrong
   board: default to `[warn]` + a machine-readable `unserved` array inside the design JSON (so
   `accept`/`fabcheck` can surface "这块板缺 3 项需求"), and gate the hard refusal behind
   `--strict-unsupported`. `run-all.ps1 -Idea` would then never abort on a lexical false positive.
5. Keep §1's 16 sentences and §2's 13 sentences as the regression corpus — the current 25-idea corpus
   contains none of this behaviour and cannot detect a regression in it.

## Appendix — commands used (all read-only w.r.t. the repo)

```
node --check <old|new>/scripts/idea2design.js                              # 0 / 0
node <v>/scripts/idea2design.js "<idea>" -o F:\cache\temp\rev\out\x.json   # per-row exits above
node scripts\audit-design.js F:\cache\temp\rev\out\T0-old.json             # exit 0, "0 个电气问题"
node scripts\test-idea2design.js                                           # 15 pass / 1 fail (same on pre-patch)
node F:\cache\temp\rev\{mutate.js,probe-regex.js,proto.js}                 # catalog mutator / regex probe / negation prototype
```
No file under `pcb-auto` was modified except this report; `designs/_catalog.json` hash unchanged
(`F520CAE88EF9`); no output was written into `designs/`.
