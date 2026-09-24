// The bash oracle: compare the hook mapper (plus the starter policy) with what real
// bash executes for the same command. See test/oracle/harness.mjs for the sandbox.
//
//   miss            the oracle saw a destructive program run, a protected branch pushed
//                   or a protected file read, and the hook did not deny — a bypass.
//   false positive  the oracle saw nothing harmful, and the hook denied.
//
// Every labeled category must agree with the oracle (the corpus is self-checking), a
// miss in any harmful category fails, and false positives may not exceed the recorded
// baseline. Skipped on Windows (Git Bash's process model differs from the POSIX shells
// the hook guards; CI's Linux job is the authority) and where bash is unavailable.
// Set SCOPEBOND_ORACLE=1 to run it on Windows anyway.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapClaudeToolUse, createHookRuntime, scaffold, fillPushBranch } from "../dist/index.js";
import { createOracle, findBash } from "./oracle/harness.mjs";

// Denials of commands bash runs harmlessly. Lower it when the mapper improves; never
// raise it without reviewing the new false positives printed by this test.
const FP_BASELINE = 0;
const BRANCH = "feature/work";

const corpus = JSON.parse(readFileSync(new URL("./oracle/corpus.json", import.meta.url), "utf8"));
const skip = process.platform === "win32" && process.env.SCOPEBOND_ORACLE !== "1"
  ? "the oracle runs on POSIX hosts (set SCOPEBOND_ORACLE=1 to force)"
  : !findBash() ? "bash is not available" : false;

function starterRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-oracle-"));
  scaffold(dir);
  return createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
  });
}

test("oracle corpus: at least 250 commands across the four categories", () => {
  assert.ok(corpus.length >= 250, `corpus has ${corpus.length} commands`);
  const cats = new Set(corpus.map((c) => c.category));
  assert.deepEqual([...cats].sort(), ["benign", "destructive-shell", "force-push", "secret-read"]);
  assert.equal(new Set(corpus.map((c) => c.command)).size, corpus.length, "duplicate commands in the corpus");
});

test("bash oracle: the hook denies everything bash would run harmfully", { skip }, async () => {
  const oracle = createOracle();
  const rt = starterRuntime();
  const mislabeled = [];
  const misses = [];
  const fps = [];
  const stats = {};
  try {
    for (const { command, category } of corpus) {
      const truth = oracle.run(command, { branch: BRANCH });
      const harm = {
        "destructive-shell": truth.destructive.length > 0,
        "force-push": truth.pushes.length > 0,
        "secret-read": truth.secretRead,
      };
      const harmful = Object.values(harm).some(Boolean);
      if (category === "benign" ? harmful : !harm[category]) {
        mislabeled.push(`${JSON.stringify(command)} [${category}] oracle: rm=${truth.destructive} push=${truth.pushes} read=${truth.leaks}`);
        continue;
      }
      const d = await rt.evaluate(fillPushBranch(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } }), BRANCH));
      const denied = d.decision === "deny";
      const s = (stats[category] ??= { total: 0, misses: 0, fps: 0 });
      s.total++;
      if (harmful && !denied) { s.misses++; misses.push(`[${category}] ${JSON.stringify(command)} -> ${d.decision} (bash ran: ${truth.execs.map((e) => [e.program, ...e.argv].join(" ")).join(" ; ")}${truth.leaks.length ? "; " + truth.leaks.join(", ") : ""})`); }
      if (!harmful && denied) { s.fps++; fps.push({ command, reason: d.reason }); }
    }
  } finally {
    oracle.cleanup();
  }

  console.log("\nbash oracle — per category");
  console.table(stats);
  if (fps.length) {
    console.log(`false positives (${fps.length}, baseline ${FP_BASELINE}):`);
    console.table(fps);
  }
  assert.deepEqual(mislabeled, [], `corpus entries whose label disagrees with bash:\n${mislabeled.join("\n")}`);
  assert.deepEqual(misses, [], `the hook allowed commands bash runs harmfully:\n${misses.join("\n")}`);
  assert.ok(fps.length <= FP_BASELINE, `false positives rose to ${fps.length} (baseline ${FP_BASELINE}):\n${fps.map((f) => f.command).join("\n")}`);
});
