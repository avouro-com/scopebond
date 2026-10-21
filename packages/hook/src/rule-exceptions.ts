// Exceptions a workspace names for a rule (sent only to a hook that reports `exceptions_any_rule`): structured, one kind per
// rule, applied in Monitor as in Block, so an excepted action matches nothing and is routine.
//
//   destructive-shell   programs, and the folders outside the working folder a delete by one of them may reach (`targets`)
//   production-deploy   environment names, exactly as the deploy names them
//   cloud-destructive   Kubernetes contexts and Terraform workspaces (a name, or a pattern with `*` and some text)
//   database-migrate    database addresses on this computer (localhost, 127.0.0.1, ::1), without credentials
//   network-egress      sites, as the allowed sites are written
//
// The rules this module keeps:
//   - An exception never reaches further than its fields name: each becomes a set of anchored bounds on the action's own
//     parameters (`exceptions` on the rule's clause, which the verifier reads), and an action that does not carry a field never
//     meets it. A program that deletes needs folders; a folder is full (`/…`, `C:/…`, `~/…`), starts with a plain name, keeps
//     `**` for its end, and never names a protected place, so no exception reaches the home folder or a drive as a whole.
//   - The always-on rules take none (managed.ts), and the part of destructive-shell that refuses a program only known when it
//     runs is never excepted: an exception names programs, and that program has no name.

import { ci } from "./runtime.js";
import { DELETE_PROGRAMS, namesProtectedPlace } from "./delete-scope.js";

export const EXCEPTIONS_CAPABILITY = "exceptions_any_rule";

/** The fields each rule's exceptions take. A rule not named here takes none. */
export const EXCEPTION_FIELDS: Readonly<Record<string, readonly ExceptionField[]>> = {
  "destructive-shell": ["programs", "targets"],
  "production-deploy": ["environments"],
  "cloud-destructive": ["kube_contexts", "terraform_workspaces"],
  "database-migrate": ["database_urls"],
  "network-egress": ["hosts"],
};
export type ExceptionField = "programs" | "targets" | "environments" | "kube_contexts" | "terraform_workspaces" | "database_urls" | "hosts";
/** One exception: lists of the rule's own fields. */
export type RuleException = Partial<Record<ExceptionField, string[]>>;
/** The most exceptions one rule takes, and the most values one list holds. */
export const MAX_EXCEPTIONS = 50;
const MAX_VALUES = 20;

/** The bounds one exception becomes, on the parameters the rule's clause judges (the verifier's `exceptions`). */
export type ExceptionBounds = Record<string, { pattern: string } | { items: { pattern: string }; match: "all" }>;

const PROGRAM = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,99}$/;
const NAME_PATTERN = /^[A-Za-z0-9._:@/+*-]{1,200}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: each label ends at its own dot (not in the label classes), and the lookahead bounds the input to 253 characters
const HOST = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FOLDER_CHARS = /^[A-Za-z0-9._@+~ /*:-]{1,300}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const escapeRegex = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");

/** A folder an exception names, split into where it starts (`/`, `c:/` or `~/`) and its segments; null when it is not one. */
function folderParts(glob: string): { prefix: string; segs: string[] } | null {
  if (!FOLDER_CHARS.test(glob)) return null;
  const drive = /^([A-Za-z]):\//.exec(glob);
  const prefix = glob.startsWith("~/") ? "~/" : drive ? `${drive[1].toLowerCase()}:/` : glob.startsWith("/") ? "/" : null;
  if (prefix === null) return null;
  const segs = glob.slice(prefix.length).split("/");
  // Plain segments only: no empty, "." or ".." one, and a colon only in the drive.
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.includes(":") || s.includes("~"))) return null;
  // It starts with a plain name, and `**` is a whole last segment: never the whole home folder, disk or drive.
  if (segs[0].includes("*")) return null;
  if (segs.some((s, i) => s.includes("**") && (s !== "**" || i !== segs.length - 1))) return null;
  // One `*` in a segment at most, so the pattern it becomes stays linear.
  if (segs.some((s) => s !== "**" && s.split("*").length > 2)) return null;
  if (namesProtectedPlace(segs.filter((s) => !s.includes("*")))) return null;
  return { prefix, segs };
}

/** A folder as an anchored pattern on a delete's targets (delete-scope.ts `targets`): `*` within one segment, a last `**`
 *  anything below. */
function folderPattern(glob: string): string {
  const { prefix, segs } = folderParts(glob)!;
  return escapeRegex(prefix) + segs.map((s) => (s === "**" ? ".+" : s.split("*").map(escapeRegex).join("[^/]*"))).join("/");
}

/** A database address on this computer, without credentials, a query or a fragment, as `scheme://host[:port]/path`. */
export function localDatabaseUrl(text: string): string | null {
  if (text.length > 300) return null;
  let u: URL;
  try { u = new URL(text); } catch { return null; }
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || !LOOPBACK.has(u.hostname.toLowerCase())) return null;
  return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ""}${u.pathname === "/" ? "" : u.pathname}`;
}

/** A context or workspace name: exact, or with `*` standing for any text (twice at most), as long as some text is named. */
const validNamePattern = (v: string): boolean => NAME_PATTERN.test(v) && v.replace(/\*/g, "") !== "" && v.split("*").length <= 3;
const namePattern = (values: readonly string[]): string => `^(?:${values.map((v) => v.split("*").map(escapeRegex).join(".*")).join("|")})$`;
const exactPattern = (values: readonly string[]): string => `^(?:${values.map(escapeRegex).join("|")})$`;

const VALID: Record<ExceptionField, (v: string) => boolean> = {
  programs: (v) => PROGRAM.test(v),
  targets: (v) => folderParts(v) !== null,
  environments: (v) => ENVIRONMENT.test(v),
  kube_contexts: validNamePattern,
  terraform_workspaces: validNamePattern,
  database_urls: (v) => localDatabaseUrl(v) !== null,
  hosts: (v) => HOST.test(v),
};

/** Whether `value` is a valid exception list for `ruleId`. A rule that takes no exceptions accepts none. Pure. */
export function validRuleExceptions(ruleId: string, value: unknown): value is RuleException[] {
  const fields = EXCEPTION_FIELDS[ruleId];
  if (!fields || !Array.isArray(value) || value.length < 1 || value.length > MAX_EXCEPTIONS) return false;
  return value.every((e) => {
    if (typeof e !== "object" || e === null || Array.isArray(e)) return false;
    const entries = Object.entries(e as Record<string, unknown>);
    if (entries.length === 0 || !entries.every(([k]) => (fields as readonly string[]).includes(k))) return false;
    for (const [k, list] of entries) {
      if (!Array.isArray(list) || list.length < 1 || list.length > MAX_VALUES) return false;
      if (!list.every((v) => typeof v === "string" && VALID[k as ExceptionField](v))) return false;
    }
    const ex = e as RuleException;
    // A program names what runs; a program that deletes also names the folders it may delete in.
    if (ruleId === "destructive-shell") return !!ex.programs && (!ex.programs.some((p) => DELETE_PROGRAMS.has(p)) || !!ex.targets);
    return true;
  });
}

/** The bounds destructive-shell's exceptions put on a shell command: its program as safe-shell judges it (`program_scope`, in
 *  any case, with or without an executable suffix, and its destructive forms: `crontab` covers `crontab/remove-all`), and
 *  every target a delete reaches outside the working folder. */
export function shellExceptionBounds(list: readonly RuleException[]): ExceptionBounds[] {
  return list.filter((e) => e.programs?.length).map((e) => ({
    program_scope: { pattern: `^(?:${e.programs!.map((p) => ci(escapeRegex(p))).join("|")})(?:${ci("\\.(?:exe|cmd|bat|com|ps1)")})?(?:/(?:remove-all|system))?$` },
    ...(e.targets?.length ? { delete_targets: { items: { pattern: `^(?:${e.targets.map(folderPattern).join("|")})$` }, match: "all" as const } } : {}),
  }));
}

/** The bounds a target rule's exceptions put on the actions the rule packs derive: `environment` (deploys), `context`
 *  (Kubernetes), `workspace` (Terraform), `database` (migrations). Each list is its own exception. */
export function packExceptionBounds(list: readonly RuleException[]): ExceptionBounds[] {
  const out: ExceptionBounds[] = [];
  for (const e of list) {
    if (e.environments?.length) out.push({ environment: { pattern: exactPattern(e.environments) } });
    if (e.kube_contexts?.length) out.push({ context: { pattern: namePattern(e.kube_contexts) } });
    if (e.terraform_workspaces?.length) out.push({ workspace: { pattern: namePattern(e.terraform_workspaces) } });
    if (e.database_urls?.length) out.push({ database: { pattern: exactPattern(e.database_urls.map((u) => localDatabaseUrl(u)!)) } });
  }
  return out;
}

/** The sites network-egress's exceptions add to its allowed sites. */
export const exceptionHosts = (list: readonly RuleException[] | undefined): string[] => (list ?? []).flatMap((e) => e.hosts ?? []);
