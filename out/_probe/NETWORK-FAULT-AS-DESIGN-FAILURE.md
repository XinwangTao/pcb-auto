# 一次网络故障被记成了一次「布局退化」

测于 2026-11-26T19:20+08:00。对象：`out\ESP32S3_Wireless_Mic_V4-20261126-185013`。

## 事实链

同一设计、同一 heal 阶梯的 4 次尝试，第 3 次突然退化：

| 尝试 | 板框 | 用时 | errors | mismatches | DRC 叶子 |
|---|---|---|---|---|---|
| 1 smart-fit | 1300×3700 | 472 s | 0 | 0 | **5** |
| 2 expand-1.25x | 1625×3700 | 502 s | 0 | 0 | **5** |
| 3 expand-1.25x-retry | 1625×3700 | 431 s | **14** | **12** | **8** |

第 3 次那 14 条错误的头一条是：

```json
"add U5: {\"ok\":false,\"error\":{\"code\":\"INTERNAL_ERROR\",
 \"message\":\"获取来源库器件失败: Network Error!\"}}"
```

剩下 13 条全是它的下游：`pin missing U5.13` / `U5.8` / `U5.18` / `U5.25` … —— U5 根本没放上去，
所以它的每个引脚都"缺失"。

**一次网络抖动，产出 14 条看起来像设计缺陷的错误，把 DRC 叶子从 5 抬到 8。**
heal 阶梯据此认为这块板退化了，第 4 轮又扩了一次板。

## 三个缺陷（都缺）

1. **该重试的没重试。** `pipeline3.js:502` 在 `add` 返回 `ok:false` 时直接 `continue`。
2. **两条失败通道只有一条被看见。** `sch_SourcePrimitiveComponent.add` 既可能抛异常、
   也可能返回 `{ok:false}`。实测这次走的是后者；只包一层 `try/catch` 的写法对前者有效、对后者无效。
3. **环境故障与设计缺陷共用一个通道。** `_run.json.gates` 里只有 `errors`，读盘者无法分辨
   "板子不行"和"网络断了"——而两者的处置完全相反（改设计 vs 重试）。

## 已做的修复

`scripts/pipeline3.js`（sha256_12 `C497DB1CF9B2` → `526A326A806C`，+2463 B）：
- `add` 的两条通道收敛成同一个 `{ok:false, error:{...}}` 形状，再统一重试 3 次（800/1600 ms 退避）。
- 只对**瞬时**错误重试：`Network Error|INTERNAL_ERROR|ETIMEDOUT|ECONNRESET|socket hang up|timeout`。
  错料这类非瞬时失败**不重试**（否则白白多打两次库服务，还把错误放大）。
- 重试耗尽后，瞬时故障**同时**进 `gates.envFaults` 与 `errors` —— 两个字段，两种含义。
- `resolveParts` 的 `getByLcscIds` 同样重试：它是同一类网络依赖，失败会早退成
  `stage:'resolveParts'`，看起来像"料号不存在"。
- 每次尝试都 `log('addAttempt')` / `log('addFailed')` —— 只记最终失败会丢掉"试过几次"。

## 证明

`test` 层面的证明在提交信息里；要点是**四个场景都跑真实字节**（从补丁后的文件里抽出那段代码，配 stub `eda`）：

| 场景 | 期望 | 实测 |
|---|---|---|
| 瞬时故障 2 次后成功 | add 调 3 次、放置 1、envFaults 0 | ✓ |
| 一直瞬时故障 | add 调 3 次、放置 0、envFaults 1、errors 1、addAttempt 3 条 | ✓ |
| 非瞬时故障（错料） | add 调 **1** 次、envFaults **0** | ✓ |
| 抛异常(Network Error) 1 次后成功 | add 调 **2** 次、放置 1 | ✓ |

第四条是关键：它证明**抛异常那条通道也进了重试**。没有它，"两条通道"这个修复无法被验证。

## 还没做的

`run-all.ps1` 的 heal 阶梯仍然把带 `envFaults` 的尝试当成设计证据（它只看 `ok`）。
正确做法是：`gates.envFaults > 0` 的尝试**不进**最好/最坏比较，并重试同一档位而不是降级到下一档。
没做是因为该文件在构建期间锁定，且改控制流的回归面比改 `pipeline3.js` 大得多。
在补上之前，读 `_run.json` 的人**必须**同时看 `gates.envFaults`，否则会把网络故障读成板子不行。
