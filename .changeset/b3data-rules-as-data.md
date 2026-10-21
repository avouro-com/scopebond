---
"@scopebond/policy-schema": patch
---

The pack format now has engine levels: `PACK_ENGINE_LEVEL` is 2, a pack may say `requires: { engine, action_types? }`, and a pack rule may carry `title`, `blockable`, `default_mode`, `safer_way` and `allow_patterns`; a pack that uses any of them must say `requires.engine: 2`, every existing pack validates and reads exactly as before, `validatePack(doc, { engine: 1 })` reads a pack as an older engine does, and `packEngineProblem` says why an engine cannot run a pack (`engine_too_old` or `unknown_action_type`).

A signed taxonomy extension (`scopebond:taxonomy-ext/v1`, at the `./taxonomy-ext` subpath) adds action types as data, and `getActionType` reads the extension in force after the built-in registry, never replacing a built-in type.
