---
"@scopebond/github-action": minor
"@scopebond/framework": minor
---

Connector hardening (SB68).

- **github-action:** `claude[bot]` and `github-actions[bot]` are now governed
  coding-agent actors (a repo can still narrow the set via `agentActors`), and a
  pull request is evaluated at a real timestamp (injectable via a `now` option)
  instead of epoch 0, so `time_window` clauses actually bind.
- **framework:** `guardedTool` (and `wrapOpenAITools`) now throw when a tool has no
  `execute` function instead of returning it unguarded — a silent passthrough on an
  unrecognized tool shape (for example an already-constructed OpenAI Agents tool that
  exposes only `invoke`) would let a tool run with no policy check. Wrap the tool
  *definition*'s `execute` before constructing the tool, or use `guardExecute`.
