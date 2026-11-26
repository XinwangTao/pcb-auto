# DRC 悬空 id 与 `why` 模板 · 静态分析

样本 `out\ESP32S3_Wireless_Mic_V3-20261126-171654\`（`_run.json` 是 `_run-4-expand-1.25x-retry2.json` 的副本）。全部结论来自磁盘遥测 + `scripts\pipeline3.js` 静态阅读，**未调用 EDA**。

## 结论 1 · `clearanceRevertDangling: ["cebe39d38d03e46a"]`
- **它是 Track（走线）id**：16 位小写 hex。`[实测]` 同一次运行里该 id 出现在 `_log.json` #200/#206/#207 的 `clearanceThinHopeless.line` / `clearanceCorridorNone.line` / `trackDogleg.line`，net=GND、线宽 10mil；而 19 位 hex 的 id 一律出现在 `objId` 位（Slot Region / SMD Pad，如 `78ca1fd552a4c00fe37`）。`[推断]` 16 位 = Track，19 位 = 复合图元；依据是上面两组字段的归属分别是 `line` 与 `objId`。
- **写入点**：`pipeline3.js:3075` `for (const id of restoreFail) danglingLines.add(id)`；另一处是 `2290-2291` 的 `rollbackLineFix`（dogleg/L 形失败）。`[实测]` 本次运行有 `clearanceRevertLineRestoreFail` + `clearanceRevertGaveUp`，**没有** `rollbackLineFail`/`rollbackModifyFail` ⇒ 走的是 3075。
- **判定逻辑**：dogleg 分支 `3800-3804` 先 `pcb_PrimitiveLine.modify(trackId,{endX,endY})` 把这条 GND 线**截短**并 `recMod` 记下原端点，随后 `create` 两段桥接铜（`recNew`）。轮末因断网 4→8 触发整轮回滚（`2987`）；回滚 `3055-3058` 用 `modify(m.id,{endX:原值,endY:原值})` 想改回去，返回 `undefined`（API 约定失败 resolve `undefined` 而不抛）⇒ 进 `restoreFail` ⇒ 进 `danglingLines`。
- **不是「删了没还原」**：`[实测]` `delFail: []`，`deleted: 8` 全部是 `delete()===true` 的成功删除。它是**回滚动作自己失败**造成的：线仍被截短，而两段桥接铜已删掉 ⇒ 该处是真实缺口（但见下条）。
- **`connFrom 4 → connTo 8` 与它不是同一原因**：`[实测]` 4 个 attempt **全部**记录 `connFrom:4, connTo:8`，而 `cebe39d38d03e46a` 只在第 4 次（retry2）出现 ⇒ 4→8 是 round 0 整轮改动的净效果；`[推断]` 且 `connTo` 取自**回滚之前**那次 DRC（`2971/2982/2992`），悬空 id 在回滚**之后**才产生。`[实测]` 回滚后 `connAfterClearance.n` 仍为 8 ⇒ 回滚没把断路数降回 4。哪一条断点属于这个缺口 `[未证实]`（回滚后无逐对象复检）。

## 结论 2 · `why` 原样模板 / `byNet:"?"`
- **占位符来源**：DRC 返回的 `explanation.errData.{minDistance,clearance,obj1,obj2}`。`why` 由 `compactLeaves`（`4610-4621`）把 `explanation` 的字符串字段拼成 `k=v`，`[推断]` 实测 `k` 就是 `str` ⇒ `explanation.str` 本身是**未替换的模板**，不是我们拼错。
- **能不调 EDA 填上的**（主样本 33 叶，24 叶进 `sample`）：`[实测]` `{minDistance}`→`cur`、`{shouldBe}`→`need` **24/24 可填**（`4597/4605`，`round(v*10)`，画布单位 ×10 = mil）。
- **填不上的**：`{obj1}`/`{obj2}` **0/24** —— `compactLeaves` 只落 `obj1Type`（`ot`），既没落 id 也没落 `obj1Suffix`，pipeline3 全程不读 suffix。`[实测]` 靠坐标 join `clearDiag.o1/o2` 只补到 **4/24**（clearDiag 被 `4727` 的 `slice(0,8)` 截断，且属另一次 DRC 调用）。余 20 条 `[未证实]`；`explanation.param` 是否另有真值 `[未证实]`（153 份日志里 `param` 出现 0 次）。
- **`?` 的 fallback**：`pipeline3.js:4690` `const k = x.net || '?';`，`net` 来自 `4601` 的 `ed.net || n.net || null`。`[实测]` 全语料 536 条 Clearance Error 的 net **全为 null**、513 条 Connection Error 的 **全非 null** ⇒ 不是「没读」，是 DRC 对间距违规不填这个字段（两侧本就可能不同网，没有单一「本网」）。

## 证据等级
`[实测]` 9 条 · `[推断]` 4 条 · `[未证实]` 4 条。`[未证实]` 的三项：本条缺口对应哪条 Connection Error、20/24 个 obj 占位符、`explanation.param` 是否有独立真值。
**可信度上限**：当前 `scripts\pipeline3.js` 是 sha256_12=`c497db1cf9b2`（305270B, mtime 11-26 17:47:18），而 `_pipeline_rev.txt` 记录的运行版本是 `0569c03010ef`（304492B）——该版本已被覆盖、磁盘上无副本，故上述**行号取自当前文件**，与实跑版本逐字节一致这一点 `[未证实]`。

STATUS={"status":"ok","changed":["out/_probe/DRC-DANGLING-AND-WHY.md"],"verify":{"cmd":"Get-Content out\\_probe\\DRC-DANGLING-AND-WHY.md | Measure-Object -Line","exit":0},"reason":"两问均定性：悬空 id 是 Track 在被回滚 modify 失败后留在截短态（delFail 为空，非删除未还原），conn 4→8 与它无关（4 次 attempt 恒 4→8 而该 id 仅第 4 次出现）；why 是 explanation.str 原始模板，minDistance/shouldBe 24/24 可从 cur/need 填，obj1/obj2 仅 4/24 可经 clearDiag join 补，? 来自 L4690 的 net||'?'。"}
