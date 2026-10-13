---
"@scopebond/agent": minor
---

The agent reports which AI coding tools are present on this computer and whether the Scopebond hook checks them. Every
self-check (daily, and on each start) now sends two optional lists: `tools` (Claude Code, Cursor, Codex, GitHub Copilot
CLI, Windsurf, Gemini CLI, Cline, OpenCode, Aider: id, installed version or null, `governed`, `settings_present`; at most
20) and `mcp_servers` (the names, only, of the MCP servers in each tool's user-level MCP configuration; at most 100, each
at most 120 characters). The inventory is reported by the agent over its authenticated connection and is not covered by
the self-check signature, so the workspace labels it "as reported on <day>". A tool counts as present only when its
user-level settings exist; `governed` means the hook is in the tool's user-level settings file (a project-only install
shows as not governed). A version is read from the global npm install's package manifest, or from `--version` for a
present tool whose program is known to answer it and exit (3 s limit); no tool is started in a way that opens a session.
No path, command, argument, environment value or address is sent. `scopebond-agent status` and `status --json` show the
tools.
