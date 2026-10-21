// Rule packs (scopebond:pack/v1): signed data that teaches an engine what a command-line tool or an MCP server does, without
// shipping code. A pack carries
//
//   grammars   how to read one tool's command line (its program names, subcommand paths, options and positionals) and which
//              taxonomy actions a matching command performs, with parameters computed by a small closed expression language;
//   profiles   which MCP servers (by the words of their configured name) and tools perform which taxonomy actions;
//   rules      policy clauses in the existing rule language (`action_allowlist`) that govern those actions;
//   vectors    inputs and the exact actions the pack must derive from them, which every engine runs before it trusts the pack.
//
// The format is closed: an unknown field, operator or option anywhere makes the pack invalid, and an engine refuses it as a
// whole. Packs are deterministic: the same command and the same pack give the same actions on every computer. A pack is
// signed with a policy-signing key (Ed25519) over the domain below followed by the RFC 8785 canonical pack without its
// `signature` member, so a pack signature never verifies as anything else and the reverse.
//
// This module defines the shape and checks it (`validatePack`). It does not interpret a pack: the hook does.
//
// Engine levels. The format grows only by adding fields, and each addition raises the engine level. Level 1 is the format as
// first published. Level 2 adds `requires` on the pack, and on a rule `title`, `blockable`, `default_mode`, `safer_way` and
// `allow_patterns`, and lets a pack emit action types a signed taxonomy extension defines (named in `requires.action_types`).
// A pack that uses a level-2 field says `requires: { engine: 2 }`. A level-1 engine reads every such field as unknown and
// refuses the pack as invalid, so a level-1 pack is read the same way by every engine, and a level-2 pack is never read
// halfway. An engine skips a pack whose `requires.engine` is above its own level, or that names an action type it does not
// know, and keeps the others (`packEngineProblem`).

import { canonical } from "./canonical.js";
import { getActionType } from "./registry.js";
import { allowPatternErrors } from "./allow-patterns.js";

export const PACK_FORMAT = "scopebond:pack/v1";
/** The pack engine level this release implements (see "Engine levels" above). */
export const PACK_ENGINE_LEVEL = 2;
/** The fields only a level-2 engine reads: on the pack, and on a pack rule. */
export const PACK_LEVEL2_FIELDS = {
  pack: ["requires"],
  rule: ["title", "blockable", "default_mode", "safer_way", "allow_patterns"],
} as const;
/** What a rule's `allow_patterns` entry may widen an allowance by. */
export const PACK_ALLOW_PATTERN_KINDS = ["path_prefix", "path_glob", "package_name", "host", "mcp_tool"] as const;
/** The longest texts a level-2 rule carries, and the most allow patterns one rule lists. */
export const PACK_RULE_LIMITS = { title: 80, saferWay: 160, allowPatterns: 8, requiredTypes: 64, maxEngine: 1000 } as const;
/** What a pack signature covers: these bytes, then the canonical pack without `signature`. */
export const PACK_SIGNATURE_DOMAIN = "scopebond:pack/v1\n";

/** Bounds every engine enforces, so a pack cannot make an engine slow or large. */
export const PACK_LIMITS = {
  maxBytes: 4 * 1024 * 1024,
  maxGrammars: 200,
  maxProfiles: 200,
  maxRules: 200,
  maxVectors: 5000,
  maxCommands: 500,
  maxTools: 200,
  maxEmits: 16,
  maxParams: 24,
  maxPathWords: 8,
  maxList: 1000,
  maxDepth: 10,
  maxPattern: 200,
  maxString: 2000,
} as const;

/** The action types a pack may not emit: the call itself, which the engine always records. */
export const PACK_RESERVED_ACTION_TYPES: readonly string[] = ["shell.exec", "mcp.tool.call"];
/** Parameters the engine sets on every derived action; a pack may not set them. */
export const PACK_RESERVED_PARAMS: readonly string[] = ["via", "derived_from"];

// ---- types --------------------------------------------------------------------------------------------------------------

export type Scalar = string | number | boolean;

/** A value expression: an object with exactly one operator (and that operator's modifiers). See `EXPRESSION_OPERATORS`. */
export type Expr = Record<string, unknown>;
/** A condition: an object with exactly one condition operator. See `CONDITION_OPERATORS`. */
export type Condition = Record<string, unknown>;

export type PathWord = string | {
  any?: string[];
  not?: string[];
  pattern?: string;
  skip?: number;
  optional?: string;
  var?: string;
};

export interface PackEmit {
  action_type: string;
  params: Record<string, Expr>;
  when?: Condition;
  for_each?: Expr;
  item_pattern?: string;
}

export interface PackCommand {
  path: PathWord[];
  when?: Condition;
  max_positionals?: number;
  emit: PackEmit[];
}

export interface PackGrammar {
  id: string;
  programs: string[];
  via?: string;
  launchers?: boolean;
  options?: { valued?: string[]; flags?: string[] };
  unknown_options?: "uncertain" | "stop";
  /** Which options may stand before a command's path words: any but an unknown switch (the default), only `known` ones, or
   *  `none`. An option that may not ends the words a path can match; the positionals after the path are read as before. */
  path_options?: "known" | "none";
  /** An option the grammar does not know ends the certain positionals even when it carries its value (`--name=value`). */
  strict_unknown?: boolean;
  /** Every option, known or not, lets the fallback run (as an option the grammar does not know does). */
  fallback_on_any_option?: boolean;
  /** The fallback runs only when no command's path (and `when`) matched. */
  fallback_only_unread?: boolean;
  /** `positionals`: the words after `--` are positionals too (the default, `end`, stops reading there). */
  double_dash?: "end" | "positionals";
  single_dash_long?: boolean;
  strip_words?: string[];
  skip?: { options?: string[]; words?: string[] };
  commands: PackCommand[];
  fallback?: Array<{ when: Condition; emit: PackEmit[] }>;
}

export interface PackProfileTool { names: string[]; when?: Condition; emit: PackEmit[] }
export interface PackProfile { id: string; servers: string[]; via?: string; tools: PackProfileTool[] }

export type ExpectedValue = Scalar | Scalar[] | { digest_of: string[] };
export interface PackVector {
  id: string;
  shell?: { command: string; dialect?: "posix" | "powershell" };
  mcp?: { server: string; tool: string; args: Record<string, unknown>; hint?: string };
  expect: Array<{ action_type: string; params: Record<string, ExpectedValue> }>;
}

export interface PackSignature { alg: "Ed25519"; key_id: string; value: string }

/** (level 2) What an engine needs to read a pack: its level, and the action types beyond the built-in registry it emits. */
export interface PackRequires { engine: number; action_types?: string[] }

/** (level 2) A bounded way a person's allowance under a rule may cover similar actions. The format checks the shape only;
 *  what each kind matches is the engine's. */
export interface PackAllowPattern { id: string; title: string; param: string; kind: (typeof PACK_ALLOW_PATTERN_KINDS)[number] }

/** A pack rule: an `action_allowlist` clause, and (level 2) what a person reads about it and whether it may block. */
export interface PackRule {
  id: string;
  type: "action_allowlist";
  mode?: "enforce" | "monitor" | "require_approval";
  description?: string;
  action_types: string[];
  param_bounds?: Record<string, unknown>;
  title?: string;
  blockable?: boolean;
  default_mode?: "monitor" | "block";
  safer_way?: string;
  allow_patterns?: PackAllowPattern[];
}

export interface Pack {
  format: typeof PACK_FORMAT;
  id: string;
  version: string;
  issued_at: string;
  title?: string;
  requires?: PackRequires;
  signature: PackSignature;
  grammars: PackGrammar[];
  profiles: PackProfile[];
  rules: Array<Record<string, unknown>>;
  vectors: PackVector[];
}

export interface PackValidation { valid: boolean; errors: string[] }

// ---- signing -----------------------------------------------------------------------------------------------------------

/** The exact string whose UTF-8 bytes a pack signature covers: the domain, then the canonical pack without `signature`. */
export function packSigningInput(pack: Record<string, unknown>): string {
  const unsigned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(pack)) if (key !== "signature") unsigned[key] = value;
  return PACK_SIGNATURE_DOMAIN + canonical(unsigned);
}

/** `id@version`, the name a pack is stored and fetched under. */
export const packRef = (pack: { id: string; version: string }): string => `${pack.id}@${pack.version}`;

/** Compare two pack versions (`MAJOR.MINOR.PATCH`) numerically: negative, zero or positive. */
export function comparePackVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// ---- the closed vocabulary ---------------------------------------------------------------------------------------------

/** Value operators, each with the modifier keys it takes. A shell-only operator in an MCP profile (or the reverse) is invalid. */
export const EXPRESSION_OPERATORS = {
  // sources: shell
  const: [], flag: [], flags: [], present: ["or"], positional: [], positionals: [], any_positional: [], word_after: [],
  words_after: [], assign: [], arg_assign: [], var: [], item: [], tool: [],
  // sources: local facts (an engine without a file and environment probe reads them as unknown)
  env_var: [], file_sha256: [], dir_sha256: [], file_text: [], dir_sql: [], config_value: [],
  // sources: MCP
  arg: [], arg_list: [], arg_items: [], server: [],
  // transforms
  env_of: [], env_class: [], ident: [], literal: [], digest: [], digest_list: [], host_of: [], match: ["pattern", "group"],
  replace: ["pattern", "with"], lower: [], upper: [], map: ["table", "default", "keep"], first: [], concat: [], join: ["sep"],
  sorted: [], count: [], split: ["sep", "index"], scrub: [], sql: ["field"], if: ["then", "else"],
} as const satisfies Record<string, readonly string[]>;

export const CONDITION_OPERATORS = ["has", "word", "defined", "eq", "in", "matches", "all", "any", "not", "count", "unknown_option"] as const;

const SHELL_ONLY = new Set(["flag", "flags", "present", "positional", "positionals", "any_positional", "word_after", "words_after", "assign", "arg_assign", "var", "tool",
  "file_sha256", "dir_sha256", "file_text", "dir_sql", "config_value"]);
const MCP_ONLY = new Set(["arg", "arg_list", "arg_items", "server"]);
const SQL_FIELDS = ["verb", "predicate_class", "risk"];

// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, a bounded run of one class with an optional repeat of separators
const PACK_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored, fixed-width fields
const ISSUED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SIG = /^[A-Za-z0-9+/]{86}(?:==)?$/;
const PROGRAM = /^[a-z0-9][a-z0-9._+-]{0,63}$/;
const OPTION = /^-{1,2}[A-Za-z0-9?][A-Za-z0-9._:-]{0,63}$/;
const VAR = /^[a-z][a-z0-9_]{0,31}$/;
const PARAM = /^[a-z][a-z0-9_]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: each repeat starts at a dot the one before it cannot contain
const ACTION_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
// A group that is itself repeated and holds a repeat (`(a+)+`, `(a*)*`, `(a|aa)+` with a quantifier inside) can backtrack
// exponentially. Patterns run only on words the engine first cuts to a bounded length, and a pack is signed data; this is
// the static check on top.
const NESTED_REPEAT = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)[+*{]/;

// ---- a rule's allow patterns ----------------------------------------------------------------------------------------------
// The recipes a rule carries for pattern allowances ("Similar commands in this project"): their shape and check are the pattern
// allowances module's (allow-patterns.ts).

type Ctx = "shell" | "mcp";

class Checker {
  readonly errors: string[] = [];
  /** The engine level the pack is read at, and the action types its `requires` names (level 2). */
  constructor(readonly level: number = PACK_ENGINE_LEVEL, readonly requiredTypes: ReadonlySet<string> = new Set()) {}
  /** Level-2 fields a rule used, by where. */
  readonly level2: string[] = [];
  fail(at: string, message: string): false { if (this.errors.length < 200) this.errors.push(`${at}: ${message}`); return false; }

  object(value: unknown, at: string, allowed: readonly string[], required: readonly string[] = []): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return this.fail(at, "must be an object");
    const record = value as Record<string, unknown>;
    let ok = true;
    for (const key of Object.keys(record)) if (!allowed.includes(key)) ok = this.fail(at, `unknown field "${key}"`);
    for (const key of required) if (record[key] === undefined) ok = this.fail(at, `missing "${key}"`);
    return ok;
  }

  string(value: unknown, at: string, pattern?: RegExp, max: number = PACK_LIMITS.maxString): value is string {
    if (typeof value !== "string" || value.length === 0) return this.fail(at, "must be a non-empty string");
    if (value.length > max) return this.fail(at, `is longer than ${max} characters`);
    if (pattern && !pattern.test(value)) return this.fail(at, `"${value.slice(0, 80)}" is not allowed here`);
    return true;
  }

  integer(value: unknown, at: string, min: number, max: number): value is number {
    if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) return this.fail(at, `must be an integer from ${min} to ${max}`);
    return true;
  }

  scalar(value: unknown, at: string): value is Scalar {
    if (typeof value === "string") return value.length <= PACK_LIMITS.maxString || this.fail(at, "is too long");
    if (typeof value === "boolean") return true;
    if (Number.isInteger(value) && Math.abs(value as number) <= Number.MAX_SAFE_INTEGER) return true;
    return this.fail(at, "must be a string, an integer or a boolean");
  }

  list(value: unknown, at: string, item: (v: unknown, at: string) => boolean, min = 1, max: number = PACK_LIMITS.maxList, unique = true): value is unknown[] {
    if (!Array.isArray(value)) return this.fail(at, "must be an array");
    if (value.length < min || value.length > max) return this.fail(at, `must have ${min} to ${max} items`);
    let ok = true;
    value.forEach((v, i) => { if (!item(v, `${at}[${i}]`)) ok = false; });
    if (ok && unique && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) ok = this.fail(at, "items must be unique");
    return ok;
  }

  strings(value: unknown, at: string, pattern?: RegExp, min = 1): value is string[] {
    return this.list(value, at, (v, a) => this.string(v, a, pattern, 200), min);
  }

  pattern(value: unknown, at: string): value is string {
    if (!this.string(value, at, undefined, PACK_LIMITS.maxPattern)) return false;
    if (NESTED_REPEAT.test(value)) return this.fail(at, "a repeated group that holds a repeat is not allowed (it can backtrack)");
    if (/\\[1-9]|\(\?<[=!]/.test(value)) return this.fail(at, "back-references and look-behind are not allowed");
    // eslint-disable-next-line security/detect-non-literal-regexp -- compiled only to check that it parses; never matched here
    try { new RegExp(value); } catch { return this.fail(at, "is not a valid regular expression"); }
    return true;
  }

  // ---- expressions ----

  expr(value: unknown, at: string, ctx: Ctx, depth = 0): boolean {
    if (depth > PACK_LIMITS.maxDepth) return this.fail(at, "is nested too deeply");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return this.fail(at, "must be an expression object");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const op = keys.find((k) => Object.hasOwn(EXPRESSION_OPERATORS, k)) as keyof typeof EXPRESSION_OPERATORS | undefined;
    if (!op) return this.fail(at, `has no known operator (${keys.join(", ") || "empty"})`);
    const modifiers: readonly string[] = EXPRESSION_OPERATORS[op];
    let ok = true;
    for (const key of keys) if (key !== op && !modifiers.includes(key)) ok = this.fail(at, `"${key}" is not a modifier of "${op}"`);
    if (ctx === "mcp" && SHELL_ONLY.has(op)) return this.fail(at, `"${op}" reads a command line; it cannot be used in an MCP profile`);
    if (ctx === "shell" && MCP_ONLY.has(op)) return this.fail(at, `"${op}" reads MCP arguments; it cannot be used in a grammar`);
    const v = record[op];
    const sub = (x: unknown, a: string): boolean => this.expr(x, a, ctx, depth + 1);
    // A literal part may be empty: a digest names an absent scope as "".
    const part = (x: unknown, a: string): boolean => (typeof x === "string" ? x.length <= 200 || this.fail(a, "is longer than 200 characters") : sub(x, a));
    const here = `${at}.${op}`;
    switch (op) {
      case "const": return this.scalar(v, here) && ok;
      case "flag": case "flags": case "word_after": return this.strings(v, here, OPTION) && ok;
      case "present":
        if (!this.strings(v, here, OPTION)) ok = false;
        if (record.or !== undefined && record.or !== false) ok = this.fail(`${at}.or`, "may only be false");
        return ok;
      case "words_after": return this.string(v, here, OPTION) && ok;
      case "positional": case "any_positional": return this.integer(v, here, 0, 64) && ok;
      case "positionals":
        if (this.object(v, here, ["from", "to", "past_unknown"], ["from"])) {
          if (!this.integer(v.from, `${here}.from`, 0, 64)) ok = false;
          if (v.to !== undefined && !this.integer(v.to, `${here}.to`, 0, 64)) ok = false;
          if (v.past_unknown !== undefined && v.past_unknown !== true) ok = this.fail(`${here}.past_unknown`, "may only be true");
          return ok;
        }
        return false;
      case "assign": case "arg_assign": case "env_var": return this.string(v, here, ENV_NAME) && ok;
      case "var": return this.string(v, here, VAR) && ok;
      case "item":
        if (v === true) return ok;
        return this.integer(v, here, 1, 9) && ok;
      case "tool": case "server": return (v === true || this.fail(here, "must be true")) && ok;
      case "file_sha256": case "dir_sha256": case "file_text": case "dir_sql": return sub(v, here) && ok;
      case "config_value":
        if (!this.object(v, here, ["files", "key", "file"], ["key"])) return false;
        if (v.files !== undefined && !this.strings(v.files, `${here}.files`, /^[A-Za-z0-9._-]{1,64}$/)) ok = false;
        if (!this.string(v.key, `${here}.key`, /^[A-Za-z_][A-Za-z0-9_]{0,63}$/)) ok = false;
        if (v.file !== undefined && !sub(v.file, `${here}.file`)) ok = false;
        if (v.files === undefined && v.file === undefined) ok = this.fail(here, "names no file (files or file)");
        return ok;
      case "arg": return this.strings(v, here, /^[A-Za-z0-9_.-]{1,64}$/) && ok;
      case "arg_list": return this.string(v, here, /^[A-Za-z0-9_.-]{1,64}$/) && ok;
      case "arg_items":
        if (!this.object(v, here, ["key", "field"], ["key", "field"])) return false;
        return this.string(v.key, `${here}.key`, /^[A-Za-z0-9_.-]{1,64}$/) && this.string(v.field, `${here}.field`, /^[A-Za-z0-9_.-]{1,64}$/) && ok;
      case "env_of": case "env_class": case "ident": case "literal": case "host_of": case "lower": case "upper":
      case "sorted": case "count": case "scrub":
        return sub(v, here) && ok;
      case "digest": return this.list(v, here, part, 2, 12, false) && ok;
      case "digest_list":
        if (!this.object(v, here, ["label", "list"], ["label", "list"])) return false;
        return this.list(v.label, `${here}.label`, part, 1, 8, false) && sub(v.list, `${here}.list`) && ok;
      case "match":
        if (!sub(v, here) || !this.pattern(record.pattern, `${at}.pattern`)) ok = false;
        if (record.group !== undefined && !this.integer(record.group, `${at}.group`, 0, 9)) ok = false;
        return ok;
      case "replace":
        if (!sub(v, here) || !this.pattern(record.pattern, `${at}.pattern`)) ok = false;
        if (typeof record.with !== "string" || record.with.length > 200) ok = this.fail(`${at}.with`, "must be a string of at most 200 characters");
        return ok;
      case "map": {
        if (!sub(v, here)) ok = false;
        const table = record.table;
        if (typeof table !== "object" || table === null || Array.isArray(table) || Object.keys(table).length === 0 || Object.keys(table).length > PACK_LIMITS.maxList) {
          return this.fail(`${at}.table`, "must be an object of 1 to 1000 entries");
        }
        for (const [k, x] of Object.entries(table)) { if (k.length > 200) ok = this.fail(`${at}.table`, "keys are at most 200 characters"); if (!this.scalar(x, `${at}.table.${k}`)) ok = false; }
        if (record.default !== undefined && !sub(record.default, `${at}.default`)) ok = false;
        if (record.keep !== undefined && record.keep !== true) ok = this.fail(`${at}.keep`, "may only be true");
        if (record.keep === true && record.default !== undefined) ok = this.fail(at, "takes either default or keep, not both");
        return ok;
      }
      case "first": case "concat": return this.list(v, here, part, 1, 12, false) && ok;
      case "join":
        if (!sub(v, here)) ok = false;
        if (typeof record.sep !== "string" || record.sep.length > 8) ok = this.fail(`${at}.sep`, "must be a string of at most 8 characters");
        return ok;
      case "split":
        if (!sub(v, here)) ok = false;
        if (typeof record.sep !== "string" || record.sep.length === 0 || record.sep.length > 8) ok = this.fail(`${at}.sep`, "must be a string of 1 to 8 characters");
        if (!this.integer(record.index, `${at}.index`, -8, 8)) ok = false;
        return ok;
      case "sql":
        if (!sub(v, here)) ok = false;
        if (!SQL_FIELDS.includes(record.field as string)) ok = this.fail(`${at}.field`, `must be one of ${SQL_FIELDS.join(", ")}`);
        return ok;
      case "if":
        if (!this.condition(v, here, ctx, depth + 1)) ok = false;
        if (record.then === undefined) ok = this.fail(at, "missing \"then\"");
        else if (!sub(record.then, `${at}.then`)) ok = false;
        if (record.else !== undefined && !sub(record.else, `${at}.else`)) ok = false;
        return ok;
    }
    return ok;
  }

  condition(value: unknown, at: string, ctx: Ctx, depth = 0): boolean {
    if (depth > PACK_LIMITS.maxDepth) return this.fail(at, "is nested too deeply");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return this.fail(at, "must be a condition object");
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const op = keys.find((k) => (CONDITION_OPERATORS as readonly string[]).includes(k));
    if (!op) return this.fail(at, `has no known condition (${keys.join(", ") || "empty"})`);
    const allowed = op === "count" ? ["count", "min", "max"] : [op];
    let ok = true;
    for (const key of keys) if (!allowed.includes(key)) ok = this.fail(at, `"${key}" is not part of "${op}"`);
    const v = record[op];
    const here = `${at}.${op}`;
    const sub = (x: unknown, a: string): boolean => this.expr(x, a, ctx, depth + 1);
    switch (op) {
      case "has":
        if (ctx === "mcp") return this.fail(here, "reads a command line; it cannot be used in an MCP profile");
        return this.strings(v, here, OPTION) && ok;
      case "word":
        if (ctx === "mcp") return this.fail(here, "reads a command line; it cannot be used in an MCP profile");
        return this.strings(v, here, undefined) && ok;
      case "unknown_option":
        if (ctx === "mcp") return this.fail(here, "reads a command line; it cannot be used in an MCP profile");
        return (v === true || this.fail(here, "must be true")) && ok;
      case "defined": return sub(v, here) && ok;
      case "eq":
        if (!Array.isArray(v) || v.length !== 2) return this.fail(here, "must be [expression, value]");
        return sub(v[0], `${here}[0]`) && this.scalar(v[1], `${here}[1]`) && ok;
      case "in":
        if (!Array.isArray(v) || v.length !== 2) return this.fail(here, "must be [expression, [values]]");
        return sub(v[0], `${here}[0]`) && this.list(v[1], `${here}[1]`, (x, a) => this.scalar(x, a)) && ok;
      case "matches":
        if (!Array.isArray(v) || v.length !== 2) return this.fail(here, "must be [expression, pattern]");
        return sub(v[0], `${here}[0]`) && this.pattern(v[1], `${here}[1]`) && ok;
      case "all": case "any": return this.list(v, here, (x, a) => this.condition(x, a, ctx, depth + 1), 1, 32, false) && ok;
      case "not": return this.condition(v, here, ctx, depth + 1) && ok;
      case "count":
        if (!sub(v, here)) ok = false;
        if (record.min === undefined && record.max === undefined) ok = this.fail(at, "count needs min or max");
        if (record.min !== undefined && !this.integer(record.min, `${at}.min`, 0, 10_000)) ok = false;
        if (record.max !== undefined && !this.integer(record.max, `${at}.max`, 0, 10_000)) ok = false;
        return ok;
    }
    return ok;
  }

  emit(value: unknown, at: string, ctx: Ctx): boolean {
    if (!this.object(value, at, ["action_type", "params", "when", "for_each", "item_pattern"], ["action_type", "params"])) return false;
    let ok = true;
    if (this.string(value.action_type, `${at}.action_type`, ACTION_TYPE, 100)) {
      const type = value.action_type;
      if (PACK_RESERVED_ACTION_TYPES.includes(type)) ok = this.fail(`${at}.action_type`, `"${type}" is the call itself; a pack cannot emit it`);
      else if (!getActionType(type) && !this.requiredTypes.has(type)) ok = this.fail(`${at}.action_type`, `"${type}" is not a registered action type (nor one the pack's requires.action_types names)`);
    } else ok = false;
    const params = value.params;
    if (typeof params !== "object" || params === null || Array.isArray(params)) ok = this.fail(`${at}.params`, "must be an object");
    else {
      const entries = Object.entries(params);
      if (entries.length > PACK_LIMITS.maxParams) ok = this.fail(`${at}.params`, `has more than ${PACK_LIMITS.maxParams} parameters`);
      for (const [name, x] of entries) {
        if (!PARAM.test(name)) ok = this.fail(`${at}.params`, `"${name}" is not a parameter name`);
        else if (PACK_RESERVED_PARAMS.includes(name)) ok = this.fail(`${at}.params`, `"${name}" is set by the engine`);
        else if (!this.expr(x, `${at}.params.${name}`, ctx)) ok = false;
      }
    }
    if (value.when !== undefined && !this.condition(value.when, `${at}.when`, ctx)) ok = false;
    if (value.for_each !== undefined && !this.expr(value.for_each, `${at}.for_each`, ctx)) ok = false;
    if (value.item_pattern !== undefined) {
      if (value.for_each === undefined) ok = this.fail(`${at}.item_pattern`, "needs for_each");
      else if (!this.pattern(value.item_pattern, `${at}.item_pattern`)) ok = false;
    }
    return ok;
  }

  pathWord(value: unknown, at: string): boolean {
    if (typeof value === "string") return this.string(value, at, undefined, 200);
    if (!this.object(value, at, ["any", "not", "pattern", "skip", "optional", "var"])) return false;
    const kinds = ["any", "not", "pattern", "skip", "optional"].filter((k) => value[k] !== undefined);
    let ok = true;
    if (kinds.length > 1 && !(kinds.length === 2 && kinds.includes("not") && kinds.includes("pattern"))) ok = this.fail(at, `combines ${kinds.join(" and ")}`);
    if (value.any !== undefined && !this.strings(value.any, `${at}.any`)) ok = false;
    if (value.not !== undefined && !this.strings(value.not, `${at}.not`)) ok = false;
    if (value.pattern !== undefined && !this.pattern(value.pattern, `${at}.pattern`)) ok = false;
    if (value.skip !== undefined && !this.integer(value.skip, `${at}.skip`, 1, PACK_LIMITS.maxPathWords)) ok = false;
    if (value.optional !== undefined && !this.string(value.optional, `${at}.optional`, undefined, 200)) ok = false;
    if (value.var !== undefined && !this.string(value.var, `${at}.var`, VAR)) ok = false;
    if (kinds.length === 0 && value.var === undefined) ok = this.fail(at, "matches nothing (give any, not, pattern, skip, optional or var)");
    return ok;
  }

  grammar(value: unknown, at: string): boolean {
    if (!this.object(value, at, ["id", "programs", "via", "launchers", "options", "unknown_options", "strict_unknown", "path_options", "fallback_on_any_option", "fallback_only_unread", "double_dash", "single_dash_long", "strip_words", "skip", "commands", "fallback"], ["id", "programs", "commands"])) return false;
    let ok = true;
    if (!this.string(value.id, `${at}.id`, PACK_ID)) ok = false;
    if (!this.list(value.programs, `${at}.programs`, (v, a) => this.string(v, a, PROGRAM), 1, 20)) ok = false;
    if (value.via !== undefined && !this.string(value.via, `${at}.via`, PROGRAM)) ok = false;
    if (value.launchers !== undefined && typeof value.launchers !== "boolean") ok = this.fail(`${at}.launchers`, "must be a boolean");
    if (value.single_dash_long !== undefined && typeof value.single_dash_long !== "boolean") ok = this.fail(`${at}.single_dash_long`, "must be a boolean");
    if (value.unknown_options !== undefined && value.unknown_options !== "uncertain" && value.unknown_options !== "stop") ok = this.fail(`${at}.unknown_options`, "must be uncertain or stop");
    if (value.path_options !== undefined && value.path_options !== "known" && value.path_options !== "none") ok = this.fail(`${at}.path_options`, "must be known or none");
    if (value.double_dash !== undefined && value.double_dash !== "end" && value.double_dash !== "positionals") ok = this.fail(`${at}.double_dash`, "must be end or positionals");
    for (const key of ["strict_unknown", "fallback_on_any_option", "fallback_only_unread"] as const) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") ok = this.fail(`${at}.${key}`, "must be a boolean");
    }
    if (value.options !== undefined && this.object(value.options, `${at}.options`, ["valued", "flags"])) {
      if (value.options.valued !== undefined && !this.strings(value.options.valued, `${at}.options.valued`, OPTION)) ok = false;
      if (value.options.flags !== undefined && !this.strings(value.options.flags, `${at}.options.flags`, OPTION)) ok = false;
    } else if (value.options !== undefined) ok = false;
    if (value.strip_words !== undefined && !this.strings(value.strip_words, `${at}.strip_words`)) ok = false;
    if (value.skip !== undefined && this.object(value.skip, `${at}.skip`, ["options", "words"])) {
      if (value.skip.options !== undefined && !this.strings(value.skip.options, `${at}.skip.options`, OPTION)) ok = false;
      if (value.skip.words !== undefined && !this.strings(value.skip.words, `${at}.skip.words`)) ok = false;
    } else if (value.skip !== undefined) ok = false;
    const commands = value.commands;
    if (this.list(commands, `${at}.commands`, () => true, 1, PACK_LIMITS.maxCommands, false)) {
      (commands).forEach((c, i) => {
        const ca = `${at}.commands[${i}]`;
        if (!this.object(c, ca, ["path", "when", "max_positionals", "emit"], ["path", "emit"])) { ok = false; return; }
        if (!this.list(c.path, `${ca}.path`, (w, a) => this.pathWord(w, a), 0, PACK_LIMITS.maxPathWords, false)) ok = false;
        if (c.when !== undefined && !this.condition(c.when, `${ca}.when`, "shell")) ok = false;
        if (c.max_positionals !== undefined && !this.integer(c.max_positionals, `${ca}.max_positionals`, 0, 64)) ok = false;
        if (!this.list(c.emit, `${ca}.emit`, (e, a) => this.emit(e, a, "shell"), 0, PACK_LIMITS.maxEmits, false)) ok = false;
        const vars = (Array.isArray(c.path) ? c.path : []).map((w) => (typeof w === "object" && w !== null ? (w as { var?: string }).var : undefined)).filter((x) => x !== undefined);
        if (new Set(vars).size !== vars.length) ok = this.fail(`${ca}.path`, "names a var twice");
      });
    } else ok = false;
    if (value.fallback !== undefined) {
      if (!this.list(value.fallback, `${at}.fallback`, (f, a) => {
        if (!this.object(f, a, ["when", "emit"], ["when", "emit"])) return false;
        const good = this.condition(f.when, `${a}.when`, "shell");
        return this.list(f.emit, `${a}.emit`, (e, b) => this.emit(e, b, "shell"), 1, PACK_LIMITS.maxEmits, false) && good;
      }, 1, 64, false)) ok = false;
    }
    return ok;
  }

  profile(value: unknown, at: string): boolean {
    if (!this.object(value, at, ["id", "servers", "via", "tools"], ["id", "servers", "tools"])) return false;
    let ok = true;
    if (!this.string(value.id, `${at}.id`, PACK_ID)) ok = false;
    if (!this.strings(value.servers, `${at}.servers`, /^[a-z0-9]{1,64}$/)) ok = false;
    if (value.via !== undefined && !this.string(value.via, `${at}.via`, PROGRAM)) ok = false;
    if (!this.list(value.tools, `${at}.tools`, (t, a) => {
      if (!this.object(t, a, ["names", "when", "emit"], ["names", "emit"])) return false;
      let good = this.strings(t.names, `${a}.names`, /^[A-Za-z0-9_.:-]{1,128}$/);
      if (t.when !== undefined && !this.condition(t.when, `${a}.when`, "mcp")) good = false;
      return this.list(t.emit, `${a}.emit`, (e, b) => this.emit(e, b, "mcp"), 1, PACK_LIMITS.maxEmits, false) && good;
    }, 1, PACK_LIMITS.maxTools, false)) ok = false;
    return ok;
  }

  bound(value: unknown, at: string): boolean {
    if (!this.object(value, at, ["min", "max", "enum", "pattern"])) return false;
    let ok = Object.keys(value).length > 0 || this.fail(at, "is empty");
    if (value.min !== undefined && typeof value.min !== "number") ok = this.fail(`${at}.min`, "must be a number");
    if (value.max !== undefined && typeof value.max !== "number") ok = this.fail(`${at}.max`, "must be a number");
    if (value.enum !== undefined && !this.list(value.enum, `${at}.enum`, (x, a) => x === null || this.scalar(x, a))) ok = false;
    if (value.pattern !== undefined && !this.pattern(value.pattern, `${at}.pattern`)) ok = false;
    return ok;
  }

  rule(value: unknown, at: string): boolean {
    // Only the `action_allowlist` clause of the rule language, exactly as the policy schema defines it; at level 2, with
    // what a person reads about the rule and whether it may block.
    const fields = ["id", "type", "mode", "description", "action_types", "param_bounds", ...(this.level >= 2 ? PACK_LEVEL2_FIELDS.rule : [])];
    if (!this.object(value, at, fields, ["id", "type", "action_types"])) return false;
    let ok = true;
    for (const key of PACK_LEVEL2_FIELDS.rule) if (value[key] !== undefined) this.level2.push(`${at}.${key}`);
    if (value.title !== undefined && !this.string(value.title, `${at}.title`, undefined, PACK_RULE_LIMITS.title)) ok = false;
    if (value.safer_way !== undefined && !this.string(value.safer_way, `${at}.safer_way`, undefined, PACK_RULE_LIMITS.saferWay)) ok = false;
    if (value.blockable !== undefined && typeof value.blockable !== "boolean") ok = this.fail(`${at}.blockable`, "must be a boolean");
    // A rule without bounds would block every action of its types: only a rule with bounds may block.
    if (value.blockable === true && value.param_bounds === undefined) ok = this.fail(`${at}.blockable`, "a rule that may block needs param_bounds");
    if (value.default_mode !== undefined && value.default_mode !== "monitor" && value.default_mode !== "block") ok = this.fail(`${at}.default_mode`, "must be monitor or block");
    if (value.default_mode === "block" && value.blockable !== true) ok = this.fail(`${at}.default_mode`, "only a blockable rule may block by default");
    // The recipes' shape is the pattern allowances' own (allowPatternErrors); what each recipe matches is the engine's.
    if (value.allow_patterns !== undefined) for (const error of allowPatternErrors(value.allow_patterns, `${at}.allow_patterns`)) ok = this.fail(at, error);
    if (!this.string(value.id, `${at}.id`, RULE_ID, 100)) ok = false;
    if (value.type !== "action_allowlist") ok = this.fail(`${at}.type`, "a pack rule is an action_allowlist clause");
    if (value.mode !== undefined && !["enforce", "monitor", "require_approval"].includes(value.mode as string)) ok = this.fail(`${at}.mode`, "must be enforce, monitor or require_approval");
    if (value.description !== undefined && !this.string(value.description, `${at}.description`, undefined, 1000)) ok = false;
    if (!this.strings(value.action_types, `${at}.action_types`, ACTION_TYPE)) ok = false;
    if (value.param_bounds !== undefined) {
      const bounds = value.param_bounds;
      if (typeof bounds !== "object" || bounds === null || Array.isArray(bounds) || Object.keys(bounds).length === 0) ok = this.fail(`${at}.param_bounds`, "must be a non-empty object");
      else for (const [name, b] of Object.entries(bounds)) {
        const ba = `${at}.param_bounds.${name}`;
        if (!PARAM.test(name)) { ok = this.fail(`${at}.param_bounds`, `"${name}" is not a parameter name`); continue; }
        if (typeof b === "object" && b !== null && !Array.isArray(b) && "items" in b) {
          if (!this.object(b, ba, ["items", "match"], ["items"])) { ok = false; continue; }
          if (!this.bound(b.items, `${ba}.items`)) ok = false;
          if (b.match !== undefined && b.match !== "all" && b.match !== "any") ok = this.fail(`${ba}.match`, "must be all or any");
        } else if (!this.bound(b, ba)) ok = false;
      }
    }
    return ok;
  }

  expected(value: unknown, at: string): boolean {
    if (Array.isArray(value)) return this.list(value, at, (x, a) => this.scalar(x, a), 0, PACK_LIMITS.maxList, false);
    if (typeof value === "object" && value !== null) {
      if (!this.object(value, at, ["digest_of"], ["digest_of"])) return false;
      return this.list((value as { digest_of: unknown }).digest_of, `${at}.digest_of`, (x, a) => typeof x === "string" || this.fail(a, "must be a string"), 1, 16, false);
    }
    return this.scalar(value, at);
  }

  vector(value: unknown, at: string): boolean {
    if (!this.object(value, at, ["id", "shell", "mcp", "expect"], ["id", "expect"])) return false;
    let ok = true;
    if (!this.string(value.id, `${at}.id`, RULE_ID, 100)) ok = false;
    if ((value.shell === undefined) === (value.mcp === undefined)) ok = this.fail(at, "needs exactly one of shell or mcp");
    if (value.shell !== undefined && this.object(value.shell, `${at}.shell`, ["command", "dialect"], ["command"])) {
      if (!this.string(value.shell.command, `${at}.shell.command`, undefined, 8000)) ok = false;
      if (value.shell.dialect !== undefined && value.shell.dialect !== "posix" && value.shell.dialect !== "powershell") ok = this.fail(`${at}.shell.dialect`, "must be posix or powershell");
    } else if (value.shell !== undefined) ok = false;
    if (value.mcp !== undefined && this.object(value.mcp, `${at}.mcp`, ["server", "tool", "args", "hint"], ["server", "tool", "args"])) {
      if (!this.string(value.mcp.server, `${at}.mcp.server`, undefined, 200)) ok = false;
      if (!this.string(value.mcp.tool, `${at}.mcp.tool`, undefined, 200)) ok = false;
      if (typeof value.mcp.args !== "object" || value.mcp.args === null || Array.isArray(value.mcp.args)) ok = this.fail(`${at}.mcp.args`, "must be an object");
      if (value.mcp.hint !== undefined && !this.string(value.mcp.hint, `${at}.mcp.hint`, undefined, 500)) ok = false;
    } else if (value.mcp !== undefined) ok = false;
    if (!this.list(value.expect, `${at}.expect`, (e, a) => {
      if (!this.object(e, a, ["action_type", "params"], ["action_type", "params"])) return false;
      let good = this.string(e.action_type, `${a}.action_type`, ACTION_TYPE, 100);
      const params = e.params;
      if (typeof params !== "object" || params === null || Array.isArray(params)) return this.fail(`${a}.params`, "must be an object");
      for (const [name, x] of Object.entries(params)) {
        if (!PARAM.test(name)) good = this.fail(`${a}.params`, `"${name}" is not a parameter name`);
        else if (!this.expected(x, `${a}.params.${name}`)) good = false;
      }
      return good;
    }, 0, 64, false)) ok = false;
    return ok;
  }
}

/** The action types a pack's `requires` names, when the member has that shape; empty otherwise. */
function requiredTypesOf(doc: unknown): Set<string> {
  const types = (doc as { requires?: { action_types?: unknown } } | null)?.requires?.action_types;
  return new Set(Array.isArray(types) ? types.filter((t): t is string => typeof t === "string") : []);
}

/** What `validatePack` reads a pack as. */
export interface PackValidationOptions {
  /** The engine level to read the pack at (default `PACK_ENGINE_LEVEL`). At level 1 every level-2 field is unknown, so a
   *  pack that uses one is invalid, exactly as an engine that predates level 2 reads it. */
  engine?: number;
}

/** Check a pack document against the closed format. It checks the shape only; the signature is the engine's to verify, and
 *  whether an engine can run the pack is `packEngineProblem`'s. */
export function validatePack(doc: unknown, options: PackValidationOptions = {}): PackValidation {
  const level = options.engine ?? PACK_ENGINE_LEVEL;
  const c = new Checker(level, level >= 2 ? requiredTypesOf(doc) : new Set());
  if (!c.object(doc, "pack", ["format", "id", "version", "issued_at", "title", ...(level >= 2 ? PACK_LEVEL2_FIELDS.pack : []), "signature", "grammars", "profiles", "rules", "vectors"],
    ["format", "id", "version", "issued_at", "signature", "grammars", "profiles", "rules", "vectors"])) return { valid: false, errors: c.errors };
  if (doc.format !== PACK_FORMAT) c.fail("pack.format", `must be "${PACK_FORMAT}"`);
  if (doc.requires !== undefined && c.object(doc.requires, "pack.requires", ["engine", "action_types"], ["engine"])) {
    c.integer(doc.requires.engine, "pack.requires.engine", 1, PACK_RULE_LIMITS.maxEngine);
    if (doc.requires.action_types !== undefined && c.list(doc.requires.action_types, "pack.requires.action_types", (t, a) => c.string(t, a, ACTION_TYPE, 100), 1, PACK_RULE_LIMITS.requiredTypes)) {
      for (const t of doc.requires.action_types as string[]) if (PACK_RESERVED_ACTION_TYPES.includes(t)) c.fail("pack.requires.action_types", `"${t}" is the call itself; a pack cannot emit it`);
    }
  }
  c.string(doc.id, "pack.id", PACK_ID);
  c.string(doc.version, "pack.version", VERSION, 40);
  if (c.string(doc.issued_at, "pack.issued_at", ISSUED_AT, 40) && !Number.isFinite(Date.parse(doc.issued_at))) c.fail("pack.issued_at", "is not a real time");
  if (doc.title !== undefined) c.string(doc.title, "pack.title", undefined, 120);
  if (c.object(doc.signature, "pack.signature", ["alg", "key_id", "value"], ["alg", "key_id", "value"])) {
    if (doc.signature.alg !== "Ed25519") c.fail("pack.signature.alg", "must be Ed25519");
    c.string(doc.signature.key_id, "pack.signature.key_id", KEY_ID, 128);
    c.string(doc.signature.value, "pack.signature.value", SIG, 100);
  }
  const ids = (list: unknown, at: string): void => {
    if (!Array.isArray(list)) return;
    const seen = new Set<string>();
    for (const item of list) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id === "string") { if (seen.has(id)) c.fail(at, `id "${id}" is used twice`); seen.add(id); }
    }
  };
  c.list(doc.grammars, "pack.grammars", (g, a) => c.grammar(g, a), 0, PACK_LIMITS.maxGrammars, false);
  ids(doc.grammars, "pack.grammars");
  c.list(doc.profiles, "pack.profiles", (p, a) => c.profile(p, a), 0, PACK_LIMITS.maxProfiles, false);
  ids(doc.profiles, "pack.profiles");
  c.list(doc.rules, "pack.rules", (r, a) => c.rule(r, a), 0, PACK_LIMITS.maxRules, false);
  ids(doc.rules, "pack.rules");
  c.list(doc.vectors, "pack.vectors", (v, a) => c.vector(v, a), 1, PACK_LIMITS.maxVectors, false);
  ids(doc.vectors, "pack.vectors");
  if (Array.isArray(doc.grammars) && Array.isArray(doc.profiles) && doc.grammars.length + doc.profiles.length === 0) c.fail("pack", "has no grammar and no profile");
  // A program named by two grammars would make the result depend on their order.
  if (Array.isArray(doc.grammars)) {
    const owner = new Map<string, string>();
    for (const g of doc.grammars as Array<{ id?: string; programs?: unknown }>) {
      for (const p of Array.isArray(g?.programs) ? g.programs : []) {
        if (typeof p !== "string") continue;
        const prior = owner.get(p);
        if (prior !== undefined && prior !== g.id) c.fail("pack.grammars", `program "${p}" is read by two grammars (${prior}, ${String(g.id)})`);
        owner.set(p, String(g.id));
      }
    }
  }
  // A level-2 field makes a pack level 2, and the pack says so: an engine that reads `requires` then knows what it needs.
  const used = [...c.level2, ...(requiredTypesOf(doc).size ? ["pack.requires.action_types"] : [])];
  const engine = (doc.requires as { engine?: unknown } | undefined)?.engine;
  if (used.length && !(typeof engine === "number" && engine >= 2)) c.fail("pack.requires", `the pack uses level-2 fields (${used.slice(0, 3).join(", ")}) and must say requires.engine 2 or more`);
  return { valid: c.errors.length === 0, errors: c.errors };
}

/** Why an engine at `level` cannot run a (valid) pack, or null when it can: its `requires.engine` is above the engine's level
 *  (`engine_too_old`, `needs` the level it asks for), or it names an action type `knows` does not (`unknown_action_type`,
 *  `needs` the first such type). A pack without `requires` is level 1. */
export function packEngineProblem(pack: { requires?: PackRequires }, level: number = PACK_ENGINE_LEVEL, knows: (type: string) => boolean = (t) => getActionType(t) !== undefined):
  { reason: "engine_too_old"; needs: number } | { reason: "unknown_action_type"; needs: string } | null {
  const needs = pack.requires?.engine ?? 1;
  if (needs > level) return { reason: "engine_too_old", needs };
  const unknown = (pack.requires?.action_types ?? []).find((t) => !knows(t));
  return unknown === undefined ? null : { reason: "unknown_action_type", needs: unknown };
}

/** The engine level a pack document asks for (`requires.engine`; 1 without it), read before the pack is validated, so an
 *  engine can tell "too new for me" from "broken". Null when the member is there but is not a level. */
export function packRequiredEngine(doc: unknown): number | null {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const requires = (doc as { requires?: { engine?: unknown } | null }).requires;
  if (requires === undefined) return 1;
  const engine = requires?.engine;
  return Number.isInteger(engine) && (engine as number) >= 1 && (engine as number) <= PACK_RULE_LIMITS.maxEngine ? engine as number : null;
}
