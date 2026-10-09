---
"@scopebond/agent": patch
---

`scopebond-agent.exe setup <workspace-url>` works after the signed Windows installer on a computer without Node or npm:
the single executable counts as installed (no `npm install -g`), autostart starts the executable itself, and the status
and the retry hint name the executable. The daily self-check also says how the agent was installed (`install_kind`: npm,
per-user or per-machine), so a workspace can show it.
