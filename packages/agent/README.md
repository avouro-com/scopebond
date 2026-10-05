# @scopebond/agent

The Scopebond Agent keeps a computer connected to its Scopebond workspace without anyone running a command.
It is one resident process per user. The hook (`@scopebond/hook`) keeps deciding every action on its own; the
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
- **Self-check.** Once a day it checks this computer's side (hook entry present and able to start, autostart on,
  nothing stuck in the queue, connection not about to lapse) and sends the result, signed with the key the computer
  enrolled with, so the workspace can show that the whole path works end to end, or what broke.
- **Health.** It reports the same machine-readable status as `scopebond status --json` (`scopebond.status.v1`).

## Use

```bash
npm install -g @scopebond/agent
scopebond-agent autostart on      # start with your sign-in (Windows Run entry, macOS LaunchAgent, Linux systemd user unit)
scopebond-agent status            # what it reports about this computer
```

On Windows, type `npx.cmd` instead of `npx` in PowerShell if you run it without installing.

| Command | What it does |
|---|---|
| `scopebond-agent run` | Run in the foreground (what autostart starts) |
| `scopebond-agent status [--json]` | Delivery state, records waiting and the last problem |
| `scopebond-agent flush` | Deliver waiting records now |
| `scopebond-agent repair` | Put the Scopebond hook back into agent settings that lost it |
| `scopebond-agent check` | Check for updates and run the self-check now |
| `scopebond-agent autostart on\|off` | Start with your sign-in, or stop doing so |

## Local control channel

The agent listens on `127.0.0.1` only, on a random port, and every request must carry a random token. Port, token and
process id are in `~/.scopebond/agent.json`, readable by you only. Routes: `GET /status`, `POST /flush`, `POST /repair`, `POST /maintain`.
Exactly one agent serves a computer's Scopebond home; a second one exits.

## Autostart

`autostart on` writes a small launcher script into the Scopebond home that finds Node and the agent each time it
runs (the paths recorded at setup first, then the ones on the system), so a Node upgrade or a version manager never
leaves autostart pointing at nothing. On Windows the Run entry starts it under `conhost --headless`, so no window
opens at sign-in. `status` says whether autostart is on and working.

## Status

Experimental. A tray icon with a one-click fix for every amber or red state is next.
