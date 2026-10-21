# Writing rule packs

A rule pack teaches the hook what a command-line tool or an MCP server does, and carries the rules that decide it. It
is data in the closed `scopebond:pack/v1` format (`@scopebond/policy-schema`, `src/pack.ts`), never code: every
operator is one of a fixed set, and the hook refuses a pack that uses anything else.

This folder holds four general packs anyone can load, and this guide. Each pack is a single JSON file:

| Pack | What it reads | Rules (default mode) |
| --- | --- | --- |
| `git-safety.json` | `git reset --hard`, `filter-branch`, `filter-repo`, force-deleting a branch, deleting a tag, expiring the reflog, `gc --prune`, `update-ref -d`, dropping stashes | `git-history-rewrite` (records), `git-force-push` (records) |
| `secrets-hygiene.json` | keys written by `ssh-keygen` and `openssl -keyout`, private keys exported with `gpg` | `env-file-write` (records), `key-file-write` (records), `private-keyring-read` (blocks) |
| `build-hygiene.json` | package publishes (`npm`, `pnpm`, `yarn`, `bun`, `cargo`, `twine`, `gem`, `poetry`), global installs | `package-publish` (blocks), `global-install` (records), `lockfile-edit` (records) |
| `ci-guard.json` | `git update-index --skip-worktree`/`--assume-unchanged`, `git config core.hooksPath` | `ci-config-edit` (records), `commit-checks-edit` (records) |

A rule that records lets the action run and keeps a record that it matched; one that blocks stops it. Any rule that
says `blockable` can be switched with `scopebond rules enforce <rule>` or `scopebond rules monitor <rule>`.

## Loading a pack

Name the pack files in your rules file (`.scopebond/rules.json`, beside `policy.json`), each path relative to that
folder:

```json
{
  "version": 1,
  "protected_branches": ["main", "master", "release/*"],
  "packs": { "local": ["team-packs/git-safety.json", "team-packs/my-team.json"] }
}
```

Keep the files inside `.scopebond/` (for example `.scopebond/team-packs/`): Scopebond's own folder is protected from
the coding agent, so the agent cannot change a pack it is governed by. Do not use `.scopebond/packs/`, which holds the
packs your workspace delivers and is rewritten on each check-in.

The trust root is the rules file: whoever can edit it can add a pack, so a local pack needs no signature. To keep pack
files somewhere others can write (a shared repository), list the keys they must be signed with:

```json
"packs": {
  "local": ["../shared/packs/my-team.json"],
  "trusted_keys": [{ "key_id": "team-2026", "public_key": "<Ed25519 public key, PEM>", "not_before": "2026-01-01T00:00:00Z", "not_after": "2027-01-01T00:00:00Z" }]
}
```

With `trusted_keys`, every local pack must carry a `signature` (Ed25519 over `scopebond:pack/v1`, one LF, then the
RFC 8785 canonical pack without `signature`: `packSigningInput` in `@scopebond/policy-schema/pack`) by one of those keys.

On every tool call the hook checks each local pack as it checks a delivered one: at most 4 MiB, the closed format at
this hook's engine level, the engine level and action types it needs, and every one of its vectors. A pack that fails
is skipped and the others stay in force. `scopebond packs list`, `scopebond status` and `scopebond doctor` name each
local pack in force and each one not used, with why.

A local pack only adds:

- A pack your workspace delivers with the same id is used instead of yours.
- A delivered pack reads a command, owns an MCP server and defines a rule id before any local pack.
- Each of its rules needs an id of its own: not one of the policy's, a delivered pack's, or a target rule's
  (`cloud-destructive`, `production-deploy`, `secret-write`, `iam-change`, `database-migrate`).
- A rule may name a type of call the hook maps a coding agent's own calls to (`shell.exec`, `file.read`, `file.write`,
  `git.push`, `net.fetch`, `mcp.tool.call`, `package.install`) only when the policy already covers that type. An
  evaluated call of a type no rule covers is denied, so a rule that newly covered it could let it through. Types the
  hook only ever derives (`deploy.release`, `software.install`, `cloud.resource.*`, `k8s.*`, …) are always fine.

A pack that breaks one of these is not used (`rule_not_added`). While local pack rules are in force, the policy
decides the actions packs derive (as it does once a delivered pack's rules are in force), so a local rule on a derived
action takes effect.

## Testing a pack

```
scopebond packs test team-packs/my-team.json
scopebond packs test team-packs/            # every .json file in the folder
scopebond packs test team-packs/ --json     # for CI
```

`packs test` checks each file as a local pack, runs each vector, and prints a line per vector: `pass` or `FAIL` (did the
input derive exactly the actions the vector expects) and what the hook decides for that input under the starter
rules with this pack alone in force (`allow`, `deny`, `ask`, `not_evaluated`), with the rule that blocked it or
recorded a match. It exits non-zero when a vector fails or a file is not a usable pack. It never reads or changes your
own policy, packs or records: it runs in a throwaway folder.

## The format

```json
{
  "format": "scopebond:pack/v1",
  "id": "my-team",
  "version": "1.0.0",
  "issued_at": "2026-10-21T00:00:00Z",
  "title": "What this pack covers",
  "requires": { "engine": 2 },
  "grammars": [],
  "profiles": [],
  "rules": [],
  "vectors": []
}
```

- `id`: lower case letters, digits and `-` (at most 64). `version`: `MAJOR.MINOR.PATCH`. `issued_at`: an RFC 3339 UTC time.
- `requires` (level 2): `engine`, the pack engine level the pack needs (2 for any field marked level 2 below), and
  `action_types`, any action types beyond the built-in registry it emits (a signed taxonomy extension must define them).
- `signature`: `{ "alg": "Ed25519", "key_id", "value" }`. Required for a delivered pack; optional for a local one unless
  the rules file lists `trusted_keys`.
- A pack has at least one grammar or profile and at least one vector. Limits: 200 grammars, profiles and rules each,
  5000 vectors, 4 MiB.

### Grammars: reading a command line

```json
{
  "id": "my-tool",
  "programs": ["mytool"],
  "via": "my-team",
  "options": { "valued": ["--env", "-e"], "flags": ["--yes", "-y"] },
  "commands": [
    { "path": ["deploy"], "emit": [{ "action_type": "deploy.release", "params": { "environment": { "env_of": { "flag": ["--env", "-e"] } } } }] }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `id` | Unique in the pack. |
| `programs` | Program names this grammar reads (lower case; one grammar per program in a pack). |
| `via` | The label every action it derives carries in `via` (default: the first program). |
| `launchers` | `false`: do not read the tool when it is started through a package runner (`npx`, `uv run`, …). |
| `options.valued`, `options.flags` | The options that take a value, and the switches. Others are unknown. |
| `unknown_options` | `uncertain` (default): read on; `stop`: an unknown option stops reading (only `fallback` can derive). |
| `path_options` | Which options may stand before the path words: any but an unknown switch (default), `known`, or `none`. |
| `strict_unknown` | An unknown `--name=value` also ends the words a path can match. |
| `fallback_on_any_option`, `fallback_only_unread` | When `fallback` may run. |
| `double_dash` | `end` (default): stop reading at `--`; `positionals`: the words after it are positionals. |
| `single_dash_long` | Read `--name` as `-name` (tools whose long options take one dash). |
| `strip_words` | Leading words to skip (`beta`). |
| `skip` | `{ options, words }`: what makes a command derive nothing beyond the built-in help, version and dry-run checks. |
| `commands` | `{ path, when?, max_positionals?, emit }`, tried in order; the first whose path and `when` match emits. |
| `fallback` | `[{ when, emit }]`: what to derive when an unknown option kept every path from matching. |

A path is a list of words: a string matches itself; `{ "any": [...] }`, `{ "not": [...] }`, `{ "pattern": "…" }` match a
word; `{ "optional": "word" }` may be absent; `{ "skip": n }` skips up to `n` words; `"var": "name"` binds the word
(or the skipped words) for `{ "var": "name" }` later.

### Profiles: reading an MCP call

`{ "id", "servers": ["words"], "via"?, "tools": [{ "names": ["tool"], "when"?, "emit" }] }`. A profile reads a call when
one of its `servers` words is a word of the server's configured name (or, failing that, of its URL or launch command).

### What a match derives

`emit` is a list of `{ "action_type", "params", "when"?, "for_each"?, "item_pattern"? }`. `action_type` is a registered
action type (`@scopebond/policy-schema/registry`), never `shell.exec` or `mcp.tool.call` (the call itself, always
recorded). `params` maps a parameter name to an expression; the engine adds `via` and `derived_from`. `for_each` emits
once per item of a list (each item is `{ "item": true }`, its groups `{ "item": n }` with `item_pattern`). A pack
computes identifiers, closed values and keyed digests, never content.

Expressions (each an object with one operator):

- From the command line: `const`, `flag` (last value), `flags` (every value), `present` (a switch), `positional`,
  `positionals` (`{ from, to?, past_unknown? }`), `any_positional`, `word_after`, `words_after`, `assign` (a
  `NAME=value` before the program), `arg_assign`, `var`, `tool` (the program read).
- From local files and the environment (unknown in vectors): `env_var`, `file_sha256`, `dir_sha256`, `file_text`,
  `dir_sql`, `config_value`.
- From an MCP call: `arg`, `arg_list`, `arg_items`, `server`.
- Transforms: `env_of` and `env_class` (production, staging, development), `ident`, `literal`, `digest`,
  `digest_list`, `host_of`, `match` (`pattern`, `group`), `replace`, `lower`, `upper`, `map` (`table`, `default` or
  `keep`), `first`, `concat`, `join`, `sorted`, `count`, `split`, `scrub`, `sql` (`verb`, `predicate_class`, `risk`), `if`.

Conditions (`when`): `has` (an option is given), `word` (a positional is one of), `defined`, `eq`, `in`, `matches`,
`all`, `any`, `not`, `count` (`min`, `max`), `unknown_option`.

Patterns are JavaScript regular expressions of at most 200 characters, with no back-references, look-behind or
repeated group that holds a repeat; every word is cut to 512 characters before one runs.

### Rules

A rule is an `action_allowlist` clause of the policy language: it covers its `action_types`, and an action of those
types that does not meet every bound matches it.

| Field | Level | Meaning |
| --- | --- | --- |
| `id` | 1 | Unique (see "A local pack only adds"). |
| `type` | 1 | Always `action_allowlist`. |
| `mode` | 1 | `enforce`, `monitor` or `require_approval`; the hook sets the mode in force (below). |
| `description` | 1 | What the rule does, in a sentence a person reads in a block message. |
| `action_types` | 1 | The action types it covers. |
| `param_bounds` | 1 | `{ param: bound }`. A bound is `{ min?, max?, enum?, pattern? }`, or for a list `{ items: bound, match?: "all" \| "any" }`. A missing parameter never meets a bound. |
| `title` | 2 | A short name (at most 80 characters) shown when it blocks. |
| `blockable` | 2 | It may block (needs `param_bounds`). Otherwise it only ever records. |
| `default_mode` | 2 | `monitor` or `block` (only a blockable rule), until a person or the workspace sets it. |
| `safer_way` | 2 | One sentence (at most 160 characters) the coding agent is told to do instead. |
| `allow_patterns` | 2 | Up to 8 `{ id, title, param, kind }` (`kind`: `path_prefix`, `path_glob`, `package_name`, `host`, `mcp_tool`): how far a person's allowance under the rule may reach. |

The mode in force: Off when switched off; else what a person (`scopebond rules enforce|monitor <rule>`) or the
workspace set; else `default_mode`. Bound a rule on a parameter every action it covers carries: a pattern such as
`^(?!build-hygiene$)` on `via` matches only the actions this pack derives.

### Vectors

`{ "id", "shell": { "command", "dialect"? } | "mcp": { "server", "tool", "args", "hint"? }, "expect": [actions] }`.
`expect` lists exactly the actions the pack must derive from that input, in order, each with every parameter
(including `via` and `derived_from`); `{ "digest_of": [parts] }` stands for the engine's keyed digest. An input the pack
must leave alone expects `[]`. Write vectors for what a rule should catch and for the everyday commands it must not
touch.

## Contributing a pack

General packs (no single vendor's tool, no knowledge of a paid service) are welcome here under the repository's
[contribution guide](../../../CONTRIBUTING.md) and CLA. Add the file to this folder with at least ten vectors, run
`scopebond packs test packages/hook/packs/` and the hook's tests (they check every pack in this folder and that the
everyday decisions do not change with them in force), and say in the pull request what the pack reads and why each
rule's default mode is what it is.
