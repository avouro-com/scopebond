---
"@scopebond/framework": minor
---

Add `@scopebond/framework` — the framework plugins (a leaf package; frameworks are optional peers, never dependencies). A cooperative (M0) in-process tool guard: before an agent runs a tool, it checks your policy and records a **signed-intent** receipt (the agent's key signs, so it is the strongest class). Enforcement depends on the framework honoring the guard; code outside the tool loop is not covered.

- `createToolGuard({ policy, agentKeyPem, manifest?, onReceipt? })` returns `{ check(name, args) }`. A tool maps to the taxonomy `tool.<name>` type by default, or to a richer type (e.g. `payout.create`) via the `manifest`; money fields are lifted so `spend_limit` clauses apply. An unlisted tool is denied by a closed allowlist (fail closed).
- Adapters ship for the **Vercel AI SDK** (`wrapVercelTools` — wraps a `tools` record; a denied call returns a synthetic denial result instead of executing) and **LangGraph/LangChain** (`wrapLangGraphTool` — proxies a tool so `invoke` checks first, preserving the instance).
- Conformance vector (allowlisted tool → cooperative allow + signed-intent receipt; over-cap money tool → deny; unlisted tool → deny; both adapters run allowed tools and block denied ones). Smoke extended to eight packages.
