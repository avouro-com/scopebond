---
"@scopebond/agent": patch
---

The Scopebond Agent no longer passes code-loading Node.js variables to what it starts, and a machine-wide workspace setting wins over a per-user one.

- `NODE_OPTIONS` and `NODE_REPL_EXTERNAL_MODULE` are removed from the agent's environment when it starts, so no process it starts (the updated agent after a self-update, the hook's commands, npm, the installer helper) inherits them. Any program running as the person can set them for every later sign-in to load its own code into a Node.js program. The Windows tray also starts the agent without them.
- A signed install's first sign-in now reads the `Workspace` value under `HKLM\Software\Avouro\Scopebond` (written by a per-machine install) before the one under `HKCU`, so a per-user value cannot move a computer an administrator deployed for one workspace to another.
