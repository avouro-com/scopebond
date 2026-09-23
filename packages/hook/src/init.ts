// `scopebond-hook init` — scaffold the local enrollment: a machine signing key, a
// gateway countersigning key and a starter policy. Keys and receipts stay on the
// machine; no credentials are handled.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import { starterPolicy } from "./runtime.js";
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
export function installHarness(harness: "claude" | "cursor" | "codex", cwd: string = process.cwd()): string {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const file = harness === "cursor" ? join(cwd, ".cursor", "hooks.json")
    : harness === "codex" ? join(cwd, ".codex", "hooks.json")
    : join(cwd, ".claude", "settings.json");
  mkdirSync(dirname(file), { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(file)) { try { const p = JSON.parse(readFileSync(file, "utf8")); if (isRecord(p)) config = p; } catch { /* start fresh on unreadable */ } }
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  const cursorCmd = hookCommand("cursor");
  const claudeCmd = hookCommand("claude");
  const codexCmd = hookCommand("codex");
  // Match any existing Scopebond hook entry (pinned or a legacy bare `scopebond-hook`)
  // so re-running never appends a duplicate and an old bare command is replaced.
  const isScopebond = (cmd: unknown): boolean => typeof cmd === "string" && /(^|\s)(npx\s+.*)?@scopebond\/hook|(^|\s)scopebond-hook(\s|$)/.test(cmd);
  const entryMatches = (e: unknown): boolean =>
    isRecord(e) && (isScopebond(e.command) || (Array.isArray(e.hooks) && e.hooks.some((h) => isRecord(h) && isScopebond(h.command))));
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

/** The harness configuration snippet to install the hook (version-pinned npx). */
export function harnessSnippet(harness: "claude" | "cursor" | "codex"): string {
  if (harness === "cursor") {
    const cmd = hookCommand("cursor");
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
          hooks: [{ type: "command", command: hookCommand("codex"), timeout: 30, statusMessage: "Checking this action with Scopebond" }],
        }],
      },
    }, null, 2);
  }
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand("claude") }] }],
    },
  }, null, 2);
}
