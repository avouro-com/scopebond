---
"@scopebond/agent": patch
---

Scopebond appears in Windows Settings -> Apps for an agent installed with npm. `setup` and `autostart on` write a per-user
entry (Scopebond Agent, Avouro LLC, the version; no administrator rights) whose Uninstall runs the agent's own `uninstall`
(autostart off, the agent stopped, the hook taken out of the coding agents' settings, the workspace told) and then
`npm uninstall -g @scopebond/agent`. `uninstall` removes the entry. The Scopebond folder stays, so installing again is the
same computer; `uninstall --purge` deletes it.
The Uninstall script is written as UTF-8 with a byte-order mark, so Windows PowerShell 5.1 reads a profile folder with
non-ASCII letters (or a typographic apostrophe) correctly, and it says "removed" only when it worked: when the agent was
already gone or its own uninstall failed, it says what did not happen and exits 1.
