---
"@scopebond/hook": minor
"@scopebond/gateway": minor
---

Make the limits editable, bound what the hook writes to disk, and make `install` safe to
try.

- **`rules` — the limits in plain terms.** `policy.json` is 6.7 KB of generated regular
  expression (the `safe-shell` clause alone is a ~700-character case-folded negative
  lookahead), so "it is a plain JSON file — edit the limits" was not true in practice and
  the starter policy was effectively the only policy. The lists those patterns are built
  from now live in `.scopebond/rules.json`, and `policy.json` is compiled from them:

  ```
  scopebond-hook rules                    # what is blocked, in plain English
  scopebond-hook rules allow dd
  scopebond-hook rules protect infra/
  scopebond-hook rules protect-branch production
  scopebond-hook rules apply              # recompile after editing rules.json by hand
  ```

  The compiled patterns are **identical** to the ones already shipped — a test pins them
  against `starterPolicy()`, so the readable front end cannot change what is enforced.
  Clause descriptions are now generated from the lists, so they stay true after an edit
  (and the block message quotes them).

- **The local store stops growing without bound.** The hook is one short-lived process per
  tool call, and it never closed its SQLite handle — so each process left its write-ahead
  log on disk for the next one to extend. Measured: **~11 KiB of WAL per receipt, against
  ~1.7 KiB once the handle is closed**, and the WAL file is now gone entirely after a run.
  (It also released a Windows file lock that stopped `.scopebond` being removable.)
  `ReceiptStore` gains optional `recent(limit)` and `count()`; both stores implement
  `close()` with a truncating checkpoint.

- **`prune` bounds the store, without ever losing evidence quietly.** `status` now reports
  the receipt count and size, and `prune --before 90d` archives the receipts it will
  remove to a JSONL file beside the database before removing them, then VACUUMs. It
  refuses outright once the log has been anchored, because a receipt's position is its
  anchor leaf index and removing one would make an existing anchor unverifiable. Nothing
  is ever deleted automatically.

- **`log` answers "what got blocked this week".** It had no filters and read every receipt
  ever recorded in order to print the last 20. It now takes `--deny` and `--since 7d`, and
  reads a tail (`ORDER BY id DESC LIMIT`) with a bounded scan when filtering. `verify`
  still reads everything — that is the point of it — but reports progress instead of
  looking hung on a long history.

- **`install --dry-run`, and a backup before any change.** `install` rewrites agent config
  files the user did not create (`~/.claude/settings.json` holds their theme, plugins and
  permissions) and the undo was "hope the merge was right". It now prints exactly which
  files it would touch with `--dry-run`, and copies each config to
  `<file>.scopebond-backup` before its first modification.

- **Fixed: `uninstall` ignored the project hook.** Like `status` and `doctor` before it, it
  looked only at the user-level config — so after the per-project `init` the site tells
  people to run, it reported "no user-level harness config found" and left the hook in
  place. It now removes both scopes and says what it kept.

- **Per-command help.** `--help` was a single line listing 15 command names. `help` now
  describes each command, and `help <command>` gives its arguments and an example.

Known remaining inefficiency: the authority tables store the policy snapshot per action,
so a tool call costs ~25 KiB rather than the ~2 KiB of the receipt itself. Deduplicating
it by digest needs a schema migration in the authority storage that backs duplicate-action
detection, so it is deliberately left for its own change rather than bundled here.
