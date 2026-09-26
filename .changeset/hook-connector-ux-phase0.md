---
"@scopebond/hook": minor
---

Make the connector do what the site says: a readable block message, a hook that starts
fast, diagnostics that tell the truth, and honest Cursor coverage.

- **`init` pins the hook to a durable path instead of `npx`.** The command it installed
  ran `npx -y @scopebond/hook@<version>` on every tool call, which re-resolves a package
  already on disk. `init` now copies this package to `~/.scopebond/runtime/<version>/`
  once per machine and points the agent at that absolute path. Measured on one Windows
  machine, through a shell, warm cache: **151 ms per tool call, down from 1053 ms.** Pass
  `--npx` to keep the portable command; `init` falls back to it automatically when no
  durable copy can be made, and `doctor` now verifies that a pinned command still
  resolves, so a cleared home or a switched Node version surfaces as a problem rather
  than a hook that cannot start.
- **A denial explains itself.** The message was the engine's internal reason — `param
  program fails pattern`. It now names the action, the deciding rule, that rule's own
  description, the technical detail and the file to edit. The same text reaches the
  coding agent, so it can choose another approach instead of retrying a blocked call.
- **`status` and `doctor` no longer contradict `init`.** Both checked only the
  user-level agent config, so after a per-project `init` they reported "Claude Code: not
  configured". They now report both scopes and name the files, and `doctor` treats "no
  agent configured at all" as a problem, because nothing is enforced in that state.
- **Cursor: an allowed action no longer prompts.** The adapter answered `ask` even for
  an action a rule had evaluated and permitted, putting a confirmation dialog in front
  of every ordinary command. An evaluated allow now answers `allow`; `ask` is reserved
  for actions no rule covers, which still defer to Cursor's own prompt.
- **Cursor: file edits are described as recorded, not prevented.** Cursor reports an
  edit only after writing it (`afterFileEdit`), so an out-of-policy edit cannot be
  blocked there. Such a decision is now flagged post-hoc, worded as "recorded an
  out-of-policy …" rather than "blocked", and `init --cursor` prints what is prevented
  and what is only recorded.
- **Fixed: unparseable input to the Cursor adapter answered `ask`.** Invalid JSON on
  stdin fell through to evaluation with an empty payload and became an `ask`, so an
  unreadable request reached a prompt the user would likely accept. It now denies, like
  every other adapter.
- **Fixed: a user-level `install` on Windows wrote a command that bash could not run.**
  Absolute paths were quoted only when they contained a space, so an unquoted Windows
  path lost its separators under Git Bash, WSL or a dev container and the hook died with
  `MODULE_NOT_FOUND`. Both paths are now always quoted on Windows.
- **Fixed: re-running `init` could install a second hook entry.** The duplicate check
  did not recognise a pinned Windows path (`@scopebond\hook`), so a repeat `init` would
  have left the hook checking every tool call twice. There is now one shared matcher for
  every command form the installer has ever written.
- Printed guidance uses plain `npx` on every platform instead of `npx.cmd`, and the
  non-interactive refusal explains why it refuses and how to proceed.
