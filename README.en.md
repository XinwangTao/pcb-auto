# pcb-auto

[中文](README.md) | **English** | [Demo video (31.6s)](https://github.com/XinwangTao/pcb-auto/releases/download/v1.0.0/ai-pcb-v9.mp4)

> Compile a single Chinese natural-language board idea into fabrication-ready PCB artifacts —
> Gerber, Excellon drill, BOM, pick-and-place — with **zero human intervention**.
>
> ```powershell
> pwsh -NoProfile -File .\run-all.ps1 -Idea "做一个 SHT30 温湿度传感器，带 LED 指示和排针引出"
> ```

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-blueviolet.svg)](mcp/server.mjs)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)](#honest-limitations)

> **Every frame of the demo is a screen recording of an AI actually driving LCEDA Pro** —
> schematic wiring → PCB import → auto-layout → copper pour → auto-routing → final.
> Not an animation mock-up. Source clips live in
> [`video/public/real/`](video/public/real/) (6 clips, 3.9 MB) and can be re-rendered.

---

## One command, any agent

Five operations live in exactly one file ([`core/ops.mjs`](core/ops.mjs)). Everything else is a thin
adapter.

| Access path | File | Works with |
|---|---|---|
| **CLI** (zero dependencies) | [`cli/pcb.mjs`](cli/pcb.mjs) | **any** agent that can run a shell command |
| **MCP server** (zero dependencies) | [`mcp/server.mjs`](mcp/server.mjs) | **any** MCP client |
| DSH plugin (Cordis bundle) | [`plugin/`](plugin/) | DeepSeek Harness |
| Claude Code plugin | [`.claude-plugin/`](.claude-plugin/) + [`.mcp.json`](.mcp.json) | Claude Code |

```bash
node cli/pcb.mjs list                    # self-describing list of the 5 operations
node cli/pcb.mjs fabcheck examples/d1         # the exit code is the answer
node install/install.mjs --list          # 19 client configurations
```

**Full platform matrix with verification levels: [docs/SUPPORT.md](docs/SUPPORT.md)** — covers Claude
Code, Cursor, Windsurf, VS Code Copilot, Zed, Cline, Roo Code, Continue, Codex CLI, Gemini CLI,
OpenHands, Goose, Amazon Q, DSH, and Chinese platforms including Tongyi Lingma, CodeBuddy, Trae,
MarsCode, Zhipu, Kimi and iFlyCode — plus every MCP or shell client.

No per-platform work is needed because **MCP and CLI are protocols, not platforms**. Any client
that implements MCP 2025-06-18 works today, without a new release.

## Measured, with denominators and timestamps

Measured **2026-11-26 10:08 +08:00**, settle window 180 s. Recompute it yourself:

```bash
node cli/pcb.mjs census --settle 180
```

| Metric | Value | Denominator |
|---|---|---|
| Settled product directories | 56 | dirs with a `_run.json`, 0 in flight |
| Orderable (`fabcheck` exit 0) | **53** | / 56 = 94.6 % |
| Blocked | **3** | / 56 = 5.4 % |
| Board names orderable at least once | **42** | / 44 = 95.5 % |
| Board names never orderable | **2** | / 44 |
| Self-report `ok=true` but actually blocked (dangerous) | **0** | / 56 |
| Self-report `ok=false` but actually orderable (pessimistic) | **5** | / 56 |

> **The denominator moves.** With settle 0 / 180 / live scan, the same `out\` directory yields three
> different, all-legitimate counts. A number without its timestamp and window is not a record.

**Why `_run.json.ok` is not the verdict**: it answers "did the pipeline finish without error".
`fabcheck` answers "can these files go to a fab". Across these 56 directories the two disagreed in
the dangerous direction **0 times** and the pessimistic direction **5 times**. That is a
measurement, not a guarantee — orderability is always `fabcheck`'s exit code.

## Honest limitations

1. **No board produced here has ever been manufactured or electrically validated.** Every
   "orderable" claim is about files, not about a working circuit.
2. **Windows only.** Requires PowerShell plus a Windows-only EDA server process.
3. **One EDA vendor only** — 嘉立创 EDA (LCEDA).
4. **The autorouter is not good enough to trust blind**: 2 of 44 board names never produced an
   orderable directory. The retry ladder (larger board frame each time) often makes DRC **worse** —
   one design went from 1 DRC group to 2 with SMD-pad violations rising from 1 to 46.
5. **Thirteen confirmed documentation errors are disclosed, not silently fixed** — 6 in the HTML
   dossier, 7 wrong + 7 stale in the delivery README. They are listed verbatim in
   [`交付-README.md`](交付-README.md) under 已知限制, with the reasoning.
6. This repository asserts **no** star counts, download counts, or user testimonials.

**Why it claims to be better, and where it is worse: [docs/WHY.md](docs/WHY.md).**

---

## Independent verification: never trust the pipeline's self-report

**`DRC passed` ≠ the board is correct.** [`scripts/verify-artifacts.js`](scripts/verify-artifacts.js)
reads only the artifacts under `out/<run>/` and cross-checks them against the design intent.

| Check | Criterion |
|---|---|
| Component completeness | every `(des, lcsc)` present in `Netlist.json`, same part; no extras |
| Net connectivity | every design `(des, pin, net)` matches `pinInfoMap[*].net` |
| BOM | merged **by material**; `Quantity` sum equals component count; designator sets match |
| PnP | row count equals component count; coordinate span inside the outline; no coincident parts |
| **Gerber copper** | parses `D01/D03` primitives in GTL/GBL — **fewer than 20 primitives is judged zero copper** |
| Gerber layers | 8 required layers plus at least 2 drill files |
| Outline | the GKO file contains draw commands (closed contour) |

This check caught a defect the pipeline could not see: at a 200×200 outline the pipeline reported
`ok=True / DRC=0`, but at 2194×1675 the bottom-layer copper contained **only 9 primitives** —
essentially no copper. Trusting the self-report would have shipped an empty board.

```powershell
node scripts\verify-artifacts.js --latest designs\d6-rp2040-minimal.json
node scripts\verify-artifacts.js out\<run-dir> designs\<design>.json
```

Exit code 0 means pass. Falsifiability check: corrupt any net name in the design and the verifier
immediately reports `X.n expected A, got B` and exits 1.

## Electrical sanity checks (items 15–17 of the 17)

**Complete artifacts plus zero DRC violations still can be a scrap board.** This layer caught three
real design defects:

| Design | Defect | Did DRC report it? |
|---|---|---|
| d2 / d3 | SHT30 **SDA/SCL not connected at all**; pull-ups tied to dangling net names | No |
| d6 | RP2040 **all six QSPI lines floating** (cannot boot without Flash); RUN has no pull-up | No |

---

See [AGENTS.md](AGENTS.md) for the machine-facing operating contract,
[llms.txt](llms.txt) for the LLM entry point, and [docs/WHY.md](docs/WHY.md) for the comparison.

License: [MIT](LICENSE). Scope and the "no board has been manufactured" disclaimer are in
[NOTICE.md](NOTICE.md) — kept out of `LICENSE` on purpose, because appending prose there
makes GitHub report the license as `NOASSERTION`. **No warranty. Do not order a board
without independent review.**
