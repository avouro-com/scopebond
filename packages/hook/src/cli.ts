#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt.
//
//   scopebond-hook claude                     evaluate a Claude Code PreToolUse call (stdin JSON)
//   scopebond-hook cursor                     evaluate a Cursor hook event (stdin JSON)
//   scopebond-hook init [--cursor] [--no-install]  scaffold keys + starter policy and configure the agent
//   scopebond-hook connect <url> <bundle.json> [--cursor]
//                                             enroll with a Cloud workspace and start exporting
//   scopebond-hook log [-n N]                 show the most recent local receipts
//   scopebond-hook verify                     verify every local receipt offline against the attester key
//   scopebond-hook test "<shell command>"     show the decision for a command without recording it
//   scopebond-hook flush                      deliver any queued receipts to Cloud now
//
// Config dir: $SCOPEBOND_HOOK_DIR, else ./.scopebond
// Fail-closed: any error denies the action with a repair message.

import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { CloudEnrollmentBundle } from "@scopebond/gateway";
import { verifyReceipt } from "@scopebond/gateway";
import { openReceiptStore, loadOrCreateAttester } from "@scopebond/gateway/node";
import { mapClaudeToolUse, mapCursorEvent, fillPushBranch } from "./map.js";
import { createHookRuntime } from "./runtime.js";
import { scaffold, harnessSnippet, installHarness } from "./init.js";
import { connectCloud, loadConnection, connectionPath } from "./cloud.js";

/** The current git branch in `cwd` (best-effort). A bare `git push` pushes it, so
 *  the runtime fills it in before evaluating; on failure the ref stays absent and
 *  the starter policy fails closed. */
function currentBranch(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch { return null; }
}

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
    const cwd = input?.cwd ? String(input.cwd) : process.cwd();
    const runtime = createHookRuntime(runtimePaths(configDir()));
    const decision = await runtime.evaluate(fillPushBranch(mapClaudeToolUse(input!), currentBranch(cwd)));
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
    const cwd = input?.cwd ? String(input.cwd) : process.cwd();
    const runtime = createHookRuntime(runtimePaths(configDir()));
    const decision = await runtime.evaluate(fillPushBranch(mapCursorEvent(event, input), currentBranch(cwd)));
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
  // Configure the agent automatically by default (idempotent), so there is no
  // hand-editing step; --no-install prints the snippet instead.
  if (!args.includes("--no-install")) {
    const file = installHarness(harness);
    console.log(`✓ ${harness === "cursor" ? "Cursor" : "Claude Code"} configured in ${file}`);
  } else {
    console.log(`Add this to your ${harness === "cursor" ? ".cursor/hooks.json" : ".claude/settings.json"}:`);
    console.log(harnessSnippet(harness));
  }
  console.log("");
  console.log("Next: run one command in the agent, then `scopebond-hook log` to see the receipt");
  console.log("and `scopebond-hook verify` to check it offline. Try `scopebond-hook test \"rm -rf /\"`.");
  console.log("To send receipts to a workspace: scopebond-hook connect <workspace-url> <enrollment>");
}

function decisionOf(payload: Record<string, unknown>): string {
  const rr = String(payload.realtime_result ?? "");
  const state = String((payload.execution as Record<string, unknown> | undefined)?.state ?? "");
  if (state === "observed_not_evaluated") return "not_evaluated";
  if (rr === "deny") return state === "cooperative_allow" || state === "executed" ? "monitor" : "deny";
  return "allow";
}

function describeIntent(payload: Record<string, unknown>): string {
  const intent = (payload.intent ?? {}) as Record<string, unknown>;
  const p = (intent.params ?? {}) as Record<string, unknown>;
  const bits = intent.action_type === "shell.exec" ? String(p.program ?? "")
    : intent.action_type === "git.push" ? `${p.remote ?? ""} ${p.ref ?? ""}`.trim()
    : intent.action_type === "file.write" || intent.action_type === "file.read" ? String(p.path ?? "")
    : intent.action_type === "mcp.tool.call" ? `${p.server ?? ""}/${p.tool ?? ""}`
    : intent.action_type === "net.fetch" ? String(p.host ?? "") : "";
  return `${String(intent.action_type ?? "?")}${bits ? ` ${bits}` : ""}`;
}

async function runLog(args: string[]): Promise<void> {
  const dir = configDir();
  const dbPath = join(dir, "receipts.db");
  if (!existsSync(dbPath)) { console.log("no receipts yet — run a command in the agent first."); process.exit(0); }
  const nIdx = args.indexOf("-n");
  const n = nIdx >= 0 ? Math.max(1, Number(args[nIdx + 1]) || 20) : 20;
  const { store } = openReceiptStore({ db: dbPath });
  const all = await Promise.resolve(store.list());
  const recent = all.slice(-n);
  if (recent.length === 0) { console.log("no receipts yet."); process.exit(0); }
  for (const r of recent) {
    const p = r.payload as unknown as Record<string, unknown>;
    console.log(`${String(p.timestamp ?? "")}  ${decisionOf(p).padEnd(13)}  ${describeIntent(p)}`);
  }
  console.log(`\n${recent.length} of ${all.length} receipt(s). Verify them: scopebond-hook verify`);
}

async function runVerify(): Promise<void> {
  const dir = configDir();
  const dbPath = join(dir, "receipts.db");
  const attesterPath = join(dir, "attester.key");
  if (!existsSync(dbPath) || !existsSync(attesterPath)) { console.log("nothing to verify yet (no receipts or no attester key)."); process.exit(0); }
  const { attester } = loadOrCreateAttester({ file: attesterPath });
  const { store } = openReceiptStore({ db: dbPath });
  const all = await Promise.resolve(store.list());
  let ok = 0;
  const bad: string[] = [];
  for (const r of all) {
    const result = verifyReceipt(r, attester.publicKeyPem) as unknown as Record<string, boolean>;
    if (result.valid) ok += 1;
    else {
      const failed = Object.entries(result).filter(([k, v]) => k.endsWith("_valid") && v === false).map(([k]) => k);
      bad.push(`${String((r.payload as unknown as Record<string, unknown>).timestamp ?? "")}: ${failed.join(", ") || "invalid"}`);
    }
  }
  console.log(`${ok}/${all.length} receipt(s) verify offline against ${attesterPath}.`);
  if (bad.length) { for (const b of bad) console.error(`  ✗ ${b}`); process.exit(1); }
  process.exit(0);
}

async function runTest(args: string[]): Promise<void> {
  const command = args.find((a) => !a.startsWith("-"));
  if (!command) { console.error('usage: scopebond-hook test "<shell command>"'); process.exit(1); }
  const dir = configDir();
  if (!existsSync(join(dir, "policy.json"))) { console.error("no policy yet — run `scopebond-hook init` first."); process.exit(1); }
  // Evaluate against the real policy and keys, but a throwaway store, so `test`
  // never records a receipt or exports anything.
  const tmp = mkdtempSync(join(tmpdir(), "sb-hook-test-"));
  try {
    const runtime = createHookRuntime({
      policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
      attesterPath: join(dir, "attester.key"), dbPath: join(tmp, "receipts.db"),
      strict: process.argv.includes("--strict"),
    });
    const mapped = fillPushBranch(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } }), currentBranch(process.cwd()));
    console.log(`command: ${command}`);
    for (const m of mapped) {
      const d = await runtime.evaluateOne(m);
      console.log(`  ${describeIntent((d.receipt as Record<string, unknown>) ?? { intent: m.intent }).padEnd(28)} → ${d.decision}${d.reason ? `  (${d.reason})` : ""}`);
    }
    const overall = await runtime.evaluate(mapped);
    console.log(`\noverall: ${overall.decision}${overall.reason ? `  · ${overall.reason}` : ""}`);
    process.exit(overall.decision === "deny" ? 2 : 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
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
else if (cmd === "log") { await runLog(rest); }
else if (cmd === "verify") { await runVerify(); }
else if (cmd === "test") { await runTest(rest); }
else if (cmd === "flush") { await runFlush(); }
else {
  console.error("usage: scopebond-hook <claude|cursor|init|connect|log|verify|test|flush> [--cursor] [--force] [--strict] [--no-install]");
  process.exit(1);
}
