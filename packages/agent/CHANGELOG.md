# @scopebond/agent

## 0.4.4

### Patch Changes

- 5a2902f: gateway, hook: two coding agents on one computer no longer make each other's checks fail with "database is locked". A process now ends with a passive checkpoint instead of an exclusive truncating one (which waited for every other process and blocked writers meanwhile), and waits up to 15 seconds for the write lock instead of 5. A lock that still times out says what it is, instead of suggesting `init`.

  agent: an update hands over reliably. Hook entries move to the recommended hook before the agent updates itself, so a failed handover never leaves the hook behind, and the old agent exits within 5 seconds even if stopping its window or tray hangs, instead of staying alive while its replacement waits.

- Updated dependencies [5a2902f]
  - @scopebond/gateway@0.16.1
  - @scopebond/hook@0.19.2

## 0.4.3

### Patch Changes

- Updated dependencies [40c1fb7]
  - @scopebond/gateway@0.16.0
  - @scopebond/hook@0.19.1

## 0.4.2

### Patch Changes

- 50a46b4: hook: every rules check now reports what this computer runs for each rule (blocks or records) and who set it (the workspace or the person at the computer), so the workspace can show what is true on the computer. On a computer its workspace manages, `rules enforce <rule>` and `rules monitor <rule>` apply only where the workspace allows changes on computers (`local_changes` in the rules document); otherwise the command says the workspace sets the rule and changes nothing. Either way the workspace hears the result immediately. Scopebond's own protection is unaffected.

  agent: on Windows the launcher restarts an agent that stopped with an error after 30 seconds, up to 50 times, as launchd and systemd already do on macOS and Linux; a clean stop still ends it.

- Updated dependencies [50a46b4]
  - @scopebond/hook@0.19.0

## 0.4.1

### Patch Changes

- Updated dependencies [9fd79e2]
- Updated dependencies [c46cd98]
  - @scopebond/gateway@0.15.0
  - @scopebond/hook@0.18.0

## 0.4.0

### Minor Changes

- fb80a3f: `scopebond-agent setup <workspace-url>` (for example `npx -y @scopebond/agent@latest setup https://cloud.scopebond.com`; `npx.cmd` on Windows): one command that checks Node.js, signs the person in with a code (which puts the hook in the user-level agent settings), installs the agent for the user, turns autostart on and ends with `status`. Running it again keeps an existing connection to the same workspace, does not reinstall the same version and only repairs what is missing; `--relogin` signs in again. When npm's global folder is not on PATH it names the folder and the command that adds it.

### Patch Changes

- 29dd537: `scopebond-agent autostart off` also stops the running agent, and the new `scopebond-agent stop` stops it until the next sign-in. Before, an agent turned off (or even uninstalled with `npm uninstall -g`) kept running until the person signed out, with no command to stop it.
- 42d42f0: The tray turns red with "Every action is blocked: the delivery queue cannot be opened" and the fix when the hook's delivery queue cannot be opened (a full disk, read-only files), instead of staying green.
- c077348: `scopebond-agent autostart on` on Windows starts the agent now even where the headless console host does not start (seen on Windows Server): after a few seconds without an answer it starts the same launcher through `cmd.exe` with its window hidden. Before, the agent stayed stopped until the next sign-in and the command only said how to start it by hand.
- 78c0a29: Duplicate hooks: `status` and `doctor` say when an agent would run the Scopebond hook more than once for each action (user settings plus a project's, two entries in one file, or an enabled Claude Code plugin beside a settings entry), and the new `dedupe` command keeps one (the user-level entry unless `--keep project|plugin`), leaving other tools' hooks alone. The Scopebond Agent's self-check reports it as `hook_duplicates` with the fix. `dedupe` removes only the Scopebond command from a hook group it shares with a person's own hook (the group goes only when nothing else is left), never rewrites a file it has nothing to change in, and edits a git-tracked project file only when `--keep project` was chosen. Settings files with a byte-order mark are read too.
- eb5eaf9: Every next step the CLI prints is in the form the person's system runs. On Windows: an expired, denied or failed sign-in prints the exact `npx.cmd … login <workspace>` command to run again; "Node too old" gives the `winget` command and how to find an older Node that still comes first on PATH; `doctor` says when PowerShell's script policy blocks plain `npx`/`npm`/`scopebond-agent` and that the `.cmd` forms work without a policy change; the agent's autostart fixes, usage line, install hint and help use `scopebond-agent.cmd` / `npm.cmd`; and the warn-mode hint names `scopebond-agent.cmd autostart on`. New helpers: `agentCommand`, `npmGlobalInstall`, `nodeTooOldLines`, `loginAgainCommand`, `executionPolicyAdvice`, `explainPowerShellError`.
- 458294f: First-run fixes on Windows and beyond. The agent's autostart launcher switches cmd.exe to UTF-8 and writes its log beside itself, so it starts in a profile folder with non-ASCII letters. Only one agent runs per home even when two start moments apart (a lock file decides). Upkeep and repair keep the hook pinned by its path (the hook the agent carries) instead of switching to the slower `npx` form, which also needed npx on the coding tool's PATH. `setup` runs the sign-in from the home folder and, when a sign-in has to be repeated, names the setup command; npm is run as this Node's own npm, without a shell. A workspace that cannot be reached is explained (a company certificate: `NODE_EXTRA_CA_CERTS`; a proxy: `NODE_USE_ENV_PROXY=1`), and `doctor`'s note says the policy it read is Windows PowerShell's. Autostart starts the launcher with `cmd /s /c ""…""`, so a profile folder whose name has a space and `(`, `)` or `&` ("John (Work)") still starts the agent. The one-agent lock is taken over when it is older than a minute and no agent answers, so a sign-in after a restart is not refused because Windows reused the old process id.
- Updated dependencies [20c2266]
- Updated dependencies [c4514ca]
- Updated dependencies [7736223]
- Updated dependencies [78c0a29]
- Updated dependencies [8e42db0]
- Updated dependencies [2a9b060]
- Updated dependencies [2430526]
- Updated dependencies [3d01147]
- Updated dependencies [0ef0a87]
- Updated dependencies [67812b1]
- Updated dependencies [a9eaba1]
- Updated dependencies [6c3b253]
- Updated dependencies [eb5eaf9]
- Updated dependencies [458294f]
  - @scopebond/hook@0.17.0
  - @scopebond/gateway@0.14.0

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
