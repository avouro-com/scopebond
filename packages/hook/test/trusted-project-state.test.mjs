// A trusted project's policy governs in its folder, pinned to what the person trusted. What can let a blocked action through
// (the workspace rules document, allowances, the record of earlier overrides) is not part of that pin, so for a trusted
// project it comes from the user-level home, never from files a repository can carry beside its policy. And the files the
// pin covers include everything else in the folder that decides what is enforced: the rule list (allowed roots, the
// remote-database guard) and the identity of a workspace connection, so a planted rule list or connection lapses the trust.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold, mapClaudeToolUse, trustProjectPolicy, isTrustedProject, resolveConfigDir, trustedProjectsFile, MANAGED_DOC_FILE, digestRules } from "../dist/index.js";
import { actionKey } from "../dist/override.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PUSH = "git push origin main";

function withHome(home, fn) {
  const saved = { SCOPEBOND_HOME: process.env.SCOPEBOND_HOME, SCOPEBOND_HOOK_DIR: process.env.SCOPEBOND_HOOK_DIR, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  process.env.SCOPEBOND_HOME = home;
  delete process.env.SCOPEBOND_HOOK_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

/** A user-level install, and a project whose own policy blocks pushes to protected branches, trusted by the person. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "scopebond-trusted-state-"));
  const profile = join(root, "profile");
  const home = join(profile, ".scopebond");
  const project = join(root, "repo");
  const config = join(project, ".scopebond");
  mkdirSync(profile, { recursive: true });
  scaffold(home);
  scaffold(config, { enforce: ["protect-branches"] });
  withHome(home, () => trustProjectPolicy(config));
  return { root, profile, home, project, config };
}

const rulesDoc = (installation) => {
  const rules = {
    "push-protected": { mode: "override", override: { reason_min: 10, minutes: 0, daily_limit: 50, harness_prompt: false } },
    "force-push-protected": { mode: "block" }, "destructive-shell": { mode: "block" }, "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
  };
  return { type: "scopebond:managed-rules", version: 1, revision: 1, export_id: `rev-1-${installation}`, environment_id: "env-x", agent_id: "agent-x", installation_id: installation, rules_digest: digestRules(rules), rules };
};
const pushKey = () => actionKey(mapClaudeToolUse({ cwd: "/repo", tool_name: "Bash", tool_input: { command: PUSH } }).find((m) => m.intent.action_type === "git.push").intent);
/** The two files a repository can carry beside its policy: "a person may allow pushes", and a standing allowance for this push. */
function plantGrant(folder) {
  writeFileSync(join(folder, MANAGED_DOC_FILE), JSON.stringify(rulesDoc("x")));
  const now = Date.now();
  writeFileSync(join(folder, "allowances.json"), JSON.stringify({ version: 1, items: [{
    id: "alw_AAAAAAAAAAAAAAAAAAAAAA", rule: "push-protected", action_key: pushKey(), scope: "computer", os_user_digest: null,
    state: "active", once: false, reason_digest: "1".repeat(64), reason_length: 20, created_by: "workspace",
    created_at: new Date(now).toISOString(), expires_at: new Date(now + 365 * 864e5).toISOString(), uses: 0,
  }] }));
}

/** Run the Claude Code hook as the coding agent would, from the project. */
function hook(s, command = PUSH) {
  const env = { ...process.env, HOME: s.profile, USERPROFILE: s.profile, SCOPEBOND_HOME: s.home, SCOPEBOND_POLICY_SYNC: "off", SCOPEBOND_TELEMETRY: "off" };
  delete env.SCOPEBOND_HOOK_DIR;
  delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [cli, "claude"], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: s.project, tool_name: "Bash", tool_input: { command }, tool_use_id: "t1", session_id: "s1" }),
    encoding: "utf8", env, timeout: 60_000,
  });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return out?.hookSpecificOutput?.permissionDecision === "deny" ? "deny" : "allow";
}

test("a trusted project's own managed-rules.json and allowances.json do not let a blocked action through", () => {
  const s = setup();
  try {
    withHome(s.home, () => assert.equal(resolveConfigDir(s.project), s.config, "the trusted project governs"));
    assert.equal(hook(s), "deny", "the project's policy blocks the push");
    plantGrant(s.config);
    withHome(s.home, () => assert.equal(isTrustedProject(s.config), true, "the policy itself did not change"));
    assert.equal(hook(s), "deny", "files beside the trusted policy never allow what it blocks");
    assert.equal(JSON.parse(readFileSync(join(s.config, "allowances.json"), "utf8")).items[0].uses, 0, "the planted allowance was never used");
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("for a trusted project, what may let a blocked action through comes from the user-level home", () => {
  const s = setup();
  try {
    plantGrant(s.home);
    assert.equal(hook(s), "allow", "the person's own allowance, under the rules document in the user home, applies");
    assert.equal(JSON.parse(readFileSync(join(s.home, "allowances.json"), "utf8")).items[0].uses, 1);
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("a rule list or a workspace connection added or changed beside a trusted policy lapses the trust", () => {
  const s = setup();
  try {
    withHome(s.home, () => {
      assert.equal(isTrustedProject(s.config), true);
      const rules = JSON.parse(readFileSync(join(s.config, "rules.json"), "utf8"));
      writeFileSync(join(s.config, "rules.json"), JSON.stringify({ ...rules, allowed_roots: ["/"] }));
      assert.equal(isTrustedProject(s.config), false, "a changed rule list (read at run time too) is not what was trusted");
      assert.equal(resolveConfigDir(s.project), s.home, "the user's own policy governs again");
      trustProjectPolicy(s.config);
      assert.equal(isTrustedProject(s.config), true);
      writeFileSync(join(s.config, "cloud.json"), JSON.stringify({ url: "https://workspace.example.test", credential: "sbm_x", organization_id: "org-x", gateway_id: "gw-x" }));
      assert.equal(isTrustedProject(s.config), false, "a connection the person did not trust never governs");
      trustProjectPolicy(s.config);
      assert.equal(isTrustedProject(s.config), true, "connecting the project is the person's decision; it is pinned again");
      // A renewed credential is the same connection.
      writeFileSync(join(s.config, "cloud.json"), JSON.stringify({ url: "https://workspace.example.test", credential: "sbm_y", organization_id: "org-x", gateway_id: "gw-x", expires_at: "2099-01-01T00:00:00Z" }));
      assert.equal(isTrustedProject(s.config), true);
      writeFileSync(join(s.config, "cloud.json"), JSON.stringify({ url: "https://elsewhere.example.test", credential: "sbm_y", organization_id: "org-x", gateway_id: "gw-x" }));
      assert.equal(isTrustedProject(s.config), false, "another workspace is another connection");
    });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});

test("a pin made before the rule list was covered stays valid, and is renewed to cover it", () => {
  const s = setup();
  try {
    withHome(s.home, () => {
      const key = Object.keys(JSON.parse(readFileSync(trustedProjectsFile(), "utf8")))[0];
      const legacy = createHash("sha256").update(readFileSync(join(s.config, "policy.json"))).digest("hex");
      writeFileSync(trustedProjectsFile(), JSON.stringify({ [key]: legacy }));
      assert.equal(isTrustedProject(s.config), true, "an earlier pin of the unchanged policy is honoured");
      assert.notEqual(JSON.parse(readFileSync(trustedProjectsFile(), "utf8"))[key], legacy, "and renewed");
      writeFileSync(join(s.config, "rules.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(s.config, "rules.json"), "utf8")), protect_remote_database: false }));
      assert.equal(isTrustedProject(s.config), false, "from then on the rule list is covered too");
    });
  } finally { rmSync(s.root, { recursive: true, force: true }); }
});
