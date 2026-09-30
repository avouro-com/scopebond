---
"@scopebond/hook": minor
---

`scopebond budget load <export.json> [--yes]` loads an action budget exported from the workspace. It verifies the export (type and version, the policy digest over the policy without its acknowledgement, the scope digest, the environment, the validity window and the fail-closed contract), refuses one this installation cannot enforce, writes the budget into `dispatch.json` as an acknowledged policy (replacing an older workspace budget for the agent, never a newer one), and queues the `policy_ack` for the workspace with the export id, budget id and version and digests it expects. Without `--yes` it only checks. When the machine is connected with `observations:write`, approvals left in `approvals/` as `{ "cloud_approval_id": "..." }` are consumed in the workspace at dispatch, and delegated sessions unknown locally are resolved there. `"cloud": false` in `dispatch.json` keeps everything local.
