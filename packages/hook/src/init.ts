// `scopebond-hook init` — scaffold the local enrollment: a machine signing key, a
// gateway countersigning key and a starter policy. Keys and receipts stay on the
// machine; no credentials are handled.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import { starterPolicy } from "./runtime.js";
import { readHarnessConfig, projectHarnessFile, harnessEntryMatches } from "./install.js";
import { hookCommand } from "./version.js";

export function scaffold(dir: string, opts: { force?: boolean } = {}): { agentKid: string; policyPath: string } {
  mkdirSync(dir, { recursive: true });
  const keyPath = join(dir, "agent.key");
  const attesterPath = join(dir, "attester.key");
  const policyPath = join(dir, "policy.json");
  // Never let the signing keys, the Cloud credential or the local log be committed.
  const gitignorePath = join(dir, ".gitignore");
  if (!existsSync(gitignorePath)) writeFileSync(gitignorePath, "*\n");
  // Machine signing key (agent) + gateway countersigning key (attester). Reused if present.
  loadOrCreateAttester({ file: keyPath });
  loadOrCreateAttester({ file: attesterPath });
  const agent = createSigner({ privateKeyPem: readFileSync(keyPath, "utf8") });
  if (!existsSync(policyPath) || opts.force) {
    writeFileSync(policyPath, JSON.stringify(starterPolicy(agent.kid), null, 2) + "\n");
  }
  return { agentKid: agent.kid, policyPath };
}

/** Install the hook into the agent's own config file, merging with anything already
 *  there (idempotent — safe to run twice). Returns the file it wrote. This is what
 *  lets `connect` finish setup without the user hand-editing JSON.
 *  `cwd` defaults to the current directory (the project root the user runs it in). */
export function installHarness(
  harness: "claude" | "cursor" | "codex",
  cwd: string = process.cwd(),
  /** The command to run per tool call. Defaults to the portable `npx` form; `init`
   *  passes a pinned absolute path when it has one, which is ~7x faster to start. */
  command?: string,
): string {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const file = projectHarnessFile(harness, cwd);
  const config = readHarnessConfig(file); // throws, leaving the file intact, if it is not a JSON object
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
      const list = Array.isArray((hooks as Record<string, unknown>)[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
      const existing = list.findIndex(entryMatches);
      if (existing >= 0) list[existing] = { command: cursorCmd }; else list.push({ command: cursorCmd });
    }
  } else {
    const list = Array.isArray((hooks as Record<string, unknown>).PreToolUse) ? (hooks as Record<string, unknown[]>).PreToolUse : ((hooks as Record<string, unknown[]>).PreToolUse = []);
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
