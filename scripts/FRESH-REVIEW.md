# 独立复核：无人值守流水线「坏板判通过」风险

基线（写入时刻实测）：`pipeline3.js` 2058 行 / sha256 `522BE2F3`；`run-all.ps1` 650 行 / `E3F1C314`；`audit-design.js` 321 行 / `D6D9D24D`；`verify-drc.js` 190 行 / `62466EBF`。**该目录正被另一进程持续改写**（本次审计期间 pipeline3.js 从 1945 → 2058 行），行号以本基线为准。

## 按「能否让坏板通过」排序

### 1. `run-all.ps1:451-459` — 独立 DRC 闸门遇到 exit 2 直接放行
`verify-drc.js:156-172` 对「CLI 无输出 / 输出无法解析 / `env.ok === false`」一律 `exit 2`，而被注释为「环境问题」。

由此出错的方式：`--timeout` 超时、幽灵调用、session 死掉时 `env.ok` 为 false，闸门记一句「本闸门跳过」就 `continue`；而 `$finalOk = ($v -and $v.ok -and $verifyOk)`（`run-all.ps1:644`）**从不看 `$drcReOk`**，于是「独立 DRC 复核从未跑成」的板子照样 `exit 0`——而流水线自述的 `drcPassed` 恰是本文件 L436 自己认定双向不可信的量。

应改成：加 `$drcReChecked` 标志并纳入 `$finalOk`；exit 2 先重试一次，仍为 2 则判「结论未定」而非放行。

### 2. `pipeline3.js:1852-1867` — 假阴性兜底把「查不出」当成「查清了」
`countLeaves`（L1839）只统计带 `errorType` 的深层叶子；而同一文件 L885-891 的 `sumCount` 注释明确写了「DRC 可能只返回类别层（有 `count` 无 `list`）」。

由此出错的方式：树里只有 `{name:'Connection Error', count:5}` 时 `countLeaves` 返回 0 → `looksClean` 成立 → 两次重试都返回同样的类别层 → `confirmed === 2` → `drcPassed = true`，而布尔版刚判过 `false`。第二分支 `Array.isArray(drcDetails) && drcDetails.length === 0` 更直接：详情接口整体失败返回空数组同样算「干净」。

应改成：`countLeaves` 复用 `sumCount` 的类别层兜底；`looksClean` 要求 `drcDetails !== null`；且不得用刚返回 false 的同一个 API 翻转判定，须靠 `verify-drc.js` 式独立回读。

### 3. `pipeline3.js:893-907` — 布线循环把空树读成「已布通」
`stillUnconnected` 初值 `Infinity`（L871）方向是对的，但 L885-891 的 `sumCount` 对既无 `count`、无 `list`、无 `errorType` 的节点返回 `Number(undefined) || 0`。

由此出错的方式：DRC 返回 `[]` 或只含 `{name:...}` 的节点时 `sumCount` 得 0 → `stillUnconnected === 0` → L907 `break`，直接跳过重建覆铜和后续所有轮次，与 L876-878 自己写的「未知必须比确定有断连更保守」相反。

应改成：无法解析的节点返回 `NaN`，并把 `NaN` 归一为 `Infinity`。

### 4. `pipeline3.js:1779` — 补线复检只比总量，可以「换类」留下
判据是 `flat2.length > beforeCount`，只比总数。

由此出错的方式：一轮把 2 个 Connection Error 换成 2 个 Clearance Error，`2 > 2` 为假 → 不回滚，`patchRound`/`patched` 照记 `fixed:2`、`patchCount` 照加，日志上是一次成功的连通性修复。

应改成：按 `errorType` 分别计数，要求 Connection Error 数严格下降且不出现新类别，否则同上回滚。

### 5. `pipeline3.js:1752` — `patchNoObj` 分支遗留孤立过孔
跨层分支（L1741-1748）先建两个 12/24 过孔并把 id 推入 `patchCreated`，再建走线。

由此出错的方式：走线 `create` 静默返回 undefined → `if (!made) { log('patchNoObj'); continue; }` 直接跳过，两个过孔留在板上且无任何回滚；只有「后续某轮恰好变差」时 `patchCreated` 整批删除才会顺手清掉，循环正常退出则永久残留。

应改成：进入候选前记 `const mark = patchCreated.length`，`!made` 时删掉 `patchCreated.slice(mark)` 并截断数组。

### 6. `pipeline3.js:547-551` — autoLayout 超时后从不取消作业
`waitJob(job.jobId, Math.max(Math.min(420000, left() - 240000), 30000), 'layout')` 之后没有任何 `cancelAutoJob`，而布线路径（L847-850）明确写了「等超时不等于作业停了」。

由此出错的方式：布局作业超时后仍在写几何，紧接着的 patchDrc/clearance 在同一块板上改铜，几何互相覆盖——正是 L830-833 注释里「两个布线器同时写铜」的同类问题。

应改成：照抄布线路径，`r.state !== 'completed'` 时 `cancelAutoJob` 并重新 `save()`。

### 7. `pipeline3.js:1538-1561` — L 形回滚失败被静默吞掉
`catch (e2)` 里恢复原终点写的是 `try { modify(trackId, {endX: ex, endY: ey}) } catch (e3) { }`。

由此出错的方式：若这次恢复也抛异常，原走线停在 `cornerX/cornerY`（已被截短），`trackRerouteRolledBack` 却记「已回滚」，且 `fixed` 未加，`clearanceFixes` 完全反映不出这条网上多了一个断点。

应改成：恢复后回读 `getState_EndX/EndY` 校验，不等则把该设计判失败，而不是继续。

### 8. `pipeline3.js:347` 与 `audit-design.js:46` — `norm` 先大写导致单位量纲坍缩
实测：`norm('10M') === norm('10m') === '10M'`，且两者都满足 `NOMINAL`。

由此出错的方式：兆欧与毫（10 mΩ/mF）被当成同一个值，声明 `10m` 的器件能对上 `10M` 的目录件（假通过）。反向也错：`norm('8P') === '8PF'`、`norm('1N4148') === '1.4148NF'`（封装/型号被当成电容值），`100nF` 与 `0.1uF` 却判不等（等值被判不符）。

应改成：单位 token 走白名单且必须紧贴数字结尾，拒绝 `\dN\d{3,}` 型号形状，并补 nF↔uF 的千倍换算。

### 9. `run-all.ps1:59-64` — 语法闸门静默换成旧版本，且不记录换了哪个
`Get-PipelineScript` 在现文件编译失败时回退到 `pipeline3.js.lastgood` 并继续跑。

由此出错的方式：日志里没有任何「本次实际跑的是 lastgood」的字段，一次通过无法归属到具体 revision——被复核的那份代码可能根本没被执行过（本目录正在被并发改写，这条不是理论风险）。

应改成：记录实际使用的路径与 sha256。

## 未发现

- `norm` 两处实现的一致性：代码逐字相同（仅注释不同），未发现语义漂移。
- 预算闸门：`boardWaitBudgetSkip`(L224)、`routeBudgetStop`(L813)、`routeBudgetSkip`(L829)、`routeCancelled`(L847)、`clearanceBudgetSkip`(L1223)、`drcBudgetSkip`(L1790)、导出闸门——全部 fail-closed（`throw`/`continue`/置 `routeState='budget'`），未发现把设计判成 ok 的路径。
- `waitCap`/`left()` 下限：负值被 30000/5000/120000 兜住，未发现「0 超时秒过即成功」。
- `$bestRaw`/`$lastGoodRaw`：赋值点（L488、L497）在两道路由闸门之后，且 `$bestV` 与 `$bestRaw` 同步移动（L556），未发现「最好的一版其实是复核失败的一版」。
- `verify-artifacts.js` exit 2：`$verifyOk = $false` → `$finalOk = $false`，fail-closed，未发现假通过。
- `create` 静默失败检测本身：`dogleg create1`(L1500/1508)、`L create1/2`(L1546/1551)、`patchNoObj`(L1752) 用「拿没拿到 id」判定是正确的唯一可靠信号，未发现检测逻辑缺陷（遗留物问题见第 5 条）。

STATUS={"status":"ok","changed":["scripts/FRESH-REVIEW.md"],"verify":{"cmd":"read scripts/FRESH-REVIEW.md","exit":0},"reason":"已按假通过风险排序写出 9 条确认缺陷与 6 项未发现问题，基线 sha256 522BE2F3 / 2058 行。"}
