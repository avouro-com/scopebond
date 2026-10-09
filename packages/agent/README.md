# @scopebond/agent

**Free, open-source companion (Apache-2.0).** Scopebond Cloud, the hosted shared
workspace it connects to, is a separate proprietary service. This package is the
Scopebond Agent companion, not the AI coding agent doing the work.

The Scopebond Agent keeps a computer connected to its Scopebond workspace without anyone running a command.
It is one resident process per user. The hook (`@scopebond/hook`) keeps evaluating supported actions on its own; the
agent never takes part in a decision. It only keeps everything around the decisions working:

- **Delivery.** It sends the records the hook queued, all of them, with backoff while the workspace is unreachable.
  A record the workspace refuses on its own is kept as a gap and never holds up the rest.
- **Rules and connection.** It runs the rules check, which brings the workspace's rules, reports this computer's
  queue, and renews the machine credential before it expires.
- **Repair.** It notices when an agent's settings lost the Scopebond hook entry (an update or a reset can remove it)
  and, on request, puts it back without touching anything else in the file.
- **Updates, under the workspace's control.** Every six hours it asks the workspace which versions to run. When
  the workspace recommends a newer agent, it installs it from npm and restarts itself; when the workspace holds
  updates, it changes nothing. It also moves the Scopebond hook entries in agent settings to the recommended hook
  and repairs any entry that can no longer start. Other tools' hook entries are never touched.
- **A small local store.** With each update check it keeps the local receipt store small: receipts the workspace
  acknowledged are removed after the workspace's retention window (30 days unless it sets 7–365), never one it has not
  acknowledged; a store written by an older hook is rewritten once so it keeps each policy and receipt only once.
- **Self-check.** Once a day it checks this computer's side (hook entry present and able to start, autostart on,
  nothing stuck in the queue, connection not about to lapse) and sends the result, signed with the key the computer
  enrolled with, so the workspace can show that the whole path works end to end, or what broke.
- **Overrides.** When the workspace sets a rule to *Block, user may override*, the hook asks the agent, and the agent
  shows its own window (Windows PowerShell with Windows Forms, macOS `osascript`, Linux `zenity`): the rule, the action and a
  reason field. Only the window answers; whatever calls the local channel can open a window but never decide it. One window
  at a time; it closes itself before the hook stops waiting. The reason goes to the workspace once, and waits in the
  Scopebond home while the computer is offline. As the workspace allows, the window offers **Allow once**, **Allow for 15
  min**, **Always allow this here…** and **Ask an admin** (only the last for a rule set to *Block, person may ask*). The
  agent sends a person's allowances and requests to the workspace (`POST /v1/allowances`, `POST /v1/requests`), each
  signed with the key this computer enrolled with, once; a workspace without these calls leaves them on the computer.
- **Health.** It reports the same machine-readable status as `scopebond status --json` (`scopebond.status.v1`).

## Use

One command from nothing to a connected computer:

```bash
npx -y @scopebond/agent@latest setup https://cloud.scopebond.com      # Windows: npx.cmd
```

`setup` checks Node.js (22.13 or later), signs you in with a code you approve in the workspace (which adds the
Scopebond hook to your user-level agent settings), installs the agent for your user, turns autostart on and ends with
`status`. Add `--cursor` or `--codex` for those tools. Run it again at any time: it keeps an existing connection to the
same workspace (`--relogin` signs in again), does not reinstall the same version, and only puts back what is missing.
If npm's global folder is not on PATH, it says which folder and how to add it.

Or step by step (from your home folder; on Windows type `npx.cmd`, `npm.cmd` and `scopebond-agent.cmd`):

```bash
npx -y @scopebond/hook@latest login https://cloud.scopebond.com   # sign in first: the agent delivers what the hook records
npm install -g @scopebond/agent@latest
scopebond-agent autostart on      # start with your sign-in (Windows Run entry, macOS LaunchAgent, Linux systemd user unit)
scopebond-agent status            # what it reports about this computer
```

In Windows PowerShell, use `npm.cmd` instead of `npm` and `scopebond-agent.cmd`
instead of `scopebond-agent` if script execution policy blocks the `.ps1` command.
For `npx` commands, use `npx.cmd`; no execution-policy change is needed.

| Command | What it does |
|---|---|
| `scopebond-agent setup <workspace-url>` | Sign in, install for this user, start with sign-in, show status; safe to run again |
| `scopebond-agent run` | Run in the foreground (what autostart starts) |
| `scopebond-agent status [--json]` | Delivery state, records waiting and the last problem |
| `scopebond-agent flush` | Deliver waiting records now |
| `scopebond-agent repair` | Put the Scopebond hook back into agent settings that lost it |
| `scopebond-agent check` | Check for updates and run the self-check now |
| `scopebond-agent autostart on\|off` | Start with your sign-in, or stop doing so (off also stops it now) |
| `scopebond-agent stop` | Stop the running agent until the next sign-in |

The Scopebond hook stops a coding agent from switching the agent off: `autostart off`, stopping it by name and a
global uninstall of `@scopebond/agent` are denied when the coding agent runs them. Run them from your own terminal.

## Local control channel

The agent listens on `127.0.0.1` only, on a random port, and every request must carry a random token. Port, token and
process id are in `~/.scopebond/agent.json`, readable by you only. Routes: `GET /status`, `POST /flush`, `POST /repair`, `POST /maintain`, `POST /override`, `POST /stop`.
Exactly one agent serves a computer's Scopebond home; a second one exits.

## Autostart

`autostart on` writes a small launcher script into the Scopebond home that finds Node and the agent each time it
runs (the paths recorded at setup first, then the ones on the system), so a Node upgrade or a version manager never
leaves autostart pointing at nothing. On Windows the Run entry starts it under `conhost --headless`, so no window
opens at sign-in. If the agent stops with an error, the launcher starts it again after 30 seconds (up to 50 times,
each noted in `agent.log`), as launchd and systemd do on macOS and Linux; a clean stop (`stop`, `autostart off`, an
update handing over) ends it. `status` says whether autostart is on and working: the entry must start this home's
launcher, so one left pointing at another home's launcher is reported and `setup` rewrites it. On Windows a Scopebond
home whose path has a `%` in it is refused (Windows would read it as a variable); set `SCOPEBOND_HOME` to a folder
without one.

The agent writes `agent.log` itself, a line at a time, so an agent handing over to its update and the updated one
can both write it. When it updates itself, the updated agent starts through the same launcher and waits for the old
one to exit; under systemd the service restarts it instead. A launcher written by agent 0.4.6 or earlier redirected
the agent's output into `agent.log`, which kept the updated agent from starting on Windows: an agent under such a
launcher starts its update directly, and the update rewrites the launcher (until the next sign-in, its log lines go
to `agent-handover.log`). After `check` updates the agent, it waits for the updated one, starts it if it did not
start, and says which version runs.

## Where you see it

On Windows the agent shows a tray icon (from Windows' own PowerShell, nothing extra to install): the Scopebond "S" tile
with a status badge, its shape and colour together — none when protected, a grey dash when the workspace cannot be
reached (it keeps checking actions; records wait), an amber "!" when something needs attention, a red "×" for a
problem, a blue arrow while it works (an update), and a slate tile when the computer is not connected to its workspace.
Records waiting count only the time the computer was awake: a laptop that slept is not "stuck".

Click it (left or right) for the menu: one headline; the rows that have data (Rules, Delivery, Today's actions and
blocks, Version); the one fix when something is wrong; **Check now**, which always says what it found; **Send records
now** when records wait; **Update now** when the workspace recommends a newer version; the last few blocks (**Recently blocked**: where the
workspace lets a person allow a blocked action or ask an admin, clicking one opens the Scopebond window for it, and the
person can allow it once, for 15 minutes or always, or ask an admin; Scopebond never runs it again by itself); the
notification setting (All, Problems only — the default —, Off); Help (copy diagnostics without keys or credentials, open
the Scopebond folder, documentation, About); and Hide icon. There is no "pause" or "quit protection": the hook decides
every action whether or not the agent runs. A balloon appears when the state gets worse ("needs attention" only after
five minutes, so sleep and wake do not flap) and once when it is protected again. Set `SCOPEBOND_AGENT_TRAY=off` for no
icon. On macOS and Linux the agent sends a system notification when things get worse, and once more when they recover.

The tray only draws what the agent computes: `GET /tray` on the local channel returns the model (state, headline, rows,
fix, actions, recent blocks) and the person's settings; `POST /check`, `/update`, `/flush`, `/repair`, `/settings`
and `/blocked` (an earlier block, answered only in the Scopebond window) do the work. `GET /status` carries the same `health` (level, headline, fix).

## Status

Experimental.
