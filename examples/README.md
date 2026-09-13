# Examples

- **`quickstart.mjs`** — an agent signs an action with `@scopebond/sdk`, submits it
  through `@scopebond/gateway` in-process, and prints the decision + the
  Ed25519-countersigned `scopebond:receipt`. Shows an in-policy action allowed and an
  over-limit action denied. It uses the default no-op executor: no payment or other
  external business action occurs, and `executed` records completion of that no-op.

```bash
pnpm install && pnpm -r build
node examples/quickstart.mjs
```

`policy.json` is a small sample policy (per-action cap, monitored daily cap, key policy).
