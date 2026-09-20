# Security Policy

Scopebond is fail-closed infrastructure on the money path, so we take security
reports seriously.

## Reporting a vulnerability

**Do not open a public issue or pull request for a security vulnerability.**

Report privately via GitHub's **"Report a vulnerability"** (Security → Advisories)
on this repository, or email **scopebond@avouro.com** with:

- a description and impact,
- steps to reproduce or a proof of concept,
- affected package/version or commit.

We aim to acknowledge within 3 business days and to agree on a coordinated
disclosure timeline. Please give us a reasonable window to fix before any public
disclosure. We credit reporters who wish to be credited.

## Scope

In scope: the code in this repository — the core packages `@scopebond/gateway`,
`@scopebond/verify`, `@scopebond/policy-schema` and `@scopebond/sdk`, and the
connectors `@scopebond/hook`, `@scopebond/mcp`, `@scopebond/framework` and
`@scopebond/github-action`. The on-chain contracts, the registry read API and the
conformance suite are `[PLANNED]` and not yet in the tree. The hosted control plane
("Scopebond Cloud") is a separate product; report issues affecting it to the same
address.

Enforcement boundary: the connectors are cooperative (they govern an agent that
routes through them); an agent that bypasses the hook or gateway is out of scope for
a "bypass" report. Reports that a *routed* action escaped its policy, that a receipt
misrepresents a decision, or that a secret leaked into a receipt are in scope.

> `[PLANNED]` A bug-bounty program will be published at general availability.
