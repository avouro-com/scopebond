# scopebond-tray (Windows, not published)

The Scopebond tray for Windows: the icon in the taskbar's notification area, its right-click menu and a small status
panel, for the Scopebond service (`@scopebond/agent`) installed by the signed Windows installer. It is a [Tauri 2](https://v2.tauri.app) program
(Rust, and the WebView2 that Windows already has). It is not an npm package; npm installs keep the agent's own
PowerShell tray.

## What a person sees

- **At rest, only the icon and its menu.** The "S" tile with a badge: no badge when protected; a blue open circle while
  working (an update, a sign-in); a grey dash when the workspace cannot be reached; an amber "!" when something needs
  attention; a red cross for a problem; a slate tile with a slash when the computer is not connected to its workspace.
  Shape and colour both say the state. The icon is drawn in code (`src/icon.rs`, the same grid and colours as the
  PowerShell tray), so the repository holds no image files; the build writes the program's .ico from the same code.
  The tooltip says how things stand in one line of at most 63 characters; while a sign-in waits for approval it shows
  the code whole: "Scopebond: approve code ABCD-EFGH".
- **Right-click menu**, short, in this order: *Open Scopebond*, *Blocked today (N)*, the one fix when the agent's model
  offers one (*Send records now*, *Reconnect…*, *Repair*…; or *Start the Scopebond Agent* when it is not answering),
  *Open <workspace> in Scopebond Cloud* (when the model offers the workspace's page), *Notifications* ▸ *Blocks and
  problems* / *Problems only* / *Off*, *Start with Windows*, *Help* ▸ (the model's other actions such as *Check now* or *Update now*, then *Copy
  diagnostics* / *Open logs folder* / *About Scopebond*), and *Hide icon*. There is no *Quit* and no *Pause protection*:
  the hook decides every action of a coding agent whether or not the tray runs. *Hide icon* hides the icon until the next
  sign-in, or until the tray is started again (the Start-menu entry opens the status panel). *Start with Windows* turns
  the installer's sign-in entry (the Run value `Scopebond`) on or off for this person, and the choice is kept across
  upgrades; for an install for every user it is shown, not changed.
- **Status panel** (left-click, *Open Scopebond* or *Blocked today*): 360 × 560 next to the tray, created when it opens
  and destroyed when it closes (it closes when it loses focus and on Esc, but not while the person is writing a reason in
  its Unblock form). Built around what got blocked:
  - At the top, the "S" tile with the state's badge, the state in one word ("Protected", "Needs attention"…) and one line
    under it ("Rules checked 3 min ago · 2 blocked today", or what is wrong). A banner with the one fix button appears
    only when the agent's model has a fix or a problem to explain.
  - **Blocked · Allowed · Requests.** *Blocked* lists up to 20 blocks, today's first and then earlier ones, newest first:
    the action in plain words as the Scopebond window shows it, with secrets masked ("Read .env.production", "git push
    --force origin main"), the rule's name, the project and the coding tool, and the time. What the panel offers follows what the
    workspace lets a person do for each block, as the agent says it: *Unblock…* where the person may allow it, *Ask to
    unblock…* where an admin decides, and no button where the block stays blocked (nothing else is said about it).
  - **Unblock in the panel.** Either button opens a form on the block itself: the text the Scopebond window shows for the
    action, only the choices the workspace offers for it now (*Just this once*, *For 15 minutes*, *Always on this
    computer* — for the workspace's number of days, or after an admin approves —, *Ask an admin to unblock it instead*), a reason with a live
    count of the characters still needed, and a button named for the result (*Allow once*, *Allow for 15 minutes*, *Always
    allow*, *Send request*). The tray checks the answer (the choice is offered, the reason long enough and at most 500
    characters) and sends it to the agent's `POST /blocked/answer`, which checks it again and applies it exactly as the
    window's answer: the allowance or the request on this computer, sent to the workspace signed by this computer's key.
    The block then says what happened: "Allowed once · Recorded and sent to Acme". Where an admin decides, the form
    has nothing to choose: the action, the reason and *Send request*, and afterwards "Request sent · you'll see the
    answer under Requests". Where the workspace sets the one length, there is nothing to choose either: one line names
    it, and where the workspace reviews every unblock later it says so ("For 15 minutes, set by your workspace; an admin
    reviews it later") and the button reads *Unblock now*; afterwards "Unblocked until 4:07 PM · an admin will review
    it", and the allowance is listed under *Allowed* until it ends or an admin undoes it. Scopebond never runs the action
    itself; the person or the coding agent runs it again. With an agent that does not say what may be done, the buttons
    open its Scopebond window as before.
  - *Allowed* lists what the person let through that still applies (once, for 15 minutes, always), with when it ends, and
    what waits for an admin, and what an admin approved. *Requests*, there only when the workspace lets the person ask or
    when they have asked before, lists their requests: waiting, approved (and by whom) or declined (with the
    admin's note when the workspace sends one), with the person's own reason. *Stop allowing* on what the person let through (not on what an
    admin approved) asks them to confirm in the row, then ends it at once; the agent tells the workspace.
  - **The question waiting now.** When a coding agent is stopped during a session and the workspace lets the person act,
    the hook asks the agent, and the agent hands the question to the tray: a notification ("Blocked: git push --force
    origin release/2.4 · Claude Code is waiting for your answer") with *Unblock…* or *Ask to unblock…*, and at the top of
    *Blocked* the question with the seconds left and the same form. The answer goes back to the hook's waiting call, so
    the coding agent goes on at once. The question stays in the tray for the hook's whole wait, and no Scopebond window
    opens beside it. Unanswered when the hook stops waiting, nothing is allowed.
  - The footer says how many actions were checked today and opens the workspace in Scopebond Cloud.
  - **Settings** (the gear): notifications, *Start with Windows*, *This computer* (the rows the agent reports: rules,
    delivery, today, version), the model's other actions (*Check now*, *Send records now*…), *Copy diagnostics*, *Open logs
    folder*, *Help* and *Hide icon*.
  Light or dark follows the Windows setting, in the workspace portal's colours (violet actions, the navy tile) and
  Windows' own type. Every control is reachable with the keyboard (the three lists are tabs, moved between with the arrow
  keys) and has an accessible name, keyboard focus stays where it was when the panel redraws, and the status line is a
  live region, so a screen reader hears what changed. Text from the agent is only ever set as text.
- **Reviewing the panel in a browser**: `node packages/tray/dev/preview.mjs` writes a preview page into `dev/dist/` (ignored
  by git) and prints its address; open it (no server, no Rust toolchain needed). It shows each scene, light and dark: the
  panel's own page from `build.rs` with the shipped `ui/` files and a stand-in for the tray (`dev/fake-tauri.js`).
  Nothing under `dev/` is built into the program.
- **Notifications**: one when the state gets worse (for "needs attention", only once it has lasted five minutes, so
  sleep and wake do not flap) and one when it is protected again; with *Blocks and problems* (the default for a new install;
  an older *All* reads the same), one for a new block in plain words with the tool, the project and the rule, and an
  button that opens the panel on that block's form, named as the panel's button is (*Unblock…*, or *Ask to unblock…*
  where an admin decides; none where the block stays blocked); blocks that follow within a
  minute are told together ("3 actions blocked in the last minute"). With *Blocks and problems* the person is also told when
  an admin answers one of their requests ("Your request was approved", with who and their note). A question waiting now
  (above) is told unless notifications are *Off*. *Problems only* says nothing about blocks, and *Off* nothing at all. The tray restarts an agent that crashed, hung or stopped
  with nothing in its place without a word; only when two restarts in a row fail within ten minutes is the person told,
  once and whatever the notification setting: "Protection is off on this computer" with *Restart it*, which starts the
  agent at once (and "Scopebond is protecting again" once it answers). One stopped on purpose is not told about; a
  missing agent program is a problem once it has lasted two minutes. Before a new install's first sign-in nothing about
  the state is told (not being signed in yet is not a problem; the panel offers *Sign in…*), and once it is done and
  protected, "Connected to <workspace>" is told once in place of "Scopebond is protecting again". After an update,
  "Updated to Scopebond 0.11.5" is told once per version (the agent names the update for a day; the tray keeps the version
  it told in `tray-settings.json`, so a restart does not tell it again). *Check now* chosen from the menu says what it found. They carry
  the AppUserModelID `Avouro.Scopebond`, the one the installer's Start-menu entry sets. The rules are plain decisions in
  `src/notify.rs` with unit tests.

## How it works

**The tray never works out health.** It asks the agent for `GET /tray`, the same model the PowerShell tray, `status` and
the workspace's computer page use (state, headline, rows, the one fix, the actions that apply now, recent blocks, and the
person's notification setting), and draws it. Every action item calls the route the model names for it (`POST /flush`,
`/update`, `/check`, `/repair`, `/reconnect`, `/open-workspace`); an item whose action the model no longer offers does
nothing. The mapping from model to menu is a pure Rust module (`src/menu.rs`) with unit tests.

**The channel.** The agent listens on a named pipe and writes the pipe's name and a token to `agent.json` in the
Scopebond home (`%USERPROFILE%\.scopebond`, or `SCOPEBOND_HOME`). The tray reads that file and sends the same HTTP
requests over the pipe that the agent's other clients (the CLI, the hook's override window) send, with the token in the
`x-scopebond-agent-token` header. Every call has a deadline: the pipe is opened for overlapped I/O, and at the deadline
the read or write is cancelled and its end awaited before the pipe is closed, so an agent that accepts a connection and
never answers costs the caller the timeout and leaves no thread or handle behind.

**Supervision.** The installer starts the tray at sign-in; the tray starts the agent (`scopebond-agent.exe run`, the
program beside it in the install folder) when nothing answers, with no console window. If the agent exits on its own, the
tray starts it again after 2 s, then 4 s, 8 s … at most 60 s apart, and the wait starts over once the agent has run for
a while. It never runs two: an agent that is updating itself exits and its replacement starts, so the tray waits for the
replacement to answer before starting anything, and the agent's lock file refuses a second agent anyway. An agent that
was stopped on purpose (`scopebond-agent stop`, which leaves `agent-stopped.json` in the Scopebond folder) stays stopped;
the menu offers to start it. An agent that exited cleanly with no replacement answering within a minute, and that nobody
asked to stop, is started again with the same waits as after a crash. An agent whose pipe
accepts connections but that gives no model (or only errors) for half a minute is shown as not answering; half a minute
later the tray ends it (only the process that runs the agent program beside the tray) and starts it again. A clean
stop is told apart from a crash by the exit code of the agent the tray started (0), or, for an agent something else
started, by its endpoint file: a clean stop removes it, a crash leaves it. The tray starts the agent with
`SCOPEBOND_AGENT_TRAY=off`, so the agent does not draw its PowerShell tray as well. All of this is silent. A restart
fails when the agent is lost again (a crash, a hang, a start that cannot run) before it has answered for five minutes;
two failed restarts within ten minutes mean protection is off on this computer, and the person is told once, with
*Restart it* (it keeps trying meanwhile). *Restart it*, or *Start the Scopebond Agent* in the menu, starts it at once,
ends a hung agent without the half-minute wait, and starts the count over. The rules are plain decisions in
`src/supervise.rs`, unit-tested case by case (first start, crash and backoff, reset after five minutes, update handover,
stop on purpose, another agent starting, no agent program, failed restarts within ten minutes or further apart).

## Threat model of the local channel

- The pipe's name is random for every start of the agent and is written only to `agent.json` in the person's own
  Scopebond folder, which other users of the computer cannot read. A program has to know the name to connect.
- Every request carries the token from the same file; the agent answers 401 without it, compared in constant time.
- The tray never uses a loopback port, and beside the tray the agent opens none: no other program on the computer can
  reach it over TCP. (npm installs keep a loopback port for now, for the PowerShell tray and hooks from before the
  pipe.)
- The agent is a Node program, and Node cannot set an access list on a named pipe it creates, so **no access list is
  claimed**: the pipe has Windows' default security for its creator. The protection is the secret name and the token,
  both kept in the person's profile. A program already running as the same person can read that file, and so can do
  what the tray does; that is the same trust the person's own command line has.
- The tray only calls short local routes the agent's model names (a path such as `/flush`, never an address), and the
  status panel loads only the files built into the program, under a content security policy that allows nothing else.
- The tray's Unblock form answers through the same channel and token (`POST /blocked/answer`), so a program already
  running as the person, which can read the token file, could send such an answer too: the same trust as the person's
  own command line. What it can do is bounded the same way the window's answer is: only a choice the workspace offers a
  person for that block, with a reason as long as the workspace asks for, within the daily limit, never for Scopebond's
  own protection or a rule on Block, and every answer is recorded on this computer and sent to the workspace with its
  reason. The hook's own protection stops a coding agent from reading the Scopebond folder through its tools.
- Apart from the Unblock form above, the tray asks nothing of the agent that the agent's own command line cannot do. With
  an agent that does not say what may be done, an earlier block is answered in its Scopebond window, which only the
  person can answer.

## Build and test

Windows only (the tray is built and tested in CI on `windows-latest`; nothing here needs a local Rust toolchain).

```sh
cd packages/tray
cargo test --locked             # the model-to-menu mapping, the icon, and the other pure parts
cargo build --release --locked  # target/release/scopebond-tray.exe
```

The toolchain is pinned in `rust-toolchain.toml` and the dependencies in `Cargo.lock`. `build.rs` writes the program's
icon and assembles the panel's page from `ui/` into `dist/` before Tauri's own build step. The `tray (windows)` job in
`.github/workflows/tray.yml` runs the tests, builds the release program, checks that it is a Windows (not console)
program and that it stays under 25 MB of memory at idle; it runs when `packages/tray`, `packages/native` or a workflow
changes.

## Status

- [x] The package, the icon, the model-to-menu mapping and its tests, the CI job.
- [x] The pipe client, the menu from the live model, the status panel.
- [x] Supervision of the agent.
- [x] The installer ships the signed tray and starts it at sign-in; the updater restarts it.
- [x] Notifications.
