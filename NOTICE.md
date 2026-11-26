# NOTICE / 范围说明

> 这份说明**故意不放在 `LICENSE` 里**。GitHub 的许可证识别器要求整篇是规范的 MIT 原文，
> 追加任何散文都会让它报 `NOASSERTION`（看起来像「许可证不明」）—— 实测过。
> 所以 `LICENSE` 保持纯净，范围约束放在这里，并在 README 里链过来。

## 许可证覆盖什么

`LICENSE` 里的 MIT 覆盖本仓库的**源代码与文档**。

它**不**覆盖：

- 第三方商标；
- 厂商 CAD 元件库；
- EDA 工具链输出的产物（Gerber / BOM / PnP 等），其条款由各自厂商与 EDA 供应商决定。

## `designs/` 与 `out/` 的性质

`designs/` 下的设计、`out/` 下的制造文件，是**为复现与研究**而按原样提供的。

**本项目产出的板子，没有任何一块被真正制造出来过，也没有做过电气验证。**
所有「可打样」都是**文件层面**的判断（`pcb_fabcheck` 的退出码），不是「焊出来能用」。

没有独立复核，不要直接下单。

同样的话也写在 [README.md](README.md)、[docs/WHY.md](docs/WHY.md)、[llms.txt](llms.txt) 与
[GEMINI.md](GEMINI.md) 里 —— 重要的话说四遍不算多。
