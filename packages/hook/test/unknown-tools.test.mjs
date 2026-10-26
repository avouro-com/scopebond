// A host tool Scopebond has no mapping for is never let through unchecked. A tool known to be harmless (it only reads, or
// only drives the agent's own task list, plan or question to the person) is recorded as before; any other name is refused,
// or asked about where the host can ask, in every mode, with a reason naming the tool and how to allow it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mapClaudeToolUse, mapCodexToolUse, mapCopilotToolUse, mapCursorEvent, createHookRuntime, scaffold, compile } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function setup(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "sb-unknown-tool-"));
  const made = scaffold(dir, opts.enforce ? ENFORCE : {});
  return { dir, ...made };
}

function runtime(dir, extra = {}) {
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: dir, ...extra,
  });
}

const MAPPERS = {
  claude: (tool_name, tool_input, cwd) => mapClaudeToolUse({ tool_name, tool_input, cwd }),
  codex: (tool_name, tool_input, cwd) => mapCodexToolUse({ tool_name, tool_input, cwd }),
  copilot: (tool_name, tool_input, cwd) => mapCopilotToolUse({ tool_name, tool_input, cwd }),
  cursor: (event, payload, cwd) => mapCursorEvent(event, { ...payload, cwd }),
};

// Per harness: a known-safe tool, a made-up one, and a mapped call that is allowed as before.
const CASES = [
  { harness: "claude", safe: ["TodoWrite", { todos: [] }], mapped: ["Read", { file_path: "src/a.ts" }] },
  { harness: "claude", safe: ["AskUserQuestion", { questions: [] }], mapped: ["Glob", { pattern: "**/*.ts" }] },
  { harness: "codex", safe: ["update_plan", { plan: [] }], mapped: ["Bash", { command: "ls -la" }] },
  { harness: "copilot", safe: ["read_bash", { sessionId: "1" }], mapped: ["view", { path: "src/a.ts" }] },
  { harness: "copilot", safe: ["task", { prompt: "look around" }], mapped: ["bash", { command: "ls -la" }] },
  { harness: "cursor", safe: null, mapped: ["beforeReadFile", { path: "src/a.ts" }] },
];

for (const mode of ["monitor", "enforce"]) {
  for (const c of CASES) {
    const { harness, safe, mapped } = c;
    const map = MAPPERS[harness];
    const made = harness === "cursor" ? "brandNewEvent" : "BrandNewTool";

    test(`${harness} (${mode}, case ${CASES.indexOf(c) + 1}): a made-up tool is refused with its name and how to allow it`, async () => {
      const { dir } = setup({ enforce: mode === "enforce" });
      const actions = map(made, { anything: 1 }, dir);
      assert.equal(actions.length, 1);
      assert.equal(actions[0].intent.action_type, `tool.${made.toLowerCase()}`);
      assert.equal(actions[0].evaluated, false);
      const d = await runtime(dir).evaluate(actions);
      assert.equal(d.decision, "deny", "an unknown tool is never let through unchecked");
      assert.equal(d.code, "unknown_tool");
      assert.ok(d.reason.includes(`the tool "${made}"`), d.reason);
      assert.ok(d.reason.includes(`add "tool.${made.toLowerCase()}" to "observe" in ${join(dir, "rules.json")}, then run \``), d.reason);
      assert.match(d.reason, /rules apply`/);
      assert.match(d.reason, /What to do: It stays blocked/);
      assert.equal(d.receipt.payload.realtime_result, "deny", "the refusal is recorded as a denied receipt");
    });

    test(`${harness} (${mode}, case ${CASES.indexOf(c) + 1}): a made-up tool is asked about where the host can ask`, async () => {
      const { dir } = setup({ enforce: mode === "enforce" });
      const d = await runtime(dir, { installAsk: "ask" }).evaluate(map(made, {}, dir));
      assert.equal(d.decision, "ask");
      assert.equal(d.code, "unknown_tool");
      assert.ok(d.reason.includes(`Scopebond does not know the tool "${made}"`), d.reason);
      assert.match(d.reason, /Allow it only if you trust it/);
      assert.match(d.reason, /"observe"/);
    });

    if (safe) {
      test(`${harness} (${mode}): the known-safe tool ${safe[0]} is recorded as before`, async () => {
        const { dir } = setup({ enforce: mode === "enforce" });
        const actions = map(safe[0], safe[1], dir);
        assert.equal(actions[0].evaluated, false);
        assert.equal(actions[0].unknownTool, undefined);
        const d = await runtime(dir).evaluate(actions);
        assert.equal(d.decision, "not_evaluated");
        assert.equal(d.receipt.payload.execution.state, "observed_not_evaluated");
      });
    }

    test(`${harness} (${mode}): a mapped call (${mapped[0]}) is decided as before`, async () => {
      const { dir } = setup({ enforce: mode === "enforce" });
      const d = await runtime(dir).evaluate(map(mapped[0], mapped[1], dir));
      assert.equal(d.decision, "allow");
    });
  }
}

test("a tool the policy names (rules.json observe) is decided by the policy, not refused", async () => {
  const { dir, agentKid, rulesPath } = setup();
  const rules = JSON.parse(readFileSync(rulesPath, "utf8"));
  rules.observe = [...rules.observe, "tool.brandnewtool"];
  writeFileSync(rulesPath, JSON.stringify(rules));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compile(rules, agentKid)));
  const d = await runtime(dir).evaluate(MAPPERS.claude("BrandNewTool", {}, dir));
  assert.equal(d.decision, "allow");
  // Another unknown tool is still refused.
  assert.equal((await runtime(dir).evaluate(MAPPERS.claude("OtherNewTool", {}, dir))).decision, "deny");
});

test("strict mode keeps its meaning: an unknown tool goes to the policy, an unreadable write is denied", async () => {
  const { dir } = setup();
  const tool = await runtime(dir, { strict: true }).evaluate(MAPPERS.claude("BrandNewTool", {}, dir));
  assert.equal(tool.decision, "deny");
  assert.match(tool.reason, /not allowlisted/);
  // A shell command whose written files are named only inside its input stays not evaluated outside strict mode.
  const patch = MAPPERS.claude("Bash", { command: "patch -p1 < fix.diff" }, dir);
  assert.ok(patch.some((m) => !m.evaluated && m.unknownTool === undefined));
  assert.notEqual((await runtime(dir).evaluate(patch)).decision, "deny");
  assert.equal((await runtime(dir, { strict: true }).evaluate(patch)).decision, "deny");
});

test("Codex view_image is a checked read of the image file", () => {
  const [m] = MAPPERS.codex("view_image", { path: "/w/shot.png" }, "/w");
  assert.equal(m.intent.action_type, "file.read");
  assert.equal(m.intent.params.path, "shot.png");
  assert.equal(m.evaluated, true);
});

// End to end through the real hook entry points.
function hook(args, dir, payload) {
  const env = { ...process.env, SCOPEBOND_HOOK_DIR: dir, SCOPEBOND_HOOK_FLUSH_MS: "0" };
  for (const k of Object.keys(env)) if (/^SCOPEBOND_HOOK_STRICT$/.test(k)) delete env[k];
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, input: JSON.stringify(payload), encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}

test("Claude Code: a made-up tool is asked about in a prompting mode and denied in bypass mode", () => {
  const { dir } = setup();
  const base = { hook_event_name: "PreToolUse", session_id: "s1", cwd: dir, tool_name: "BrandNewTool", tool_input: {} };
  const ask = hook(["claude"], dir, { ...base, permission_mode: "default" });
  assert.equal(ask.status, 0, ask.stderr);
  const asked = JSON.parse(ask.stdout).hookSpecificOutput;
  assert.equal(asked.permissionDecision, "ask");
  assert.match(asked.permissionDecisionReason, /the tool "BrandNewTool"/);
  const deny = hook(["claude"], dir, { ...base, permission_mode: "bypassPermissions" });
  assert.equal(deny.status, 2);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.stderr, /Scopebond blocked the tool "BrandNewTool"/);
  // A known-safe tool stays silent: the coding agent's own permission flow decides.
  const safe = hook(["claude"], dir, { ...base, tool_name: "TodoWrite", tool_input: { todos: [] }, permission_mode: "bypassPermissions" });
  assert.equal(safe.status, 0, safe.stderr);
  assert.equal(safe.stdout, "");
});

test("Codex: a made-up tool is denied (Codex cannot ask)", () => {
  const { dir } = setup();
  const r = hook(["codex"], dir, { hook_event_name: "PreToolUse", session_id: "s1", cwd: dir, tool_name: "BrandNewTool", tool_input: {} });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /the tool "BrandNewTool"/);
  const safe = hook(["codex"], dir, { hook_event_name: "PreToolUse", session_id: "s1", cwd: dir, tool_name: "update_plan", tool_input: { plan: [] } });
  assert.equal(safe.status, 0, safe.stderr);
  assert.equal(safe.stdout, "");
});

test("Cursor: an event Scopebond does not map is asked about, with the reason", () => {
  const { dir } = setup();
  const r = hook(["cursor"], dir, { hook_event_name: "brandNewEvent", cwd: dir });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.permission, "ask");
  assert.match(out.agentMessage, /the tool "brandNewEvent"/);
});
