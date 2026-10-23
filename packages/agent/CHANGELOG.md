# @scopebond/agent

## 0.12.0

### Minor Changes

- d60ae5e: Report bounded recent hook callback activity over the authenticated local control channel, independently of Cloud enrollment. Reject stale, replayed and malformed messages, and invalidate activity after configuration or profile changes. Keep native verification, supported capabilities and licensing separate: a callback alone never establishes protected coverage.
- fc9a18a: Discover supported coding tools while the agent runs, including Copilot CLI, and enroll a detected tool when its hook file is missing. Automatic repair and upkeep honor saved exclusions. Configuration writes reject linked paths, preserve concurrent edits and unrelated settings, and replace files atomically. Status reports each tool separately and keeps native approval and runtime verification distinct from configuration; one tool's hook no longer makes another tool's self-check pass.
  
  Negotiate signed, bounded discovery reports independently of action delivery, with explicit environment categories and collection failures. Reports authenticate their actual contents and do not claim runtime proof or allocate licenses.
- 1622f90: Keep automatic integration and managed tool settings inside the selected user profile. Preserve exclusions during native migration, bind local discovery to an opaque profile identity, and distinguish local configuration from unverified execution in other environments. Uninstall uses the shared configuration lock and preserves local state when hook removal is refused.

### Patch Changes

- 846c95c: Package descriptions and READMEs use one vocabulary (Monitor or Block rules, signed records, protection packs) and list GitHub Copilot with the other supported coding tools. The SDK README's example now signs a coding-agent `shell.exec` action. No code changes.
- e169216: Route Codex session and after-tool events through observations without issuing pre-tool decisions. Preserve unknown outcomes, deduplicate callbacks, isolate correlation by coding tool, and prevent denied calls from acquiring completion records. Wire supported lifecycle events during enrollment and native migration while retaining native trust requirements.
- c9d5aed: Honor the active Codex configuration directory during discovery, enrollment, health checks and removal. Keep automatic access within the selected user profile and use the native session-end timeout.
- 5aafb75: Reconcile discovery within a short fallback interval after resume, even when the platform pauses timer clocks during sleep and no filesystem event arrives. Keep scans serialized and unchanged inventory deduplicated.
- 9c768a4: Documentation: tool discovery, shell record targets and Codex lifecycle observations described as they work.
- 093b542: Read installed tool versions from package metadata during automatic discovery. Leave the version unknown when metadata is unavailable instead of executing a program selected by its PATH name.
- 4fc63db: Preserve tool exclusions, disabled native hooks and selected profile preferences during connection and repeated setup.
- 997f5f1: Keep historical blocks quiet while the Windows tray waits for its first agent response after startup.
- Updated dependencies [ebd7215]
- Updated dependencies [c8b2831]
- Updated dependencies [846c95c]
- Updated dependencies [e169216]
- Updated dependencies [c9d5aed]
- Updated dependencies [3b0b63f]
- Updated dependencies [9c768a4]
- Updated dependencies [98a28d2]
- Updated dependencies [d60ae5e]
- Updated dependencies [fc9a18a]
- Updated dependencies [1622f90]
- Updated dependencies [4fc63db]
  - @scopebond/hook@0.32.0
  - @scopebond/gateway@0.20.7
  - @scopebond/sdk@0.1.12

## 0.11.6

### Patch Changes

- 3bbbf07: A person can now keep a block without being asked again ("Keep blocking without asking me"): the same action is denied at once for 30 days, the coding agent is told not to ask again, the tray lists it under the allowed items as kind "quiet" with Undo, and it is sent to the workspace as an allowance record with `kind: "quiet"` that never lets anything through.
  
  A workspace can now name the lengths a person's unblock may last (`lengths` on a rule's override terms: Once, 1 hour, Until tomorrow, 30 days); the hook reports the `answer_lengths` capability, refuses unknown lengths, offers `hour` and `tomorrow`, and makes allowances that last 1 hour, 24 hours or 30 days, while terms without `lengths` work exactly as before.
  
  The hook's new `ruleSummary` counts every rule in force (the starter rules, the workspace's own, the rule packs' rules on Block and each service the workspace blocks by name) and lists the packs in force, and the tray model passes these counts on; `ruleReport` keeps its shape.
  
  "Rules updated" now means the last successful rules check: a failed check keeps `checked_at`, records `last_attempt_at` and `last_error`, and is not tried again before five minutes have passed.
  
  The message a coding agent gets on a deny now has five lines (what was blocked in plain words and the rule's name, why, what to do, what the person can do, and a `Ref:` line with the clause, the mode and the record id), and its final instruction follows the outcome: the person can unblock it, an admin decides, it stays blocked, or the person chose to keep it blocked; a Safe Install block also says it stays blocked.
  
  A successful rules check also writes `checked_ok_at`, and the tray's offers for a block say that keeping it blocked (`quiet`) is offered.
- 630d3c5: The tray model groups today's repeats of one blocked action under one rule into one row, and each block carries why its rule exists for the panel's details.
  The tray model marks a block the person chose to keep blocked without being asked, lists it under Kept blocked with Undo, and names allowances made for an hour or until tomorrow by their length.
  Tray notifications are one switch, on unless the person turned it off (the older problems-only setting reads as on), and the tray model gives Settings its facts: protection with rules and packs, the workspace, when the rules were last updated successfully, and one Scopebond version.
  The agent answers GET /support with a support report for the tray's Get help: state, versions, settings and the last failures in its log, with folders, sign-in codes and anything token-shaped masked, and no keys, records, commands or reasons.
  The Unblock form offers Once, 1 hour, Until tomorrow and 30 days (15 minutes for older terms), optional quick reasons, one button named for the result, Ask an admin instead and Keep blocking without asking me; the result line names the length, the command and where it was recorded, and the Scopebond window (opt-in fallback) has the same choices.
- 42f748f: Records waiting to send are now the agent's job alone: the tray stays "Protected" with no "Send records now" and no attention state, the agent starts again at once when a delivery worked elsewhere or the computer woke instead of waiting out its backoff, and only after 24 hours awake and online without a delivery does Settings show "Records can't reach <workspace> since <time>"; on macOS and Linux a notification now comes only when the person must act, and when that is over.
  
  The agent now repairs this computer's setup as soon as it sees it broken (each cycle, whenever the tray asks, and before every self-check): a Scopebond hook entry a coding agent's settings lost is put back, a second copy is taken out, and autostart that is on but broken is started again (autostart the person turned off stays off); each repair is checked again and recorded as `last_repair` in `status`, the self-check runs once more after a repair, and the tray shows only a repair that failed, as "Scopebond couldn't reconnect to Claude Code" with Repair.
  
  Rules not checked for over an hour no longer turn the tray to "Rules not checked for…": the last-known rules stay in force, the agent checks again at once after a failed check and then after 1, 2, 4, 8 and at most 15 minutes, and Settings' "Rules updated" says when the last check worked.
  
  A self-check that did not pass no longer turns the tray to attention: Settings shows "Last check didn't pass: …" in words (never check ids), the line stays until a check passes, and "Check now" names what it found in the same words.
  
  A credential that ends within a week is renewed by the agent itself (at most once an hour, besides the rules check's own renewal), silently when the workspace renews it or does not answer; only when the workspace refuses does the tray ask "Sign in again to keep this computer connected" with "Sign in again…", and `status` reports the last renewal as `credential_renewal`.
  
  An update that does not install (a failed download or check, an install or start that failed) is now tried again after 1 hour, then 6 hours, then every 24 hours while the running version keeps protecting; `failedUpdate` reports how many tries failed, a version that installs forgets them, and Settings says "Update didn't install; Scopebond keeps protecting on <version>" only from the third failed try (nothing before).
  
  A workspace that refuses records for billing reasons (its monthly limit, no license, or the plan paused this agent) no longer turns the tray to attention for the developer: the tray stays "Protected" with no button, and Settings shows one line such as "Not licensed · 4 records wait on this computer" with the plain note under it.
  
  A workspace that cannot be reached now keeps the tray "Offline" however long it lasts (no attention state after four hours, so no toast), with the one line "Using this computer's rules; records send when back online".
  
  A person can mark a block "This shouldn't be blocked" from its details in the tray; the mark (the record, the rule and the action's key, never a reason or a command) is sent to a workspace that takes it, so its admins see which rules get in the way.
- 42453b6: The tray model now gives the code of a sign-in waiting for approval (`sign_in_code`, and the tooltip "Scopebond: approve code ABCD-EFGH" with the code whole), says whether this computer's first sign-in is still to come (`first_sign_in`), and names the update this computer took for a day after it (`updated`, from the new `noteRunningVersion`, which remembers the version that last ran in the Scopebond folder).
  
  The Windows tray restarts an agent that crashed, hung or stopped without a word, and tells the person only when two restarts in a row fail within ten minutes ("Protection is off on this computer" with a Restart it button, which starts the agent at once).
  
  The Windows tray's tooltip shows a waiting sign-in's code whole ("Scopebond: approve code ABCD-EFGH") and is cut at 63 characters; before a new install's first sign-in it tells no problem, then says "Connected to <workspace>" once; and after an update it says "Updated to Scopebond <version>" once per version.
- 1648958: `uninstall` now exits with code 75 (exported as `UNINSTALL_NOT_TOLD_EXIT`) when a workspace this computer is connected to could not be told about the removal, says when the computer is not connected to any workspace, and names the Scopebond folder once instead of twice when run from the home folder; a program that runs it for the person can set `SCOPEBOND_UNINSTALL_CALLER` to say what happens to the folder itself, and `uninstallReportLine` gives the line for a workspace's answer.
  
  `scopebond-agent uninstall` (also what the Windows installer's removal and the Settings -> Apps entry run) now says when the workspace could not be told and exits with code 75 while still removing everything else, stops the hook's uninstall if it takes longer than 30 seconds, tells the workspace itself if the hook's uninstall cannot start, and ends with one sentence naming the Scopebond folder: that it stays (keys and records not yet sent) and how to remove it, or that it was removed with `--purge`.
  
  The Settings -> Apps entry of an npm install now goes on to remove the npm package when only the workspace notice failed (and says so), ends with the sentence about the Scopebond folder, and is rewritten when the agent starts after an update, so it always runs the installed version's uninstall and shows its version.
- 1b8a705: The agent now counts, per day, the questions it asks a person and the notifications the tray reports showing (`POST /fatigue`), and each rules check sends the counts as `x-scopebond-fatigue: toasts=n;prompts=n;day=YYYY-MM-DD` (counts only, never what was shown).
  
  The pack format now has engine levels: `PACK_ENGINE_LEVEL` is 2, a pack may say `requires: { engine, action_types? }`, and a pack rule may carry `title`, `blockable`, `default_mode`, `safer_way` and `allow_patterns`; a pack that uses any of them must say `requires.engine: 2`, every existing pack validates and reads exactly as before, `validatePack(doc, { engine: 1 })` reads a pack as an older engine does, and `packEngineProblem` says why an engine cannot run a pack (`engine_too_old` or `unknown_action_type`).
  
  A signed taxonomy extension (`scopebond:taxonomy-ext/v1`, at the `./taxonomy-ext` subpath) adds action types as data, and `getActionType` reads the extension in force after the built-in registry, never replacing a built-in type.
  
  A rule pack's rule can now say its own title, whether it may block and whether it blocks by default: the hook reads `blockable` (falling back to the target rules for older packs), applies `default_mode` until a person or the workspace sets the rule, names the block by the rule's `title`, adds the rule's `safer_way` to the deny message's "What to do" line, and keeps these fields out of the policy clause.
  
  A workspace can now set the mode of any rule pack's rule in `pack_rules` (the hook reports the `pack_rules` capability; `pack_rules` is digested with the rules), a person may allow or ask about such a rule when its terms say so, and `rules enforce|monitor` accepts a pack's own rules.
  
  The hook now reads packs at engine level 2 and says so (`x-scopebond-pack-engine: 2` on the rules check and on each pack fetch, and the `pack_engine_2` capability): a pack that needs a newer engine or an action type the hook does not know is skipped and reported (`engine_too_old` or `unknown_action_type`, with what it needs) while every other pack is kept, `SCOPEBOND_PACK_ENGINE_LEVEL` can lower the level to see what an older engine does, and the signed pack list may mark a pack `shadow` (its rules record what they would block) or kill versions (`killed`, covered by the list's digest), which are dropped at once in favour of the version held before.
  
  The hook now fetches and verifies the signed taxonomy extension a workspace names in its pack list (`taxonomy-ext`), so a pack can emit a new kind of action, and a policy that names one of its opt-in types decides those actions, without a new hook.
  
  A rule pack's grammar can now read local facts (an environment variable, a file's digest, a top-level configuration value) in the folder the command runs in, and an MCP profile can read the environment; a pack's own vectors still run without them, so they derive the same on every computer.
  
  Each rules check now reports the packs on the computer in `x-scopebond-packs` (`id@version,…;rejected=id@version:reason,…;engine=2`): the packs in force, the ones not taken and why, and the engine level.
  
  The hook now reads and pins a next policy-signing key from a document the current key signs (`scopebond:policy-next-key/v1`, sent as `policy_next_key` on a rules answer), so the key can be rotated without a release, and a computer its workspace manages enforces signed rules when that document says `managed_signature_mode: "enforce"`.
  
  A rule id the hook does not know in a workspace document, or a malformed `pack_rules` entry, is now skipped and reported (`skipped_rules` on the rules confirmation and in `managed-meta.json`) instead of refusing the whole document.
- 0a0332d: Receipts may now carry two optional members a signed plugin gave the action: `pattern_id` (64 lowercase hex) and `intel`, an opaque slot of padded base64 holding at most 4 KiB. The receipt schema, `isReceiptIntel`/`isReceiptPatternId` and the `receipt_intel` vectors describe their shape only; the gateway signs them through the new `intel` option of `handleAction` and `observeAction`, `validateReceiptIntel` checks them, and a receipt made without them is unchanged byte for byte.
  
  The hook can now load one optional signed plugin from `<home>/intel/current/intel.mjs`: only when the manifest beside it (`{ version, sha256, signature, key_id }`) verifies against a pinned policy key over `scopebond:component/intel/v1` and the module's SHA-256. It is asked about each action within 2 ms (a throw, a promise, a late or malformed answer gives nothing) and its answer is signed into the receipt as `pattern_id` and `intel`; it never changes a decision, and without it the hook writes exactly the receipts it wrote before.
  
  New `scopebond-hook packs test --all` runs the vectors of every rule pack in force with this engine (and `packs test <file>` those of one pack file), exiting non-zero when one fails; it is the check an engine update runs before the new engine is used.
  
  The signed install's hook now runs a newer engine bundle the agent staged and checked: `<home>/engine/current.json` names it, and it is loaded only when its manifest is signed by an updater key the executable carries, its bytes are the ones the manifest names, and it is newer than the engine inside the executable. Otherwise, or when it fails to start (recorded; after two failures it is not tried again), the engine inside the executable decides the call, and hook entries keep the `"<exe>" hook <harness>` form they have today.
  
  The signed Scopebond Agent (per user and for every user) now takes a newer engine without a new installer: when the workspace names `hook_bundle` in its client-version answer, the agent downloads the bundle, checks the manifest's updater-key signature, the archive's and every file's SHA-256 and that it is newer (never an older bundle), stages it under `<home>/engine/<version>/`, runs the new engine's `packs test --all` against the packs in force, and only then names it in `<home>/engine/current.json`. A bundle that fails its vectors, or fails to start twice, is rolled back (to the one before it, else to the engine the installer carries) and never taken again.
  
  The agent installs the plugin component its workspace names (`intel: { version, sha256, url }`): fetched from the workspace only, with the computer's credential and hook version, checked against the named SHA-256 and the pinned policy key, staged under `<home>/intel/<version>/` and switched to as `<home>/intel/current`; it is removed when the workspace is not licensed (402) or stops naming it.
- f760776: A delete outside the working folder whose every target is tracked and committed in a git repository (nothing modified, staged, untracked or ignored under it) is now recorded instead of blocked, as `program_scope` `<program>/git_restorable`, because git can restore it; an untracked or changed target, a target outside any repository, the repository's own top folder, and any git error or slow answer keep the block.
  
  A person who may unblock an action can now allow "Similar commands in this project" instead, where the workspace lets them (`override.patterns`: `person`, `needs_admin` or `off`; the hook reports the `pattern_allowances` capability): the allowance carries `match` (the rule, the action type, the recipe and its bounds) and never matches outside one folder of one project or repository, another rule, or an always-on protection.
  
  The policy schema now defines a rule's pattern recipes (`allow_patterns`: `path_prefix`, `path_glob`, `package_name`, `host`, `mcp_tool`) and the bounds of a pattern allowance (`allowance.match`), with checks that refuse any bound wider than one project folder or repository, a `..` or `.` segment, or a wildcard where a folder is named.
  
  The agent's block offers now carry `similar` (the words, an example it covers and one it does not, and whether it needs an admin), and `POST /blocked/answer` accepts `scope: "similar"` with a length.
  
  The tray's Unblock form shows "Similar commands in this project" beside "Just this command" where it is offered, with its words and examples, and names the result on its button ("Allow similar commands for 30 days").
- 972aed2: A workspace can now keep some kinds of block quiet: the hook works out a blocked record's tuning digest (the sha256 of its action type, workspace rule, program, target class, environment and host) and, when the workspace's rules document lists it in `quiet_patterns` (sent only to a hook that reports the new `quiet_patterns` capability, and signed with the allowances), the action stays blocked but no one is asked about it, the coding agent is told it stays blocked, and the tray's note for the block says it is quiet; an allowance in force still lets the action through, and Scopebond's own protection is never quiet.
  
  The tray lists a block the workspace keeps quiet as "Kept blocked without asking you", with nothing to answer and no notification.
- Updated dependencies [3bbbf07]
- Updated dependencies [9a55ade]
- Updated dependencies [fcad353]
- Updated dependencies [1648958]
- Updated dependencies [1b8a705]
- Updated dependencies [0a0332d]
- Updated dependencies [f760776]
- Updated dependencies [972aed2]
- Updated dependencies [22dd251]
- Updated dependencies [07f7189]
  - @scopebond/hook@0.31.2
  - @scopebond/gateway@0.20.6

## 0.11.5

### Patch Changes

- 8ed768b: A workspace may now ask for no reason to unblock an action or to ask an admin (`reason_min` 0, accepted by a hook that reports the `optional_reason` capability); an unblock with no reason is recorded with no reason digest and a reason length of 0, while a workspace minimum above 0 still requires a reason as before.
  The Scopebond window and the tray's form accept an answer with no reason where the workspace asks for none, and say a reason is optional.
  An override record with no reason (no digest, length 0) is now a valid receipt member.
  The receipt schema allows an override record with no reason: `reason_digest` null and `reason_length` 0.
- 4d63a6e: - The Scopebond window now shows a command containing `&` exactly as it runs (for example `2>&1` and `a && b`); before, Windows hid each `&` as a keyboard-shortcut mark.
  - When the Scopebond tray is listening, a blocked action is asked about only in the tray, for the hook's whole wait; the Scopebond window no longer also opens after ten seconds.
  - On Windows the old Scopebond window no longer opens for a block when no tray is listening; set `SCOPEBOND_PROMPT_WINDOW=1` to bring it back for this release (it will be removed after that). macOS and Linux keep their dialog.
  - When no one could be asked at the moment of a block but the workspace lets the person act, the denial's "For the person" line now says to allow it (or ask an admin) from the Scopebond icon's recent blocks, or on this computer's page in the workspace, instead of saying the agent is not running.
- 391c3f7: The tray lists every block of the last seven days (up to 200), not only those among the newest 5,000 records, so a busy day no longer shows a blocked count over an empty list. The local store keeps an index of denied records for this (built by the agent's upkeep on an existing store).
  
  An agent's retries of one block (the same action, rule, project and session, each within 10 minutes) are one row with the number of tries, are announced once, and count once: the header, the Blocked tab, the menu and the Today row all show the same number of distinct blocks.
  
  Every block carries one outcome: Unblock, Ask an admin, or a plain sentence saying why it stays blocked (Scopebond's own protection, a rule set by the workspace, Safe Install's verdict in words, or Safe Install holding an install for the person), with "Copy details" where it helps. A block the person asked about follows the request (waiting, approved by whom, declined) and offers nothing more once a request or an allowance covers it; while a request waits, the agent checks for the answer every 10 seconds for 10 minutes, and the answer is announced unless notifications are off.
  
  "Check now" checks the rules and packs again and runs the self-check; it never installs an update. A failed self-check is kept until a check passes.
  
  The npm tray icon's menu shows `&` in commands as it is.
  
  The coding agent trying a blocked action again within 10 minutes, before the person answered, is not asked about again: the denial tells the agent not to retry and to tell the person, who acts on it from the tray.
- Updated dependencies [8ed768b]
- Updated dependencies [5756ef9]
- Updated dependencies [f083dbb]
- Updated dependencies [09e5726]
- Updated dependencies [14648fa]
- Updated dependencies [409298d]
- Updated dependencies [4d63a6e]
- Updated dependencies [a879854]
- Updated dependencies [356a8e1]
- Updated dependencies [391c3f7]
  - @scopebond/hook@0.31.1
  - @scopebond/gateway@0.20.5

## 0.11.4

### Patch Changes

- Updated dependencies [3ad147c]
- Updated dependencies [ca359b2]
  - @scopebond/hook@0.31.0

## 0.11.3

### Patch Changes

- Updated dependencies [40270e7]
  - @scopebond/hook@0.30.0
  - @scopebond/gateway@0.20.4
  - @scopebond/sdk@0.1.11

## 0.11.2

### Patch Changes

- Updated dependencies [524a841]
- Updated dependencies [e4ba261]
  - @scopebond/hook@0.29.0
  - @scopebond/gateway@0.20.3
  - @scopebond/sdk@0.1.10

## 0.11.1

### Patch Changes

- 5fb6d83: Status, doctor and the tray say in one plain line when the workspace does not license an agent (its records are refused with `not_licensed`): the starter protections stay on, the records wait on the computer, and an owner adds licenses in Settings, Billing. No flush is suggested, since sending again changes nothing.
- Updated dependencies [1af329c]
- Updated dependencies [5fb6d83]
- Updated dependencies [a71186a]
  - @scopebond/hook@0.28.0
  - @scopebond/gateway@0.20.2
  - @scopebond/sdk@0.1.9

## 0.11.0

### Minor Changes

- b892368: Install keys for company-wide installs. A Windows install given an install key (`msiexec ... ALLUSERS=1 KEY=sbk_...`, kept as the `InstallKey` setting) connects to its workspace on its first start with no sign-in code, as an unclaimed computer that its person then claims from the tray. A key that is not accepted falls back to the usual sign-in with a code. The installer keeps the key out of its log.

### Patch Changes

- 560880e: Windows hook entries: the quoted fallback is reported and hardened, and shared hook groups are kept.
  
  - `status` and `doctor` note when a Codex or Cursor entry uses the quoted form, which may not start under PowerShell. The quoted form is either written by an earlier release, or used because this computer has no short name for one of the folders; quoted network (UNC) paths count too. The note says the Scopebond Agent rewrites the entry when it can, or to reinstall.
  - A quoted path containing `$` or a backtick is refused with a clear error instead of being written (Git Bash expands those even inside quotes). A path with `%` or `!` is written: cmd.exe and Git Bash start it.
  - The short-name lookup passes the path to cmd.exe through an environment variable, so a folder name with `%`, `!`, `&` or `^` is not parsed. It reads cmd's answer as UTF-16 (`cmd /u`), so a name outside the console's code page reads correctly. The quoted form is used when the volume has short names switched off, a short name keeps such a character or is not plain ASCII, or the path is a network (UNC) path.
  - The Scopebond Agent rewrites a quoted Codex or Cursor entry into the plain form once that form is available. Claude Code runs hooks under Git Bash, which starts the quoted form, so its entries are left alone. The agent reports a change only when a settings file actually changed.
  - A path that cannot be written no longer stops anything else:
    - the dry-run previews show the refusal;
    - `init` refuses before anything is set up;
    - signing in reports it and fails;
    - the agent's upkeep, the move to the signed install and the hook repair record it for that coding agent and carry on.
  - Writing the hook (install, upgrade, the agent's upkeep, the Claude Code session entries) replaces only Scopebond's own hook in a hook group another tool shares. The group's matcher and other hooks stay, and Scopebond's hook keeps its own timeout. `uninstall` likewise removes only Scopebond's hook from such a group.
  - `doctor` also checks a Codex entry's `commandWindows`, and `init` recognises a hook that names Scopebond only there.
  - A hook command counts as Scopebond's only when it runs one of Scopebond's own programs:
    - `@scopebond/hook`;
    - `scopebond`, `scopebond-hook` or `scopebond-agent`;
    - a `cli.js` inside a `.scopebond` or `@scopebond` folder;
    - this hook's own `cli.js`.
  
    Another tool's `cli.js`, or a path that merely mentions "scopebond", is left alone.
  
  `flush` edge cases:
  
  - `flush` exits 1 when the last delivery attempt failed, even with nothing left in the queue (it used to exit 0 then).
  - A routine record stamped further ahead than one summary window and its grace (a clock set wrong) is sent in full rather than held for a window that will not close. Until then it counts as pending, not held.
  - The "held until" time shows its date when it is not today.
  - With only held routine records left, `flush` sends nothing and does not contact the workspace (now documented).
- Updated dependencies [4d30452]
- Updated dependencies [69ecb8d]
- Updated dependencies [560880e]
  - @scopebond/hook@0.27.0
  - @scopebond/gateway@0.20.1

## 0.10.0

### Minor Changes

- 7577598: A machine id, so a workspace can tell that a computer connecting again is the same computer.
  
  - The machine id is `m1:` and the unpadded base64url SHA-256 of `scopebond-machine-id/v1`, the workspace's id (`unscoped` before it is known) and the operating system's own machine id (Windows `MachineGuid`, macOS `IOPlatformUUID`, Linux `/etc/machine-id` or `/var/lib/dbus/machine-id`), trimmed and lowercased. The operating system's id never leaves the computer and is never written, logged or shown; where there is none, nothing is sent, and the host name or a network address is never used instead.
  - Sign-in and enrollment carry it as `machine_id` in their body (`login`, `connect`, the Scopebond Agent's first sign-in, `scopebond-gateway enroll`); the rules check, record deliveries and summaries, and observation uploads carry it in the `x-scopebond-machine-id` header.
  - It is kept with its scope in `machine-id.json` beside `cloud.json` (the gateway: `scopebond-machine-id.json`, or `SCOPEBOND_MACHINE_ID_FILE`), worked out again once the workspace's id is known after enrolling, and once a day.
  - `@scopebond/gateway` exports the shared implementation (`computeMachineId`, `readRawMachineId`, `cachedMachineId` from `@scopebond/gateway/node`; `MACHINE_ID_HEADER`, `isMachineId`, `machineIdHeaders` from the root), and `completeCloudEnrollment` and `createCloudExporter` take a `machineId` option.

### Patch Changes

- 3f0dd31: The Scopebond Agent no longer passes code-loading Node.js variables to what it starts, and a machine-wide workspace setting wins over a per-user one.
  
  - `NODE_OPTIONS` and `NODE_REPL_EXTERNAL_MODULE` are removed from the agent's environment when it starts, so no process it starts (the updated agent after a self-update, the hook's commands, npm, the installer helper) inherits them. Any program running as the person can set them for every later sign-in to load its own code into a Node.js program. The Windows tray also starts the agent without them.
  - A signed install's first sign-in now reads the `Workspace` value under `HKLM\Software\Avouro\Scopebond` (written by a per-machine install) before the one under `HKCU`, so a per-user value cannot move a computer an administrator deployed for one workspace to another.
- Updated dependencies [2c0b2af]
- Updated dependencies [7577598]
- Updated dependencies [a03b216]
- Updated dependencies [9df359a]
  - @scopebond/hook@0.26.0
  - @scopebond/gateway@0.20.0

## 0.9.1

### Patch Changes

- e835c1f: Every block the tray lists names its rule, and the project and coding tool where the hook knows them.
  
  - Rule names are the workspace's own ("Rewrite history on a protected branch", "Run a command that deletes data or shuts down the computer", "Read passwords, keys or secrets", …), for every workspace rule, in the tray, the Scopebond window and the hook's messages. A block by Scopebond's own protection reads "Change Scopebond's or the agent's safety settings" (a change) or "Read passwords, keys or secrets" (a read), and a blocked service reads "Blocked service". A rule the hook cannot name reads "A Scopebond rule": never an empty line, never a rule id. `ruleName` and `blockTitle` join `ruleTitle` in the hook's exports.
  - The hook notes each call it blocks in `block-notes.json` in its folder: the action's id, the clause that denied it and the rule that clause carries, the coding tool's id and the project's name (the repository's, else the folder's, never the home folder). It holds no arguments and never leaves the computer. `localActivity` reads it, so a block whose receipt has no context (a workspace that has not said it reads it) or names no rule still shows its rule, project and tool; each recent block now carries `rule_title` and `project`.
  - The hook's question to the agent carries the project (`project`), for the window and the tray.
  - The tray's panel and notifications show "A Scopebond rule" when an older agent sends no rule name, instead of a blank line or the rule's id.
- Updated dependencies [e835c1f]
  - @scopebond/hook@0.25.1

## 0.9.0

### Minor Changes

- 7a4ffe3: The tray lists what was blocked in plain words, and allowing an earlier block from the tray offers 15 minutes again.
  
  - Fix: acting on an earlier block from the tray (`POST /blocked`) left "Allow for 15 min" out of the Scopebond window, because the question for an earlier block carried no 15-minute offer. `blockedQuestion` now offers it wherever the window offers it when the block happens (a rule set to "Block, person may allow" whose workspace sends the allowance terms, under the daily limit), and `actOnBlocked` makes a 15-minute allowance only where it is offered.
  - `GET /tray` lists up to 20 recent blocks (was 3), newest first. Each keeps its older fields and adds `what` (the action in plain words, such as "Read .env.production" or "git push --force origin main", with secrets masked as the Scopebond window masks them), `action_text` (the text the window shows), `rule_title`, `project` (the repository's name), `tool` ("Claude Code", "Cursor", "Codex"…), `offers` (once, fifteen, always with `always_days` and `always_needs_admin`, ask) and `reason_min`. The model also adds `can_ask` (the workspace lets a person ask an admin under some rule), `detail` (the line under "Protected"), `workspace` (its name) and `today` (actions and blocks since midnight).
  - The hook exports `plainAction` and `ruleTitle`; `localActivity` adds `what`, `action_text`, `harness` and `repository` to each recent block, and `blockedQuestion` adds `offers.fifteen`, `always_days` and `always_needs_admin`.
  - The PowerShell tray lists the newest five blocks, in plain words.
- dd05d59: The tray answers the hook's question during a coding session, and a person can stop an allowance.
  
  - Live prompt: when the hook asks the agent during a coding session (`POST /override`) and a tray is listening, the agent hands the question to the tray first (`POST /override/wait`, a long wait; `GET /tray` carries it as `pending`). The person answers in the tray's panel (`POST /override/answer`, checked as the window's answer would be), and the hook's waiting call receives that answer. If the person does not open the question in the tray within a third of the hook's wait (ten seconds at most; `POST /override/open` says they did), it is withdrawn and the Scopebond window opens for the time left. With no tray listening the window opens at once, as before. Unanswered at the deadline, nothing is allowed.
  - The hook's question carries the coding tool and what the workspace set about the length (`harness`, `reviewed`, `always_days`, `always_needs_admin`); an older agent ignores them.
  - Stop allowing: `POST /allowances/stop` ends an allowance the person made (`endAllowance` in the hook: it stops applying at once and stays stopped when the workspace sends its copy). The agent sends the workspace `{ id, state: "ended", ended_by: "person", ended_at }` to `/v1/allowances`, signed like the other records, once; a workspace that refuses it is not asked again.
  - Where the workspace sets the unblock terms, an allowance a person makes carries `unblocked` (`automatic` or `person`); the Allowed list shows "Unblocked automatically".
  - The Scopebond window says "Ask to unblock" ("You may ask to unblock it; an admin decides."), and the macOS and Linux dialogs offer the workspace's one length when it sets one (`singleChoice`) instead of refusing.
- c707f52: The tray answers earlier blocks itself and lists what was allowed and asked.
  
  - `POST /blocked/answer` (`{ action_id, choice, reason }`, `choice` one of `once`, `fifteen`, `always`, `ask`) answers an earlier block from the tray's own form. The agent checks it as the Scopebond window would (the block is still offered, the workspace offers that choice now, the reason is long enough and at most 500 characters) and applies it exactly as the window's answer: the allowance or the request on this computer, sent to the workspace signed by this computer's key. It answers with the outcome and the words the tray shows ("Allowed once · Recorded and sent to Acme"; for a request, "Request sent · you'll see the answer under Requests").
  - `GET /allowances` lists the allowances that still apply and those waiting for an admin (what, the rule's name, once / fifteen / always, who made it, when it ends); `GET /requests` lists the requests to an admin (waiting, approved or declined, who answered and their note when the workspace sends them). `GET /tray` carries both as `allowed` and `asked`.
  - Notifications: a new setting value, `blocks` (blocks and problems), is the default on an agent's first start in a new Scopebond folder; an install whose person never chose keeps `problems`, and an older `all` reads as `blocks`. The PowerShell tray offers *Blocks and problems*, *Problems only* and *Off*.
  - A workspace may set the one length a person's unblock lasts (the rule's `lasts`: `once`, `15m` or `always`) and say that every unblock is reviewed by an admin later (`review`). The window and the tray then offer only that length; an answer for another length allows nothing. The hook reports the `unblock_terms` capability, and a workspace sends these terms only then. The hook exports `offersFor`, `allowsAny` and `offeredLength`; `blockedQuestion` adds `reviewed`, and the tray model's `offers` add `reviewed` ("Unblocked until 4:07 PM · an admin will review it").
  - The hook remembers, on this computer only, the text the Scopebond window showed for each action a person allows (`action-text.json`, the newest 500; `readActionText`, `rememberActionText`), so the tray can say what an allowance lets through. It is never sent.

### Patch Changes

- Updated dependencies [7a4ffe3]
- Updated dependencies [dd05d59]
- Updated dependencies [c707f52]
  - @scopebond/hook@0.25.0

## 0.8.1

### Patch Changes

- Updated dependencies [0a135da]
- Updated dependencies [feba379]
- Updated dependencies [f8fa8ea]
- Updated dependencies [47d72a4]
  - @scopebond/hook@0.24.0
  - @scopebond/gateway@0.19.1

## 0.8.0

### Minor Changes

- 8b9b474: The agent reports which AI coding tools are present on this computer and whether the Scopebond hook checks them. Every
  self-check (daily, and on each start) now sends two optional lists: `tools` (Claude Code, Cursor, Codex, GitHub Copilot
  CLI, Windsurf, Gemini CLI, Cline, OpenCode, Aider: id, installed version or null, `governed`, `settings_present`; at most
  20) and `mcp_servers` (the names, only, of the MCP servers in each tool's user-level MCP configuration; at most 100, each
  at most 120 characters). The inventory is reported by the agent over its authenticated connection and is not covered by
  the self-check signature, so the workspace labels it "as reported on <day>". A tool counts as present only when its
  user-level settings exist; `governed` means the hook is in the tool's user-level settings file (a project-only install
  shows as not governed). A version is read from the global npm install's package manifest, or from `--version` for a
  present tool whose program is known to answer it and exit (3 s limit); no tool is started in a way that opens a session.
  No path, command, argument, environment value or address is sent. `scopebond-agent status` and `status --json` show the
  tools.
- c9165a0: Managed tool settings. A workspace rules document may carry a `tool_settings` section, signed on its own with the workspace key and checked with the rules check itself (`checkToolSettingsSignature`; its signed payload adds `kind: "tool_settings"`, which a rules payload never carries, so a rules signature never passes for it, nor the reverse): for each AI coding tool, permission rules to allow and to deny and MCP servers it may or may not start, and `mode: "enforce" | "report"`. The hook carries it (a changed section at the same rules version is installed; an answer without one leaves the installed section), and sends the agent's version (`x-scopebond-agent-version`) and report (`x-scopebond-tool-settings`) on the agent's rules check. The Scopebond Agent applies a section only when a trusted key signed it (otherwise `refused: unsigned`, nothing written): to Claude Code's `~/.claude/settings.json` (`permissions.allow`/`deny`, `allowedMcpServers`/`deniedMcpServers`) and the Cursor CLI's `~/.cursor/cli-config.json` (`permissions.allow`/`deny`, denied servers as `Mcp(<name>:*)`); Codex (per-server settings in TOML, which Scopebond does not rewrite yet) and GitHub Copilot are reported as unsupported. Only entries Scopebond added are ever removed, a list it created goes once empty, other keys and entries stay, the file is backed up once and replaced atomically, a file that does not parse or is a symbolic link is never written, `CLAUDE_CONFIG_DIR` is honoured, rules without a section report `not_delivered`, replay marks are kept per workspace, entries with bidirectional or invisible formatting characters are refused, and each tool is reported as applied, drifted (setting names only, never values) or refused; a drift is put back only in enforce mode.

### Patch Changes

- bf5be26: Records no longer name your account. Before an action is signed, the hook writes your home folder as `~` in the working
  folder, file paths and the command line (a project in your home folder is recorded as `~/repo`), and the account name
  in any other home-folder path as `~other`. The home folder is the one the system reports plus `HOME` and `USERPROFILE`;
  a Windows home matches in any case and with either separator. Rules keep matching: rules written relative or with `~`
  match as they are, and a rule that names your home folder by its full path is read as `~/…` when the rules load
  (`rules protect <path>` now stores it that way).
  
  New: `SCOPEBOND_HOSTNAME_MODE` chooses the computer name a sign-in sends (`login`, and the Scopebond Agent's first
  sign-in): `full` (the default, unchanged), `hash` (the first 12 hex characters of the SHA-256 of the host name) or `off`
  (none).
- Updated dependencies [fef136d]
- Updated dependencies [4bad113]
- Updated dependencies [bf5be26]
- Updated dependencies [c652c9e]
- Updated dependencies [7687816]
- Updated dependencies [0b1a503]
- Updated dependencies [ad9512d]
- Updated dependencies [c9165a0]
- Updated dependencies [d401d09]
- Updated dependencies [d401d09]
- Updated dependencies [9c70fd6]
- Updated dependencies [6797bbd]
- Updated dependencies [6797bbd]
  - @scopebond/hook@0.23.0
  - @scopebond/gateway@0.19.0
  - @scopebond/sdk@0.1.8

## 0.7.0

### Minor Changes

- 9124dad: Windows: the signed installer is the one Windows install. A signed install that was never connected signs in by itself
  on its first start (the workspace the installer named under `Software\Avouro\Scopebond\Workspace`, HKCU then HKLM, else
  Scopebond Cloud; https only), and the tray offers **Sign in…** until it is connected; approved, it sets up the hook
  entries and autostart as `setup` does. Signed installs update only to the workspace's `native_agent` (the newest
  published signed build; no field means no update), through a copy of the signed program that checks the installer again,
  runs msiexec with a verbose log in the updates folder, and confirms the new agent starts; a version that does not
  install or start is recorded and not tried again for a day. The signed agent takes over from an npm install (stops it,
  removes its sign-in entry, launcher and Apps entry, and points the hook entries at itself). Messages name
  `scopebond-agent` and `scopebond-agent hook` under the signed install, and `status` and the self-check name hook
  entries whose program is gone.

### Patch Changes

- Updated dependencies [a2ce061]
  - @scopebond/hook@0.22.0

## 0.6.5

### Patch Changes

- Updated dependencies [e7ddb4a]
  - @scopebond/gateway@0.18.0
  - @scopebond/hook@0.21.11

## 0.6.4

### Patch Changes

- 5a85492: The tray no longer says a plan change lifts the workspace's monthly limit unless the workspace said so (then it names the limit that plan gives); the record exporter treats a redirect as a failed delivery and retries, never sending records on; an unsent "Ask an admin" request is never dropped to make room in `requests.json`; the typed MCP adapter checks its config at start and approves a resource only on an exact match in a list; `policy load --yes` in a trusted project keeps the loaded policy trusted, so it is the one that governs; `dedupe --keep plugin` with no enabled Scopebond plugin changes nothing, and dedupe backs up and replaces a settings file whole; autostart health checks that the sign-in entry starts this home's launcher, a systemd unit writes `%` and `$` literally, and a Windows home path with `%` is refused; the agent's loopback channel refuses a foreign Host and any request with an Origin.
- fc919a7: A recorded wait the workspace asked for (429, or 503 with Retry-After) never holds delivery more than an hour and five minutes after it was recorded, and a clock that jumps no longer extends it; a host name that does not resolve is recorded as failed, not as an unknown outcome; a scoped link-local IPv6 address from the resolver is compared without its zone index; the chain-head check no longer reports a rollback after a clock step back or across computers sharing one folder; and the MCP proxy's session history is bounded in calls and bytes.
- Updated dependencies [5a85492]
- Updated dependencies [fc919a7]
- Updated dependencies [b1d3728]
- Updated dependencies [b1d3728]
- Updated dependencies [cbddbcc]
  - @scopebond/gateway@0.17.7
  - @scopebond/hook@0.21.10

## 0.6.3

### Patch Changes

- Updated dependencies [cbfe241]
  - @scopebond/hook@0.21.9

## 0.6.2

### Patch Changes

- da85dd4: Delivery no longer stalls behind a record the workspace will never accept, and it honours a workspace that asks a computer to wait. A record over the workspace's size limit (one long URL or one large tool argument) used to be re-sent at the head of every batch and hold every newer record back for good; now large records travel alone, a batch refused for its size is split, and a record refused on its own for its size leaves the queue as an `oversize` gap (shown in `status`, `status --json` and `doctor`, reported to the workspace with the other gaps, and kept in the local log). A refused batch listing records refused for good beside records kept back (a clock ahead, a key not yet enrolled) now settles the first and keeps the second. A 429, or a 503 with Retry-After, is now honoured across hook calls and agent cycles: the wait (at most an hour plus a small random spread; a 429 without Retry-After starts at 30 seconds and doubles) is kept in `delivery.json`, `status` shows the next try, and `status --json` adds `delivery.backoff_until`.
- aaa031e: Keys, the Cloud credential, chain heads and the receipt and dispatch databases (with the journal files SQLite keeps beside them) are readable by their owner alone from their first byte, on Windows and POSIX, also in a folder other local users can open; a credential write replaces a file or link at its name instead of writing through it, and processes that create a key at the same moment now agree on one key.
  
  Upgrading: the hook's and the agent's folder is made readable by its owner alone on their next run, files an older version left there included. A self-hosted gateway or MCP proxy restricts its existing key files, credential file and databases the next time it opens them.
- 4f79b89: Programs started by name are no longer looked up in the current folder, which Windows otherwise searches before PATH: `git`, `npm` and an MCP upstream named without a folder come from the absolute folders on PATH, and Windows' own tools (`icacls`, `reg`, `powershell`, `cmd`, `conhost`, `explorer`) from the system folder. A `git.exe` or similar placed in a project, or in a pull request's checkout, is no longer run by the hook, the agent, the MCP proxy or the pull request check; a program that cannot be found that way is not started. `@scopebond/gateway/node` exports the lookup as `findProgram`, `programPath` and `windowsSystemProgram`.
- Updated dependencies [7529bc5]
- Updated dependencies [da85dd4]
- Updated dependencies [0929cac]
- Updated dependencies [99b0577]
- Updated dependencies [aaa031e]
- Updated dependencies [8d94b55]
- Updated dependencies [4f79b89]
  - @scopebond/gateway@0.17.6
  - @scopebond/hook@0.21.8

## 0.6.1

### Patch Changes

- 611d02c: A caller that drops its connection to the agent's local channel mid-request no longer stops the agent, plus lint clean-ups that change nothing else.
- Updated dependencies [611d02c]
- Updated dependencies [3805a5a]
- Updated dependencies [a17f73b]
  - @scopebond/gateway@0.17.5
  - @scopebond/hook@0.21.7
  - @scopebond/sdk@0.1.7

## 0.6.0

### Minor Changes

- 0f9e040: The signed Windows install can carry the native Scopebond tray (`scopebond-tray.exe` beside the agent). When it is there, the agent leaves the tray to it (no PowerShell tray), `autostart on` sets the tray's own sign-in entry (`Scopebond`, which starts the agent) instead of the launcher's `ScopebondAgent` and retires the latter, `autostart off` removes it, `status` reports it, and after a self-update the helper stops the tray, installs, and starts the tray again (which starts the updated agent). npm installs are unchanged.

### Patch Changes

- ed31dd1: Scopebond appears in Windows Settings -> Apps for an agent installed with npm. `setup` and `autostart on` write a per-user
  entry (Scopebond Agent, Avouro LLC, the version; no administrator rights) whose Uninstall runs the agent's own `uninstall`
  (autostart off, the agent stopped, the hook taken out of the coding agents' settings, the workspace told) and then
  `npm uninstall -g @scopebond/agent`. `uninstall` removes the entry. The Scopebond folder stays, so installing again is the
  same computer; `uninstall --purge` deletes it.
  The Uninstall script is written as UTF-8 with a byte-order mark, so Windows PowerShell 5.1 reads a profile folder with
  non-ASCII letters (or a typographic apostrophe) correctly, and it says "removed" only when it worked: when the agent was
  already gone or its own uninstall failed, it says what did not happen and exits 1.
- aacdb6c: A backlog is no longer hidden after the agent restarts. Waiting used to be counted from the agent's start, so after an
  update or a crash a four-hour backlog showed "Protected" for fifteen minutes. The agent now keeps the computer's wake time
  in `agent-awake.json` across its own restarts; after the computer was switched off it counts from the computer's start,
  and time asleep still never counts. After a long gap without a restart of the computer (the agent was stopped, or the
  computer slept), a record written during the gap counts from when it was written, and an older record keeps the time it
  waited before the gap.
- 4e6ceff: The agent keeps the evidence-chain head each delivery answer carries in the hook's `chain-heads.json`, like the hook, so `scopebond verify --anchor` can check it later.
- 58fa74d: The agent keeps answering while it works. The local store's upkeep (up to 30 seconds of database work, or a full rewrite
  of an older file) now runs as `scopebond-agent upkeep` in a process of its own, so the tray, `status` and the workspace's
  requests are answered meanwhile. One cycle sends for at most a minute and the next cycle starts at once while records
  remain, so a long queue never holds up the rules check. The gateway's exporter lets the event loop run between batches
  and takes `flush({ maxMs })`: no new batch starts once that time is up.
- 688e402: `scopebond-agent.exe setup <workspace-url>` works after the signed Windows installer on a computer without Node or npm:
  the single executable counts as installed (no `npm install -g`), autostart starts the executable itself, and the status
  and the retry hint name the executable. The daily self-check also says how the agent was installed (`install_kind`: npm,
  per-user or per-machine), so a workspace can show it.
- 6480952: A stop asked for by this computer's user (`scopebond-agent stop`) leaves `agent-stopped.json` in the Scopebond folder,
  and the next start of the agent removes it. The native Windows tray uses it to tell a stop on purpose (it leaves the
  agent stopped) from an agent that went away without a replacement (it starts it again).
- 0b6b433: The agent's own updates are harder to subvert. The npm update (and `setup`'s install) runs `npm install -g` with package
  scripts off and the public registry pinned (also for the @scopebond scope), without registry or script settings from the
  environment, and only after the registry's npm provenance for that exact version names this repository's main branch and
  the tarball it serves. The workspace's version answer is bounded: at most 4 KiB, a known policy, strict `x.y.z` versions
  no more than one major version ahead; anything else is no answer and nothing changes. Hook entries are always pinned to the
  hook the agent carries, by its path: a version named by the workspace is no longer followed, the `npx -y …@<version>` form
  is never written, and existing `npx` entries are re-pinned. After installing, the agent runs the new program and requires
  it to report the new version, then waits for the new agent to answer before exiting; if either fails it reinstalls the
  version it was running and does not retry that version for a day. The new `scopebond-agent version` command prints the
  agent and hook versions. The signed Windows updater can trust several updater keys (key id and last day of use, from
  `updater-keys.json`), a manifest names the key that signed it, and the helper checks the installer's size, digest and
  signature again, from a handle that keeps the file unchanged, right before it starts msiexec; Windows' tools are started
  by their full paths.
- 1a587dc: The signed Windows install checks an update's installer again right before installing it. The helper that waits for the
  agent to exit now holds the installer open (no writes or deletes) and checks its size and SHA-256 against the signed
  manifest and its Authenticode signature against the same publisher rule, before msiexec runs. Any mismatch installs
  nothing; the reason is recorded in `updates/install-result.json` and logged when the agent starts again.
  Windows PowerShell is started without an inherited PowerShell 7 module path, so the signature check also works for an
  agent started from PowerShell 7.
- 52502c3: The same action gets the same treatment in Claude Code, Codex and Cursor.
  
  - Cursor is answered `allow` only for a clean evaluated allow. An action a monitored rule finds out of policy now gets no
    opinion (`ask`), so Cursor's own approval decides, as Claude Code's and Codex's do when the hook stays silent.
  - A Cursor edit reported after it was written (`afterFileEdit`) that breaks a blocking rule is signed with the new execution
    state `observed_after` (`realtime_result: "deny"`, `executed: true`) instead of `denied`. `log` shows it as "recorded, not
    prevented", the tray and local counts keep it apart from blocks, and it is never counted as one. The gateway takes this as
    the `observedAfter` action option (nothing is dispatched and no override is asked); the receipt schema, evidence vectors
    and evidence check accept the new state.
  - The hook program answers deny on any failure the commands do not catch themselves (a module that cannot load, an uncaught
    error): Claude Code gets exit 2, Codex and Cursor their deny answer.
  - The Scopebond Agent checks the Codex and Cursor hook entries on each maintenance pass and keeps each outage (an entry that
    cannot start) as one `hook_unresolvable` delivery gap, which the rules check reports with the other gaps; `status` lists
    such outages apart from records that missed delivery.
- 6838107: Beside the native Scopebond tray (the signed Windows install) the agent no longer listens on 127.0.0.1: its tray and its hook (the same program) reach it over its named pipe. npm installs keep the loopback port for now, because the PowerShell tray and hooks before the pipe use it (`SCOPEBOND_AGENT_LOOPBACK=0` still turns it off). `startControl` takes `{ loopback }`.
- f4ff598: The agent's delivery follows the hook's new default evidence detail: a computer whose workspace has not named one sends
  the Standard detail (notable receipts in full, routine ones as signed summaries), and Full only when the workspace or the
  computer's own saved setting says so.
- Updated dependencies [58fa74d]
- Updated dependencies [4e6ceff]
- Updated dependencies [52502c3]
- Updated dependencies [4e6ceff]
- Updated dependencies [f4ff598]
  - @scopebond/gateway@0.17.4
  - @scopebond/hook@0.21.6

## 0.5.6

### Patch Changes

- Updated dependencies [0225f33]
- Updated dependencies [0225f33]
- Updated dependencies [faacb85]
- Updated dependencies [9ed82ed]
  - @scopebond/gateway@0.17.3
  - @scopebond/hook@0.21.5

## 0.5.5

### Patch Changes

- Updated dependencies [b35ae68]
  - @scopebond/hook@0.21.4

## 0.5.4

### Patch Changes

- b9c0504: Each delivery batch's record numbers are now signed with the computer's enrolled key. The Cloud exporter takes an optional `sequenceProof` (the attester and the machine credential's id) and sends `seq_proof: { kid, signature }` beside `seq` and `queue`, over `"scopebond:delivery-sequence/v1\n"` followed by the canonical JSON of the credential id, the queue id, the numbers and the SHA-256 of each receipt as sent. A party holding only the bearer credential can no longer attach numbers to records of its choosing. The hook and the agent sign with the key that signs their receipts; an exporter without a key sends the numbers unsigned, as before.
- Updated dependencies [bc4999d]
- Updated dependencies [ddb4033]
- Updated dependencies [b7bbe7a]
- Updated dependencies [b9c0504]
  - @scopebond/hook@0.21.3
  - @scopebond/gateway@0.17.2

## 0.5.3

### Patch Changes

- 258cdb6: Records that miss normal delivery are now kept, put right and reported.

  - When a receipt is written locally but its delivery-queue write fails (the queue cannot be opened, or another process holds its lock), the action stays allowed and recorded on the computer as before. The miss is now noted, kept as an `outbox_error` gap on the next flush, and the receipt is queued then (every receipt written since the miss that the queue does not know yet, in log order). A tool call waits at most 2 seconds for the queue's lock, so an override wait plus a lock wait stays inside the coding agent's hook time limit; after an override wait, the local log also waits less for its lock. `flush` and the Scopebond Agent keep the longer wait.
  - An evaluation stopped between its reservation and its receipt (a hook time limit, a crash) is closed after five minutes by the next hook call or the Scopebond Agent, with a signed receipt whose outcome is unknown (`execution.state: outcome_unknown`, reference `scopebond:evaluation-interrupted`, the policy's decision kept), queued like any other.
  - The delivery queue keeps a lifetime count of gaps per reason (`status().gapsByReason`), beside the lifetime total; the gap rows themselves are still trimmed to the newest 10,000. `SqliteCloudOutbox` takes a `busyTimeoutMs` option and has `setBusyTimeout()` and `known()`; `SqliteReceiptStore` has `interruptedActions()`, `settleAction()`, `lastId()` and `setBusyTimeout()`.
  - The rules check sends `x-scopebond-gaps-total` (the lifetime total) and `x-scopebond-gaps-by-reason` (compact JSON of reason code to count) when the queue has any gaps. `status` and `doctor` show a "delivery gaps" line, and `status --json` adds `delivery.gaps_total` and counts `delivery.gaps_by_reason` over the queue's lifetime.
  - The status texts no longer say an unusable delivery queue blocks every action: actions stay allowed and recorded on the computer, and are sent once the queue can be written again.

- d6996ad: Delivery no longer stalls on a request that never answers. Each delivery request now has a time limit (30 seconds by default, `requestTimeoutMs`), and the limit also covers reading the answer.

  The Scopebond Agent:

  - caps each delivery cycle at 10 minutes and goes on to the next cycle;
  - starts its maintenance before the first cycle;
  - answers Send now and stop without waiting on a stuck cycle;
  - reports when the running cycle started (`cycle_started_at` in `/status`).

  The hook:

  - waits on a flush that is already sending instead of returning at once, so a backlog of 100 or more records drains from hook calls;
  - records a cut-off only when its time limit really ran out;
  - no longer replaces the agent's recent delivery error with its own cut-off message.

  An agent that the workspace's plan paused now says so in the tray and in `status`, instead of offering Send records now.

  The rules check now sends `x-scopebond-accepts-requests`: `flush,self_check` from the agent and `none` from a hook call. A workspace that reads the header then leaves a request from its computer page (send now, check now) for the agent.

- Updated dependencies [258cdb6]
- Updated dependencies [d6996ad]
- Updated dependencies [7fc5efb]
- Updated dependencies [0f7268b]
- Updated dependencies [0f7268b]
- Updated dependencies [af23f31]
- Updated dependencies [6529530]
- Updated dependencies [f52a2ff]
- Updated dependencies [3839ff8]
- Updated dependencies [d066717]
- Updated dependencies [88a6380]
  - @scopebond/gateway@0.17.1
  - @scopebond/hook@0.21.2
  - @scopebond/sdk@0.1.6

## 0.5.2

### Patch Changes

- 739c935: The tray says when the workspace has reached its monthly limit ("Workspace limit reached: N records waiting", with Open workspace) instead of "N waiting · sending", and names the status of any other refusal; records stay on the computer either way. The agent's local answers now say they are UTF-8, so the PowerShell tray shows "·" instead of "Â·".

## 0.5.1

### Patch Changes

- Updated dependencies [06b09e7]
  - @scopebond/hook@0.21.1

## 0.5.0

### Minor Changes

- d29fe87: The Scopebond Agent's local channel now runs over a named pipe on Windows (a random name, kept in `agent.json` in the user's own Scopebond folder) and a Unix socket elsewhere (in a folder only the user can open, the socket itself 0600). Another user can neither find nor open them, unlike a loopback port, which any program on the computer can reach. The `scopebond-agent` commands and the hook's override window use it; the token is still required. The loopback port stays on for one more release, for the PowerShell tray, and `SCOPEBOND_AGENT_LOOPBACK=0` turns it off.
- 8874b49: `scopebond-agent uninstall [--purge]`: turns autostart off, stops the agent, and runs the hook's uninstall (which tells the workspace and takes the hook out of the coding agents' settings). The Windows installer runs it when Scopebond is removed.
- cb4d4e0: People may allow blocked actions for a while, or ask an admin. In the Scopebond window a person may choose **Allow once**,
  **Allow for 15 min**, **Always allow this here…** or **Ask an admin**, as the workspace allows. "For 15 min" and "always"
  leave a standing _allowance_ for the same action (the same type and parameters, whatever tool call it comes from): it is
  bound to one rule, expires (30 days by default), and never applies to Scopebond's own protection. A new rule mode, _Block,
  person may ask_, offers only **Ask an admin**: the action stays blocked and the request goes to the workspace, which answers
  with an allowance on the next rules check. The agent sends a person's allowances and requests to the workspace once, signed
  by the computer's enrolled key.

  The receipt of an action an allowance lets through carries `override.method: "allowance"`, with `repeat_of` naming the
  allowance and `reason_digest` the reason it was made with (receipt schema and `validateOverrideRecord`). The hook reports
  `x-scopebond-hook-capabilities: allowances` on its rules check, so a workspace sends the new mode and terms only to hooks that
  understand them.

  Also: the action key that recognises "the same action" leaves out the tool call's group size and position, so an earlier
  override's repeat window applies to the same command in any call.

  Review fixes before release: the floor check keeps a rule a person may only ask about blocking when another rule on the same
  action lets a person allow; the agent re-reads its files before writing, so an allowance or request the hook wrote during a
  send is kept; allowances and requests are signed over `scopebond:allowance/v1` and `scopebond:request/v1` domain lines;
  "Allow for 15 min" is offered only where the workspace sends the allowance terms; an older agent's "Allow once" on an
  ask-only rule becomes a request to an admin.

- ce7728c: A small, steady local store. A hook call's memory and time no longer grow with the local history: the replay check is one
  indexed lookup instead of reading every receipt (a call on a 767 MB log peaked at 69 MB, down from 233 MB, and 504 MB for a
  three-part shell command; it took 0.26 s instead of 1–1.8 s). The SQLite store keeps each policy once and each receipt once,
  and keeps nothing for an action that finished without being dispatched; a log from an earlier version is rewritten to this
  layout and shrinks (767 MB became 93 MB with every receipt kept).

  Receipts a workspace acknowledged are removed 30 days after it did (the workspace can set 7–365 days); a receipt it has not
  acknowledged is never removed, an anchored log is never pruned, and a computer with no workspace keeps everything. The
  Scopebond Agent runs this upkeep; a hook-only install runs a short pass once a day and leaves rewriting an older file to a
  background process. `prune` reports the retention, and `prune --compact` runs the upkeep now.

  Also: `sed -n a,bp f` reads `f`, not a file named after the script; `cat $f` no longer records a read of a file called `$f`;
  Scopebond's own folder named in an interpreter's arguments (`node -e`, `python script.py ~/.scopebond/…`, `sqlite3`) is
  treated as a read of it; `rules.json` and `cloud.json` are read once per call; the delivery queue keeps its totals.
  `@scopebond/gateway` adds `ReceiptStore.authorizationUsed`, `SqliteReceiptStore.maintain`, `SqliteCloudOutbox.markAcknowledged`
  and `pendingCount`, and re-exports `historyNeed`.

- 59d9ec8: The signed Windows install updates itself only with an installer it has checked three ways: the release manifest is signed with the updater key (an Ed25519 key separate from the Authenticode certificate; its public half is built into the program), the installer's SHA-256 and size match the manifest, and its Authenticode signature is valid and names Avouro LLC. Otherwise nothing is installed and the agent says the update could not be verified. An install for every user (Program Files) never updates itself. npm installs are unchanged.
- b2f5af9: Act on a block afterwards, from the tray. When a rule lets a person allow a blocked action or ask an admin, the block is
  kept for a week and the tray's **Recently blocked** list offers it: a click opens the Scopebond window for that action, and
  the person may allow it once (the next try), for 15 minutes or always, or ask an admin, as the workspace allows now. The
  reason length and the daily limit apply as in the window; a block is offered once; Scopebond never runs the action again by
  itself. New: `blockedQuestion` and `actOnBlocked` in the hook, `POST /blocked` on the agent's local channel (it only names
  the block; the answer comes from the window), and `can_act` / `acted` on the tray model's recent blocks.
- d4b34d8: Send summaries instead of every routine receipt when the workspace asks for it. The workspace names its evidence detail on
  each rules check (`x-scopebond-evidence-detail: full | standard`); the hook keeps it beside the local retention. With
  _standard_, the exporter sends notable receipts in full at once and the routine ones of each closed five-minute window as one
  signed summary (`POST /v1/summaries`, with the queue's record numbers it stands for beside it, so the workspace's gap check
  stays exact). Each window is summarised once per queue (a claim in the outbox), so a window's summary covers exactly its
  routine receipts that were not sent in full; a record that turns up for a window already summarised is sent in full. A
  workspace without summaries (404, 405) or that refuses one (400, 413, 422) is sent every receipt, as before.

  Also: enqueueing never starts a flush while summaries are on, and a hook call's flush runs only when the call recorded
  something notable (`flush({ routine: false })`); the agent's cycle and `scopebond-hook flush` send the summaries. New:
  `CloudSummaryOptions`, `seqRanges`, outbox `claimWindow`/`releaseWindow`; hook `evidenceDetail`, `evidenceDetailFrom`,
  `summaryOptions`. A 1,000-action session over 20 minutes ships 4 summaries and its 5 pushes.

  Review fixes before release: a window's claim is a lease, so a window another process is sending waits instead of also going
  in full, and a claim a process abandoned is taken over under the same summary id; records leave the queue only for the
  summaries the workspace says it has (a summary it refused sends its records in full; a short answer is retried under the
  same ids); a summary's `notable_count` counts the window's records sent in full, kept in the outbox; notable records go
  before summaries; a computer without the agent sends summaries from a hook call once routine records have waited 30 minutes.

- c20849f: The tray says what is true and offers only what applies. The Windows tray draws the Scopebond "S" tile with a status badge
  (protected, working, offline, needs attention, problem, not connected) from a model the agent computes (`GET /tray`), so the
  tray, `status` and the workspace agree. Its menu shows Rules, Delivery, Today's actions and blocks, and Version (each only
  with data), the one fix when something is wrong, **Check now** with what it found, **Send records now** only when records
  wait, **Update now** only when the workspace recommends a newer version, the last few blocks, a notification setting (All,
  Problems only by default, Off) and Help (copy diagnostics, open the Scopebond folder, documentation, About). Records waiting
  count only time the computer was awake, and the workspace being unreachable is offline (still checking actions) for four
  hours before it needs attention.

  The hook exports `localActivity()` (today's counts and the newest blocks, read-only and bounded, summarised without
  arguments) and `ruleReport()`.

  The agent acts on a request the workspace carries on the rules check (`x-scopebond-request: flush | self_check`, from the
  computer's page: "Ask it to send now", "Ask it to check now"), and reads the workspace's optional `GET /v1/computer/summary`
  for the tray's workspace and environment names, Review count and **Open workspace** (links only on the connected workspace's
  own origin). A workspace without the call answers 404 and the tray leaves those rows out; the fake cloud implements it.

  **Reconnect…** in the tray signs this computer in again with no terminal: the agent runs the hook's own sign-in for the
  workspace it is already connected to, opens the approval page there and shows the code. A workspace that lets the same
  computer keep its key delivers the records waiting on it as they are.

### Patch Changes

- 8039c25: The updated agent now starts after a self-update on Windows. The autostart launcher redirected the agent's output into `agent.log`; the replacement launcher's own redirect then failed on the file the old agent still held, cmd skipped the command and took that for a clean stop, and the computer stayed without an agent until the next sign-in. The agent now writes its log itself, the launcher counts a command that never ran as a failure, and the handover uses the launcher's own start command. An agent running under a launcher from 0.4.6 or earlier starts its update directly, and the update rewrites the launcher. Under systemd the service restarts the agent instead of a detached child that would be stopped with it. `check` waits for the updated agent and says which version runs.
- e343292: Groundwork for a single-file Windows build. The hook's and the agent's commands are now `main(argv)` functions in `cli-main.js` (the `cli.js` programs that agent settings and autostart name are unchanged and call them); every place that starts the hook or the agent again goes through one helper (`hookSelfCommand`, `agentCliPath`); Node's SQLite is taken from Node's built-ins; versions can be set at build time. No change in behaviour for npm installs.
- 4e59097: When Scopebond runs as the single executable, the coding agents' settings name the executable itself (`"…\scopebond-agent.exe" hook claude`), with no Node, npm or npx; `init`, `install`, sign-in and the agent's upkeep all write that form, and an npm agent leaves a working one alone. Autostart's launcher starts the executable with `run` (and still restarts it after a crash).
- Updated dependencies [d29fe87]
- Updated dependencies [cb4d4e0]
- Updated dependencies [e343292]
- Updated dependencies [e0f2de4]
- Updated dependencies [ce7728c]
- Updated dependencies [4e59097]
- Updated dependencies [b2f5af9]
- Updated dependencies [c66d872]
- Updated dependencies [c877e45]
- Updated dependencies [d4b34d8]
- Updated dependencies [c20849f]
  - @scopebond/hook@0.21.0
  - @scopebond/gateway@0.17.0
  - @scopebond/sdk@0.1.5

## 0.4.6

### Patch Changes

- Updated dependencies [5f121d0]
  - @scopebond/hook@0.20.1

## 0.4.5

### Patch Changes

- Updated dependencies [377e2e0]
- Updated dependencies [2dac3d7]
  - @scopebond/hook@0.20.0
  - @scopebond/gateway@0.16.2

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
