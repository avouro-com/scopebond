// What a gateway receipt keeps of an action's parameters. Credential-shaped values are scrubbed inside string values, not
// only under credential-named keys, before the receipt is signed and exported; ordinary values and the money fields
// (asset, amount) stay as they are. Fake values only, assembled at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAttester, createGateway, minimizeIntentForEvidence, scrubSecretText, buildSummary } from "../dist/index.js";
import { createHash } from "node:crypto";

const tok = ["FAKE", "tok", "Qz9", "x".repeat(20)].join("");
const pw = ["Pw", "Fake", "Qz9", "hunter"].join("");
const bearer = ["FAKE", "bearer", "Qz9", "y".repeat(20)].join("");
const userinfo = ["fake", "Pass", "Qz7"].join("");

test("credential shapes inside string values are scrubbed; ordinary values are kept", () => {
  const intent = {
    action_type: "tool.http_get",
    asset: "USDC", amount: 250,
    params: {
      url: `https://api.example.test/v1/data?page=2&api_token=${tok}`,
      query: `ALTER USER app PASSWORD '${pw}'`,
      command: `curl -H "Authorization: Bearer ${bearer}" https://x.example.test`,
      remote: `https://bot:${userinfo}@git.example.test/repo.git`,
      nested: [{ note: `export API_KEY=${tok}` }],
      path: "src/index.ts", ref: "refs/heads/main", commit: "0123456789abcdef0123456789abcdef01234567",
    },
  };
  const { intent: out, redactedPaths } = minimizeIntentForEvidence(intent);
  const text = JSON.stringify(out);
  for (const secret of [tok, pw, bearer, userinfo]) assert.ok(!text.includes(secret), `${secret.slice(0, 8)}… left in ${text}`);
  assert.equal(out.params.url, "https://api.example.test/v1/data?page=2&api_token=***");
  assert.equal(out.params.path, "src/index.ts");
  assert.equal(out.params.ref, "refs/heads/main");
  assert.equal(out.params.commit, intent.params.commit, "a commit id is not a secret");
  assert.equal(out.asset, "USDC");
  assert.equal(out.amount, 250);
  assert.deepEqual(redactedPaths, ["intent.params.command", "intent.params.nested[0].note", "intent.params.query", "intent.params.remote", "intent.params.url"]);
  assert.equal(scrubSecretText("nothing to see here"), "nothing to see here");
});

test("a /v1/evaluate-style check signs the scrubbed copy; the decision still saw the original", async () => {
  const policy = { vocabulary_version: "1.0", policy_id: "p", version: 1, clauses: [{ id: "a", type: "action_allowlist", mode: "enforce", action_types: ["tool.run_sql"] }] };
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester: createAttester(), policy });
  const { receipt, allowed } = await gateway.check({ intent: { action_type: "tool.run_sql", params: { query: `ALTER USER app PASSWORD '${pw}'` } } });
  assert.ok(!JSON.stringify(receipt).includes(pw));
  assert.ok(receipt.payload.redaction.paths.includes("intent.params.query"));
  assert.notEqual(receipt.payload.action_ref.authorized_intent_hash, receipt.payload.action_ref.evidence_intent_hash);
  assert.equal(allowed, true);
});

test("a summary's folder digest is keyed, and stays the same for one key so folders still group", async () => {
  const attester = createAttester();
  const policy = { vocabulary_version: "1.0", policy_id: "p", version: 1, clauses: [{ id: "a", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec"] }] };
  let clock = Date.parse("2026-10-07T10:00:00Z");
  const gateway = createGateway({ authentication: { mode: "insecure-development" }, mode: "check_only", attester, policy, now: () => new Date(clock += 1000).toISOString() });
  const cwd = "/srv/work/sample-repo";
  const rs = [];
  for (const c of ["pnpm test", "pnpm lint"]) rs.push((await gateway.check({ intent: { action_type: "shell.exec", params: { command: c, program: "pnpm", cwd } } })).receipt);
  const key = "11".repeat(32);
  const window = { kind: "interval", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:05:00Z" };
  const a = await buildSummary(rs, { attester, window, notableCount: 0, digestKey: key });
  const b = await buildSummary(rs, { attester, window, notableCount: 0, digestKey: key });
  const plain = createHash("sha256").update(cwd, "utf8").digest("hex");
  assert.equal(a.payload.counts.length, 1, "one folder, one count line");
  assert.equal(a.payload.counts[0].count, 2);
  assert.notEqual(a.payload.counts[0].cwd_digest, plain, "the folder digest cannot be tested against a guessed path");
  assert.match(a.payload.counts[0].cwd_digest, /^[0-9a-f]{64}$/);
  assert.equal(a.payload.counts[0].cwd_digest, b.payload.counts[0].cwd_digest, "the same key gives the same digest");
  const other = await buildSummary(rs, { attester, window, notableCount: 0, digestKey: "22".repeat(32) });
  assert.notEqual(other.payload.counts[0].cwd_digest, a.payload.counts[0].cwd_digest);
});

test("a query credential after another parameter's value is still scrubbed", () => {
  assert.equal(scrubSecretText(`https://a.example/x?page=2;api_token=${tok}&b=1`), "https://a.example/x?page=2;api_token=***&b=1");
  assert.equal(scrubSecretText(`?X-Amz-Signature=${tok}#frag`), "?X-Amz-Signature=***#frag");
  assert.equal(scrubSecretText("?page=2&sort=asc"), "?page=2&sort=asc");
  assert.equal(scrubSecretText(`PASSWORD = '${pw}'`), "PASSWORD = '***'");
});

test("PowerShell secret shapes and a URL password holding '@' are scrubbed inside values; ordinary values stay", () => {
  for (const [value, secret] of [
    [`Set-Item -Path Env:DB_PASSWORD -Value '${pw}'`, pw],
    [`Set-Item Env:DB_PASSWORD '${pw}'`, pw],
    [`[Environment]::SetEnvironmentVariable('API_TOKEN', '${pw}', 'User')`, pw],
    [`setx DB_PASSWORD ${pw}`, pw],
    [`$token = '${tok}'`, tok],
    [`$DbPass = "${pw}"`, pw],
    [`$env:DB_PASSWORD = "${pw}"`, pw],
    [`$p = ConvertTo-SecureString -AsPlainText -Force -String '${pw}'`, pw],
    [`$p = '${pw}' | ConvertTo-SecureString -AsPlainText -Force`, pw],
    [`$headers = @{ Authorization = 'Bearer ${bearer}' }`, bearer],
    [`git push https://deploy:p4ss@${userinfo}@git.example.test/o/r.git main`, userinfo],
  ]) {
    const out = scrubSecretText(value);
    assert.ok(!out.includes(secret), `${secret.slice(0, 6)}… left in ${out}`);
  }
  assert.equal(scrubSecretText(`https://bot:a@${userinfo}@git.example.test/repo.git`), "https://***@git.example.test/repo.git");
  assert.equal(scrubSecretText(`https://${tok}@git.example.test/repo.git`), "https://***@git.example.test/repo.git", "a token alone as the user");
  assert.equal(scrubSecretText("https://api.example.test/find?email=a@example.test"), "https://api.example.test/find?email=a@example.test");
  assert.equal(scrubSecretText("$name = 'build'; Set-Item Env:PATH 'C:/tools'"), "$name = 'build'; Set-Item Env:PATH 'C:/tools'");
});

test("scrubbing stays linear on adversarial 50,000-character values", () => {
  const n = 50_000;
  for (const text of [
    "Set-Item Env:TOKEN ".repeat(n / 19),  // many Env: paths in one command
    "ConvertTo-SecureString ".repeat(n / 23),
    "'TOKEN', ".repeat(n / 10),             // many credential names given as arguments
    "a".repeat(n) + " = 'x'",              // a long name before "="
    "$token = @' ".repeat(n / 12),          // unclosed here-strings
    "'x' | ".repeat(n / 6) + "ConvertTo-SecureString",
    "://" + "a@".repeat(n / 2),            // URL userinfo with many "@"
    "?" + "token".repeat(n / 5),           // a parameter name full of credential words and no "="
    "password" + " ".repeat(n) + "x",     // a long run of spaces after a SQL password keyword
    "identified by" + " ".repeat(n) + "x",
    "--password" + " ".repeat(n),
    "-----BEGIN " + "A ".repeat(n / 2),
    "://a:" + "a".repeat(n),
  ]) {
    const started = performance.now();
    scrubSecretText(text);
    assert.ok(performance.now() - started < 250, `slow on ${JSON.stringify(text.slice(0, 20))}`);
  }
});
