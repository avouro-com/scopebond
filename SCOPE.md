# Scope policy

This is the contract that decides what belongs in Scopebond. It is written for
two readers: contributors, and the **automated scope-review agent** that reads
every pull request and issue and judges it against this document. Keep it precise —
the agent's verdict is only as good as this document.

The product's one rule: **prevent what you can, collateralize what you can't
prevent, refuse what you can't observe.**

## In scope

- **Policy enforcement** — the gateway proxy (HTTP + MCP ingress) that evaluates
  the policy vocabulary in real time, denies out-of-policy actions, and fails closed.
- **Receipts** — countersigning actions in the ACTA `scopebond:receipt` envelope;
  attestation of occurrence and content (not a compliance verdict).
- **Kill switch** — halting execution for one or all agents, fail-closed.
- **The verdict layer** — `scopebond-verify` (`violates(policy, receipts, claimed)`),
  the policy schema, the test vectors, and the conformance suite. Deterministic,
  reproducible, no network, no clock.
- **The registry** — indexer and read API over verified receipt histories; the
  on-chain contracts (written fresh), verified on-chain.
- **Portability** — anything that lets a track record be read by any counterparty
  without a platform's permission.
- **Framework/wallet integrations** — as separate leaf packages that emit
  `scopebond:receipt`.
- Docs, examples, tests, and tooling for the above.

## Out of scope (reject or route to a maintainer)

- **Detection, analytics, dashboards-for-customers, or SOC/compliance features**
  sold to gateway users. The gateway is enforcement + receipts + kill switch only.
- **Anything custodial** — code that lets Scopebond hold a key that can move
  collateral, or that makes a fee loss-contingent, or adds claim discretion.
- **Vendor or agent-framework SDK dependencies inside a core package**
  (`policy-schema`, `verify`, `gateway`, `sdk`, `contracts`). External services go
  behind an interface with a local implementation; framework glue is a leaf package.
- **The hosted control plane** — tenancy, billing, SSO, retention, quotas, the
  hosted dashboard app. That is proprietary and lives in a separate repository.
- **The compliance/audit-readiness engine** and any prior-project (codename) code.
- **A second cloud, Postgres, a separate indexer, an SSR framework, a sovereign
  chain, or a v1 token** — these contradict settled architecture decisions.

## Hard constraints (a change that breaks one is rejected regardless of merit)

- **Fail closed.** Deny-by-default; unparseable input denies or goes stale; never "no limit."
- **No PII** in receipts, anchors, or evidence — hashes only.
- **Determinism** of `violates()` — no network or wall-clock reads; the evaluation
  timestamp is an input; ambiguity resolves for the operator.
- **Closed schema** — unknown clause types or fields make a policy invalid.
- **No secrets, no private material, no prior-project codenames** (the OSS gate enforces this).
- **Trademark** — a fork must rename; "Scopebond-compatible" requires passing the conformance suite.

## How the agent should decide

For each PR/issue, classify as one of:

- **ALIGNED** — within "In scope", breaks no hard constraint. Proceed to normal review.
- **NEEDS-CHANGES** — in scope but violates a constraint or a package rule that the
  author can fix. Explain precisely what to change.
- **OUT-OF-SCOPE** — matches "Out of scope", or expands scope / adds a new package /
  changes a public interface or a settled decision. **Do not close it; label it and
  route it to a maintainer** for a human decision.

Always cite the specific rule above. When genuinely uncertain, prefer NEEDS-CHANGES
or OUT-OF-SCOPE (route to a human) over ALIGNED — false "aligned" is the costly error.
