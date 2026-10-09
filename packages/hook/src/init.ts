// `scopebond-hook init` — scaffold the local enrollment: a machine signing key, a
// gateway countersigning key and a starter policy. Keys and receipts stay on the
// machine; no credentials are handled.

import { copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDir, loadOrCreateAttester } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import { compile, createRules, defaultRules, loadRules, saveRules, rulesPath } from "./rules.js";
import { createExclusive, replaceFile } from "./safe-fs.js";
import {
  readHarnessConfig, projectHarnessFile, localHarnessFile, harnessEntryMatches, backupHarnessConfig,
  gitShareState, excludeFromGit, pruneHarnessEntries, configuredHookCommands, isMachineSpecificCommand,
} from "./install.js";
import { hookCommand } from "./version.js";
import { loadOrCreateDigestKey } from "./minimize.js";

export function scaffold(dir: string, opts: { force?: boolean; enforce?: readonly string[] } = {}): { agentKid: string; policyPath: string; rulesPath: string } {
  mkdirSync(dir, { recursive: true });
  // Keys, the Cloud credential and the receipt log live here: readable by this user alone, from their first byte.
  ensurePrivateDir(dir);
  const keyPath = join(dir, "agent.key");
  const attesterPath = join(dir, "attester.key");
  const policyPath = join(dir, "policy.json");
  // Never let the signing keys, the Cloud credential or the local log be committed.
  const gitignorePath = join(dir, ".gitignore");
  createExclusive(gitignorePath, "*\n");
  // Machine signing key (agent) + gateway countersigning key (attester). Reused if present.
  loadOrCreateAttester({ file: keyPath });
  loadOrCreateAttester({ file: attesterPath });
  // The per-machine key for keyed command and argument digests (see minimize.ts).
  loadOrCreateDigestKey(dir);
  const agent = createSigner({ privateKeyPem: readFileSync(keyPath, "utf8") });
  // The editable rule set beside the compiled policy, so "edit the limits" means editing a
  // readable list rather than a 700-character lookahead. `compile(defaultRules())` produces
  // the starter policy's exact patterns — `rules.test.mjs` pins that — so writing either
  // form enforces the same thing.
  const rulesFile = rulesPath(dir);
  // Without --force each file is written only when absent; the exclusive create is the check.
  const starterRules = { ...defaultRules(), enforce: [...(opts.enforce ?? [])] };
  if (opts.force) saveRules(dir, starterRules); else createRules(dir, starterRules);
  const policyText = (): string => JSON.stringify(compile(loadRules(dir) ?? defaultRules(), agent.kid), null, 2) + "\n";
  if (opts.force) replaceFile(policyPath, policyText()); else createExclusive(policyPath, policyText);
  return { agentKid: agent.kid, policyPath, rulesPath: rulesFile };
}

/** The clause ids a policy compiled from the rule set carries (with the optional ones). */
const GENERATED_IDS = new Set(["protect-scopebond-write", "protect-scopebond-read", "protect-branches", "safe-shell", "protect-write", "protect-read",
  "observe-net-mcp", "protect-root", "protect-remote-database", "keys"]);

/** One-time move to the monitor default (rules record what they would have stopped; only Scopebond's own protection blocks).
 *  A rule set written before it has no `enforce` list; it gets an empty one and the policy is recompiled, the previous policy
 *  kept beside it. A computer whose rules a workspace manages is left alone (the workspace's document decides), and so is a
 *  policy a person edited by hand (clauses this hook does not generate). Returns whether anything changed. */
export function migrateToMonitorDefault(dir: string): boolean {
  const policyPath = join(dir, "policy.json");
  if (existsSync(join(dir, "managed-rules.json"))) return false;
  // No rule set (loadRules gives null) or no policy (the read below fails): nothing to move.
  const rules = loadRules(dir);
  if (!rules || Array.isArray(rules.enforce)) return false;
  try {
    const policy = JSON.parse(readFileSync(policyPath, "utf8").replace(/^\uFEFF/, "")) as { clauses?: Array<{ id?: unknown }> };
    if (!Array.isArray(policy.clauses) || policy.clauses.some((c) => !GENERATED_IDS.has(String(c?.id)))) return false;
  } catch { return false; }
  const agent = createSigner({ privateKeyPem: readFileSync(join(dir, "agent.key"), "utf8") });
  copyFileSync(policyPath, join(dir, "policy.previous.json"));
  saveRules(dir, { ...rules, enforce: [] });
  replaceFile(policyPath, JSON.stringify(compile({ ...rules, enforce: [] }, agent.kid), null, 2) + "\n");
  return true;
}

/** Where `init` put the hook, and why — for the lines it prints. */
export interface HookPlacement {
  /** The config file written. */
  file: string;
  /** The command written into it. */
  command: string;
  /** `shared`: the project config a team commits (portable command only).
   *  `personal`: a file only this clone uses (the pinned, machine-specific command). */
  scope: "shared" | "personal";
  /** One line for the user when the placement differs from what they might expect. */
  note?: string;
  /** Machine-specific entries moved out of a shared config file (a repair). */
  repaired: number;
}

/** Place the hook for a project so that nothing machine-specific reaches a file git
 *  shares. A pinned command (`"<node>" "<…/cli.js>" claude`) is fast but names paths that
 *  exist only here; in a committed `.claude/settings.json` it cannot start on a
 *  teammate's machine, and an agent treats a hook that cannot start as a non-blocking
 *  error — so the agent there would run unchecked, while the file says it is governed.
 *
 *  - `shared` (or no pinned command): the portable `npx` form in the project config.
 *  - Claude Code, pinned: `.claude/settings.local.json`, kept out of git for this clone;
 *    any machine-specific entry an older `init` wrote into `settings.json` is removed.
 *  - Cursor / Codex, pinned: they have no personal file, so the project file is used
 *    only if git does not already track it (then excluded for this clone); a tracked
 *    file gets the portable form. */
export function placeHook(
  harness: "claude" | "cursor" | "codex",
  cwd: string,
  pinned: string | undefined,
  opts: { shared?: boolean } = {},
): HookPlacement {
  const shared = projectHarnessFile(harness, cwd);
  const portable = hookCommand(harness);
  const local = localHarnessFile(harness, cwd);
  if (opts.shared || !pinned) {
    const file = installHarness(harness, cwd, portable);
    // One hook per project: a personal copy beside a shared one would check every action twice.
    if (local) pruneHarnessEntries(local, () => true);
    return { file, command: portable, scope: "shared", repaired: 0 };
  }
  if (local) {
    const state = gitShareState(local);
    if (state === "tracked") {
      const file = installHarness(harness, cwd, portable);
      return { file, command: portable, scope: "shared", repaired: 0,
        note: `${local} is committed to git, so the portable command was used (it starts on any machine)` };
    }
    // An existing portable hook in the shared file is the team's; leave it rather than
    // running two hooks, and say how to get the fast one.
    if (configuredHookCommands(shared).some((c) => !isMachineSpecificCommand(c))) {
      return { file: shared, command: portable, scope: "shared", repaired: 0,
        note: `kept the shared hook already in ${shared}; remove it there to pin a faster one on this machine` };
    }
    // A personal file git would still add is not personal: if it cannot be excluded,
    // fall back to the portable command rather than leave a pinned path to be committed.
    if (state === "untracked" && !excludeFromGit(local)) {
      const file = installHarness(harness, cwd, portable);
      pruneHarnessEntries(local, () => true);
      pruneHarnessEntries(shared, isMachineSpecificCommand);
      return { file, command: portable, scope: "shared", repaired: 0,
        note: `${local} could not be kept out of git, so the portable command was used` };
    }
    const file = installHarness(harness, cwd, pinned, local);
    const repaired = pruneHarnessEntries(shared, isMachineSpecificCommand);
    return { file, command: pinned, scope: "personal", repaired };
  }
  const state = gitShareState(shared);
  if (state === "tracked") {
    const file = installHarness(harness, cwd, portable);
    return { file, command: portable, scope: "shared", repaired: 0,
      note: `${shared} is committed to git, so the portable command was used (it starts on any machine)` };
  }
  if (state === "untracked" && !excludeFromGit(shared)) {
    const file = installHarness(harness, cwd, portable);
    return { file, command: portable, scope: "shared", repaired: 0,
      note: `${shared} could not be kept out of git, so the portable command was used` };
  }
  const file = installHarness(harness, cwd, pinned);
  return { file, command: pinned, scope: "personal", repaired: 0 };
}

/** Install the hook into the agent's own config file, merging with anything already
 *  there (idempotent — safe to run twice). Returns the file it wrote. This is what
 *  lets `connect` finish setup without the user hand-editing JSON.
 *  `cwd` defaults to the current directory (the project root the user runs it in).
 *  Writes exactly where it is told; `placeHook` decides where a command may go. */
export function installHarness(
  harness: "claude" | "cursor" | "codex",
  cwd: string = process.cwd(),
  /** The command to run per tool call. Defaults to the portable `npx` form. */
  command?: string,
  /** The file to write; defaults to the shared project config. */
  target?: string,
): string {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const file = target ?? projectHarnessFile(harness, cwd);
  const config = readHarnessConfig(file); // throws, leaving the file intact, if it is not a JSON object
  backupHarnessConfig(file); // keep the user's original beside it before the first change
  mkdirSync(dirname(file), { recursive: true });
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  const forHarness = (h: "claude" | "cursor" | "codex"): string =>
    command ? command.replace(/\b(claude|cursor|codex)$/, h) : hookCommand(h);
  const cursorCmd = forHarness("cursor");
  const claudeCmd = forHarness("claude");
  const codexCmd = forHarness("codex");
  // Match any existing Scopebond hook entry — npx, pinned absolute (either path
  // separator) or a legacy bare `scopebond-hook` — so re-running replaces the entry
  // instead of appending a second one. One shared matcher with `install`: a private
  // copy here missed the pinned Windows form and duplicated the hook.
  const entryMatches = harnessEntryMatches;
  if (harness === "cursor") {
    config.version = config.version ?? 1;
    for (const event of ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "afterFileEdit"]) {
      const list = Array.isArray((hooks)[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
      const existing = list.findIndex(entryMatches);
      if (existing >= 0) list[existing] = { command: cursorCmd }; else list.push({ command: cursorCmd });
    }
  } else {
    const list = Array.isArray((hooks).PreToolUse) ? (hooks as Record<string, unknown[]>).PreToolUse : ((hooks as Record<string, unknown[]>).PreToolUse = []);
    const existing = list.findIndex(entryMatches);
    // Codex matchers are regular expressions. No matcher means all supported tools.
    const entry = harness === "codex"
      ? { hooks: [{ type: "command", command: codexCmd, timeout: 30, statusMessage: "Checking this action with Scopebond" }] }
      : { matcher: "*", hooks: [{ type: "command", command: claudeCmd }] };
    if (existing >= 0) list[existing] = entry; else list.push(entry);
  }
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

/** The harness configuration snippet to install the hook by hand. Defaults to the
 *  version-pinned `npx` form; `init --no-install` passes the pinned path it chose, so
 *  the printed snippet matches what `init` would have written. */
export function harnessSnippet(harness: "claude" | "cursor" | "codex", command?: string): string {
  const cmdFor = (h: "claude" | "cursor" | "codex"): string =>
    command ? command.replace(/\b(claude|cursor|codex)$/, h) : hookCommand(h);
  if (harness === "cursor") {
    const cmd = cmdFor("cursor");
    return JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: cmd }],
        beforeMCPExecution: [{ command: cmd }],
        beforeReadFile: [{ command: cmd }],
        afterFileEdit: [{ command: cmd }],
      },
    }, null, 2);
  }
  if (harness === "codex") {
    return JSON.stringify({
      hooks: {
        PreToolUse: [{
          hooks: [{ type: "command", command: cmdFor("codex"), timeout: 30, statusMessage: "Checking this action with Scopebond" }],
        }],
      },
    }, null, 2);
  }
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: cmdFor("claude") }] }],
    },
  }, null, 2);
}
