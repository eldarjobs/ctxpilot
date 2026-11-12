# Security Policy & Threat Model

`ctxpilot` `v0.1` is **strictly read-only** and runs **100% locally**.

## What `ctxpilot` Reads
- User MCP config files under `~/.gemini/` (`mcp_config.json`, `mcp_disabled.json`, `mcp_toggles.json`, and tool schemas in `antigravity/mcp/`).
- Workspace `.agents/` rules, hooks, skills, and root instruction files (`AGENTS.md`, `GEMINI.md`, `CLAUDE.md`).
- The tail (last `64 KB`) of the most recent conversation `transcript.jsonl` to read token counters.

## What `ctxpilot` Never Does
- **Zero telemetry:** No analytics, crash reporting, update checks, or outbound network calls on `doctor` or `context` (the only optional network probe is `doctor --ping`, which issues a `HEAD` request with no auth headers when explicitly requested).
- **Zero secret echoing:** Detected tokens, API keys, Bearer headers, and connection passwords are replaced in memory with type-only markers such as `[REDACTED: bearer-token]` or `[REDACTED: api-key]`. Not even key prefixes are printed in terminal or `--json` output.
- **Zero mutations in `v0.1`:** `doctor` and `context` never modify any configuration, rule, or application binary.

## Reporting Issues
Please open a GitHub Security Advisory or issue without pasting unredacted configuration files.
