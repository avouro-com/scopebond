// Managed tool settings: the lists a workspace keeps in the user-level settings of the AI coding tools on this computer.
//
// A rules document may carry a `tool_settings` section (the hook's managed.ts): for each tool, permission rules to allow and
// to deny, and MCP servers it may or may not start. The section is signed on its own with the workspace key that signs the
// rules, and checked here with the hook's own verifier (`checkToolSettingsSignature`): a section that is not signed by a key
// this release trusts is never applied, in any mode, and is reported as `refused: unsigned`.
//
// Where each list goes, only where the tool documents a user-level setting for it:
//   Claude Code  ~/.claude/settings.json      permissions.allow, permissions.deny, allowedMcpServers and deniedMcpServers
//                                              ({ "serverName": <name> } entries)
//   Cursor CLI   ~/.cursor/cli-config.json    permissions.allow, permissions.deny; a denied MCP server is the deny entry
//                                              `Mcp(<name>:*)`. Cursor documents no list of permitted MCP servers.
//   Codex, GitHub Copilot                     no list is applied (reported `refused: unsupported`): Codex keeps its MCP servers
//                                              in TOML, which this agent does not rewrite, and documents no permission lists;
//                                              Copilot CLI takes its tool permissions as command-line flags only.
//
// How a file is changed: the entries the workspace sets are added to the lists in place, and entries Scopebond placed earlier
// that the workspace no longer sets are taken out; every other key and entry stays as it was. A file that does not parse, or
// whose lists are not lists, is never written (`refused: unparseable`). The first change keeps a copy of the file
// (`<file>.scopebond-backup`, the one the hook installer keeps; an existing backup is never replaced), and every write is a temp
// file renamed over the original. A file changed between reading and writing is left for the next cycle. Nothing is written
// when nothing changes.
//
// What is reported, per tool: `applied`; `drifted` with the names of the settings that no longer hold the workspace's entries
// (never their values); or `refused` and why. A drift is put back only when the section says `mode: "enforce"`; with
// `mode: "report"` it is reported and left alone. A new section is applied in both modes.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  MANAGED_DOC_FILE, backupHarnessConfig, checkToolSettingsSignature, inspectToolSettings, loadConnection, userHarnessFile, workspaceIdOf, writeAtomic,
  type PolicyKey, type ToolSettingsList, type ToolSettingsSection,
} from "@scopebond/hook";

export const TOOL_SETTINGS_STATE_FILE = "tool-settings.json";

export type ToolSettingsRefusal = "unsigned" | "bad_signature" | "invalid" | "unsupported" | "unparseable" | "not_installed" | "write_failed";
export interface HarnessReport {
  state: "applied" | "drifted" | "refused";
  /** The settings (for example `permissions.deny`) that no longer hold the workspace's entries. Names only, never values. */
  keys: string[];
  reason: ToolSettingsRefusal | null;
  /** When a drift was last put back (enforce mode), and which settings it touched. */
  restored_at: string | null;
  restored_keys: string[];
}
export interface ToolSettingsReport {
  v: 1;
  revision: number | null;
  settings_digest: string | null;
  mode: "enforce" | "report" | null;
  /** The section as a whole: applied (checked and signed; see each tool) or refused and why. */
  result: "applied" | "refused";
  reason: ToolSettingsRefusal | null;
  harnesses: Record<string, HarnessReport>;
  at: string;
}
interface ToolSettingsState {
  version: 1;
  report: ToolSettingsReport | null;
  /** The `issued_at` of the last section applied, and its workspace: an older one is a replay. */
  issued_at: string | null;
  workspace: string | null;
  /** Per tool: the digest of the section last applied there, and the entries Scopebond placed, by setting. */
  applied: Record<string, { digest: string; placed: Record<string, string[]> }>;
}
/** The UTF-8 byte-order mark Windows PowerShell 5.1 writes at the start of a file; JSON.parse refuses it. */
const BOM = String.fromCharCode(0xfeff);
const withoutBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);
const EMPTY_STATE: ToolSettingsState = { version: 1, report: null, issued_at: null, workspace: null, applied: {} };

/** A setting's place in a tool's file and how one list entry is written there. */
interface Placement { path: readonly string[]; entry: (value: string) => unknown }
interface Target { file: () => string; lists: Partial<Record<ToolSettingsList, Placement>> }
const asIs = (value: string): unknown => value;
const TARGETS: Record<string, Target> = {
  claude: {
    file: () => userHarnessFile("claude"),
    lists: {
      permissions_allow: { path: ["permissions", "allow"], entry: asIs },
      permissions_deny: { path: ["permissions", "deny"], entry: asIs },
      mcp_allowed: { path: ["allowedMcpServers"], entry: (name) => ({ serverName: name }) },
      mcp_denied: { path: ["deniedMcpServers"], entry: (name) => ({ serverName: name }) },
    },
  },
  cursor: {
    file: () => join(homedir(), ".cursor", "cli-config.json"),
    lists: {
      permissions_allow: { path: ["permissions", "allow"], entry: asIs },
      permissions_deny: { path: ["permissions", "deny"], entry: asIs },
      mcp_denied: { path: ["permissions", "deny"], entry: (name) => `Mcp(${name}:*)` },
    },
  },
};
/** The tools this agent applies settings to. */
export const TOOL_SETTINGS_SUPPORTED = Object.keys(TARGETS);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** One list entry as a comparable string (key order normalised for object entries). */
const keyOf = (value: unknown): string => JSON.stringify(isObject(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);

export function readToolSettingsState(dir: string): ToolSettingsState {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, TOOL_SETTINGS_STATE_FILE), "utf8")) as Partial<ToolSettingsState>;
    return { ...EMPTY_STATE, ...parsed, applied: isObject(parsed.applied) ? parsed.applied : {} };
  } catch { return { ...EMPTY_STATE, applied: {} }; }
}
function writeState(dir: string, state: ToolSettingsState): void {
  try { writeAtomic(join(dir, TOOL_SETTINGS_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`); } catch { /* reported again next cycle */ }
}

/** The report the agent sends with its next rules check (`x-scopebond-tool-settings`), or null when it has none. */
export function toolSettingsReport(dir: string): string | null {
  const report = readToolSettingsState(dir).report;
  return report ? JSON.stringify(report) : null;
}

const refusedHarness = (reason: ToolSettingsRefusal): HarnessReport => ({ state: "refused", keys: [], reason, restored_at: null, restored_keys: [] });

/** A tool's settings file, read for changing: its parsed object and its text, `{}` when there is none, or null when it cannot be
 *  read as a JSON object whose lists are lists (then it is never written). */
function readTarget(file: string, paths: (readonly string[])[]): { config: Record<string, unknown>; text: string | null } | null {
  let text: string | null;
  try { text = readFileSync(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") text = null; else return null; }
  let config: unknown = {};
  if (text !== null && withoutBom(text).trim() !== "") {
    try { config = JSON.parse(withoutBom(text)); } catch { return null; }
  }
  if (!isObject(config)) return null;
  for (const path of paths) {
    let at: unknown = config;
    for (const [i, key] of path.entries()) {
      if (!isObject(at)) return null;
      at = at[key];
      if (at === undefined) break;
      if (i < path.length - 1 ? !isObject(at) : !Array.isArray(at)) return null;
    }
  }
  return { config, text };
}

/** The list at `path`, created when `create` is set; undefined when it is not there. */
function listAt(config: Record<string, unknown>, path: readonly string[], create: boolean): unknown[] | undefined {
  let at = config;
  for (const key of path.slice(0, -1)) {
    if (!isObject(at[key])) { if (!create) return undefined; at[key] = {}; }
    at = at[key] as Record<string, unknown>;
  }
  const last = path[path.length - 1];
  if (!Array.isArray(at[last])) { if (!create) return undefined; at[last] = []; }
  return at[last] as unknown[];
}

/** The file's text with `config` in it, in the file's own indentation and line ending, and its byte-order mark if it had one. */
function render(config: Record<string, unknown>, text: string | null): string {
  const body = withoutBom(text ?? "");
  const indent = /\n([ \t]+)["}\]]/.exec(body)?.[1] ?? "  ";
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const json = JSON.stringify(config, null, indent).replace(/\n/g, eol);
  return `${text?.startsWith(BOM) ? BOM : ""}${json}${text === null || /\r?\n$/.test(body) ? eol : ""}`;
}

interface ApplyOptions {
  now?: Date;
  /** The keys to trust instead of the release's (tests). */
  keys?: PolicyKey[];
}

/** Apply one tool's lists. `settings` is undefined when the section no longer names the tool: what Scopebond placed is taken out. */
function applyHarness(harness: string, settings: Record<string, string[]> | undefined, section: ToolSettingsSection, state: ToolSettingsState, previous: HarnessReport | undefined, at: string): HarnessReport | null {
  const target = TARGETS[harness];
  if (!target) return refusedHarness("unsupported");
  const lists = Object.entries(settings ?? {});
  if (lists.some(([list, entries]) => entries.length > 0 && !target.lists[list as ToolSettingsList])) return refusedHarness("unsupported");
  const file = target.file();
  const before = state.applied[harness];
  // What the workspace wants in each setting, as entries and as comparable keys.
  const desired = new Map<string, { path: readonly string[]; values: unknown[] }>();
  for (const [list, entries] of lists) {
    const placement = target.lists[list as ToolSettingsList];
    if (!placement) continue;
    const name = placement.path.join(".");
    const slot = desired.get(name) ?? { path: placement.path, values: [] };
    for (const value of entries.map(placement.entry)) if (!slot.values.some((v) => keyOf(v) === keyOf(value))) slot.values.push(value);
    desired.set(name, slot);
  }
  const placedBefore = before?.placed ?? {};
  const paths = new Map<string, readonly string[]>([...desired].map(([name, d]) => [name, d.path]));
  for (const name of Object.keys(placedBefore)) if (!paths.has(name)) paths.set(name, name.split("."));
  if (paths.size === 0 && !before) return null;
  if (!existsSync(dirname(file))) return settings ? refusedHarness("not_installed") : null;
  const read = readTarget(file, [...paths.values()]);
  if (!read) return refusedHarness("unparseable");

  // What is missing (the workspace's entries not in the file) and what is stale (entries Scopebond placed that it no longer sets).
  const missingIn: string[] = [];
  let staleAny = false;
  for (const [name, path] of paths) {
    const current = (listAt(read.config, path, false) ?? []).map(keyOf);
    const want = (desired.get(name)?.values ?? []).map(keyOf);
    if (want.some((k) => !current.includes(k))) missingIn.push(name);
    if ((placedBefore[name] ?? []).some((k) => !want.includes(k) && current.includes(k))) staleAny = true;
  }
  const isNew = before?.digest !== section.settings_digest;
  const drifted = !isNew && missingIn.length > 0;
  const keep = { restored_at: previous?.restored_at ?? null, restored_keys: previous?.restored_keys ?? [] };
  if (!isNew && drifted && section.mode !== "enforce") return { state: "drifted", keys: missingIn.sort(), reason: null, ...keep };

  if (missingIn.length > 0 || staleAny) {
    for (const [name, path] of paths) {
      const want = desired.get(name)?.values ?? [];
      const wantKeys = want.map(keyOf);
      const stale = new Set((placedBefore[name] ?? []).filter((k) => !wantKeys.includes(k)));
      const list = listAt(read.config, path, want.length > 0);
      if (!list) continue;
      const kept = list.filter((v) => !stale.has(keyOf(v)));
      for (const value of want) if (!kept.some((v) => keyOf(v) === keyOf(value))) kept.push(value);
      list.splice(0, list.length, ...kept);
    }
    // Only the file as it was read is replaced: a change made since then is read again next cycle.
    let now: string | null;
    try { now = readFileSync(file, "utf8"); } catch { now = null; }
    if (now !== read.text) return previous ?? null;
    try {
      if (read.text !== null) backupHarnessConfig(file);
      writeAtomic(file, render(read.config, read.text));
    } catch { return refusedHarness("write_failed"); }
  }
  if (settings) {
    state.applied[harness] = { digest: section.settings_digest, placed: Object.fromEntries([...desired].map(([name, d]) => [name, d.values.map(keyOf)])) };
  } else {
    delete state.applied[harness];
    return null;
  }
  return drifted ? { state: "applied", keys: [], reason: null, restored_at: at, restored_keys: missingIn.sort() } : { state: "applied", keys: [], reason: null, ...keep };
}

/** Apply the tool settings in the workspace document in force, once. Returns the report, or null when the document carries no
 *  tool settings (then nothing is changed and nothing is reported). Never throws. */
export function applyToolSettings(dir: string, options: ApplyOptions = {}): ToolSettingsReport | null {
  try {
    let doc: Record<string, unknown>;
    try { doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as Record<string, unknown>; } catch { return null; }
    const raw = doc.tool_settings;
    if (raw === undefined) return null;
    const now = options.now ?? new Date();
    const at = now.toISOString();
    const state = readToolSettingsState(dir);
    const named = isObject(raw) && isObject(raw.harnesses) ? Object.keys(raw.harnesses).slice(0, 16) : [];
    const refuse = (reason: ToolSettingsRefusal, section: Partial<ToolSettingsSection> = {}): ToolSettingsReport => {
      const report: ToolSettingsReport = {
        v: 1, revision: Number.isInteger(section.revision) ? section.revision! : null,
        settings_digest: typeof section.settings_digest === "string" && /^[0-9a-f]{64}$/.test(section.settings_digest) ? section.settings_digest : null,
        mode: section.mode === "enforce" || section.mode === "report" ? section.mode : null,
        result: "refused", reason, harnesses: Object.fromEntries(named.filter((h) => /^[a-z0-9_-]{1,32}$/.test(h)).map((h) => [h, refusedHarness(reason)])), at,
      };
      writeState(dir, { ...state, report });
      return report;
    };
    const inspected = inspectToolSettings(raw);
    if (!inspected.ok) return refuse(inspected.reason === "unsupported" ? "unsupported" : "invalid", isObject(raw) ? raw : {});
    const section = inspected.settings;
    const connection = loadConnection(dir);
    if (!connection) return null;
    const workspace = workspaceIdOf(connection);
    const computer = (connection as { installation_id?: string }).installation_id ?? connection.gateway_id;
    const check = checkToolSettingsSignature(section as unknown as Record<string, unknown>, {
      workspace, computer, lastIssuedAt: state.workspace === workspace ? state.issued_at : null, keys: options.keys, now,
    });
    if (check.result !== "verified") {
      // Not signed, or signed by no key this release trusts: nothing is applied.
      const unsigned = check.result === "unsigned" || check.reason === "unknown_key" || check.reason === "key_not_valid";
      return refuse(unsigned ? "unsigned" : "bad_signature", section);
    }
    const harnesses: Record<string, HarnessReport> = {};
    const names = new Set([...Object.keys(section.harnesses), ...Object.keys(state.applied)]);
    for (const harness of names) {
      const settings = (section.harnesses as Record<string, Record<string, string[]> | undefined>)[harness];
      const result = applyHarness(harness, settings, section, state, state.report?.harnesses[harness], at);
      if (result) harnesses[harness] = result;
    }
    const report: ToolSettingsReport = { v: 1, revision: section.revision, settings_digest: section.settings_digest, mode: section.mode, result: "applied", reason: null, harnesses, at };
    writeState(dir, { ...state, report, issued_at: check.issuedAt, workspace });
    return report;
  } catch { return null; }
}
