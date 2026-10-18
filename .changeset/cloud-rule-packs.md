---
"@scopebond/hook": minor
---

Vendor tools and MCP servers are now covered by rule packs only. The readers built into the hook for cloud, Kubernetes, infrastructure, deployment, secret and database migration tools, the MCP server profiles, and the target-rule clauses are removed; Scopebond Cloud delivers the same coverage as signed rule packs, which the hook already verifies and runs. With no pack in force, the hook runs the open detection (shell, git, files, web requests, package installs, SQL through `psql` and `sqlite3`) and the starter protections.

- A pack's rules join the policy in force each time it is loaded (`withPackRules`), on the modes this computer's rules or its workspace set; they are no longer compiled into `policy.json`. A clause a policy already carries is kept. The five target rules (`cloud-destructive`, `production-deploy`, `secret-write`, `iam-change`, `database-migrate`) can still be switched with `rules enforce|monitor` and by a workspace; a pack's other rules always record.
- Removed exports: `deriveTargetOperations`, `toolOf`, `envOfName`, `targetDigest`, `TARGET_TOOLS`, `deriveMcpOperations`, `mcpProfileOf`, `targetRuleClauses`, `OBSERVED_TARGET_TYPES`, `setBuiltinReaders`, `builtinReadersOn`. New: `activePacks`, `packRuleClauses`, `switchablePackRules`, `withPackRules`, `managedEnforce`, `enforcedRuleIds`.
- `typed-infra.ts` is split: Wrangler's resource and D1 observation operations move to `typed-wrangler.ts`; the shell fetchers, `psql`, `sqlite3` and the remote-database guard stay.
- `scopebond rules` lists the target rules only when a pack in force defines them.
