---
"@scopebond/hook": patch
"@scopebond/agent": patch
"@scopebond/gateway": patch
---

Groundwork for a single-file Windows build. The hook's and the agent's commands are now `main(argv)` functions in `cli-main.js` (the `cli.js` programs that agent settings and autostart name are unchanged and call them); every place that starts the hook or the agent again goes through one helper (`hookSelfCommand`, `agentCliPath`); Node's SQLite is taken from Node's built-ins; versions can be set at build time. No change in behaviour for npm installs.
