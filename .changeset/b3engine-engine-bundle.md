---
"@scopebond/policy-schema": patch
"@scopebond/gateway": patch
"@scopebond/hook": patch
"@scopebond/agent": patch
---

Receipts may now carry two optional members a signed plugin gave the action: `pattern_id` (64 lowercase hex) and `intel`, an opaque slot of padded base64 holding at most 4 KiB. The receipt schema, `isReceiptIntel`/`isReceiptPatternId` and the `receipt_intel` vectors describe their shape only; the gateway signs them through the new `intel` option of `handleAction` and `observeAction`, `validateReceiptIntel` checks them, and a receipt made without them is unchanged byte for byte.

The hook can now load one optional signed plugin from `<home>/intel/current/intel.mjs`: only when the manifest beside it (`{ version, sha256, signature, key_id }`) verifies against a pinned policy key over `scopebond:component/intel/v1` and the module's SHA-256. It is asked about each action within 2 ms (a throw, a promise, a late or malformed answer gives nothing) and its answer is signed into the receipt as `pattern_id` and `intel`; it never changes a decision, and without it the hook writes exactly the receipts it wrote before.

New `scopebond-hook packs test --all` runs the vectors of every rule pack in force with this engine (and `packs test <file>` those of one pack file), exiting non-zero when one fails; it is the check an engine update runs before the new engine is used.

The signed install's hook now runs a newer engine bundle the agent staged and checked: `<home>/engine/current.json` names it, and it is loaded only when its manifest is signed by an updater key the executable carries, its bytes are the ones the manifest names, and it is newer than the engine inside the executable. Otherwise, or when it fails to start (recorded; after two failures it is not tried again), the engine inside the executable decides the call, and hook entries keep the `"<exe>" hook <harness>` form they have today.

The signed Scopebond Agent (per user and for every user) now takes a newer engine without a new installer: when the workspace names `hook_bundle` in its client-version answer, the agent downloads the bundle, checks the manifest's updater-key signature, the archive's and every file's SHA-256 and that it is newer (never an older bundle), stages it under `<home>/engine/<version>/`, runs the new engine's `packs test --all` against the packs in force, and only then names it in `<home>/engine/current.json`. A bundle that fails its vectors, or fails to start twice, is rolled back (to the one before it, else to the engine the installer carries) and never taken again.

The agent installs the plugin component its workspace names (`intel: { version, sha256, url }`): fetched from the workspace only, with the computer's credential and hook version, checked against the named SHA-256 and the pinned policy key, staged under `<home>/intel/<version>/` and switched to as `<home>/intel/current`; it is removed when the workspace is not licensed (402) or stops naming it.
