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
  {
    file: "examples/github-pr-gate.mjs",
    expect: [
      "is not a governed agent", // human PR is never blocked
      "decision = allow", // agent PR within policy merges
      "decision = deny", // agent PR touching a production path cannot merge
      "asserted:copilot-swe-agent[bot]", // attribution from the login
    ],
  },
  {
    file: "examples/mcp-proxy.mjs",
    expect: [
      "ran read_file", // allowed call was forwarded to the upstream
      "Scopebond policy denied delete_file", // destructive call denied
      "no (blocked before forwarding)", // and never forwarded upstream
    ],
  },
  {
    file: "examples/hook-map.mjs",
    expect: [
      "git.push", // Bash `git push` maps to the git.push taxonomy action
      "param ref fails pattern", // push to main denied by the protected-branch bound
      "param program fails pattern", // rm denied by the destructive-program bound
      "not_evaluated", // an unmapped tool is observed, never silently allowed
    ],
  },
  {
    file: "examples/verify-receipt-offline.mjs",
    expect: [
      "original receipt, JWK key: VALID", // WebCrypto verifier accepts the gateway's receipt
      "original receipt, PEM key: VALID", // same result with the PEM form of the key
      "tampered receipt (amount 500000 -> 9900000): INVALID", // edited payload fails
      "original receipt, another gateway's key: INVALID", // wrong attester key fails
    ],
  },
  {
    file: "examples/verify-anchor-inclusion.mjs",
    expect: [
      "algo=rfc9162-sha256", // the gateway emits a v2 (RFC 9162, signed) anchor
      "anchor signature: VALID", // Ed25519 anchor signature + kid binding
      "inclusion proof:  VALID", // the receipt is in the anchored tree
      "matches the server's: yes", // server proof equals the locally computed RFC 9162 path
      "wrong leaf_index (3): INVALID", // the same path at another position fails
      "anchor with tree_size edited: INVALID", // a modified anchor fails its signature
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
