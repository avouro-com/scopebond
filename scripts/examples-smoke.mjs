// Runs each example against the built workspace packages and asserts the
// decisions it prints. This keeps the examples honest (a published-API change
// that flips an allow/deny, or drops the receipt fields, fails CI) and keeps
// them from bit-rotting. Requires `pnpm -r build` first (CI runs `pnpm -r test`,
// which builds each package). Run: `node scripts/examples-smoke.mjs`.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (rel) => execFileSync(process.execPath, [rel], { cwd: root, encoding: "utf8" });

const cases = [
  {
    file: "examples/quickstart.mjs",
    expect: [
      "allowed = true", // the in-policy payout is allowed
      "allowed = false", // the over-limit payout is denied
    ],
  },
  {
    file: "examples/framework-guard.mjs",
    expect: [
      "results for order-4821", // allowlisted read-only tool ran
      "refunded 50000 cents", // refund within the cap ran
      "Blocked by policy: refund", // over-cap refund denied, real tool never ran
      "Blocked by policy: deleteAll", // non-allowlisted tool denied (fail-closed)
      "evidence_class   = signed_intent", // the strongest class: the agent signed
      "executed         = false", // cooperative M0 check; the guard never runs the tool
    ],
  },
];

let failures = 0;
for (const { file, expect } of cases) {
  let output = "";
  try {
    output = run(file);
  } catch (error) {
    console.error(`FAIL ${file}: threw (${error.status ?? error.message})`);
    if (error.stdout) console.error(error.stdout);
    if (error.stderr) console.error(error.stderr);
    failures++;
    continue;
  }
  const missing = expect.filter((needle) => !output.includes(needle));
  if (missing.length) {
    console.error(`FAIL ${file}: missing expected output:`);
    for (const needle of missing) console.error(`  - ${JSON.stringify(needle)}`);
    console.error("--- actual output ---");
    console.error(output);
    failures++;
  } else {
    console.log(`ok   ${file} (${expect.length} assertions)`);
  }
}

if (failures) {
  console.error(`\nexamples-smoke: ${failures} example(s) failed`);
  process.exit(1);
}
console.log(`\nexamples-smoke: ${cases.length} examples pass`);
