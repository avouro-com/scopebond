# @scopebond/agent

**Free and open source (Apache-2.0).** Scopebond Cloud, the hosted shared
workspace it connects to, is a separate proprietary service. This package is the
Scopebond service on the computer, which keeps the computer connected to its workspace.

The Scopebond service (`@scopebond/agent`) keeps a computer connected to its Scopebond workspace without anyone running a command.
It is one resident process per user. The hook (`@scopebond/hook`) keeps evaluating supported actions on its own; the
agent never takes part in a decision. It only keeps everything around the decisions working:

- **Delivery.** It sends the records the hook queued, all of them, with backoff while the workspace is unreachable.
  A record the workspace refuses on its own is kept as a gap and never holds up the rest.
- **Rules and connection.** It runs the rules check, which brings the workspace's rules, reports this computer's
  queue, and renews the machine credential before it expires.
- **Repair.** It notices when an agent's settings lost the Scopebond hook entry (an update or a reset can remove it)
  and puts it back without touching anything else in the file, on its own while it runs (see "Discovery while the
  agent runs") or on request.
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
  the agent puts the hook into the settings of the coding agents on this computer (Claude Code, and Cursor and OpenAI Codex where
  they are installed) and turns autostart on, as `setup` does. If you close the page, **Sign in…** in the tray's menu
  starts it again. The workspace is the one the installer was given (`msiexec /i … WORKSPACE=https://<your-workspace>`,
  kept as `Workspace` under `HKCU\Software\Avouro\Scopebond`, or `HKLM` for an install for every user), else
  `https://cloud.scopebond.com`. Only an https address there is used, and the machine's `HKLM` value, when there is
  one, wins over this user's `HKCU` one. From a terminal the same is
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
  recorded, shown in `status` and the tray, and not tried again for a day. A version that installed but did not start
  is taken back: the previous release's installer is fetched and checked the same three ways, the new version is
  removed without telling the workspace or touching the hook entries, and the previous one is installed again with the
  workspace it had (logs `msi-<version>-rollback-remove.log` and `msi-<previous>-rollback.log`). An install for every
  user (Program Files) is updated by whoever deployed it.
- **From an npm install.** Existing npm installs keep working until the signed installer is installed. When the signed
  agent first starts (or `setup` runs) it takes over: it stops the npm agent, removes its `ScopebondAgent` sign-in entry,
  its launcher, its Settings -> Apps entry and that entry's uninstall script, and points every Scopebond hook entry at
  itself (`"<install folder>\scopebond-agent.exe" hook <tool>`). The npm package itself is left in place; remove it with
  `npm.cmd uninstall -g @scopebond/agent`. `status` says so while both are there.
- **Removing it.** Settings -> Apps -> Scopebond Agent -> Uninstall first runs `scopebond-agent uninstall` as the person
  removing it (autostart off, the agent stopped, the hook taken out of that person's coding-agent settings, the workspace
  told). Its output and exit code go to the installer's log (`msiexec /x … /l*v <log>`): a workspace that could not be
  told within a few seconds is said there and the exit code is 75, and the removal goes on either way. The last line names
  the Scopebond folder, which stays (keys and records not yet sent) unless it was removed with `msiexec /x … PURGE=1`.
  From npm, `scopebond-agent uninstall` (and the Settings -> Apps entry of an npm install) does the same and ends the same
  way; `scopebond-agent uninstall --purge` removes the folder too. An install for every user removed by a deployment tool (Intune, Group Policy, the system account) cleans only the
  profile it runs as: the agent does not edit other people's profiles. Before removing it for everyone, have each person
  run `scopebond-agent uninstall` (or remove it for them as them); afterwards, any hook entries left in someone's
  settings point at a program that is gone, and `status` and the daily self-check name that file
  (`hook_starts`). Installing Scopebond again, or taking the Scopebond entries out of those settings files, clears it.

## macOS: the installer package

The same executable in a macOS installer package (`packages/native`, `build-pkg.mjs`): `/usr/local/bin/scopebond-agent`
for every user of the Mac, and a LaunchAgent that runs `scopebond-agent run` as each person who signs in (the agent's own
autostart label, so it never runs twice). It counts as installed for every user.

- **Updates.** The package carries an updater that runs as root (the LaunchDaemon `com.scopebond.updater`). When the
  workspace recommends a newer signed build, the person's agent asks it for that version, and nothing else. The updater
  installs it only after the same checks as on Windows: newer than the one installed; the release manifest signed with
  an updater key built into the program; the package's SHA-256 and size are the manifest's; and the package is signed
  with Avouro LLC's Developer ID Installer identity and notarized (`pkgutil --check-signature`, `spctl`). The package's
  own postinstall then starts the new agent for everyone signed in. A package that did not install counts as a failed
  update and is tried again after 1 hour, 6 hours, then daily. An organization turns updates off with the `AutoUpdate`
  preference (`false`) in a configuration profile or `/Library/Preferences/com.scopebond.agent`; the person's own value
  does not turn them on or off.
- The signed executable run from anywhere else on a Mac does not update itself: it never fetches the Windows installer,
  offers no update in the tray, and says in its log that a newer package is recommended. `sudo "/Library/Application Support/Scopebond/uninstall.sh"`
removes it, running `scopebond-agent uninstall` first as the person removing it; `--purge` removes the Scopebond folder
too.

- **First run.** On its first start the agent signs in as after the Windows installer. The workspace and an install key
  come from the `Workspace` and `InstallKey` preferences of `com.scopebond.agent`, read in this order:
  1. a configuration profile a device management service installed (`/Library/Managed Preferences`);
  2. the machine's preferences an administrator wrote:

     ```sh
     sudo defaults write /Library/Preferences/com.scopebond.agent Workspace https://<your-workspace>
     sudo defaults write /Library/Preferences/com.scopebond.agent InstallKey sbk_…
     ```

  3. this person's own `~/Library/Preferences/com.scopebond.agent`, which never overrides the first two.

  As on Windows, only an https address is used; a value that is not one stops the sign-in. Without a workspace, the
  agent signs in to Scopebond Cloud.
- **From an npm install.** When the package's agent starts (or `setup` runs) and finds the agent installed with npm, it
  takes over first: the npm agent is asked to stop, its LaunchAgent in `~/Library/LaunchAgents` and its launcher go
  (autostart becomes the package's LaunchAgent), and every Scopebond hook entry runs `/usr/local/bin/scopebond-agent`.
  The npm package stays where npm put it; the agent says once, and `status` keeps saying while it is there, that
  `npm uninstall -g @scopebond/agent` removes it.
- **The menu-bar app.** The package also installs `/Applications/Scopebond.app` (`packages/tray`): the icon, menu,
  status panel and notifications the Windows tray gives, in the menu bar. Beside it the agent posts no notifications of
  its own, and the hook's live question goes to the app while it runs.
- **Autostart.** It is the package's LaunchAgent. `autostart off` disables it for this person in launchd, and `autostart
  on` enables it again; neither writes a LaunchAgent of the person's own (one written before the package is removed).
  `status` reads launchd's disabled list.

npm stays the way to install on Linux, and on macOS until a signed package is released:

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

The agent also sends this computer's machine id, as the hook does (see the hook's README, "The machine id"): a SHA-256
hash of the operating system's own machine id and the workspace's id, in the body of its first sign-in and in the
`x-scopebond-machine-id` header of its rules checks and deliveries, so the workspace can tell that a computer
connecting again is the same one. The operating system's id itself never leaves the computer and is never written,
logged or shown. Without one, nothing is sent.

| Tool | Present when | Version from | MCP server names from |
|---|---|---|---|
| Claude Code | `~/.claude/settings.json` or `~/.claude/` | `@anthropic-ai/claude-code` | `~/.claude.json` (`mcpServers`) |
| Cursor | `~/.cursor/` | — | `~/.cursor/mcp.json` (`mcpServers`) |
| Codex | `~/.codex/`, or the folder `CODEX_HOME` names | `@openai/codex` | `config.toml` in that folder (`[mcp_servers.<name>]` table headers) |
| GitHub Copilot CLI | the CLI's `settings.json` or `logs` in `~/.copilot/` (`COPILOT_HOME`), or `copilot` on PATH, as the hook detects it | `@github/copilot` | `~/.copilot/mcp-config.json` (`mcpServers`) |
| Windsurf (best effort) | `~/.codeium/windsurf/` | — | `~/.codeium/windsurf/mcp_config.json` (`mcpServers`) |
| Gemini CLI | `~/.gemini/` | `@google/gemini-cli` | `~/.gemini/settings.json` (`mcpServers`) |
| Cline (best effort) | VS Code's `User/globalStorage/saoudrizwan.claude-dev` (stable or Insiders), or the Cline CLI's `~/.cline/` | — | — |
| OpenCode | `~/.config/opencode/` (or under `XDG_CONFIG_HOME`) or `~/.opencode/` | `opencode-ai` | — |
| Aider | any `~/.aider*` (`~/.aider.conf.yml`, `~/.aider/`) | — | — |

Discovery is passive: it reads files and never starts a program. A version is the `version` in the tool's npm package
manifest (`<package>/package.json`) in a global npm folder: the one `npm_config_prefix` names, the one beside the
Node.js the agent runs on, and the usual folders for the platform (`%APPDATA%\npm\node_modules` on Windows;
`~/.npm-global/lib/node_modules`, `/usr/local/lib/node_modules`, `/opt/homebrew/lib/node_modules` and
`/usr/lib/node_modules` elsewhere). Without that manifest the version is unknown (`null`): neither the tool nor npm is
run to find it, so a program that only shares a tool's name on PATH never supplies a version. `copilot` on PATH is
only looked up, never run. A supported tool whose configuration folder lies outside the selected user profile, or
whose hook file is a link, is left out. The rows marked best effort are not confirmed against the tool's current
documentation: Windsurf's folder, and Cline's VS Code storage folder, which follows VS Code's naming for the
extension's id.

### Discovery while the agent runs

The agent does not wait for the daily self-check to notice a coding tool. While it runs it watches the user profile
and the configuration folders of the tools the hook supports (Claude Code, Cursor, Codex and GitHub Copilot CLI; at
most 12 folders, a change acted on after one second) and checks again every 10 seconds whatever the folders say, so a
computer that wakes from sleep is checked again within that time. One check runs at a time, and a result that has not
changed is not reported again.

- **Enrolling a missing hook.** A supported tool that is present but whose user-level settings have no Scopebond hook
  entry, a missing hook file included, gets one; a second Scopebond entry for the same tool is taken out. Every other
  setting stays, a settings file that is a link or does not parse is never written, and the file is replaced in one
  step.
- **Saved exclusions.** `integration-intent.json` in the Scopebond folder (`{ "version": 1, "automatic": true,
  "excluded": [...] }`) says which tools the agent leaves alone. An excluded tool, or one whose own settings switch its
  hooks off, is never enrolled or repaired automatically, nor when `setup` runs again or the computer connects; with
  `"automatic": false` no tool is. A file that cannot be read as such turns automatic changes off for every tool.
- **Profile boundary.** Automatic changes and watches stay inside the user profile the agent runs for. A tool folder
  moved outside it (by `CODEX_HOME` or `COPILOT_HOME`, or through a link) is not changed automatically. The profile is
  bound to a random id in `integration-profile.json` in the Scopebond folder; a Scopebond folder copied to another
  profile does not match it, and automatic changes stop there.
- **Per-tool status.** `scopebond-agent status` (and `GET /status`, as `integrations`) gives each supported tool on
  its own: whether it is detected, and its state (`not configured`, `awaiting trust` for Codex until it is trusted in
  `/hooks`, `awaiting restart`, `disabled`, `repair failed`) with the reason (an exclusion, the tool's own hooks
  switched off, a hook command that cannot start, a duplicate entry, the profile boundary). One tool's hook never
  counts for another. The status covers this computer's own environment (Windows, macOS, Linux, WSL, a container or a
  remote session) only, and a configured hook is never reported as verified at run time.
- **Local hook activity.** Each call the hook answers, and each session and after-tool event it receives, is reported
  to the running agent over the local control channel (`POST /integration/callback`, over the pipe or socket only):
  the tool, the kind of event, a random id and the time, sent within 20 ms or not at all. The agent accepts a report
  only with the channel's token, at most 10 seconds old, not seen before, and for a tool whose hook is configured as it
  is now; status then shows when the tool last called the hook (`callback_observed`, or `stale` after 15 minutes). It
  is kept in memory only: a restart, a changed configuration or a clock set back forgets it. It is not sent to the
  workspace, and it never changes a tool's state, its trust or what it is licensed for.
- **To the workspace.** When the workspace supports it (`GET /v1/tool-inventory` answers `tool_inventory_1`), the
  agent also sends these per-tool states, with a hash of each tool's hook configuration, the profile's random id and
  the kind of environment, signed with this computer's key: no path, no setting and no command. A workspace without
  the route is asked again later.

## Tool settings from the workspace

A workspace can keep lists in the user-level settings of the AI coding tools on a computer: permission rules to allow
and to deny, and MCP servers a tool may or may not start. Nothing else: never prompts, instruction files or a model
choice. The lists arrive inside the workspace's rules document as a `tool_settings` section that is signed on its own,
with the same key and the same check as the rules (`checkToolSettingsSignature` in `@scopebond/hook`; its signed payload
also carries `kind: "tool_settings"`, so a rules signature never passes for tool settings, nor the reverse). The agent applies
a section only when it is signed by a key this release trusts; an unsigned section, or one signed by a key it does not
trust, is never applied, in any mode, and is reported as `refused: unsigned`.

| Tool | File | What the agent sets |
|---|---|---|
| Claude Code | `~/.claude/settings.json` (`$CLAUDE_CONFIG_DIR/settings.json` when the agent's environment sets it) | `permissions.allow`, `permissions.deny`, `allowedMcpServers` and `deniedMcpServers` (`{ "serverName": … }` entries) |
| Cursor CLI | `~/.cursor/cli-config.json` | `permissions.allow`, `permissions.deny`; a denied MCP server is the deny entry `Mcp(<name>:*)`. A deny entry refuses the server's tool calls; Cursor still starts the server. Cursor documents no list of permitted MCP servers, so that list is refused as unsupported |
| Codex, GitHub Copilot CLI | — | Nothing: refused as unsupported. Codex has per-server settings in `~/.codex/config.toml`, but Scopebond does not rewrite TOML yet; Copilot CLI takes tool permissions as command-line flags only |

The workspace's entries are added to those lists. An entry the agent itself added (not one that was already in the file)
is taken out again when the workspace no longer sets it, and a list the agent created is removed once it is empty (an
empty `allowedMcpServers` would stop every MCP server); a person's own entries and lists stay. Every other key stays,
in the file's own indentation and line endings. The first change keeps a copy (`<file>.scopebond-backup`; an existing
copy is never replaced), every write replaces the file through a temporary file, and a file that does not parse as JSON,
or whose lists are not lists, is never written (`refused: unparseable`). A settings file that is a symbolic link (a
dotfiles checkout, say) is never replaced (`refused: symlink`). A tool whose folder does not exist is reported as
`refused: not_installed` and nothing is created.

A changed file is written back from its parsed form: `\u` escapes become the characters they stand for, a key that
appears twice keeps only its last value, and on macOS and Linux the file becomes readable by its owner only (0600).

Each rules check reports, per tool, `applied`, `drifted` (with the names of the settings that no longer hold the
workspace's entries, for example `permissions.deny`, never their values) or `refused` and why
(`x-scopebond-tool-settings`). When the section says `mode: "enforce"`, a drift is put back and reported as restored;
with `mode: "report"` it is reported and left alone. Rules without a section, after a computer had one, are reported
as `not_delivered`, and nothing is changed. The state is kept in `tool-settings.json` in the Scopebond folder, with
the newest section's time per workspace, so an older section is refused as a replay.

## Local control channel

The agent listens on a named pipe with a random name (Windows) or a Unix socket in a folder only you can open, and
npm installs also on `127.0.0.1` at a random port (`SCOPEBOND_AGENT_LOOPBACK=0` turns that off); every request must
carry a random token. Pipe or socket, port, token and process id are in `~/.scopebond/agent.json`, readable by you
only. Routes: `GET /status`, `POST /flush`, `POST /repair`, `POST /maintain`, `POST /rescan`, `POST /override`,
`POST /integration/callback`, `POST /stop`.
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
notification setting (Blocks and problems — the default for a new install —, Problems only — kept for an install whose
person never chose —, Off; an older "all" reads as Blocks and problems); Help (copy diagnostics without keys or credentials, open
the Scopebond folder, documentation, About); and Hide icon. There is no "pause" or "quit protection": the hook decides
every action whether or not the agent runs. A balloon appears when the state gets worse ("needs attention" only after
five minutes, so sleep and wake do not flap) and once when it is protected again. Set `SCOPEBOND_AGENT_TRAY=off` for no
icon. On macOS and Linux the agent sends a system notification when things get worse, and once more when they recover.

The tray only draws what the agent computes: `GET /tray` on the local channel returns the model (state, headline, rows,
fix, actions, the line under the state, today's counts, the workspace's name, and up to 20 recent blocks: each in plain words
as the Scopebond window shows it, with secrets masked, the rule's name, the project and the coding tool, and what the
workspace lets the person do about it now: allow it once, for 15 minutes or always, or ask an admin, with the shortest
reason it accepts) and the person's settings; `POST /check`, `/update`, `/flush`, `/repair`, `/settings`
and `/blocked` (an earlier block, answered in the Scopebond window) do the work. `GET /status` carries the same `health` (level, headline, fix).

The tray's own panel answers earlier blocks and lists what came of them, over the same channel and token:

- `POST /blocked/answer` with `{ action_id, choice, reason, scope?, once_now? }`, where `choice` is `once`, `fifteen`,
  `hour`, `tomorrow`, `always`, `ask` or `quiet`. The agent checks it again as the Scopebond window would (the block is
  still offered, the workspace offers that choice for it now, the reason is at least the workspace's minimum and at most
  500 characters, with no control characters but line breaks). Any program running as the person can read the channel's
  token, the coding agent among them, so nothing on the channel shows that a person answered. So only the next try is
  allowed on this computer from an answer here: `once` makes a one-time allowance marked `approval: "local_unverified"`
  in the record sent to the workspace. A longer choice (a length, `always`, or `scope: "similar"`) makes no allowance
  here: it becomes a request to an admin (`asked_for` says what was chosen), and the action is allowed once now where
  once is offered, unless `once_now: false`. A longer choice is refused when the computer is not connected to a
  workspace (`needs_workspace`) or the workspace takes no requests for the block (`not_offered`). `ask` and `quiet`
  work as before. Allowances and requests are sent signed by this computer's key (`/v1/allowances`, `/v1/requests`).
  It answers `{ outcome, choice, text }`: `allowed`, `asked`, `quiet`, or why not (`gone`, `not_offered`,
  `needs_workspace`, `reason_short`, `invalid`), and the words the tray shows ("Allowed once · recorded in Acme"); with
  `approval` when something was allowed, and `requested` and `allowed_once` for a longer choice. The block's `offers`
  in `GET /tray` say what may be chosen from here: no lengths, and `always` and similar commands only as requests
  (`always_needs_admin`, `similar.needs_admin`). Scopebond never runs the action: the person or the coding agent runs it
  again.
- `GET /allowances`: the allowances that still apply and those waiting for an admin, newest first: what (the text the
  window showed, when this computer knows it), the rule and its name, the choice (`once`, `fifteen`, `always`), the state
  (`active` or `proposed`), who made it (the person, or an admin) and when it ends. From `allowances.json` with the rules
  document's allowances and revoked allowances brought in.
- `GET /requests`: the requests to an admin, newest first: what, the person's reason, when it was asked and whether it
  reached the workspace, and the state: `waiting`, `approved` (an allowance for the same rule and action came back from
  the workspace) or `declined`, with who answered and the admin's note when the workspace sent them (an optional `request_answers` list in
  its rules document, `{ request_id, state, by, note, at }`, or `approved_by` and `note` on the allowance it sends).

`GET /tray` carries the same two lists as `allowed` and `asked`.

- `POST /allowances/stop` with `{ id }`: "Stop allowing". The person ends an allowance they made on this computer (or one
  applied at once by the workspace's terms; not one an admin made). It stops applying at once, and the agent sends the
  workspace a record signed like the others (`/v1/allowances`): `{ id, state: "ended", ended_by: "person", ended_at }`. A
  workspace that does not take it refuses it once and is not asked again; the allowance stays ended here.

The live prompt: when the hook asks during a coding session (`POST /override`) and a tray is listening, the question waits
in the tray, and only there: no Scopebond window opens beside it, so one block asks once.

- `POST /override/wait` with `{ seen }`: the tray's long wait. It answers `{ question }` at once when the question waiting
  now is not the one the tray last saw, else when it changes or after 20 s. The question has the action as the window
  shows it, the rule's name, the coding tool, what the workspace lets the person do (`offers`, with `reviewed`), the
  shortest reason and the `deadline` (when the hook stops waiting). `GET /tray` carries it as `pending`.
- `POST /override/open` with `{ action_id }`: the person opened it in the tray.
- `POST /override/answer` with `{ action_id, choice, reason }`: the person's answer, checked as the window's would be,
  becomes the hook's answer: `once` (an allow marked `approval: "local_unverified"`), `ask` or `quiet`. A longer choice
  becomes the hook's request to an admin, and nothing is allowed now; it is refused when the computer is not connected
  (`needs_workspace`) or the workspace takes no requests (`not_offered`), and the question keeps waiting. The question's
  `offers` say so: once, or asking an admin. The question stays in the tray for the hook's whole wait; unanswered at the deadline,
  nothing is allowed. With no tray listening, the window opens at once on macOS and Linux. On Windows the Windows Forms
  window is retired: it opens only with `SCOPEBOND_PROMPT_WINDOW=1` (kept for one release); otherwise the agent answers
  `{ decision: "unavailable", later: true, link? }` at once, and the hook's denial tells the person to allow the block,
  or ask an admin, from the Scopebond icon's recent blocks afterwards (`link`: this computer's page in the workspace,
  when connected).

## Status

Experimental.
