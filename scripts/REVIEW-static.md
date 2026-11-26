# pcb-auto 静态审查：无上限等待 / 无界重试 / 静默失败

范围：`pipeline3.js`(1293)、`run-all.ps1`(499；现 1424 行，下表行号已按现版本重核)、`run-overnight.ps1`(142)。纯读代码，未跑 EDA。已知 4 例不复报。

| 严重度 | 文件:行 | 代码片段 | 问题 | 建议补丁 |
|---|---|---|---|---|
| 高 | run-all.ps1:904-912 "$vfFails = @($vfRaw -split" | `$vfFails=@($vfRaw -split ... -match '\[FAIL\]')`；`if($vfFails.Count -eq 0){ break }` | 校验器崩溃时 exit 2 且无 [FAIL] → 当成校验通过并 break，废掉另一轮自愈（**【已修】**：L908 已按 exit code 判未通过） | `$vfCode=$LASTEXITCODE; if($vfCode -ne 0 -or $vfFails.Count){ continue }` |
| 高 | run-all.ps1:515-520 "$auditFails = @($auditOut -split" | `$auditFails=@($auditOut ... -match '\[FAIL\]')` | 审计脚本崩溃时无 [FAIL] → 打印"审计通过"。这是唯一拦电路错误的闸门，fail-open（**【已修】**：L520 已判 `$auditCode -ne 0`） | `if($LASTEXITCODE -ne 0 -or $auditFails.Count){ ...exit 1 }` |
| 高 | pipeline3.js:687,118,164；run-all.ps1:22 "[int]$InvokeTimeoutMs = 590000" | `waitJob(id, isFirstTry?900000:600000)`；建板 8×(60+60)s；`--timeout 590000` | 内部单次等待都大于外部掐断线。掐断→非 JSON→判"设计失败"→换板重烧；最坏 2×590+紧凑 590+重建 590≈2360s | 顶部设 `WALL=T0+540000`，各 wait 取 `Math.min(ms, WALL-Date.now())`，超时返回 `{ok:false,stage:'timeout'}`；外部 timeout 须大于内部最坏值 |
| 高 | pipeline3.js:707-731 | `let stillUnconnected=0; try{d=await drc.check()}catch(e){log()}`；`if(stillUnconnected===0) break` | DRC 抛异常时停在初值 0 → 当成"已布通"提前退出，补铜与后续轮次全跳过 | `let stillUnconnected=Infinity;`；catch 内 `errors.push('iterDrc:'+e.message); continue;` |
| 高 | pipeline3.js:994-1005 | `netName=String(vv.getState_Net?.()\|\|'')`；`if(!isPourNet && netName.trim()) continue;` → `delete` | 读不到网名（内层 catch 吞）时保护条件短路 → 仍删 via，正是注释说的"删信号网 via 断整网" | `if(!netName.trim()){ log('viaKept',{via:viaObjId}); continue; }` |
| 高 | run-all.ps1:1280 "$mkOut = (& $py $mk $OutDir 2>&1"；run-overnight.ps1:68 | `(& $py $mk $OutDir 2>&1 \| Out-String)`；`(& pwsh ... run-all.ps1 ... \| Out-String)` | 两层子进程均无超时：python 卡住则在跑的进程永远不返回，整夜零进展且无告警（同一形态还有 L1408 的第二处） | `$p=Start-Process $py -ArgumentList $mk,$OutDir -PassThru; if(-not $p.WaitForExit(300000)){ $p.Kill() }`；overnight 包 2400s |
| 中 | pipeline3.js:1274-1276 | `ok: errors.length===0 && ... && drcPassed===true && schDrcErrors===0` | 6 个导出全 false 时 errors 不增长 → `ok:true` + `artifacts:[]`；`layoutState`/`imported` 也不在表达式内 | 追加 `&& exports.every(e=>e.ok) && artifacts.length>=6 && layoutState==='completed'` |
| 中 | pipeline3.js:164-169 | `if(bs.length===0 && boardsCreated===0){ createBoard(); boardsCreated++ }` | 自增早于验证：建板静默失败一次即永久停手，之后 8 轮×2 次 waitForReady≈16min 白等且超过 590s，连 `no board` 都报不出 | `if(await eda.dmt_Board.createBoard()!==undefined) boardsCreated++;`；循环内 `if(!board&&boardsCreated>=3) throw` |
| 中 | pipeline3.js:436-440 | `const r=await waitJob(job.jobId,420000); layoutState=r.state` | `TIMEOUT/ERR` 不进 ok 也不中止：布局作业可能仍在跑，后续焊盘枚举/铺铜/布线作用在**还动的板**上 | `if(r.state!=='completed') throw new Error('autoLayout '+r.state)` |
| 中 | pipeline3.js:858-874 | `for(i<n)for(j=i+1<n) if(hypot<=MERGE) uni(i,j)` | O(n²) 且按每个违规重建（×层×6 轮）；GND 通路锚点上千 → 单设计数十秒~数分钟纯 CPU，吃掉 590s | 1mil 整数网格分桶，只比同桶+8 邻桶 |
| 中 | pipeline3.js:816-878 | `anchorsByNet=new Map()` 在 `for round<6` **之外**采集 | 第 2 轮起看不到上一轮新补的线 → 同一缺口反复补重叠线（注释里"6 轮 12 条废线"的成因） | 每轮重采 lines，补线后 `addAnchor(net,x,y,layer,'r'+round)` |
| 中 | pipeline3.js:1263-1272 | `try{ saveFileToFileSystem(OUT+'\\_run.json',...) }catch(_){}` | 写失败被吞 → verify-artifacts 退回设计文件**原始**板框，自愈后实际板框丢失，判定比错对象 | `catch(e){ errors.push('_run.json: '+e.message) }` |
| 中 | run-all.ps1:1186 "$(if ($lastGoodRaw) { $lastGoodRaw } else { $raw })" | `Set-Content -Path $logFile -Value $(if ($lastGoodRaw) { $lastGoodRaw } else { $raw }) -Encoding UTF8` | 两轮 invoke 都异常时 `$raw` 为 null → `-Value $null` 抛参数绑定错误，掩盖真实原因、丢日志（**【片段已改写】**：现为 -Path/-Encoding 形式，null 那条路未变） | `if($raw){ Set-Content ... } else { Log '两轮均 invoke 异常' 'Red' }` |
| 中 | run-all.ps1:373 "$_.headless -eq $true -and $_.origin -eq 'cli'" | `$list \| Where-Object { $_.headless -eq $true -and $_.origin -eq 'cli' }` | 注释说"未绑定项目的裸会话"，代码没滤 projectId → 可复用别人工程的会话；候选数无上限、每个 30s 探活（28 个≈14min） | 加 `-and -not $_.projectId`，再 `Select-Object -First 3` |
| 中 | run-all.ps1:244-246,283 "function Acquire-Lock {" | `while((Get-Date) -lt $deadline){ ... Start-Sleep 10 }` | 单设计最多白等 90min（持有者 pid 被复用则判不出 stale）；`Release-Lock` 不校验归属，会删掉别人的锁 | 锁写 `pid+hostname`，Release 前校验；等待上限降到 15min |
| 中 | run-overnight.ps1:65 | `if($deadline -and (Get-Date) -ge $deadline){ break }` 仅在设计之间 | 单设计最坏 ~40min，越过 `-Until` 数小时；截止时间对"正在跑的这一个"无效 | 起新设计前用 `$deadline.AddMinutes(-40)` 预判；配合上条硬超时 |
| 中 | run-overnight.ps1:142 | `exit $(if(@($allRuns\|Where-Object ok).Count -gt 0){0}else{1})` | 一夜 300 次只成功 1 次也 exit 0，外部监控当健康 | 按最后一轮 `$roundPass/$roundFail` 或通过率阈值 |
| 低 | run-all.ps1:1264 "try { $py = Resolve-Python } catch { $py = $null }" | 原写死 `$py='C:\Users\UserX\.dsh\...\python.exe'` **已不存在**（现文件只剩 L1246 注释里的旧形态） | 本机用户是 `陶鑫旺`，恒不存在 → 原 `if(Test-Path $py)` 直接跳过，交付文档静默不生成（**【已修】**：解释器改由 Resolve-Python 解析，找不到会 Log 红字并计入 `$finalOk`） | 用 `Get-Command python` 兜 `$env:USERPROFILE`，找不到要 Log 红字 |
| 低 | run-overnight.ps1:57-58 | `$files=Get-ChildItem ... -EA SilentlyContinue; if(-not $files){ sleep 60; continue }` | `designs` 目录不存在时无限 60s 空转，不传 `-Until` 永不退出也不报错 | 先 `if(-not(Test-Path ...\designs)){ throw }` |
| 低 | pipeline3.js 多处 | 空 catch：71/232/411/456/473/531/733/740/789/942/948/1132/1234 | 有后果的是 473（删旧板框失败→留两条 outline，尺寸/DRC 全错）、733/740/789/942/948/1132（覆铜 rebuild 失败仍按"有铜"继续判）；余为几何/相机降级 | 统一 `catch(e){ log('swallow',{at:'行号',m:String(e&&e.message).slice(0,120)}) }` |

## 已排除（验证后无害，勿重复判断）

- **`cam()` 整体 try/catch（37-71）**：`REC` 为关时直接 return，异常只影响录屏画面。
- **`importChanges` 静默 false（411）**：不会假成功 —— `verify-artifacts.js:240-255` 用 Netlist 反查器件，空板必出 `器件缺失`。
- **`while($true)`（run-overnight:52）**：`-Until/-Rounds` 是显式设计，缺陷只在上表缺目录那条。
- **固定次数重试 5/8/4/6/3/4**：都有硬上限；问题在"单次预算 > 掐断线"，加次数只放大后果。
- **`waitJob` 内 `catch→return{state:'ERR'}`**：偏保守，不会无界等待；散落 `sleep()` 合计约 60s，可忽略。
- **createBoard 双板**：已知已修，不复报。

## Top 3 先修什么

1. **预算倒挂（高·3）**：内部 `waitJob(900000)` 比外部 590s 还长，等于"走强模式必被掐死"，掐断又变非 JSON、判设计失败、换板重烧。一条 wall clock 贯穿所有等待后，重试逻辑才有意义；否则调次数全是白调。
2. **两道闸门 fail-open（高·1+2）**：静态审计是电路错误唯一防线，产物校验是"自述成功、实体失败"唯一防线，都靠数 `[FAIL]` 判成败，脚本一崩即成 PASS。各一行 exit code 判断换全部产出可信。
3. **修复循环静默少做（高·4+5）**：DRC 异常即"已布通"，会跳过补铜、把断连拖到最终 DRC；误删信号 via 会造出"4 种板框全失败"的假性死循环。都不产生错结论，但把可控失败放大成整轮失败，排查只能翻 log。

另：第6条（子进程无超时）建议下次跑夜前修 —— 不产生错结论，只产生"看着在跑"的一整夜。
