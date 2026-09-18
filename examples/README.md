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

```bash
pnpm install && pnpm -r build
node examples/quickstart.mjs
node examples/framework-guard.mjs
node examples/github-pr-gate.mjs
node examples/mcp-proxy.mjs
```

`policy.json` is a small sample policy (per-action cap, monitored daily cap, key policy).
The examples are also run as a CI smoke that asserts their decisions
(`pnpm run test:examples`), so a published-API change that flips an allow/deny is caught.
