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
