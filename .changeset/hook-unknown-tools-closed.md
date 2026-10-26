---
"@scopebond/hook": minor
"@scopebond/gateway": patch
---

A coding-agent tool Scopebond has no mapping for is no longer let through unchecked. Tools that only read, only load a skill's instructions, or only manage the agent's own task list, plan or questions to you (for example Claude Code's `TodoWrite`, `AskUserQuestion`, `WebSearch`, `Task` and `Skill`, Copilot's `read_bash`, Codex's `update_plan`) are recorded as before. Any other unmapped tool is now blocked in every mode, with a message naming the tool; where the coding agent can ask you (Claude Code in a mode that prompts, Cursor, the GitHub Copilot CLI), you are asked instead. To allow such a tool, add its `tool.<name>` type (for `BrandNewTool`, `tool.brandnewtool`) to `observe` in `.scopebond/rules.json` and run `scopebond rules apply`; on a computer your workspace manages, ask an admin. A later Scopebond update may also map it. Codex's `view_image` is now checked as a read of the image file. `SCOPEBOND_HOOK_STRICT` is unchanged.
