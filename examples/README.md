# Examples

- **`quickstart.mjs`** — an agent signs an action with `@scopebond/sdk`, submits it
  through `@scopebond/gateway` in-process, and prints the decision + the
  Ed25519-countersigned `scopebond:receipt`. Shows an in-policy action allowed and an
  over-limit action denied (fail closed).

```bash
pnpm install && pnpm -r build
node examples/quickstart.mjs
```

`policy.json` is a small sample policy (per-action cap, monitored daily cap, key policy).
