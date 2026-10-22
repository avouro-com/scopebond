---
"@scopebond/hook": patch
"@scopebond/agent": minor
---

Discover supported coding tools while the agent runs, including Copilot CLI, and enroll a detected tool when its hook file is missing. Automatic repair and upkeep honor saved exclusions. Configuration writes reject linked paths, preserve concurrent edits and unrelated settings, and replace files atomically. Status reports each tool separately and keeps native approval and runtime verification distinct from configuration; one tool's hook no longer makes another tool's self-check pass.
