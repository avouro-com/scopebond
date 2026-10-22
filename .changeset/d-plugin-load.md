---
"@scopebond/hook": patch
---

The optional signed plugin loads faster: its checked bytes are handed to Node's module loader from memory instead of through a `data:` URL (on Node versions with `module.registerHooks`), which saves several milliseconds on every tool call. Each answer keeps its 2 ms budget, and while the plugin's code runs for the first time in a process its answers may go over that by 25 ms in all. Loading the plugin no longer prints a Node experimental-feature warning into the coding agent's transcript.
