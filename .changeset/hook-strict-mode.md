---
"@scopebond/hook": minor
---

Add an opt-in **strict mode** to the hook. By default an unmapped tool (one with no Action Taxonomy mapping) is observed and recorded `not_evaluated`, matching the connector conformance vector. With `strict` (`--strict` or `SCOPEBOND_HOOK_STRICT=1`, or `createHookRuntime({ strict: true })`), an unmapped tool is instead policy-checked and denied by a closed allowlist — fail-closed coverage for tools the taxonomy does not yet map, for security-conscious deployments.
