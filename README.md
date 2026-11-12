# ctxpilot

> **See where your context window goes, catch leaked MCP secrets, and safely cut prompt bloat — without patching the app.**

`ctxpilot` is an unofficial, zero-dependency, read-only CLI diagnostic and context-budget analyzer for Antigravity workspaces (`v0.1`).

---

## Why `ctxpilot`?

- **Zero app patching:** Runs strictly read-only on your local configs (`~/.gemini/`, `.agents/`). Never modifies binaries.
- **Zero telemetry:** Performs zero outbound network requests (unless you explicitly pass `--ping` to probe HTTP MCP endpoints).
- **CI-ready secret hygiene:** Detects plaintext tokens/passwords in `mcp_config.json`, masks them with prefix-free labels (`[REDACTED: bearer-token]`), and exits non-zero on failures.

---

## Quick Start

Run directly without installing (Node.js 18+):

```bash
npx github:eldarjobs/ctxpilot doctor --fix-suggest
npx github:eldarjobs/ctxpilot context
```

*(Once published to npm, `npx ctxpilot doctor` and `npx ctxpilot context` work identically.)*

---

## Commands

### `ctxpilot doctor`

Audits MCP configs, database `READONLY` flags, stdio binaries, remote URLs, rule size caps (`24,000` bytes/file, `20,000` tokens `defaultRulesBudget`), and `.agents/hooks.json`.

```text
ctxpilot doctor (read-only)
Workspace: ~/projects/my-app
────────────────────────────────────────────────────────────────────
  [OK]   ~/.gemini/config/mcp_config.json        Valid JSON
  [OK]   context7                                http (mcp.context7.com)
  [FAIL] context7                                Plaintext [REDACTED: bearer-token] in headers.Authorization
  [OK]   serena                                  stdio (serena.exe)
  [OK]   mssql                                   stdio (node)
  [OK]   mssql                                   READONLY=true (safe) | host=localhost
  [OK]   .agents/rules/                          15 file(s) | largest: 13.9 KB / 24.0 KB limit
  [OK]   .agents/hooks.json                      Valid JSON (3 hook group(s))

Suggested ${ENV_VAR} replacements (no files were modified):
  - context7.headers: "Authorization": "Bearer ${CONTEXT7_API_KEY}"
────────────────────────────────────────────────────────────────────
Summary: 7 ok, 0 warning(s), 1 failure(s).
```

Flags:
- `--fix-suggest` — prints `${ENV_VAR}` replacement snippets without writing files
- `--strict` — exit code `1` on warnings as well as failures
- `--json` — machine-readable JSON (secrets remain redacted)
- `--ping` — opt-in `HEAD` check on HTTP MCP URLs
- `--workspace <dir>` — target a specific workspace

### `ctxpilot context`

Measures **Rules**, **Active MCP Tool Schemas**, **Skills metadata**, and latest conversation telemetry (`transcript.jsonl` v1 adapter) so you know exactly which MCP server costs the most tokens per turn.

```text
ctxpilot context (workspace: ~/projects/my-app)
──────────────────────────────────────────────────────────────────
1. Always-On Rules (Antigravity defaultRulesBudget: 20,000 tok)
   8 always-on file(s) (22.8 KB)     ~5,842 tok  (est +/-20%)
   7 conditional rule(s) (loaded on demand: 59.1 KB)

2. Active MCP Tool Schemas
   mssql                  (23 tools)   15.9 KB   ~4,649 tok  (est +/-20%)
   graphify               (10 tools)    6.1 KB   ~1,783 tok  (est +/-20%)
   context7               ( 2 tools)    4.8 KB   ~1,412 tok  (est +/-20%)
   sequential-thinking    ( 1 tool )    3.9 KB   ~1,152 tok  (est +/-20%)
   microsoft-learn        ( 3 tools)    3.7 KB   ~1,085 tok  (est +/-20%)
   serena                 ( 3 tools)    3.6 KB   ~1,053 tok  (est +/-20%)
   MCP Subtotal: ~11,134 tok (46% of ~24,018 tok static overhead)

3. Skills Metadata (progressive disclosure)
   113 skill(s) (27.5 KB)            ~7,042 tok  (est +/-20%)

4. Latest Conversation (transcript adapter v1)
   Conversation: example-session-01
   Context used: 303,178 tok (Cache hit: 98.7%)
   Last output:  253 tok
──────────────────────────────────────────────────────────────────
Note: Rules have a separate defaultRulesBudget (20k tok); Static Overhead sums Rules + MCP Schemas + Skills.
Tip: Parking "mssql" (23 tools) when unused saves ~4,649 tok/turn (approx +/-20%).
```

---

## Roadmap

- **`v0.1`** (current): Read-only `doctor` + `context` + `SECURITY.md`
- **`v0.2`**: MCP Task Profiles (`Code & Docs`, `DB Audit RO`, `Lean`) + `--dry-run`
- **`v0.3`**: Official Sidecar UI Plugin (zero-patch aux pane) + Hooks panel + stack presets (`nextjs`, `dotnet-clean`)
- **`v0.4`**: Team bundle export/import with fuzz-tested secret sanitizer
- **`v1.0`**: Optional `--experimental-asar-patch` mode, npm provenance, SBOM

## Security & Compatibility

- Threat model: [`SECURITY.md`](./SECURITY.md)
- Verified on Antigravity `2.31.2` (Windows 11, Node.js `v24.18.0`; CI tested across Linux, macOS, and Windows).
- Unofficial community project; not affiliated with Google.

## License

[MIT](./LICENSE)
