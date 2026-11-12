# ctxpilot

> **See where your context window goes, catch leaked MCP secrets, safely cut prompt bloat, and manage everything directly inside Antigravity's Overview sidebar.**

`ctxpilot` (`ctx`) is an unofficial, zero-dependency CLI & **Antigravity Overview Hub patcher** (`v0.4.0`).

---

## Why `ctxpilot`?

- **Native Overview Hub (`ctx patch`):** Injects the full `CTXPILOT` panel directly inside Antigravity's Overview sidebar (with `app.asar.bak` backup, SHA-256 verification of untouched files, and instant `ctx patch restore`).
- **Zero telemetry:** Performs zero outbound network requests (unless you explicitly pass `--ping` to probe HTTP MCP endpoints).
- **CI-ready secret hygiene:** Detects plaintext tokens/passwords in `mcp_config.json`, masks them with prefix-free labels (`[REDACTED: bearer-token]`), and exits non-zero on failures.

---

## Quick Start

Run directly without installing (Node.js 18+):

```bash
npx github:eldarjobs/ctxpilot doctor --fix-suggest
npx github:eldarjobs/ctxpilot context
```

Or install globally (provides both `ctxpilot` and `ctx` commands):

```bash
npm install -g github:eldarjobs/ctxpilot
ctx patch install --restart   # Injects CTXPILOT hub directly into Antigravity Overview
```

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
- `--fix` — backs up `mcp_config.json`, moves plaintext tokens to OS User Env + `~/.gemini/.env`, and rewrites to `${ENV_VAR}`
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

### `ctx park` / `ctx unpark` / `ctx ro` / `ctx rw` / `ctx profile`

Safely unload unused MCP servers to cut static prompt bloat (moves definitions to `~/.gemini/config/mcp_disabled.json`), switch DB servers between `READONLY=true/false`, and sync `.agents/rules/00-active-mcps.md`:

```bash
ctx profile list
ctx profile code-docs --dry-run   # preview changes first
ctx profile db-ro                 # keep DB servers in READONLY=true + serena
ctx park mssql                    # park a single server
ctx unpark mssql                  # restore it
ctx ro mssql                      # enforce READONLY=true
```

### `ctx patch` (Overview Panel Integration inside Antigravity)

Injects the full `CTXPILOT` hub directly inside Antigravity's Overview sidebar (Context bar, Static Overhead breakdown, MCP Park & RO/RW toggles, Profiles, Doctor findings, Project Actions, Quick Prompts, Rules, Hooks, Skills, Token History) with SHA-256 verification of untouched files:

```bash
ctx patch install --dry-run   # preview version & build hash without modifying files
ctx patch install --restart   # verify, patch app.asar (backing up app.asar.bak), and relaunch
ctx patch ensure --restart    # idempotent: only patches if missing or outdated after Antigravity update
ctx patch status
ctx patch restore --restart   # restore original app.asar.bak anytime
```

### `ctx init` / `ctx hub init` / `ctx bench` / `ctx bundle`

- **`ctx init [nextjs|dotnet|node|python|auto]`**: Auto-detects stack and scaffolds lean `.agents/rules/01-stack-conventions.md` + `.agents/hub.json` (with `--dry-run` / `--force`).
- **`ctx hub init`**: Generates `.agents/hub.json` with detected `profile`, `actions`, and `prompts`.
- **`ctx bench [--run-hooks]`**: Audits rule bloat, `always_on` budget, and duplicate lines statically; pass `--run-hooks` to benchmark enabled hooks (`<150 ms` budget, `{}` stdin, 2s timeout).
- **`ctx bundle export | import`**: Exports `.agents/rules`, `hooks.json`, `hub.json`, and sanitized MCP server templates (`${ENV_VAR}`) to `ctxpilot-bundle.json`, and imports cleanly with `--dry-run` / `--overwrite`.

---

## Roadmap

- **`v0.1`**: Read-only `doctor` + `context` + `SECURITY.md` (done)
- **`v0.2`**: `ctx` alias, MCP profiles (`full`, `code-docs`, `db-ro`, `lean`), `park/unpark/ro/rw`, `--dry-run` (done)
- **`v0.3`**: Direct Antigravity Overview Hub injection via `ctx patch install | restore | status` with SHA-256 verification and `app.asar.bak` backup (done)
- **`v0.4`** (current): Smart Bloat Cutter & Workspace Auto-Profile in Hub, `doctor --fix`, `patch ensure`, `hub init`, `init` stack presets, `bench`, and sanitized `bundle export/import` (done)
- **`v1.0`**: npm provenance, SBOM

## Security & Compatibility

- Threat model: [`SECURITY.md`](./SECURITY.md)
- Verified on Antigravity `2.31.2` (Windows 11, Node.js `v24.18.0`; CI tested across Linux, macOS, and Windows).
- Unofficial community project; not affiliated with Google.

## License

[MIT](./LICENSE)
