// Rules you can actually read and change.
//
// The site says "set rules in plain terms" and "it is a plain JSON file — edit the
// limits". What `init` wrote was 6.7 KB of generated regular expression: the `safe-shell`
// clause alone is a ~700-character case-folded negative lookahead. Nobody edits that, so
// in practice the starter policy was the *only* policy and "set your own rules" was not
// true.
//
// The fix is not to weaken the patterns — they are careful, and the canonicalization
// tests exist because bypasses are subtle. It is to stop making the pattern the
// interface. The lists the patterns are built from live in `.scopebond/rules.json`, a
// short readable file, and `policy.json` is compiled from it. The regex stays as the
// compiled form.
//
// `compile()` reproduces the shipped starter policy's enforcement patterns exactly —
// `rules.test.mjs` asserts that against `starterPolicy()`, so a change here cannot
// quietly alter what is enforced.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ci, under, named, dir, DESTRUCTIVE } from "./runtime.js";

/** One protected location. `under`/`named`/`dir` are the readable, editable shapes;
 *  `raw` carries the few patterns with bespoke exceptions (`.env` templates are allowed,
 *  `.ssh/config` and `*.pub` are allowed) that no simple shape expresses. */
export type PathRule =
  | { kind: "under"; value: string; label: string }
  | { kind: "named"; value: string; label: string }
  | { kind: "dir"; value: string; label: string }
  | { kind: "raw"; pattern: string; label: string };

export interface RuleSet {
  version: 1;
  /** Refs an agent may not push to. `release/*` means the prefix `release/`. */
  protected_branches: string[];
  /** Programs an agent may not run, in any case and with or without .exe. */
  destructive_programs: string[];
  protected_write: PathRule[];
  protected_read: PathRule[];
  /** Action types recorded but not blocked. */
  observe: string[];
}

export const RULES_FILE = "rules.json";

const pathPattern = (rule: PathRule): string =>
  rule.kind === "under" ? under(rule.value)
    : rule.kind === "named" ? named(rule.value)
    : rule.kind === "dir" ? dir(rule.value)
    : rule.pattern;

/** A protected-path rule from a plain path the user typed. A trailing `/` (or a path with
 *  no dot in its last segment) reads as a directory; anything else as a file name. */
export function pathRuleFor(input: string): PathRule {
  const clean = input.trim().replace(/^[./\\]+/, (m) => (m.startsWith(".") && !m.startsWith("./") ? m : "")).replace(/\\/g, "/");
  const escaped = clean.replace(/[.*+?^${}()|[\]]/g, "\\$&").replace(/\/$/, "");
  const isDirectory = input.trim().endsWith("/") || !/\.[^/]*$/.test(clean);
  return isDirectory
    ? { kind: "under", value: escaped, label: `${clean.replace(/\/$/, "")}/ and everything in it` }
    : { kind: "named", value: escaped, label: clean };
}

/** The branch pattern: deny the listed refs, plus the "every branch at once" flags and a
 *  push whose destination could not be read. `--tags` alone is allowed. */
function branchPattern(branches: string[]): string {
  const exact = branches.filter((b) => !b.endsWith("/*"));
  const prefixes = branches.filter((b) => b.endsWith("/*")).map((b) => b.slice(0, -1));
  const parts = [
    exact.length ? `(?!(?:${exact.map(ci).join("|")})$)` : "",
    ...prefixes.map((p) => `(?!${ci(p)})`),
    `(?!-(?!-${ci("tags")}$))`,
  ];
  return `^${parts.join("")}.+`;
}

const programPattern = (programs: string[]): string =>
  `^(?!(?:${programs.map(ci).join("|")})(?:${ci("\\.(?:exe|cmd|bat|com|ps1)")})?$).+`;

const pathsPattern = (rules: PathRule[]): string => `^${rules.map(pathPattern).join("")}.+`;

/** A sentence listing what a clause covers, generated from the list rather than written by
 *  hand — so it stays true after an edit. The block message quotes this, so a stale
 *  description would be a lie told at the worst moment. */
function sentence(items: string[], limit = 12): string {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
}

/** Compile a rule set into the policy the gateway evaluates. */
export function compile(rules: RuleSet, agentKid: string): Record<string, unknown> {
  return {
    vocabulary_version: "1.0", policy_id: "coding-agent", version: 1,
    clauses: [
      {
        id: "protect-branches", type: "action_allowlist", mode: "enforce", action_types: ["git.push"],
        param_bounds: { ref: { pattern: branchPattern(rules.protected_branches) } },
        description: `Deny pushes to ${sentence(rules.protected_branches)} (any case, any refspec spelling), pushes of every branch at once (--all, --mirror) and pushes whose destination cannot be read from the command (a git alias, a configured push refspec, send-pack). A tags-only push (--tags) is allowed. Change these in .scopebond/${RULES_FILE}.`,
      },
      {
        id: "safe-shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"],
        param_bounds: { program: { pattern: programPattern(rules.destructive_programs) } },
        description: `Deny destructive programs (${sentence(rules.destructive_programs, 10)}) in any case and with or without .exe. An empty program — a command that could not be parsed, or whose program is only known at run time ($VAR, $(…), eval of a variable) — is denied. Argument-shaped deletion (find -delete, git clean) is not a program name and is not covered here. Change this list in .scopebond/${RULES_FILE}.`,
      },
      {
        id: "protect-write", type: "action_allowlist", mode: "enforce", action_types: ["file.write"],
        param_bounds: { path: { pattern: pathsPattern(rules.protected_write) } },
        description: `Allow workspace writes, but never to ${sentence(rules.protected_write.map((r) => r.label))}. Case-insensitive. Change this list in .scopebond/${RULES_FILE}.`,
      },
      {
        id: "protect-read", type: "action_allowlist", mode: "enforce", action_types: ["file.read"],
        param_bounds: { path: { pattern: pathsPattern(rules.protected_read) } },
        description: `Allow workspace reads, but never ${sentence(rules.protected_read.map((r) => r.label))}. Case-insensitive. Change this list in .scopebond/${RULES_FILE}.`,
      },
      {
        id: "observe-net-mcp", type: "action_allowlist", mode: "monitor",
        action_types: rules.observe,
        description: `Observe ${sentence(rules.observe)} — recorded, not blocked. Add bounds to enforce. Change this list in .scopebond/${RULES_FILE}.`,
      },
      { id: "keys", type: "key_policy", active_keys: [agentKid], description: "Only the enrolled machine key may sign." },
    ],
  };
}

/** The shipped defaults. Every entry here reproduces one piece of the starter policy's
 *  patterns; `rules.test.mjs` pins that equivalence. */
export function defaultRules(): RuleSet {
  return {
    version: 1,
    protected_branches: ["main", "master", "release/*"],
    destructive_programs: [...DESTRUCTIVE],
    protected_write: [
      { kind: "under", value: "\\.scopebond", label: "the hook's own policy and keys (.scopebond)" },
      { kind: "raw", pattern: `(?!(?:.*/)?${ci("\\.claude/settings")})`, label: "Claude Code settings" },
      { kind: "under", value: "\\.claude/hooks", label: "Claude Code hooks" },
      { kind: "under", value: "\\.claude/agents", label: "Claude Code agents" },
      { kind: "raw", pattern: `(?!(?:.*/)?${ci("\\.cursor/hooks")})`, label: "Cursor hook settings" },
      { kind: "named", value: "\\.codex/hooks\\.json", label: "Codex hook settings" },
      { kind: "named", value: "\\.codex/config\\.toml", label: "Codex config" },
      { kind: "named", value: "\\.mcp\\.json", label: ".mcp.json" },
      { kind: "under", value: "\\.git/hooks", label: "git hooks" },
      { kind: "named", value: "\\.git/config", label: "git config" },
      { kind: "under", value: "\\.husky", label: "Husky hooks" },
      { kind: "under", value: "\\.github/workflows", label: "GitHub workflows" },
      { kind: "under", value: "\\.github/actions", label: "GitHub actions" },
      { kind: "named", value: "\\.gitlab-ci\\.yml", label: ".gitlab-ci.yml" },
      { kind: "named", value: "\\.gitlab-ci\\.yaml", label: ".gitlab-ci.yaml" },
      { kind: "under", value: "\\.circleci", label: "CircleCI config" },
      { kind: "named", value: "azure-pipelines\\.yml", label: "azure-pipelines.yml" },
      { kind: "named", value: "Jenkinsfile", label: "Jenkinsfile" },
    ],
    protected_read: [
      { kind: "under", value: "\\.scopebond", label: "the hook's own policy and keys (.scopebond)" },
      { kind: "raw", pattern: `(?!.*${ci("\\.(?:key|pem|p12|pfx|jks|keystore)")}$)`, label: "signing keys and key containers (*.key, *.pem, *.p12, *.pfx, *.jks)" },
      {
        kind: "raw",
        pattern: `(?!(?:.*/)?${ci("\\.env")}(?!(?:\\.[^/]*)?\\.(?:${ci("example")}|${ci("sample")}|${ci("template")}|${ci("dist")})$)(?:\\.[^/]*)?$)`,
        label: "environment secret files (.env, .env.* — except .example/.sample/.template/.dist)",
      },
      { kind: "named", value: "\\.envrc", label: ".envrc" },
      {
        kind: "raw",
        pattern: `(?!(?:.*/)?${ci("\\.ssh")}(?:$|/(?!.*${ci("\\.pub")}$)(?!${ci("known_hosts")}$)(?!${ci("config")}$)))`,
        label: "SSH private keys and the .ssh directory (public keys, known_hosts and config are allowed)",
      },
      { kind: "raw", pattern: `(?!(?:.*/)?${ci("\\.aws")}(?:$|/(?!${ci("config")}$)))`, label: "AWS credentials (.aws, except .aws/config)" },
      { kind: "named", value: "\\.npmrc", label: ".npmrc" },
      { kind: "named", value: "\\.pypirc", label: ".pypirc" },
      { kind: "named", value: "\\.netrc", label: ".netrc" },
      { kind: "named", value: "_netrc", label: "_netrc" },
      { kind: "named", value: "\\.git-credentials", label: ".git-credentials" },
      { kind: "dir", value: "\\.kube", label: "the .kube directory" },
      { kind: "named", value: "\\.kube/config", label: ".kube/config" },
      { kind: "dir", value: "\\.docker", label: "the .docker directory" },
      { kind: "named", value: "\\.docker/config\\.json", label: ".docker/config.json" },
      { kind: "under", value: "\\.config/gcloud", label: "gcloud credentials" },
      { kind: "under", value: "\\.azure", label: "Azure credentials" },
      { kind: "under", value: "\\.gnupg", label: "GnuPG keys" },
      { kind: "dir", value: "\\.config/gh", label: "the GitHub CLI config directory" },
      { kind: "named", value: "\\.config/gh/hosts\\.yml", label: "the GitHub CLI's hosts.yml" },
      { kind: "named", value: "\\.claude/\\.credentials\\.json", label: "Claude Code's .credentials.json" },
    ],
    observe: ["net.fetch", "mcp.tool.call"],
  };
}

export const rulesPath = (dir: string): string => join(dir, RULES_FILE);

export function loadRules(configDir: string): RuleSet | null {
  const file = rulesPath(configDir);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RuleSet;
    if (parsed?.version !== 1 || !Array.isArray(parsed.protected_branches)) return null;
    return parsed;
  } catch { return null; }
}

export function saveRules(configDir: string, rules: RuleSet): string {
  const file = rulesPath(configDir);
  writeFileSync(file, `${JSON.stringify(rules, null, 2)}\n`);
  return file;
}

/** Plain English, for `scopebond-hook rules`. */
export function describeRules(rules: RuleSet): string {
  const lines: string[] = [];
  lines.push("Blocked before it runs:");
  lines.push("");
  lines.push(`  pushes to          ${rules.protected_branches.join(", ")}`);
  lines.push(`                     and any push whose destination cannot be read`);
  lines.push(`  programs           ${rules.destructive_programs.join(", ")}`);
  lines.push("");
  lines.push(`  writes to          ${rules.protected_write.length} protected location(s):`);
  for (const rule of rules.protected_write) lines.push(`                       ${rule.label}`);
  lines.push("");
  lines.push(`  reads of           ${rules.protected_read.length} protected location(s):`);
  for (const rule of rules.protected_read) lines.push(`                       ${rule.label}`);
  lines.push("");
  lines.push("Recorded, not blocked:");
  lines.push(`  ${rules.observe.join(", ")}`);
  return lines.join("\n");
}
