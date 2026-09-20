---
"@scopebond/hook": minor
---

Close command-injection bypasses in the hook and stop it suppressing the host's
own review.

Previously the mapper read only the first token of a Bash command, so a denied
program could ride in behind an allowed one — `echo hi && rm -rf x`,
`bash -c 'rm -rf /'`, `$(rm -rf x)`, `FOO=1 rm -rf x`, `git push origin +main`,
`git -C /repo push origin main` all slipped past the starter policy. A new shell
decomposer (`decomposeShell`) splits a command into every simple command it will
run — across `&&`/`||`/`|`/`;`/`&`/newline separators, `bash -c`/`sh -c` scripts
(including combined flags like `-lc`), `$( )`/backtick/`( )` substitutions and
subshells, and `sudo`/`env`/`xargs`/assignment prefixes — and `mapClaudeToolUse`
and `mapCursorEvent` now return one intent per simple command (an array). The
runtime evaluates all of them and denies the call if any one is out of policy;
`git push` parsing understands `-C`, `--force`/`-f`/`--force-with-lease` and a
leading `+` force refspec. A command that cannot be parsed with confidence is
opaque: denied in strict mode, observed otherwise — never trusted.

The hook no longer returns `permissionDecision:"allow"` (Claude Code) or
`permission:"allow"` (Cursor) for an in-policy action, which used to suppress the
user's normal permission prompt. It records the receipt and defers: only an
out-of-policy action is blocked outright.

The starter policy now protects the hook's own control surface — it denies writes
to `.scopebond/**`, `.claude/settings*`, `.cursor/hooks*` and `.git/hooks/**`, and
reads of `*.key` and `.scopebond/**` — so a governed agent cannot rewrite its own
policy or read the signing keys. Adds a 42-case bypass corpus, decomposition,
self-protection and ReDoS-timing tests.
