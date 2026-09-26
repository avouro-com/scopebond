// Cursor's adapter answers with a permission, and which permission it picks is a
// product decision, not a detail: answering "ask" for an action a rule had already
// allowed put a confirmation prompt in front of every ordinary command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold, mapCursorEvent } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const policy = {
  vocabulary_version: "1.0", policy_id: "cursor-test", version: 1,
  clauses: [
    {
      id: "safe-shell", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"],
      param_bounds: { program: { pattern: "^(?!rm$).+" } },
      description: "Deny destructive programs.",
    },
    {
      id: "protect-write", type: "action_allowlist", mode: "enforce", action_types: ["file.write"],
      param_bounds: { path: { pattern: "^(?!\\.github/).+" } },
      description: "Never write CI config.",
    },
    { id: "reads", type: "action_allowlist", mode: "enforce", action_types: ["file.read"] },
  ],
};

function enrolled() {
  const dir = mkdtempSync(join(tmpdir(), "sb-cursor-"));
  scaffold(dir);
  const active = JSON.parse(JSON.stringify(policy));
  // Keep the scaffolded key clause so only the enrolled machine key may sign.
  const scaffolded = JSON.parse(execFileSync(process.execPath, ["-e", `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(dir, "policy.json"))},'utf8'))`], { encoding: "utf8" }));
  const keys = (scaffolded.clauses ?? []).find((c) => c.type === "key_policy");
  if (keys) active.clauses.push(keys);
  writeFileSync(join(dir, "policy.json"), JSON.stringify(active));
  return dir;
}

function cursorEvent(dir, payload) {
  const out = execFileSync(process.execPath, [cli, "cursor"], {
    encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir }, input: JSON.stringify(payload),
  });
  return JSON.parse(out);
}

test("an evaluated-and-allowed action returns allow, not a confirmation prompt", () => {
  const dir = enrolled();
  const result = cursorEvent(dir, { hook_event_name: "beforeShellExecution", cwd: dir, command: "npm test" });
  assert.equal(result.permission, "allow", "an allowed command must not prompt the user");
});

test("an out-of-policy action is denied outright, with the rule named", () => {
  const dir = enrolled();
  const result = cursorEvent(dir, { hook_event_name: "beforeShellExecution", cwd: dir, command: "rm -rf src" });
  assert.equal(result.permission, "deny");
  assert.match(result.agentMessage, /rule "safe-shell"/);
});

test("an action no rule covers still defers to Cursor's own prompt", () => {
  const dir = enrolled();
  const result = cursorEvent(dir, { hook_event_name: "someFutureEvent", cwd: dir });
  assert.equal(result.permission, "ask", "unevaluated actions are never silently allowed");
});

test("malformed input fails closed", () => {
  const dir = enrolled();
  const out = execFileSync(process.execPath, [cli, "cursor"], {
    encoding: "utf8", env: { ...process.env, SCOPEBOND_HOOK_DIR: dir }, input: "not json",
  });
  assert.equal(JSON.parse(out).permission, "deny");
});

test("afterFileEdit is marked post-hoc, and the message never claims prevention", () => {
  // The mapping carries the flag...
  const mapped = mapCursorEvent("afterFileEdit", { path: "src/a.ts", cwd: "/repo" });
  assert.ok(mapped.length > 0);
  for (const m of mapped) assert.equal(m.postHoc, true, "an after-the-fact edit is flagged");
  // ...and a before-hook event is not.
  for (const m of mapCursorEvent("beforeReadFile", { path: "src/a.ts", cwd: "/repo" })) {
    assert.notEqual(m.postHoc, true, "a before-hook action is genuine prevention");
  }
  // ...and the user-facing message says so plainly.
  const dir = enrolled();
  const result = cursorEvent(dir, { hook_event_name: "afterFileEdit", cwd: dir, path: ".github/workflows/ci.yml" });
  assert.equal(result.permission, "deny", "the violation is still reported");
  assert.match(result.agentMessage, /was not prevented/);
  assert.doesNotMatch(result.agentMessage, /Scopebond blocked/, "must not claim the edit was blocked");
});
