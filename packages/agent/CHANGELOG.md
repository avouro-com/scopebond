# @scopebond/agent

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
