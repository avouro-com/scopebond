---
"@scopebond/hook": minor
---

GitHub Copilot's other surfaces: VS Code agent mode and the Copilot cloud coding agent. Neither is verified on a live
install yet, and nothing claims more: their capability cells are now computed like the CLI's (configured and unverified
until a real run proves them, never verified from a local run), labelled "cooperative · prevents if honored · a hook
timeout fails open", and carry the gap "verified on a live install: not yet".

- The Copilot hook file also registers `Stop`, which VS Code sends at the end of a turn. It marks the session active and
  prints nothing, so it never blocks or prolongs a turn.
- A Copilot deny or ask is written in both shapes Copilot's surfaces read: the top-level `permissionDecision` and
  `permissionDecisionReason` (Copilot CLI, VS Code's Copilot session target) and `hookSpecificOutput` (VS Code's Local
  harness). A deny still exits 2 with the reason on stderr.
- The cloud agent is recognised by no user-level Scopebond hook file for Copilot together with the sandbox's own
  environment (`COPILOT_AGENT_PROMPT` or `GITHUB_COPILOT_API_TOKEN` present, by presence only) or `GITHUB_ACTIONS=true`.
  There an "ask" is answered as a deny that says why ("this action needs a person's approval, and the Copilot cloud agent
  has no one to ask, so it is denied"). Both ways the heuristic can be wrong end in a deny.
- VS Code's Local harness sends tool names that GitHub and VS Code do not publish; such a name is recorded as an
  unevaluated `tool.<name>` and never answered "allow" (strict mode denies it).
- `capabilities --prove --copilot` opens an hour's recording, on this computer, of the tool names each Copilot surface
  actually sends (`copilot-tool-names.json` beside the policy: surface, event, tool name, argument names, never values),
  and lists what was seen, so a person can confirm the names on a real install.
