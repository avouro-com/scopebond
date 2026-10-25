---
"@scopebond/hook": patch
---

Each hook call is faster: about 85 ms instead of about 150 ms on an Apple M2 Max, measured with `scripts/bench-hook.mjs`. Coding agents run the hook on every tool call, so every call waits less. The package now ships the command line as one bundled file, `dist/cli-bundle.js`, which `dist/cli.js` loads instead of about a hundred separate modules. Hook calls (`claude`, `codex`, `cursor`, `copilot`) also keep Node's compile cache in a `.compile-cache` folder beside the package. When that folder is read-only there is no cache and no message, and `NODE_DISABLE_COMPILE_CACHE=1` turns the cache off. Talking to the Scopebond Agent no longer loads Node's fetch implementation on every call. The library (`exports`), the commands and the fail-closed answers are unchanged: a bundle that cannot load still denies in each agent's format.
