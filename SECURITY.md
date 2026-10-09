# Security Policy

Scopebond's open-source components check supported agent actions and produce
signed evidence. Enforcement integrity, record integrity, credentials, and local
workspace connections are security-sensitive, so we take reports seriously.

## Reporting a vulnerability

**Do not open a public issue or pull request for a security vulnerability.**

Report privately by email to **security@scopebond.com**, the one address for
security reports (also published at https://scopebond.com/.well-known/security.txt),
or via GitHub's **"Report a vulnerability"** (Security → Advisories) on this
repository, with:

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
`@scopebond/github-action`, plus the `@scopebond/agent` companion (including its
credential handling, local control channel, and update path). Policy and evidence
conformance vectors are already in the tree. On-chain contracts and a registry
read API are future work, not current product features.

The hosted shared workspace (Scopebond Cloud) is a separate proprietary service,
not open source and not included in this repository. Report issues affecting it
to the same address, security@scopebond.com.

Enforcement boundary: the connectors are cooperative (they govern an agent that
routes through them); an agent that bypasses the hook or gateway is out of scope for
a "bypass" report. Reports that a *routed* action escaped its policy, that a receipt
misrepresents a decision, or that a secret leaked into a receipt are in scope.

> `[PLANNED]` A bug-bounty program will be published at general availability.

## Past advisories

Resolved before the first tagged release, during the alpha hardening. Full detail is
in the [CHANGELOG](CHANGELOG.md) `### Security` entries.

- **`@scopebond/hook` (≤ 0.5.0), `@scopebond/github-action` (≤ 0.3.1) — policy bypasses.** The Action read the policy from the pull request's own checkout, and the hook compared command text literally, so protected branches, keys/`.env` files, config/CI files and destructive commands could be reached by respelling the command (alternate refspecs, `cp`/`tar`/`scp`, globs, case and path variants, `cmd /c`, `pwsh -EncodedCommand`, `find -exec`, …); a project `.scopebond/policy.json` also overrode the user's install. Fixed by reading the Action's policy from the base commit, canonicalizing hook inputs before evaluation, and requiring `scopebond trust` before a project policy applies. (Fixed in `@scopebond/hook@0.6.0` and `@scopebond/github-action@0.4.0`; [GHSA-8p35-5vwf-5v93](https://github.com/avouro-com/scopebond/security/advisories/GHSA-8p35-5vwf-5v93).)
- **`@scopebond/hook` — secret scrubber leak.** Single-token credential shapes were
  emitted as `secret***` and signed into receipts. Rewritten with explicit rules and a
  property-based regression suite. (Fixed in `@scopebond/hook@0.3.0`.)
- **`@scopebond/hook` — command-mapping bypasses.** A denied program could ride in
  behind an allowed one (`a && b`, `bash -c '…'`, `$(…)`, env-prefix, `git -C`,
  `+ref`). The mapper now decomposes a command into every simple command and denies the
  call if any segment is out of policy; the hook defers to the host on allow. (Fixed in
  `@scopebond/hook@0.3.0`.)
- **`@scopebond/gateway`, `@scopebond/mcp` — stateful clauses never bound in
  cooperative mode.** `rate_limit`, `spend_limit` and `sequence` now count prior
  cooperative allows. (Fixed in `@scopebond/gateway@0.6.0`.)
- **`@scopebond/framework` — `guardedTool` passed a tool unguarded** when it lacked an
  `execute` implementation; it now throws instead of silently skipping the policy
  check. (Fixed in `@scopebond/framework@0.3.0`.)
