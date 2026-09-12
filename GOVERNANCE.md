# Governance

## Who decides

Scopebond is stewarded by the maintainer (Avouro LLC) as the final authority on
scope, architecture, and releases. This is a benevolent-dictator model
appropriate to an early, single-maintainer project; it will formalize (a
maintainers team, then a steering process) as contributors earn trust. Contact:
scopebond@avouro.com.

## What we accept — the contribution ladder

The bar rises with the blast radius of the change. See [SCOPE.md](SCOPE.md) for
the precise in/out-of-scope rules and the hard constraints.

| Change | Path |
|---|---|
| Typo, docs, a test, a bug fix **with a repro** | Open a PR directly. |
| A behavior change within an existing package | Open an issue describing the problem first; then a PR. |
| A new clause type, a public-interface change, a new package, or anything touching a hard constraint | **Open a proposal issue and get maintainer sign-off before writing code.** These change the standard others depend on. |
| Anything in "Out of scope" | Will be labeled and routed to a maintainer; likely declined with a reason. |

## How a contribution is reviewed

Every PR runs an automated pipeline; a change merges only when the required
checks pass and, for anything scope-touching, a maintainer approves.

1. **OSS gate** — no private content/secrets/prior-project codenames.
2. **Build / lint / type / test** and the **dependency-boundary check**
   (`scripts/deps-allowlist.mjs`: core packages take no vendor/framework SDKs).
3. **CLA** — the contributor has signed (see [CLA.md](CLA.md)).
4. **Scope-review agent** — reads the diff against [SCOPE.md](SCOPE.md) and posts a
   verdict (`ALIGNED` / `NEEDS-CHANGES` / `OUT-OF-SCOPE`) with a label and reasons.
   Aligned changes proceed to review; out-of-scope changes are **routed to a
   maintainer**, never auto-closed.
5. **Maintainer decision** — required for scope-touching changes (enforced by
   CODEOWNERS on `SCOPE.md`, the gate, and CI config).

The agent accelerates triage and review; it does not replace the maintainer's
final call. Its rubric is [SCOPE.md](SCOPE.md) — improving the rubric improves
every future review.

## Releases & security

Releases follow semantic versioning once the first package is tagged; the policy
vocabulary and `scopebond-verify` version independently (see the vocabulary spec).
Security issues follow [SECURITY.md](SECURITY.md).
