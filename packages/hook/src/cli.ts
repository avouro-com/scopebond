#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt.
//
//   scopebond-hook claude                     evaluate a Claude Code PreToolUse call (stdin JSON)
//   scopebond-hook cursor                     evaluate a Cursor hook event (stdin JSON)
//   scopebond-hook codex                      evaluate a Codex PreToolUse call (stdin JSON)
//   scopebond-hook init [--cursor|--codex] [--no-install] [--yes]
//   scopebond-hook connect <url> <bundle.json> [--cursor|--codex]
//                                             enroll with a Cloud workspace and start exporting
//   scopebond-hook log [-n N]                 show the most recent local receipts
//   scopebond-hook verify                     verify every local receipt offline against the attester key
//   scopebond-hook test "<shell command>"     show the decision for a command without recording it
//   scopebond-hook flush                      deliver any queued receipts to Cloud now
//   scopebond-hook trust [--yes]              let this project's .scopebond policy govern here (pinned)
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
import { mapClaudeToolUse, mapCodexToolUse, mapCursorEvent, fillPushBranch, type Mapped } from "./map.js";
import { createHookRuntime } from "./runtime.js";
import { scaffold, harnessSnippet, installHarness } from "./init.js";
import {
  userHome, userHarnessFile, resolveConfigDir, writeHarnessConfig, removeHarnessConfig,
  cursorDetected, codexDetected, absoluteHookCommand, isHarnessConfigured, purgeHome, type Harness,
  harnessScopes, harnessScopeLabel, configuredHookCommands, hookCommandResolves, projectHarnessFile,
  trustProjectPolicy, untrustedProjectPolicy,
} from "./install.js";
import { connectCloud, loadConnection, connectionPath } from "./cloud.js";
import { describeAction, type ExplainIntent } from "./explain.js";
import { ensureDurableRuntime } from "./runtime-install.js";
import { cliCommand, hookVersion } from "./version.js";
import { fileURLToPath } from "node:url";

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
  // A composed explanation already names Scopebond in its first line; only the
  // bare internal messages need the prefix.
  process.stderr.write(`${reason.startsWith("Scopebond") ? reason : `Scopebond: ${reason}`}\n`);
  process.exit(2);
}

/** Codex accepts the structured deny response on a successful hook exit. Keeping
 *  exit 0 lets its UI show a completed policy check instead of a failed hook while
 *  still preventing the tool call. */
function denyCodex(reason: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
  }) + "\n");
  process.exit(0);
}

const harnessName = (harness: Harness): string => harness === "claude" ? "Claude Code" : harness === "cursor" ? "Cursor" : "Codex";
const harnessFileName = (harness: Harness): string => harness === "claude" ? ".claude/settings.json" : harness === "cursor" ? ".cursor/hooks.json" : ".codex/hooks.json";
const selectedHarness = (args: string[]): Harness => args.includes("--codex") ? "codex" : args.includes("--cursor") ? "cursor" : "claude";
const codexTrustStep = "Open Codex, run `/hooks`, review Scopebond, and choose Trust. Then start a new task.";
/** What Cursor can and cannot stop. Cursor has before-hooks for shell commands, MCP
 *  calls and file reads, but reports file *edits* only after they are written, so an
 *  out-of-policy edit is recorded and flagged rather than prevented. Said at install
 *  time, because someone choosing a guardrail needs to know its edges up front. */
const cursorCoverageNote = [
  "What this covers in Cursor:",
  "  prevented  shell commands, MCP tool calls, file reads — checked before they run",
  "  recorded   file edits — Cursor reports an edit only after writing it, so an",
  "             out-of-policy edit is signed and flagged, not blocked",
  "For edits that must be blocked before they land, use the GitHub Action as a required",
  "check on pull requests.",
].join("\n");

async function runPreToolUse(mapper: (input: Record<string, unknown>) => Mapped[], deny: (reason: string) => never = denyClaude): Promise<void> {
  let input: Record<string, unknown>;
  try { input = JSON.parse(readStdin()); } catch { deny("hook received invalid JSON on stdin"); }
  try {
    const cwd = input?.cwd ? String(input.cwd) : process.cwd();
    const runtime = createHookRuntime(runtimePaths(resolveConfigDir(cwd)));
    const decision = await runtime.evaluate(fillPushBranch(mapper(input!), currentBranch(cwd)));
    await runtime.flush();
    if (decision.decision === "deny") deny(decision.reason);
    // Stay silent on allow/not_evaluated so the coding agent's normal permission
    // flow remains in charge. Scopebond blocks; it never silently approves.
    process.exit(0);
  } catch (error) {
    deny(`Scopebond hook failed closed: ${(error as Error).message}. Repair: run \`${cliCommand("init")}\`.`);
  }
}

async function runClaude(): Promise<void> {
  await runPreToolUse(mapClaudeToolUse);
}

async function runCodex(): Promise<void> {
  await runPreToolUse(mapCodexToolUse, denyCodex);
}

function denyCursor(reason: string): never {
  process.stdout.write(JSON.stringify({ permission: "deny", agentMessage: reason }) + "\n");
  process.exit(0);
}

async function runCursor(): Promise<void> {
  // Unparseable input denies, like every other adapter. Previously this fell through
  // to evaluation with an empty payload, which mapped to no known action and so
  // answered "ask" — handing an unreadable request to a prompt the user would very
  // likely accept. Deny-by-default on unparseable input is not optional.
  let parsed: unknown;
  try { parsed = JSON.parse(readStdin()); } catch { denyCursor("Scopebond: hook received invalid JSON on stdin"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    denyCursor("Scopebond: hook received a payload that is not a JSON object");
  }
  const input = parsed as Record<string, unknown>;
  const event = String(input.hook_event_name ?? input.event ?? process.argv[3] ?? "");
  let permission: "allow" | "deny" | "ask" = "deny";
  let message = "Scopebond hook failed closed";
  let postHoc = false;
  try {
    const cwd = input?.cwd ? String(input.cwd) : process.cwd();
    const runtime = createHookRuntime(runtimePaths(resolveConfigDir(cwd)));
    const mapped = fillPushBranch(mapCursorEvent(event, input), currentBranch(cwd));
    const decision = await runtime.evaluate(mapped);
    await runtime.flush();
    // An `afterFileEdit` violation is real and recorded, but the edit has already
    // landed. Say so rather than letting "blocked" imply it was stopped.
    postHoc = mapped.some((m) => m.postHoc);
    // Three outcomes, three answers:
    //   deny  — out of policy, blocked outright.
    //   allow — a rule was evaluated and permitted it. Returning "ask" here put a
    //           confirmation prompt in front of every ordinary command, which is not
    //           "your agent works as normal"; it also trained people to click through
    //           prompts, which makes the real denials easier to miss. An evaluated
    //           allow is a decision, not a silent auto-approval.
    //   ask   — nothing was evaluated (no rule covers this action), so Cursor's own
    //           permission flow stays in charge. That is the fail-closed case and it
    //           keeps its prompt.
    permission = decision.decision === "deny" ? "deny" : decision.decision === "allow" ? "allow" : "ask";
    message = decision.reason;
  } catch (error) {
    permission = "deny";
    message = `Scopebond hook failed closed: ${(error as Error).message}. Repair: run \`${cliCommand("init")}\`.`;
  }
  if (postHoc && permission === "deny") {
    message = `${message}\nCursor reports a file edit only after it is written, so this edit was not prevented. Review and revert it yourself.`;
  }
  process.stdout.write(JSON.stringify({ permission, agentMessage: message }) + "\n");
  process.exit(0);
}

/** `init`, `trust` and `uninstall` change what governs the agent, so they are for a
 *  person at a terminal. A coding agent's shell is not interactive: without a TTY on
 *  stdin they refuse unless `--yes` is passed (for scripts and CI). The starter policy
 *  also denies the agent running them. */
function requireInteractive(command: string, args: string[]): void {
  if (process.stdin.isTTY || args.includes("--yes")) return;
  console.error(`scopebond ${command} changes what governs your coding agent, so it does not run unattended.`);
  console.error(`There is no terminal on stdin here — which is also what it looks like when the agent itself`);
  console.error(`tries to run this, so the refusal is deliberate rather than a bug.`);
  console.error(``);
  console.error(`If you are a person: run it in your own terminal, or confirm it now with --yes:`);
  console.error(`  ${cliCommand(`${command} --yes`)}`);
  console.error(`Scripts, CI and container builds should always pass --yes.`);
  process.exit(1);
}

function runInit(args: string[]): void {
  requireInteractive("init", args);
  const harness = selectedHarness(args);
  const dir = configDir();
  const { agentKid, policyPath } = scaffold(dir, { force: args.includes("--force") });
  console.log(`Scopebond hook enrolled in ${dir}`);
  console.log(`  machine key    ${agentKid}`);
  console.log(`  policy         ${policyPath} (starter — edit the limits)`);
  // With a user-level install present, a project policy governs only once trusted.
  // Running init here is that decision, so pin this policy now.
  if (!process.env.SCOPEBOND_HOOK_DIR && existsSync(join(userHome(), "policy.json"))) {
    trustProjectPolicy(dir);
    console.log(`  trusted        overrides ${userHome()} here; after editing it, run \`${cliCommand("trust")}\``);
  }
  // The hook command runs once per tool call, so it must start fast. `npx` re-resolves
  // a package that is already on disk and costs ~830 ms a call; the same CLI invoked
  // directly costs ~110 ms. Pin a durable copy and use that, and fall back to `npx`
  // (slow, but it always starts) when no durable copy can be made. `--npx` forces the
  // portable form for anyone who wants it.
  const pin = args.includes("--npx") ? { cli: null, how: "unavailable" as const } : ensureDurableRuntime(cliPath(), hookVersion());
  const command = pin.cli ? absoluteHookCommand(pin.cli, harness) : undefined;
  // No per-action millisecond claim here: it varies by machine, and this project only
  // states numbers it has measured. The measured comparison lives in the changelog.
  console.log(`  hook runtime   ${pin.cli
    ? `${pin.cli}\n                 pinned — no npx resolution per action`
    : `npx @scopebond/hook@${hookVersion()} — portable, but re-resolves on every action`}`);
  console.log("");
  // Configure the agent automatically by default (idempotent), so there is no
  // hand-editing step; --no-install prints the snippet instead.
  if (!args.includes("--no-install")) {
    let file: string;
    try { file = installHarness(harness, process.cwd(), command); } catch (error) { console.error((error as Error).message); process.exit(1); }
    console.log(`✓ ${harnessName(harness)} configured in ${file}`);
    if (harness === "codex") console.log(`\nOne last step: ${codexTrustStep}`);
    if (harness === "cursor") console.log(`\n${cursorCoverageNote}`);
  } else {
    console.log(`Add this to your ${harnessFileName(harness)}:`);
    console.log(harnessSnippet(harness, command));
    if (harness === "cursor") console.log(`\n${cursorCoverageNote}`);
  }
  console.log("");
  // Print the runnable `npx` form: after `npx @scopebond/hook init` there is no
  // `scopebond-hook` binary on PATH, so a bare `scopebond-hook log` would fail.
  console.log(`Next: run one command in the agent, then \`${cliCommand("log")}\` to see the receipt`);
  console.log(`and \`${cliCommand("verify")}\` to check it offline. Try \`${cliCommand('test "rm -rf /"')}\`.`);
  console.log(`To send receipts to a workspace: ${cliCommand("connect <workspace-url> <enrollment>")}`);
}

function decisionOf(payload: Record<string, unknown>): string {
  const rr = String(payload.realtime_result ?? "");
  const state = String((payload.execution as Record<string, unknown> | undefined)?.state ?? "");
  if (state === "observed_not_evaluated") return "not_evaluated";
  if (rr === "deny") return state === "cooperative_allow" || state === "executed" ? "monitor" : "deny";
  return "allow";
}

function describeIntent(payload: Record<string, unknown>): string {
  return describeAction(payload.intent as ExplainIntent | undefined);
}

async function runLog(args: string[]): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
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
  console.log(`\n${recent.length} of ${all.length} receipt(s). Verify them: ${cliCommand("verify")}`);
}

async function runVerify(): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
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
  const dir = resolveConfigDir(process.cwd());
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
      // One tidy row per action. A deny's full explanation is multi-line, so the
      // row carries only the deciding rule and the whole message is printed once,
      // below — exactly as the agent will receive it.
      const note = d.decision === "deny" ? (d.clauseId ? `rule "${d.clauseId}"` : "")
        : d.decision === "not_evaluated" ? d.reason : "";
      console.log(`  ${describeIntent({ intent: m.intent }).padEnd(28)} → ${d.decision.padEnd(14)}${note}`);
    }
    const overall = await runtime.evaluate(mapped);
    console.log(`\noverall: ${overall.decision}`);
    if (overall.decision === "deny" && overall.reason) console.log(`\n${overall.reason}`);
    process.exit(overall.decision === "deny" ? 2 : 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function runConnect(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const url = positional[0];
  const bundleArg = positional[1];
  const harness = selectedHarness(args);
  if (!url) {
    console.error("usage: scopebond-hook connect <workspace-url> <enrollment> [--claude|--cursor|--codex] [--no-install]");
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
      console.log(`✓ ${harnessName(harness)} configured in ${file}`);
      if (harness === "codex") console.log(`\nOne last step: ${codexTrustStep}`);
    } else {
      console.log(`Add this to your ${harnessFileName(harness)}:`);
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
  const dir = resolveConfigDir(process.cwd());
  if (!loadConnection(dir)) { console.error("not connected to a workspace; run `scopebond-hook connect` first"); process.exit(1); }
  const runtime = createHookRuntime(runtimePaths(dir));
  await runtime.exporter?.flush();
  const status = runtime.exporter?.status();
  runtime.exporter?.stop();
  console.log(`flushed; ${status?.pending ?? 0} receipt(s) still pending${status?.lastError ? ` (last error: ${status.lastError})` : ""}`);
  // Let pending HTTP handles close normally (forced exit can abort on Windows).
  process.exitCode = status && status.pending > 0 ? 1 : 0;
}

/** The absolute path to this CLI file, for registering the hook by absolute path. */
function cliPath(): string {
  return fileURLToPath(import.meta.url);
}

/** `install` — the once-per-machine, user-level install (SB112). Scaffolds the
 *  user home and registers the hook by absolute path in the user-level agent config,
 *  so every project a developer opens is governed without a per-repo `init`. */
function runInstall(args: string[]): void {
  const dir = userHome();
  const { agentKid, policyPath } = scaffold(dir, { force: args.includes("--force") });
  console.log(`Scopebond installed for this user in ${dir}`);
  console.log(`  machine key    ${agentKid}`);
  console.log(`  policy         ${policyPath} (starter — edit the limits)`);
  console.log("");
  const harnesses: Harness[] = args.includes("--codex") ? ["codex"]
    : args.includes("--cursor") ? ["cursor"]
    : args.includes("--claude") ? ["claude"]
    : ["claude", ...(cursorDetected() ? ["cursor" as const] : []), ...(codexDetected() ? ["codex" as const] : [])];
  if (!args.includes("--no-install")) {
    for (const h of harnesses) {
      try {
        const file = writeHarnessConfig(userHarnessFile(h), h, absoluteHookCommand(cliPath(), h));
        console.log(`✓ ${harnessName(h)} configured in ${file}`);
      } catch (error) { console.error(`✗ ${harnessName(h)}: ${(error as Error).message}`); process.exitCode = 1; }
    }
  } else {
    console.log("Add this to your user-level agent config:");
    console.log(harnessSnippet(harnesses[0]));
  }
  if (harnesses.includes("codex")) console.log(`\nOne last step for Codex: ${codexTrustStep}`);
  console.log("");
  console.log(`A project's own .scopebond policy applies only after you trust it there (${cliCommand("trust")}).`);
  console.log(`Check it: ${cliCommand("doctor")} · see decisions: ${cliCommand("log")}`);
  console.log(`To send receipts to a workspace: ${cliCommand("connect <workspace-url> <enrollment>")}`);
}

function runStatus(): void {
  const home = userHome();
  const installed = existsSync(join(home, "policy.json"));
  // Both scopes, always: `init` writes the project config and `install` writes the
  // user one, so a single-scope check contradicts whichever command the user ran.
  const claude = harnessScopes("claude", process.cwd());
  const cursor = harnessScopes("cursor", process.cwd());
  const codex = harnessScopes("codex", process.cwd());
  const connected = !!loadConnection(resolveConfigDir(process.cwd()));
  const dbPath = join(resolveConfigDir(process.cwd()), "receipts.db");
  console.log(`Scopebond hook ${hookVersion()}`);
  console.log(`  user home        ${home} ${installed ? "(installed)" : "(not installed — run `scopebond install`)"}`);
  console.log(`  active config    ${resolveConfigDir(process.cwd())}`);
  const ignored = untrustedProjectPolicy(process.cwd());
  if (ignored) console.log(`  project policy   ${ignored} ignored — not trusted (run \`${cliCommand("trust")}\` to use it)`);
  console.log(`  Claude Code      ${harnessScopeLabel(claude) || "not configured"}`);
  console.log(`  Cursor           ${harnessScopeLabel(cursor) || (cursorDetected() ? "detected, not configured" : "not detected")}`);
  console.log(`  Codex            ${codex.project || codex.user ? `${harnessScopeLabel(codex)} — approve once with /hooks` : codexDetected() ? "detected, not configured" : "not detected"}`);
  console.log(`  cloud workspace  ${connected ? "connected" : "not connected (local only)"}`);
  console.log(`  local receipts   ${existsSync(dbPath) ? dbPath : "none yet"}`);
  for (const [name, scopes] of [["Claude Code", claude], ["Cursor", cursor], ["Codex", codex]] as const) {
    for (const file of [scopes.project, scopes.user]) if (file) console.log(`    ${name}: ${file}`);
  }
}

async function runDoctor(): Promise<void> {
  const problems: string[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  console.log(`Scopebond doctor`);
  console.log(`  node             ${process.versions.node} ${nodeOk ? "ok" : "TOO OLD (need >=22.13)"}`);
  if (!nodeOk) problems.push("node >=22.13 is required (the Cloud outbox uses node:sqlite)");
  const cli = cliPath();
  console.log(`  cli              ${cli} ${existsSync(cli) ? "ok" : "MISSING"}`);
  const active = resolveConfigDir(process.cwd());
  const hasPolicy = existsSync(join(active, "policy.json"));
  console.log(`  active config    ${active} ${hasPolicy ? "ok" : "no policy (run `scopebond install` or `init`)"}`);
  if (!hasPolicy) problems.push("no policy found in the active config dir");
  const ignored = untrustedProjectPolicy(process.cwd());
  if (ignored) console.log(`  project policy   ${ignored} IGNORED — not trusted (never trusted, or edited since). Review it, then \`${cliCommand("trust")}\``);
  // Every harness, in both scopes, plus a check that each configured command can
  // actually start. A pinned path that has gone missing is the one failure mode of
  // the fast absolute-path install, so doctor is where it must surface.
  let anyHarness = false;
  for (const harness of ["claude", "cursor", "codex"] as const) {
    const scopes = harnessScopes(harness, process.cwd());
    const label = harnessScopeLabel(scopes);
    const name = harnessName(harness);
    if (!label) {
      const detected = harness === "claude" || (harness === "cursor" ? cursorDetected() : codexDetected());
      console.log(`  ${name.padEnd(15)} ${detected ? `not configured — run \`${cliCommand(`init${harness === "claude" ? "" : ` --${harness}`}`)}\`` : "not detected"}`);
      continue;
    }
    anyHarness = true;
    console.log(`  ${name.padEnd(15)} ${label}`);
    for (const file of [scopes.project, scopes.user]) {
      if (!file) continue;
      for (const command of configuredHookCommands(file)) {
        const ok = hookCommandResolves(command);
        console.log(`    ${ok ? "ok  " : "BAD "} ${file}`);
        if (!ok) {
          console.log(`         command cannot start: ${command}`);
          problems.push(`${name} hook command no longer resolves in ${file} — run \`${cliCommand("init")}\` to repair it`);
        }
      }
    }
    if (harness === "codex") console.log(`    run /hooks in Codex and approve Scopebond once`);
  }
  if (!anyHarness) problems.push(`no coding agent is configured — run \`${cliCommand("init")}\` in your project root`);
  const connection = loadConnection(active);
  if (!connection) {
    console.log(`  cloud            not connected (local only) — receipts stay on this machine`);
  } else {
    let reachable = "unknown";
    try {
      const res = await fetch(new URL("/healthz", connection.url).toString(), { method: "GET" });
      reachable = res.ok ? "reachable" : `unhealthy (${res.status})`;
    } catch (error) { reachable = `unreachable (${(error as Error).message})`; }
    console.log(`  cloud            ${connection.url} — ${reachable}`);
  }
  console.log(problems.length ? `\n${problems.length} problem(s): ${problems.join("; ")}` : `\nAll good.`);
  process.exitCode = problems.length ? 1 : 0;
}

function runUninstall(args: string[]): void {
  requireInteractive("uninstall", args);
  let removed = 0;
  for (const h of ["claude", "cursor", "codex"] as Harness[]) {
    if (removeHarnessConfig(userHarnessFile(h))) { console.log(`✓ removed the Scopebond hook from ${userHarnessFile(h)}`); removed++; }
  }
  if (removed === 0) console.log("no user-level harness config found.");
  if (args.includes("--purge")) { purgeHome(); console.log(`✓ purged ${userHome()} (keys, policy, receipts)`); }
  else console.log(`Kept ${userHome()} (keys, policy, receipts). Use --purge to remove it too.`);
}

/** `trust` — let this project's .scopebond policy govern here instead of the user
 *  home, pinned to its current contents. Run by the user, not the agent: the file it
 *  writes lives in the user home, which the starter policy write-protects. */
function runTrust(args: string[]): void {
  requireInteractive("trust", args);
  const dir = join(process.cwd(), ".scopebond");
  if (!existsSync(join(dir, "policy.json"))) { console.error(`no project policy at ${join(dir, "policy.json")}`); process.exit(1); }
  const digest = trustProjectPolicy(dir);
  console.log(`✓ trusted ${join(dir, "policy.json")} (sha256 ${digest.slice(0, 12)}…)`);
  console.log("It governs agents in this project until it changes; after any edit, review it and run trust again.");
}

function runLogin(): void {
  console.log("Device-code login is not available yet.");
  console.log(`For now, connect with a one-time enrollment from your workspace:`);
  console.log(`  ${cliCommand("connect <workspace-url> <enrollment>")}`);
  process.exit(0);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "claude") { await runClaude(); }
else if (cmd === "cursor") { await runCursor(); }
else if (cmd === "codex") { await runCodex(); }
else if (cmd === "init") { runInit(rest); }
else if (cmd === "install") { runInstall(rest); }
else if (cmd === "connect") { await runConnect(rest); }
else if (cmd === "log") { await runLog(rest); }
else if (cmd === "verify") { await runVerify(); }
else if (cmd === "test") { await runTest(rest); }
else if (cmd === "flush") { await runFlush(); }
else if (cmd === "status") { runStatus(); }
else if (cmd === "doctor") { await runDoctor(); }
else if (cmd === "uninstall") { runUninstall(rest); }
else if (cmd === "login") { runLogin(); }
else if (cmd === "trust") { runTrust(rest); }
else {
  console.error("usage: scopebond <claude|cursor|codex|init|install|connect|log|verify|test|flush|status|doctor|uninstall|login|trust> [--cursor] [--claude] [--codex] [--force] [--strict] [--no-install] [--purge] [--yes]");
  process.exit(1);
}
