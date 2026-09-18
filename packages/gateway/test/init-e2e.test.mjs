import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicKey } from "node:crypto";
import { createGateway, StaticPrincipalKeyRegistry, deriveKid, verifyReceipt } from "../dist/index.js";
import { createSigner, submit } from "@scopebond/sdk";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// Rebuild the gateway's principal-key authentication from the scaffolded registry,
// exactly as `scopebond-gateway serve` does from SCOPEBOND_PRINCIPAL_KEYS_FILE.
function authenticationFromRegistry(path) {
  const records = JSON.parse(readFileSync(path, "utf8")).map((row) => {
    const publicKeyPem = row.public_key_pem;
    const jwk = createPublicKey(publicKeyPem).export({ format: "jwk" });
    return {
      kid: deriveKid({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }),
      publicKeyPem, purposes: row.purposes, status: row.status,
    };
  });
  return { keys: new StaticPrincipalKeyRegistry(records) };
}

test("init → serve → SDK sign → submit → verify runs end to end against the scaffolded project", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-init-e2e-"));
  execFileSync(process.execPath, [cli, "init"], { cwd: dir, stdio: "pipe" });

  // Build the gateway from the scaffolded policy + registry (the `serve` wiring).
  const policy = JSON.parse(readFileSync(join(dir, "scopebond.policy.json"), "utf8"));
  const gateway = createGateway({ policy, authentication: authenticationFromRegistry(join(dir, "principal-keys.json")) });

  // The agent signs with the scaffolded key — the exact key the policy trusts.
  const agent = createSigner({ privateKeyPem: readFileSync(join(dir, "scopebond-agent.key"), "utf8") });
  const keyClause = policy.clauses.find((c) => c.type === "key_policy");
  assert.deepEqual(keyClause.active_keys, [agent.kid], "the key_policy clause trusts exactly the scaffolded agent key");

  // `submit()` posts the full signed envelope to /v1/evaluate; route it in-process.
  const fetchImpl = (url, init) => gateway.app.request(url, init);

  // 1. An in-policy action is allowed and its receipt verifies offline.
  const inPolicy = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 500000 });
  const allowed = await submit("http://gateway.local", inPolicy, fetchImpl);
  assert.equal(allowed.allowed, true, allowed.reason);
  const verified = verifyReceipt(allowed.receipt, gateway.attester.publicKeyPem, [
    { kid: agent.kid, publicKeyPem: agent.publicKeyPem, purposes: ["agent"], status: "active" },
  ]);
  assert.equal(verified.valid, true, "the returned receipt's countersignature verifies");
  assert.equal(verified.fully_valid, true, "the agent intent signature verifies against the trusted key");

  // 2. The scaffolded $10,000 enforced cap holds: an over-limit action is denied, not executed.
  const overLimit = agent.sign({ action_type: "payout.create", asset: "USDC", amount: 2000000 });
  const denied = await submit("http://gateway.local", overLimit, fetchImpl);
  assert.equal(denied.allowed, false);
  assert.equal(denied.receipt.payload.executed, false);
  assert.equal(denied.receipt.payload.realtime_result, "deny");

  // 3. An action signed by a key the registry does not trust is never allowed.
  const stranger = createSigner();
  const forged = stranger.sign({ action_type: "payout.create", asset: "USDC", amount: 1 });
  const rejected = await submit("http://gateway.local", forged, fetchImpl);
  assert.notEqual(rejected.allowed, true, "an untrusted signer cannot obtain an allow");
});
