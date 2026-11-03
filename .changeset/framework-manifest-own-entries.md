---
"@scopebond/framework": patch
---

The tool guard maps a tool name through the manifest's own entries only. A tool named like an Object prototype member (`constructor`, `__proto__`, `toString`) is no longer mapped by the prototype (which made the check throw or record a malformed action type); it is `tool.<name>` like any other unmapped tool, governed under the closed allowlist.
