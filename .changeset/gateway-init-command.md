---
"@scopebond/gateway": minor
---

Add `scopebond-gateway init [--force]`. It scaffolds a working project — an Ed25519 agent signing key, a `principal-keys.json` registry that trusts that key, and a starter `scopebond.policy.json` bound to it — then prints the start, sign, submit and verify steps with a one-time control token that is never written to disk. A refused run (an existing registry or policy without `--force`) now leaves the directory untouched, generating no agent key.
