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

```bash
pnpm install && pnpm -r build
node examples/quickstart.mjs
node examples/framework-guard.mjs
```

`policy.json` is a small sample policy (per-action cap, monitored daily cap, key policy).
The examples are also run as a CI smoke that asserts their decisions
(`pnpm run test:examples`), so a published-API change that flips an allow/deny is caught.
