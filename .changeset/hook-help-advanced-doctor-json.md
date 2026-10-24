---
"@scopebond/hook": minor
---

The default `help` lists the everyday commands; `help --advanced` adds `budget`, `delegation`, `capabilities`, `observations`, `policy`, `prune`, `trust` and `dedupe`, which still work as before. `doctor --json` prints the same checks as one JSON document (`scopebond.doctor.v1`: each check's `name`, `ok`, `detail` and, when it fails, `fix`, plus the `problems` count) and exits as `doctor` does. The repository's `engines.node` is `>=22.13`, the floor the hook already enforces.
