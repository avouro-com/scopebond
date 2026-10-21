// The always-on floor covers what runs code or switches Scopebond off, and nothing a workspace has reason to manage: the
// connection file is protected in Scopebond's own folder (any project's `config/cloud.json` reads as usual), and the coding
// agents' sub-agent definitions (`.claude/agents`) and MCP settings (`.mcp.json`) are guarded by the configuration rule a
// workspace can relax. `.git/hooks`, `.git/config` and `.husky` run code, so they stay in the floor.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENFORCE } from "./enforce-all.mjs";
import { scaffold, createHookRuntime, mapClaudeToolUse, compile, defaultRules, compileManaged, digestRules, upgradeStarterPolicy, starterPolicy } from "../dist/index.js";

const temps = [];
after(() => { for (const d of temps) { try { rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* a handle still open on Windows */ } } });
function runtime(policyOf) {
  const dir = mkdtempSync(join(tmpdir(), "sb-floor-"));
  temps.push(dir);
  const { agentKid } = scaffold(dir, ENFORCE);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policyOf(agentKid)));
  return createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo", homeFolders: ["/srv/people/dev"] });
}
const write = (file_path) => mapClaudeToolUse({ tool_name: "Write", tool_input: { file_path, content: "x" }, cwd: "/repo" });
const read = (file_path) => mapClaudeToolUse({ tool_name: "Read", tool_input: { file_path }, cwd: "/repo" });
async function outcomes(rt, calls) {
  const out = [];
  for (const c of calls) { const d = await rt.evaluate(c); out.push(d.decision === "deny" ? `deny:${d.clauseId}` : d.decision); }
  return out;
}
const rules = (overrides) => {
  const r = { "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" }, "secret-read": { mode: "block" },
    "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" }, ...overrides };
  return { type: "scopebond:managed-rules", version: 1, revision: 1, export_id: "rev-1-x", environment_id: "e", agent_id: "a", installation_id: "x", rules: r, rules_digest: digestRules(r) };
};

test("the connection file is protected in Scopebond's own folder only", async () => {
  const rt = runtime((kid) => compile({ ...defaultRules(), enforce: [] }, kid));
  try {
    assert.deepEqual(await outcomes(rt, [read("/repo/config/cloud.json"), read("/repo/infra/cloud.json"), read("/srv/people/dev/.scopebond/cloud.json"),
      read("/repo/.scopebond/cloud.json"), read("D:/Apps/data/Scopebond/cloud.json"), read("/srv/people/dev/.config/scopebond/cloud.json")]),
    ["allow", "allow", "deny:protect-scopebond-read", "deny:protect-scopebond-read", "deny:protect-scopebond-read", "deny:protect-scopebond-read"]);
  } finally { rt.close(); }
});

test("sub-agent definitions and .mcp.json follow the configuration rule; git hooks, git config and Husky stay in the floor", async () => {
  const relaxable = [write("/repo/.claude/agents/reviewer.md"), write("/repo/.mcp.json"), write("/srv/people/dev/.claude/agents/x.md")];
  const floor = [write("/repo/.git/hooks/pre-commit"), write("/repo/.git/config"), write("/repo/.husky/pre-commit"), write("/repo/.claude/settings.json"), write("/repo/.scopebond/policy.json")];
  // The configuration rule blocking: denied by it, not by the floor.
  const on = runtime((kid) => compile({ ...defaultRules(), ...ENFORCE }, kid));
  try {
    assert.deepEqual(await outcomes(on, relaxable), ["deny:protect-write", "deny:protect-write", "deny:protect-write"]);
  } finally { on.close(); }
  // Recording or Off, or excepted by the workspace: allowed. The floor still denies what runs code.
  for (const doc of [rules({ "ci-config-write": { mode: "monitor" } }), rules({ "ci-config-write": { mode: "off" } }),
    rules({ "ci-config-write": { mode: "block", excluded_paths: [".claude/agents/**", ".mcp.json", ".git/hooks/**", ".husky/**", ".git/config"] } })]) {
    const rt = runtime((kid) => compileManaged(defaultRules(), doc, kid));
    try {
      const label = JSON.stringify(doc.rules["ci-config-write"]);
      assert.deepEqual(await outcomes(rt, relaxable.slice(0, 2)), ["allow", "allow"], label);
      assert.deepEqual((await outcomes(rt, floor)).map((o) => o.startsWith("deny:protect-scopebond-write")), [true, true, true, true, true], label);
    } finally { rt.close(); }
  }
});

test("a policy that still carries the earlier floor is narrowed when it is loaded; the floor in force is the current one", () => {
  const current = starterPolicy("key:abc").clauses.filter((c) => c.id.startsWith("protect-scopebond-"));
  const ci = (s) => s.replace(/[A-Za-z]/g, (ch) => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
  const writePattern = current.find((c) => c.id === "protect-scopebond-write").param_bounds.path.pattern;
  const readPattern = current.find((c) => c.id === "protect-scopebond-read").param_bounds.path.pattern;
  assert.ok(!writePattern.includes(ci("\\.mcp\\.json")) && !writePattern.includes(ci("\\.claude/agents")));
  // The earlier read floor: Scopebond's folder and any cloud.json.
  const earlierRead = `^(?!(?:.*/)?${ci("\\.scopebond")}(?:/|$))(?!(?:.*/)?${ci("cloud\\.json")}$).+`;
  const upgraded = upgradeStarterPolicy({ clauses: [{ id: "protect-scopebond-read", type: "action_allowlist", action_types: ["file.read"], param_bounds: { path: { pattern: earlierRead } } }] });
  assert.equal(upgraded.clauses[0].param_bounds.path.pattern, readPattern);
});
