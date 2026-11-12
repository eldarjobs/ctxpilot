---
name: active-mcp-servers
description: MCP servers enabled via ctxpilot and how to use them proactively.
trigger: always_on
---

# Proactive MCP Tool Usage Policy

Active MCP servers in this workspace. Use their tools proactively when relevant:

**Serena first for code navigation**: call serena `initial_instructions` once per session, then prefer Serena symbol tools over text grep.

- **serena**: Tools: activate_project, initial_instructions, serena_repl.
- **microsoft-learn**: Tools: microsoft_code_sample_search, microsoft_docs_fetch, microsoft_docs_search.
- **graphify**: Tools: get_community, get_neighbors, get_node, get_pr_impact, god_nodes, graph_stats, list_prs, query_graph, shortest_path, triage_prs.
- **context7**: Tools: query-docs, resolve-library-id.
- **sequential-thinking**: Tools: sequentialthinking.

Parked/disabled servers (do not rely on them): mssql.
