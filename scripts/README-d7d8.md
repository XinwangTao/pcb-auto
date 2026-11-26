# d7 / d8 失败诊断（2026-11-25，11 次实测）

## 结论速览

| 设计 | 生产症状 | 实测真因 | 补丁后 |
|---|---|---|---|
| d7 RP2040_QSPI_Flash | r1 违规 1 组、r2 `REQUEST_TIMEOUT` | ①板框 2400×1800 过大（越小越好）②590s 被幽灵调用吃掉 | 1130×1130 **PASS 189s** |
| d8 AI_纯分立_19pl4cd | `策略=?`、校验全 0 | 外层 `SESSION_NOT_FOUND`，流水线从未启动；且声明 1400×1000 被放大到 2126×1786 | 1400×1000 **PASS 150s** |

## d7 阶段耗时（同一会话基线）

| 板框 mil | 结果 | wall | snapEnds | fixClearance | export |
|---|---|---|---|---|---|
| 3600×2700（生产 r1） | FAIL 违规 1 | 177.7 | 92.4 | — | — |
| 2400×1800（声明值） | FAIL 违规 1（4 叶） | 266.0 | 111.6 | 49.6 | 51.1 |
| 1200×900 | PASS | 175.1 | 90.9 | 10.6 | 20.0 |
| 1130×1130（补丁公式） | PASS | 189.2 | 88.9 | 20.6 | 14.8 |
| 2400×1800（生产 r2） | `REQUEST_TIMEOUT`×2 | 1316.6 | — | — | — |

- **590s 本身够**：健康会话下 d7 只需 266s。r2 的 1316s 无结果不是预算不足，
  是会话被前一次超时的幽灵调用污染（见下）。
- **板越大越差**：2400×1800/3600×2700 全失败，1200×900 直接通过；填充率仅 0.119（d8 0.255），
  器件被摊开 → 走线细长 → 吸附/间距更易出错。今晚 d13 同样被放大到 2118×1779、2647×2224 连续失败。
- **snapEnds 是最大单项**（占 42%）：原实现 `anchors.filter(a => a.net === net)` 每条线全表扫描，
  `modify` 逐条同步写回。分桶后 111.6s → 88.9s，并丢掉 56 条吸附后完全重合的重复线
  （`dupSkipped:56`，正是 "铜压铜" Clearance 的来源）。

### 根因：`REQUEST_TIMEOUT` 不中断代码 → 幽灵调用 → 下一设计无声失败

CLI 原文：`gave up waiting; the code may still be running in the render`。
`session abort` 前实测：d7 超时后立刻在同一 session 跑 d8 → 立即 `SESSION_CLOSED`；`session abort`
（唯一能杀卡死窗口的命令）后重开 → 偶发 `EXECUTION_ERROR: no board`；再下一次全新 session 才恢复
150s 通过。**结论：abort 后必须允许再重试一次，不能一次不成就放弃。**

## 补丁（完整 unified diff：`scripts\d7d8-patches.diff`，+114/−23 行，两文件语法校验通过）

**P1 `run-all.ps1` 预估公式只当下限，绝不放大**（插在 `$estArea` 处）

```powershell
$estArea = [Math]::Max(480000, $compCount * 55000 + $connCount * 9000)  # 原 120000/12000
$estSide = [Math]::Ceiling([Math]::Sqrt($estArea))
$FIVExFIVE_MIL2 = 1969 * 1969
$baseArea = $baseW * $baseH
if ($baseArea -gt [Math]::Max($estArea * 2.2, $FIVExFIVE_MIL2)) {   # 过大 → 剪
  $baseW = [int]($estSide * 1.15); $baseH = [int]($estSide * 1.15)
} elseif ($baseArea -lt $estArea * 0.75) {                          # 过小 → 才放大（沿用原 1.25/1.05）
  $baseW = [Math]::Max($baseW, [int]($estSide * 1.25)); $baseH = [Math]::Max($baseH, [int]($estSide * 1.05))
}
```
d7 → 1130×1130（实测 PASS 189s）；d8 → 保持 1400×1000（实测 PASS 150s）。
d13 → 不再放大，但它在声明 1800×1300 复跑仍 1 处违规（fill 0.78），那是另一类根因，此补丁不覆盖。

**P2 `pipeline3.js` 自带预算，超时前必须自己 return**（`const phase = ...` 之后）

```js
const BUDGET = Number((A && A.budgetMs) || 530000);
const left = () => BUDGET - (Date.now() - T0);
```
各闸门：snapEnds `left()<120000` 停；fixClearance `<90000`；patchDrc/drc `<60000`；
导出 `<45000` 记 `{ok:false, skipped:'budget'}`。run-all 传 `budgetMs = --timeout − 60000`。
实测余量足够：预算 100s 时实际收尾 132s（超 30s），外部 150s 未触发，返回**合法 JSON**。

**P3 `run-all.ps1` 非 JSON 必须换 session，不能 `continue`**（`foreach ($plan in $healPlans)` 内的 `ConvertFrom-Json` catch）

```powershell
$why = if ($raw -match 'REQUEST_TIMEOUT') { 'REQUEST_TIMEOUT 幽灵仍在跑' }
       elseif ($raw -match 'SESSION_CLOSED') { 'SESSION_CLOSED' } else { 'NON_JSON' }
if (-not (Reset-Session $why)) { continue }
# Reset-Session: session abort → 删 .session → Ensure-Session
```
并在 `throw "所有自愈策略均失败"` 前也 `session abort` + 删 `.session`，
否则「一个设计超时」会级联成「后面所有设计 `策略=?`」（实测 d7→d8）。

## 验证命令

```powershell
pwsh -NoProfile -File scripts\d7d8-make-patches.ps1          # 生成并校验补丁
pwsh -NoProfile -File scripts\d7d8-verify.ps1                # T1 板框修复 + T2 预算闸门
pwsh -NoProfile -File scripts\d7d8-repro-ghost.ps1           # 复现幽灵调用级联
pwsh -NoProfile -File scripts\d7d8-run.ps1 -Which d7 -Tag d7-full -TimeoutMs 1800000
node scripts\d7d8-parse.js logs\diag-d7-full.json            # 阶段表
```

## 文件

`logs\diag-d7-full.json` `diag-d8-full.json` `diag-d8-declared.json` `diag-d7-small.json`
`diag-ghost.json` `diag-verify.json` `diag-d13-declared.json`（原始 invoke 信封 + 阶段耗时）
`scripts\d7d8-{run,parse,make-patches,verify,repro-ghost}.ps1|js`、`d7d8-patches.diff`
⚠ `-OutDir` 必须绝对路径，相对路径会让 6 个导出全部静默 `ok:false`。
诊断产生的临时工程在 `LCEDA-Pro\projects`（名字带随机后缀，不与 run-all 冲突）。
