---
"@scopebond/hook": patch
---

Reading a command, a package spec or a `wrangler.toml` now takes time in proportion to its length: a crafted one (a word of many wildcards, a long hyphenated header name, thousands of blank lines) could hold a hook check for seconds or, in the worst cases, far past the agent's time limit.
