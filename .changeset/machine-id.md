---
"@scopebond/gateway": minor
"@scopebond/hook": minor
"@scopebond/agent": minor
---

A machine id, so a workspace can tell that a computer connecting again is the same computer.

- The machine id is `m1:` and the unpadded base64url SHA-256 of `scopebond-machine-id/v1`, the workspace's id (`unscoped` before it is known) and the operating system's own machine id (Windows `MachineGuid`, macOS `IOPlatformUUID`, Linux `/etc/machine-id` or `/var/lib/dbus/machine-id`), trimmed and lowercased. The operating system's id never leaves the computer and is never written, logged or shown; where there is none, nothing is sent, and the host name or a network address is never used instead.
- Sign-in and enrollment carry it as `machine_id` in their body (`login`, `connect`, the Scopebond Agent's first sign-in, `scopebond-gateway enroll`); the rules check, record deliveries and summaries, and observation uploads carry it in the `x-scopebond-machine-id` header.
- It is kept with its scope in `machine-id.json` beside `cloud.json` (the gateway: `scopebond-machine-id.json`, or `SCOPEBOND_MACHINE_ID_FILE`), worked out again once the workspace's id is known after enrolling, and once a day.
- `@scopebond/gateway` exports the shared implementation (`computeMachineId`, `readRawMachineId`, `cachedMachineId` from `@scopebond/gateway/node`; `MACHINE_ID_HEADER`, `isMachineId`, `machineIdHeaders` from the root), and `completeCloudEnrollment` and `createCloudExporter` take a `machineId` option.
