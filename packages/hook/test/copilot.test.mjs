// GitHub Copilot as a coding agent: the hook file `install`/`init` write, the decision Copilot reads on stdout, the
// always-on protection of Copilot's own hook settings, and the honest label (cooperative: a Copilot hook timeout fails
// open). Runs the real dist/cli.js with HOME/USERPROFILE/SCOPEBOND_HOME/COPILOT_HOME in temp dirs; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  scaffold, mapCopilotToolUse, classifyIntent, defaultRules, computeManifest, renderManifest, writeHarnessConfig, upgradeStarterPolicy, compile,
  removeHarnessConfig, isHarnessConfigured, configuredHookCommands, isScopebondHookCommand, copilotHookEntry,
  COPILOT_EVENTS, COPILOT_TIMEOUT_SEC, COPILOT_DECISION_DEADLINE_MS,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";
import { GUARDRAIL_WRITE_PATTERN, under, named } from "../dist/runtime.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const LABEL = "cooperative · prevents if honored · a hook timeout fails open in Copilot";

function isolated(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "sb-copilot-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SCOPEBOND_|CLAUDE_|COPILOT_)/.test(k)) delete env[k];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    SCOPEBOND_HOME: join(home, ".scopebond"), SCOPEBOND_HOOK_FLUSH_MS: "300", ...extra,
  });
  const project = join(root, "proj");
  mkdirSync(join(project, "src"), { recursive: true });
  return { root, home, env, project };
}

function run(env, args, { cwd, input } = {}) {
  const r = spawnSync(process.execPath, [cli, ...args], { env, cwd, input, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

/** A governed user home (enforce or the default monitor rules), and a `copilot` runner for PreToolUse payloads. */
function governed(mode) {
  const ctx = isolated();
  const dir = join(ctx.home, ".scopebond");
  scaffold(dir, mode === "enforce" ? ENFORCE : {});
  const decide = (tool_name, tool_input, extra = {}) => {
    const payload = { hook_event_name: "PreToolUse", session_id: "s-copilot", timestamp: new Date().toISOString(), cwd: ctx.project, tool_name, tool_input, ...extra };
    return run(ctx.env, ["copilot"], { cwd: ctx.project, input: JSON.stringify(payload) });
  };
  return { ...ctx, dir, decide };
}

function receipts(dir) {
  const file = join(dir, "receipts.db");
  if (!existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare("SELECT realtime_result, receipt_json FROM receipts ORDER BY id").all().map((r) => ({ result: r.realtime_result, payload: JSON.parse(r.receipt_json).payload })); }
  finally { db.close(); }
}

function assertCopilotFile(file) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.version, 1);
  assert.deepEqual(Object.keys(doc.hooks).sort(), [...COPILOT_EVENTS].sort());
  for (const event of COPILOT_EVENTS) {
    assert.equal(doc.hooks[event].length, 1, `one Scopebond entry for ${event}`);
    const entry = doc.hooks[event][0];
    assert.equal(entry.type, "command");
    assert.equal(entry.timeoutSec, COPILOT_TIMEOUT_SEC);
    assert.equal(entry.matcher, undefined, "no matcher: every tool");
    assert.match(entry.bash, /\scopilot$/, `bash runs the copilot subcommand: ${entry.bash}`);
    assert.match(entry.powershell, /\scopilot$/);
    assert.ok(isScopebondHookCommand(entry.bash) && isScopebondHookCommand(entry.powershell));
  }
  return doc;
}

test("install --copilot writes ~/.copilot/hooks/scopebond.json, and uninstall removes the file", () => {
  const { env, home } = isolated();
  const install = run(env, ["install", "--copilot"]);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const file = join(home, ".copilot", "hooks", "scopebond.json");
  assertCopilotFile(file);
  assert.match(install.stdout, /GitHub Copilot configured/);
  assert.match(install.stdout, new RegExp(LABEL));
  assert.doesNotMatch(install.stdout, /in-path|in the path/i);
  const status = run(env, ["status"]);
  assert.match(status.stdout, /GitHub Copilot\s+configured \(user-level\)/);
  assert.match(status.stdout, new RegExp(LABEL));
  const uninstall = run(env, ["uninstall", "--yes"]);
  assert.equal(uninstall.status, 0, uninstall.stdout);
  assert.equal(existsSync(file), false, "Scopebond's own file goes once nothing else is in it");
});

test("install --copilot respects COPILOT_HOME", () => {
  const ctx = isolated();
  const copilotHome = join(ctx.root, "copilot-home");
  const env = { ...ctx.env, COPILOT_HOME: copilotHome };
  const install = run(env, ["install", "--copilot"]);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assertCopilotFile(join(copilotHome, "hooks", "scopebond.json"));
  assert.equal(existsSync(join(ctx.home, ".copilot", "hooks", "scopebond.json")), false);
});

test("install with no flag adds Copilot when its user folder exists", () => {
  const { env, home } = isolated();
  mkdirSync(join(home, ".copilot"), { recursive: true });
  const install = run(env, ["install"]);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  assert.ok(existsSync(join(home, ".copilot", "hooks", "scopebond.json")), "detected and configured");
});

test("init --copilot writes .github/hooks/scopebond.json in the project; uninstall removes it", () => {
  const { env, project } = isolated();
  const init = run(env, ["init", "--copilot", "--yes"], { cwd: project });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const file = join(project, ".github", "hooks", "scopebond.json");
  assertCopilotFile(file);
  const shared = run(env, ["init", "--copilot", "--shared", "--yes", "--force"], { cwd: project });
  assert.equal(shared.status, 0, shared.stdout + shared.stderr);
  const doc = assertCopilotFile(file);
  assert.match(doc.hooks.PreToolUse[0].bash, /^npx -y @scopebond\/hook@\S+ copilot$/, "--shared writes the portable form");
  assert.match(doc.hooks.PreToolUse[0].powershell, /^npx\.cmd -y @scopebond\/hook@\S+ copilot$/);
  const uninstall = run(env, ["uninstall", "--yes"], { cwd: project });
  assert.equal(uninstall.status, 0, uninstall.stdout);
  assert.equal(existsSync(file), false);
});

test("uninstall keeps other hooks in a shared Copilot file and removes only Scopebond's", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-copilot-file-"));
  const file = join(dir, ".github", "hooks", "scopebond.json");
  mkdirSync(join(dir, ".github", "hooks"), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, hooks: { PreToolUse: [{ type: "command", bash: "./audit.sh" }] } }));
  writeHarnessConfig(file, "copilot", `"${process.execPath}" "/opt/x/@scopebond/hook/dist/cli.js" claude`);
  assert.equal(isHarnessConfigured(file), true);
  const doc = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(doc.hooks.PreToolUse.length, 2, "added beside the person's own hook");
  assert.match(doc.hooks.PreToolUse[1].bash, /\scopilot$/, "the subcommand is copilot");
  assert.match(doc.hooks.PreToolUse[1].powershell, /^& "/, "PowerShell runs the quoted program with the call operator");
  // Writing again replaces, never duplicates.
  writeHarnessConfig(file, "copilot", `"${process.execPath}" "/opt/x/@scopebond/hook/dist/cli.js" copilot`);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).hooks.PreToolUse.length, 2);
  assert.equal(configuredHookCommands(file).length, COPILOT_EVENTS.length, "one command per event, read from bash");
  removeHarnessConfig(file);
  const after = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(after.hooks.PreToolUse, [{ type: "command", bash: "./audit.sh" }], "the person's hook is kept");
  assert.equal(isHarnessConfigured(file), false);
});

test("the hook's own deadline is inside the timeoutSec it installs (a Copilot timeout fails open)", () => {
  assert.ok(COPILOT_DECISION_DEADLINE_MS < COPILOT_TIMEOUT_SEC * 1000 - 5_000, "a margin for Node's start and the answer");
  assert.equal(copilotHookEntry("x copilot").timeoutSec, COPILOT_TIMEOUT_SEC);
  // A check that runs past the deadline answers deny, not a timeout.
  const { env, project, dir } = governed("default");
  void dir;
  const r = run({ ...env, SCOPEBOND_COPILOT_DEADLINE_MS: "1" }, ["copilot"], {
    cwd: project, input: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", cwd: project, tool_name: "Bash", tool_input: { command: "ls" } }),
  });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).permissionDecision, "deny");
  assert.match(JSON.parse(r.stdout).permissionDecisionReason, /did not finish/);
});

test("a force push to a protected branch is denied with permissionDecision deny and a reason", () => {
  const g = governed("enforce");
  const r = g.decide("Bash", { command: "git push --force origin main" });
  assert.equal(r.status, 2, "exit 2 denies whatever stdout says");
  const out = JSON.parse(r.stdout);
  assert.equal(out.permissionDecision, "deny");
  assert.ok(out.permissionDecisionReason && /protect-branches/.test(out.permissionDecisionReason), out.permissionDecisionReason);
  // The camelCase payload (runtime tool names, arguments as a JSON string) is read the same way.
  const camel = run(g.env, ["copilot"], { cwd: g.project, input: JSON.stringify({ sessionId: "s2", cwd: g.project, toolName: "bash", toolArgs: JSON.stringify({ command: "git push --force origin main" }) }) });
  assert.equal(camel.status, 2);
  assert.equal(JSON.parse(camel.stdout).permissionDecision, "deny");
});

test("a routine read is allowed silently, so Copilot's own permission flow stays in charge", () => {
  const g = governed("enforce");
  writeFileSync(join(g.project, "src", "a.ts"), "x");
  const r = g.decide("Read", { path: join(g.project, "src", "a.ts") });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "no opinion on an allowed action");
  const read = receipts(g.dir).find((x) => x.payload.intent?.action_type === "file.read");
  assert.ok(read, "the read is recorded");
  assert.equal(read.result, "allow");
});

test("an unknown tool is recorded as not evaluated", () => {
  const mapped = mapCopilotToolUse({ tool_name: "some_future_tool", tool_input: { x: 1 }, cwd: "/w" });
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].intent.action_type, "tool.some_future_tool");
  assert.equal(mapped[0].evaluated, false);
  const g = governed("enforce");
  const r = g.decide("some_future_tool", { x: 1 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const rec = receipts(g.dir).find((x) => x.payload.intent?.action_type === "tool.some_future_tool");
  assert.ok(rec, "recorded");
  assert.equal(rec.payload.execution?.state, "observed_not_evaluated");
});

test("Copilot's tool names map to the Claude Code tool families", () => {
  const at = (name, input) => mapCopilotToolUse({ tool_name: name, tool_input: input, cwd: "/w" }).map((m) => `${m.intent.action_type} ${m.intent.params.host ?? m.intent.params.path ?? m.intent.params.program ?? ""}`.trim());
  assert.deepEqual(at("view", { path: "/w/src/a.ts" }), ["file.read src/a.ts"]);
  assert.deepEqual(at("create", { path: "/w/src/b.ts", file_text: "x" }), ["file.write src/b.ts"]);
  assert.deepEqual(at("edit", { path: "/w/src/b.ts", old_str: "a", new_str: "b" }), ["file.write src/b.ts"]);
  assert.deepEqual(at("str_replace_editor", { command: "view", path: "/w/src/b.ts" }), ["file.read src/b.ts"]);
  assert.deepEqual(at("apply_patch", { input: "*** Begin Patch\n*** Update File: src/c.ts\n*** End Patch" }), ["file.write src/c.ts"]);
  assert.deepEqual(at("bash", { command: "ls -la" }), ["shell.exec ls"]);
  assert.deepEqual(at("web_fetch", { url: "https://example.test/x" }), ["net.fetch example.test"]);
  assert.deepEqual(at("Write", { file_path: "/w/src/d.ts" }), ["file.write src/d.ts"]);
  assert.deepEqual(at("mcp__docs__search", { q: "x" }).map((s) => s.split(" ")[0]), ["mcp.tool.call"]);
});

test("Copilot's hook settings are guardrail configuration (C02, always on), not CI configuration", () => {
  const rules = defaultRules();
  for (const path of [".github/hooks/scopebond.json", ".github/hooks/other.json", ".github/copilot/settings.json", ".github/copilot/settings.local.json", "~/.copilot/hooks/scopebond.json", "~/.copilot/settings.json"]) {
    const c = classifyIntent({ action_type: "file.write", params: { path } }, rules);
    assert.deepEqual(c.ids, ["C02"], `${path}: ${c.ids}`);
  }
  // Always on: blocked even under the default rules, which only record.
  const g = governed("default");
  for (const [tool, input] of [
    ["Write", { file_path: join(g.project, ".github", "hooks", "scopebond.json"), content: "{}" }],
    ["Edit", { file_path: join(g.home, ".copilot", "hooks", "scopebond.json"), old_string: "a", new_string: "b" }],
    ["Write", { file_path: join(g.project, ".github", "copilot", "settings.local.json"), content: "{}" }],
    ["Bash", { command: "rm -rf .github/hooks" }],
  ]) {
    const r = g.decide(tool, input);
    assert.equal(r.status, 2, `${tool} ${JSON.stringify(input)}: ${r.stdout}`);
    assert.equal(JSON.parse(r.stdout).permissionDecision, "deny");
  }
  // An ordinary workflow edit stays a CI-config write (H03), which the default rules only record.
  const ci = classifyIntent({ action_type: "file.write", params: { path: ".github/workflows/ci.yml" } }, rules);
  assert.deepEqual(ci.ids, ["H03"]);
});

test("a policy written before Copilot was covered gets Copilot's hook settings on load", () => {
  const copilotPart = under("\\.copilot/hooks") + named("\\.copilot/settings\\.json") + under("\\.github/hooks")
    + named("\\.github/copilot/settings\\.json") + named("\\.github/copilot/settings\\.local\\.json");
  assert.ok(GUARDRAIL_WRITE_PATTERN.includes(copilotPart), "the always-on floor covers them");
  const before = GUARDRAIL_WRITE_PATTERN.replace(copilotPart, "");
  const policy = compile(defaultRules(), "kid");
  const floor = policy.clauses.find((c) => c.id === "protect-scopebond-write");
  floor.param_bounds.path.pattern = before;
  const write = policy.clauses.find((c) => c.id === "protect-write");
  write.param_bounds.path.pattern = write.param_bounds.path.pattern.replace(copilotPart, "");
  const upgraded = upgradeStarterPolicy(policy);
  assert.equal(upgraded.clauses.find((c) => c.id === "protect-scopebond-write").param_bounds.path.pattern, GUARDRAIL_WRITE_PATTERN);
  assert.equal(upgraded.clauses.find((c) => c.id === "protect-write").param_bounds.path.pattern, compile(defaultRules(), "kid").clauses.find((c) => c.id === "protect-write").param_bounds.path.pattern);
});

test("session and after-action events never print a decision", () => {
  const g = governed("default");
  for (const event of ["SessionStart", "PostToolUse", "SessionEnd"]) {
    const r = run(g.env, ["copilot"], { cwd: g.project, input: JSON.stringify({ hook_event_name: event, session_id: "s", cwd: g.project, tool_name: "Bash", tool_input: { command: "ls" }, reason: "complete" }) });
    assert.equal(r.status, 0, `${event}: ${r.stderr}`);
    assert.equal(r.stdout, "");
  }
});

test("malformed input fails closed", () => {
  const g = governed("default");
  const r = run(g.env, ["copilot"], { cwd: g.project, input: "not json" });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).permissionDecision, "deny");
});

test("the capability manifest labels every Copilot host cooperative, never in-path", () => {
  const manifest = computeManifest({ adapterVersion: "test", configured: { claude: false, codex: false, cursor: false, copilot: true } });
  const cells = manifest.cells.filter((c) => c.host_variant.startsWith("copilot_"));
  assert.deepEqual([...new Set(cells.map((c) => c.host_variant))].sort(), ["copilot_cli", "copilot_cloud", "copilot_vscode"]);
  for (const cell of cells) {
    assert.ok(cell.enforcement?.startsWith(LABEL), `${cell.key}: ${cell.enforcement}`);
    assert.doesNotMatch(JSON.stringify(cell), /in-path|in_path/i);
  }
  assert.match(cells.find((c) => c.host_variant === "copilot_cloud").enforcement, /ask is treated as deny/);
  const shell = cells.find((c) => c.host_variant === "copilot_cli" && c.action_type === "shell.exec");
  assert.equal(shell.state, "configured_unverified", "never verified from a local run");
  assert.equal(cells.find((c) => c.action_type === "mcp.tool.call").state, "unsupported", "MCP naming is not documented, so not claimed");
  const text = renderManifest(manifest);
  assert.match(text, new RegExp(`copilot_cli\\n  enforcement: ${LABEL}`));
  // Other hosts carry no such label.
  assert.ok(manifest.cells.filter((c) => !c.host_variant.startsWith("copilot_")).every((c) => c.enforcement === undefined));
});
