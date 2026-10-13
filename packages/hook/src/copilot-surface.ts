// Which GitHub Copilot surface ran a hook, and the record of the tool names each surface actually sent.
//
// GitHub Copilot runs the same hook file from three places, and they do not behave alike:
//
//   cli           the Copilot CLI, and VS Code's "Copilot" session target, which runs the same SDK hook implementation on
//                 VS Code's Agent Host. The payload and tool names are those in GitHub's Copilot hooks reference.
//   vscode_local  VS Code's "Local" harness (the extension host). It reads `.github/hooks/*.json` and
//                 `~/.copilot/hooks/*.json` too, but sends its own payload (it adds `tool_use_id`) and its own tool names,
//                 which neither GitHub nor VS Code publishes ("open the agent debug logs to inspect the Local tool schema").
//   cloud_agent   the Copilot cloud coding agent: an ephemeral Linux sandbox that loads only `.github/hooks/*.json` from the
//                 cloned repository, runs only an entry's `bash` (or `command`), and treats `ask` as `deny`.
//
// Sources, read 2026-10-13:
//   https://docs.github.com/en/copilot/reference/hooks-reference  (hook locations, "Cloud agent execution environment",
//     payloads for the camelCase and VS Code compatible formats, "Tool names for hook matching", exit codes)
//   https://code.visualstudio.com/docs/agent-customization/hooks  (session targets: Copilot on Agent Host vs Local)
//   https://code.visualstudio.com/docs/agents/reference/hooks-reference  (Local payloads: `tool_use_id`, `hookSpecificOutput`)
//
// None of this is verified on a live install yet. The tool-name record below is how a person checks it: `scopebond
// capabilities --prove --copilot` opens a recording window, the person uses each surface, and the same command then lists
// every tool name each surface sent and what Scopebond made of it.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { userHarnessFile } from "./install.js";
import { readIfPresent, replaceFile } from "./safe-fs.js";

export type CopilotSurface = "cli" | "vscode_local" | "cloud_agent";

/** Environment variables whose presence (never their value) says a hook runs in the Copilot cloud agent's sandbox. GitHub
 *  documents `COPILOT_AGENT_PROMPT` (the job's prompt) and `GITHUB_COPILOT_API_TOKEN` as set there. */
const CLOUD_AGENT_VARS = ["COPILOT_AGENT_PROMPT", "GITHUB_COPILOT_API_TOKEN"] as const;

/** Whether this hook runs in the Copilot cloud coding agent's sandbox (or a job like it).
 *
 *  The heuristic: no user-level Scopebond hook file for Copilot (a person's computer has one once `install --copilot` ran;
 *  the sandbox ships with no user-level hook files at all), and the sandbox's own variables are set
 *  (`COPILOT_AGENT_PROMPT` or `GITHUB_COPILOT_API_TOKEN`, by presence only) or the job is a GitHub Actions run
 *  (`GITHUB_ACTIONS=true`).
 *
 *  How it fails, and why that is safe: the Copilot CLI run as a step in GitHub Actions without a user-level install is read
 *  as the cloud agent, so its `ask` becomes a `deny` (no one is there to answer either). A cloud sandbox that stops setting
 *  these variables is read as the CLI, so it is answered `ask`, which the cloud agent itself treats as `deny`. Neither
 *  mistake lets an action through that would otherwise have been stopped. */
export function copilotCloudAgent(env: NodeJS.ProcessEnv = process.env, userInstall: boolean = existsSync(userHarnessFile("copilot"))): boolean {
  if (userInstall) return false;
  return CLOUD_AGENT_VARS.some((name) => env[name] !== undefined) || env.GITHUB_ACTIONS === "true";
}

/** The plain signals a hook call carried about where it came from: names of what was present, never a value. */
export function surfaceSignals(payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): string[] {
  const signals: string[] = [];
  if (typeof payload.hook_event_name === "string") signals.push("pascal_case_payload");
  else if (payload.toolName !== undefined || payload.sessionId !== undefined) signals.push("camel_case_payload");
  if (typeof payload.tool_use_id === "string") signals.push("tool_use_id");
  for (const name of CLOUD_AGENT_VARS) if (env[name] !== undefined) signals.push(name);
  if (env.GITHUB_ACTIONS === "true") signals.push("GITHUB_ACTIONS");
  if (env.VSCODE_PID !== undefined || env.TERM_PROGRAM === "vscode") signals.push("vscode_environment");
  return signals;
}

/** Which surface most likely sent `payload`: the cloud agent by `copilotCloudAgent`; VS Code's Local harness when the
 *  payload carries `tool_use_id` (a field the Local reference documents and GitHub's does not); the CLI otherwise (which
 *  includes VS Code's Copilot session target, whose payload is the CLI's). A best reading, for the record and the `ask`
 *  answer only; it never relaxes a decision. */
export function copilotSurface(payload: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env, userInstall?: boolean): CopilotSurface {
  if (copilotCloudAgent(env, userInstall)) return "cloud_agent";
  if (typeof payload.tool_use_id === "string") return "vscode_local";
  return "cli";
}

/** Why an "ask" is a deny in the Copilot cloud agent, said in the deny itself. */
export const COPILOT_CLOUD_ASK_IS_DENY = "this action needs a person's approval, and the Copilot cloud agent has no one to ask, so it is denied";

export interface CopilotAnswer { stdout: string; stderr: string; exitCode: 0 | 2 }

/** What the hook writes for a Copilot `deny` or `ask`.
 *
 *  The decision is written in both shapes Copilot's surfaces read: the top-level `permissionDecision` and
 *  `permissionDecisionReason` (GitHub's hooks reference, "preToolUse decision control"; the Copilot CLI and VS Code's
 *  Copilot session target) and `hookSpecificOutput` (VS Code's Local hooks reference, "PreToolUse Output"). Both say the
 *  same thing, so whichever one a surface reads, the answer is the same.
 *
 *  A deny also exits 2, which the CLI treats as a deny whatever stdout says and the Local harness treats as a blocking
 *  error with stderr given to the model, so a deny holds even if the JSON were not read. An `ask` in the cloud agent
 *  (`cloud`) is answered as a deny with the reason spelled out: the cloud agent turns every "ask" into a deny because no
 *  one can answer it, and the agent should be told why rather than see a bare refusal. */
export function copilotAnswer(decision: "deny" | "ask", reason: string, cloud: boolean): CopilotAnswer {
  if (decision === "ask" && cloud) return copilotAnswer("deny", `Scopebond: ${COPILOT_CLOUD_ASK_IS_DENY}. ${reason.replace(/^Scopebond:\s*/, "")}`, cloud);
  const body = {
    permissionDecision: decision, permissionDecisionReason: reason,
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason },
  };
  const stdout = JSON.stringify(body) + "\n";
  if (decision === "ask") return { stdout, stderr: "", exitCode: 0 };
  return { stdout, stderr: `${reason.startsWith("Scopebond") ? reason : `Scopebond: ${reason}`}\n`, exitCode: 2 };
}

/** The tool names GitHub's hooks reference documents ("Tool names for hook matching", and the runtime-to-Claude table the
 *  PascalCase payloads use). A name a surface sends that is not here is exactly what a live run has to confirm. */
export const DOCUMENTED_COPILOT_TOOL_NAMES: readonly string[] = [
  "bash", "powershell", "view", "create", "edit", "str_replace_editor", "apply_patch", "grep", "rg", "glob", "web_fetch",
  "web_search", "ask_user", "update_todo", "task",
  // As the PascalCase payloads report them.
  "Bash", "Read", "Write", "Edit", "Grep", "Glob", "WebFetch", "WebSearch", "AskUserQuestion", "TodoWrite", "Agent",
];

// --- The tool-name record ---------------------------------------------------------------------------------------------

/** The record file, beside the policy. It exists only while a person has a recording window open. */
export const COPILOT_PROBE_FILE = "copilot-tool-names.json";
/** How long a recording window stays open. */
export const COPILOT_PROBE_WINDOW_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const MAX_KEYS = 20;
const MAX_NAME = 120;
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

export interface ProbeEntry {
  surface: CopilotSurface;
  event: string;
  /** The tool name exactly as the surface sent it. */
  tool_name: string;
  /** What Scopebond made of it: action types, `tool.<name>` for an unmapped tool. */
  mapped_as: string[];
  /** Whether every action it became is checked (false: recorded, not evaluated). */
  evaluated: boolean;
  /** The argument names (never the values). */
  input_keys: string[];
  signals: string[];
  count: number;
  first_seen: string;
  last_seen: string;
}

export interface CopilotProbe {
  version: 1;
  opened_at: string;
  until: string;
  entries: ProbeEntry[];
}

const probePath = (dir: string): string => join(dir, COPILOT_PROBE_FILE);

/** The record, or null when there is none or it does not read. */
export function readCopilotProbe(dir: string): CopilotProbe | null {
  try {
    const text = readIfPresent(probePath(dir));
    if (text === undefined) return null;
    const parsed = JSON.parse(text) as CopilotProbe;
    return parsed && parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : null;
  } catch { return null; }
}

/** Open (or extend) the recording window, keeping what was already recorded. Returns the record. */
export function openCopilotProbe(dir: string, now: Date = new Date()): CopilotProbe {
  const existing = readCopilotProbe(dir);
  const probe: CopilotProbe = {
    version: 1,
    opened_at: existing?.opened_at ?? now.toISOString(),
    until: new Date(now.getTime() + COPILOT_PROBE_WINDOW_MS).toISOString(),
    entries: existing?.entries ?? [],
  };
  replaceFile(probePath(dir), JSON.stringify(probe, null, 2) + "\n");
  return probe;
}

const clip = (s: string): string => s.length > MAX_NAME ? s.slice(0, MAX_NAME) : s;

/** Add one hook call to the record, when a window is open. Best effort: it never throws, and with no window open it only
 *  checks that the file is absent. Only the tool's name, the event, the argument names and the signals are kept. */
export function recordCopilotProbe(dir: string, call: {
  payload: Record<string, unknown>; surface: CopilotSurface; signals: string[]; mapped_as: string[]; evaluated: boolean;
}, now: Date = new Date()): void {
  try {
    if (!existsSync(probePath(dir))) return;
    const probe = readCopilotProbe(dir);
    if (!probe || Date.parse(probe.until) < now.getTime()) return;
    const p = call.payload;
    const rawName = p.tool_name ?? p.toolName;
    const tool_name = clip(typeof rawName === "string" ? rawName : "(none)");
    const event = clip(typeof p.hook_event_name === "string" ? p.hook_event_name : "(camelCase event)");
    let args: unknown = p.tool_input ?? p.toolArgs;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
    const input_keys = args && typeof args === "object" && !Array.isArray(args)
      ? Object.keys(args).filter((k) => SAFE_KEY.test(k)).sort().slice(0, MAX_KEYS) : [];
    const at = now.toISOString();
    const found = probe.entries.find((e) => e.surface === call.surface && e.event === event && e.tool_name === tool_name);
    if (found) {
      found.count += 1; found.last_seen = at;
      found.input_keys = [...new Set([...found.input_keys, ...input_keys])].sort().slice(0, MAX_KEYS);
      found.signals = [...new Set([...found.signals, ...call.signals])].sort();
    } else if (probe.entries.length < MAX_ENTRIES) {
      probe.entries.push({ surface: call.surface, event, tool_name, mapped_as: call.mapped_as.map(clip).slice(0, 8), evaluated: call.evaluated,
        input_keys, signals: [...call.signals].sort(), count: 1, first_seen: at, last_seen: at });
    }
    replaceFile(probePath(dir), JSON.stringify(probe, null, 2) + "\n");
  } catch { /* the record is a diagnostic; it never affects the call */ }
}

const SURFACE_LABEL: Record<CopilotSurface, string> = {
  cli: "Copilot CLI (or VS Code's Copilot session target)",
  vscode_local: "VS Code Local harness",
  cloud_agent: "Copilot cloud agent",
};

/** The record as text: per surface, every tool name seen, what it became, and the documented names not seen yet. */
export function renderCopilotProbe(probe: CopilotProbe | null, file: string, now: Date = new Date()): string {
  const lines: string[] = [];
  lines.push("GitHub Copilot tool names seen on this computer");
  if (!probe) { lines.push(`  nothing recorded (${file})`); return lines.join("\n"); }
  const open = Date.parse(probe.until) >= now.getTime();
  lines.push(`  ${file}: recording ${open ? `open until ${probe.until}` : `closed at ${probe.until}`}`);
  if (probe.entries.length === 0) lines.push("  no Copilot hook call has been recorded yet");
  for (const surface of ["cli", "vscode_local", "cloud_agent"] as const) {
    const entries = probe.entries.filter((e) => e.surface === surface);
    if (entries.length === 0) continue;
    lines.push("");
    lines.push(`  ${SURFACE_LABEL[surface]}`);
    for (const e of [...entries].sort((a, b) => a.event.localeCompare(b.event) || a.tool_name.localeCompare(b.tool_name))) {
      const documented = DOCUMENTED_COPILOT_TOOL_NAMES.includes(e.tool_name);
      lines.push(`    ${e.event.padEnd(18)} ${e.tool_name.padEnd(28)} ${String(e.count).padStart(4)}x  -> ${e.mapped_as.join(", ") || "(no action)"}${e.evaluated ? "" : " (recorded, not evaluated)"}${documented ? "" : "  [not in GitHub's documented names]"}`);
      if (e.input_keys.length) lines.push(`        arguments: ${e.input_keys.join(", ")}`);
      lines.push(`        signals: ${e.signals.join(", ") || "none"}`);
    }
  }
  const seen = new Set(probe.entries.map((e) => e.tool_name));
  const missing = DOCUMENTED_COPILOT_TOOL_NAMES.filter((n) => !seen.has(n));
  lines.push("");
  lines.push(`  documented names not seen yet: ${missing.join(", ") || "none"}`);
  return lines.join("\n");
}
