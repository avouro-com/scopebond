# @scopebond/agent

## 0.3.2

### Patch Changes

- 50b18b0: `autostart on` now also starts the agent right away (on Windows the tray icon appears), instead of waiting for the next sign-in. `status` says plainly when the agent is not running and gives the Windows command (`scopebond-agent.cmd`). The command and the launcher no longer print Node's SQLite experimental warning.

## 0.3.1

### Patch Changes

- 8de1477: The daily self-check against a workspace that does not offer it yet (it answers 404) now reports this computer's own checks instead of a failure, so the tray stays green when everything on the computer works.

## 0.3.0

### Minor Changes

- 433c8df: The Scopebond window for warn mode: when the hook asks (`POST /override` on the local channel), the agent shows the rule, the action and a reason field with the operating system's own tools (Windows PowerShell and Windows Forms, macOS `osascript`, Linux `zenity`), one window at a time, and answers only from the window. The reason is sent to the workspace once, and waits while the computer is offline. On Windows a tray icon (from Windows' own PowerShell) shows green, amber or red with the one fix in its menu; on macOS and Linux a notification says when things get worse or recover. `GET /status` adds `health`.

### Patch Changes

- Updated dependencies [433c8df]
  - @scopebond/hook@0.16.0
  - @scopebond/gateway@0.13.0
  - @scopebond/sdk@0.1.4

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
