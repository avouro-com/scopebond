// `scopebond-hook init` — scaffold the local enrollment: a machine signing key, a
// gateway countersigning key and a starter policy. Keys and receipts stay on the
// machine; no credentials are handled.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadOrCreateAttester } from "@scopebond/gateway/node";
import { createSigner } from "@scopebond/sdk";
import { starterPolicy } from "./runtime.js";

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
export function installHarness(harness: "claude" | "cursor", cwd: string = process.cwd()): string {
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const file = harness === "cursor" ? join(cwd, ".cursor", "hooks.json") : join(cwd, ".claude", "settings.json");
  mkdirSync(dirname(file), { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(file)) { try { const p = JSON.parse(readFileSync(file, "utf8")); if (isRecord(p)) config = p; } catch { /* start fresh on unreadable */ } }
  const hooks = isRecord(config.hooks) ? config.hooks : (config.hooks = {});
  const has = (list: unknown, cmd: string): boolean =>
    Array.isArray(list) && list.some((e) => isRecord(e) && (e.command === cmd
      || (Array.isArray(e.hooks) && e.hooks.some((h) => isRecord(h) && h.command === cmd))));
  if (harness === "cursor") {
    config.version = config.version ?? 1;
    for (const event of ["beforeShellExecution", "beforeMCPExecution", "beforeReadFile", "afterFileEdit"]) {
      const list = Array.isArray((hooks as Record<string, unknown>)[event]) ? (hooks as Record<string, unknown[]>)[event] : ((hooks as Record<string, unknown[]>)[event] = []);
      if (!has(list, "scopebond-hook cursor")) list.push({ command: "scopebond-hook cursor" });
    }
  } else {
    const list = Array.isArray((hooks as Record<string, unknown>).PreToolUse) ? (hooks as Record<string, unknown[]>).PreToolUse : ((hooks as Record<string, unknown[]>).PreToolUse = []);
    if (!has(list, "scopebond-hook claude")) list.push({ matcher: "*", hooks: [{ type: "command", command: "scopebond-hook claude" }] });
  }
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}

/** The harness configuration snippet to install the hook. */
export function harnessSnippet(harness: "claude" | "cursor"): string {
  if (harness === "cursor") {
    return JSON.stringify({
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: "scopebond-hook cursor" }],
        beforeMCPExecution: [{ command: "scopebond-hook cursor" }],
        beforeReadFile: [{ command: "scopebond-hook cursor" }],
        afterFileEdit: [{ command: "scopebond-hook cursor" }],
      },
    }, null, 2);
  }
  return JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "scopebond-hook claude" }] }],
    },
  }, null, 2);
}
