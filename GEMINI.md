# GEMINI.md

Operating contract: [AGENTS.md](AGENTS.md). Read it first.

Gemini CLI additions: the same five operations are exposed over MCP (`mcp/server.mjs`) and over a
zero-dependency CLI (`cli/pcb.mjs`). To register the MCP server:

```bash
node install/install.mjs --print gemini-cli
```

That prints a `mcpServers` snippet for `~/.gemini/settings.json`. (The snippet shape is the standard
MCP `mcpServers` form; the exact file path is documented but was **not** verified on this machine —
`docs/SUPPORT.md` marks its verification level honestly.)

Without any configuration at all, these work:

```bash
node cli/pcb.mjs list
node cli/pcb.mjs fabcheck out/d1
node cli/pcb.mjs census --settle 180
```

Non-negotiables:

- Orderability is `pcb_fabcheck`'s exit code, never `_run.json.ok`.
- Every number needs a denominator, a settle window, and an as-of time.
- No board in this repository has been physically manufactured.
- Do not add ESM syntax to `scripts/*.js` (every CommonJS file there depends on the root package having no
  `"type": "module"`). New ESM code goes in `.mjs` files.
