// scopebond-hook's commands, as `main(argv)`. `cli.ts` is the program npm installs and agent settings name; the single
// executable calls `main` the same way. Nothing here runs when the module loads.
//
// The command list, arguments and examples live in `COMMANDS` near the bottom of this
// file, which is what `scopebond-hook help [command]` prints — one source rather than a
// comment here that drifts from it.
//
// Config dir: $SCOPEBOND_HOOK_DIR, else ./.scopebond
// Fail-closed: any error denies the action with a repair message.

import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { hookCliPath, isSingleExecutable } from "./self.js";
import { textOf } from "./text.js";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { clientNameField } from "./computer-name.js";
import { execFileSync } from "node:child_process";
import type { CloudEnrollmentBundle } from "@scopebond/gateway";
import { verifyReceipt } from "@scopebond/gateway";
import { checkChains } from "./chain-verify.js";
import { openReceiptStore, loadOrCreateAttester, programPath, windowsSystemProgram } from "@scopebond/gateway/node";
import * as gatewayNode from "@scopebond/gateway/node";
import { callRequestOf, keyedIdFor, TYPED_ACTION_TYPES } from "./typed-ops.js";
import { databaseGuardActions } from "./typed-infra.js";
import { mapClaudeToolUse, mapCodexToolUse, mapCopilotCall, copilotAsClaude, mapCursorEvent, fillPushBranch, type Mapped } from "./map.js";
import { copilotCloudAgent, copilotSurface, surfaceSignals, recordCopilotProbe, openCopilotProbe, readCopilotProbe, renderCopilotProbe, COPILOT_PROBE_FILE } from "./copilot-surface.js";
import { copilotAnswer, type CopilotAnswer } from "./copilot-answer.js";
import { createHash } from "node:crypto";
import { createHookRuntime, readPolicyFile, type Decision } from "./runtime.js";
import { upstreamBranch } from "./git-upstream.js";
import { hookErrorLine, recordHookError, setHookErrorContext } from "./hook-errors.js";
import { useDigestKey, loadOrCreateDigestKey } from "./minimize.js";
import { replaceFile } from "./safe-fs.js";
import { scaffold, harnessSnippet, placeHook, coverWithoutNpx, migrateToMonitorDefault, installRepositoryHooks, REPO_HARNESSES, type HookPlacement } from "./init.js";
import { onboardingSteps } from "./onboarding.js";
import { dedupeHooks, describeEntry, duplicateHooks, type HookScope } from "./duplicates.js";
import { executionPolicyAdvice, loginAgainCommand, nodeTooOldLines, retryCommand, unreachableHint } from "./windows-hints.js";
import { approvalSummary, retryAfterSeconds } from "./login-approval.js";
import { createInterface } from "node:readline/promises";
import {
  userHome, userHarnessFile, resolveConfigDir, writeHarnessConfig, removeHarnessConfig,
  cursorDetected, codexDetected, copilotDetected, harnessDetected, HARNESSES, COPILOT_DECISION_DEADLINE_MS,
  absoluteHookCommand, nativeHookCommand, isHarnessConfigured, purgeHome, type Harness,
  harnessScopes, harnessScopeLabel, configuredHookCommands, hookCommandResolves, projectHarnessFile,
  localHarnessFile, gitShareState, isMachineSpecificCommand, trustProjectPolicy, untrustedProjectPolicy, isTrustedProject, decisionStateDir,
  wireLifecycleHooks, unwireLifecycleHooks, nativeHookProgram, missingHookPrograms, quotedEntryNote,
  npxAvailable, samePath,
} from "./install.js";
import {
  openObservations, describeObservations, observationStatus, stopReasonFromClaude, exitFromClaudeFailure,
  heartbeatIntervalMs, OBSERVATIONS_SCOPE, type ObservationEmitter,
} from "./obs-emitter.js";
import { OBSERVATION_DB, ObservationStore } from "./obs-store.js";
import { loadOrCreateBindingKey } from "./observation.js";
import { uploadPending } from "./obs-upload.js";
import { connectCloud, ingestUrl, loadConnection, reportUninstall, uninstallReportLine, UNINSTALL_CALLER_ENV, UNINSTALL_NOT_TOLD_EXIT } from "./cloud.js";
import { recoverEarlierReceipts } from "./recover.js";
import { loadPolicyExport, policyBuilds } from "./policy-load.js";
import { compileManaged, isManaged, readMeta, writeMeta, MANAGED_DOC_FILE, type ManagedDocument } from "./managed.js";
import { agentPresence, healthLines, recommendedFrom, NATIVE_DOWNLOAD_URL } from "./client-health.js";
import { localRetentionDays, runStoreUpkeep, upkeepIfDue } from "./store-upkeep.js";
import { createOverrideHandler, overrideHint, overrideRemedy, PROMPTING_MODES } from "./override.js";
import { checkInstalls, VERDICT_TIMEOUT_MS } from "./install-verdicts.js";
import { markRulesDroppedTold, rulesDroppedNotice, syncIfDue, syncPolicy, type SyncOptions, type SyncOutcome } from "./policy-sync.js";
import { loadBudgetExport } from "./budget-load.js";
import { receiptContextFor, repositoryFacts } from "./receipt-context.js";
import { noteBlock, projectOf } from "./block-notes.js";
import { RepositoryEnrollmentError, isRepositoryConnection, repositoryConnectionDir, REPO_TOKEN_ENV } from "./repo-enrol.js";
import { REPO_HOOK_MARKER } from "./init.js";
import { keyedSessionId, sessionBudgetGuardFor } from "./session-budgets.js";
import { compile, defaultRules, describeRules, loadRules, saveRules, rulesPath, pathRuleFor, SWITCHABLE_RULES } from "./rules.js";
import { createSigner } from "@scopebond/sdk";
import { runDispatchCommand } from "./dispatch-cli.js";
import { describeAction, type ExplainIntent } from "./explain.js";
import { ensureDurableRuntime, pinnedCliPath, isEphemeralPath } from "./runtime-install.js";
import { cliCommand, hookCommand, hookVersion } from "./version.js";
import { withHookVersion } from "./workspace-fetch.js";
import { activatePacks, checkPackText, installPack, loadPacks, packsDir, removePack } from "./pack-store.js";
import { switchablePackRules } from "./pack-rules.js";
import { runPackVectors } from "./packs.js";
import { loadIntelPlugin } from "./intel-plugin.js";
import { validatePack, type Pack } from "@scopebond/policy-schema/pack";
import { describePackSync } from "./pack-sync.js";
import { approvedWorkspaceId, machineIdField, machineIdFor } from "./machine-id.js";
import { HOT_PATH_STORE_BUSY_MS, WAIT_RESERVE_MS, hookDeadlineRemainingMs, waitWithinDeadline } from "./hook-deadline.js";
import { policyKeyProblems } from "./policy-keys.js";
import { recordDeliveryAttempt, recordRulesCredential } from "./delivery-state.js";
import { describeDelivery, flushOutcome } from "./delivery-report.js";
import { buildStatusJson } from "./status-json.js";
import { computeManifest, renderManifest, HOST_ENFORCEMENT } from "./capabilities.js";
import { runProofFixtures, loadProofs, saveProofs, proofPassed, deliverProofReceipts } from "./proof.js";

/** The current git branch in `cwd` (best-effort). A bare `git push` pushes it, so
 *  the runtime fills it in before evaluating; on failure the ref stays absent and
 *  the starter policy fails closed. git is started by its full path from PATH, never
 *  from `cwd`, which is the project and could hold a git.exe of its own. */
function currentBranch(cwd: string): string | null {
  try {
    return execFileSync(programPath("git"), ["-C", cwd, "symbolic-ref", "--quiet", "--short", "HEAD"], {
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
function runtimePaths(dir: string, cwd?: string) {
  const connection = loadConnection(dir);
  return {
    policyPath: join(dir, "policy.json"),
    keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"),
    dbPath: join(dir, "receipts.db"),
    ...(cwd ? { cwd } : {}),
    // Strict: deny (not just observe) tools with no taxonomy mapping.
    strict: process.argv.includes("--strict") || process.env.SCOPEBOND_HOOK_STRICT === "1",
    // When connected, auto-export receipts. A short bounded flush keeps the hot path
    // fast; undelivered receipts persist in the durable outbox and flush next time
    // (or via `scopebond-hook flush`, e.g. on a session-end hook).
    ...(connection ? { cloud: { connection, flushTimeoutMs: Number(process.env.SCOPEBOND_HOOK_FLUSH_MS ?? 800) } } : {}),
  };
}
/** The harness's own id for this tool call, when it gives one (Claude Code and Codex send
 *  `tool_use_id`), so the receipts of one call share a stable action group. */
/** The keyed session id for session-scoped allowances; null when it cannot be read (such an allowance then does not apply). */
function sessionKeyOf(dir: string, input: Record<string, unknown>): string | null {
  try { return keyedSessionId(dir, input); } catch { return null; }
}

function callId(input: Record<string, unknown>): string | undefined {
  for (const key of ["tool_use_id", "tool_call_id", "call_id"]) {
    const value = input?.[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}
function readStdin(): string {
  // A UTF-8 byte-order mark is not part of the event: Windows PowerShell 5.1 and other .NET Framework
  // programs write one before what they pipe in, and JSON.parse refuses it.
  try { return readFileSync(0, "utf8").replace(/^\uFEFF/, ""); } catch { return ""; }
}

/** How long a hook waits for a person in the Scopebond window: well inside each agent's hook timeout (Claude Code 60 s by
 *  default; the Codex entry Scopebond writes says 30 s; for Copilot, inside the hook's own deadline, which is itself inside
 *  the 60 s its entry says), so the wait ends as a block, never as a timed-out hook. */
const OVERRIDE_WAIT_MS: Record<Harness, number> = { claude: 45_000, codex: 20_000, cursor: 20_000, copilot: 25_000 };

/** Warn mode: Claude Code shows the person its own prompt for this action (only where the workspace allows it and Claude Code
 *  really asks; see override.ts). */
function askClaude(reason: string): never {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
  }) + "\n");
  process.exit(0);
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

/** GitHub Copilot: the decision on stdout, and exit 2, which Copilot treats as a deny whatever stdout says, so a deny holds
 *  even if the JSON were lost. `permissionDecisionReason` is required with a deny; it is what the agent is told. */
function denyCopilot(reason: string): never {
  answerCopilot(copilotAnswer("deny", reason, false));
}

/** GitHub Copilot's "ask": the CLI asks the person. The cloud coding agent, with no one to ask, treats "ask" as a deny
 *  anyway; there Scopebond answers the deny itself, with the reason (see `copilotAnswer`). */
function askCopilot(reason: string): never {
  answerCopilot(copilotAnswer("ask", reason, copilotCloudAgent()));
}

function answerCopilot(answer: CopilotAnswer): never {
  process.stdout.write(answer.stdout);
  if (answer.stderr) process.stderr.write(answer.stderr);
  process.exit(answer.exitCode);
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

const harnessName = (harness: Harness): string => harness === "claude" ? "Claude Code" : harness === "cursor" ? "Cursor" : harness === "copilot" ? "GitHub Copilot" : "Codex";
const harnessFileName = (harness: Harness): string => harness === "claude" ? ".claude/settings.json" : harness === "cursor" ? ".cursor/hooks.json" : harness === "copilot" ? ".github/hooks/scopebond.json" : ".codex/hooks.json";
const selectedHarness = (args: string[]): Harness => args.includes("--codex") ? "codex" : args.includes("--cursor") ? "cursor" : args.includes("--copilot") ? "copilot" : "claude";
const codexTrustStep = "Open Codex, run `/hooks`, review Scopebond, and choose Trust. Then start a new task.";
/** How far Copilot's hook can be relied on, said wherever Copilot is set up or reported: never as "in the path". */
const COPILOT_ENFORCEMENT = HOST_ENFORCEMENT.copilot_cli ?? "cooperative";
/** What GitHub Copilot can and cannot stop, said at install time. */
const copilotCoverageNote = [
  `What this covers in GitHub Copilot (${COPILOT_ENFORCEMENT}):`,
  "  checked    shell commands (and what write_bash types), file reads and edits, git pushes",
  "             — before they run",
  "  recorded   web fetches; tools Scopebond has no mapping for (MCP tools, sub-agent tasks)",
  "Copilot runs the action anyway when a hook times out. Scopebond answers within its own",
  "deadline (shorter than the entry's timeoutSec) and denies when it cannot decide in time.",
  "This covers the Copilot CLI. VS Code's agent mode reads this file too, but it sends its own",
  "tool names, so its actions are not covered yet. The cloud coding agent can run it with a",
  "repository token (`init --repo`); that is not verified yet, so gate its pull requests with",
  "the GitHub Action.",
].join("\n");
/** Said after `init --copilot` writes the project file: the cloud agent reads it from the default branch. */
const COPILOT_CLOUD_COMMIT_WARNING = "Committing .github/hooks/scopebond.json makes the Copilot cloud agent deny every action until Scopebond is set up there";
/** The deny a Copilot call gets where Scopebond has no setup at all (typically the cloud agent's sandbox). */
const COPILOT_NOT_SET_UP = "Scopebond is not set up in this environment; the Copilot cloud agent is not covered: give it a SCOPEBOND_REPO_TOKEN secret (see `scopebond init --repo`), or remove .github/hooks/scopebond.json from the default branch";
/** The deadline timer of the Copilot call in progress, cleared once the call is allowed (the rest is record delivery). */
let copilotDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
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

/** Record what was dispatched as observations, when this workspace enrolled for them. Purely
 *  additive: it runs after the decision is made and can neither change it nor fail it. */
function recordObservations(dir: string, cwd: string, input: Record<string, unknown>, decision: Decision, harness: Harness): ObservationEmitter | undefined {
  try {
    // After the decision, before it is written: a busy observation log waits briefly (it is additive and may miss).
    const { emitter } = openObservations(dir, { adapterVersion: hookVersion(), busyTimeoutMs: 2_000 });
    if (!emitter) return undefined;
    const sessionId = typeof input.session_id === "string" && input.session_id !== "" ? input.session_id : undefined;
    // Session lifecycle is Claude Code's and GitHub Copilot's: their SessionStart/SessionEnd hooks are the ones the
    // mapping covers. Other hosts still get tool intents from their PreToolUse.
    if ((harness === "claude" || harness === "copilot") && sessionId) emitter.activity(sessionId, cwd);
    emitter.toolIntents({ harnessSessionId: sessionId, callId: callId(input), cwd, dispatched: decision.dispatched ?? [], request: callRequestOf(input) });
    return emitter;
  } catch { return undefined; }
}

/** The remote-database actions of a shell call, only when the rule set opts in (`protect_remote_database`).
 *  They are extra evaluated intents read from the raw command, so the deny happens before it runs. */
function databaseGuard(dir: string, cwd: string, input: Record<string, unknown>): Mapped[] {
  let enabled: boolean;
  try { enabled = loadRules(dir)?.protect_remote_database === true; } catch { return []; }
  if (!enabled) return [];
  const request = callRequestOf(input);
  if (request?.command === undefined) return [];
  const intent = (params: Record<string, unknown>): Mapped => ({ intent: { action_type: "db.exec", params }, evaluated: true, source: "shell" });
  try {
    return databaseGuardActions(request.command, request.dialect ?? "posix", { cwd }).map((action) => intent({ ...action }));
  } catch {
    // The rule is on and the reader failed: a command that names a database tool is not waved through.
    return /(?:wrangler|psql)/i.test(request.command) ? [intent({ provider: "unknown", verb: "unknown", scope: "unknown", risk: "unknown" })] : [];
  }
}

/** The one fix for a failure while deciding: the error's own when it names one, else the command that fixes its kind (a broken
 *  rules file, a full disk, a folder this account cannot write, a missing file), naming the file. `init` alone never helped a
 *  file that exists: it writes only what is missing. */
export function repairFor(error: unknown): string {
  const e = (error ?? {}) as { repair?: unknown; code?: unknown; path?: unknown; file?: unknown; kind?: unknown; managed?: unknown; message?: unknown };
  const repair = e.repair;
  if (typeof repair === "string" && repair) return repair;
  const file = typeof e.file === "string" ? e.file : typeof e.path === "string" ? e.path : null;
  if (e.code === "ENOSPC") return "free some disk space on this computer, then run the action again";
  if ((e.code === "EACCES" || e.code === "EPERM") && file) return `make sure your account can read and write ${file} (it should be yours), then run \`${cliCommand("doctor")}\``;
  // A computer that follows its workspace's rules refuses `rules apply`, and `init --force` would drop the workspace's rules:
  // the fix is to fetch them again (a rules file that is missing or does not parse is installed again, not "unchanged").
  if (e.kind === "policy" && e.managed === true) {
    return `get your workspace's rules again with \`${cliCommand("policy sync")}\`; if that fails, ask an admin of your Scopebond workspace`;
  }
  if (e.code === "ENOENT" && file) return `${file} is missing: run \`${cliCommand("init")}\` to create it`;
  if (e.kind === "policy") {
    return `rebuild it with \`${cliCommand("rules apply")}\`; if that fails, \`${cliCommand("init --force")}\` restores the starter rules (it replaces your own rules and settings in that folder)`;
  }
  // A busy local log is another Scopebond check on this computer writing at the same moment (two agents at once), not a
  // broken setup: init would not help.
  if (/database is locked|SQLITE_BUSY/i.test((error as Error | null)?.message ?? "")) {
    return `another Scopebond check on this computer was writing at the same moment; run the action again (if it keeps happening, \`${cliCommand("status")}\` says what holds it)`;
  }
  return `run \`${cliCommand("doctor")}\`, which names what is broken and the command that fixes it`;
}

/** What a Copilot check that ran out of time answers. */
const copilotDeadlineReason = (): string =>
  `Scopebond hook failed closed: the check did not finish within ${Math.round(copilotDeadlineMs() / 1000)} s, and GitHub Copilot would run the action unchecked if the hook timed out. Repair: run \`${cliCommand("doctor")}\`, then try the action again.`;
const copilotDeadlineMs = (): number => {
  const configured = Number(process.env.SCOPEBOND_COPILOT_DEADLINE_MS);
  return Number.isFinite(configured) && configured > 0 && configured < COPILOT_DECISION_DEADLINE_MS ? configured : COPILOT_DECISION_DEADLINE_MS;
};

/** How a host answers a Safe Install "ask": Claude Code asks the person in a permission mode that prompts, Cursor and GitHub
 *  Copilot always do (Copilot's cloud agent treats "ask" as a deny); Codex cannot ask, so the install is refused with how to go
 *  ahead. */
function installAskFor(harness: Harness, permissionMode: string | null): "ask" | "deny" {
  if (harness === "claude") return permissionMode !== null && PROMPTING_MODES.has(permissionMode) ? "ask" : "deny";
  return harness === "cursor" || harness === "copilot" ? "ask" : "deny";
}

/** Safe Install: verdicts for the installs a call would run (install-verdicts.ts), within what is left of the hook's deadline.
 *  Unchanged when the call installs nothing it checks or the check is off here. */
async function withInstallVerdicts(dir: string, mapped: Mapped[], ask: "ask" | "deny"): Promise<Mapped[]> {
  const left = hookDeadlineRemainingMs() - WAIT_RESERVE_MS;
  return checkInstalls(dir, mapped, {
    connection: loadConnection(dir), ask, headers: { "x-scopebond-hook-version": hookVersion() },
    timeoutMs: Math.max(250, Math.min(VERDICT_TIMEOUT_MS, Number.isFinite(left) ? left : VERDICT_TIMEOUT_MS)),
  });
}

/** For the tray: the rule, project and tool of a blocked call, noted on this computer (block-notes.ts). Never throws. */
function noteIfBlocked(dir: string, cwd: string, harness: Harness, decision: Decision, input?: Record<string, unknown>): void {
  if (decision.decision !== "deny") return;
  try { noteBlock(dir, decision, { harness, project: projectOf(repositoryFacts(cwd).repository, cwd), session: input ? sessionKeyOf(decisionStateDir(dir), input) : null }); } catch { /* the receipt is the record */ }
}

/** `deadlineAt`: a time after which the call is denied rather than evaluated (GitHub Copilot, whose hook timeouts fail
 *  open). It is checked once the policy and keys are loaded, before the action is evaluated: a load held up by a busy disk
 *  or a lock is synchronous, so a timer alone could not interrupt it. */
async function runPreToolUse(mapper: (input: Record<string, unknown>) => Mapped[], deny: (reason: string) => never = denyClaude, raw?: string, harness: Harness = "claude", deadlineAt?: number): Promise<void> {
  let input: Record<string, unknown>;
  try { input = JSON.parse(raw ?? readStdin()); } catch { deny("hook received invalid JSON on stdin"); }
  let runtime: ReturnType<typeof createHookRuntime> | undefined;
  let configFolder: string | undefined;
  try {
    const cwd = input?.cwd ? textOf(input.cwd) : process.cwd();
    configFolder = resolveConfigDir(cwd);
    // A repository token (a cloud agent's sandbox, a CI job) connects this hook as that repository when no one signed in here.
    const dir = await repositoryConnectionDir(configFolder, { home: userHome(), repository: () => repositoryFacts(cwd).repository });
    configFolder = dir;
    setHookErrorContext(dir, harness, hookVersion());
    // The rule packs cached here (pack-store.ts): verified now, used by the mapper below. A bad or expired pack is not used.
    activatePacks(dir);
    // A repository run decides nothing before its workspace's rules are loaded once: in a fresh sandbox the starter rules
    // would let through what the workspace blocks. Tried again on every call until it succeeds.
    await requireRepositoryRules(dir);
    const permissionMode = typeof input!.permission_mode === "string" ? input!.permission_mode : null;
    // Rules written before monitor became the default move to it once (never fails the call).
    try { migrateToMonitorDefault(dir); } catch { /* the policy on disk stays in force */ }
    const branch = currentBranch(cwd);
    // Where these receipts come from (harness, model, keyed session id, repository, branch); null while a connected
    // workspace has not said it reads it. Never fails the call.
    const context = receiptContextFor({ harness, input: input!, dir, cwd, connected: !!loadConnection(dir), branch });
    const installAsk = installAskFor(harness, permissionMode);
    const actions = await withInstallVerdicts(dir, [...fillPushBranch(mapper(input!), branch, () => upstreamBranch(cwd)), ...databaseGuard(dir, cwd, input!)], installAsk);
    // The signed plugin in this computer's home, when there is one that verifies (intel-plugin.ts); none: receipts unchanged.
    const intel = await loadIntelPlugin();
    runtime = createHookRuntime({ ...runtimePaths(dir, cwd), context, installAsk, intel, sessionBudgets: sessionBudgetGuardFor(dir, input!), storeBusyTimeoutMs: HOT_PATH_STORE_BUSY_MS, override: (agentKid) => {
      const made = createOverrideHandler({ dir: decisionStateDir(dir), home: userHome(), agentKid, harness, permissionMode, sessionId: sessionKeyOf(decisionStateDir(dir), input!), project: () => projectOf(repositoryFacts(cwd).repository, cwd), cwd, waitMs: () => waitWithinDeadline(OVERRIDE_WAIT_MS[harness]) });
      return made ? { handler: made.handler, hint: () => overrideHint(made.note()), remedy: () => overrideRemedy(made.note()) } : null;
    } });
    useDigestKey(loadOrCreateDigestKey(dir));
    if (deadlineAt !== undefined && Date.now() > deadlineAt) { runtime.close(); runtime = undefined; recordHookError("deadline", copilotDeadlineReason()); deny(copilotDeadlineReason()); }
    const decision = await runtime.evaluate(actions, { groupKey: callId(input!) });
    noteIfBlocked(dir, cwd, harness, decision, input!);
    // Allowed: what is left is record delivery, which must not turn an allowed call into a "did not finish" deny.
    if (decision.decision === "allow" && copilotDeadlineTimer !== undefined) { clearTimeout(copilotDeadlineTimer); copilotDeadlineTimer = undefined; }
    const observer = recordObservations(dir, cwd, input!, decision, harness);
    // Workspace rules: at most every five minutes, a capped check alongside the record delivery. It never fails the call.
    await Promise.all([runtime.flush(), observer?.flush() ?? Promise.resolve(), syncIfDue(dir, () => syncOptionsFor(dir))]);
    observer?.close();
    // Close before deciding: the receipt is already committed, and leaving the handle
    // open is what made the write-ahead log grow without bound.
    runtime.close();
    runtime = undefined;
    keepStore(dir);
    // C-03: once, the person is told that a refused connection put this computer back on its own rules: with a deny, in its
    // reason; on an allow, as Claude Code's warning line (other agents read it on their next deny, and `status` always says it).
    const dropped = rulesDroppedNotice(dir, cliCommand("login"));
    // Marked told only where it is said: in a deny's or an ask's reason, or Claude Code's warning line on an allow.
    if (dropped && (decision.decision === "deny" || decision.decision === "ask" || harness === "claude")) markRulesDroppedTold(dir);
    const told = (reason: string): string => (dropped ? `${reason}\n${dropped}` : reason);
    if (decision.decision === "deny") deny(told(decision.reason));
    // Only Claude Code is offered "ask" by the override (override.ts); Copilot is answered "ask" if a decision ever is one
    // (its cloud agent reads that as a deny); any other harness treats it as a denial.
    if (decision.decision === "ask") {
      if (harness === "claude") askClaude(told(decision.reason));
      if (harness === "copilot") askCopilot(told(decision.reason));
      deny(told(decision.reason));
    }
    // Stay silent on allow/not_evaluated so the coding agent's normal permission
    // flow remains in charge. Scopebond blocks; it never silently approves. (A warning line is not a decision.)
    if (dropped && harness === "claude") process.stdout.write(`${JSON.stringify({ systemMessage: dropped })}\n`);
    process.exit(0);
  } catch (error) {
    try { runtime?.close(); } catch { /* already failing; the deny below is what matters */ }
    if (error instanceof RepositoryEnrollmentError) { recordHookError("fail_closed", error.message); deny(`Scopebond hook failed closed: ${error.message}. Repair: ${error.repair}.`); }
    // No Scopebond setup here at all (no policy): for Copilot that is the cloud agent's sandbox, so say what to do about it.
    if (harness === "copilot" && configFolder !== undefined && !existsSync(join(configFolder, "policy.json"))) deny(COPILOT_NOT_SET_UP);
    recordHookError("fail_closed", (error as Error).message);
    deny(`Scopebond hook failed closed: ${(error as Error).message}. Repair: ${repairFor(error)}.`);
  }
}

/** Claude Code events other than PreToolUse: session start and end, and the after-action
 *  events. They only feed observations; they never print a decision and always exit 0. */
/** For a repository connection: the workspace's rules must have loaded once (a rules check that succeeded) before any call is
 *  decided. Throws a RepositoryEnrollmentError (a deny with the reason) until then. */
async function requireRepositoryRules(dir: string): Promise<void> {
  if (!isRepositoryConnection(loadConnection(dir))) return;
  const meta = readMeta(dir);
  if (meta.repository_rules_at) return;
  let outcome: SyncOutcome;
  try { outcome = await syncPolicy(dir, { ...syncOptionsFor(dir), timeoutMs: 3000 }); }
  catch (error) { outcome = { state: "unavailable", message: error instanceof Error ? error.message : String(error) }; }
  if (outcome.state === "applied" || outcome.state === "unchanged" || outcome.state === "own_rules") {
    writeMeta(dir, { ...readMeta(dir), repository_rules_at: new Date().toISOString() });
    return;
  }
  const why = "message" in outcome ? outcome.message : outcome.state;
  throw new RepositoryEnrollmentError(`this repository's rules are not loaded yet (${why})`,
    { repair: "try the action again; the rules are checked again on every call until they load" });
}

/** A hook entry committed to a repository (`init --repo`, marked `--from-repo`) runs on every computer that opens the
 *  repository. Where there is neither a repository token nor a person's own connection, nothing governs this computer:
 *  it says so once on stderr, records nothing and lets the agent's own permission flow decide. A token or a person's
 *  connection keeps the usual checks (and their fail-closed answers). */
function repositoryHookNotGovernedHere(args: string[]): boolean {
  if (!args.includes(REPO_HOOK_MARKER)) return false;
  if (process.env[REPO_TOKEN_ENV]?.trim()) return false;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (const dir of [resolveConfigDir(projectDir), userHome()]) if (loadConnection(dir)) return false;
  return true;
}

async function runClaudeLifecycle(input: Record<string, unknown>): Promise<never> {
  try {
    const cwd = input.cwd ? textOf(input.cwd) : process.cwd();
    const { emitter } = openObservations(resolveConfigDir(cwd), { adapterVersion: hookVersion() });
    const sessionId = typeof input.session_id === "string" && input.session_id !== "" ? input.session_id : undefined;
    if (emitter) {
      try {
        switch (input.hook_event_name) {
          case "SessionStart": if (sessionId) emitter.sessionStart(sessionId, cwd); break;
          case "SessionEnd": if (sessionId) emitter.sessionStop(sessionId, stopReasonFromHost(input.reason)); break;
          case "Stop": if (sessionId) emitter.activity(sessionId, cwd); break;
          case "PostToolUse": { const id = callId(input); if (id) emitter.toolOutcomes(sessionId, id, "ok"); break; }
          case "PostToolUseFailure": { const id = callId(input); if (id) emitter.toolOutcomes(sessionId, id, exitFromClaudeFailure(input.is_interrupt)); break; }
        }
        await emitter.flush(input.hook_event_name === "SessionEnd" ? 1500 : 800);
      } finally { emitter.close(); }
    }
  } catch { /* observations are best effort; nothing here may affect the agent */ }
  process.exit(0);
}

const CLAUDE_OBSERVATION_EVENTS = new Set(["SessionStart", "SessionEnd", "PostToolUse", "PostToolUseFailure"]);

/** A session's end reason as Claude Code or GitHub Copilot gives it. Copilot's `complete` and `user_exit` are an ordinary
 *  end and `abort` a cancel; its `error` and `timeout`, like anything unrecognised, stay unknown. */
function stopReasonFromHost(reason: unknown): ReturnType<typeof stopReasonFromClaude> {
  if (reason === "complete" || reason === "user_exit") return "completed";
  if (reason === "abort") return "cancelled";
  return stopReasonFromClaude(reason);
}

/** Copilot sends no id for a tool call. The same call (session, tool and arguments) gets the same id before and after it
 *  runs, so the after-action event finds what the before-action hook recorded. Two identical calls in one session share
 *  one id; the first after-action event then settles both, which is the cost of having no id to read. */
function copilotCallId(call: Record<string, unknown>): string {
  const canonical = JSON.stringify([call.session_id ?? null, call.tool_name ?? null, call.tool_input ?? null]);
  return `copilot-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** Copilot's observation-only events: Claude Code's, and `Stop` (the agent finished a turn), which only marks the session
 *  active. None of them prints anything, so a `Stop` is never blocked and never forced to continue. */
const COPILOT_OBSERVATION_EVENTS = new Set([...CLAUDE_OBSERVATION_EVENTS, "Stop"]);

/** While a person has a tool-name recording window open (`capabilities --prove --copilot`), note which surface sent this
 *  call, the tool's name exactly as sent, and what Scopebond made of it. Nothing at all happens with no window open. */
function noteCopilotToolName(raw: Record<string, unknown>, call: Record<string, unknown>): void {
  try {
    if (call.tool_name === undefined) return;
    const dir = resolveConfigDir(typeof raw.cwd === "string" ? raw.cwd : undefined);
    if (!existsSync(join(dir, COPILOT_PROBE_FILE))) return;
    const mapped = mapCopilotCall(call);
    recordCopilotProbe(dir, {
      payload: raw, surface: copilotSurface(raw), signals: surfaceSignals(raw),
      mapped_as: [...new Set(mapped.map((m) => m.intent.action_type))], evaluated: mapped.length > 0 && mapped.every((m) => m.evaluated),
    });
  } catch { /* a diagnostic only */ }
}

/** `copilot`: one GitHub Copilot hook event, JSON on stdin. `PreToolUse` decides; the session and after-action events only
 *  feed observations. Copilot lets the action run when a hook times out, so the decision has a deadline of its own, inside
 *  the entry's `timeoutSec`: a check that has not finished by then is denied rather than left to time out. */
async function runCopilot(): Promise<void> {
  // Two guards: a timer for the waits that yield (the override window, a capped rules check, record delivery), and a check
  // before evaluation for loading that does not (see runPreToolUse). `SCOPEBOND_COPILOT_DEADLINE_MS` can only shorten it.
  const deadlineAt = Date.now() + copilotDeadlineMs();
  const deadline = setTimeout(() => denyCopilot(copilotDeadlineReason()), copilotDeadlineMs());
  copilotDeadlineTimer = deadline;
  const raw = readStdin();
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { clearTimeout(deadline); denyCopilot("hook received invalid JSON on stdin"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { clearTimeout(deadline); denyCopilot("hook received a payload that is not a JSON object"); }
  const call = copilotAsClaude(parsed as Record<string, unknown>);
  noteCopilotToolName(parsed as Record<string, unknown>, call);
  if (call.tool_name !== undefined && callId(call) === undefined) call.tool_use_id = copilotCallId(call);
  const event = typeof call.hook_event_name === "string" ? call.hook_event_name : "";
  if (COPILOT_OBSERVATION_EVENTS.has(event)) { clearTimeout(deadline); await runClaudeLifecycle(call); }
  await runPreToolUse(mapCopilotCall, denyCopilot, JSON.stringify(call), "copilot", deadlineAt);
}

async function runClaude(): Promise<void> {
  const raw = readStdin();
  let event: unknown; let input: Record<string, unknown> | undefined;
  try { input = JSON.parse(raw) as Record<string, unknown>; event = input?.hook_event_name; } catch { /* PreToolUse reports invalid input */ }
  if (input && typeof event === "string" && CLAUDE_OBSERVATION_EVENTS.has(event)) await runClaudeLifecycle(input);
  await runPreToolUse(mapClaudeToolUse, denyClaude, raw, "claude");
}

async function runCodex(): Promise<void> {
  await runPreToolUse(mapCodexToolUse, denyCodex, undefined, "codex");
}

function denyCursor(reason: string): never {
  process.stdout.write(JSON.stringify({ permission: "deny", agentMessage: reason }) + "\n");
  process.exit(0);
}

/** An evaluated allow: the call was allowed and every action in it was checked, permitted (or allowed by a person) or found
 *  out of policy by a monitored rule, which is signed `deny` and still allowed. An unchecked action is `not_evaluated`.
 *  `monitored` says whether a monitored rule matched any of them. */
function evaluatedAllow(decision: { decision: string; receipt?: unknown; receipts?: unknown[] }): { ok: boolean; monitored: boolean } {
  if (decision.decision !== "allow") return { ok: false, monitored: false };
  const list = decision.receipts?.length ? decision.receipts : decision.receipt !== undefined ? [decision.receipt] : [];
  const results = list.map((r) => (r as { payload?: { realtime_result?: unknown } } | null)?.payload?.realtime_result);
  return {
    ok: results.length > 0 && results.every((result) => result === "allow" || result === "approved" || result === "deny"),
    monitored: results.includes("deny"),
  };
}

/** Keep the local store small when the Scopebond Agent does not (it keeps the user home while it runs). */
function keepStore(dir: string): void {
  const home = userHome();
  if (samePath(dir, home) && agentPresence(home).state === "running") return;
  upkeepIfDue(dir);
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
  const event = textOf(input.hook_event_name ?? input.event ?? process.argv[3]);
  let permission: "allow" | "deny" | "ask";
  let message: string;
  let postHoc = false;
  let runtime: ReturnType<typeof createHookRuntime> | undefined;
  let configDir: string | undefined;
  try {
    const cwd = input?.cwd ? textOf(input.cwd) : process.cwd();
    const dir = resolveConfigDir(cwd);
    configDir = dir;
    setHookErrorContext(dir, "cursor", hookVersion());
    activatePacks(dir);
    const permissionMode = typeof input.permission_mode === "string" ? input.permission_mode : null;
    const branch = currentBranch(cwd);
    const mapped = await withInstallVerdicts(dir, fillPushBranch(mapCursorEvent(event, input), branch, () => upstreamBranch(cwd)), "ask");
    // An edit Cursor reports after saving it cannot be overridden: it already happened.
    const overridable = !mapped.some((m) => m.postHoc);
    // Rules written before monitor became the default move to it once (never fails the call).
    try { migrateToMonitorDefault(dir); } catch { /* the policy on disk stays in force */ }
    const context = receiptContextFor({ harness: "cursor", input, dir, cwd, connected: !!loadConnection(dir), branch });
    const intel = await loadIntelPlugin();
    runtime = createHookRuntime({ ...runtimePaths(dir, cwd), context, installAsk: "ask", intel, sessionBudgets: sessionBudgetGuardFor(dir, input), storeBusyTimeoutMs: HOT_PATH_STORE_BUSY_MS, override: (agentKid) => {
      const made = overridable ? createOverrideHandler({ dir: decisionStateDir(dir), home: userHome(), agentKid, harness: "cursor", permissionMode, sessionId: sessionKeyOf(decisionStateDir(dir), input), project: () => projectOf(repositoryFacts(cwd).repository, cwd), cwd, waitMs: () => waitWithinDeadline(OVERRIDE_WAIT_MS.cursor) }) : null;
      return made ? { handler: made.handler, hint: () => overrideHint(made.note()), remedy: () => overrideRemedy(made.note()) } : null;
    } });
    useDigestKey(loadOrCreateDigestKey(dir));
    const decision = await runtime.evaluate(mapped, { groupKey: callId(input) });
    noteIfBlocked(dir, cwd, "cursor", decision, input);
    const observer = recordObservations(dir, cwd, input, decision, "cursor");
    await Promise.all([runtime.flush(), observer?.flush() ?? Promise.resolve(), syncIfDue(dir, () => syncOptionsFor(dir))]);
    observer?.close();
    runtime.close();
    runtime = undefined;
    keepStore(dir);
    // An `afterFileEdit` violation is real and recorded, but the edit has already
    // landed. Say so rather than letting "blocked" imply it was stopped.
    postHoc = mapped.some((m) => m.postHoc);
    // The answers:
    //   deny  — out of policy, blocked outright.
    //   allow — an evaluated allow: every action of the call was checked and permitted,
    //           or found out of policy by a rule that records rather than blocks.
    //           Monitor is silent for the developer: answering "ask" for a monitored
    //           match put Cursor's approval prompt in front of every one of them, which
    //           is not "your agent works as normal" and trained people to click through
    //           prompts, so the real denials were easier to miss. The match is recorded.
    //   ask   — anything else: Scopebond could not evaluate the action (no rule covers
    //           it, or the event could not be read into one), or it holds the action for
    //           a person. Cursor's own approval stays in charge.
    const evaluated = evaluatedAllow(decision);
    permission = decision.decision === "deny" ? "deny" : evaluated.ok ? "allow" : "ask";
    message = permission === "allow" && evaluated.monitored
      ? "Scopebond recorded this under a rule that records rather than blocks."
      : decision.reason;
  } catch (error) {
    permission = "deny";
    recordHookError("fail_closed", (error as Error).message);
    message = `Scopebond hook failed closed: ${(error as Error).message}. Repair: ${repairFor(error)}.`;
  } finally {
    // Release the SQLite handles on every path: an unclosed writer leaves its
    // write-ahead log behind for the next tool call to extend.
    try { runtime?.close(); } catch { /* the decision is already recorded */ }
  }
  if (postHoc && permission === "deny") {
    message = `${message}\nCursor reports a file edit only after it is written, so this edit was not prevented. Review and revert it yourself.`;
  }
  // C-03 for Cursor: its agent reads a deny's message, so the one-time notice rides on the next deny.
  if (permission === "deny" && configDir !== undefined) {
    const dropped = rulesDroppedNotice(configDir, cliCommand("login"));
    if (dropped) { markRulesDroppedTold(configDir); message = `${message}\n${dropped}`; }
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

/** What `init --repo` says after writing the files: where the token goes for each kind of run, and what it is not. */
const REPO_NEXT_STEPS = [
  "Next:",
  "  1. Commit these files to the default branch (GitHub's hooks documentation says the Copilot coding",
  "     agent loads hooks from there).",
  "  2. In your Scopebond workspace, create a token for this repository (Computers, Repositories).",
  "  3. Give it to the agent as the secret SCOPEBOND_REPO_TOKEN wherever it runs:",
  "       GitHub Copilot coding agent   the repository's \"copilot\" environment secrets",
  "       GitHub Actions agent steps    env: SCOPEBOND_REPO_TOKEN: ${{ secrets.SCOPEBOND_REPO_TOKEN }}",
  "       Claude Code on the web        the cloud environment's environment variables",
  "       Codex cloud tasks             the Codex environment's secrets",
  "     Set SCOPEBOND_URL too if your workspace is not at https://cloud.scopebond.com.",
  "  4. Allow the sandbox to run npx and reach your workspace (npm registry and the workspace address).",
  "",
  "With the token the hook connects as this repository on its first action and decides nothing until the",
  "workspace's rules have loaded. Each of these cloud runs is not verified yet: check one run's records in",
  "your workspace before relying on it.",
  "",
  "Where there is no token and no Scopebond connection (a contributor's computer, a run you did not give",
  "the secret), the committed hook checks nothing: it prints \"this repository's hook is not connected on",
  "this computer; nothing is checked\", records nothing and lets the agent run as it would without Scopebond.",
  "A computer signed in to Scopebond, or a run with the token, is checked as usual.",
  "",
  "The agent can edit files in its own checkout, these included, so they are not a boundary on their own.",
  "Keep the Scopebond GitHub Action as a required check on pull requests, and protect .github/ and the",
  "default branch with branch protection or a ruleset.",
].join("\n");

/** `init --repo`: the committed hook files for the runs of this repository where no person signs in (cloud coding agents,
 *  agent steps in CI). Writes those files only: no keys and no .scopebond folder on this computer. */
function runInitRepo(args: string[]): void {
  const cwd = process.cwd();
  if (args.includes("--dry-run")) {
    console.log(`Dry run — nothing is written.\n`);
    for (const harness of REPO_HARNESSES) {
      console.log(`Would configure     ${projectHarnessFile(harness, cwd)} (${harnessName(harness)}; committed with the repository)`);
      console.log(`  adding hook       ${hookCommand(harness)}`);
    }
    console.log(`\nNothing else in those files is changed, and no keys are made here. Run without --dry-run to apply.`);
    process.exit(0);
  }
  requireInteractive("init --repo", args);
  let written;
  try { written = installRepositoryHooks(cwd); } catch (error) { console.error((error as Error).message); process.exit(1); }
  for (const w of written) console.log(`${w.changed ? "✓" : "="} ${harnessName(w.harness)} ${w.changed ? "configured in" : "already configured in"} ${w.file}`);
  console.log(`  hook command   ${hookCommand("claude").replace(/ claude$/, " <agent>")} (pinned; starts on any machine with Node.js)`);
  console.log("");
  console.log(REPO_NEXT_STEPS);
}

function runInit(args: string[]): void {
  if (args.includes("--repo")) { runInitRepo(args); return; }
  const harness = selectedHarness(args);
  const dir = configDir();
  // A dry run changes nothing, so it needs no terminal and no --yes.
  if (args.includes("--dry-run")) {
    const shared = projectHarnessFile(harness, process.cwd());
    const local = localHarnessFile(harness, process.cwd());
    const personal = args.includes("--shared") || args.includes("--npx") ? null
      : local ?? (gitShareState(shared) === "tracked" ? null : shared);
    console.log(`Dry run — nothing is written.\n`);
    console.log(`Would scaffold      ${dir} (machine key, countersigning key, starter policy, .gitignore)`);
    if (args.includes("--no-install")) {
      console.log(`Would print         the ${harnessFileName(harness)} snippet instead of writing it`);
    } else if (personal) {
      console.log(`Would configure     ${personal} (this machine only; kept out of git)`);
      if (isSingleExecutable()) console.log(`  adding hook       ${previewCommand(() => nativeHookCommand(harness))}`);
      else {
        console.log(`  adding hook       "<node>" "${pinnedCliPath(hookVersion())}" ${harness}`);
        console.log(`                    (or the path this copy runs from, when it is already installed durably)`);
      }
      if (local) console.log(`  and remove        any machine-specific Scopebond entry from ${shared}`);
    } else {
      console.log(`Would configure     ${shared} (shared — safe to commit)`);
      console.log(`  adding hook       ${hookCommand(harness)}`);
    }
    console.log(`\nNothing else in those files is changed. Run without --dry-run to apply.`);
    process.exit(0);
  }
  requireInteractive("init", args);
  // The hook command first: a path no hook shell can start is refused here, before anything is written.
  const shared = args.includes("--shared");
  const native = isSingleExecutable() && !args.includes("--npx") && !shared;
  let pin: { cli: string | null; how: string };
  let command: string | undefined;
  try {
    pin = native ? { cli: process.execPath, how: "native" } : args.includes("--npx") || shared ? { cli: null, how: "unavailable" } : ensureDurableRuntime(cliPath(), hookVersion());
    command = native ? nativeHookCommand(harness) : pin.cli ? absoluteHookCommand(pin.cli, harness) : undefined;
  } catch (error) { console.error(`nothing was set up: ${(error as Error).message}`); process.exit(1); }
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
  // Configure the agent automatically by default (idempotent), so there is no
  // hand-editing step; --no-install prints the snippet instead.
  if (!args.includes("--no-install")) {
    let placed: HookPlacement;
    try { placed = placeHook(harness, process.cwd(), command, { shared }); } catch (error) { console.error((error as Error).message); process.exit(1); }
    // No per-action millisecond claim here: it varies by machine, and this project only
    // states numbers it has measured. The measured comparison lives in the changelog.
    console.log(`  hook runtime   ${placed.scope === "personal"
      ? `${pin.cli}\n                 ${native ? "the signed installer's program — no Node.js or npx needed" : "pinned — no npx resolution per action"}`
      : `npx @scopebond/hook@${hookVersion()} — portable, but re-resolves on every action`}`);
    console.log("");
    console.log(`✓ ${harnessName(harness)} configured in ${placed.file}`);
    console.log(placed.scope === "personal"
      ? `  this machine only — kept out of git, so no teammate inherits a path that does not exist for them`
      : `  shared — the portable command starts on any machine that clones this project`);
    if (placed.repaired > 0) console.log(`  moved a machine-specific hook out of ${projectHarnessFile(harness, process.cwd())}; commit that change`);
    if (placed.note) console.log(`  note: ${placed.note}`);
    if (placed.scope === "shared" && isSingleExecutable() && !npxAvailable()) for (const line of coverWithoutNpx(harness, process.cwd(), { label: harnessName(harness) })) console.log(`  ${line}`);
    if (harness === "codex") console.log(`\nOne last step: ${codexTrustStep}`);
    if (harness === "cursor") console.log(`\n${cursorCoverageNote}`);
    if (harness === "copilot") console.log(`\n${copilotCoverageNote}\n\n${COPILOT_CLOUD_COMMIT_WARNING}.`);
  } else {
    // The snippet is for a file the user will likely commit, so it carries the portable
    // command; the pinned one is offered separately, for a file only this machine uses.
    console.log(`Add this to your ${harnessFileName(harness)}:`);
    console.log(harnessSnippet(harness));
    const local = localHarnessFile(harness, process.cwd());
    if (command && local) {
      console.log(`\nFaster, for this machine only — use this command in ${local} instead (keep that file out of git):`);
      console.log(`  ${command}`);
    }
    if (harness === "cursor") console.log(`\n${cursorCoverageNote}`);
    if (harness === "copilot") console.log(`\n${copilotCoverageNote}\n\n${COPILOT_CLOUD_COMMIT_WARNING}.`);
  }
  console.log("");
  // Print the runnable `npx` form: after `npx @scopebond/hook init` there is no
  // `scopebond-hook` binary on PATH, so a bare `scopebond-hook log` would fail.
  console.log(`Next: run one command in the agent, then \`${cliCommand("log")}\` to see the receipt`);
  console.log(`and \`${cliCommand("verify")}\` to check it offline. Try \`${cliCommand('test "rm -rf /"')}\`.`);
  console.log(onboardingSteps({ harness, command: cliCommand, project: true }).join("\n"));
}

function decisionOf(payload: Record<string, unknown>): string {
  const rr = textOf(payload.realtime_result);
  const state = textOf((payload.execution as Record<string, unknown> | undefined)?.state);
  if (state === "observed_not_evaluated") return "not_evaluated";
  // Out of policy, but reported only after it ran: recorded, never a block.
  if (state === "observed_after") return "recorded, not prevented";
  if (rr === "deny") return state === "cooperative_allow" || state === "executed" ? "monitor" : "deny";
  return "allow";
}

/** The receipt's context in brief (harness, model, repository and branch), or nothing when it has none. */
function contextNote(context: unknown): string {
  if (!context || typeof context !== "object") return "";
  const c = context as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const where = text(c.repository) && text(c.branch) ? `${text(c.repository)}@${text(c.branch)}` : text(c.repository) || text(c.branch);
  const parts = [text(c.harness), text(c.model), where].filter(Boolean);
  return parts.length ? `  [${parts.join(" · ")}]` : "";
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
        const at = Date.parse(textOf(p.timestamp));
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
      console.log(`${textOf(p.timestamp)}  ${decisionOf(p).padEnd(13)}  ${describeIntent(p)}${contextNote(p.context)}`);
    }
    const filters = [denyOnly ? "denied" : "", since ? `since ${new Date(since).toISOString()}` : ""].filter(Boolean).join(", ");
    const scope = filters ? ` matching ${filters}` : "";
    const capped = (denyOnly || since) && scanned.length >= budget && total > budget;
    console.log(`\n${shown.length}${scope} of ${total} receipt(s)${capped ? ` — searched the most recent ${budget}` : ""}. Verify them: ${cliCommand("verify")}`);
  } finally {
    try { await store.close?.(); } catch { /* read-only */ }
  }
}

/** `rules` — read and change the limits in plain terms.
 *
 *  Without this, "edit the limits" meant hand-writing a ~700-character case-folded
 *  negative lookahead, which nobody does — so the starter policy was effectively the only
 *  policy. The lists live in `.scopebond/rules.json`; `policy.json` is compiled from them. */
/** Tell the workspace now what this computer runs (a rules check carries the report). Bounded; silent when not connected. */
async function reportRules(dir: string): Promise<void> {
  if (!loadConnection(dir)) return;
  try {
    const outcome = await syncPolicy(dir, syncOptionsFor(dir));
    if (outcome.state !== "refused") console.log("  workspace      told");
  } catch { /* the next rules check reports it */ }
}

async function runRules(args: string[]): Promise<void> {
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
    console.log(`  ${cliCommand("rules protect-remote-database")}  block destructive or unreadable SQL on a remote database (off by default)`);
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
    case "protect-remote-database":
      if (rules.protect_remote_database === true) { console.log("Remote databases are already protected."); process.exit(0); }
      rules.protect_remote_database = true;
      changed = "remote SQL that drops, deletes or updates every row, or cannot be read, is now blocked";
      break;
    case "unprotect-remote-database":
      if (rules.protect_remote_database !== true) { console.log("Remote databases were not protected; nothing to change."); process.exit(0); }
      delete rules.protect_remote_database;
      changed = "remote SQL is no longer checked";
      break;
    case "enforce":
    case "monitor": {
      // Monitor is the default: a rule records what it would have stopped. "enforce" makes it block.
      const id = String(value ?? "");
      // A rule pack's own rule that may block can be switched too, while its pack is in force.
      activatePacks(dir);
      const packOnly = switchablePackRules().filter((r) => !SWITCHABLE_RULES.includes(r));
      if (!SWITCHABLE_RULES.includes(id) && !packOnly.includes(id)) {
        console.error(`rules ${verb} <rule>: one of ${[...SWITCHABLE_RULES, ...packOnly].join(", ")}`);
        process.exit(1);
      }
      if (isManaged(dir)) {
        // The workspace sets this computer's rules. A person's own choice applies only where the workspace allows
        // changes on computers; either way the workspace hears what this computer runs.
        const doc = JSON.parse(readFileSync(join(dir, MANAGED_DOC_FILE), "utf8")) as ManagedDocument;
        if (doc.local_changes !== true) {
          console.error(`Your Scopebond workspace sets the rules on this computer, and it does not allow changing them here.`);
          console.error(`An owner or admin can change ${id} in the workspace (Rules), or allow changes on computers there.`);
          process.exit(1);
        }
        requireInteractive("rules", args);
        rules.local_overrides = { ...(rules.local_overrides ?? {}), [id]: verb };
        const agentKid = createSigner({ privateKeyPem: readFileSync(join(dir, "agent.key"), "utf8") }).kid;
        saveRules(dir, rules);
        replaceFile(join(dir, "policy.json"), `${JSON.stringify(compileManaged(rules, doc, agentKid), null, 2)}\n`);
        console.log(`✓ ${verb === "enforce" ? `${id} now blocks on this computer` : `${id} now records on this computer, without blocking`} (your workspace allows changes on computers)`);
        await reportRules(dir);
        process.exit(0);
      }
      // A rule pack's own rule keeps the person's choice by its id (it wins over the rule's default).
      if (packOnly.includes(id)) rules.local_overrides = { ...(rules.local_overrides ?? {}), [id]: verb };
      const set = new Set(rules.enforce ?? []);
      if (verb === "enforce") set.add(id); else set.delete(id);
      rules.enforce = SWITCHABLE_RULES.filter((r) => set.has(r));
      changed = verb === "enforce" ? `${id} now blocks` : `${id} now records, without blocking`;
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

  if (isManaged(dir)) {
    console.error("The rules on this computer are set by your Scopebond workspace, so they cannot be changed here.");
    console.error("Change them in the workspace (Rules), or disconnect this computer to manage its rules locally again.");
    process.exit(1);
  }
  // Changing what governs the agent is the same class of action as `init`.
  requireInteractive("rules", args);
  const policyPath = join(dir, "policy.json");
  const agentKid = createSigner({ privateKeyPem: readFileSync(join(dir, "agent.key"), "utf8") }).kid;
  saveRules(dir, rules);
  replaceFile(policyPath, `${JSON.stringify(compile(rules, agentKid), null, 2)}\n`);
  console.log(`✓ ${changed}`);
  console.log(`  rules          ${rulesPath(dir)}`);
  console.log(`  policy         ${policyPath} (recompiled)`);
  await reportRules(dir);
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
/** The archives earlier prunes wrote beside the database, with their sizes. */
function receiptArchives(dir: string): Array<{ name: string; bytes: number }> {
  try {
    return readdirSync(dir).filter((name) => /^receipts-archived-.*\.jsonl$/.test(name)).map((name) => {
      let bytes = 0;
      try { bytes = statSync(join(dir, name)).size; } catch { /* gone meanwhile */ }
      return { name, bytes };
    });
  } catch { return []; }
}

async function runPrune(args: string[]): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
  const dbPath = join(dir, "receipts.db");
  if (!existsSync(dbPath)) { console.log("no local receipts yet — nothing to prune."); process.exit(0); }
  const beforeIdx = args.indexOf("--before");
  if (args.includes("--compact")) {
    const quiet = args.includes("--quiet");
    // One compaction at a time: parallel hook calls can each ask for one in the background.
    const lock = join(dir, "store-compact.lock");
    try { writeFileSync(lock, String(process.pid), { flag: "wx" }); }
    catch {
      let fresh: boolean;
      try { fresh = Date.now() - statSync(lock).mtimeMs < 15 * 60_000; } catch { fresh = false; }
      if (fresh) {
        if (!quiet) console.error("another compaction of this store is running; try again in a few minutes.");
        process.exit(quiet ? 0 : 1);
      }
      writeFileSync(lock, String(process.pid)); // a stale lock from a process that died
    }
    const before = describeStore(dbPath);
    let report: ReturnType<typeof runStoreUpkeep>;
    let migrated: number;
    try {
      report = runStoreUpkeep(dir, { budgetMs: 10 * 60_000, allowFullVacuum: true });
      migrated = report?.migrated ?? 0;
      while (report?.more) {
        report = runStoreUpkeep(dir, { budgetMs: 10 * 60_000, allowFullVacuum: true });
        migrated += report?.migrated ?? 0;
      }
    } finally {
      rmSync(lock, { force: true });
    }
    if (quiet) process.exit(0);
    console.log(`local receipts   ${dbPath}`);
    console.log(`before           ${before}`);
    console.log(`after            ${describeStore(dbPath)}`);
    if (report) {
      console.log(`removed          ${report.receiptsRemoved} acknowledged receipt(s) past retention, ${report.stateRemoved} finished check record(s)`);
      if (migrated) console.log(`rewrote          ${migrated} older row(s) to keep each policy and receipt once`);
    }
    process.exit(0);
  }
  if (beforeIdx < 0) {
    const days = localRetentionDays(dir);
    console.log(`local receipts   ${dbPath}`);
    console.log(`                 ${describeStore(dbPath)}`);
    console.log(days === null
      ? `retention        none: with no workspace connected, every receipt stays until you prune`
      : `retention        receipts the workspace acknowledged are removed after ${days} days; never one it has not`);
    console.log(`\nShrink the file now (keeps every receipt the retention rule keeps): ${cliCommand("prune --compact")}`);
    console.log(`To remove older receipts yourself, name a cutoff:`);
    console.log(`  ${cliCommand("prune --before 90d")}      # older than 90 days`);
    console.log(`  ${cliCommand("prune --before 2026-01-01")}`);
    console.log(`Receipts are archived beside the database before removal (add --no-archive to skip that).`);
    // Earlier prunes' archives are plain copies of signed receipts that nothing removes: say where they are and how big.
    const archives = receiptArchives(dir);
    if (archives.length) {
      const bytes = archives.reduce((n, a) => n + a.bytes, 0);
      console.log(`\narchives         ${archives.length} file(s), ${(bytes / 1024 / 1024).toFixed(1)} MB, beside the database (receipts-archived-*.jsonl).`);
      console.log(`                 They are kept until you delete them; they hold the same details as the receipts.`);
    }
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
    const archived = !args.includes("--no-archive");
    if (archived) {
      const archive = join(dir, `receipts-archived-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
      writeFileSync(archive, `${doomed.map((r) => JSON.stringify(r)).join("\n")}\n`, { mode: 0o600 });
      console.log(`archived to      ${archive}`);
    } else {
      console.log(`archived to      nothing (--no-archive)`);
    }
    const { removed } = sqlite.removeBefore(iso);
    console.log(`removed          ${removed} receipt(s)`);
    await store.close?.();
    console.log(`store now        ${describeStore(dbPath)}`);
    if (archived) console.log(`\nThe archive is a plain JSONL of signed receipts — still verifiable, still yours. It stays until you delete it.`);
    process.exit(0);
  } catch (error) {
    try { await store.close?.(); } catch { /* closing after a failure */ }
    console.error(`prune refused: ${(error as Error).message}`);
    process.exit(1);
  }
}

/** A `--since` value: a duration (`7d`, `24h`, `30m`) or an ISO-ish date. */
function parseSince(value: string | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const duration = /^(\d+)\s*([dhm])$/i.exec(value.trim());
  if (duration) {
    const scale = { d: 86_400_000, h: 3_600_000, m: 60_000 }[duration[2].toLowerCase() as "d" | "h" | "m"];
    return now - Number(duration[1]) * scale;
  }
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

async function runVerify(args: string[] = []): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
  const dbPath = join(dir, "receipts.db");
  const attesterPath = join(dir, "attester.key");
  // --anchor <file-or-url> (repeatable) and --segments <dir>: the evidence-chain heads this computer kept, against a
  // published day's anchor list and the evidence segments downloaded from the workspace.
  const anchors: string[] = [];
  let segmentsDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--anchor" && args[i + 1]) anchors.push(args[++i]);
    else if (args[i] === "--segments" && args[i + 1]) segmentsDir = resolve(args[++i]);
    else { console.error(`unknown option for verify: ${args[i]}. Use: ${cliCommand("verify [--anchor <file-or-url>] [--segments <dir>]")}`); process.exit(2); }
  }
  const chainCheck = anchors.length > 0 || segmentsDir !== undefined;
  if (!existsSync(dbPath) || !existsSync(attesterPath)) {
    console.log("nothing to verify yet (no receipts or no attester key).");
    if (!chainCheck) process.exit(0);
    process.exit(await reportChains(dir, anchors, segmentsDir, undefined) ? 0 : 1);
  }
  const { attester } = loadOrCreateAttester({ file: attesterPath });
  const { store } = openReceiptStore({ db: dbPath });
  // Verification is the one command that must read everything — that is the point of it.
  // It just should not look hung while doing so: at ~2.6 s per 20,000 receipts a long
  // history is a visible wait, so report progress on a TTY.
  const all = await Promise.resolve(store.list());
  try { await store.close?.(); } catch { /* read-only */ }
  const progress = process.stdout.isTTY && all.length >= 2000;
  let ok = 0;
  const bad: string[] = [];
  for (const [index, r] of all.entries()) {
    const result = verifyReceipt(r, attester.publicKeyPem) as unknown as Record<string, boolean>;
    if (result.valid) ok += 1;
    else {
      const failed = Object.entries(result).filter(([k, v]) => k.endsWith("_valid") && v === false).map(([k]) => k);
      bad.push(`${textOf((r.payload as unknown as Record<string, unknown>).timestamp)}: ${failed.join(", ") || "invalid"}`);
    }
    if (progress && (index + 1) % 1000 === 0) process.stderr.write(`\rverifying ${index + 1}/${all.length}…`);
  }
  if (progress) process.stderr.write("\r".padEnd(40) + "\r");
  console.log(`${ok}/${all.length} receipt(s) verify offline against ${attesterPath}.`);
  if (bad.length) for (const b of bad) console.error(`  ✗ ${b}`);
  const chainsOk = chainCheck ? await reportChains(dir, anchors, segmentsDir, attester.publicKeyPem) : true;
  process.exit(bad.length || !chainsOk ? 1 : 0);
}

/** Prints the chain-head checks; true when nothing disagrees. */
async function reportChains(dir: string, anchors: string[], segmentsDir: string | undefined, publicKeyPem: string | undefined): Promise<boolean> {
  const report = await checkChains({ dir, anchors, segmentsDir, publicKeyPem });
  for (const line of report.lines) console.log(line);
  for (const problem of report.problems) console.error(`  ✗ ${problem}`);
  if (!report.ok) console.error("The workspace's evidence chain disagrees with what it told this computer or published: records may have been removed, reordered or re-chained.");
  return report.ok;
}

async function runTest(args: string[]): Promise<void> {
  const command = args.find((a) => !a.startsWith("-"));
  if (!command) { console.error('usage: scopebond-hook test "<shell command>"'); process.exit(1); }
  const dir = resolveConfigDir(process.cwd());
  if (!existsSync(join(dir, "policy.json"))) { console.error(`no policy yet — run \`${cliCommand("init")}\` first.`); process.exit(1); }
  // Evaluate against the real policy and keys, but a throwaway store, so `test`
  // never records a receipt or exports anything.
  const tmp = mkdtempSync(join(tmpdir(), "sb-hook-test-"));
  try {
    const runtime = createHookRuntime({
      policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
      attesterPath: join(dir, "attester.key"), dbPath: join(tmp, "receipts.db"),
      strict: process.argv.includes("--strict"),
    });
    activatePacks(dir);
    const mapped = fillPushBranch(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } }), currentBranch(process.cwd()), () => upstreamBranch(process.cwd()));
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
    console.error(`usage: ${cliCommand("connect <workspace-url> <enrollment> [--claude|--cursor|--codex] [--no-install] [--project]")}`);
    console.error(enrollmentHelp);
    process.exit(1);
  }
  const dir = connectDir(args);
  // One command sets everything up: scaffold the key, attester and starter policy if
  // they do not exist, then enroll and persist the scoped machine credential. The
  // enrollment can be a file, an inline base64 blob (what the portal hands out) or
  // raw JSON — the user never has to save or open a JSON file.
  scaffold(dir, {});
  let bundle: CloudEnrollmentBundle;
  try { bundle = readBundleArg(bundleArg, readStdin); }
  catch { console.error(`could not read the enrollment (expected a file, inline blob, or JSON on stdin)\n${enrollmentHelp}`); process.exit(1); }
  await finishConnect(dir, url, bundle, harness, args);
}

/** Enroll with a bundle and wire the agent: shared by `connect` (a pasted enrollment)
 *  and `login` (one received through device-code approval). */
async function finishConnect(dir: string, url: string, bundle: CloudEnrollmentBundle, harness: Harness, args: string[], workspaceId?: string | null): Promise<void> {
  try {
    const c = await connectCloud(dir, url, bundle, undefined, workspaceId);
    console.log(`✓ Connected to ${c.url}`);
    if (c.rotatedFrom) console.log(`✓ This computer's earlier key (${c.rotatedFrom}) was no longer accepted, so it was replaced; the old key is kept in ${join(dir, "retired-keys")}`);
    if (c.setAside) console.log(`  ${c.setAside.toLocaleString()} queued record(s) signed by an earlier key cannot go through this connection. To deliver them, run: ${cliCommand("recover")}`);
    // One rules check now, bounded: the new workspace says what it reads (receipt context) and sends its rules before the first
    // tool call. It never fails the sign-in; the first tool call checks again if this one could not.
    try { await syncPolicy(dir, { ...syncOptionsFor(dir), timeoutMs: 3000 }); } catch { /* checked on the next tool call */ }
    // With a user-level install present, the hook ignores a project policy until it is
    // trusted, and would fall back to the user home, which holds no cloud.json: the agent
    // stays governed, but nothing reaches the workspace. Connecting this project is the
    // user's decision to use it, exactly as running `init` here is, so pin it the same way.
    if (!process.env.SCOPEBOND_HOOK_DIR && !samePath(dir, userHome()) && existsSync(join(userHome(), "policy.json"))) {
      trustProjectPolicy(dir);
      console.log(`✓ This project's rules are trusted (they override ${userHome()} here)`);
    }
    // Configure the agent automatically (merges into the existing config), unless the
    // caller opts out. This removes the "paste this snippet" step. A hook that is already
    // configured — pinned by `init`, or user-level by `install` — is left as it is:
    // connecting changes where receipts go, not how the hook starts.
    // A user-level connection looks only at the user-level settings: a project's own hook
    // entry in the folder this ran from used to count as "already configured", so a sign-in
    // from such a folder never set up the user at all.
    const forUser = samePath(dir, userHome());
    const scopes = harnessScopes(harness, process.cwd());
    const existing = forUser ? scopes.user : scopes.local ?? scopes.project ?? scopes.user;
    if (existing && !args.includes("--no-install")) {
      console.log(`✓ ${harnessName(harness)} already configured in ${existing}`);
    } else if (!args.includes("--no-install")) {
      // A connection for this computer (the user home, the default) covers every project,
      // so the hook goes into the user-level agent settings. Placing it in the current
      // folder's project settings — what this did before — left every other project
      // unchecked, and a sign-in run from a scratch folder governed only that folder.
      // `--project` (a per-project connection) keeps the project placement.
      let file: string;
      try {
        file = forUser
          ? writeHarnessConfig(userHarnessFile(harness), harness, durableHookCommand(harness))
          // The installer's program needs no npx, so a per-project connection made with it pins that program (kept out of
          // git, as `init` does); from npm it keeps the portable form.
          : placeHook(harness, process.cwd(), isSingleExecutable() ? nativeHookCommand(harness) : undefined).file;
      } catch (error) {
        // Connected, but no hook entry: say so plainly, and fail, so nobody takes the agent for checked.
        console.error(`✗ ${harnessName(harness)} hook not set up: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`✓ ${harnessName(harness)} configured in ${file}`);
      if (harness === "codex") console.log(`\nOne last step: ${codexTrustStep}`);
    } else {
      console.log(`Add this to your ${harnessFileName(harness)}:`);
      console.log(harnessSnippet(harness));
    }
    // Session and after-action observations are opt-in through the enrollment: wired only
    // when this workspace granted observations:write and Claude Code is the host. Off is
    // silent here (`status` says why); a granted scope the hook cannot use is worth a line.
    const observing = observationStatus(loadConnection(dir));
    if (observing.state === "on" && harness === "claude" && !args.includes("--no-install")) {
      const placed = harnessScopes("claude", process.cwd());
      const target = forUser ? placed.user : placed.local ?? placed.project ?? placed.user;
      const command = target ? configuredHookCommands(target)[0] : undefined;
      if (target && command) { wireLifecycleHooks(target, command); console.log(`✓ Session and after-action observations enabled in ${target}`); }
    } else if (observing.state === "unsupported") console.log(`Observations: ${observing.reason}`);
    if (forUser) for (const line of projectSetupNotice(process.cwd())) console.log(line);
    console.log("");
    console.log("Run your agent — the first action appears in your workspace within seconds.");
    console.log(onboardingSteps({ harness, command: cliCommand, connected: true }).join("\n"));
  } catch (error) {
    const message = (error as Error).message;
    console.error(`connect failed: ${message}`);
    if (/enrollment|expired|401|403/i.test(message)) console.error(enrollmentHelp);
    process.exit(1);
  }
}

/** Where an enrollment comes from, for every connect error that means "this one will
 *  not work": the bare "invalid enrollment token" told the reader nothing about what to
 *  do next. */
const enrollmentHelp = [
  "An enrollment comes from your Scopebond workspace: open it, choose to connect an agent,",
  "and copy the command it shows — it includes the workspace URL and a fresh enrollment.",
  "Each enrollment is single-use and expires soon after it is created; if this one was",
  "used or has expired, create a new one there.",
].join("\n");

/** Where `connect` and `login` write. A project someone set up here with `init` (it has a
 *  policy) is connected, as before. Otherwise the configuration the hook itself uses from
 *  here — usually the user-level install — so reconnecting from any folder repairs the
 *  connection that is actually failing instead of creating a second, project-level one
 *  beside it. `--project` asks for a new per-project setup explicitly. */
function connectDir(args: string[]): string {
  const project = configDir();
  if (args.includes("--project") || existsSync(join(project, "policy.json"))) return project;
  const resolved = resolveConfigDir(process.cwd());
  // On a computer with nothing set up yet, resolveConfigDir falls back to this folder. A login
  // without --project connects the person, so it goes to the user home the hook reads everywhere.
  return process.env.SCOPEBOND_HOOK_DIR || existsSync(join(resolved, "policy.json")) ? resolved : userHome();
}

/** Where `login` writes: the user home, whatever folder it runs from, because signing in sets
 *  Scopebond up for this person across projects. It used to follow `connect` and connect a
 *  project setup it found in the current folder, so a sign-in from a folder with a leftover
 *  `.scopebond` connected only that folder and left the user "not installed". `--project`
 *  connects the folder's own setup instead; SCOPEBOND_HOOK_DIR still overrides both. */
function loginDir(args: string[]): string {
  if (args.includes("--project")) return configDir();
  return process.env.SCOPEBOND_HOOK_DIR ?? userHome();
}

/** After a sign-in for the user: what a project setup in the folder it ran from means for it.
 *  The hook prefers a trusted project setup for sessions opened in that folder (see
 *  `resolveConfigDir`), so the sign-in says so instead of leaving it to be found later. */
function projectSetupNotice(cwd: string): string[] {
  if (process.env.SCOPEBOND_HOOK_DIR) return [];
  const project = join(cwd, ".scopebond");
  if (samePath(project, userHome()) || !existsSync(join(project, "policy.json"))) return [];
  const hookFiles = HARNESSES.flatMap((h) => {
    const scopes = harnessScopes(h, cwd);
    return [scopes.project, scopes.local].filter((file): file is string => !!file);
  });
  const remove = [`delete the folder ${project}`, ...hookFiles.map((file) => `remove the Scopebond hook entry from ${file}`)].join(", and ");
  if (samePath(resolveConfigDir(cwd), project)) {
    const own = loadConnection(project);
    const records = own ? `go to the workspace its own connection names (${own.url})` : "stay on this computer: it is not connected";
    return [
      "",
      `Note: ${cwd} has its own Scopebond setup (${project}), and it takes precedence over this sign-in`,
      `for agent sessions opened in ${cwd}: their rules come from it and their records ${records}.`,
      `To use this sign-in there too, ${remove}.`,
    ];
  }
  return [
    "",
    `Note: ${cwd} also has an earlier project setup (${project}). It is not trusted, so the hook ignores it`,
    `and this sign-in governs sessions opened there. To remove it, ${remove}.`,
  ];
}

/** The user-level sign-in's workspace, when a project setup takes precedence over it from here
 *  (for `status` and `doctor`): the hook would otherwise route this folder's records past it
 *  without a word. */
function shadowedUserConnection(active: string): string | null {
  if (process.env.SCOPEBOND_HOOK_DIR || samePath(active, userHome())) return null;
  return loadConnection(userHome())?.url ?? null;
}

/** `recover [--no-wait]`: deliver receipts that an earlier, since-revoked key of this computer
 *  signed and the workspace never received, after an owner or admin approves it there. */
async function runRecover(args: string[]): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
  const connection = loadConnection(dir);
  if (!connection) {
    console.error(`not connected to a workspace; run \`${cliCommand("login <workspace-url>")}\` first`);
    process.exit(1);
  }
  console.log(`Recovering from ${dir}`);
  const result = await recoverEarlierReceipts(dir, connection, {
    log: (line) => console.log(line),
    fetch,
    now: Date.now,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  }, { wait: !args.includes("--no-wait"), waitMs: 15 * 60_000, pollMs: 5_000 });
  if (result.groups) {
    const parts = [
      `recovered ${result.accepted.toLocaleString()}`,
      `already present ${result.duplicates.toLocaleString()}`,
      `refused ${result.rejected.toLocaleString()}`,
      ...(result.pending ? [`waiting for approval ${result.pending.toLocaleString()}`] : []),
      ...(result.skipped ? [`skipped ${result.skipped.toLocaleString()}`] : []),
    ];
    console.log(`\nDone: ${parts.join(", ")}.`);
  }
  process.exitCode = result.failed || result.pending ? 1 : 0;
}

async function runFlush(): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
  if (!loadConnection(dir)) { console.error(`not connected to a workspace; run \`${cliCommand("connect <workspace-url> <enrollment>")}\` first`); process.exit(1); }
  // No time limit here, so the queue waits as long as the agent's flush does for another process's lock.
  const runtime = createHookRuntime({ ...runtimePaths(dir), queueBusyTimeoutMs: 15_000 });
  const before = runtime.exporter?.status().lastSuccessAt ?? null;
  // First, anything the queue never got (a failed queue write, an evaluation that was cut off).
  await runtime.repair();
  await runtime.exporter?.flush();
  const status = runtime.exporter?.status();
  // Unbounded, so its outcome is a real one: `status` and `doctor` show it like any other.
  if (status) recordDeliveryAttempt(dir, status, Date.now(), before, null, "hook");
  // Routine records held for their summary window are not undelivered: they are reported apart and do not fail the flush.
  const held = status ? runtime.exporter?.held?.() : undefined;
  runtime.exporter?.stop();
  const outcome = flushOutcome(status, held);
  for (const line of outcome.lines) console.log(line);
  // Let pending HTTP handles close normally (forced exit can abort on Windows).
  process.exitCode = outcome.exitCode;
}

/** `observations`: what the observation emitters are doing, and the local queue. */
/** `policy load <export.json> [--yes]`: check a policy exported from the workspace and, with
 *  `--yes`, make it the active policy here; then acknowledge it (or its refusal) to the workspace. */
async function runPolicy(args: string[]): Promise<void> {
  const [sub, file] = args;
  if (sub === "sync") { await runPolicySync(args.includes("--background")); return; }
  if (sub !== "load" || !file) { console.error(`usage: ${cliCommand("policy sync")} | ${cliCommand("policy load <export.json> [--yes]")}`); process.exitCode = 2; return; }
  const dir = resolveConfigDir(process.cwd());
  if (isManaged(dir)) {
    console.error("The rules on this computer are set by your Scopebond workspace; a policy file cannot replace them here.");
    process.exitCode = 1;
    return;
  }
  const apply = args.includes("--yes");
  const connection = loadConnection(dir);
  const outcome = loadPolicyExport(dir, file, { apply, environmentId: connection?.environment_id, afterPolicyWrite: repinAfterWrite(dir) });
  let ack: Parameters<ObservationEmitter["policyAck"]>[0] | undefined;
  if (outcome.state === "rejected") {
    console.error(`refused: ${outcome.message} (${outcome.error})`);
    if (outcome.ack) ack = { ...outcome.ack, error: outcome.error };
    process.exitCode = 1;
  } else if (outcome.state === "would_load") {
    console.log(`This export checks out (policy ${outcome.facts.policyId} v${outcome.facts.policyVersion}, digest ${outcome.facts.policyDigest.slice(0, 12)}...).`);
    console.log(`Loading it REPLACES the active policy at ${join(dir, "policy.json")} (the old one is kept as policy.previous.json), so the starter protections apply only if the export includes them.`);
    console.log("Run again with --yes to load it.");
    return;
  } else {
    console.log(`loaded policy ${outcome.facts.policyId} v${outcome.facts.policyVersion} (digest ${outcome.facts.policyDigest.slice(0, 12)}...) from export ${outcome.facts.exportId}`);
    console.log(`  active policy   ${outcome.policyPath}${outcome.previous ? `  (previous kept at ${outcome.previous})` : ""}`);
    console.log(`  note            \`${cliCommand("rules apply")}\` recompiles policy.json from rules.json and would replace it`);
    ack = { exportId: outcome.facts.exportId, policyId: outcome.facts.policyId, policyVersion: outcome.facts.policyVersion, policyDigest: outcome.facts.policyDigest, scopeDigest: outcome.facts.scopeDigest };
  }
  if (!ack) return;
  await sendPolicyAck(dir, ack);
}

/** A project policy governs only once trusted, so a write that replaces a trusted project's policy re-pins it, exactly when
 *  `rules apply` would; anything else (the user's own policy, a project not trusted) is never trusted by a write. Decided
 *  before the write, from the policy as it is now. */
function repinAfterWrite(dir: string): ((dir: string) => void) | undefined {
  const home = userHome();
  const repin = dir !== home && existsSync(join(home, "policy.json")) && isTrustedProject(dir);
  return repin ? (d) => { trustProjectPolicy(d); } : undefined;
}

/** What a rules check needs for this config directory. */
function syncOptionsFor(dir: string): SyncOptions {
  const agentKid = createSigner({ privateKeyPem: readFileSync(join(dir, "agent.key"), "utf8") }).kid;
  return { agentKid, hookVersion: hookVersion(), policyBuilds, afterPolicyWrite: repinAfterWrite(dir) };
}

/** `policy sync`: bring this computer's rules in line with its workspace now (the hook also checks every five minutes). */
async function runPolicySync(background: boolean): Promise<void> {
  const dir = resolveConfigDir(process.cwd());
  let outcome: SyncOutcome;
  try {
    outcome = await syncPolicy(dir, syncOptionsFor(dir));
  } catch (error) {
    outcome = { state: "unavailable", message: (error as Error).message };
  }
  if (background) return;
  const lines: Record<SyncOutcome["state"], string> = {
    not_connected: "This computer is not connected to a Scopebond workspace; it uses its own rules.",
    own_rules: "Your workspace does not set rules for this computer; it uses its own rules.",
    unchanged: "Up to date with your workspace.",
    applied: "Updated to your workspace's latest rules.",
    refused: "Could not apply your workspace's rules; the rules already in force stay.",
    disconnected: "The workspace connection is no longer valid; this computer now uses its own rules.",
    unavailable: "Could not reach your workspace; the rules already in force stay.",
  };
  console.log(lines[outcome.state]);
  if (outcome.state === "refused" || outcome.state === "unavailable") { console.log(`  ${outcome.message}`); process.exitCode = 1; }
}

/** Queue a `policy_ack` (loaded or rejected) through the observation outbox and try to deliver it now. */
async function sendPolicyAck(dir: string, ack: Parameters<ObservationEmitter["policyAck"]>[0]): Promise<void> {
  const observed = openObservations(dir, { adapterVersion: hookVersion(), spawnHeartbeat: false });
  if (!observed.emitter) { console.error(`not acknowledged to the workspace: observations are ${observed.status.state}${"reason" in observed.status ? ` (${observed.status.reason})` : ""}`); return; }
  try {
    const queued = observed.emitter.policyAck(ack);
    await observed.emitter.flush(3000);
    console.error(queued?.queued ? `queued the ${ack.error ? "rejection" : "load"} acknowledgement for the workspace` : "could not queue the acknowledgement");
  } finally { observed.emitter.close(); }
}

/** `budget load <export.json> [--yes]`: check an action budget exported from the workspace and, with `--yes`,
 *  make it the budget this machine enforces; then acknowledge it (or its refusal) to the workspace. */
async function runBudgetLoad(args: string[]): Promise<void> {
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) { console.error(`usage: ${cliCommand("budget load <export.json> [--yes]")}`); process.exitCode = 2; return; }
  const dir = resolveConfigDir(process.cwd());
  const agentKid = (() => { try { return createSigner({ privateKeyPem: readFileSync(join(dir, "agent.key"), "utf8") }).kid; } catch { return ""; } })();
  const outcome = loadBudgetExport(dir, file, { apply: args.includes("--yes"), agentKid, environmentId: loadConnection(dir)?.environment_id });
  let ack: Parameters<ObservationEmitter["policyAck"]>[0] | undefined;
  if (outcome.state === "rejected") {
    console.error(`refused: ${outcome.message} (${outcome.error})`);
    if (outcome.ack && outcome.error !== "expired") ack = { ...outcome.ack, error: outcome.error };
    process.exitCode = 1;
  } else if (outcome.state === "would_load") {
    const p = outcome.facts.policy;
    for (const w of outcome.warnings) console.error(`warning: ${w}`);
    console.log(`This export checks out: ${p.mode} budget ${outcome.facts.budgetId} v${outcome.facts.budgetVersion}, ${p.max_dispatch} dispatches in ${p.window_seconds}s for this agent on this installation.`);
    console.log(`Loading it writes the budget to ${join(dir, "dispatch.json")} as acknowledged, and replaces an older workspace budget for this agent. Run again with --yes to load it.`);
    return;
  } else {
    const p = outcome.facts.policy;
    for (const w of outcome.warnings) console.error(`warning: ${w}`);
    console.log(`loaded ${p.mode} budget ${outcome.facts.budgetId} v${outcome.facts.budgetVersion} from export ${outcome.facts.exportId}: ${p.max_dispatch} dispatches in ${p.window_seconds}s`);
    if (outcome.replaced.length > 0) console.log(`  replaced        ${outcome.replaced.join(", ")}`);
    console.log(`  valid until     ${new Date(outcome.facts.validUntil).toISOString()} (after that an enforced budget denies new dispatch until you load a new export)`);
    ack = { exportId: outcome.facts.exportId, policyId: outcome.facts.budgetId, policyVersion: outcome.facts.budgetVersion, policyDigest: outcome.facts.policyDigest, scopeDigest: outcome.facts.scopeDigest };
  }
  if (!ack) return;
  await sendPolicyAck(dir, ack);
}

async function runObservations(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const dir = resolveConfigDir(process.cwd());
  if (sub === "heartbeat") { await runHeartbeatLoop(args[1] ?? ""); return; }
  if (sub === "status") {
    const lines = describeObservations(dir);
    console.log(`observations: ${lines[0]}`);
    for (const line of lines.slice(1)) console.log(`  ${line}`);
    const file = join(dir, OBSERVATION_DB);
    if (args.includes("--refused") && existsSync(file)) {
      const store = new ObservationStore(file);
      try { for (const row of store.terminal()) console.log(`  refused  #${row.sequence} gen ${row.generation} ${row.kind} ${row.observation_id} ${row.code} ${new Date(row.at).toISOString()}`); }
      finally { store.close(); }
    }
    return;
  }
  if (sub === "id") {
    // The opaque id this installation gives a ref, remote or repository, for writing reference
    // sets. Local only: it reads the binding key and prints; nothing is sent anywhere.
    const id = keyedIdFor(loadOrCreateBindingKey(dir), args[1] ?? "", args.slice(2));
    if (!id) { console.error("usage: observations id <ref <name> | remote <url> | ghrepo <owner/name> | repo <workspace-path> | mcp <server> <tool> | mcp-resource <kind> <value> | net-dest <host> <port> | cf <kind> <name> | database <pg|sqlite> <key>>"); process.exit(1); }
    console.log(id);
    return;
  }
  if (sub === "wire" || sub === "unwire") {
    const scopes = harnessScopes("claude", process.cwd());
    if (sub === "unwire") {
      let removed = 0;
      for (const file of [scopes.project, scopes.local, scopes.user]) if (file) removed += unwireLifecycleHooks(file);
      console.log(`removed ${removed} lifecycle hook entr${removed === 1 ? "y" : "ies"}`);
      return;
    }
    const target = scopes.local ?? scopes.project ?? scopes.user;
    const command = target ? configuredHookCommands(target)[0] : undefined;
    if (!target || !command) { console.error("Claude Code is not configured with this hook; run install or init first"); process.exit(1); }
    wireLifecycleHooks(target, command);
    console.log(`session and after-action hooks wired in ${target}`);
    return;
  }
  const opened = openObservations(dir, { adapterVersion: hookVersion(), spawnHeartbeat: false });
  if (!opened.emitter) {
    console.error(`observations are ${opened.status.state}${"reason" in opened.status ? `: ${opened.status.reason}` : ""}`);
    process.exit(1);
  }
  const emitter = opened.emitter;
  try {
    if (sub === "flush") {
      const outcome = await uploadPending(emitter.store, { url: ingestUrl(emitter.connection), credential: emitter.connection.credential, timeoutMs: 10_000, machineId: machineIdFor(emitter.dir, emitter.connection.organization_id) });
      const left = emitter.store.pendingSummary().count;
      console.log(`${outcome.result}: ${outcome.acknowledged} acknowledged, ${outcome.deferred} deferred, ${outcome.rejected} refused; ${left} still pending${outcome.detail ? ` (${outcome.detail})` : ""}`);
      process.exitCode = left > 0 ? 1 : 0;
    } else if (sub === "retry") {
      const state = emitter.store.state();
      if (state?.capability === "unsupported") { emitter.store.setCapability("active", null); console.log("will try the workspace again"); }
      else console.log("nothing to retry (a stale generation clears when you reconnect)");
    } else { console.error("usage: observations [status [--refused]|flush|retry|wire|unwire]"); process.exit(1); }
  } finally { emitter.close(); }
}

/** The single heartbeat helper for one active session (started by the hook, never by hand). */
async function runHeartbeatLoop(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const dir = resolveConfigDir(process.cwd());
  const { emitter } = openObservations(dir, { adapterVersion: hookVersion(), spawnHeartbeat: false, flushTimeoutMs: 3000 });
  if (!emitter) return;
  const override = Number(process.env.SCOPEBOND_HEARTBEAT_INTERVAL_MS);
  const interval = Number.isFinite(override) && override >= 100 ? override : heartbeatIntervalMs(dir);
  const endsAt = Date.now() + 24 * 60 * 60 * 1000;
  let last = Date.now();
  try {
    for (;;) {
      const verdict = emitter.heartbeatTick(sessionId, last);
      await emitter.flush();
      if (verdict === "stop" || Date.now() > endsAt) break;
      last = Date.now();
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
  } finally { emitter.store.releaseHeartbeat(sessionId); emitter.close(); }
}

/** The absolute path to this CLI file, for registering the hook by absolute path. */
function cliPath(): string {
  return hookCliPath();
}

/** `install` — the once-per-machine, user-level install. Scaffolds the
 *  user home and registers the hook by absolute path in the user-level agent config,
 *  so every project a developer opens is governed without a per-repo `init`. */
/** The command a user-level agent setting runs. Run through `npx`, this CLI lives in npm's
 *  throwaway cache; registering that path would leave a hook that stops starting whenever
 *  npm clears it — and a hook that cannot start lets every action through. Pin the durable
 *  copy, as `init` does, and fall back to the portable `npx` command when none can be made. */
/** A hook command for a dry-run preview: the reason instead when the real run would refuse to write it. */
function previewCommand(make: () => string): string {
  try { return make(); } catch (error) { return `(would be refused: ${(error as Error).message})`; }
}

function durableHookCommand(h: Harness): string {
  // The single executable is its own durable copy: the installer keeps its path.
  if (isSingleExecutable()) return nativeHookCommand(h);
  const pin = ensureDurableRuntime(cliPath(), hookVersion());
  return pin.cli ? absoluteHookCommand(pin.cli, h) : hookCommand(h);
}

function runInstall(args: string[]): void {
  const dir = userHome();
  const commandFor = durableHookCommand;
  const harnessesFor = (): Harness[] => args.includes("--codex") ? ["codex"]
    : args.includes("--cursor") ? ["cursor"]
    : args.includes("--copilot") ? ["copilot"]
    : args.includes("--claude") ? ["claude"]
    : ["claude", ...(cursorDetected() ? ["cursor" as const] : []), ...(codexDetected() ? ["codex" as const] : []), ...(copilotDetected() ? ["copilot" as const] : [])];
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
      // Previewed without copying anything: the path the real run would pin.
      console.log(`  adding hook       ${previewCommand(() => (isSingleExecutable() ? nativeHookCommand(h) : absoluteHookCommand(isEphemeralPath(cliPath()) ? pinnedCliPath(hookVersion()) : cliPath(), h)))}`);
      if (exists && isHarnessConfigured(file)) console.log(`  (a Scopebond hook is already there; it would be replaced, not duplicated)`);
    }
    console.log(`\nNothing else in those files is changed. Run without --dry-run to apply.`);
    process.exit(0);
  }
  const { agentKid, policyPath } = scaffold(dir, { force: args.includes("--force") });
  console.log(`Scopebond installed for this user in ${dir}`);
  console.log(`  machine key    ${agentKid}`);
  // A computer already connected keeps its connection and its workspace's rules: say so, not "starter".
  const existing = loadConnection(dir);
  const workspaceRules = existsSync(join(dir, MANAGED_DOC_FILE));
  console.log(`  policy         ${policyPath} (${workspaceRules ? "set by your workspace" : "starter — edit the limits"})`);
  if (existing) console.log(`  workspace      connected to ${existing.url} (kept)`);
  console.log("");
  const harnesses: Harness[] = harnessesFor();
  if (!args.includes("--no-install")) {
    for (const h of harnesses) {
      try {
        const target = userHarnessFile(h);
        const backup = existsSync(target) ? `${target}.scopebond-backup` : null;
        const file = writeHarnessConfig(target, h, commandFor(h));
        console.log(`✓ ${harnessName(h)} configured in ${file}`);
        if (backup && existsSync(backup)) console.log(`  original kept at ${backup}`);
      } catch (error) { console.error(`✗ ${harnessName(h)}: ${(error as Error).message}`); process.exitCode = 1; }
    }
  } else {
    console.log("Add this to your user-level agent config:");
    console.log(harnessSnippet(harnesses[0]));
  }
  if (harnesses.includes("codex")) console.log(`\nOne last step for Codex: ${codexTrustStep}`);
  if (harnesses.includes("copilot")) console.log(`\n${copilotCoverageNote}`);
  console.log("");
  console.log(`A project's own .scopebond policy applies only after you trust it there (${cliCommand("trust")}).`);
  console.log(`Check it: ${cliCommand("doctor")} · see decisions: ${cliCommand("log")}`);
  console.log(onboardingSteps({ harness: harnesses[0], command: cliCommand, connected: !!existing, agentRunning: agentPresence(userHome()).state === "running" }).join("\n"));
}

/** Size and count of the local receipt store, plus its write-ahead log. Signed evidence
 *  accumulates in the user's project directory and there is no automatic deletion — so
 *  the footprint is reported rather than left to be discovered. */
function describeStore(dbPath: string): string {
  const bytes = (file: string): number => { try { return statSync(file).size; } catch { return 0; } };
  const total = bytes(dbPath) + bytes(`${dbPath}-wal`) + bytes(`${dbPath}-shm`);
  const human = total >= 1024 * 1024 ? `${(total / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(total / 1024))} KiB`;
  let count: number | null;
  try {
    const { store } = openReceiptStore({ db: dbPath });
    try { count = store.count ? Number(store.count()) : null; } finally { void Promise.resolve(store.close?.()).catch(() => undefined); }
  } catch { count = null; }
  return count === null ? human : `${count} receipt(s), ${human}`;
}

/** What `status` and `doctor` say when the folder that holds the keys and records could not be made readable by this user
 *  alone (its own access list could not be changed): each file in it is then restricted on its own. Null when it was. */
function fileAccessLine(dir: string): string | null {
  // On POSIX every key and record file is created 0600 whatever its folder: nothing to say. Read through the namespace: with
  // an older gateway installed beside this hook the function is not there, and nothing is said.
  const ownerOnlyState = (gatewayNode as Partial<typeof gatewayNode>).ownerOnlyState;
  return process.platform === "win32" && typeof ownerOnlyState === "function" && ownerOnlyState(dir) === "per-file"
    ? `${dir} could not be made readable by you alone (its own access could not be changed); its key and record files are restricted one by one`
    : null;
}

function runStatus(args: string[] = []): void {
  if (args.includes("--json")) {
    const cwd = process.cwd();
    const active = resolveConfigDir(cwd);
    const configured = (h: Harness) => !!harnessScopeLabel(harnessScopes(h, cwd));
    console.log(JSON.stringify(buildStatusJson({
      version: hookVersion(), activeDir: active, candidateDirs: [userHome(), join(cwd, ".scopebond")],
      userDir: process.env.SCOPEBOND_HOOK_DIR ? undefined : userHome(),
      hasPolicy: existsSync(join(active, "policy.json")),
      agents: { claude: configured("claude"), cursor: configured("cursor"), codex: configured("codex"), copilot: configured("copilot") },
    }), null, 2));
    return;
  }
  const home = userHome();
  const installed = existsSync(join(home, "policy.json"));
  // Both scopes, always: `init` writes the project config and `install` writes the
  // user one, so a single-scope check contradicts whichever command the user ran.
  const claude = harnessScopes("claude", process.cwd());
  const cursor = harnessScopes("cursor", process.cwd());
  const codex = harnessScopes("codex", process.cwd());
  const copilot = harnessScopes("copilot", process.cwd());
  const connected = !!loadConnection(resolveConfigDir(process.cwd()));
  const dbPath = join(resolveConfigDir(process.cwd()), "receipts.db");
  console.log(`Scopebond hook ${hookVersion()}`);
  console.log(`  user home        ${home} ${installed ? "(installed)" : `(not installed — run \`${cliCommand("install")}\`)`}`);
  console.log(`  active config    ${resolveConfigDir(process.cwd())}`);
  {
    const active = resolveConfigDir(process.cwd());
    const shadowed = shadowedUserConnection(active);
    if (shadowed) console.log(`  user sign-in     ${home} is connected to ${shadowed}, but ${active} takes precedence here${connected ? "" : " and is not connected, so records from here stay on this computer"}`);
  }
  const ignored = untrustedProjectPolicy(process.cwd());
  if (ignored) console.log(`  project policy   ${ignored} ignored — not trusted (run \`${cliCommand("trust")}\` to use it)`);
  console.log(`  Claude Code      ${harnessScopeLabel(claude) || "not configured"}`);
  console.log(`  Cursor           ${harnessScopeLabel(cursor) || (cursorDetected() ? "detected, not configured" : "not detected")}`);
  console.log(`  Codex            ${codex.project || codex.user ? `${harnessScopeLabel(codex)} — approve once with /hooks` : codexDetected() ? "detected, not configured" : "not detected"}`);
  console.log(`  GitHub Copilot   ${harnessScopeLabel(copilot) ? `${harnessScopeLabel(copilot)} — ${COPILOT_ENFORCEMENT}` : copilotDetected() ? "detected, not configured" : "not detected"}`);
  for (const [harness, scopes] of [["cursor", cursor], ["codex", codex]] as const) {
    const note = quotedEntryNote(harness, [scopes.project, scopes.local, scopes.user]);
    if (note) console.log(`  note             ${harnessName(harness)}: ${note}`);
  }
  console.log(`  cloud workspace  ${connected ? "connected" : "not connected (local only)"}`);
  {
    const activeDir = resolveConfigDir(process.cwd());
    const connection = loadConnection(activeDir);
    if (connection) for (const line of describeDelivery(activeDir, connection).lines) console.log(`                   ${line}`);
    const failures = hookErrorLine(activeDir);
    if (failures) console.log(`  hook failures    ${failures}`);
  }
  {
    const activeDir = resolveConfigDir(process.cwd());
    const meta = readMeta(activeDir);
    const managed = existsSync(join(activeDir, MANAGED_DOC_FILE));
    const checked = meta.checked_at ? `, last checked ${meta.checked_at}` : "";
    console.log(`  rules            ${managed ? `set by your workspace (version ${meta.revision})${checked}` : `this computer's own (${rulesPath(activeDir)})${connected ? checked : ""}`}`);
    console.log(`                   always on: protection of Scopebond's own settings and the agents' hook settings`);
    if (meta.last_error) console.log(`                   last problem: ${meta.last_error}`);
    for (const note of meta.rule_notes ?? []) console.log(`                   note: ${note}`);
    for (const line of describePackSync(meta.packs)) console.log(`  rule packs       ${line}`);
  }
  {
    const activeDir = resolveConfigDir(process.cwd());
    const connection = loadConnection(activeDir);
    for (const line of healthLines({ hookVersion: hookVersion(), recommended: readMeta(activeDir).recommended ?? null, agent: agentPresence(home), connected: !!connection, workspaceUrl: connection?.url ?? null })) {
      console.log(`  ${line.label.padEnd(16)} ${line.text}`);
    }
  }
  const observationLines = describeObservations(resolveConfigDir(process.cwd()));
  console.log(`  observations     ${observationLines[0]}`);
  for (const line of observationLines.slice(1)) console.log(`                   ${line}`);
  console.log(`  local receipts   ${existsSync(dbPath) ? `${dbPath} (${describeStore(dbPath)})` : "none yet"}`);
  const fileAccess = fileAccessLine(resolveConfigDir(process.cwd()));
  if (fileAccess) console.log(`  file access      ${fileAccess}`);
  for (const [name, scopes] of [["Claude Code", claude], ["Cursor", cursor], ["Codex", codex], ["GitHub Copilot", copilot]] as const) {
    for (const file of [scopes.project, scopes.local, scopes.user]) if (file) console.log(`    ${name}: ${file}`);
  }
  for (const problem of missingProgramProblems(process.cwd())) console.log(`  MISSING PROGRAM  ${problem}`);
  for (const line of duplicateLines(process.cwd())) console.log(line);
}

/** What to say about a hook entry whose single executable is gone, with the command that repairs it in the form this
 *  installation runs: `install` (or `init` for a project's entry) points it at this Scopebond, `uninstall` removes it. */
function missingProgramProblem(name: string, file: string, program: string, scope: "user" | "project"): string {
  const repair = scope === "user" ? cliCommand("install") : cliCommand("init");
  return `${name} hook entry in ${file} points at a missing program (${program}), so ${name} shows a hook error on each action and runs it unchecked. `
    + `Reinstall Scopebond (${NATIVE_DOWNLOAD_URL}), run \`${repair}\` to point it at this Scopebond, or \`${cliCommand("uninstall")}\` to remove it`;
}

/** Every hook entry, in every agent and scope, that runs a single executable which is no longer there. */
function missingProgramProblems(cwd: string): string[] {
  const out: string[] = [];
  for (const harness of HARNESSES) {
    const scopes = harnessScopes(harness, cwd);
    for (const [file, scope] of [[scopes.project, "project"], [scopes.local, "project"], [scopes.user, "user"]] as const) {
      if (!file) continue;
      for (const { program } of missingHookPrograms(file)) out.push(missingProgramProblem(harnessName(harness), file, program, scope));
    }
  }
  return out;
}

/** Each agent that would ask Scopebond more than once per action, and the one command that keeps one. */
function duplicateLines(cwd: string): string[] {
  const lines: string[] = [];
  for (const harness of HARNESSES) {
    const dupes = duplicateHooks(harness, cwd);
    if (!dupes) continue;
    const flag = harness === "claude" ? "" : ` --${harness}`;
    lines.push(`  DUPLICATE        ${harnessName(harness)} runs the Scopebond hook ${dupes.length} times for each action:`);
    for (const e of dupes) lines.push(`                   - ${describeEntry(e)}`);
    lines.push(`                   Keep one (the user-level entry): ${cliCommand(`dedupe${flag}`)}`);
  }
  return lines;
}

/** `dedupe [--claude|--cursor|--codex|--copilot] [--keep user|project|plugin]`: keep one Scopebond hook entry per agent. */
function runDedupe(args: string[]): void {
  const harness: Harness = selectedHarness(args);
  const at = args.indexOf("--keep");
  const keep = (at >= 0 ? args[at + 1] : "user") as HookScope;
  if (!["user", "project", "local", "plugin"].includes(keep)) { console.error(`usage: ${cliCommand("dedupe [--claude|--cursor|--codex|--copilot] [--keep user|project|plugin]")}`); process.exit(1); }
  const dupes = duplicateHooks(harness, process.cwd());
  if (!dupes) { console.log(`${harnessName(harness)} runs the Scopebond hook once per action; nothing to change.`); return; }
  const result = dedupeHooks(harness, keep, process.cwd());
  if (!result.kept) {
    // Removing the settings entries would leave the agent with no Scopebond hook at all.
    console.error(`No enabled Scopebond plugin was found for ${harnessName(harness)}, so nothing was changed: removing the settings entries would leave no Scopebond hook. Keep a settings entry instead with ${cliCommand("dedupe")}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Kept: ${describeEntry(result.kept)}`);
  for (const e of result.removed) console.log(`Removed: ${describeEntry(e)}`);
  for (const e of result.plugins) console.log(`Still running from ${describeEntry(e)}: turn that plugin off in Claude Code (/plugin), or keep it instead with ${cliCommand("dedupe --keep plugin")}`);
  for (const e of result.shared) console.log(`Left alone: ${describeEntry(e)} is shared with the team through git; actions in this project are recorded twice until the team removes that entry.`);
}

/** What a person does after `capabilities --prove --copilot` to confirm Copilot's tool names on a real install. */
const copilotProbeSteps = [
  "Now, in each Copilot surface you use, start a new session and ask the agent to:",
  "  1. run `git status`   2. read a file   3. create a file and then edit it   4. fetch https://example.com",
  "  5. create the file .github/hooks/probe.json (Scopebond always denies this, saying why)",
  "Surfaces: the Copilot CLI; VS Code agent mode with the Copilot session target and with the Local",
  "session target. Then run this command again: every tool name each surface sent is listed with",
  "what Scopebond made of it. A name marked \"recorded, not evaluated\" is not checked yet.",
  "If no \"VS Code Local harness\" section appears after using the Local session target, the hook",
  "is not running there: Local did not load this hook file.",
].join("\n");

/** `capabilities`: the manifest of what this hook can honestly claim, cell by cell.
 *  `--prove` runs the safe fixtures in temp directories (never touching agent settings);
 *  `--save` records the result beside the policy; `--json` prints the manifest. */
async function runCapabilities(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const dir = resolveConfigDir(cwd);
  const configured = {
    claude: !!harnessScopeLabel(harnessScopes("claude", cwd)),
    cursor: !!harnessScopeLabel(harnessScopes("cursor", cwd)),
    codex: !!harnessScopeLabel(harnessScopes("codex", cwd)),
    copilot: !!harnessScopeLabel(harnessScopes("copilot", cwd)),
  };
  const version = hookVersion();
  let proofs = loadProofs(dir);
  let failed = false;
  if (args.includes("--prove")) {
    // When the workspace accepts observations, the fixtures are signed with this machine's
    // own keys (copied into the temp home) and their receipts are delivered first, so the
    // proof can name them and the workspace can resolve them. Otherwise a fixture stays local.
    const observed = openObservations(dir, { adapterVersion: version, spawnHeartbeat: false });
    const collected: unknown[] = [];
    const fresh = await runProofFixtures(version, observed.emitter ? { identityDir: dir, collect: collected } : {});
    const proven = computeManifest({ adapterVersion: version, configured: { claude: true, codex: true, cursor: true, copilot: true }, proofs: fresh });
    for (const cell of proven.cells) {
      const proof = fresh[cell.key];
      if (proof && !proofPassed(proof, cell)) {
        failed = true;
        console.error(`fixture failed: ${cell.key} (allow ${proof.safe_allow}, deny ${proof.safe_deny}, signature ${proof.signature}, grouping ${proof.grouping})`);
      }
    }
    if (observed.emitter) {
      try {
        const delivered = await deliverProofReceipts(observed.emitter.connection, collected, { machineId: machineIdFor(observed.emitter.dir, observed.emitter.connection.organization_id) });
        if (!delivered) console.error("could not deliver the fixture receipts to the workspace; the capability proofs were not sent (run it again when it is reachable)");
        else {
          const queued = observed.emitter.capabilityProofs(proven.cells.flatMap((cell) => {
            // A typed-operation cell has no receipt of its own action type for a proof to name, so no proof is sent for it.
            if (TYPED_ACTION_TYPES.has(cell.action_type)) return [];
            const proof = cell.state === "unsupported" ? undefined : fresh[cell.key];
            return proof ? [{ adapterVersion: cell.adapter_version, hostVariant: cell.host_variant, actionType: cell.action_type, phase: cell.event_phase, requiredFields: cell.emitted_required_fields, fixtureVersion: `fixture/${proof.test_vector_digest}`, passed: proofPassed(proof, cell), proofDigests: proof.proof_digests }] : [];
          }));
          await observed.emitter.flush(3000);
          console.error(`queued ${queued} capability proof observation(s) (fixture origin, ${collected.length} fixture receipt(s) delivered)`);
        }
      } finally { observed.emitter.close(); }
    }
    if (args.includes("--save")) {
      if (!existsSync(dir)) { console.error(`no ${dir} to record into - run \`${cliCommand("init")}\` first.`); process.exit(1); }
      console.error(`recorded fixture proofs in ${saveProofs(dir, fresh)}`);
    }
    proofs = fresh;
  }
  const manifest = computeManifest({ adapterVersion: version, configured, proofs });
  if (args.includes("--json")) console.log(JSON.stringify(manifest, null, 2));
  else {
    console.log(renderManifest(manifest));
    if (args.includes("--prove")) console.log(`\nFixture run ${failed ? "FAILED - see degraded cells" : "passed"}. It used temporary directories only; no agent setting or policy was changed and no key was modified.`);
  }
  // `--prove --copilot`: the live half. Fixtures cannot say which tool names a real Copilot surface sends, so this opens
  // (or extends) a recording window on this computer and shows what the surfaces have sent so far. Text goes to stderr
  // with --json, so the manifest on stdout stays one JSON document.
  if (args.includes("--prove") && args.includes("--copilot")) {
    const out = args.includes("--json") ? console.error : console.log;
    if (!existsSync(join(dir, "policy.json"))) { out(`\nno Scopebond setup in ${dir} to record Copilot's tool names into - run \`${cliCommand("install --copilot")}\` first.`); }
    else {
      const before = readCopilotProbe(dir);
      const probe = openCopilotProbe(dir);
      out("");
      out(renderCopilotProbe(probe, join(dir, COPILOT_PROBE_FILE)));
      out("");
      out(before ? "Recording extended by an hour." : "Recording is now open for an hour.");
      out(copilotProbeSteps);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

async function runDoctor(): Promise<void> {
  const problems: string[] = [];
  const nodeOk = nodeSupported();
  console.log(`Scopebond doctor`);
  console.log(`  node             ${process.versions.node} ${nodeOk ? "ok" : "TOO OLD (need >=22.13)"}`);
  if (!nodeOk) problems.push("node >=22.13 is required (the Cloud outbox uses node:sqlite)");
  if (process.platform === "win32" && !isSingleExecutable()) {
    // The commands this computer's person types: PowerShell's script policy decides whether plain npx runs. The
    // installer's program is an .exe, which the policy does not touch.
    let policy = "";
    // Windows PowerShell finds its own modules only without PowerShell 7's PSModulePath, which a doctor run from
    // pwsh would pass on; and its errors are not this computer's problem to print.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));
    try { policy = execFileSync(windowsSystemProgram("powershell"), ["-NoProfile", "-NonInteractive", "-Command", "Get-ExecutionPolicy"], { encoding: "utf8", timeout: 10_000, windowsHide: true, env, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* no PowerShell: nothing to say */ }
    const advice = policy ? executionPolicyAdvice(policy) : null;
    if (advice) console.log(`  powershell       ${advice}`);
  }
  const cli = isSingleExecutable() ? process.execPath : cliPath();
  console.log(`  cli              ${cli} ${existsSync(cli) ? "ok" : "MISSING"}${isSingleExecutable() ? " (the signed installer's program)" : ""}`);
  const active = resolveConfigDir(process.cwd());
  const hasPolicy = existsSync(join(active, "policy.json"));
  console.log(`  active config    ${active} ${hasPolicy ? "ok" : `no policy (run \`${cliCommand("init")}\` here, or \`${cliCommand("install")}\` once for your user)`}`);
  const fileAccess = fileAccessLine(active);
  if (fileAccess) console.log(`  file access      ${fileAccess}`);
  if (!hasPolicy) problems.push("no policy found in the active config dir");
  const failures = hookErrorLine(active);
  if (failures) console.log(`  hook failures    ${failures}`);
  // C-01: a rules file that does not parse blocks every action; doctor says so with the fix instead of "ok".
  if (hasPolicy) {
    try { readPolicyFile(join(active, "policy.json")); }
    catch (error) { problems.push(`${(error as Error).message}: ${repairFor(error)}`); }
  }
  const ignored = untrustedProjectPolicy(process.cwd());
  const shadowed = shadowedUserConnection(active);
  if (shadowed) {
    const activeConnected = !!loadConnection(active);
    console.log(`  user sign-in     ${userHome()} is connected to ${shadowed}, but ${active} takes precedence here${activeConnected ? "" : " — NOT CONNECTED"}`);
    if (!activeConnected) problems.push(`this folder's own setup (${active}) takes precedence over your user-level sign-in and is not connected, so records from agent sessions here stay on this computer; delete ${active} to use your sign-in here, or run ${cliCommand(`login ${shadowed} --project`)} here to connect it`);
  }
  if (ignored) console.log(`  project policy   ${ignored} IGNORED — not trusted (never trusted, or edited since). Review it, then \`${cliCommand("trust")}\``);
  // Signing keys for workspace rules that cannot be used (a window that closes before it opens, a key that does not read).
  for (const problem of policyKeyProblems()) {
    console.log(`  rules keys       ${problem}`);
    problems.push(`a signing key for workspace rules is left out: ${problem}`);
  }
  // Every harness, in both scopes, plus a check that each configured command can
  // actually start. A pinned path that has gone missing is the one failure mode of
  // the fast absolute-path install, so doctor is where it must surface.
  let anyHarness = false;
  for (const harness of HARNESSES) {
    const scopes = harnessScopes(harness, process.cwd());
    const label = harnessScopeLabel(scopes);
    const name = harnessName(harness);
    if (!label) {
      const detected = harnessDetected(harness);
      console.log(`  ${name.padEnd(15)} ${detected ? `not configured — run \`${cliCommand(`init${harness === "claude" ? "" : ` --${harness}`}`)}\`` : "not detected"}`);
      continue;
    }
    anyHarness = true;
    console.log(`  ${name.padEnd(15)} ${label}`);
    for (const file of [scopes.project, scopes.local, scopes.user]) {
      if (!file) continue;
      // A project file git shares must not name a path on this machine: it starts here,
      // so the resolve check below passes, but on every teammate's machine it cannot
      // start — and a hook that cannot start is a non-blocking error, so their agent runs
      // unchecked. Only the doctor on the machine that wrote it can see this coming.
      const share = file === scopes.project ? gitShareState(file) : "none";
      const shared = share === "tracked" || share === "untracked";
      for (const command of configuredHookCommands(file)) {
        const ok = hookCommandResolves(command);
        const leaks = ok && shared && isMachineSpecificCommand(command);
        console.log(`    ${ok && !leaks ? "ok  " : "BAD "} ${file}`);
        const program = nativeHookProgram(command);
        if (!ok && program && !existsSync(program)) {
          console.log(`         command cannot start (missing program): ${command}`);
          problems.push(missingProgramProblem(name, file, program, file === scopes.user ? "user" : "project"));
        } else if (!ok) {
          console.log(`         command cannot start: ${command}`);
          problems.push(`${name} hook command no longer resolves in ${file} — run \`${cliCommand("init")}\` to repair it`);
        } else if (leaks) {
          console.log(`         machine-specific command in a file git shares: ${command}`);
          problems.push(`${name} hook in ${file} names a path on this machine and git shares that file — anyone who clones it gets a hook that cannot start, and their agent runs unchecked. Run \`${cliCommand(`init${harness === "claude" ? "" : ` --${harness}`}`)}\` to move it, then commit the change`);
        }
      }
    }
    const quotedNote = quotedEntryNote(harness, [scopes.project, scopes.local, scopes.user]);
    if (quotedNote) console.log(`    note: ${quotedNote}`);
    if (harness === "codex") console.log(`    run /hooks in Codex and approve Scopebond once`);
    if (harness === "copilot") console.log(`    ${COPILOT_ENFORCEMENT}`);
  }
  if (!anyHarness) problems.push(`no coding agent is configured — run \`${cliCommand("init")}\` in your project root`);
  const connection = loadConnection(active);
  if (!connection) {
    console.log(`  cloud            not connected (local only) — receipts stay on this machine`);
  } else {
    let reachable: string;
    try {
      const res = await fetch(new URL("/healthz", connection.url).toString(), { method: "GET", headers: withHookVersion({}), signal: AbortSignal.timeout(10_000) });
      reachable = res.ok ? "reachable" : `unhealthy (${res.status})`;
    } catch (error) { reachable = `unreachable (${(error as Error).message})`; }
    console.log(`  cloud            ${connection.url} — ${reachable}`);
    // C-11: an unreachable or unhealthy workspace is a problem (records queue here; nothing is lost), not "All good".
    if (reachable !== "reachable") problems.push(`the workspace is ${reachable}: records stay queued on this computer and send once it answers (service status: https://status.scopebond.com)`);
    // An authenticated check. Reaching the workspace says nothing about whether it
    // still accepts this computer; the rules endpoint answers 401 when it does not.
    let accepted: string;
    let recommended = readMeta(active).recommended ?? null;
    try {
      const res = await fetch(new URL("/v1/policy", connection.url).toString(), {
        headers: { authorization: `Bearer ${connection.credential}`, "x-scopebond-hook-version": hookVersion() },
        redirect: "error", signal: AbortSignal.timeout(10_000),
      });
      recommended = recommendedFrom(res.headers) ?? recommended;
      if (res.status === 401) {
        accepted = "REFUSED (401)";
        recordRulesCredential(active, false, Date.now());
      } else if (res.ok || res.status === 204 || res.status === 304) {
        accepted = "accepted";
        recordRulesCredential(active, true, Date.now());
      } else accepted = `unknown (HTTP ${res.status})`;
    } catch (error) { accepted = `not checked (${(error as Error).message})`; }
    console.log(`  connection       ${accepted}`);
    if (accepted === "REFUSED (401)") problems.push(`the workspace refused this computer's connection: sign in again with \`${cliCommand("login")}\``);
    const delivery = describeDelivery(active, connection);
    for (const line of delivery.lines) console.log(`                   ${line}`);
    problems.push(...delivery.problems);
    for (const line of healthLines({ hookVersion: hookVersion(), recommended, agent: agentPresence(userHome()), connected: true, workspaceUrl: connection.url })) {
      console.log(`  ${line.label.padEnd(16)} ${line.text}`);
      // Only a broken setup fails doctor: an agent installed but not running. An older version or a computer
      // without the (optional) agent is said above, with its command, and does not fail scripts that run doctor.
      if (line.problem && /installed but not running/.test(line.text)) problems.push("the Scopebond Agent is installed but not running (see background agent above)");
    }
  }
  const duplicates = duplicateLines(process.cwd());
  for (const line of duplicates) console.log(line);
  // A duplicate only the team can remove (its project file is shared through git) is shown, not failed on.
  const fixableHere = HARNESSES.some((h) => (duplicateHooks(h, process.cwd()) ?? []).some((e) => e.scope !== "user" && e.scope !== "plugin" && gitShareState(e.file) !== "tracked")
    || (duplicateHooks(h, process.cwd()) ?? []).filter((e) => e.scope === "user" || e.scope === "plugin").length > 1);
  if (duplicates.length && fixableHere) problems.push("the Scopebond hook runs more than once for each action (see DUPLICATE above)");
  console.log(problems.length ? `\n${problems.length} problem(s): ${problems.join("; ")}` : `\nAll good.`);
  process.exitCode = problems.length ? 1 : 0;
}

async function runUninstall(args: string[]): Promise<void> {
  requireInteractive("uninstall", args);
  // Every workspace this computer is connected to hears about the removal first (the user home's connection and a project's).
  // One that could not be told is said, and the exit code says so once the removal is done (UNINSTALL_NOT_TOLD_EXIT).
  const seen = new Set<string>();
  let untold = 0;
  for (const dir of [userHome(), resolveConfigDir(process.cwd())]) {
    const connection = loadConnection(dir);
    if (!connection || seen.has(connection.credential)) continue;
    seen.add(connection.credential);
    const report = await reportUninstall(connection, { purge: args.includes("--purge"), hookVersion: hookVersion() });
    if (!report.told) untold++;
    console.log(uninstallReportLine(report));
  }
  if (seen.size === 0) console.log("this computer is not connected to a workspace, so there was none to tell");
  let removed = 0;
  // Both scopes. Checking only the user config meant that after a per-project `init` —
  // the install the site actually tells people to run — `uninstall` reported "no
  // user-level harness config found" and left the project hook in place.
  for (const h of HARNESSES) {
    for (const file of [projectHarnessFile(h, process.cwd()), localHarnessFile(h, process.cwd()), userHarnessFile(h)]) {
      if (file && removeHarnessConfig(file)) { console.log(`✓ removed the Scopebond hook from ${file}`); removed++; }
    }
  }
  if (removed === 0) console.log("no Scopebond hook found in this project or your user config.");
  // A program that ran this for the person (UNINSTALL_CALLER_ENV) says last what happens to the Scopebond folder.
  const caller = !!process.env[UNINSTALL_CALLER_ENV];
  if (args.includes("--purge")) { purgeHome(); if (!caller) console.log(`✓ purged ${userHome()} (keys, policy, receipts)`); }
  else if (!caller) console.log(`Kept ${userHome()} (keys, policy, receipts). Use --purge to remove it too.`);
  // Run from the home folder, the user home is also the "project" folder found: it is named once, above.
  const projectDir = resolveConfigDir(process.cwd());
  if (resolve(projectDir) !== resolve(userHome()) && existsSync(join(projectDir, "policy.json"))) {
    console.log(`Kept ${projectDir} (this project's keys, policy and receipts) — delete it by hand if you want it gone.`);
  }
  if (untold) process.exitCode = UNINSTALL_NOT_TOLD_EXIT;
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

/** `login <workspace-url>` — connect this computer without pasting anything. It asks
 *  the workspace for a short code, shows it with the page to open, and waits while a
 *  person who can manage the workspace approves it there for an environment and agent.
 *  The approval hands back a single-use enrollment, which completes exactly as
 *  `connect` does. Nothing secret is printed: the device code stays in memory. */
/** The flags a login was run with, to repeat it exactly. */
function loginFlags(args: string[]): string[] {
  return args.filter((a) => ["--claude", "--cursor", "--codex", "--copilot", "--no-install", "--project", "--yes"].includes(a));
}

async function runLogin(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const harness = selectedHarness(args);
  let origin: string;
  try {
    const parsed = new URL(positional[0] ?? "");
    const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
    if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) throw new Error("https required");
    origin = parsed.origin;
  } catch {
    console.error(`usage: ${cliCommand("login <workspace-url> [--claude|--cursor|--codex] [--no-install] [--project] [--yes]")}`);
    console.error("The workspace URL is the address of your Scopebond workspace, for example https://cloud.scopebond.com.");
    process.exit(1);
  }
  const post = async (path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown>; retryAfter: string | null }> => {
    const response = await fetch(new URL(path, origin), {
      // Sign-in runs before enrollment; it says which hook version asks too, so the workspace can hold a version floor here.
      method: "POST", headers: withHookVersion({ "content-type": "application/json" }), body: JSON.stringify(body),
      redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown>, retryAfter: response.headers.get("retry-after") };
  };
  // Run from inside an agent session (its own terminal or tool call), a sign-in can
  // land in the agent's working folder rather than this person's, and the person may never
  // see the code to approve. Say so plainly; the hook settings are left alone either way.
  if (process.env.CLAUDECODE || process.env.CODEX_SANDBOX || process.env.CURSOR_AGENT) {
    console.error("Note: this looks like a coding agent's own terminal. Signing in works best from your own terminal window, outside the agent.");
  }
  const dir = loginDir(args);
  let start: { status: number; json: Record<string, unknown> };
  // The machine id (a hash, never the OS id itself) lets the workspace see that a computer signing in again is the same one.
  try { start = await post("/v1/device/code", { ...clientNameField(), harness, ...machineIdField(dir, loadConnection(dir)?.organization_id) }); }
  catch (error) { console.error(`could not reach ${origin}: ${(error as Error).message}. ${unreachableHint(error)}`); process.exit(1); }
  const deviceCode = typeof start.json.device_code === "string" ? start.json.device_code : "";
  if (start.status !== 200 || !deviceCode) {
    console.error(`${origin} did not start a login (HTTP ${start.status}). Check the workspace URL, or use ${cliCommand("connect <workspace-url> <enrollment>")}.`);
    process.exit(1);
  }
  const userCode = textOf(start.json.user_code);
  const verify = textOf(start.json.verification_uri_complete ?? start.json.verification_uri ?? origin);
  let intervalMs = Math.max(1, Number(start.json.interval ?? 5)) * 1000;
  const deadline = Date.now() + Math.max(60, Number(start.json.expires_in ?? 600)) * 1000;
  console.log(`To connect this computer, open:\n\n  ${verify}\n\nand check that it shows the code  ${userCode}\n`);
  console.log("Waiting for approval (the code expires in 10 minutes; Ctrl+C to stop)…");
  scaffold(dir, {});
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    let polled: { status: number; json: Record<string, unknown>; retryAfter: string | null };
    try { polled = await post("/v1/device/token", { device_code: deviceCode }); }
    catch { continue; } // a transient network error: keep waiting until the deadline
    // A busy or rate-limited workspace: wait as it says and keep polling until the deadline.
    if (polled.status === 429 || polled.status === 503) { intervalMs = Math.max(intervalMs, retryAfterSeconds(polled.retryAfter) * 1000); continue; }
    if (polled.status === 200 && polled.json.enrollment && typeof polled.json.enrollment === "object") {
      const summary = approvalSummary(polled.json);
      console.log(summary ? `✓ ${summary}` : "✓ Approved");
      // Someone else could have approved this code into their own workspace: the person here confirms it before anything
      // is set up. A script (no terminal) passes --yes.
      if (summary && process.stdin.isTTY && !args.includes("--yes")) {
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = (await prompt.question("Connect this computer to that workspace? [y/N] ")).trim().toLowerCase();
        prompt.close();
        if (answer !== "y" && answer !== "yes") {
          console.error(`Nothing was connected. If you did not expect that workspace, tell its owner. To ask again: ${retryCommand(loginAgainCommand(origin, loginFlags(args)))}`);
          process.exit(1);
        }
      }
      await finishConnect(dir, origin, polled.json.enrollment as CloudEnrollmentBundle, harness, args, approvedWorkspaceId(polled.json));
      return;
    }
    const error = polled.json.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") { intervalMs += 5_000; continue; }
    if (error === "access_denied") { console.error(`The request was denied in the workspace. Nothing was connected. To ask again: ${retryCommand(loginAgainCommand(origin, loginFlags(args)))}`); process.exit(1); }
    if (error === "expired_token") break;
    console.error(`login failed (${textOf(error ?? `HTTP ${polled.status}`)}). For a new code, run: ${retryCommand(loginAgainCommand(origin, loginFlags(args)))}`);
    process.exit(1);
  }
  console.error(`The code expired before it was approved. For a new one, run: ${retryCommand(loginAgainCommand(origin, loginFlags(args)))}`);
  process.exit(1);
}

/** What each command does, its arguments, and one example. The whole help used to be a
 *  single usage line listing 15 command names, which told a reader nothing about what any
 *  of them did or what arguments they take. */
/** `packs`: the rule packs cached on this computer (pack-store.ts). `list` (the default) shows what is in force and why
 *  anything is not; `verify <file>` checks a pack file (format, signature, its own vectors) without installing it; `add <file>`
 *  and `remove <id>` change the cache, so they are for a person at a terminal. */
function runPacks(args: string[]): void {
  const [sub = "list", target] = args.filter((a) => !a.startsWith("--"));
  const dir = resolveConfigDir(process.cwd());
  const json = args.includes("--json");
  if (sub === "list") {
    const loaded = loadPacks(dir);
    if (json) {
      console.log(JSON.stringify({ dir: packsDir(dir), expires_at: loaded.expiresAt, packs: loaded.packs.map((p) => ({ id: p.id, version: p.version, issued_at: p.issued_at, title: p.title ?? null, expires_at: loaded.expires[`${p.id}@${p.version}`] ?? null })), problems: loaded.problems, not_updated: readMeta(dir).packs?.failed ?? [] }, null, 2));
      return;
    }
    const notUpdated = describePackSync(readMeta(dir).packs);
    if (loaded.packs.length === 0 && loaded.problems.length === 0 && notUpdated.length === 0) { console.log("No rule packs on this computer. The open detection and the starter protections apply."); return; }
    for (const p of loaded.packs) {
      const until = loaded.expires[`${p.id}@${p.version}`];
      console.log(`  ${p.id}@${p.version}  issued ${p.issued_at}${p.title ? `  ${p.title}` : ""}${until ? `  in force until ${until}` : ""}`);
    }
    if (loaded.packs.length) console.log("Each pack stays in force for 30 days after this computer last confirmed it with the workspace.");
    for (const problem of loaded.problems) console.log(`  not used: ${problem.ref}: ${problem.message}`);
    for (const line of notUpdated) console.log(`  not updated: ${line}`);
    return;
  }
  if (sub === "test") { runPacksTest(args, dir, json); return; }
  if ((sub === "verify" || sub === "add") && target) {
    let text = "";
    try { text = readFileSync(target, "utf8"); } catch { console.error(`cannot read ${target}`); process.exit(1); }
    if (sub === "verify") {
      const result = checkPackFile(text);
      if (!result.ok) { console.error(`not a usable pack: ${result.message}`); process.exit(1); }
      console.log(`ok: ${result.ref}, signature verified, ${result.vectors} vectors pass`);
      return;
    }
    requireInteractive("packs add", args);
    const result = installPack(dir, text);
    if (!result.ok) { console.error(`not added: ${result.message}`); process.exit(1); }
    console.log(`added ${result.pack.id}@${result.pack.version}; it is in force for 30 days unless this computer checks in again.`);
    return;
  }
  if (sub === "remove" && target) {
    requireInteractive("packs remove", args);
    if (!removePack(dir, target)) { console.error(`no pack ${target} here`); process.exit(1); }
    console.log(`removed ${target}`);
    return;
  }
  console.error("usage: scopebond packs [list|test --all|test <file>|verify <file>|add <file>|remove <id>] [--json] [--yes]");
  process.exit(1);
}

/** `packs test --all`: run every vector of every pack in force here with this engine; `packs test <file>`: the vectors of one
 *  pack file (its shape is checked, its signature is `packs verify`'s job). Exit 1 when any vector fails. This is the check an
 *  engine update runs with the new engine before it is used, so it reports the engine's version and the packs it ran. */
function runPacksTest(args: string[], dir: string, json: boolean): void {
  const file = args.filter((a) => !a.startsWith("--"))[1];
  let packs: Pack[];
  let notUsed: Array<{ ref: string; reason: string }> = [];
  if (args.includes("--all")) {
    const loaded = loadPacks(dir);
    packs = loaded.packs;
    notUsed = loaded.problems.map((p) => ({ ref: p.ref, reason: p.reason }));
  } else if (file) {
    let doc: unknown;
    try { doc = JSON.parse(readFileSync(file, "utf8")); } catch { console.error(`cannot read ${file} as JSON`); process.exit(1); }
    const shape = validatePack(doc);
    if (!shape.valid) { console.error(`not a valid pack: ${shape.errors.slice(0, 3).join("; ")}`); process.exit(1); }
    packs = [doc as Pack];
  } else {
    console.error("usage: scopebond packs test --all | <file> [--json]");
    process.exit(1);
  }
  let vectors = 0;
  const failures: Array<{ pack: string; vector: string }> = [];
  const lines: string[] = [];
  for (const pack of packs) {
    const ref = `${pack.id}@${pack.version}`;
    const run = runPackVectors(pack);
    vectors += run.passed;
    for (const failure of run.failures) failures.push({ pack: ref, vector: failure.id });
    lines.push(run.failures.length ? `${ref}: ${run.failures.length} of ${pack.vectors.length} vectors fail (first: ${run.failures[0].id})` : `${ref}: ${run.passed} vectors pass`);
  }
  if (json) console.log(JSON.stringify({ engine: hookVersion(), packs: packs.map((p) => `${p.id}@${p.version}`), vectors, failures, ...(file && !args.includes("--all") ? {} : { not_used: notUsed }) }));
  else {
    console.log(`engine ${hookVersion()}`);
    for (const line of lines) console.log(`  ${line}`);
    if (!packs.length) console.log("  no rule packs to test");
  }
  if (failures.length) process.exit(1);
}

/** Check a pack file as `packs add` would, without changing anything. */
function checkPackFile(text: string): { ok: true; ref: string; vectors: number } | { ok: false; message: string } {
  const checked = checkPackText(text);
  if (!checked.ok) return { ok: false, message: checked.message };
  const run = runPackVectors(checked.pack);
  if (run.failures.length) return { ok: false, message: `${run.failures.length} of ${checked.pack.vectors.length} vectors fail (first: ${run.failures[0].id})` };
  return { ok: true, ref: `${checked.pack.id}@${checked.pack.version}`, vectors: run.passed };
}

const COMMANDS: Array<{ name: string; args?: string; summary: string; detail?: string[] }> = [
  { name: "init", args: "[--cursor|--codex|--copilot] [--shared] [--dry-run] [--no-install] [--npx] [--force] [--yes] | --repo [--dry-run] [--yes]",
    summary: "set this project up: keys, a starter policy, and your agent wired to the hook",
    detail: [
      "Writes .scopebond/ (machine key, countersigning key, starter policy, .gitignore) and",
      "wires your agent to the hook. It pins a durable copy of this package so the hook starts",
      "fast, and because that command names paths on this machine it goes where git will not",
      "share it: .claude/settings.local.json (kept out of git for this clone), or for Cursor,",
      "Codex and GitHub Copilot their project file only while git does not track it. --shared",
      "writes the portable npx command to .claude/settings.json, .cursor/hooks.json,",
      ".codex/hooks.json or .github/hooks/scopebond.json instead, so everyone who clones the",
      "project gets the hook. --dry-run shows what it",
      "would write. --no-install prints the config snippet rather than writing it.",
      "--repo writes only the committed hook files for runs with no person signed in (Claude Code on",
      "the web, Codex cloud tasks, the GitHub Copilot coding agent, agent steps in GitHub Actions):",
      ".claude/settings.json, .codex/hooks.json and .github/hooks/scopebond.json, with the pinned npx",
      "command and --from-repo. No keys are made here; in the sandbox the hook connects as the",
      "repository with the SCOPEBOND_REPO_TOKEN secret (and SCOPEBOND_URL for a workspace of your own",
      "address). Where there is no token and no Scopebond connection, those entries check nothing.",
      "Needs a terminal, or --yes in a script, because it changes what governs your agent.",
    ] },
  { name: "install", args: "[--claude] [--cursor] [--codex] [--copilot] [--dry-run] [--force] [--yes]",
    summary: "set up once for this user, so every project you open is governed",
    detail: [
      "Scaffolds ~/.scopebond and registers the hook in your user-level agent config",
      "(GitHub Copilot: ~/.copilot/hooks/scopebond.json, or under COPILOT_HOME when set).",
      "--dry-run prints exactly which files it would touch and changes nothing. Each config",
      "is copied to <file>.scopebond-backup before its first modification.",
    ] },
  { name: "rules", args: "[show|enforce|monitor|allow|block|protect|unprotect|protect-branch|unprotect-branch|protect-remote-database|unprotect-remote-database|apply] [value]",
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
  { name: "dedupe", args: "[--claude|--cursor|--codex|--copilot] [--keep user|project|plugin]",
    summary: "keep one Scopebond hook entry when an agent would run it more than once per action",
    detail: [
      "Status and doctor say when the hook sits in the user settings and a project's, twice in one file,",
      "or in an enabled Claude Code plugin beside a settings entry. dedupe keeps the user-level entry",
      "(or the scope you name) and removes the others; other tools' hooks are left alone.",
    ] },
  { name: "capabilities", args: "[--prove [--save] [--copilot]] [--json]",
    summary: "what this hook can honestly claim, per agent host, action and phase",
    detail: [
      "Prints the capability manifest: for Claude Code, Codex, Cursor and GitHub Copilot, each action type and",
      "phase is unsupported, inactive, configured_unverified, degraded or verified_reporting.",
      "Unsupported stays unsupported. A cell is never verified from a local run alone.",
      "--prove runs safe fixtures (allow, deny, signature, action group) in temporary",
      "directories; it does not read or change any agent settings. --save records the result.",
      "--prove --copilot also opens an hour's recording of the tool names GitHub Copilot actually",
      "sends from each surface (CLI, VS Code, cloud agent) on this computer, and lists what it has",
      "seen so far: names, events and argument names only, never their values.",
    ] },
  { name: "policy", args: "load <export.json> [--yes]",
    summary: "check a policy exported from your workspace and make it the active policy here",
    detail: [
      "Without --yes it only checks the export (its policy hash and scope digest, and that the",
      "gateway can load it) and says what loading would replace. With --yes the policy is",
      "written atomically as policy.json, the old one kept as policy.previous.json. If this",
      "machine is enrolled for observations, the load (or the refusal) is then acknowledged to",
      "the workspace, echoing the export's digests exactly. An export carries no signature;",
      "get the file from your workspace.",
    ] },
  { name: "observations", args: "[status [--refused]|flush|retry|wire|unwire|id <kind> <value>]",
    summary: "session, health and action observations sent to your workspace (opt-in)",
    detail: [
      `On only when your workspace enrollment grants ${OBSERVATIONS_SCOPE}; otherwise off, and status says why.`,
      "Local enforcement never depends on it: uploads are best effort and bounded. status shows",
      "what is pending and what the workspace refused (kept locally, never retried). flush",
      "sends now; retry re-checks a workspace that lacked the route; wire and unwire add or",
      "remove the Claude Code session and after-action hook entries.",
    ] },
  { name: "packs", args: "[list|test --all|test <file>|verify <file>|add <file>|remove <id>] [--json] [--yes]",
    summary: "the rule packs on this computer: what is in force, and checking or adding a pack file",
    detail: [
      "Rule packs are signed data from Scopebond Cloud that teach the hook what more command-line tools and MCP servers do.",
      "list shows the packs in force and why any other is not used (bad signature, expired, damaged). Each pack stays in force",
      "for 30 days after this computer last confirmed it; a pack whose update could not be used keeps its last good version on",
      "its own clock, and the others renew as usual. Without one, the open detection and the starter protections apply.",
      "verify <file> checks a pack file (format, signature, its own vectors) and changes nothing.",
      "test --all runs the vectors of every pack in force with this engine (an engine update runs it before use); test <file>",
      "runs one pack file's vectors. Both exit non-zero when a vector fails; --json reports the engine, packs and failures.",
      "add <file> checks it the same way, then puts it in force here; remove <id> takes one out. Both need a terminal or --yes.",
      "Packs live in the packs folder of .scopebond/ (index.json and one <id>@<version>.json per pack).",
    ] },
  { name: "budget", args: "init|ack <id>|status|load <export.json>",
    summary: "per-agent action budgets: how many actions this agent may dispatch in a window",
    detail: [
      "load checks a budget exported from your workspace (digests, environment, validity, fail-closed contract) and, with --yes,",
      "makes it the acknowledged budget here, then acknowledges it to the workspace so its export stops showing as pending.",
      "init writes the suggested 100 actions per 60 seconds, monitor-only (nothing is limited).",
      "Enforcing needs the mode set to enforce and an acknowledgement of the exact policy (ack).",
      "Counters persist across hook processes and restarts. They count dispatched parent actions on",
      "THIS installation only; a limit shared across installations needs a shared in-path gateway,",
      "which an independent hook is not, so it refuses to enforce one.",
    ] },
  { name: "delegation", args: "add <file>|list|revoke <id>|import <file>",
    summary: "delegated child scopes: a child may do no more than its parent and never outlives it",
    detail: [
      "A session runs under one with SCOPEBOND_DELEGATION=<id>. Every action is checked against it,",
      "and against every ancestor, for scope, expiry and revocation. revoke takes effect on the next action.",
      "import adds revoked ids from a file exported from your workspace (add-only).",
    ] },
  { name: "doctor", summary: "check the setup and whether each configured hook command can start",
    detail: ["Exits non-zero when something is wrong, so it works in a script."] },
  { name: "log", args: "[-n N] [--deny] [--since 7d]",
    summary: "the recent decisions",
    detail: [`--deny shows only blocked actions; --since takes 7d, 24h, 30m or a date.`, `e.g. ${cliCommand("log --deny --since 7d")}`] },
  { name: "verify", args: "[--anchor <file-or-url>] [--segments <dir>]", summary: "check every local receipt offline against the countersigning key",
    detail: [
      "No network, no account. Exits non-zero if any receipt fails.",
      "--anchor checks the chain heads this computer kept from its workspace's answers against a published",
      "day of anchors (a file, or an https address); --segments also checks evidence segments downloaded from",
      "the workspace. A chain that went back, or a kept head whose segment is gone, fails.",
    ] },
  { name: "test", args: '"<shell command>"',
    summary: "show the decision for a command without running or recording it",
    detail: [`e.g. ${cliCommand('test "rm -rf /"')}`] },
  { name: "prune", args: "[--compact] [--before 90d] [--yes] [--no-archive]",
    summary: "report the local store's size, or bound it",
    detail: [
      "--compact runs the upkeep now: older rows are rewritten to keep each policy and receipt once,",
      "receipts the workspace acknowledged are removed after its retention window, and the file shrinks.",
      "With no --before it only reports. With one, it archives the receipts it will remove",
      "to a JSONL file beside the database, then removes them. Refuses once the log has been",
      "anchored, because a receipt's position is its anchor leaf index. --no-archive removes without the copy;",
      "an archive stays until you delete it (the report lists them).",
    ] },
  { name: "login", args: "<workspace-url> [--claude|--cursor|--codex|--copilot] [--no-install] [--project] [--yes]",
    summary: "connect this computer to a Scopebond Cloud workspace by approving a short code there",
    detail: [
      "Prints a code and a link; someone who manages the workspace opens it, checks the code",
      "and approves it for an environment and agent. Nothing is copied or pasted.",
      "It sets Scopebond up for you across projects (~/.scopebond and your user-level agent",
      "settings), whatever folder you run it from. --project connects the current folder's",
      "own setup instead. If the folder has a project setup that takes precedence, it says so.",
      "Once approved it names the workspace and who approved it and asks before connecting;",
      "--yes connects without asking (scripts).",
    ] },
  { name: "connect", args: "<workspace-url> <enrollment> [--claude|--cursor|--codex|--copilot]",
    summary: "send receipts to a Scopebond Cloud workspace as well as keeping them locally" },
  { name: "flush", summary: "deliver any receipts still queued for the workspace now, with no time limit" },
  { name: "recover", args: "[--no-wait]", summary: "deliver records an earlier, revoked key signed, once the workspace approves",
    detail: [
      "When this computer was replaced or disconnected while records were still queued, the",
      "workspace refuses them from the new connection. This asks the workspace to accept them,",
      "waits while an owner or admin approves it on Activity, then sends them, labelled Recovered.",
    ] },
  { name: "trust", args: "[--yes]", summary: "let this project's .scopebond policy govern here (pinned by hash)" },
  { name: "uninstall", args: "[--purge] [--yes]", summary: "remove the hook from your agent config; --purge also deletes the home" },
  { name: "claude", summary: "(internal) decide one Claude Code PreToolUse call, JSON on stdin" },
  { name: "cursor", summary: "(internal) decide one Cursor hook event, JSON on stdin" },
  { name: "codex", summary: "(internal) decide one Codex PreToolUse call, JSON on stdin" },
  { name: "copilot", summary: "(internal) decide one GitHub Copilot hook event, JSON on stdin" },
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
  out(`Usage: scopebond-hook <command> [options]`);
  out("");
  out(`  ${cliCommand("init")}            set up this project`);
  out(`  ${cliCommand('test "rm -rf /"')}  see a decision without running it`);
  out(`  ${cliCommand("log --deny")}      what got blocked`);
  out(`  ${cliCommand("rules")}           what blocks and what records, in plain English`);
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

/** Whether this Node can run the receipt store (`node:sqlite`, 22.13+). */
function nodeSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  // A setup command on an older Node would scaffold and wire the agent, then fail on the
  // first action with an error about a missing module. Stop before changing anything, and
  // say what to do. The hook subcommands are left alone: they already fail closed.
  if (["init", "install", "connect", "login"].includes(cmd ?? "") && !nodeSupported()) {
    for (const line of nodeTooOldLines(process.versions.node)) console.error(line);
    process.exit(1);
  }
  if ((cmd === "claude" || cmd === "codex" || cmd === "copilot") && repositoryHookNotGovernedHere(rest)) {
    process.stderr.write("Scopebond: this repository's hook is not connected on this computer; nothing is checked\n");
    process.exit(0);
  }
  if (cmd === "claude") { await runClaude(); }
  else if (cmd === "cursor") { await runCursor(); }
  else if (cmd === "codex") { await runCodex(); }
  else if (cmd === "copilot") { await runCopilot(); }
  else if (cmd === "init") { runInit(rest); }
  else if (cmd === "install") { runInstall(rest); }
  else if (cmd === "connect") { await runConnect(rest); }
  else if (cmd === "log") { await runLog(rest); }
  else if (cmd === "verify") { await runVerify(rest); }
  else if (cmd === "test") { await runTest(rest); }
  else if (cmd === "flush") { await runFlush(); }
  else if (cmd === "recover") { await runRecover(rest); }
  else if (cmd === "status") { runStatus(rest); }
  else if (cmd === "dedupe") { runDedupe(rest); }
  else if (cmd === "doctor") { await runDoctor(); }
  else if (cmd === "capabilities") { await runCapabilities(rest); }
  else if (cmd === "observations") { await runObservations(rest); }
  else if (cmd === "policy") { await runPolicy(rest); }
  else if (cmd === "budget" && rest[0] === "load") { await runBudgetLoad(rest.slice(1)); }
  else if (cmd === "budget" || cmd === "delegation") {
    // These change what the agent may do, so they are for a person at a terminal.
    if (rest[0] !== "status" && rest[0] !== "list") requireInteractive(cmd, rest);
    const dir = resolveConfigDir(process.cwd());
    const kid = (() => { try { return createSigner({ privateKeyPem: readFileSync(join(dir, "agent.key"), "utf8") }).kid; } catch { return ""; } })();
    process.exit(runDispatchCommand(cmd, rest, dir, kid));
  }
  else if (cmd === "uninstall") { await runUninstall(rest); }
  else if (cmd === "login") { await runLogin(rest); }
  else if (cmd === "trust") { runTrust(rest); }
  else if (cmd === "prune") { await runPrune(rest); }
  else if (cmd === "rules") { await runRules(rest); }
  else if (cmd === "packs") { runPacks(rest); }
  else if (cmd === "help" || cmd === "--help" || cmd === "-h" || cmd === undefined) { printHelp(rest[0]); }
  else {
    console.error(`unknown command: ${cmd}`);
    printHelp(undefined, true);
    process.exit(1);
  }
}
