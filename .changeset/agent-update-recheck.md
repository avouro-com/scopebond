---
"@scopebond/agent": patch
---

The signed Windows install checks an update's installer again right before installing it. The helper that waits for the
agent to exit now holds the installer open (no writes or deletes) and checks its size and SHA-256 against the signed
manifest and its Authenticode signature against the same publisher rule, before msiexec runs. Any mismatch installs
nothing; the reason is recorded in `updates/install-result.json` and logged when the agent starts again.
