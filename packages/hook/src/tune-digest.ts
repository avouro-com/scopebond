// The block digest of a blocked action, and the workspace's quiet list.
//
// A connected workspace may keep some blocks quiet: the action is still blocked, but nobody is asked about it and the tray
// shows no notification, only a row in its list of blocks. The workspace names those blocks by their block digest, a plain
// sha256 over six fields every record already carries, in this order:
//
//   [action type, workspace rule, program, target class, environment, host]
//
// - the action type, at most 64 characters;
// - the workspace rule the clause that denied it carries (rule-titles.ts `ruleOfClause`); a block whose clause names no
//   workspace rule, or that a session budget decided, has no digest;
// - the program (or package manager) in its canonical form: the file name, lower case, without .exe/.cmd/.bat/.com/.ps1;
// - the class of the action's path: inside the repository, build output, temp, home, system, remote or unknown, never the
//   path itself. A deleting or writing shell command names its paths in `targets`: the class they all share, or unknown when
//   they are of more than one class (a record from before `targets` has none, and keeps the digest it had);
// - the environment it names, lower case, and the host, lower case without port.
//
// It is computed here from the signed record's own intent, exactly as the workspace computes it from the same record, so the
// two agree (test/fixtures/tune-digest-vectors.json holds the shared vectors). The digest never leaves this computer, and it
// only chooses how a block is shown: it never turns a block into an allow, and it never touches Scopebond's own protection.
//
// The quiet list arrives as `quiet_patterns` in the workspace's rules document (sent only to a hook that reports the
// `quiet_patterns` capability), signed with the document's grants (policy-signature.ts). An entry that is not a 64-character
// lowercase hex digest is skipped.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANAGED_DOC_FILE } from "./managed.js";
import { ruleOfClause } from "./rule-titles.js";

export const QUIET_PATTERNS_CAPABILITY = "quiet_patterns";
/** The most entries read from a document's quiet list. */
export const MAX_QUIET_PATTERNS = 5_000;

export const TARGET_CLASSES = ["repository", "build_output", "temp", "home", "system", "remote", "unknown"] as const;
export type TargetClass = (typeof TARGET_CLASSES)[number];

/** Every part of a digest, as hashed. */
export interface TuneDigestParts {
  action_type: string;
  rule: string;
  program: string | null;
  target_class: TargetClass;
  environment: string | null;
  host: string | null;
}

/** Scopebond's own protection: always on, never quiet. */
const ALWAYS_ON_CLAUSES: ReadonlySet<string> = new Set(["protect-scopebond-read", "protect-scopebond-write"]);

const BUILD_SEGMENTS = new Set(["node_modules", "dist", "build", "out", ".next", "coverage", "target", ".turbo", ".cache"]);
const TEMP_SEGMENTS = new Set(["tmp", "temp"]);
// Every spelling of the temp folder's variable the delete rule knows (delete-scope.ts), in lower case.
const TEMP_ROOTS = new Set(["$env:temp", "$env:tmp", "${env:temp}", "${env:tmp}", "%temp%", "%tmp%", "$tmpdir", "${tmpdir}", "$temp", "${temp}", "$tmp", "${tmp}"]);
const HOME_ROOTS = new Set(["~", "$home", "${home}", "$env:userprofile", "%userprofile%", "%homepath%"]);
const SYSTEM_ROOTS = new Set(["etc", "usr", "bin", "sbin", "boot", "lib", "lib64", "opt", "sys", "proc", "dev", "var", "system", "library", "windows", "program files", "program files (x86)", "programdata"]);
const PROGRAM_SUFFIXES = [".exe", ".cmd", ".bat", ".com", ".ps1"];
const PROGRAM = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_PATH = 4096;
const MAX_ENVIRONMENT = 100;
/** The most targets read from a record: one that names more has no single class of place. */
const MAX_TARGETS = 64;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const normPath = (s: string): string => s.split("\\").join("/").toLowerCase();
const segments = (path: string): string[] => normPath(path).split("/").filter((s) => s.length > 0 && s !== ".");
const alnum = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
/** 1 to 253 characters of a-z, 0-9, "." and "-", starting and ending with a letter or digit (a loop, not a pattern). */
function plainHost(host: string): boolean {
  if (host.length < 1 || host.length > 253 || !alnum(host[0]) || !alnum(host[host.length - 1])) return false;
  for (const c of host) if (!alnum(c) && c !== "." && c !== "-") return false;
  return true;
}

/** A program's canonical name (its file name, lower case, without a Windows program suffix), or undefined when it is not a
 *  plain program name. Pure. */
export function canonicalProgram(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  let program = segments(raw).at(-1) ?? "";
  for (const suffix of PROGRAM_SUFFIXES) if (program.endsWith(suffix)) { program = program.slice(0, -suffix.length); break; }
  return PROGRAM.test(program) ? program : undefined;
}

/** A host in lower case without port, or undefined when it is not a plain host name (credentials, a path, a query). Pure. */
export function canonicalHost(value: unknown): string | undefined {
  let host = str(value)?.toLowerCase();
  if (!host || host.includes("@") || host.includes("/") || host.includes("?") || host.includes("#")) return undefined;
  const colon = host.lastIndexOf(":");
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(host.slice(colon + 1))) return undefined; // not a port
    host = host.slice(0, colon);
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return plainHost(host) && !host.includes("..") ? host : undefined;
}

/** The class of a path. `rootScope` is the hook's own inside/outside answer for a file action, where it set one. A folder
 *  named like build output or temp is that class only inside the working folder: under the home folder or a system folder
 *  the path is home or system (`~/dist` is home, `/etc/x/tmp` is system). Pure. */
export function targetClassOf(path: string | undefined, rootScope?: unknown): TargetClass {
  if (!path || path.length > MAX_PATH || path.includes("\0")) return rootScope === "inside" ? "repository" : "unknown";
  const p = normPath(path.trim());
  // A URL or an scp-style remote (host:path) names something on another machine.
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(p) || /^[^/\s:@]+@[^/\s:]+:/.test(p)) return "remote";
  const segs = segments(p);
  // A path that climbs (`dist/../../etc`) may land anywhere: never build output, temp or home because of what it climbs from.
  if (segs.includes("..")) return rootScope === "inside" ? "repository" : "unknown";
  const first = segs[0] ?? "";
  const drive = /^[a-z]:$/.test(first);
  const rest = drive ? segs.slice(1) : segs;
  const absolute = p.startsWith("/") || drive;
  // What follows the home folder (`~/x`, or an account folder under `home` or `Users`), or null when the path is not under it.
  const underHome = HOME_ROOTS.has(first) ? segs.slice(1) : absolute && (rest[0] === "home" || rest[0] === "users") && rest.length >= 2 ? rest.slice(2) : null;
  // The temp folder: by its variable, the system's (`/tmp`, `/var/tmp`, `C:/Windows/Temp`) or the account's (`AppData/Local/Temp`).
  if (TEMP_ROOTS.has(first)) return "temp";
  if (absolute && (rest[0] === "tmp" || (rest[0] === "var" && rest[1] === "tmp") || (rest[0] === "windows" && rest[1] === "temp"))) return "temp";
  if (underHome && underHome[0] === "appdata" && underHome[1] === "local" && underHome[2] === "temp") return "temp";
  if (p === "/" || (drive && rest.length === 0)) return "system";
  if (rootScope !== "inside") {
    if (underHome) return "home";
    if (absolute && SYSTEM_ROOTS.has(rest[0] ?? "")) return "system";
    if (absolute || rootScope === "outside" || first.startsWith("$") || first.startsWith("%")) return "unknown";
  }
  // Inside the working folder: its temp and build output folders by name, else the repository.
  if (segs.some((s) => TEMP_SEGMENTS.has(s))) return "temp";
  if (segs.some((s) => BUILD_SEGMENTS.has(s))) return "build_output";
  return "repository";
}

/** The class of the place an action reaches: its own path or target, else the one class every path in its `targets` shares
 *  (a deleting or writing shell command names its targets there). Targets of more than one class, or more than MAX_TARGETS
 *  of them, have none: unknown. Entries that are not paths are skipped. */
function targetClassOfParams(params: Record<string, unknown>): TargetClass {
  const direct = str(params.path) ?? str(params.target);
  if (direct) return targetClassOf(direct, params.root_scope);
  const targets: unknown[] = Array.isArray(params.targets) ? params.targets : [];
  if (targets.length > MAX_TARGETS) return "unknown";
  const classes = new Set(targets.filter((t): t is string => typeof t === "string" && t.length > 0).map((t) => targetClassOf(t, params.root_scope)));
  if (classes.size === 0) return targetClassOf(undefined, params.root_scope);
  return classes.size === 1 ? [...classes][0] : "unknown";
}

function environmentOf(params: Record<string, unknown>): string | null {
  const value = str(params.environment) ?? str(params.env) ?? str(params.context) ?? str(params.workspace);
  if (!value) return null;
  const v = value.trim().toLowerCase();
  return v && v.length <= MAX_ENVIRONMENT ? v : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The parts of an action's digest for the workspace rule that blocked it. Pure. */
export function tuneDigestParts(intent: { action_type: string; params?: unknown }, rule: string): TuneDigestParts {
  const p = isObject(intent.params) ? intent.params : {};
  return {
    action_type: intent.action_type.slice(0, 64),
    rule,
    program: canonicalProgram(p.program) ?? canonicalProgram(p.manager) ?? null,
    target_class: targetClassOfParams(p),
    environment: environmentOf(p),
    host: canonicalHost(p.host) ?? null,
  };
}

/** The digest: sha256 hex of the parts in their fixed order. Pure. */
export function tuneDigest(parts: TuneDigestParts): string {
  return createHash("sha256").update(JSON.stringify([parts.action_type, parts.rule, parts.program, parts.target_class, parts.environment, parts.host])).digest("hex");
}

/** A session budget decided it (refused while unknown, or over its limit): a budget is never a rule's block. */
function budgetDecided(payload: Record<string, unknown>): boolean {
  const budget = payload.budget;
  return isObject(budget) && (budget.state === "over" || budget.state === "unavailable");
}

/** The digest of a blocked record, from its signed payload: its intent and the clause that denied it. Null when it was not
 *  denied, names no clause or a clause that carries no workspace rule, or a session budget decided it. Pure. */
export function tuneDigestOfReceipt(receipt: unknown): string | null {
  const payload = isObject(receipt) && isObject(receipt.payload) ? receipt.payload : null;
  if (!payload || payload.realtime_result !== "deny" || budgetDecided(payload)) return null;
  const intent = payload.intent;
  if (!isObject(intent) || typeof intent.action_type !== "string") return null;
  const rule = ruleOfClause(typeof payload.clause_id === "string" ? payload.clause_id : null);
  return rule ? tuneDigest(tuneDigestParts({ action_type: intent.action_type, params: intent.params }, rule)) : null;
}

/** The well-formed entries of a document's quiet list (none when it has none). Pure. */
export function quietPatternsOf(doc: { quiet_patterns?: unknown } | null | undefined): Set<string> {
  const raw = doc?.quiet_patterns;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.slice(0, MAX_QUIET_PATTERNS).filter((d): d is string => typeof d === "string" && HEX64.test(d)));
}

/** Whether the workspace keeps this block quiet: the clause that denied it is not Scopebond's own protection and the action's
 *  digest is on the quiet list. Pure. */
export function quietByWorkspace(quiet: ReadonlySet<string>, intent: { action_type?: unknown; params?: unknown }, clause: string | null | undefined): boolean {
  if (quiet.size === 0 || !clause || ALWAYS_ON_CLAUSES.has(clause) || typeof intent.action_type !== "string") return false;
  const rule = ruleOfClause(clause);
  return !!rule && quiet.has(tuneDigest(tuneDigestParts({ action_type: intent.action_type, params: intent.params }, rule)));
}

/** Whether the workspace keeps a blocked record quiet, by the rules document in `dir`. False with no document, no list, or a
 *  record that is not a quiet block. Never throws. */
export function quietBlock(dir: string, receipt: unknown): boolean {
  try {
    const payload = isObject(receipt) && isObject(receipt.payload) ? receipt.payload : null;
    const clause = typeof payload?.clause_id === "string" ? payload.clause_id : null;
    if (!payload || !clause || ALWAYS_ON_CLAUSES.has(clause)) return false;
    const digest = tuneDigestOfReceipt(receipt);
    if (!digest) return false;
    return quietPatternsOf(JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as { quiet_patterns?: unknown }).has(digest);
  } catch { return false; }
}
