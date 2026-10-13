---
"@scopebond/hook": minor
---

Robustness. Secret scrubbing reads a header value once: a 100 kB run of `name:name:…` took seconds and now takes milliseconds. A hook call that has not decided shortly before the coding agent's own hook time limit (55 s for Claude Code, 28 s for Codex and Cursor) now denies instead of being left to time out, which an agent treats as "run it"; `SCOPEBOND_HOOK_DEADLINE_MS` can only shorten the deadline. A bypass corpus (`test/bypass-corpus/`) records what the hook blocks or names for indirect forms of blocked actions, and its known gaps. Every call to the workspace (rules check and confirmation, record delivery and summaries, observations, credential renewal, recovery, enrollment, uninstall notice) now carries `x-scopebond-hook-version`.
