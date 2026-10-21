---
"@scopebond/policy-schema": patch
"@scopebond/hook": patch
---

The pack format now has engine levels: `PACK_ENGINE_LEVEL` is 2, a pack may say `requires: { engine, action_types? }`, and a pack rule may carry `title`, `blockable`, `default_mode`, `safer_way` and `allow_patterns`; a pack that uses any of them must say `requires.engine: 2`, every existing pack validates and reads exactly as before, `validatePack(doc, { engine: 1 })` reads a pack as an older engine does, and `packEngineProblem` says why an engine cannot run a pack (`engine_too_old` or `unknown_action_type`).

A signed taxonomy extension (`scopebond:taxonomy-ext/v1`, at the `./taxonomy-ext` subpath) adds action types as data, and `getActionType` reads the extension in force after the built-in registry, never replacing a built-in type.

A rule pack's rule can now say its own title, whether it may block and whether it blocks by default: the hook reads `blockable` (falling back to the target rules for older packs), applies `default_mode` until a person or the workspace sets the rule, names the block by the rule's `title`, adds the rule's `safer_way` to the deny message's "What to do" line, and keeps these fields out of the policy clause.

A workspace can now set the mode of any rule pack's rule in `pack_rules` (the hook reports the `pack_rules` capability; `pack_rules` is digested with the rules), a person may allow or ask about such a rule when its terms say so, and `rules enforce|monitor` accepts a pack's own rules.

A rule id the hook does not know in a workspace document, or a malformed `pack_rules` entry, is now skipped and reported (`skipped_rules` on the rules confirmation and in `managed-meta.json`) instead of refusing the whole document.
