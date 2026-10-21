---
"@scopebond/policy-schema": patch
"@scopebond/hook": patch
---

The pack format now has engine levels: `PACK_ENGINE_LEVEL` is 2, a pack may say `requires: { engine, action_types? }`, and a pack rule may carry `title`, `blockable`, `default_mode`, `safer_way` and `allow_patterns`; a pack that uses any of them must say `requires.engine: 2`, every existing pack validates and reads exactly as before, `validatePack(doc, { engine: 1 })` reads a pack as an older engine does, and `packEngineProblem` says why an engine cannot run a pack (`engine_too_old` or `unknown_action_type`).

A signed taxonomy extension (`scopebond:taxonomy-ext/v1`, at the `./taxonomy-ext` subpath) adds action types as data, and `getActionType` reads the extension in force after the built-in registry, never replacing a built-in type.

A rule pack's rule can now say its own title, whether it may block and whether it blocks by default: the hook reads `blockable` (falling back to the target rules for older packs), applies `default_mode` until a person or the workspace sets the rule, names the block by the rule's `title`, adds the rule's `safer_way` to the deny message's "What to do" line, and keeps these fields out of the policy clause.

A workspace can now set the mode of any rule pack's rule in `pack_rules` (the hook reports the `pack_rules` capability; `pack_rules` is digested with the rules), a person may allow or ask about such a rule when its terms say so, and `rules enforce|monitor` accepts a pack's own rules.

The hook now reads packs at engine level 2 and says so (`x-scopebond-pack-engine: 2` on the rules check and on each pack fetch, and the `pack_engine_2` capability): a pack that needs a newer engine or an action type the hook does not know is skipped and reported (`engine_too_old` or `unknown_action_type`, with what it needs) while every other pack is kept, `SCOPEBOND_PACK_ENGINE_LEVEL` can lower the level to see what an older engine does, and the signed pack list may mark a pack `shadow` (its rules record what they would block) or kill versions (`killed`, covered by the list's digest), which are dropped at once in favour of the version held before.

The hook now fetches and verifies the signed taxonomy extension a workspace names in its pack list (`taxonomy-ext`), so a pack can emit a new kind of action, and a policy that names one of its opt-in types decides those actions, without a new hook.

A rule pack's grammar can now read local facts (an environment variable, a file's digest, a top-level configuration value) in the folder the command runs in, and an MCP profile can read the environment; a pack's own vectors still run without them, so they derive the same on every computer.

Each rules check now reports the packs on the computer in `x-scopebond-packs` (`id@version,…;rejected=id@version:reason,…;engine=2`): the packs in force, the ones not taken and why, and the engine level.

The hook now reads and pins a next policy-signing key from a document the current key signs (`scopebond:policy-next-key/v1`, sent as `policy_next_key` on a rules answer), so the key can be rotated without a release, and a computer its workspace manages enforces signed rules when that document says `managed_signature_mode: "enforce"`.

A rule id the hook does not know in a workspace document, or a malformed `pack_rules` entry, is now skipped and reported (`skipped_rules` on the rules confirmation and in `managed-meta.json`) instead of refusing the whole document.
