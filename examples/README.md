# Examples

- **`quickstart.mjs`** — an agent signs an action with `@scopebond/sdk`, submits it
  through `@scopebond/gateway` in-process, and prints the decision + the
  Ed25519-countersigned `scopebond:receipt`. Shows an in-policy action allowed and an
  over-limit action denied. It uses the default no-op executor: no payment or other
  external business action occurs, and `executed` records completion of that no-op.

- **`framework-guard.mjs`** — the framework connector (`@scopebond/framework`): wraps a
  Vercel AI SDK-shaped `tools` record so every tool call is checked against policy
  in-process (cooperative M0) and records a **signed-intent** receipt before it runs.
  Shows a read-only tool allowed, a mapped money tool allowed within its cap and denied
  over it, and a non-allowlisted tool denied (fail-closed). A denied call returns a
  synthetic denial to the model instead of executing; `executed` is `false` because the
  guard never runs the tool itself.

- **`github-pr-gate.mjs`** — the GitHub connector's boundary lane
  (`@scopebond/github-action`): decides whether an agent's pull request may merge, as a
  required status check would in your own Actions runner. Pure and deterministic (no
  credential, no network). Shows a human PR never blocked, an agent PR within policy
  allowed, and an agent PR touching `infra/prod/**` denied by the element-wise array
  path bound (D67).

- **`mcp-proxy.mjs`** — the MCP connector's in-path proxy (`@scopebond/mcp`): one policy
  in front of every `tools/call`. An allowed call is forwarded to the upstream and gets a
  **PEP-authorized** receipt; a denied call is answered with a JSON-RPC error and is
  **never forwarded** (the example's stub upstream records that the denied call never
  reached it).

- **`hook-map.mjs`** — the Claude Code / Cursor connector (`@scopebond/hook`): maps a
  coding agent's native tool call (`mapClaudeToolUse`) to a normalized taxonomy action
  and decides it, exactly as the `scopebond-hook` runtime does. Shows a `git push` to a
  protected branch denied, a workspace read allowed, a destructive `rm` denied (with the
  command redacted), and an unmapped tool observed as `not_evaluated` — never a silent
  allow.

- **`verify-receipt-offline.mjs`** — offline receipt verification
  (`@scopebond/verify/signature`): the gateway issues a receipt, then a WebCrypto-only
  verifier (no `node:` imports; runs as-is in a browser or Worker) checks the Ed25519
  signature and the attester kid binding. Shows the receipt valid with the JWK and PEM
  key, and a tampered copy and a different attester key both rejected.

- **`verify-anchor-inclusion.mjs`** — receipt-log anchors (`@scopebond/verify/anchor`):
  five receipts are anchored in a signed v2 (RFC 9162) anchor, the gateway serves an
  inclusion proof for one of them, and the client verifies the anchor signature and the
  audit path offline (and recomputes the path locally). Shows the same proof at the wrong
  leaf index and an edited anchor both rejected.

```bash
pnpm install && pnpm -r build
node examples/quickstart.mjs
node examples/framework-guard.mjs
node examples/github-pr-gate.mjs
node examples/mcp-proxy.mjs
node examples/hook-map.mjs
node examples/verify-receipt-offline.mjs
node examples/verify-anchor-inclusion.mjs
```

`policy.json` is a small sample policy (per-action cap, monitored daily cap, key policy).
The examples are also run as a CI smoke that asserts their decisions
(`pnpm run test:examples`), so a published-API change that flips an allow/deny is caught.
