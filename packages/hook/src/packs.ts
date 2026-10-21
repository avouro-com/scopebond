// The rule-pack interpreter: what a command line or an MCP tool call does, read through the grammars and MCP profiles of
// the signed rule packs in force (pack-store.ts loads and verifies them; the format is @scopebond/policy-schema's
// `scopebond:pack/v1`).
//
// The rules this interpreter keeps:
//   - Packs are data, never code. Every operator is one of the closed set the format defines; nothing in a pack is run.
//   - Deterministic: the same command, the same packs and the same local facts give the same actions, with no model, no
//     network and no clock. A pack reads local files or the environment only through a probe: the mapper passes this
//     computer's (the files relative to the folder the command runs in); a pack's own vectors run with none, so there those
//     facts are unknown (left out), never guessed, and a vector derives the same on every computer.
//   - Bounded: only the subcommand paths a grammar lists are read. A help, version or dry run (`--help`, `-h` alone, a `help`
//     first word, `--version` with no operand, `--dry-run`, and whatever the grammar's `skip` adds) derives nothing.
//     A command a grammar does not match derives nothing, unless an option the grammar does not know stopped it reading
//     and one of its `fallback` conditions holds: then the fallback's actions are derived, with every name left out, so an
//     option placed before the subcommand cannot move a command out of a rule's reach.
//   - No content: a pack computes identifiers, closed values and keyed digests. Parameter values a pack computes are what it
//     says; the engine adds `via` and `derived_from` to every action.
//
// The engine carries no vendor knowledge of its own: what a vendor's command-line tool or MCP server does is read only through
// the packs in force. With no pack in force, or a pack that is missing, bad or expired, only the open detection (shell, git,
// files, fetches, package installs, databases through psql and sqlite3) and the starter protections apply. Among packs, the
// one whose id sorts first and derives anything wins. For an MCP call, the first profile whose words name the server owns it
// (derivePackMcp). A pack's rules join the policy in force (pack-rules.ts).

import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { comparePackVersions, packRef, type Pack, type PackEmit, type PackGrammar, type PackProfile, type PathWord } from "@scopebond/policy-schema/pack";
import { canonProgram, decomposeShell, isDescribeOption, type SimpleCommand } from "./shell.js";
import { digest, scrubParam } from "./minimize.js";
import { classifySql } from "./sql-classify.js";
import { launched } from "./launchers.js";
import type { FileProbe } from "./typed-infra.js";

export interface PackAction { action_type: string; params: Record<string, unknown> }

/** What a grammar may consult beyond the command line: the environment and local files, relative to `cwd`. */
export interface PackProbe { env?: (name: string) => string | undefined; files?: FileProbe; cwd?: string }

type Value = string | number | boolean | string[] | undefined;
type Node = Record<string, unknown>;

const SUBST = "__sb_subst";
const EMPTY: ReadonlySet<string> = new Set();
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
/** Every word a pattern runs on is cut to this length first. */
const MATCH_LIMIT = 512;
const MAX_ITEMS = 100;
const MAX_ACTIONS = 64;

// ---- shared readers (one meaning of an option, a value and a word for every grammar) ----------------------------------------

/** A value fit to record as an identifier: a plain name the scrubber leaves alone, never an unexpanded variable. */
function ident(value: string | undefined): string | undefined {
  if (value === undefined || value.includes(SUBST) || !IDENT.test(value)) return undefined;
  return scrubParam(value) === value ? value : undefined;
}
/** A value fit to digest: anything the command names literally (an unexpanded variable is not a name). */
const literal = (value: string | undefined): string | undefined =>
  value !== undefined && value !== "" && !value.includes(SUBST) && !value.includes("$") ? value : undefined;

/** A keyed digest of a named resource, as every derived action carries it. The parts are joined canonically. */
export const packDigest = (...parts: string[]): string => digest(["scopebond:target/v1", ...parts]);

/** The environment a name's words say (`myapp-prod`, `envs/staging`, `dev.tfvars`); undefined when none, or two. */
export function envOfName(name: string | undefined): "production" | "staging" | "development" | undefined {
  if (!name || name.includes(SUBST)) return undefined;
  const found = new Set<"production" | "staging" | "development">();
  for (const word of name.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word === "prod" || word === "production" || word === "prd" || word === "live") found.add("production");
    else if (word === "staging" || word === "stage" || word === "stg" || word === "preprod" || word === "uat") found.add("staging");
    else if (word === "dev" || word === "development" || word === "test" || word === "testing" || word === "qa" || word === "sandbox" || word === "local") found.add("development");
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/** The environment class an environment's exact name says; `unknown` when it says none. */
function envClass(env: string | undefined): string {
  const e = (env ?? "").toLowerCase();
  if (/^(?:prod|production|live)$/.test(e)) return "production";
  if (/^(?:stage|staging|preprod|uat)$/.test(e)) return "staging";
  if (/^(?:dev|development|test|testing|preview|local)$/.test(e)) return "development";
  return "unknown";
}

const clip = (s: string): string => (s.length > MATCH_LIMIT ? s.slice(0, MATCH_LIMIT) : s);
const regexCache = new Map<string, RegExp>();
function re(pattern: string): RegExp {
  let r = regexCache.get(pattern);
  // eslint-disable-next-line security/detect-non-literal-regexp -- a pattern from a signed pack, checked by validatePack (bounded, no nested repeats); every input is cut to MATCH_LIMIT first
  if (!r) { r = new RegExp(pattern); if (regexCache.size < 2000) regexCache.set(pattern, r); }
  return r;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
}

function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') { let j = i + 1; while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1; out += text.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (c === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e < 0 ? text.length : e + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** A top-level string value of a JSON, JSONC or TOML file. */
function configValue(text: string, file: string, key: string): string | undefined {
  try {
    if (/\.toml$/i.test(file)) {
      const top = text.split(/^[^\S\n\r\u2028\u2029]*\[/m)[0];
      for (const line of top.split(/\r?\n/)) {
        const eq = line.indexOf("=");
        if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
        // eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the quoted run cannot hold a quote, and the comment is one tail
        const m = /^\s*"([^"\n]*)"\s*(?:#.*)?$/.exec(line.slice(eq + 1));
        return m ? m[1] : undefined;
      }
      return undefined;
    }
    const json = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
    const v = json && typeof json === "object" ? json[key] : undefined;
    return typeof v === "string" ? v : undefined;
  } catch { return undefined; }
}

// ---- reading a command line through a grammar -----------------------------------------------------------------------------

interface Reading {
  tool: string;
  argv: string[];
  /** Positionals before `--`, after the grammar's leading words are stripped. */
  pos: string[];
  /** How many of `pos` were read before an option the grammar does not know. */
  certain: number;
  /** How many of `pos` a command's path may match: `certain`, or fewer under the grammar's `path_options`. */
  pathCertain: number;
  /** Every option seen, by name, with each value it was given (`true` for a switch). */
  flags: Map<string, Array<string | true>>;
  /** An option the grammar does not know was seen. */
  uncertain: boolean;
  /** The grammar says to stop at an unknown option, and one was seen. */
  stopped: boolean;
}

function readArgs(grammar: PackGrammar, argv: readonly string[]): Reading & { skipped: boolean } {
  const valuedOptions: ReadonlySet<string> = new Set(grammar.options?.valued ?? []);
  const knownOptions: ReadonlySet<string> = new Set([...valuedOptions, ...(grammar.options?.flags ?? [])]);
  const skip = new Set(grammar.skip?.options ?? []);
  const pos: string[] = [];
  const flags = new Map<string, Array<string | true>>();
  let certain = -1;
  let pathEnd = -1;
  let uncertain = false;
  let stopped = false;
  let skipped = false;
  // Whatever the grammar lists, help (`--help`, `-h` alone, a `help` first word), a version (`--version` with no operand) and
  // a dry run (`--dry-run`) derive nothing. A word an unknown option before it may take as its value is not one of them.
  let mayBeValue = false;
  let versionAsked = false;
  if (argv.length === 1 && argv[0] === "-h") skipped = true;
  const put = (name: string, value: string | true): void => { const list = flags.get(name) ?? []; list.push(value); flags.set(name, list); };
  for (let i = 0; i < argv.length; i++) {
    let t = argv[i];
    const afterUnknown = mayBeValue;
    mayBeValue = false;
    // `--dry-run none` turns it off where the grammar reads `--dry-run` as taking a value.
    const off = argv[i] === "--dry-run" && valuedOptions.has(argv[i]) && /^(?:none|false)$/i.test(argv[i + 1] ?? "");
    if (!afterUnknown && !off && isDescribeOption(argv[i])) {
      if (argv[i] === "--version") versionAsked = true;
      else skipped = true;
    }
    if (t === "--") {
      // Some tools read the words after `--` as positionals too.
      if (grammar.double_dash === "positionals") pos.push(...argv.slice(i + 1));
      break;
    }
    if (t.length > 1 && t.startsWith("-") && !/^-\d/.test(t)) {
      if (grammar.single_dash_long && t.startsWith("--")) t = t.slice(1);
      const eq = t.indexOf("=");
      const name = eq > 0 ? t.slice(0, eq) : t;
      const isKnown = knownOptions.has(name) || (eq < 0 && !t.startsWith("--") && t.length > 2 && valuedOptions.has(t.slice(0, 2)));
      // Which options may stand before a command's path: `none`, or only `known` ones (an unknown one ends it, `=value` too).
      if (pathEnd < 0 && (grammar.path_options === "none" || (grammar.path_options === "known" && !isKnown))) pathEnd = pos.length;
      if (grammar.fallback_on_any_option) uncertain = true;
      // Under `path_options: none`, an option before the first positional is not read as one the grammar knows: it takes no
      // value, and the words after it are uncertain.
      const known = grammar.path_options === "none" && pos.length === 0 ? EMPTY : knownOptions;
      const valued = known === EMPTY ? EMPTY : valuedOptions;
      if (skip.has(name)) {
        const value = eq > 0 ? t.slice(eq + 1).toLowerCase() : "";
        if (value !== "none" && value !== "false") skipped = true;
      }
      if (eq > 0) {
        put(name, t.slice(eq + 1));
        if (!known.has(name)) {
          uncertain = true;
          if (grammar.unknown_options === "stop") stopped = true;
          // `strict_unknown`: an unknown option ends the certain positionals even when it carries its value.
          if (grammar.strict_unknown && certain < 0) certain = pos.length;
        }
        continue;
      }
      if (valued.has(t)) { put(t, argv[i + 1] ?? ""); i++; continue; }
      // An attached short value: `-nprod`.
      if (!t.startsWith("--") && t.length > 2 && valued.has(t.slice(0, 2))) { put(t.slice(0, 2), t.slice(2)); continue; }
      put(t, true);
      if (!known.has(t)) {
        mayBeValue = true;
        uncertain = true;
        if (grammar.unknown_options === "stop") stopped = true;
        if (certain < 0) certain = pos.length;
      }
      continue;
    }
    pos.push(t);
  }
  const strip = new Set(grammar.strip_words ?? []);
  let lead = 0;
  const certainAll = certain < 0 ? pos.length : certain;
  const pathAll = Math.min(certainAll, pathEnd < 0 ? pos.length : pathEnd);
  while (lead < pos.length && lead < pathAll && strip.has(pos[lead])) lead++;
  const words = pos.slice(lead);
  const certainCount = certainAll - lead;
  if (words[0] !== undefined && certainCount > 0 && (words[0] === "help" || (grammar.skip?.words ?? []).includes(words[0]))) skipped = true;
  if (versionAsked && pos.length === 0) skipped = true;
  return { tool: "", argv: [...argv], pos: words, certain: Math.max(0, certainCount), pathCertain: Math.max(0, pathAll - lead), flags, uncertain, stopped, skipped };
}

type Bindings = Map<string, string | string[]>;

/** Match a command's path against the leading certain positionals: the bindings and how many words it consumed. */
function matchPath(path: readonly PathWord[], words: readonly string[], certain: number): { bindings: Bindings; used: number } | null {
  const bindings: Bindings = new Map();
  const step = (p: number, w: number): number | null => {
    if (p === path.length) return w;
    const word = path[p];
    const take = (ok: boolean, value?: string): number | null => {
      if (!ok) return null;
      const varName = typeof word === "object" ? word.var : undefined;
      if (varName && value !== undefined) bindings.set(varName, value);
      const rest = step(p + 1, w + 1);
      if (rest === null && varName) bindings.delete(varName);
      return rest;
    };
    if (typeof word === "string") return w < certain ? take(words[w] === word) : null;
    if (word.optional !== undefined) {
      if (w < certain && words[w] === word.optional) { const r = take(true, words[w]); if (r !== null) return r; }
      return step(p + 1, w);
    }
    if (word.skip !== undefined) {
      for (let n = 0; n <= word.skip && w + n <= certain; n++) {
        if (word.var) bindings.set(word.var, words.slice(w, w + n));
        const r = step(p + 1, w + n);
        if (r !== null) return r;
      }
      if (word.var) bindings.delete(word.var);
      return null;
    }
    if (w >= certain) return null;
    const text = words[w];
    let ok = true;
    if (word.any !== undefined) ok = word.any.includes(text);
    if (ok && word.not !== undefined) ok = !word.not.includes(text);
    if (ok && word.pattern !== undefined) ok = re(word.pattern).test(clip(text));
    return take(ok, text);
  };
  const used = step(0, 0);
  return used === null ? null : { bindings, used };
}

interface Scope {
  kind: "shell" | "mcp";
  sc?: SimpleCommand;
  reading?: Reading;
  used?: number;
  bindings?: Bindings;
  item?: { text: string; groups: string[] };
  mcp?: { server: string; tool: string; args: Node };
  probe: PackProbe;
}

const isDefined = (v: Value): boolean => v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0);
const asString = (v: Value): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const asList = (v: Value): string[] => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);

function flagValues(s: Scope, names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) for (const v of s.reading?.flags.get(name) ?? []) if (typeof v === "string" && v !== "") out.push(v);
  return out.slice(0, MAX_ITEMS);
}

function flagOf(s: Scope, names: readonly string[]): string | undefined {
  const r = s.reading;
  if (!r) return undefined;
  for (const name of names) {
    const values = r.flags.get(name);
    if (!values) continue;
    const last = values[values.length - 1];
    if (typeof last === "string" && last !== "") return last;
  }
  return undefined;
}

const present = (s: Scope, names: readonly string[]): boolean =>
  names.some((n) => { const v = s.reading?.flags.get(n); return v !== undefined && v[v.length - 1] !== "false"; });

/** The value after `--name` (or `--name=value`) anywhere in the argument list: for tools whose options all take a value. */
function wordAfter(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--") return undefined;
    for (const n of names) {
      if (t === n) { const v = argv[i + 1]; if (v !== undefined && !v.startsWith("-")) return v; }
      else if (t.startsWith(`${n}=`)) return t.slice(n.length + 1);
    }
  }
  return undefined;
}

function wordsAfter(argv: readonly string[], name: string): string[] {
  const at = argv.indexOf(name);
  if (at < 0) return [];
  const out: string[] = [];
  for (let i = at + 1; i < argv.length && !argv[i].startsWith("-"); i++) out.push(argv[i]);
  return out;
}

function mcpArg(args: Node, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return undefined;
}

const resolveIn = (cwd: string | undefined, p: string): string => (isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p) || !cwd ? p : join(cwd, p));

function evaluate(e: Node, s: Scope, depth = 0): Value {
  if (depth > 12) return undefined;
  const sub = (x: unknown): Value => evaluate(x as Node, s, depth + 1);
  const part = (x: unknown): Value => (typeof x === "string" ? x : sub(x));
  const r = s.reading;
  const used = s.used ?? 0;
  if ("const" in e) return e.const as Value;
  if ("flag" in e) return flagOf(s, e.flag as string[]);
  if ("flags" in e) return flagValues(s, e.flags as string[]);
  if ("present" in e) return present(s, e.present as string[]) ? true : e.or === false ? false : undefined;
  if ("positional" in e) { const i = used + (e.positional as number); return r && i < r.certain ? r.pos[i] : undefined; }
  if ("positionals" in e) {
    if (!r) return [];
    const spec = e.positionals as { from: number; to?: number; past_unknown?: true };
    // Past an option the grammar does not know, a word may be that option's value: only `past_unknown` reads on.
    const end = Math.min(spec.past_unknown ? r.pos.length : r.certain, spec.to !== undefined ? used + spec.to : Number.MAX_SAFE_INTEGER);
    return r.pos.slice(used + spec.from, Math.max(used + spec.from, end));
  }
  if ("any_positional" in e) return r?.pos[used + (e.any_positional as number)];
  if ("word_after" in e) return r ? wordAfter(r.argv, e.word_after as string[]) : undefined;
  if ("words_after" in e) return r ? wordsAfter(r.argv, e.words_after as string) : [];
  if ("assign" in e) {
    const name = e.assign as string;
    for (const word of s.sc?.assigns ?? []) if (word.startsWith(`${name}=`)) return literal(word.slice(name.length + 1));
    return undefined;
  }
  if ("arg_assign" in e) {
    const name = `${e.arg_assign as string}=`;
    const word = r?.argv.find((w) => w.startsWith(name));
    return word === undefined ? undefined : literal(word.slice(name.length));
  }
  if ("var" in e) return s.bindings?.get(e.var as string);
  if ("item" in e) return e.item === true ? s.item?.text : s.item?.groups[e.item as number];
  if ("tool" in e) return r?.tool;
  if ("server" in e) return s.mcp?.server;
  if ("env_var" in e) return s.probe.env?.(e.env_var as string);
  if ("file_sha256" in e || "dir_sha256" in e || "file_text" in e || "dir_sql" in e) {
    const files = s.probe.files;
    const path = asString(sub(e.file_sha256 ?? e.dir_sha256 ?? e.file_text ?? e.dir_sql));
    if (!files || !path || !literal(path)) return undefined;
    const full = resolveIn(s.probe.cwd, path);
    if ("file_sha256" in e) return files.sha256File(full) ?? undefined;
    if ("dir_sha256" in e) return files.sha256Dir(full) ?? undefined;
    if ("file_text" in e) return files.readText(full, 5 * 1024 * 1024) ?? undefined;
    const set = files.listSql(full);
    return set ? set.map((f) => f.text).join(";\n") : undefined;
  }
  if ("config_value" in e) {
    const spec = e.config_value as { files?: string[]; key: string; file?: Node };
    const files = s.probe.files;
    if (!files) return undefined;
    const named = spec.file ? asString(sub(spec.file)) : undefined;
    const candidates = named !== undefined ? (literal(named) ? [named] : []) : spec.files ?? [];
    for (const f of candidates) {
      const text = files.readText(resolveIn(s.probe.cwd, f), 1024 * 1024);
      if (text !== null) return configValue(text, f, spec.key);
    }
    return undefined;
  }
  if ("arg" in e) return s.mcp ? mcpArg(s.mcp.args, e.arg as string[]) : undefined;
  if ("arg_list" in e) {
    const v = s.mcp?.args[e.arg_list as string];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "").slice(0, MAX_ITEMS) : [];
  }
  if ("arg_items" in e) {
    const spec = e.arg_items as { key: string; field: string };
    const v = s.mcp?.args[spec.key];
    if (!Array.isArray(v)) return [];
    return v.map((x) => (x && typeof x === "object" && !Array.isArray(x) ? mcpArg(x as Node, [spec.field]) : undefined)).filter((x): x is string => x !== undefined).slice(0, MAX_ITEMS);
  }
  if ("env_of" in e) return envOfName(asString(sub(e.env_of)));
  if ("env_class" in e) return envClass(asString(sub(e.env_class)));
  if ("ident" in e) return ident(asString(sub(e.ident)));
  if ("literal" in e) return literal(asString(sub(e.literal)));
  if ("digest" in e) {
    const values: string[] = [];
    for (const p of e.digest as unknown[]) {
      const v = part(p);
      if (Array.isArray(v)) values.push(...v);
      else values.push(asString(v) ?? "");
    }
    const name = values[values.length - 1];
    if (name === undefined || name === "" || values.some((v) => v !== "" && literal(v) === undefined)) return undefined;
    return packDigest(...values);
  }
  if ("digest_list" in e) {
    const spec = e.digest_list as { label: unknown[]; list: Node };
    const labels = spec.label.map((p) => asString(part(p)) ?? "");
    const items = asList(sub(spec.list)).filter((x) => literal(x) !== undefined).sort();
    return items.length ? packDigest(...labels, ...items) : undefined;
  }
  if ("host_of" in e) return hostOf(asString(sub(e.host_of)));
  if ("match" in e) {
    const v = asString(sub(e.match));
    if (v === undefined) return undefined;
    const m = re(e.pattern as string).exec(clip(v));
    const g = m?.[(e.group as number | undefined) ?? 0];
    return g === undefined || g === "" ? undefined : g;
  }
  if ("replace" in e) {
    const v = asString(sub(e.replace));
    return v === undefined ? undefined : clip(v).replace(re(e.pattern as string), e.with as string);
  }
  if ("lower" in e) return asString(sub(e.lower))?.toLowerCase();
  if ("upper" in e) return asString(sub(e.upper))?.toUpperCase();
  if ("map" in e) {
    const v = asString(sub(e.map));
    const table = e.table as Record<string, string | number | boolean>;
    if (v !== undefined && Object.hasOwn(table, v)) return table[v];
    if (e.keep === true) return v;
    return e.default !== undefined ? sub(e.default) : undefined;
  }
  if ("first" in e) { for (const p of e.first as unknown[]) { const v = part(p); if (v !== undefined) return v; } return undefined; }
  if ("concat" in e) {
    let out = "";
    for (const p of e.concat as unknown[]) { const v = asString(part(p)); if (v === undefined) return undefined; out += v; }
    return out;
  }
  if ("join" in e) { const list = asList(sub(e.join)); return list.length ? list.join(e.sep as string) : undefined; }
  if ("sorted" in e) return [...asList(sub(e.sorted))].sort();
  if ("count" in e) { const v = sub(e.count); return Array.isArray(v) ? v.length : isDefined(v) ? 1 : 0; }
  if ("split" in e) {
    const v = asString(sub(e.split));
    if (v === undefined) return undefined;
    const parts = v.split(e.sep as string);
    const i = e.index as number;
    const got = parts[i < 0 ? parts.length + i : i];
    return got === undefined || got === "" ? undefined : got;
  }
  if ("scrub" in e) { const v = asString(sub(e.scrub)); return v === undefined ? undefined : scrubParam(v); }
  if ("sql" in e) {
    const text = asString(sub(e.sql));
    const c = text === undefined ? null : classifySql(text);
    if (e.field === "verb") return c?.verb ?? "unknown";
    if (e.field === "predicate_class") return c?.predicate_class;
    return c === null ? "unknown" : c.destructive || (c.verb === "update" && c.predicate_class === "all") ? "destructive" : "ordinary";
  }
  if ("if" in e) return holds(e.if as Node, s, depth + 1) ? sub(e.then) : e.else !== undefined ? sub(e.else) : undefined;
  return undefined;
}

function holds(c: Node, s: Scope, depth = 0): boolean {
  if (depth > 12) return false;
  const sub = (x: unknown): Value => evaluate(x as Node, s, depth + 1);
  if ("has" in c) return present(s, c.has as string[]);
  if ("word" in c) { const words = new Set(s.reading?.pos ?? []); return (c.word as string[]).some((w) => words.has(w)); }
  if ("unknown_option" in c) return s.reading?.uncertain === true || s.reading?.stopped === true;
  if ("defined" in c) return isDefined(sub(c.defined));
  if ("eq" in c) { const [a, b] = c.eq as [unknown, unknown]; return sub(a) === b; }
  if ("in" in c) { const [a, list] = c.in as [unknown, unknown[]]; const v = sub(a); return v !== undefined && !Array.isArray(v) && list.includes(v); }
  if ("matches" in c) { const [a, p] = c.matches as [unknown, string]; const v = asString(sub(a)); return v !== undefined && re(p).test(clip(v)); }
  if ("all" in c) return (c.all as Node[]).every((x) => holds(x, s, depth + 1));
  if ("any" in c) return (c.any as Node[]).some((x) => holds(x, s, depth + 1));
  if ("not" in c) return !holds(c.not as Node, s, depth + 1);
  if ("count" in c) {
    const v = sub(c.count);
    const n = Array.isArray(v) ? v.length : isDefined(v) ? 1 : 0;
    return (c.min === undefined || n >= (c.min as number)) && (c.max === undefined || n <= (c.max as number));
  }
  return false;
}

function emitAll(emits: readonly PackEmit[], s: Scope, via: string, derivedFrom: "shell.exec" | "mcp.tool.call", out: PackAction[]): void {
  for (const emit of emits) {
    if (out.length >= MAX_ACTIONS) return;
    if (emit.when && !holds(emit.when, s)) continue;
    const one = (scope: Scope): void => {
      const params: Record<string, unknown> = {};
      for (const [name, x] of Object.entries(emit.params)) {
        const v = evaluate(x, scope);
        if (v !== undefined) params[name] = v;
      }
      out.push({ action_type: emit.action_type, params: { ...params, via, derived_from: derivedFrom } });
    };
    if (emit.for_each === undefined) { one(s); continue; }
    const items = asList(evaluate(emit.for_each, s)).slice(0, MAX_ITEMS);
    for (const text of items) {
      if (out.length >= MAX_ACTIONS) return;
      let groups: string[] = [text];
      if (emit.item_pattern !== undefined) {
        const m = re(emit.item_pattern).exec(clip(text));
        if (!m) continue;
        groups = [...m].map((g) => g ?? "");
      }
      one({ ...s, item: { text, groups } });
    }
  }
}

/** The program a grammar reads in this simple command, and its arguments: the program itself, or the same tool started
 *  through a package runner when the grammar allows it. */
function grammarCall(sc: SimpleCommand, grammar: PackGrammar): { tool: string; argv: string[] } | null {
  if (sc.opaque) return null;
  const program = canonProgram(sc.program);
  if (grammar.programs.includes(program)) return { tool: program, argv: sc.argv };
  if (grammar.launchers === false) return null;
  const run = launched(sc);
  return run && grammar.programs.includes(run.tool) ? { tool: run.tool, argv: run.argv } : null;
}

/** The actions one grammar derives from one simple command. */
export function deriveFromGrammar(sc: SimpleCommand, grammar: PackGrammar, probe: PackProbe = {}): PackAction[] {
  const call = grammarCall(sc, grammar);
  if (!call) return [];
  const reading = { ...readArgs(grammar, call.argv), tool: call.tool };
  if (reading.skipped) return [];
  const via = grammar.via ?? grammar.programs[0];
  const out: PackAction[] = [];
  let matched = false;
  if (!reading.stopped) {
    for (const command of grammar.commands) {
      const m = matchPath(command.path, reading.pos, reading.pathCertain);
      if (!m) continue;
      if (command.max_positionals !== undefined && reading.pos.length - m.used > command.max_positionals) continue;
      const scope: Scope = { kind: "shell", sc, reading, used: m.used, bindings: m.bindings, probe };
      if (command.when && !holds(command.when, scope)) continue;
      matched = true;
      emitAll(command.emit, scope, via, "shell.exec", out);
      break;
    }
  }
  // Uncertain is not unknown: an option the grammar does not know may have hidden the subcommand. With
  // `fallback_only_unread`, only a command line no command could read falls back.
  if (out.length === 0 && (reading.uncertain || reading.stopped) && grammar.fallback && !(grammar.fallback_only_unread && matched)) {
    const scope: Scope = { kind: "shell", sc, reading, used: 0, bindings: new Map(), probe };
    for (const f of grammar.fallback) {
      if (!holds(f.when, scope)) continue;
      emitAll(f.emit, scope, via, "shell.exec", out);
      break;
    }
  }
  return out;
}

/** The words of a configured MCP server name (`github-mcp`, `plugin_github_github`). */
const serverWords = (name: string): Set<string> => new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));

/** The actions one profile derives from one MCP call, or null when the profile does not cover this server and tool. */
export function deriveFromProfile(profile: PackProfile, server: string, tool: string, args: unknown, hint?: string, probe: PackProbe = {}): PackAction[] | null {
  const named = (text: string): boolean => { const words = serverWords(text); return profile.servers.some((w) => words.has(w)); };
  if (!named(server) && !(hint !== undefined && named(hint))) return null;
  const entry = profile.tools.find((t) => t.names.includes(tool));
  if (!entry) return null;
  const input: Node = args && typeof args === "object" && !Array.isArray(args) ? (args as Node) : {};
  const scope: Scope = { kind: "mcp", mcp: { server, tool, args: input }, probe: { ...(probe.env ? { env: probe.env } : {}) } };
  if (entry.when && !holds(entry.when, scope)) return [];
  const out: PackAction[] = [];
  emitAll(entry.emit, scope, profile.via ?? profile.id, "mcp.tool.call", out);
  return out;
}

// ---- the packs in force ------------------------------------------------------------------------------------------------------

let active: readonly Pack[] = [];
let shadow: ReadonlySet<string> = new Set();

/** Set the packs the mapper reads (pack-store.ts `activatePacks`, after verifying them). Sorted by id, so the result never
 *  depends on the order they were found in. An empty list switches every pack off. `shadowIds` names the packs whose signed
 *  list says `shadow`: their rules record what they would block and never block (pack-rules.ts). */
export function setActivePacks(packs: readonly Pack[], shadowIds: Iterable<string> = []): void {
  active = [...packs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : comparePackVersions(a.version, b.version)));
  shadow = new Set(shadowIds);
}

/** The ids of the packs in force that are in shadow. */
export const shadowPackIds = (): ReadonlySet<string> => shadow;

/** The packs in force, as `id@version`. */
export const activePackRefs = (): string[] => active.map(packRef);
/** The packs in force, sorted by id. */
export const activePacks = (): readonly Pack[] => active;

/** What the packs in force derive from one simple command: the first pack (by id) whose grammar for this program derives
 *  anything. Never throws: a pack that fails here derives nothing. */
export function derivePackTargets(sc: SimpleCommand, probe: PackProbe = {}, packs: readonly Pack[] = active): PackAction[] {
  if (sc.opaque || packs.length === 0) return [];
  for (const pack of packs) {
    for (const grammar of pack.grammars) {
      try {
        const out = deriveFromGrammar(sc, grammar, probe);
        if (out.length) return out;
      } catch { /* this grammar derives nothing */ }
    }
  }
  return [];
}

/** What the packs in force derive from one MCP call. The first profile (packs by id, then profile order) whose server words
 *  name the server's configured name owns the call; only when none does, the first whose words name the hint (the server's
 *  URL or launch command). The owning profile derives what it lists for the tool, and nothing for a tool it does not list:
 *  another profile is never asked, so a call is read the same way whichever tools a profile lists. */
export function derivePackMcp(server: string, tool: string, args: unknown, hint?: string, packs: readonly Pack[] = active, probe: PackProbe = {}): PackAction[] {
  for (const by of hint === undefined ? [server] : [server, hint]) {
    const words = serverWords(by);
    for (const pack of packs) {
      for (const profile of pack.profiles) {
        if (!profile.servers.some((w) => words.has(w))) continue;
        try { return deriveFromProfile(profile, server, tool, args, hint, probe) ?? []; } catch { return []; }
      }
    }
  }
  return [];
}

// ---- conformance: a pack's own vectors -------------------------------------------------------------------------------------

export interface VectorFailure { id: string; expected: unknown; actual: unknown }

/** An expected parameter value as the engine computes it: `{ digest_of: [...] }` is the keyed digest of those parts. */
function expectedValue(v: unknown): unknown {
  if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { digest_of?: unknown }).digest_of)) {
    return packDigest(...(v as { digest_of: string[] }).digest_of);
  }
  return v;
}

const stable = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Node).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** Run every vector of a pack through this interpreter, with this pack alone in force. Pure: no file, no network. */
export function runPackVectors(pack: Pack): { passed: number; failures: VectorFailure[] } {
  const failures: VectorFailure[] = [];
  let passed = 0;
  for (const vector of pack.vectors) {
    let actual: PackAction[] = [];
    try {
      if (vector.shell) {
        const text = vector.shell.dialect === "powershell" ? vector.shell.command.replace(/`(.)/g, "$1").replace(/\\/g, "/") : vector.shell.command;
        for (const sc of decomposeShell(text)) actual.push(...derivePackTargets(sc, {}, [pack]));
      } else if (vector.mcp) {
        actual = derivePackMcp(vector.mcp.server, vector.mcp.tool, vector.mcp.args, vector.mcp.hint, [pack]);
      }
    } catch (error) { actual = [{ action_type: "error", params: { message: (error as Error).message } }]; }
    const expected = vector.expect.map((x) => ({ action_type: x.action_type, params: Object.fromEntries(Object.entries(x.params).map(([k, v]) => [k, expectedValue(v)])) }));
    if (stable(actual) === stable(expected)) passed++;
    else failures.push({ id: vector.id, expected, actual });
  }
  return { passed, failures };
}

/** A pack's content digest (sha256 of its canonical text as stored), for listings. */
export const packFileDigest = (text: string): string => createHash("sha256").update(text).digest("hex");
