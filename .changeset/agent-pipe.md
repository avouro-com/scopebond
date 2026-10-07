---
"@scopebond/agent": minor
"@scopebond/hook": patch
---

The Scopebond Agent's local channel now runs over a named pipe on Windows (a random name, kept in `agent.json` in the user's own Scopebond folder) and a Unix socket elsewhere (in a folder only the user can open, the socket itself 0600). Another user can neither find nor open them, unlike a loopback port, which any program on the computer can reach. The `scopebond-agent` commands and the hook's override window use it; the token is still required. The loopback port stays on for one more release, for the PowerShell tray, and `SCOPEBOND_AGENT_LOOPBACK=0` turns it off.
