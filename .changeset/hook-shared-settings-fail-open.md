---
"@scopebond/hook": minor
---

`init` no longer writes a machine-specific hook command into a file your team shares. The fast, pinned command names paths that exist only on the machine that ran `init`; in a committed `.claude/settings.json` it could not start on a teammate's machine, and Claude Code, Cursor and Codex treat a hook that cannot start as a non-blocking error — so the teammate's agent ran with no check while the file said it was governed.

- Claude Code: the pinned command goes to `.claude/settings.local.json`, kept out of git for this clone through `.git/info/exclude` (the repository's `.gitignore` is not touched). Running `init` again removes a pinned entry an older version wrote into `.claude/settings.json`.
- Cursor and Codex: the pinned command goes into the project file only while git does not already track it; a tracked file gets the portable `npx` command.
- `init --shared` writes the portable command to the shared file so everyone who clones the project gets the hook (it fails closed with a setup message until they run `init`).
- `doctor` flags a machine-specific command in a file git shares, even when it starts on this machine.
- `install` pins a durable copy instead of registering npm's temporary `npx` cache path, which npm may clear.
- `connect` leaves an already-configured hook as it is.
- `init --dry-run` shows what it would write; `connect` errors say where an enrollment comes from; `status`/`doctor` hints print a runnable command; Node's experimental SQLite warning is no longer printed.
