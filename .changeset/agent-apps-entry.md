---
"@scopebond/agent": patch
---

Scopebond appears in Windows Settings -> Apps for an agent installed with npm. `setup` and `autostart on` write a per-user
entry (Scopebond Agent, Avouro LLC, the version; no administrator rights) whose Uninstall runs the agent's own `uninstall`
(autostart off, the agent stopped, the hook taken out of the coding agents' settings, the workspace told) and then
`npm uninstall -g @scopebond/agent`. `uninstall` removes the entry. The Scopebond folder stays, so installing again is the
same computer; `uninstall --purge` deletes it.
