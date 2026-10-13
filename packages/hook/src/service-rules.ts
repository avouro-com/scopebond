// Blocked services: MCP servers, hosts, programs and packages a workspace blocks by name.
//
// A workspace may send a `blocked_services` list in its rules document (only to a hook that reports the `service_rules`
// capability): `[{ kind: "mcp_server" | "host" | "cli" | "package", key }]`, at most 500 entries, each key at most 200
// characters. The list is digested with the rules (`rules_digest` covers `{ rules, blocked_services }` when the list is
// present), so a changed list is refused like changed rules, and a malformed one refuses the whole document.
//
// The list is compiled into policy clauses, one per kind, placed after the ordinary rules, so a block is decided, recorded
// and explained like any other rule block and can be checked again from the receipt and the policy it names:
//
//   mcp_server  an `mcp.tool.call` whose server's configured name contains the key as a word (or a run of words): the word
//               rule that recognises a server (mcp-profiles.ts): the name is split at every character that is not a letter or
//               a digit, case-insensitively. `github` blocks `github`, `github-mcp` and `plugin_github_github`, not `githubx`.
//   host        a `net.fetch` whose host is the key, case-insensitively. A key with a port (`host:port`) blocks that port
//               only; a key without one blocks the host on every port.
//   cli         a `shell.exec` whose program is the key, case-insensitively, with or without a path or an executable suffix
//               (.exe, .cmd, .bat, .com, .ps1): `terraform` blocks `terraform`, `/usr/bin/terraform` and `Terraform.exe`.
//   package     an install that names the package: the key is `<manager>:<name>` (`npm:zod`, `pip:requests`), matched exactly
//               on the manager and the package name the hook reports for the install. Such an install is evaluated as a
//               `package.install` action beside its command (`{ manager, name, package_key }`), only when its package is
//               blocked, so every other install is recorded exactly as before.
//
// A leaf module (no local imports): managed.ts, runtime.ts and explain.ts all read it.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BLOCKED_SERVICE_KINDS = ["mcp_server", "host", "cli", "package"] as const;
export type BlockedServiceKind = (typeof BLOCKED_SERVICE_KINDS)[number];
export interface BlockedService { kind: BlockedServiceKind; key: string }
export const MAX_BLOCKED_SERVICES = 500;
export const MAX_BLOCKED_SERVICE_KEY = 200;
/** The capability a hook reports so its workspace sends `blocked_services`. */
export const SERVICE_RULES_CAPABILITY = "service_rules";
/** The reason a blocked service gives for a denial. */
export const BLOCKED_SERVICE_REASON = "blocked_service";

/** The clause that carries each kind, and the action and parameter it reads. */
export const BLOCKED_SERVICE_CLAUSES: Readonly<Record<BlockedServiceKind, { id: string; action: string; param: string }>> = {
  mcp_server: { id: "blocked-mcp-servers", action: "mcp.tool.call", param: "server" },
  host: { id: "blocked-hosts", action: "net.fetch", param: "host" },
  cli: { id: "blocked-programs", action: "shell.exec", param: "program" },
  package: { id: "blocked-packages", action: "package.install", param: "package_key" },
};
const KIND_OF_CLAUSE: ReadonlyMap<string, BlockedServiceKind> = new Map(BLOCKED_SERVICE_KINDS.map((kind) => [BLOCKED_SERVICE_CLAUSES[kind].id, kind]));
/** The kind a clause id blocks, when it is a blocked-service clause. */
export const blockedServiceKindOf = (clauseId: string | null | undefined): BlockedServiceKind | null => KIND_OF_CLAUSE.get(clauseId ?? "") ?? null;
/** The kind, as a sentence names it. */
export const BLOCKED_SERVICE_LABEL: Readonly<Record<BlockedServiceKind, string>> = { mcp_server: "MCP server", host: "host", cli: "program", package: "package" };

// The keys each kind accepts: the shapes a workspace's services inventory keys them by. Anything else refuses the document.
const MCP_KEY = /^(?=[^A-Za-z0-9]*[A-Za-z0-9])[A-Za-z0-9_.:@+-]{1,200}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: the inner class cannot contain the final character class's boundary twice; bounded to 200 characters by the caller
const HOST_KEY = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
const CLI_KEY = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
// eslint-disable-next-line security/detect-unsafe-regex -- linear: anchored; the optional scope ends at its own `/`
const PACKAGE_KEY = /^[a-z0-9-]{1,20}:(?:@[A-Za-z0-9._~-]{1,100}\/)?[A-Za-z0-9._~-]{1,214}$/;
const KEY_SHAPE: Readonly<Record<BlockedServiceKind, RegExp>> = { mcp_server: MCP_KEY, host: HOST_KEY, cli: CLI_KEY, package: PACKAGE_KEY };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether one entry is well formed: exactly `kind` and `key`, a known kind, a key of that kind's shape. */
export function validBlockedService(entry: unknown): entry is BlockedService {
  if (!isObject(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 2 || !keys.includes("kind") || !keys.includes("key")) return false;
  const { kind, key } = entry;
  if (typeof kind !== "string" || !(BLOCKED_SERVICE_KINDS as readonly string[]).includes(kind)) return false;
  if (typeof key !== "string" || key.length < 1 || key.length > MAX_BLOCKED_SERVICE_KEY || key.includes("..")) return false;
  if (kind === "host" && Number(key.split(":")[1] ?? "1") > 65535) return false;
  return KEY_SHAPE[kind as BlockedServiceKind].test(key);
}

/** Whether a rules document's `blocked_services` is a valid list (at most 500 entries, each valid). The order is the
 *  workspace's (by kind, then key); it is part of the digest, so it is not checked again here. */
export function validBlockedServices(list: unknown): list is BlockedService[] {
  return Array.isArray(list) && list.length <= MAX_BLOCKED_SERVICES && list.every(validBlockedService);
}

// --- patterns ----------------------------------------------------------------------------------------------------------------
// Policy patterns are plain regular expressions with no flags, so case-insensitivity is spelled out per letter.

const escapeRegex = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
/** A literal, any case. The two characters that lower-case to an ASCII letter (U+0130 to `i`, U+212A to `k`) are included,
 *  so a name cannot dodge a key by spelling one of its letters that way. */
const anyCase = (text: string): string => escapeRegex(text).replace(/[A-Za-z]/g, (c) => {
  const l = c.toLowerCase();
  return `[${l}${c.toUpperCase()}${l === "i" ? "\\u0130" : l === "k" ? "\\u212A" : ""}]`;
});
const NOT_WORD = "[^A-Za-z0-9\\u0130\\u212A]";

/** The words of a server key, as the word rule splits a configured name. */
const wordsOf = (key: string): string[] => key.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A pattern that matches the parameter value naming this entry (unanchored for an MCP server, whole value otherwise). */
export function servicePattern(entry: BlockedService): string {
  switch (entry.kind) {
    case "mcp_server":
      return `(?:^|${NOT_WORD})${wordsOf(entry.key).map(anyCase).join(`${NOT_WORD}+`)}(?:${NOT_WORD}|$)`;
    case "host": {
      const at = entry.key.indexOf(":");
      const host = at < 0 ? entry.key : entry.key.slice(0, at);
      // A trailing dot names the same host. Without a port in the key, any port.
      return `^${anyCase(host)}\\.?${at < 0 ? "(?::[0-9]+)?" : `:${escapeRegex(entry.key.slice(at + 1))}`}$`;
    }
    case "cli":
      return `^(?:[\\s\\S]*[\\\\/])?${anyCase(entry.key)}(?:\\.(?:${["exe", "cmd", "bat", "com", "ps1"].map(anyCase).join("|")}))?$`;
    case "package":
      return `^${escapeRegex(entry.key)}$`;
  }
}

/** Whether a parameter value names this entry. */
export function serviceMatches(entry: BlockedService, value: unknown): boolean {
  // eslint-disable-next-line security/detect-non-literal-regexp -- built here from a validated key, every character escaped
  return typeof value === "string" && new RegExp(servicePattern(entry)).test(value);
}

const listed = (keys: readonly string[]): string => keys.length <= 10 ? keys.join(", ") : `${keys.slice(0, 10).join(", ")} and ${keys.length - 10} more`;

/** The policy clauses for a list: one per kind that has entries, each allowing every value except the ones it names. A value
 *  of another type (a missing server or host) is denied, as every bounded parameter is. */
export function blockedServiceClauses(list: readonly BlockedService[] | undefined): Array<Record<string, unknown>> {
  if (!list?.length) return [];
  const clauses: Array<Record<string, unknown>> = [];
  for (const kind of BLOCKED_SERVICE_KINDS) {
    const entries = list.filter((e) => e.kind === kind);
    if (!entries.length) continue;
    const { id, action, param } = BLOCKED_SERVICE_CLAUSES[kind];
    const any = entries.map(servicePattern).join("|");
    const keys = entries.map((e) => e.key);
    const label = BLOCKED_SERVICE_LABEL[kind];
    clauses.push({
      id, type: "action_allowlist", mode: "enforce", action_types: [action],
      param_bounds: { [param]: { pattern: kind === "mcp_server" ? `^(?![\\s\\S]*?(?:${any}))[\\s\\S]*$` : `^(?!(?:${any}))[\\s\\S]*$` } },
      description: `Deny ${kind === "mcp_server" ? "calls to the" : kind === "host" ? "web requests to the" : kind === "cli" ? "running the" : "installing the"} ${label}${keys.length > 1 ? "s" : ""} your workspace blocks: ${listed(keys)}. Set by your workspace.`,
    });
  }
  return clauses;
}

/** The blocked-packages clause's pattern in a policy, or null when the policy blocks no package. */
export function blockedPackagePattern(policy: unknown): RegExp | null {
  const clauses = (policy as { clauses?: unknown[] } | null)?.clauses;
  for (const clause of Array.isArray(clauses) ? clauses : []) {
    const c = clause as { id?: unknown; param_bounds?: Record<string, { pattern?: unknown }> };
    if (c?.id !== BLOCKED_SERVICE_CLAUSES.package.id) continue;
    const pattern = c.param_bounds?.package_key?.pattern;
    // eslint-disable-next-line security/detect-non-literal-regexp -- the policy's own clause, compiled once per runtime as the evaluator compiles it
    try { return typeof pattern === "string" ? new RegExp(pattern) : null; } catch { return null; }
  }
  return null;
}

/** The entry a denied action names, from the list in force: what an explanation shows. Null when none does. */
export function blockedServiceOf(kind: BlockedServiceKind, params: Record<string, unknown> | undefined, list: readonly BlockedService[]): BlockedService | null {
  const value = params?.[BLOCKED_SERVICE_CLAUSES[kind].param];
  return list.find((e) => e.kind === kind && serviceMatches(e, value)) ?? null;
}

/** The list in this folder's rules document (managed-rules.json, as managed.ts names it); empty when there is none. */
export function readBlockedServices(dir: string): BlockedService[] {
  try {
    const doc = JSON.parse(readFileSync(join(dir, "managed-rules.json"), "utf8")) as { blocked_services?: unknown };
    return Array.isArray(doc.blocked_services) ? doc.blocked_services.filter(validBlockedService) : [];
  } catch { return []; }
}
