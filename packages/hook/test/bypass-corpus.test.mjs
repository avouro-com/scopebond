// The bypass corpus (test/bypass-corpus/*.json): ways an agent might reach a blocked action indirectly, with every rule
// blocking. Each case states the outcome the hook should give:
//   block  the call is denied;
//   watch  the call runs, but the record names the action (`target`), so it is visible and reviewable.
// A case the hook does not meet yet carries `expected_gap` with what it does today (`watch`, or `miss`: the action is
// neither blocked nor named in the record) and why. The runner asserts the recorded outcome either way, so a regression
// and an improvement both fail until the case is updated: a gap is listed, never hidden.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffold, createHookRuntime, mapClaudeToolUse, useDigestKey } from "../dist/index.js";
import { ENFORCE } from "./enforce-all.mjs";

const folder = fileURLToPath(new URL("./bypass-corpus/", import.meta.url));
const OUTCOMES = new Set(["block", "watch"]);
const GAP_OUTCOMES = new Set(["block", "watch", "miss"]);

/** The command, with an encoded payload built here (base64 of UTF-8 for `{base64}`, of UTF-16LE for PowerShell's
 *  `{encoded}`), so the corpus files hold only readable text. */
function commandOf(c) {
  if (c.payload === undefined) return c.command;
  return c.command
    .replace("{base64}", Buffer.from(c.payload, "utf8").toString("base64"))
    .replace("{encoded}", Buffer.from(c.payload, "utf16le").toString("base64"));
}

const names = (mapped, target) => mapped.some(({ intent }) => intent.action_type === target.action_type
  && Object.entries(target).every(([k, v]) => k === "action_type" || intent.params?.[k] === v));

useDigestKey("33".repeat(32));
const dir = mkdtempSync(join(tmpdir(), "sb-bypass-"));
scaffold(dir, ENFORCE);
const runtime = createHookRuntime({ policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"), attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"), cwd: "/repo" });

async function outcomeOf(c) {
  const mapped = mapClaudeToolUse({ cwd: "/repo", tool_name: c.tool ?? "Bash", tool_input: { command: commandOf(c) } });
  const decision = await runtime.evaluate(mapped);
  if (decision.decision === "deny") return "block";
  return c.target && names(mapped, c.target) ? "watch" : "miss";
}

const files = readdirSync(folder).filter((f) => f.endsWith(".json")).sort();
const ids = new Set();
test.after(() => { runtime.close(); rmSync(dir, { recursive: true, force: true }); });

test("the corpus covers every category and each case is well formed", () => {
  assert.ok(files.length >= 6);
  for (const file of files) {
    const { category, cases } = JSON.parse(readFileSync(join(folder, file), "utf8"));
    assert.ok(typeof category === "string" && cases.length > 0, file);
    for (const c of cases) {
      assert.ok(!ids.has(c.id), `duplicate id ${c.id}`); ids.add(c.id);
      assert.ok(OUTCOMES.has(c.expected), `${c.id}: expected is block or watch`);
      if (c.expected === "watch") assert.ok(c.target, `${c.id}: a watch case names the action the record must show`);
      if (c.expected_gap) {
        assert.ok(GAP_OUTCOMES.has(c.expected_gap.actual) && c.expected_gap.actual !== c.expected, `${c.id}: a gap records a different outcome`);
        assert.ok(typeof c.expected_gap.reason === "string" && c.expected_gap.reason.length > 20, `${c.id}: a gap says why`);
      }
    }
  }
});

for (const file of files) {
  const { category, cases } = JSON.parse(readFileSync(join(folder, file), "utf8"));
  test(`bypass corpus: ${category}`, async () => {
    const wrong = [];
    for (const c of cases) {
      const actual = await outcomeOf(c);
      const recorded = c.expected_gap ? c.expected_gap.actual : c.expected;
      if (actual !== recorded) {
        wrong.push(`${c.id}: ${actual} (recorded ${recorded}${c.expected_gap ? `, a known gap; expected ${c.expected}` : ""})`);
      }
    }
    assert.deepEqual(wrong, [], "update the case: a regression must be fixed, an improvement must drop its expected_gap");
  });
}
