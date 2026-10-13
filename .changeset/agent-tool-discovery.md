---
"@scopebond/agent": minor
---

The agent reports which AI coding tools are present on this computer and whether the Scopebond hook checks them. Every
self-check (daily, and on each start) now sends two optional lists: `tools` (Claude Code, Cursor, Codex, GitHub Copilot
CLI, Windsurf, Gemini CLI, Cline, OpenCode, Aider: id, installed version or null, `governed`, `settings_present`; at most
20) and `mcp_servers` (the names, only, of the MCP servers in each tool's user-level MCP configuration; at most 100, each
at most 120 characters). A version is read from the global npm install's package manifest, or from `--version` for the
programs known to answer it and exit (3 s limit); no tool is started in a way that opens a session. No path, command,
argument, environment value or address is sent. `scopebond-agent status` and `status --json` show the tools.
