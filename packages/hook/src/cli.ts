#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt.
//
//   scopebond-hook claude                     evaluate a Claude Code PreToolUse call (stdin JSON)
//   scopebond-hook cursor                     evaluate a Cursor hook event (stdin JSON)
//   scopebond-hook init [--cursor]            scaffold keys + starter policy, print the config
//   scopebond-hook connect <url> <bundle.json> [--cursor]
//                                             enroll with a Cloud workspace and start exporting
//   scopebond-hook flush                      deliver any queued receipts to Cloud now
//
// Config dir: $SCOPEBOND_HOOK_DIR, else ./.scopebond
// Fail-closed: any error denies the action with a repair message.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CloudEnrollmentBundle } from "@scopebond/gateway";
import { mapClaudeToolUse, mapCursorEvent } from "./map.js";
import { createHookRuntime } from "./runtime.js";
import { scaffold, harnessSnippet, installHarness } from "./init.js";
import { connectCloud, loadConnection, connectionPath } from "./cloud.js";

/** Read an enrollment bundle from a file path, an inline base64 blob, or inline raw
 *  JSON (the portal hands out a base64 blob so it is one clean argument). */
function readBundleArg(bundleArg: string | undefined, stdin: () => string): CloudEnrollmentBundle {
  let text: string;
  if (!bundleArg) text = stdin();
  else if (existsSync(bundleArg)) text = readFileSync(bundleArg, "utf8");
  else if (bundleArg.trim().startsWith("{")) text = bundleArg;
  else { try { text = Buffer.from(bundleArg, "base64").toString("utf8"); } catch { text = bundleArg; } }
  return JSON.parse(text) as CloudEnrollmentBundle;
}

function configDir(): string {
  return process.env.SCOPEBOND_HOOK_DIR ?? join(process.cwd(), ".scopebond");
}
function runtimePaths(dir: string) {
  const connection = loadConnection(dir);
  return {
    policyPath: join(dir, "policy.json"),
    keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"),
    // Strict: deny (not just observe) tools with no taxonomy mapping.
    strict: process.argv.includes("--strict") || process.env.SCOPEBOND_HOOK_STRICT === "1",
    // When connected, auto-export receipts. A short bounded flush keeps the hot path
    // fast; undelivered receipts persist in the durable outbox and flush next time
    // (or via `scopebond-hook flush`, e.g. on a session-end hook).
    ...(connection ? { cloud: { connection, flushTimeoutMs: Number(process.env.SCOPEBOND_HOOK_FLUSH_MS ?? 800) } } : {}),
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
    await runtime.flush();
    if (decision.decision === "deny") denyClaude(decision.reason);
    // allow and not_evaluated both DEFER to Claude Code's own permission flow: the
    // hook records the receipt but never returns permissionDecision:"allow", which
    // would suppress the user's normal review. Scopebond blocks; it does not approve.
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
    await runtime.flush();
    // Only an out-of-policy action is denied outright; an allowed or unevaluated
    // action defers to Cursor's own prompt ("ask"), never a silent auto-allow.
    permission = decision.decision === "deny" ? "deny" : "ask";
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
  console.log("To send receipts to your workspace, run: scopebond-hook connect <workspace-url> scopebond-enrollment.json");
}

async function runConnect(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const url = positional[0];
  const bundleArg = positional[1];
  const harness = args.includes("--cursor") ? "cursor" : "claude";
  if (!url) {
    console.error("usage: scopebond-hook connect <workspace-url> <enrollment> [--cursor] [--no-install]");
    process.exit(1);
  }
  const dir = configDir();
  // One command sets everything up: scaffold the key, attester and starter policy if
  // they do not exist, then enroll and persist the scoped machine credential. The
  // enrollment can be a file, an inline base64 blob (what the portal hands out) or
  // raw JSON — the user never has to save or open a JSON file.
  scaffold(dir, {});
  let bundle: CloudEnrollmentBundle;
  try { bundle = readBundleArg(bundleArg, readStdin); }
  catch { console.error("could not read the enrollment (expected a file, inline blob, or JSON on stdin)"); process.exit(1); }
  try {
    const c = await connectCloud(dir, url, bundle);
    console.log(`✓ Connected to ${c.url}`);
    // Configure the agent automatically (merges into the existing config), unless the
    // caller opts out. This removes the "paste this snippet" step.
    if (!args.includes("--no-install")) {
      const file = installHarness(harness);
      console.log(`✓ ${harness === "cursor" ? "Cursor" : "Claude Code"} configured in ${file}`);
    } else {
      console.log(`Add this to your ${harness === "cursor" ? ".cursor/hooks.json" : ".claude/settings.json"}:`);
      console.log(harnessSnippet(harness));
    }
    console.log("");
    console.log("Run your agent — the first action appears in your workspace within seconds.");
  } catch (error) {
    console.error(`connect failed: ${(error as Error).message}`);
    process.exit(1);
  }
}

async function runFlush(): Promise<void> {
  const dir = configDir();
  if (!loadConnection(dir)) { console.error("not connected to a workspace; run `scopebond-hook connect` first"); process.exit(1); }
  const runtime = createHookRuntime(runtimePaths(dir));
  await runtime.exporter?.flush();
  const status = runtime.exporter?.status();
  console.log(`flushed; ${status?.pending ?? 0} receipt(s) still pending${status?.lastError ? ` (last error: ${status.lastError})` : ""}`);
  process.exit(status && status.pending > 0 ? 1 : 0);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "claude") { await runClaude(); }
else if (cmd === "cursor") { await runCursor(); }
else if (cmd === "init") { runInit(rest); }
else if (cmd === "connect") { await runConnect(rest); }
else if (cmd === "flush") { await runFlush(); }
else {
  console.error("usage: scopebond-hook <claude|cursor|init|connect|flush> [--cursor] [--force] [--strict]");
  process.exit(1);
}
