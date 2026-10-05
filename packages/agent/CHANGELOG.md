# @scopebond/agent

## 0.2.2

### Patch Changes

- Updated dependencies [d2cec83]
  - @scopebond/hook@0.15.2

## 0.2.1

### Patch Changes

- Updated dependencies [793e126]
  - @scopebond/hook@0.15.1

## 0.2.0

### Minor Changes

- 3ec2d5e: Autostart now starts a launcher that finds Node and the agent each time (no window on Windows), the agent follows the versions its workspace recommends (installing a newer agent and restarting, or holding when the workspace says so), keeps the Scopebond hook entries current and repaired, and runs a signed daily end-to-end self-check. New `scopebond-agent check`; `status` shows the version, autostart health and the last self-check. Dependencies are pinned exactly, so one agent version always runs one hook version.

## 0.1.0

### Minor Changes

- 464b80a: New package `@scopebond/agent`, the Scopebond Agent: one resident process per user that delivers the records the hook queued, runs the rules check (workspace rules, the queue report and credential renewal), notices agent settings that lost the Scopebond hook entry and repairs them on request, and reports `scopebond.status.v1` on a token-protected local channel (`127.0.0.1`, token in `~/.scopebond/agent.json`). `scopebond-agent autostart on` starts it with the user's sign-in on Windows, macOS and Linux, without administrator rights. The hook keeps deciding every action without it.

  The hook exports the delivery-state, status and credential-renewal functions the agent reuses.

### Patch Changes

- Updated dependencies [464b80a]
  - @scopebond/hook@0.15.0
