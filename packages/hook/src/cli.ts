#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt.
//
//   scopebond-hook claude              evaluate a Claude Code PreToolUse call (stdin JSON)
//   scopebond-hook cursor              evaluate a Cursor hook event (stdin JSON)
//   scopebond-hook init [--cursor]     scaffold keys + starter policy, print the config
//
// Config dir: $SCOPEBOND_HOOK_DIR, else ./.scopebond
// Fail-closed: any error denies the action with a repair message.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeToolUse, mapCursorEvent } from "./map.js";
import { createHookRuntime } from "./runtime.js";
import { scaffold, harnessSnippet } from "./init.js";

function configDir(): string {
  return process.env.SCOPEBOND_HOOK_DIR ?? join(process.cwd(), ".scopebond");
}
function runtimePaths(dir: string) {
  return {
    policyPath: join(dir, "policy.json"),
    keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"),
  };
}
function readStdin(): string {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function denyClaude(reason: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }) + "\n");
  process.stderr.write(`Scopebond: ${reason}\n`);
  process.exit(2);
}

async function runClaude(): Promise<void> {
  let input: Record<string, unknown>;
  try { input = JSON.parse(readStdin()); } catch { denyClaude("hook received invalid JSON on stdin"); }
  try {
    const runtime = createHookRuntime(runtimePaths(configDir()));
    const decision = await runtime.evaluate(mapClaudeToolUse(input!));
    if (decision.decision === "deny") denyClaude(decision.reason);
    if (decision.decision === "allow") {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: decision.reason },
      }) + "\n");
      process.exit(0);
    }
    // not_evaluated: defer to the harness default (grant nothing, block nothing).
    process.exit(0);
  } catch (error) {
    denyClaude(`Scopebond hook failed closed: ${(error as Error).message}. Repair: run \`scopebond-hook init\`.`);
  }
}

async function runCursor(): Promise<void> {
  let input: Record<string, unknown> = {};
  try { input = JSON.parse(readStdin()); } catch { /* fall through to fail-closed deny below */ }
  const event = String(input?.hook_event_name ?? input?.event ?? process.argv[3] ?? "");
  let permission: "allow" | "deny" | "ask" = "deny";
  let message = "Scopebond hook failed closed";
  try {
    const runtime = createHookRuntime(runtimePaths(configDir()));
    const decision = await runtime.evaluate(mapCursorEvent(event, input));
    permission = decision.decision === "deny" ? "deny" : decision.decision === "allow" ? "allow" : "ask";
    message = decision.reason;
  } catch (error) {
    permission = "deny";
    message = `Scopebond hook failed closed: ${(error as Error).message}. Repair: run \`scopebond-hook init\`.`;
  }
  process.stdout.write(JSON.stringify({ permission, agentMessage: message }) + "\n");
  process.exit(0);
}

function runInit(args: string[]): void {
  const harness = args.includes("--cursor") ? "cursor" : "claude";
  const dir = configDir();
  const { agentKid, policyPath } = scaffold(dir, { force: args.includes("--force") });
  console.log(`Scopebond hook enrolled in ${dir}`);
  console.log(`  machine key    ${agentKid}`);
  console.log(`  policy         ${policyPath} (starter — edit the limits)`);
  console.log("");
  console.log(`Add this to your ${harness === "cursor" ? ".cursor/hooks.json" : ".claude/settings.json"}:`);
  console.log(harnessSnippet(harness));
  console.log("");
  console.log("Then run one safe command in the agent and see the receipt in .scopebond/receipts.db.");
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "claude") { await runClaude(); }
else if (cmd === "cursor") { await runCursor(); }
else if (cmd === "init") { runInit(rest); }
else {
  console.error("usage: scopebond-hook <claude|cursor|init> [--cursor] [--force]");
  process.exit(1);
}
