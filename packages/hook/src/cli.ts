#!/usr/bin/env node
// scopebond-hook — govern a coding agent's tool calls against policy, in-path,
// before they run, with a signed local receipt.
//
// The command list, arguments and examples live in `COMMANDS` near the bottom of this
// file, which is what `scopebond-hook help [command]` prints — one source rather than a
// comment here that drifts from it.
//
// Config dir: $SCOPEBOND_HOOK_DIR, else ./.scopebond
// Fail-closed: any error denies the action with a repair message.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
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
import { compile, defaultRules, describeRules, loadRules, saveRules, rulesPath, pathRuleFor } from "./rules.js";
import { createSigner } from "@scopebond/sdk";
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
  let runtime: ReturnType<typeof createHookRuntime> | undefined;
  try {
    const cwd = input?.cwd ? String(input.cwd) : process.cwd();
    runtime = createHookRuntime(runtimePaths(resolveConfigDir(cwd)));
    const decision = await runtime.evaluate(fillPushBranch(mapper(input!), currentBranch(cwd)));
    await runtime.flush();
    // Close before deciding: the receipt is already committed, and leaving the handle
    // open is what made the write-ahead log grow without bound.
    runtime.close();
    runtime = undefined;
    if (decision.decision === "deny") deny(decision.reason);
    // Stay silent on allow/not_evaluated so the coding agent's normal permission
    // flow remains in charge. Scopebond blocks; it never silently approves.
    process.exit(0);
  } catch (error) {
    try { runtime?.close(); } catch { /* already failing; the deny below is what matters */ }
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
  let runtime: ReturnType<typeof createHookRuntime> | undefined;
  try {
    const cwd = input?.cwd ? String(input.cwd) : process.cwd();
    runtime = createHookRuntime(runtimePaths(resolveConfigDir(cwd)));
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
  } finally {
    // Release the SQLite handles on every path: an unclosed writer leaves its
    // write-ahead log behind for the next tool call to extend.
    try { runtime?.close(); } catch { /* the decision is already recorded */ }
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
  const { agentKid, policyPath, rulesPath: rulesFile } = scaffold(dir, { force: args.includes("--force") });
  console.log(`Scopebond hook enrolled in ${dir}`);
  console.log(`  machine key    ${agentKid}`);
  console.log(`  rules          ${rulesFile} (the readable list — edit this)`);
  console.log(`  policy         ${policyPath} (compiled from the rules; don't hand-edit)`);
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

/** `log [-n N] [--deny] [--since <when>]` — the recent decisions.
 *
 *  "What did my agents get blocked on this week" had no answer at the CLI: the only
 *  output was an unfiltered tail. `--deny` and `--since` make it answerable, and the
 *  tail is read as a tail (`ORDER BY id DESC LIMIT`) rather than by loading and parsing
 *  every receipt ever recorded and slicing the end off. */
async function runLog(args: string[]): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
  const dbPath = join(dir, "receipts.db");
  if (!existsSync(dbPath)) { console.log("no receipts yet — run a command in the agent first."); process.exit(0); }
  const nIdx = args.indexOf("-n");
  const n = nIdx >= 0 ? Math.max(1, Number(args[nIdx + 1]) || 20) : 20;
  const denyOnly = args.includes("--deny");
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? parseSince(args[sinceIdx + 1]) : null;
  if (sinceIdx >= 0 && since === null) {
    console.error(`--since wants a duration (7d, 24h, 30m) or a date (2026-09-25); got ${args[sinceIdx + 1] ?? "nothing"}`);
    process.exit(1);
  }
  const { store } = openReceiptStore({ db: dbPath });
  try {
    const total = store.count ? await Promise.resolve(store.count()) : (await Promise.resolve(store.list())).length;
    // A filter has to look past the last N to find N matches; without one, read only the
    // tail. The scan is still bounded so a huge log cannot hang the command.
    const budget = denyOnly || since ? Math.min(Math.max(n * 50, 1000), 20000) : n;
    const scanned = store.recent
      ? await Promise.resolve(store.recent(budget))
      : (await Promise.resolve(store.list())).slice(-budget).reverse();
    const matching = scanned.filter((r) => {
      const p = r.payload as unknown as Record<string, unknown>;
      if (denyOnly && decisionOf(p) !== "deny") return false;
      if (since) {
        const at = Date.parse(String(p.timestamp ?? ""));
        if (!Number.isFinite(at) || at < since) return false;
      }
      return true;
    });
    const shown = matching.slice(0, n).reverse(); // oldest-first on screen, newest last
    if (shown.length === 0) {
      console.log(denyOnly || since ? "no receipts match that filter." : "no receipts yet.");
      process.exit(0);
    }
    for (const r of shown) {
      const p = r.payload as unknown as Record<string, unknown>;
      console.log(`${String(p.timestamp ?? "")}  ${decisionOf(p).padEnd(13)}  ${describeIntent(p)}`);
    }
    const filters = [denyOnly ? "denied" : "", since ? `since ${new Date(since).toISOString()}` : ""].filter(Boolean).join(", ");
    const scope = filters ? ` matching ${filters}` : "";
    const capped = (denyOnly || since) && scanned.length >= budget && total > budget;
    console.log(`\n${shown.length}${scope} of ${total} receipt(s)${capped ? ` — searched the most recent ${budget}` : ""}. Verify them: ${cliCommand("verify")}`);
  } finally {
    try { store.close?.(); } catch { /* read-only */ }
  }
}

/** `rules` — read and change the limits in plain terms.
 *
 *  Without this, "edit the limits" meant hand-writing a ~700-character case-folded
 *  negative lookahead, which nobody does — so the starter policy was effectively the only
 *  policy. The lists live in `.scopebond/rules.json`; `policy.json` is compiled from them. */
function runRules(args: string[]): void {
  const dir = resolveConfigDir(process.cwd());
  if (!existsSync(join(dir, "policy.json"))) {
    console.error(`no policy here yet — run \`${cliCommand("init")}\` first.`);
    process.exit(1);
  }
  const rules = loadRules(dir) ?? defaultRules();
  const [verb, ...values] = args.filter((a) => !a.startsWith("--"));
  const value = values.join(" ").trim();

  if (!verb || verb === "show") {
    console.log(`Rules for ${dir}`);
    if (!loadRules(dir)) console.log(`(showing the defaults — ${rulesPath(dir)} will be written on your first change)`);
    console.log("");
    console.log(describeRules(rules));
    console.log("");
    console.log(`Change them:`);
    console.log(`  ${cliCommand("rules allow <program>")}        stop blocking a program`);
    console.log(`  ${cliCommand("rules block <program>")}        start blocking one`);
    console.log(`  ${cliCommand("rules protect <path>")}         never write there`);
    console.log(`  ${cliCommand("rules unprotect <path>")}       allow writing there again`);
    console.log(`  ${cliCommand("rules protect-branch <name>")}  never push there`);
    console.log(`  ${cliCommand("rules unprotect-branch <name>")}`);
    console.log(`Or edit ${rulesPath(dir)} directly, then \`${cliCommand("rules apply")}\`.`);
    process.exit(0);
  }

  const needsValue = ["allow", "block", "protect", "unprotect", "protect-branch", "unprotect-branch"];
  if (needsValue.includes(verb) && !value) {
    console.error(`\`rules ${verb}\` needs a value, e.g. \`${cliCommand(`rules ${verb} ${verb.includes("branch") ? "production" : verb.includes("protect") ? "infra/" : "dd"}`)}\``);
    process.exit(1);
  }

  let changed = "";
  switch (verb) {
    case "allow": {
      const before = rules.destructive_programs.length;
      rules.destructive_programs = rules.destructive_programs.filter((p) => p.toLowerCase() !== value.toLowerCase());
      if (rules.destructive_programs.length === before) { console.log(`${value} was not in the blocked list; nothing to change.`); process.exit(0); }
      changed = `${value} is no longer blocked`;
      break;
    }
    case "block": {
      if (rules.destructive_programs.some((p) => p.toLowerCase() === value.toLowerCase())) { console.log(`${value} is already blocked.`); process.exit(0); }
      rules.destructive_programs.push(value.toLowerCase());
      changed = `${value} is now blocked`;
      break;
    }
    case "protect": case "unprotect": {
      const list = verb === "protect" ? "protected_write" : "protected_write";
      const rule = pathRuleFor(value);
      if (verb === "protect") {
        if (rules[list].some((r) => r.label === rule.label)) { console.log(`${value} is already protected.`); process.exit(0); }
        rules[list].push(rule);
        changed = `writes to ${rule.label} are now blocked`;
      } else {
        const before = rules[list].length;
        rules[list] = rules[list].filter((r) => r.label !== rule.label && !r.label.startsWith(`${value.replace(/\/$/, "")}/`));
        if (rules[list].length === before) {
          console.log(`${value} is not in the protected list. Current list:`);
          for (const r of rules[list]) console.log(`  ${r.label}`);
          process.exit(1);
        }
        changed = `writes to ${value} are allowed again`;
      }
      break;
    }
    case "protect-branch": {
      if (rules.protected_branches.some((b) => b.toLowerCase() === value.toLowerCase())) { console.log(`${value} is already protected.`); process.exit(0); }
      rules.protected_branches.push(value);
      changed = `pushes to ${value} are now blocked`;
      break;
    }
    case "unprotect-branch": {
      const before = rules.protected_branches.length;
      rules.protected_branches = rules.protected_branches.filter((b) => b.toLowerCase() !== value.toLowerCase());
      if (rules.protected_branches.length === before) { console.log(`${value} was not protected; nothing to change.`); process.exit(0); }
      changed = `pushes to ${value} are allowed again`;
      break;
    }
    case "apply":
      changed = `recompiled from ${rulesPath(dir)}`;
      break;
    default:
      console.error(`unknown: rules ${verb}`);
      printHelp("rules", true);
      process.exit(1);
  }

  // Changing what governs the agent is the same class of action as `init`.
  requireInteractive("rules", args);
  const policyPath = join(dir, "policy.json");
  const agentKid = createSigner({ privateKeyPem: readFileSync(join(dir, "agent.key"), "utf8") }).kid;
  saveRules(dir, rules);
  writeFileSync(policyPath, `${JSON.stringify(compile(rules, agentKid), null, 2)}\n`);
  console.log(`✓ ${changed}`);
  console.log(`  rules          ${rulesPath(dir)}`);
  console.log(`  policy         ${policyPath} (recompiled)`);
  // A project policy governs only once trusted, and the hash just changed.
  if (!process.env.SCOPEBOND_HOOK_DIR && existsSync(join(userHome(), "policy.json"))) {
    trustProjectPolicy(dir);
    console.log(`  trusted        re-pinned for this project`);
  }
  console.log(`\nCheck it: ${cliCommand('test "rm -rf /"')}`);
  process.exit(0);
}

/** `prune --before <when> [--yes]` — bound the local receipt store.
 *
 *  Signed receipts are the product, so this never runs on its own and never quietly
 *  destroys anything: it archives what it will remove to a JSONL file beside the
 *  database first, and it refuses entirely once the log has been anchored, because a
 *  receipt's position is its anchor leaf index. Without a `--before` it reports the
 *  footprint and exits. */
async function runPrune(args: string[]): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
  const dbPath = join(dir, "receipts.db");
  if (!existsSync(dbPath)) { console.log("no local receipts yet — nothing to prune."); process.exit(0); }
  const beforeIdx = args.indexOf("--before");
  if (beforeIdx < 0) {
    console.log(`local receipts   ${dbPath}`);
    console.log(`                 ${describeStore(dbPath)}`);
    console.log(`\nNothing is removed automatically. To bound it, name a cutoff:`);
    console.log(`  ${cliCommand("prune --before 90d")}      # older than 90 days`);
    console.log(`  ${cliCommand("prune --before 2026-01-01")}`);
    console.log(`Receipts are archived beside the database before removal.`);
    process.exit(0);
  }
  const cutoff = parseSince(args[beforeIdx + 1]);
  if (cutoff === null) {
    console.error(`--before wants a duration (90d, 24h) or a date (2026-01-01); got ${args[beforeIdx + 1] ?? "nothing"}`);
    process.exit(1);
  }
  const iso = new Date(cutoff).toISOString();
  const { store } = openReceiptStore({ db: dbPath });
  const sqlite = store as typeof store & {
    before?(iso: string): unknown[];
    removeBefore?(iso: string): { removed: number };
  };
  if (!sqlite.before || !sqlite.removeBefore) {
    console.error("this receipt store does not support pruning (no SQLite available).");
    process.exit(1);
  }
  try {
    const doomed = sqlite.before(iso);
    if (doomed.length === 0) { console.log(`no receipts older than ${iso}.`); process.exit(0); }
    const before = describeStore(dbPath);
    console.log(`${doomed.length} receipt(s) recorded before ${iso} (store is currently ${before}).`);
    if (!args.includes("--yes") && !process.stdin.isTTY) {
      console.error(`\nThis removes signed evidence, so it needs an explicit confirmation:`);
      console.error(`  ${cliCommand(`prune --before ${args[beforeIdx + 1]} --yes`)}`);
      process.exit(1);
    }
    const archive = join(dir, `receipts-archived-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
    writeFileSync(archive, `${doomed.map((r) => JSON.stringify(r)).join("\n")}\n`);
    console.log(`archived to      ${archive}`);
    const { removed } = sqlite.removeBefore(iso);
    console.log(`removed          ${removed} receipt(s)`);
    store.close?.();
    console.log(`store now        ${describeStore(dbPath)}`);
    console.log(`\nThe archive is a plain JSONL of signed receipts — still verifiable, still yours.`);
    process.exit(0);
  } catch (error) {
    try { store.close?.(); } catch { /* closing after a failure */ }
    console.error(`prune refused: ${(error as Error).message}`);
    process.exit(1);
  }
}

/** A `--since` value: a duration (`7d`, `24h`, `30m`) or an ISO-ish date. */
export function parseSince(value: string | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const duration = /^(\d+)\s*([dhm])$/i.exec(value.trim());
  if (duration) {
    const scale = { d: 86_400_000, h: 3_600_000, m: 60_000 }[duration[2].toLowerCase() as "d" | "h" | "m"];
    return now - Number(duration[1]) * scale;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

async function runVerify(): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
  const dbPath = join(dir, "receipts.db");
  const attesterPath = join(dir, "attester.key");
  if (!existsSync(dbPath) || !existsSync(attesterPath)) { console.log("nothing to verify yet (no receipts or no attester key)."); process.exit(0); }
  const { attester } = loadOrCreateAttester({ file: attesterPath });
  const { store } = openReceiptStore({ db: dbPath });
  // Verification is the one command that must read everything — that is the point of it.
  // It just should not look hung while doing so: at ~2.6 s per 20,000 receipts a long
  // history is a visible wait, so report progress on a TTY.
  const all = await Promise.resolve(store.list());
  try { store.close?.(); } catch { /* read-only */ }
  const progress = process.stdout.isTTY && all.length >= 2000;
  let ok = 0;
  const bad: string[] = [];
  for (const [index, r] of all.entries()) {
    const result = verifyReceipt(r, attester.publicKeyPem) as unknown as Record<string, boolean>;
    if (result.valid) ok += 1;
    else {
      const failed = Object.entries(result).filter(([k, v]) => k.endsWith("_valid") && v === false).map(([k]) => k);
      bad.push(`${String((r.payload as unknown as Record<string, unknown>).timestamp ?? "")}: ${failed.join(", ") || "invalid"}`);
    }
    if (progress && (index + 1) % 1000 === 0) process.stderr.write(`\rverifying ${index + 1}/${all.length}…`);
  }
  if (progress) process.stderr.write("\r".padEnd(40) + "\r");
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
  const harnessesFor = (): Harness[] => args.includes("--codex") ? ["codex"]
    : args.includes("--cursor") ? ["cursor"]
    : args.includes("--claude") ? ["claude"]
    : ["claude", ...(cursorDetected() ? ["cursor" as const] : []), ...(codexDetected() ? ["codex" as const] : [])];
  // `install` rewrites agent config files the user did not create — their theme, plugins
  // and permissions live in ~/.claude/settings.json — so there is a way to see exactly
  // what it would touch before it touches anything.
  if (args.includes("--dry-run")) {
    console.log(`Dry run — nothing is written.\n`);
    console.log(`Would scaffold      ${dir} (machine key, countersigning key, starter policy)`);
    for (const h of harnessesFor()) {
      const file = userHarnessFile(h);
      const exists = existsSync(file);
      console.log(`Would ${exists ? "modify" : "create"} ${file}`);
      if (exists) console.log(`  backing it up to  ${file}.scopebond-backup`);
      console.log(`  adding hook       ${absoluteHookCommand(cliPath(), h)}`);
      if (exists && isHarnessConfigured(file)) console.log(`  (a Scopebond hook is already there; it would be replaced, not duplicated)`);
    }
    console.log(`\nNothing else in those files is changed. Run without --dry-run to apply.`);
    process.exit(0);
  }
  const { agentKid, policyPath } = scaffold(dir, { force: args.includes("--force") });
  console.log(`Scopebond installed for this user in ${dir}`);
  console.log(`  machine key    ${agentKid}`);
  console.log(`  policy         ${policyPath} (starter — edit the limits)`);
  console.log("");
  const harnesses: Harness[] = harnessesFor();
  if (!args.includes("--no-install")) {
    for (const h of harnesses) {
      try {
        const target = userHarnessFile(h);
        const backup = existsSync(target) ? `${target}.scopebond-backup` : null;
        const file = writeHarnessConfig(target, h, absoluteHookCommand(cliPath(), h));
        console.log(`✓ ${harnessName(h)} configured in ${file}`);
        if (backup && existsSync(backup)) console.log(`  original kept at ${backup}`);
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

/** Size and count of the local receipt store, plus its write-ahead log. Signed evidence
 *  accumulates in the user's project directory and there is no automatic deletion — so
 *  the footprint is reported rather than left to be discovered. */
function describeStore(dbPath: string): string {
  const bytes = (file: string): number => { try { return statSync(file).size; } catch { return 0; } };
  const total = bytes(dbPath) + bytes(`${dbPath}-wal`) + bytes(`${dbPath}-shm`);
  const human = total >= 1024 * 1024 ? `${(total / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(total / 1024))} KiB`;
  let count: number | null = null;
  try {
    const { store } = openReceiptStore({ db: dbPath });
    try { count = store.count ? Number(store.count()) : null; } finally { store.close?.(); }
  } catch { count = null; }
  return count === null ? human : `${count} receipt(s), ${human}`;
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
  console.log(`  local receipts   ${existsSync(dbPath) ? `${dbPath} (${describeStore(dbPath)})` : "none yet"}`);
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
  // Both scopes. Checking only the user config meant that after a per-project `init` —
  // the install the site actually tells people to run — `uninstall` reported "no
  // user-level harness config found" and left the project hook in place.
  for (const h of ["claude", "cursor", "codex"] as Harness[]) {
    for (const file of [projectHarnessFile(h, process.cwd()), userHarnessFile(h)]) {
      if (removeHarnessConfig(file)) { console.log(`✓ removed the Scopebond hook from ${file}`); removed++; }
    }
  }
  if (removed === 0) console.log("no Scopebond hook found in this project or your user config.");
  if (args.includes("--purge")) { purgeHome(); console.log(`✓ purged ${userHome()} (keys, policy, receipts)`); }
  else console.log(`Kept ${userHome()} (keys, policy, receipts). Use --purge to remove it too.`);
  const projectDir = resolveConfigDir(process.cwd());
  if (existsSync(join(projectDir, "policy.json"))) {
    console.log(`Kept ${projectDir} (this project's keys, policy and receipts) — delete it by hand if you want it gone.`);
  }
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

/** What each command does, its arguments, and one example. The whole help used to be a
 *  single usage line listing 15 command names, which told a reader nothing about what any
 *  of them did or what arguments they take. */
const COMMANDS: Array<{ name: string; args?: string; summary: string; detail?: string[] }> = [
  { name: "init", args: "[--cursor|--codex] [--no-install] [--npx] [--force] [--yes]",
    summary: "set this project up: keys, a starter policy, and your agent wired to the hook",
    detail: [
      "Writes .scopebond/ (machine key, countersigning key, starter policy, .gitignore) and",
      "configures .claude/settings.json, .cursor/hooks.json or .codex/hooks.json.",
      "Pins a durable copy of this package so the hook starts fast; --npx keeps the portable",
      "command instead. --no-install prints the config snippet rather than writing it.",
      "Needs a terminal, or --yes in a script, because it changes what governs your agent.",
    ] },
  { name: "install", args: "[--claude] [--cursor] [--codex] [--dry-run] [--force] [--yes]",
    summary: "set up once for this user, so every project you open is governed",
    detail: [
      "Scaffolds ~/.scopebond and registers the hook in your user-level agent config.",
      "--dry-run prints exactly which files it would touch and changes nothing. Each config",
      "is copied to <file>.scopebond-backup before its first modification.",
    ] },
  { name: "rules", args: "[show|allow|block|protect|unprotect|protect-branch|unprotect-branch|apply] [value]",
    summary: "read and change the limits in plain terms",
    detail: [
      "With no arguments, prints what is blocked in plain English — no regular expressions.",
      "The editable lists are .scopebond/rules.json; policy.json is compiled from them, so",
      "you never hand-write a lookahead.",
      "  rules allow dd                stop blocking a program",
      "  rules protect infra/          never write there",
      "  rules protect-branch production",
      "  rules apply                   recompile after editing rules.json by hand",
    ] },
  { name: "status", summary: "what is configured, where, and how big the local log is" },
  { name: "doctor", summary: "check the setup and whether each configured hook command can start",
    detail: ["Exits non-zero when something is wrong, so it works in a script."] },
  { name: "log", args: "[-n N] [--deny] [--since 7d]",
    summary: "the recent decisions",
    detail: [`--deny shows only blocked actions; --since takes 7d, 24h, 30m or a date.`, `e.g. ${cliCommand("log --deny --since 7d")}`] },
  { name: "verify", summary: "check every local receipt offline against the countersigning key",
    detail: ["No network, no account. Exits non-zero if any receipt fails."] },
  { name: "test", args: '"<shell command>"',
    summary: "show the decision for a command without running or recording it",
    detail: [`e.g. ${cliCommand('test "rm -rf /"')}`] },
  { name: "prune", args: "[--before 90d] [--yes]",
    summary: "report the local store's size, or bound it",
    detail: [
      "With no --before it only reports. With one, it archives the receipts it will remove",
      "to a JSONL file beside the database, then removes them. Refuses once the log has been",
      "anchored, because a receipt's position is its anchor leaf index.",
    ] },
  { name: "connect", args: "<workspace-url> <enrollment> [--claude|--cursor|--codex]",
    summary: "send receipts to a Scopebond Cloud workspace as well as keeping them locally" },
  { name: "flush", summary: "deliver any receipts still queued for the workspace now" },
  { name: "trust", args: "[--yes]", summary: "let this project's .scopebond policy govern here (pinned by hash)" },
  { name: "uninstall", args: "[--purge] [--yes]", summary: "remove the hook from your agent config; --purge also deletes the home" },
  { name: "claude", summary: "(internal) decide one Claude Code PreToolUse call, JSON on stdin" },
  { name: "cursor", summary: "(internal) decide one Cursor hook event, JSON on stdin" },
  { name: "codex", summary: "(internal) decide one Codex PreToolUse call, JSON on stdin" },
];

function printHelp(topic: string | undefined, toStderr = false): void {
  const out = toStderr ? console.error : console.log;
  const match = topic ? COMMANDS.find((c) => c.name === topic.replace(/^--?/, "")) : undefined;
  if (match) {
    out(`scopebond-hook ${match.name}${match.args ? ` ${match.args}` : ""}`);
    out("");
    out(`  ${match.summary}`);
    if (match.detail) { out(""); for (const line of match.detail) out(`  ${line}`); }
    return;
  }
  if (topic) { out(`no such command: ${topic}`); out(""); }
  out(`scopebond-hook — govern a coding agent's tool calls against policy, before they run.`);
  out("");
  out(`  ${cliCommand("init")}            set up this project`);
  out(`  ${cliCommand('test "rm -rf /"')}  see a decision without running it`);
  out(`  ${cliCommand("log --deny")}      what got blocked`);
  out(`  ${cliCommand("rules")}           what is blocked, in plain English`);
  out("");
  out("Commands:");
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  for (const command of COMMANDS) {
    if (command.summary.startsWith("(internal)")) continue;
    out(`  ${command.name.padEnd(width)}  ${command.summary}`);
  }
  out("");
  out(`  ${"help".padEnd(width)}  \`help <command>\` for that command's arguments and examples`);
  out("");
  out(`Receipts and keys stay in .scopebond/ in this project. Nothing leaves your machine`);
  out(`unless you run \`connect\`. Docs: https://github.com/avouro-com/scopebond`);
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
else if (cmd === "prune") { await runPrune(rest); }
else if (cmd === "rules") { runRules(rest); }
else if (cmd === "help" || cmd === "--help" || cmd === "-h" || cmd === undefined) { printHelp(rest[0]); }
else {
  console.error(`unknown command: ${cmd}`);
  printHelp(undefined, true);
  process.exit(1);
}
