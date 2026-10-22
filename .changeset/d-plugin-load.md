---
"@scopebond/hook": patch
---

The optional signed plugin loads faster: its checked bytes are handed to Node's module loader from memory instead of through a `data:` URL (on Node versions with `module.registerHooks`), which saves several milliseconds on every tool call. The first answer a plugin gives in a process may take up to 25 ms, since its code runs for the first time there; later answers keep the 2 ms budget. Loading the plugin no longer prints a Node experimental-feature warning into the coding agent's transcript.
