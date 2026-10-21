// What the coding agent is told on a deny, through the runtime: five lines (what was blocked, why, what to do, for the
// person, the references), with the final instruction by outcome, so the agent stops retrying and says the right thing:
// the person can unblock it, an admin decides, it stays blocked, or the person chose to keep it blocked.
import { ENFORCE } from "./enforce-all.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scaffold, createHookRuntime, mapClaudeToolUse, compileManaged, digestRules, digestManaged, defaultRules,
  createOverrideHandler, overrideHint, overrideRemedy, MANAGED_DOC_FILE, readBlocked, actOnBlocked,
} from "../dist/index.js";

const INSTALLATION = "gw-deny-1";
const terms = (extra = {}) => ({ reason_min: 0, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once", requests: true, ...extra });
const defaults = () => ({
  "force-push-protected": { mode: "block" }, "push-protected": { mode: "block" }, "destructive-shell": { mode: "block" },
  "secret-read": { mode: "block" }, "ci-config-write": { mode: "block" }, "network-egress": { mode: "monitor" },
});
const UNBLOCK = "What to do: The person can unblock it from the Scopebond icon; ask them, then try once more.";
const ASK = "What to do: The person can ask an admin from the Scopebond icon; tell them, and wait for the answer before trying again.";
const STAYS = "What to do: It stays blocked. Don't retry or work around it; tell the person what you were trying to do.";
const QUIET = "What to do: The person chose to keep this blocked; do not ask again or retry.";
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

function setup(overrides = {}, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scopebond-deny-"));
  const { agentKid } = scaffold(dir, ENFORCE);
  const rules = { ...defaults(), ...overrides };
  const doc = { type: "scopebond:managed-rules", version: 1, revision: 2, export_id: `rev-2-${INSTALLATION}`, environment_id: "env-1", agent_id: "agent-1",
    installation_id: INSTALLATION, rules, rules_digest: extra.blocked_services ? digestManaged(rules, extra.blocked_services) : digestRules(rules), ...extra };
  writeFileSync(join(dir, MANAGED_DOC_FILE), JSON.stringify(doc));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(compileManaged(defaultRules(), doc, agentKid)));
  return dir;
}

async function deny(dir, toolUse, answers = [], now) {
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo",
    override: (agentKid) => {
      const made = createOverrideHandler({ dir, home: dir, agentKid, harness: "claude", permissionMode: "default", waitMs: 50, ...(now ? { now } : {}),
        ask: async () => answers.shift() ?? { decision: "unavailable" } });
      return made ? { handler: made.handler, hint: () => overrideHint(made.note()), remedy: () => overrideRemedy(made.note()) } : null;
    },
  });
  try {
    const d = await runtime.evaluate(mapClaudeToolUse({ cwd: "/repo", ...toolUse }));
    assert.equal(d.decision, "deny");
    return d;
  } finally { runtime.close(); }
}

/** The five lines, checked for shape: the first names the action and the rule, the last carries the clause, the mode and the
 *  record. */
function lines(d, clause) {
  const out = d.reason.split("\n");
  assert.equal(out.length, 5, d.reason);
  assert.match(out[0], /^Scopebond blocked: .+ \(".+"\)\.$/);
  assert.match(out[1], /^Why: /);
  assert.match(out[2], /^What to do: /);
  assert.match(out[3], /^For the person: /);
  const record = d.receipts.find((r) => r.payload.realtime_result === "deny")?.payload.action_ref.action_id;
  assert.ok(record);
  assert.match(out[4], new RegExp(`^Ref: ${clause} · enforce · ${record}( \\(.+\\))?$`));
  return out;
}

test("a rule on Block: it stays blocked, and the person asks an admin to change the rule", async () => {
  const d = await deny(setup(), bash("rm -rf ../build"));
  const out = lines(d, "safe-shell");
  assert.equal(out[0], 'Scopebond blocked: rm -rf ../build ("Run a command that deletes data or shuts down the computer").');
  assert.equal(out[2], STAYS);
  assert.match(out[3], /ask an admin of the workspace to change the rule/);
});

test("the person may unblock it: the agent is told to ask them, then try once more", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms() } });
  const out = lines(await deny(dir, bash("rm -rf ../build"), [{ decision: "unavailable", later: true }]), "safe-shell");
  assert.equal(out[2], UNBLOCK);
  assert.match(out[3], /^For the person: your workspace lets you allow it from the Scopebond icon/);
  // The Scopebond Agent is not running: the same instruction, and the person is told to start it.
  const down = lines(await deny(dir, bash("rm -rf ../dist")), "safe-shell");
  assert.equal(down[2], UNBLOCK);
  assert.match(down[3], /the Scopebond Agent is not running/);
});

test("an admin decides: the agent is told to wait for the answer", async () => {
  const dir = setup({ "destructive-shell": { mode: "ask", override: terms() } });
  assert.equal(lines(await deny(dir, bash("rm -rf ../build"), [{ decision: "unavailable", later: true }]), "safe-shell")[2], ASK);
  const asked = lines(await deny(dir, bash("rm -rf ../dist"), [{ decision: "ask", reason: "" }]), "safe-shell");
  assert.equal(asked[2], ASK);
  assert.match(asked[3], /was sent to your workspace's admins/);
});

test("kept blocked by the person: do not ask again or retry", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms() } });
  await deny(dir, bash("rm -rf ../build"));
  actOnBlocked(dir, readBlocked(dir).at(-1).id, { decision: "quiet" });
  const out = lines(await deny(dir, bash("rm -rf ../build")), "safe-shell");
  assert.equal(out[2], QUIET);
  assert.match(out[3], /you chose to keep this blocked/);
});

test("a retry within minutes: as before, don't try it again", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms() } });
  const t0 = Date.parse("2026-10-21T09:00:00Z");
  await deny(dir, bash("rm -rf ../build"), [], () => t0);
  const out = lines(await deny(dir, bash("rm -rf ../build"), [], () => t0 + 60_000), "safe-shell");
  assert.equal(out[2], "What to do: This was blocked a few minutes ago and the person has not answered yet. Don't try it again: tell the person what you were trying to do; they can act on it from the Scopebond icon.");
});

test("the person said no: it stays blocked", async () => {
  const dir = setup({ "destructive-shell": { mode: "override", override: terms() } });
  const no = lines(await deny(dir, bash("rm -rf ../a"), [{ decision: "deny" }]), "safe-shell");
  assert.equal(no[2], STAYS);
  assert.match(no[3], /not given/);
});

test("Scopebond's own protection and a service the workspace blocks: it stays blocked", async () => {
  const dir = setup({}, { blocked_services: [{ kind: "cli", key: "ffmpeg" }] });
  const own = await deny(dir, { tool_name: "Read", tool_input: { file_path: "/repo/.scopebond/agent.key" } });
  const protectedLines = lines(own, "protect-scopebond-read");
  assert.equal(protectedLines[2], STAYS);
  assert.match(protectedLines[3], /always on: no one can unblock it/);
  const service = lines(await deny(dir, bash("ffmpeg -i a.mp4 b.mp4")), "blocked-programs");
  assert.equal(service[1], "Why: Your workspace blocks the program ffmpeg.");
  assert.equal(service[2], STAYS);
  assert.match(service[3], /ask an admin of your Scopebond workspace to change the block/);
});

test("Safe Install's verdict in words still reads from the first line when the instruction follows it", async () => {
  const { installVerdictWords } = await import("../dist/block-notes.js");
  assert.equal(installVerdictWords("Scopebond Safe Install blocked installing left-pad (npm).\nWhat to do: It stays blocked. Don't retry or work around it; tell the person what you were trying to do."), null);
  assert.equal(installVerdictWords("Scopebond Safe Install blocked installing left-pad (npm). It is known malware.\nWhat to do: It stays blocked."), "It is known malware");
});
