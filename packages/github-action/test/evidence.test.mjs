import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "@scopebond/policy-schema/canonical";
import { buildActionEvidence, checkResult } from "../dist/index.js";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const policy = {
  vocabulary_version: "1.0", policy_id: "gh", version: 1,
  clauses: [{ id: "no-prod", type: "action_allowlist", mode: "enforce", action_types: ["pr.merge"], param_bounds: { paths: { items: { pattern: "^(?!infra/prod/).*" }, match: "all" } } }],
};
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function run({ paths, sha = HEAD, login = "copilot-swe-agent[bot]", env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "sb-evidence-"));
  const event = { repository: { full_name: "acme/app" }, pull_request: { number: 7, base: { ref: "main" }, head: { ref: "agent/x", sha }, changed_files: paths.length, user: { login } } };
  writeFileSync(join(dir, "event.json"), JSON.stringify(event));
  writeFileSync(join(dir, "policy.json"), JSON.stringify(policy));
  writeFileSync(join(dir, "paths.txt"), paths.join("\n"));
  const out = join(dir, "evidence.json");
  let status = 0; let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [cli, "--event", join(dir, "event.json"), "--policy", join(dir, "policy.json"), "--paths-file", join(dir, "paths.txt"), "--policy-source", "workspace", "--evidence-out", out], {
      encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_OUTPUT: "", GITHUB_EVENT_PATH: "", GITHUB_RUN_ID: "555", GITHUB_RUN_ATTEMPT: "2", GITHUB_WORKFLOW: "policy", GITHUB_SHA: "f".repeat(40), RUNNER_ENVIRONMENT: "github-hosted", ...env },
    });
  } catch (e) { status = e.status; stdout = String(e.stdout ?? ""); }
  return { status, stdout, evidence: JSON.parse(readFileSync(out, "utf8")), dir };
}

test("an allowed pull request: the exact head commit, the policy digest and a success result", () => {
  const { status, evidence } = run({ paths: ["src/app.ts"] });
  assert.equal(status, 0);
  assert.equal(evidence.schema, "scopebond:action-evidence/v1");
  assert.equal(evidence.commit, HEAD);
  assert.equal(evidence.commit_exact, true);
  assert.equal(evidence.repository, "acme/app");
  assert.deepEqual(evidence.pull_request, { number: 7 });
  assert.equal(evidence.check.result, "success");
  assert.equal(evidence.check.decision, "allow");
  assert.equal(evidence.artifacts.policy_digest, sha256(canonical(policy)));
  assert.equal("receipt_hash" in evidence.artifacts, false, "no receipt without a key");
  assert.deepEqual(evidence.run, { id: "555", attempt: "2", workflow: "policy", workflow_sha: "f".repeat(40), runner_environment: "github-hosted" });
});

test("the evidence never claims independence and carries no path, key or source text", () => {
  const { evidence, dir } = run({ paths: ["src/secret-plan.ts"], env: { SCOPEBOND_ATTESTER_KEY: "" } });
  assert.equal(evidence.producer.independent, false);
  const text = readFileSync(join(dir, "evidence.json"), "utf8");
  assert.ok(!text.includes("secret-plan") && !text.includes("BEGIN"), "no path list, no key");
  assert.ok(!/trust|verified|independent_pass/i.test(Object.keys(evidence).join(" ")), "no field reads as a trust grant");
});

test("a denied pull request still writes its evidence, with a failure result, and the check still fails", () => {
  const { status, evidence } = run({ paths: ["infra/prod/main.tf"] });
  assert.equal(status, 1);
  assert.equal(evidence.check.result, "failure");
  assert.equal(evidence.check.decision, "deny");
  assert.deepEqual(evidence.check.rule_ids, ["no-prod"]);
});

test("a human pull request is neutral; a short head sha is reported as not exact", () => {
  const human = run({ paths: ["src/a.ts"], login: "alice" });
  assert.equal(human.evidence.check.result, "neutral");
  assert.equal(human.evidence.check.decision, "not_evaluated");
  const short = run({ paths: ["src/a.ts"], sha: "abc123def456abc1" });
  assert.equal(short.evidence.commit_exact, false, "not a full commit id, so it identifies no commit");
});

test("with a signing key the evidence names the boundary receipt by its source-receipt hash", () => {
  const keyPem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = mkdtempSync(join(tmpdir(), "sb-evidence-key-"));
  const receiptOut = join(dir, "receipt.json");
  const { evidence } = run({ paths: ["src/a.ts"], env: { SCOPEBOND_ATTESTER_KEY: keyPem, SCOPEBOND_RECEIPT_OUT: receiptOut } });
  const receipt = JSON.parse(readFileSync(receiptOut, "utf8"));
  assert.equal(evidence.artifacts.receipt_hash, sha256("scopebond:source-receipt/v1\n" + canonical(receipt)));
});

test("buildActionEvidence and checkResult are pure", () => {
  assert.equal(checkResult("allow"), "success");
  assert.equal(checkResult("deny"), "failure");
  assert.equal(checkResult("not_evaluated"), "neutral");
  const ctx = { event: "pull_request", repo: "a/b", base: "main", head: "x", headSha: HEAD, paths: [], filesChanged: 0, additions: 0, deletions: 0, actor: "x" };
  const evidence = buildActionEvidence({ ctx, policy, decision: { decision: "allow", reason: "ok", ruleIds: [], actionType: "pr.merge" }, version: "1.2.3", env: { GITHUB_RUN_ID: "1\u0000" } });
  assert.deepEqual(evidence.run, {}, "a value with a control character is dropped");
  assert.equal(evidence.producer.version, "1.2.3");
});
