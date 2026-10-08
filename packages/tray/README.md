# scopebond-tray (Windows, not published)

The Scopebond tray for Windows: the icon in the taskbar's notification area, its right-click menu and a small status
panel, for the Scopebond Agent installed by the signed Windows installer. It is a [Tauri 2](https://v2.tauri.app) program
(Rust, and the WebView2 that Windows already has). It is not an npm package; npm installs keep the agent's own
PowerShell tray.

## What a person sees

- **At rest, only the icon and its menu.** The "S" tile with a badge: no badge when protected; a blue open circle while
  working (an update, a sign-in); a grey dash when the workspace cannot be reached; an amber "!" when something needs
  attention; a red cross for a problem; a slate tile with a slash when the computer is not connected to its workspace.
  Shape and colour both say the state. The icon is drawn in code (`src/icon.rs`, the same grid and colours as the
  PowerShell tray), so the repository holds no image files; the build writes the program's .ico from the same code.
- **Right-click menu**, in this order: a header line (the agent's headline), *Open status…*, the actions the agent offers
  right now (the one fix first, then *Send records now*, *Update now*, *Check now*, *Reconnect…*, *Open workspace* only
  when the agent's model offers them), *Start with Windows*, *Notifications* ▸ *All* / *Problems only* / *Off*, *Help* ▸
  *Copy diagnostics* / *Open logs folder* / *About Scopebond*, and *Hide icon*. There is no *Quit* and no *Pause
  protection*: the hook decides every action of a coding agent whether or not the tray runs. *Hide icon* hides the icon
  until the next sign-in, or until the tray is started again (the Start-menu entry opens the status panel). *Start with
  Windows* turns the installer's sign-in entry (the Run value `Scopebond`) on or off for this person, and the choice is
  kept across upgrades; for an install for every user it is shown, not changed.
- **Status panel** (left-click, or *Open status…*): about 360 × 420 next to the tray, created when it opens and destroyed
  when it closes (it closes when it loses focus and on Esc). The headline and state, the rows the agent reports (Rules,
  Delivery, Today, Version), the one fix as the main button, a hint when no button can fix it, the other actions, and the
  recent blocks (with *Allow or ask…* where the person may still act on one). Light or dark follows the Windows setting;
  the colours are CSS variables with the PowerShell tray's palette. Every control is reachable with the keyboard and has
  an accessible name, and the status line is a live region, so a screen reader hears what changed.
- **Notifications**: one when the state gets worse (for "needs attention", only once it has lasted five minutes, so
  sleep and wake do not flap) and one when it is protected again; none for blocks unless the person chose *All* (then
  one per new block); none at all with *Off*. An agent that has not answered for two minutes while the tray keeps trying
  counts as a problem, and so, at once, does one whose pipe accepts connections but that has given no model for half a
  minute; one stopped on purpose does not. An agent that stopped without anyone asking and with nothing in its place is
  told about once when the tray starts it again. *Check now* chosen from the menu says what it found. They carry
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
asked to stop, is started again with the same waits as after a crash, and the person is told. An agent whose pipe
accepts connections but that gives no model (or only errors) for half a minute is shown as not answering; half a minute
later the tray ends it (only the process that runs the agent program beside the tray) and starts it again. A clean
stop is told apart from a crash by the exit code of the agent the tray started (0), or, for an agent something else
started, by its endpoint file: a clean stop removes it, a crash leaves it. The tray starts the agent with
`SCOPEBOND_AGENT_TRAY=off`, so the agent does not draw its PowerShell tray as well. The rules are plain decisions in
`src/supervise.rs`, unit-tested case by case (first start, crash and backoff, reset after five minutes, update handover,
stop on purpose, another agent starting, no agent program).

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
- The tray asks nothing of the agent that the agent's own command line cannot do. Allowing an earlier block still goes
  through the agent's Scopebond window, which only the person can answer.

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
