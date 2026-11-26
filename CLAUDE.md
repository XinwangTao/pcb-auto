# CLAUDE.md

This repository's operating contract lives in [AGENTS.md](AGENTS.md). Read it before changing
anything — it lists the three hard prohibitions and the reasons for each.

Claude-specific additions:

## Use the plugin, don't re-implement the pipeline

This repo ships a Claude Code plugin (`.claude-plugin/plugin.json`) and an MCP server
(`.mcp.json` → `mcp/server.mjs`). If you need to build a board or check one:

```
pcb_idea_to_design   Chinese idea → design JSON
pcb_build            design JSON → manufacturing files (2–20 min)
pcb_fabcheck         the authority on "can this be ordered as-is"
pcb_census           pass rate over the whole corpus
pcb_verify           delivery consistency assertions
```

If the MCP server is not connected, the same five operations are available as a zero-dependency CLI:

```bash
node cli/pcb.mjs list
node cli/pcb.mjs fabcheck examples/d1
```

## The one rule that matters most

**Orderability is `pcb_fabcheck`'s exit code, never `_run.json.ok`.**
They answer different questions. See [AGENTS.md](AGENTS.md) §三条不许.

## Never

- Add ESM `import`/`export` to `scripts/*.js` — the root `package.json` deliberately has no
  `"type": "module"` and every `.js` under `scripts/` is CommonJS. Use `.mjs` for new ESM code.
- Quote a number without its denominator, settle window, and as-of time.
- Claim a board has been manufactured. None has.
- Use `os.kill(pid, 0)` on Windows to probe liveness — it calls `TerminateProcess`.
