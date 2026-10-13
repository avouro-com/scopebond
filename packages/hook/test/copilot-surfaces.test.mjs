// GitHub Copilot beyond the CLI: VS Code agent mode (its Copilot session target on the Agent Host, and its Local harness)
// and the Copilot cloud coding agent. Runs the real dist/cli.js with HOME/USERPROFILE/SCOPEBOND_HOME/COPILOT_HOME in temp
// dirs; no network.
//
// The fixture payloads are copied from the published references, read 2026-10-13:
//   GitHub  https://docs.github.com/en/copilot/reference/hooks-reference
//           ("Hook event input payloads": the VS Code compatible format, selected by the PascalCase event names;
//            "Cloud agent execution environment"; "preToolUse decision control"; "Tool names for hook matching")
//   VS Code https://code.visualstudio.com/docs/agent-customization/hooks (session targets: Copilot on the Agent Host uses
//            the Copilot CLI's implementation; Local runs in the extension host)
//           https://code.visualstudio.com/docs/agents/reference/hooks-reference (Local: common input, `tool_use_id`,
//            `hookSpecificOutput`, exit code 2)
// Neither reference publishes the Local harness's tool names ("Open the agent debug logs to inspect the Local tool
// schema"), so the Local fixtures use a placeholder name and assert that an unknown name is never allowed by default.
// None of this is verified on a live install; `capabilities --prove --copilot` is how a person records the real names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scaffold, copilotAnswer, copilotCloudAgent, copilotSurface, surfaceSignals, openCopilotProbe, readCopilotProbe, recordCopilotProbe,
  renderCopilotProbe, mapCopilotToolUse, COPILOT_EVENTS, COPILOT_PROBE_FILE, COPILOT_CLOUD_ASK_IS_DENY, DOCUMENTED_COPILOT_TOOL_NAMES,
} from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function isolated(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "sb-copilot-surf-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SCOPEBOND_|CLAUDE_|COPILOT_|GITHUB_|VSCODE_)/.test(k) || k === "TERM_PROGRAM") delete env[k];
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

function governed(mode, extra = {}) {
  const ctx = isolated(extra);
  const dir = join(ctx.home, ".scopebond");
  scaffold(dir, mode === "enforce" ? ENFORCE : {});
  return { ...ctx, dir, hook: (payload, env = ctx.env) => run(env, ["copilot"], { cwd: ctx.project, input: JSON.stringify(payload) }) };
}

// --- Fixture payloads (shapes as published) ---------------------------------------------------------------------------

/** GitHub: PreToolUse, VS Code compatible format (what the Copilot CLI, VS Code's Copilot session target and the cloud agent
 *  send when the event is registered as `PreToolUse`). `tool_name` is the Claude tool name (`Bash`, not `bash`). */
const ghPreToolUse = (cwd, tool_name, tool_input) => ({
  hook_event_name: "PreToolUse", session_id: "sess-gh-1", timestamp: "2026-10-13T09:00:00.000Z", cwd, tool_name, tool_input,
});
/** GitHub: agentStop / Stop, VS Code compatible format. */
const ghStop = (cwd) => ({
  hook_event_name: "Stop", session_id: "sess-gh-1", timestamp: "2026-10-13T09:01:00.000Z", cwd,
  transcript_path: join(cwd, "transcript.jsonl"), stop_reason: "end_turn", stop_hook_active: false,
});
/** VS Code Local: PreToolUse = common input (timestamp, cwd, session_id, hook_event_name, transcript_path) + tool_name,
 *  tool_input, tool_use_id. The Local tool names are not published; `<local-tool-name>` is the reference's placeholder. */
const localPreToolUse = (cwd, tool_name, tool_input) => ({
  timestamp: "2026-10-13T09:02:00.000Z", cwd, session_id: "sess-local-1", hook_event_name: "PreToolUse",
  transcript_path: join(cwd, "t.json"), tool_name, tool_input, tool_use_id: "tool-123",
});
const localSessionStart = (cwd) => ({ timestamp: "2026-10-13T09:00:00.000Z", cwd, session_id: "sess-local-1", hook_event_name: "SessionStart", source: "new" });
const localStop = (cwd) => ({ timestamp: "2026-10-13T09:03:00.000Z", cwd, session_id: "sess-local-1", hook_event_name: "Stop", stop_hook_active: false });

// --- Wiring -----------------------------------------------------------------------------------------------------------

test("the hook file registers SessionStart, PreToolUse, PostToolUse and Stop (VS Code's events) with PascalCase names", () => {
  for (const event of ["SessionStart", "PreToolUse", "PostToolUse", "Stop"]) assert.ok(COPILOT_EVENTS.includes(event), event);
  for (const event of COPILOT_EVENTS) assert.match(event, /^[A-Z]/, "PascalCase selects the VS Code compatible payload");
});

test("the repository file the cloud agent loads has a bash command on every entry, and no exec", () => {
  const { env, project } = isolated();
  const init = run(env, ["init", "--copilot", "--shared", "--yes"], { cwd: project });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const doc = JSON.parse(readFileSync(join(project, ".github", "hooks", "scopebond.json"), "utf8"));
  assert.equal(doc.version, 1);
  for (const event of COPILOT_EVENTS) {
    for (const entry of doc.hooks[event]) {
      assert.equal(entry.type, "command");
      assert.match(entry.bash, /^npx -y @scopebond\/hook@\S+ copilot$/, "the cloud agent honors only bash (or command)");
      assert.equal(entry.exec, undefined, "exec is CLI-only");
    }
  }
});

test("user-level ~/.copilot/hooks/ is what VS Code's Local harness reads too: install --copilot writes it", () => {
  const { env, home } = isolated();
  const install = run(env, ["install", "--copilot"]);
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const doc = JSON.parse(readFileSync(join(home, ".copilot", "hooks", "scopebond.json"), "utf8"));
  assert.ok(doc.hooks.Stop?.length === 1, "Stop registered");
});

// --- Copilot CLI / VS Code's Copilot session target (published payloads) -----------------------------------------------

test("a published-shape PreToolUse force push is denied in both answer shapes, with exit 2", () => {
  const g = governed("enforce");
  const r = g.hook(ghPreToolUse(g.project, "Bash", { command: "git push --force origin main" }));
  assert.equal(r.status, 2, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /protect-branches/);
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: out.permissionDecisionReason });
  assert.match(r.stderr, /^Scopebond/, "the Local harness gives stderr to the model on exit 2");
});

test("a published-shape Stop prints nothing and exits 0: never blocks, never forces another turn", () => {
  const g = governed("enforce");
  for (const payload of [ghStop(g.project), localStop(g.project), localSessionStart(g.project)]) {
    const r = g.hook(payload);
    assert.equal(r.status, 0, `${payload.hook_event_name}: ${r.stderr}`);
    assert.equal(r.stdout, "", payload.hook_event_name);
  }
});

// --- VS Code Local harness ---------------------------------------------------------------------------------------------

test("a Local tool name nobody has published is recorded as tool.<name> and never allowed by Scopebond", () => {
  const mapped = mapCopilotToolUse(localPreToolUse("/w", "localToolName", { anything: 1 }));
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].intent.action_type, "tool.localtoolname");
  assert.equal(mapped[0].evaluated, false);
  const g = governed("enforce");
  const r = g.hook(localPreToolUse(g.project, "localToolName", { anything: 1 }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "no permissionDecision allow: the surface's own approval flow stays in charge");
  // Strict mode denies an unmapped tool, in the shape the Local harness reads.
  const strict = g.hook(localPreToolUse(g.project, "localToolName", { anything: 1 }), { ...g.env, SCOPEBOND_HOOK_STRICT: "1" });
  assert.equal(strict.status, 2, strict.stdout);
  assert.equal(JSON.parse(strict.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("a Local call that writes Copilot's own hook settings is denied (always on)", () => {
  const g = governed("default");
  const r = g.hook(localPreToolUse(g.project, "Write", { file_path: join(g.project, ".github", "hooks", "scopebond.json"), content: "{}" }));
  assert.equal(r.status, 2, r.stdout);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
});

// --- Surfaces and the cloud agent ----------------------------------------------------------------------------------------

test("cloud-agent detection: no user-level install plus the sandbox's variables (or a GitHub Actions run)", () => {
  assert.equal(copilotCloudAgent({ COPILOT_AGENT_PROMPT: "fix the bug" }, false), true);
  assert.equal(copilotCloudAgent({ GITHUB_COPILOT_API_TOKEN: "x" }, false), true);
  assert.equal(copilotCloudAgent({ GITHUB_ACTIONS: "true" }, false), true, "a CI run has no one to ask either");
  assert.equal(copilotCloudAgent({}, false), false);
  assert.equal(copilotCloudAgent({ GITHUB_ACTIONS: "false" }, false), false);
  // A person's computer (the user-level hook file exists) is never the cloud agent, whatever the environment says.
  assert.equal(copilotCloudAgent({ COPILOT_AGENT_PROMPT: "x", GITHUB_ACTIONS: "true" }, true), false);
});

test("which surface sent a call: the cloud agent, VS Code's Local harness (tool_use_id), or the CLI", () => {
  assert.equal(copilotSurface(ghPreToolUse("/w", "Bash", {}), { COPILOT_AGENT_PROMPT: "x" }, false), "cloud_agent");
  assert.equal(copilotSurface(localPreToolUse("/w", "x", {}), {}, true), "vscode_local");
  assert.equal(copilotSurface(ghPreToolUse("/w", "Bash", {}), { TERM_PROGRAM: "vscode" }, true), "cli", "the Copilot session target sends the CLI's payload");
  const signals = surfaceSignals(localPreToolUse("/w", "x", {}), { VSCODE_PID: "1", GITHUB_COPILOT_API_TOKEN: "secret-value" });
  assert.deepEqual(signals, ["pascal_case_payload", "tool_use_id", "GITHUB_COPILOT_API_TOKEN", "vscode_environment"]);
  assert.ok(!signals.join(" ").includes("secret-value"), "names only, never a value");
  assert.ok(surfaceSignals({ toolName: "bash", sessionId: "s" }, {}).includes("camel_case_payload"));
});

test("ask: the CLI and VS Code are asked; the cloud agent is denied with the reason spelled out", () => {
  const ask = copilotAnswer("ask", "Scopebond: a workspace rule blocks this.", false);
  assert.equal(ask.exitCode, 0);
  const a = JSON.parse(ask.stdout);
  assert.equal(a.permissionDecision, "ask");
  assert.equal(a.hookSpecificOutput.permissionDecision, "ask");
  const cloud = copilotAnswer("ask", "Scopebond: a workspace rule blocks this.", true);
  assert.equal(cloud.exitCode, 2, "a deny, not an ask the cloud agent would read as a bare refusal");
  const c = JSON.parse(cloud.stdout);
  assert.equal(c.permissionDecision, "deny");
  assert.equal(c.permissionDecisionReason, `Scopebond: ${COPILOT_CLOUD_ASK_IS_DENY}. a workspace rule blocks this.`);
  assert.equal(c.hookSpecificOutput.permissionDecision, "deny");
  assert.match(cloud.stderr, /no one to ask/);
  const deny = copilotAnswer("deny", "blocked", true);
  assert.equal(deny.exitCode, 2);
  assert.equal(JSON.parse(deny.stdout).permissionDecisionReason, "blocked");
  assert.equal(deny.stderr, "Scopebond: blocked\n");
});

test("in a cloud-agent sandbox with no Scopebond setup, every action is still denied (never allowed)", () => {
  const { env, project } = isolated({ COPILOT_AGENT_PROMPT: "add a feature", GITHUB_COPILOT_API_TOKEN: "x" });
  const r = run(env, ["copilot"], { cwd: project, input: JSON.stringify(ghPreToolUse(project, "Bash", { command: "ls" })) });
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).permissionDecision, "deny");
  assert.match(JSON.parse(r.stdout).permissionDecisionReason, /not set up in this environment/);
});

// --- Recording the tool names a real install sends ----------------------------------------------------------------------

test("the tool-name record keeps names, events and argument names, never values, and only while a window is open", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-copilot-probe-"));
  const call = (payload, surface) => {
    const mapped = mapCopilotToolUse(payload);
    recordCopilotProbe(dir, { payload, surface, signals: surfaceSignals(payload, {}), mapped_as: [...new Set(mapped.map((m) => m.intent.action_type))], evaluated: mapped.every((m) => m.evaluated) });
  };
  call(ghPreToolUse("/w", "Bash", { command: "echo do-not-keep-this" }), "cli");
  assert.equal(existsSync(join(dir, COPILOT_PROBE_FILE)), false, "no window: nothing written");
  openCopilotProbe(dir);
  call(ghPreToolUse("/w", "Bash", { command: "echo do-not-keep-this" }), "cli");
  call(ghPreToolUse("/w", "Bash", { command: "ls" }), "cli");
  call(localPreToolUse("/w", "localToolName", { secretArg: "do-not-keep-this-either" }), "vscode_local");
  const text = readFileSync(join(dir, COPILOT_PROBE_FILE), "utf8");
  assert.ok(!text.includes("do-not-keep-this"), "argument values are never written");
  const probe = readCopilotProbe(dir);
  const bash = probe.entries.find((e) => e.tool_name === "Bash");
  assert.equal(bash.count, 2);
  assert.deepEqual(bash.input_keys, ["command"]);
  assert.deepEqual(bash.mapped_as, ["shell.exec"]);
  const local = probe.entries.find((e) => e.surface === "vscode_local");
  assert.deepEqual(local.mapped_as, ["tool.localtoolname"]);
  assert.equal(local.evaluated, false);
  const rendered = renderCopilotProbe(probe, "x.json");
  assert.match(rendered, /VS Code Local harness/);
  assert.match(rendered, /localToolName.*recorded, not evaluated.*not in GitHub's documented names/);
  assert.ok(DOCUMENTED_COPILOT_TOOL_NAMES.includes("Bash"));
  // A closed window records nothing more.
  writeFileSync(join(dir, COPILOT_PROBE_FILE), JSON.stringify({ ...probe, until: "2000-01-01T00:00:00.000Z" }));
  call(ghPreToolUse("/w", "Read", { file_path: "/w/a" }), "cli");
  assert.equal(readCopilotProbe(dir).entries.some((e) => e.tool_name === "Read"), false);
});

test("capabilities --prove --copilot opens the recording, and the hook then records what each surface sends", () => {
  const g = governed("default");
  const first = run(g.env, ["capabilities", "--prove", "--copilot"], { cwd: g.project });
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /Recording is now open for an hour/);
  assert.match(first.stdout, /Copilot session target and with the Local/);
  assert.ok(existsSync(join(g.dir, COPILOT_PROBE_FILE)));
  // The surfaces send calls (here: the published CLI shape and a Local-shaped call).
  assert.equal(g.hook(ghPreToolUse(g.project, "Bash", { command: "git status" })).status, 0);
  assert.equal(g.hook(localPreToolUse(g.project, "localToolName", { x: 1 })).status, 0);
  const again = run(g.env, ["capabilities", "--prove", "--copilot"], { cwd: g.project });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Recording extended by an hour/);
  assert.match(again.stdout, /Copilot CLI \(or VS Code's Copilot session target\)\n\s+PreToolUse\s+Bash\s+1x\s+-> shell\.exec/);
  assert.match(again.stdout, /VS Code Local harness\n\s+PreToolUse\s+localToolName/);
  // --json keeps stdout one JSON document.
  const json = run(g.env, ["capabilities", "--prove", "--copilot", "--json"], { cwd: g.project });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).connector, "scopebond-hook");
  assert.match(json.stderr, /GitHub Copilot tool names seen/);
  // Without a setup it says what to run instead of writing anything.
  const bare = isolated();
  const none = run(bare.env, ["capabilities", "--prove", "--copilot"], { cwd: bare.project });
  assert.match(none.stdout, /no Scopebond setup in .* to record Copilot's tool names into/);
  assert.equal(existsSync(join(bare.home, ".scopebond", COPILOT_PROBE_FILE)), false);
});
