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
  the workspace recommends a newer agent, it installs it from npm and restarts itself (the signed Windows install: the
  signed build, see below); when the workspace holds
  updates, it changes nothing. It also moves the Scopebond hook entries in agent settings to the recommended hook
  and repairs any entry that can no longer start. Other tools' hook entries are never touched.
- **A small local store.** With each update check it keeps the local receipt store small: receipts the workspace
  acknowledged are removed after the workspace's retention window (30 days unless it sets 7–365), never one it has not
  acknowledged; a store written by an older hook is rewritten once so it keeps each policy and receipt only once.
- **Self-check.** Once a day it checks this computer's side (hook entry present and able to start, autostart on,
  nothing stuck in the queue, connection not about to lapse) and sends the result, signed with the key the computer
  enrolled with, so the workspace can show that the whole path works end to end, or what broke. With it, and once on
  each start, it reports which AI coding tools this computer has and whether the hook checks them (see below).
- **Overrides.** When the workspace sets a rule to *Block, user may override*, the hook asks the agent, and the agent
  shows its own window (Windows PowerShell with Windows Forms, macOS `osascript`, Linux `zenity`): the rule, the action and a
  reason field. Only the window answers; whatever calls the local channel can open a window but never decide it. One window
  at a time; it closes itself before the hook stops waiting. The reason goes to the workspace once, and waits in the
  Scopebond home while the computer is offline. As the workspace allows, the window offers **Allow once**, **Allow for 15
  min**, **Always allow this here…** and **Ask an admin** (only the last for a rule set to *Block, person may ask*). The
  agent sends a person's allowances and requests to the workspace (`POST /v1/allowances`, `POST /v1/requests`), each
  signed with the key this computer enrolled with, once; a workspace without these calls leaves them on the computer.
- **Health.** It reports the same machine-readable status as `scopebond status --json` (`scopebond.status.v1`).

## Windows: the signed installer

On Windows, install Scopebond with the signed installer (`scopebond-agent-<version>-x64.msi` from the
[releases](https://github.com/avouro-com/scopebond/releases), or `winget install Avouro.Scopebond`). It needs neither
Node.js nor npm: one signed program is both the agent and the hook, and the Scopebond tray keeps it running.

- **First run.** After the installer, the tray starts the agent, and on its very first start the agent signs in by
  itself, once: the approval page opens in your browser and the tray shows the code to check there. Once you approve it,
  the agent puts the hook into the settings of the coding agents on this computer (Claude Code, and Cursor and Codex where
  they are installed) and turns autostart on, as `setup` does. If you close the page, **Sign in…** in the tray's menu
  starts it again. The workspace is the one the installer was given (`msiexec /i … WORKSPACE=https://<your-workspace>`,
  kept as `Workspace` under `HKCU\Software\Avouro\Scopebond`, or `HKLM` for an install for every user), else
  `https://cloud.scopebond.com`. Only an https address there is used. From a terminal the same is
  `scopebond-agent setup https://<your-workspace>`. The sign-in sends this computer's host name so the approver can
  tell which computer it is; set `SCOPEBOND_HOSTNAME_MODE=hash` to send a short stable hash of it instead, or `off` to
  send none (see the hook's README).
- **Commands.** `scopebond-agent <command>` (the table below), and the hook's commands as `scopebond-agent hook <command>`.
- **Updates.** An install for this user updates itself when the workspace names a newer published signed build
  (`native_agent` in its answer to `GET /v1/client-version`; never the npm release, which can come out first). The
  installer is checked three ways (a release manifest signed with the updater key, the installer's SHA-256 and size,
  and its Authenticode signature by Avouro LLC), checked again right before it runs, and installed with Windows' own
  `msiexec` by a copy of the signed program itself, with a verbose log in `.scopebond\updates\msi-<version>.log`. The
  new agent must start and report its version within three minutes; a version that does not install or start is
  recorded, shown in `status` and the tray, and not tried again for a day. An install for every user (Program Files) is
  updated by whoever deployed it.
- **From an npm install.** Existing npm installs keep working until the signed installer is installed. When the signed
  agent first starts (or `setup` runs) it takes over: it stops the npm agent, removes its `ScopebondAgent` sign-in entry,
  its launcher, its Settings -> Apps entry and that entry's uninstall script, and points every Scopebond hook entry at
  itself (`"<install folder>\scopebond-agent.exe" hook <tool>`). The npm package itself is left in place; remove it with
  `npm.cmd uninstall -g @scopebond/agent`. `status` says so while both are there.
- **Removing it.** Settings -> Apps -> Scopebond Agent -> Uninstall first runs `scopebond-agent uninstall` as the person
  removing it (autostart off, the agent stopped, the hook taken out of that person's coding-agent settings, the workspace
  told). An install for every user removed by a deployment tool (Intune, Group Policy, the system account) cleans only the
  profile it runs as: the agent does not edit other people's profiles. Before removing it for everyone, have each person
  run `scopebond-agent uninstall` (or remove it for them as them); afterwards, any hook entries left in someone's
  settings point at a program that is gone, and `status` and the daily self-check name that file
  (`hook_starts`). Installing Scopebond again, or taking the Scopebond entries out of those settings files, clears it.

npm stays the way to install on macOS and Linux:

## Use

One command from nothing to a connected computer (macOS, Linux, and existing npm installs on Windows):

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
| `scopebond-agent status [--json]` | Delivery state, records waiting, the last problem, and the coding tools on this computer |
| `scopebond-agent flush` | Deliver waiting records now |
| `scopebond-agent repair` | Put the Scopebond hook back into agent settings that lost it |
| `scopebond-agent check` | Check for updates and run the self-check now |
| `scopebond-agent autostart on\|off` | Start with your sign-in, or stop doing so (off also stops it now) |
| `scopebond-agent stop` | Stop the running agent until the next sign-in |

The Scopebond hook stops a coding agent from switching the agent off: `autostart off`, stopping it by name and a
global uninstall of `@scopebond/agent` are denied when the coding agent runs them. Run them from your own terminal.

## What the agent reports about this computer

With every self-check (once a day, and on each start) the agent adds two lists to the self-check it sends to the
workspace, and `scopebond-agent status` shows the same (`Claude Code 2.1.4 · governed`, `Cursor · present, not
governed`). This inventory is reported by the agent over its authenticated connection to the workspace; it is not
covered by the self-check signature (which signs the day's proof), so the workspace shows it as "as reported on <day>",
not as verified. These are exactly the facts sent, and nothing else:

- `tools`: for each AI coding tool whose user-level settings are present (at most 20), its `id` (`claude`, `cursor`,
  `codex`, `copilot`, `windsurf`, `gemini`, `cline`, `opencode`, `aider`), its installed `version` or null, whether it
  is `governed`, and whether its user-level settings are present (`settings_present`). `governed` means the Scopebond
  hook is in the tool's user-level settings file; a tool with the hook only in a project's own settings shows as not
  governed, and a tool the hook does not support yet is never governed. A program or npm install alone, without the
  tool's settings, does not make a tool present and is never run.
- `mcp_servers`: the name of each MCP server in a tool's user-level MCP configuration, with the tool's id (at most 100
  names, each at most 120 characters). Never a server's command, arguments, environment, headers or address, and never
  a project's own MCP file.

No path, user name or file content beyond those names is sent. A name that reads as a path or an address is left out.

| Tool | Present when | Version from | MCP server names from |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` or `~/.claude/` | `@anthropic-ai/claude-code` in npm's global folder, else `claude --version` | `~/.claude.json` (`mcpServers`) |
| Cursor | `~/.cursor/` | — | `~/.cursor/mcp.json` (`mcpServers`) |
| Codex | `~/.codex/` | `@openai/codex`, else `codex --version` | `~/.codex/config.toml` (`[mcp_servers.<name>]` table headers) |
| GitHub Copilot CLI | the CLI's `settings.json` or `logs` in `~/.copilot/` (`COPILOT_HOME`), or `copilot` on PATH, as the hook detects it | `@github/copilot`, else `copilot --version` | `~/.copilot/mcp-config.json` (`mcpServers`) |
| Windsurf (best effort) | `~/.codeium/windsurf/` | — | `~/.codeium/windsurf/mcp_config.json` (`mcpServers`) |
| Gemini CLI | `~/.gemini/` | `@google/gemini-cli`, else `gemini --version` | `~/.gemini/settings.json` (`mcpServers`) |
| Cline (best effort) | VS Code's `User/globalStorage/saoudrizwan.claude-dev` (stable or Insiders), or the Cline CLI's `~/.cline/` | — | — |
| OpenCode | `~/.config/opencode/` (or under `XDG_CONFIG_HOME`) or `~/.opencode/` | `opencode-ai` | — |
| Aider | any `~/.aider*` (`~/.aider.conf.yml`, `~/.aider/`) | `aider --version` | — |

npm's global folder is the usual one for the platform, else the one `npm root -g` names (asked once per run of the
agent). `--version` runs only the programs above, only for a tool whose settings are present, found in PATH's
absolute folders (on Windows only an `.exe` or `.com`, never a script that needs a shell), with no input, from a
temporary folder, for at most 3 seconds; a tool is never started in a way that opens a session. Only the version number is kept from what it prints. The rows marked best
effort are not confirmed against the tool's current documentation: Windsurf's folder, and Cline's VS Code storage
folder, which follows VS Code's naming for the extension's id.

## Tool settings from the workspace

A workspace can keep lists in the user-level settings of the AI coding tools on a computer: permission rules to allow
and to deny, and MCP servers a tool may or may not start. Nothing else: never prompts, instruction files or a model
choice. The lists arrive inside the workspace's rules document as a `tool_settings` section that is signed on its own,
with the same key and the same check as the rules (`checkToolSettingsSignature` in `@scopebond/hook`). The agent applies
a section only when it is signed by a key this release trusts; an unsigned section, or one signed by a key it does not
trust, is never applied, in any mode, and is reported as `refused: unsigned`.

| Tool | File | What the agent sets |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | `permissions.allow`, `permissions.deny`, `allowedMcpServers` and `deniedMcpServers` (`{ "serverName": … }` entries) |
| Cursor CLI | `~/.cursor/cli-config.json` | `permissions.allow`, `permissions.deny`; a denied MCP server is the deny entry `Mcp(<name>:*)`. Cursor documents no list of permitted MCP servers, so that list is refused as unsupported |
| Codex, GitHub Copilot CLI | — | Nothing: refused as unsupported. Codex keeps its MCP servers in TOML, which the agent does not rewrite, and documents no permission lists; Copilot CLI takes tool permissions as command-line flags only |

The workspace's entries are added to those lists, and entries the agent placed earlier that the workspace no longer
sets are taken out; every other key and entry in the file stays, in the file's own indentation and line endings. The
first change keeps a copy (`<file>.scopebond-backup`; an existing copy is never replaced), every write replaces the
file through a temporary file, and a file that does not parse as JSON, or whose lists are not lists, is never written
(`refused: unparseable`). A tool whose folder does not exist is reported as `refused: not_installed` and nothing is
created.

Each rules check reports, per tool, `applied`, `drifted` (with the names of the settings that no longer hold the
workspace's entries, for example `permissions.deny`, never their values) or `refused` and why
(`x-scopebond-tool-settings`). When the section says `mode: "enforce"`, a drift is put back and reported as restored;
with `mode: "report"` it is reported and left alone. The state is kept in `tool-settings.json` in the Scopebond folder.

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
