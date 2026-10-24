---
"@scopebond/hook": minor
---

The five-minute rules check reports how many actions the hook blocked in the last 24 hours because it failed itself, and the newest kind (`x-scopebond-hook-failures: <count>;<kind>`, never a message), so the workspace can show it on the computer's page. The hook advertises the `hook_failures` capability; no failure, no header.
