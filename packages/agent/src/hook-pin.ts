// The exact hook entry each coding tool's user settings should hold, and how the installed one differs from it. The
// expected entry is worked out from this agent itself (the program it runs and the arguments the installer writes), never
// read from a file on this computer, so a changed settings file or state file cannot vouch for itself. Any difference is
// tamper: another program or other arguments, a wrapper around the command, the entry gone, Claude Code's
// `disableAllHooks`, or an integration-intent file that no longer reads. Reports name what differs and carry digests
// only, never the contents of a file.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADAPTERS, HARNESSES, INTEGRATION_INTENT_FILE, adapterPresent, adapterWithinProfile, codexHookEntry, copilotHookEntry, harnessHookIsOurs, isHarness,
  readHarnessConfig, userHarnessFile, userHome, wireLifecycleHooks, writeHarnessConfig, writeIntegrationIntent, type Harness,
} from "@scopebond/hook";
import { maintainedHookCommand } from "./update.js";

/** What differs from the expected entry. */
export type PinDeviation =
  | "missing_entry" | "program" | "arguments" | "wrapper" | "hooks_disabled" | "settings_unreadable" | "intent_unreadable";

/** One coding tool's hook entry compared with the one this agent would write. `excluded`: the person excluded the tool;
 *  `not_checked`: the tool is not on this computer (or outside the selected profile), or no entry can be written for it. */
export interface HookPin {
  harness: Harness;
  state: "intact" | "tampered" | "excluded" | "not_checked";
  /** sha256 of the expected entry's command fields (program path and arguments, per field the tool reads). */
  expected_digest: string | null;
  /** The same digest of each distinct Scopebond entry installed (at most eight). */
  installed_digests: string[];
  deviations: PinDeviation[];
}

export type IntentState = "absent" | "ok" | "unreadable";
export interface HookPins { intent: IntentState; tools: HookPin[] }

/** The command fields a hook entry may run: `command`, Codex's `commandWindows`, and Copilot's `bash` and `powershell`. */
const COMMAND_KEYS = ["command", "commandWindows", "bash", "powershell"] as const;
type CommandFields = Partial<Record<(typeof COMMAND_KEYS)[number], string>>;
const MAX_DIGESTS = 8;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const fieldsOf = (entry: Record<string, unknown>): CommandFields => {
  const out: CommandFields = {};
  for (const key of COMMAND_KEYS) { const value = entry[key]; if (typeof value === "string") out[key] = value; }
  return out;
};

/** The command the installer and upkeep write for `harness`: this agent's own hook, by its absolute path (the single
 *  executable with `hook <harness>`, or Node and the hook's cli.js). */
export function expectedHookCommand(harness: Harness): string {
  return maintainedHookCommand(harness);
}

/** The command fields of the entry the installer writes for `command`, exactly as `writeHarnessConfig` places them. */
export function expectedHookEntry(harness: Harness, command: string): CommandFields {
  if (harness === "codex") return fieldsOf(codexHookEntry(command));
  if (harness === "copilot") return fieldsOf(copilotHookEntry(command));
  return { command: harness === "cursor" ? command.replace(/\bclaude$/, "cursor") : command };
}

/** A digest of one entry's command fields, bound to its coding tool. */
export function hookEntryDigest(harness: Harness, fields: CommandFields): string {
  return createHash("sha256").update(JSON.stringify(["scopebond:hook-entry", 1, harness, COMMAND_KEYS.map((key) => fields[key] ?? null)])).digest("hex");
}

/** Whether the integration-intent file reads: absent (automatic, nothing excluded), ok, or unreadable (corrupt, too large,
 *  not a file), which turns every automatic repair off until it is written again. */
export function integrationIntentState(dir: string = userHome()): IntentState {
  let text: string;
  try { text = readFileSync(join(dir, INTEGRATION_INTENT_FILE), "utf8"); } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
  }
  try {
    if (text.length > 4096) return "unreadable";
    const value = JSON.parse(text) as Record<string, unknown>;
    const ok = record(value) && value.version === 1 && typeof value.automatic === "boolean" && Array.isArray(value.excluded)
      && value.excluded.length <= HARNESSES.length && value.excluded.every(isHarness);
    return ok ? "ok" : "unreadable";
  } catch { return "unreadable"; }
}

/** A readable intent file's choices (the defaults when there is none). */
function intentChoices(dir: string): { automatic: boolean; excluded: Harness[] } {
  try {
    const value = JSON.parse(readFileSync(join(dir, INTEGRATION_INTENT_FILE), "utf8")) as { automatic?: boolean; excluded?: Harness[] };
    return { automatic: value.automatic !== false, excluded: value.excluded ?? [] };
  } catch { return { automatic: true, excluded: [] }; }
}

/** Every enabled Scopebond hook handler in a settings document, with the event it is under. */
function installedHandlers(hooks: Record<string, unknown>): Array<{ event: string; fields: CommandFields }> {
  const found: Array<{ event: string; fields: CommandFields }> = [];
  const walk = (event: string, value: unknown): void => {
    if (!record(value) || value.enabled === false || value.disabled === true) return;
    if (COMMAND_KEYS.some((key) => typeof value[key] === "string") && harnessHookIsOurs(value)) found.push({ event, fields: fieldsOf(value) });
    if (Array.isArray(value.hooks)) for (const child of value.hooks) walk(event, child);
  };
  for (const [event, list] of Object.entries(hooks)) if (Array.isArray(list)) for (const value of list) walk(event, value);
  return found;
}

const unquote = (token: string): string => token.replace(/^["']+|["']+$/g, "");
/** The program a command runs: its leading path words (Node and the hook's cli.js, or the single executable), or its first
 *  word when it starts with a bare name. PowerShell's call operator is skipped. */
function programOf(command: string): string {
  const words = (command.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(unquote).filter((w) => w !== "&");
  const paths: string[] = [];
  for (const word of words) { if (!/[\\/]/.test(word)) break; paths.push(word); }
  const program = paths.length ? paths : words.slice(0, 1);
  const spelled = program.join(" ").replace(/\\/g, "/");
  return process.platform === "win32" ? spelled.toLowerCase() : spelled;
}

/** How one installed command differs from the expected one. */
function deviationOf(installed: string | undefined, expected: string | undefined): PinDeviation | null {
  if (installed === expected) return null;
  if (installed === undefined || expected === undefined) return "arguments";
  if (installed.includes(expected.trim())) return "wrapper";
  return programOf(installed) === programOf(expected) ? "arguments" : "program";
}

/** Each coding tool's installed hook entry compared with the expected one. Never throws. `expected`: the command this agent
 *  writes for a tool (tests name their own). */
export function hookPins(harnesses: readonly Harness[], options: { dir?: string; expected?: (harness: Harness) => string } = {}): HookPins {
  const dir = options.dir ?? userHome();
  const intent = integrationIntentState(dir);
  const { automatic, excluded } = intent === "ok" ? intentChoices(dir) : { automatic: true, excluded: [] as Harness[] };
  const tools = harnesses.map((harness): HookPin => {
    const pin: HookPin = { harness, state: "not_checked", expected_digest: null, installed_digests: [], deviations: [] };
    try { if (!adapterWithinProfile(harness) || !adapterPresent(harness)) return pin; } catch { return pin; }
    if (excluded.includes(harness)) return { ...pin, state: "excluded" };
    const deviations = new Set<PinDeviation>();
    if (intent === "unreadable") deviations.add("intent_unreadable");
    let expected: CommandFields | null = null;
    try { expected = expectedHookEntry(harness, (options.expected ?? expectedHookCommand)(harness)); pin.expected_digest = hookEntryDigest(harness, expected); } catch { /* no entry can be written here */ }
    let config: Record<string, unknown> | null = null;
    try { config = readHarnessConfig(userHarnessFile(harness)); } catch { deviations.add("settings_unreadable"); }
    if (config) {
      if (config.disableAllHooks === true || config.hooksEnabled === false) deviations.add("hooks_disabled");
      const handlers = installedHandlers(record(config.hooks) ? config.hooks : {});
      pin.installed_digests = [...new Set(handlers.map((h) => hookEntryDigest(harness, h.fields)))].slice(0, MAX_DIGESTS);
      // With automatic enrollment turned off, a tool the person never enrolled has no entry by choice.
      if (automatic || handlers.length) for (const event of ADAPTERS[harness].decisionEvents) if (!handlers.some((h) => h.event === event)) deviations.add("missing_entry");
      if (expected) {
        for (const handler of handlers) {
          for (const key of COMMAND_KEYS) { const found = deviationOf(handler.fields[key], expected[key]); if (found) deviations.add(found); }
        }
      }
    }
    if (!expected && !deviations.size) return pin;
    return { ...pin, state: deviations.size ? "tampered" : "intact", deviations: [...deviations].sort() };
  });
  return { intent, tools };
}

/** Deviations a repair can put right by writing the expected entry back. `hooks_disabled` is the person's own switch in
 *  the coding tool and stays; an unreadable settings file is never rewritten (it would lose the person's other settings). */
const REPAIRABLE: ReadonlySet<PinDeviation> = new Set(["missing_entry", "program", "arguments", "wrapper"]);

/** Write the expected entry back for each tool whose entry differs in a way a repair may change: the decision entry is put
 *  in place of Scopebond's (any other copy goes), and the session and after-action entries the same when there were any.
 *  Entries of other tools are never touched. Returns the tools written. */
export function repairHookPins(pins: readonly HookPin[], expected: (harness: Harness) => string = expectedHookCommand): Harness[] {
  const written: Harness[] = [];
  for (const pin of pins) {
    if (pin.state !== "tampered" || pin.deviations.some((d) => !REPAIRABLE.has(d))) continue;
    try {
      const harness = pin.harness;
      const command = expected(harness);
      const file = userHarnessFile(harness);
      const hooks = readHarnessConfig(file).hooks;
      const decisions: readonly string[] = ADAPTERS[harness].decisionEvents;
      const lifecycle = record(hooks) && installedHandlers(hooks).some((h) => !decisions.includes(h.event));
      writeHarnessConfig(file, harness, command);
      if (lifecycle && (harness === "claude" || harness === "codex")) wireLifecycleHooks(file, command, harness);
      written.push(pin.harness);
    } catch (error) {
      process.stderr.write(`Scopebond Agent: could not put the expected hook entry back for ${pin.harness}: ${(error as Error).message}\n`);
    }
  }
  return written;
}

/** An unreadable integration-intent file written again as the default (automatic, nothing excluded): what a missing file
 *  means. A corrupt file names no exclusion, so none is lost. True when it was written. */
export function repairIntegrationIntent(dir: string = userHome()): boolean {
  if (integrationIntentState(dir) !== "unreadable") return false;
  try { writeIntegrationIntent({ version: 1, automatic: true, excluded: [] }, dir); } catch { return false; }
  return integrationIntentState(dir) === "ok";
}

/** Tamper the agent saw and what became of it, kept until a self-check reports it. `tool`: a coding tool, or the
 *  integration-intent file. */
export interface TamperFinding {
  tool: Harness | "integration_intent";
  deviations: PinDeviation[];
  expected_digest: string | null;
  installed_digests: string[];
  first_seen_at: number;
  repaired: boolean;
}

/** Merge what one check found into what is kept: one finding per tool (deviations joined, the latest repair outcome). */
export function noteTamper(kept: TamperFinding[], found: readonly TamperFinding[]): TamperFinding[] {
  const out = kept.map((f) => ({ ...f }));
  for (const finding of found) {
    const known = out.find((f) => f.tool === finding.tool);
    if (!known) { out.push({ ...finding }); continue; }
    known.deviations = [...new Set([...known.deviations, ...finding.deviations])].sort();
    known.expected_digest = finding.expected_digest;
    known.installed_digests = [...new Set([...known.installed_digests, ...finding.installed_digests])].slice(0, MAX_DIGESTS);
    known.repaired = finding.repaired;
  }
  return out;
}

/** The findings of a check before a repair, each marked repaired when the check after it finds that tool intact. */
export function tamperFindings(before: HookPins, after: HookPins | null, at: number, intentRepaired = false): TamperFinding[] {
  const findings: TamperFinding[] = [];
  if (before.intent === "unreadable") {
    findings.push({ tool: "integration_intent", deviations: ["intent_unreadable"], expected_digest: null, installed_digests: [], first_seen_at: at, repaired: intentRepaired });
  }
  for (const pin of before.tools) {
    if (pin.state !== "tampered") continue;
    const now = after?.tools.find((t) => t.harness === pin.harness);
    findings.push({
      tool: pin.harness, deviations: pin.deviations, expected_digest: pin.expected_digest, installed_digests: pin.installed_digests,
      first_seen_at: at, repaired: !!now && now.state === "intact",
    });
  }
  return findings;
}
