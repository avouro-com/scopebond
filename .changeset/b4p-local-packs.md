---
"@scopebond/hook": patch
"@scopebond/policy-schema": patch
---

The hook now reads local rule packs that `rules.json` names (`"packs": { "local": [...] }`, paths relative to that file): they use the same format and engine as delivered packs, are checked the same way on every call (format, engine level, action types, every vector) without needing a signature (or with one by a key listed in `packs.trusted_keys`), only add rules (a delivered pack with the same id, grammar or MCP server comes first, and a local rule can neither reuse a rule id nor cover a type of call the policy does not), and are named by `packs list`, `status` and `doctor` when they are not used.

`scopebond packs test <file|folder>...` now checks pack files as local packs and runs each vector through the engine, printing a pass/fail line per vector with what the hook would decide (allow, deny, ask) and the rule that matched; `--json` reports every result, and the command exits non-zero when a vector fails or a file is not a usable pack.

The hook package now ships four general rule packs (`git-safety`, `secrets-hygiene`, `build-hygiene`, `ci-guard`) and an authoring guide in its `packs` folder.

`validatePack(doc, { unsigned: true })` reads a local pack, whose `signature` may be left out.
