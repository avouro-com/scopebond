---
"@scopebond/agent": patch
"@scopebond/gateway": patch
"@scopebond/hook": patch
"@scopebond/mcp": patch
---

The tray no longer says a plan change lifts the workspace's monthly limit unless the workspace said so (then it names the limit that plan gives); the record exporter treats a redirect as a failed delivery and retries, never sending records on; an unsent "Ask an admin" request is never dropped to make room in `requests.json`; the typed MCP adapter checks its config at start and approves a resource only on an exact match in a list; `policy load --yes` in a trusted project keeps the loaded policy trusted, so it is the one that governs; `dedupe --keep plugin` with no enabled Scopebond plugin changes nothing, and dedupe backs up and replaces a settings file whole; autostart health checks that the sign-in entry starts this home's launcher, a systemd unit writes `%` and `$` literally, and a Windows home path with `%` is refused; the agent's loopback channel refuses a foreign Host and any request with an Origin.
