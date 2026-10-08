---
"@scopebond/agent": patch
---

Beside the native Scopebond tray (the signed Windows install) the agent no longer listens on 127.0.0.1: its tray and its hook (the same program) reach it over its named pipe. npm installs keep the loopback port for now, because the PowerShell tray and hooks before the pipe use it (`SCOPEBOND_AGENT_LOOPBACK=0` still turns it off). `startControl` takes `{ loopback }`.
