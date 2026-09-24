import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mapClaudeToolUse, mapCursorEvent, createHookRuntime, scaffold,
  scrubSecrets, scrubParam, redactCommand, sha256,
} from "../dist/index.js";

// Secret-shaped values are built at runtime so no token literal sits in this source.
// A small deterministic generator keeps failures reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const pick = (rand, alphabet, n) => Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const HEX = "0123456789abcdef";
const B64 = ALNUM + "+/";
const B64URL = ALNUM + "_-";

// One generator per secret family the scrubber claims to recognize by shape.
const FAMILIES = {
  "GitHub classic token": (r) => "gh" + "pousr"[Math.floor(r() * 5)] + "_" + pick(r, ALNUM, 36),
  "GitHub fine-grained token": (r) => "github" + "_pat_" + pick(r, ALNUM, 22) + "_" + pick(r, ALNUM, 40),
  "GitLab token": (r) => "glpat" + "-" + pick(r, ALNUM, 20),
  "npm token": (r) => "npm" + "_" + pick(r, ALNUM, 36),
  "Slack token": (r) => "xox" + "bp"[Math.floor(r() * 2)] + "-" + pick(r, "0123456789", 12) + "-" + pick(r, ALNUM, 24),
  "Stripe key": (r) => "sk" + "_live_" + pick(r, ALNUM, 24),
  "OpenAI-style key": (r) => "sk" + "-" + pick(r, ALNUM, 40),
  "Anthropic-style key": (r) => "sk" + "-ant-api03-" + pick(r, B64URL, 60),
  "Google API key": (r) => "AI" + "za" + pick(r, B64URL, 35),
  "AWS access key id": (r) => "AK" + "IA" + pick(r, UPNUM, 16),
  "AWS secret access key": (r) => pick(r, B64, 40),
  "JWT": (r) => "ey" + "J" + pick(r, B64URL, 20) + "." + "ey" + "J" + pick(r, B64URL, 30) + "." + pick(r, B64URL, 43),
  "hex secret": (r) => pick(r, HEX, 64),
  "base64 blob": (r) => pick(r, B64, 64) + "==",
};

// Command shapes a coding agent actually produces. Each embeds the secret bare —
// with no `--token=` flag or `Bearer` label to help the scrubber.
const TEMPLATES = [
  (s) => `echo ${s}`,
  (s) => `gh auth login --with-token <<< ${s}`,
  (s) => `curl -s https://api.example.com/v1/items -H "X-Custom: ${s}"`,
  (s) => `git clone https://${s}@github.com/acme/widgets.git`,
  (s) => `docker login -p ${s} registry.example.com`,
  (s) => `${s}`,
  (s) => `printf '%s' "${s}" | some-cli login`,
  (s) => `cd /srv/app && ./deploy.sh ${s} --region us-east-1`,
];

// No recognizable part of the secret may survive: not the whole, and no 12-character
// window of it (a scrubber that emits "secret***" fails on the first window).
function assertAbsent(haystack, secret, label) {
  assert.equal(haystack.includes(secret), false, `${label}: the whole secret survived`);
  for (let i = 0; i + 12 <= secret.length; i++) {
    const window = secret.slice(i, i + 12);
    assert.equal(haystack.includes(window), false, `${label}: fragment "${window.slice(0, 4)}…" survived`);
  }
}

test("regression: a bare token is removed, not suffixed with a mask", () => {
  const token = FAMILIES["GitHub classic token"](rng(1));
  const out = scrubSecrets(`echo ${token}`);
  assert.equal(out, "echo ***");
  const aws = FAMILIES["AWS access key id"](rng(2));
  assert.equal(scrubSecrets(`aws configure set aws_access_key_id ${aws}`).endsWith(" ***"), true);
});

test("property: no secret family survives scrubbing in any command shape", () => {
  const rand = rng(20260919);
  for (const [family, make] of Object.entries(FAMILIES)) {
    for (let i = 0; i < 25; i++) {
      const secret = make(rand);
      for (const [t, template] of TEMPLATES.entries()) {
        const command = template(secret);
        const label = `${family} / template ${t}`;
        assertAbsent(scrubSecrets(command), secret, label);
        // headLen larger than any command here, so truncation cannot hide a leak.
        assertAbsent(redactCommand(command, 4096), secret, `${label} / redactCommand`);
        assertAbsent(JSON.stringify(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } })), secret, `${label} / Claude intent`);
        assertAbsent(JSON.stringify(mapCursorEvent("beforeShellExecution", { command })), secret, `${label} / Cursor intent`);
      }
    }
  }
});

test("labelled secrets: flags, headers, credential assignments and URL userinfo keep the label and drop the value", () => {
  const rand = rng(7);
  const weak = () => pick(rand, ALNUM, 14); // too short and plain to be caught by shape
  const cases = [
    (s) => [`mysql --password=${s} -e 'select 1'`, "--password="],
    (s) => [`mysql --password ${s}`, "--password"],
    (s) => [`tool --api-key "${s} with spaces"`, "--api-key"],
    (s) => [`curl -u admin:${s} https://example.com`, "-u"],
    (s) => [`curl -H 'Authorization: Bearer ${s}' https://example.com`, "Authorization: Bearer"],
    (s) => [`curl -H "Authorization: Basic ${s}" https://example.com`, "Authorization: Basic"],
    (s) => [`curl -H "X-API-Key: ${s}" https://example.com`, "X-API-Key:"],
    (s) => [`GH_TOKEN=${s} gh api user`, "GH_TOKEN="],
    (s) => [`export AWS_SECRET_ACCESS_KEY=${s}`, "AWS_SECRET_ACCESS_KEY="],
    (s) => [`DATABASE_PASSWORD=${s} npm run migrate`, "DATABASE_PASSWORD="],
    (s) => [`git clone https://deploy:${s}@git.example.com/acme/app.git`, "https://"],
    // N-032: attached -p/-u values and custom secret-named headers
    (s) => [`mysql -p${s} -e 'select 1'`, "-p"],
    (s) => [`psql -u${s} -h db.internal`, "-u"],
    (s) => [`curl -H 'X-Custom-Secret: ${s}' https://example.com`, "X-Custom-Secret:"],
    (s) => [`curl -H "My-Token: ${s}" https://example.com`, "My-Token:"],
  ];
  for (const make of cases) {
    const secret = weak();
    const [command, label] = make(secret);
    const out = scrubSecrets(command);
    assert.equal(out.includes(secret), false, `value survived in: ${label}`);
    assert.equal(out.includes(label), true, `label was lost: ${label}`);
  }
});

test("N-032: a space-separated -p operand is not masked by the attached-value rule", () => {
  // `mkdir -p dir` uses -p as an ordinary flag with a space-separated operand; the
  // attached-value rule targets only `-p<value>` with no space, so the operand stays.
  assert.equal(scrubSecrets("mkdir -p src/deep/dir"), "mkdir -p src/deep/dir");
  assert.equal(scrubSecrets("tar -c -p -f a.tgz src"), "tar -c -p -f a.tgz src");
});

test("N-031: the command digest is taken over the scrubbed text, not the secret-bearing original", () => {
  const rand = rng(31);
  const password = pick(rand, ALNUM, 20);
  const command = `mysql -p${password} -e 'select 1'`;
  const redacted = redactCommand(command, 4096);
  // The digest embedded in the redacted string equals the hash of the scrubbed command,
  // so an attacker holding the receipt cannot brute-force the password from the digest.
  const scrubbed = scrubSecrets(command);
  assert.equal(redacted.includes(sha256(scrubbed)), true, "digest is not over the scrubbed text");
  assert.equal(redacted.includes(sha256(command)), false, "digest still leaks the original");
});

test("a private key block is removed whole, even when unterminated", () => {
  const body = pick(rng(3), B64, 200);
  const begin = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";
  const end = "-----END OPENSSH " + "PRIVATE KEY-----";
  assertAbsent(scrubSecrets(`echo "${begin}\n${body}\n${end}" > id`), body, "terminated");
  assertAbsent(scrubSecrets(`echo "${begin}\n${body}`), body, "unterminated");
});

test("structured parameters never carry a secret: program, push remote and ref, fetch path and host", () => {
  const rand = rng(11);
  const token = FAMILIES["GitHub classic token"](rand);
  const weak = pick(rand, ALNUM, 14);

  // A bare credential assignment becomes the first word of the command.
  const shell = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: `GH_TOKEN=${token} gh api user` } });
  assertAbsent(JSON.stringify(shell), token, "program");

  const [push] = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: `git push https://ci:${weak}@github.com/acme/app.git feature/x` } });
  assert.equal(push.intent.action_type, "git.push");
  assert.equal(JSON.stringify(push).includes(weak), false, "push remote userinfo");
  assert.equal(push.intent.params.ref, "feature/x");

  const pushToken = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: `git push https://${token}@github.com/acme/app.git main` } });
  assertAbsent(JSON.stringify(pushToken), token, "push remote token");

  const [fetchPath] = mapClaudeToolUse({ tool_name: "WebFetch", tool_input: { url: `https://hooks.example.com/services/${token}/send?key=${weak}` } });
  assertAbsent(JSON.stringify(fetchPath), token, "fetch path");
  assert.equal(JSON.stringify(fetchPath).includes(weak), false, "fetch query string");
  assert.equal(fetchPath.intent.params.host, "hooks.example.com");

  const badUrl = mapClaudeToolUse({ tool_name: "WebFetch", tool_input: { url: `not a url ${token}` } });
  assertAbsent(JSON.stringify(badUrl), token, "unparseable url");
});

test("ordinary values a policy matches on are left alone", () => {
  assert.equal(scrubParam("origin"), "origin");
  assert.equal(scrubParam("feature/a-long-branch-name-with-many-words-in-it-for-a-ticket"), "feature/a-long-branch-name-with-many-words-in-it-for-a-ticket");
  assert.equal(scrubParam("/acme/app/commit/0123456789abcdef0123456789abcdef01234567"), "/acme/app/commit/0123456789abcdef0123456789abcdef01234567");
  assert.equal(scrubParam("npm"), "npm");
  const [m] = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "npm test -- --watch=false" } });
  assert.equal(m.intent.params.program, "npm");
  assert.match(m.intent.params.command, /^npm test -- --watch=false \(sha256:/);
  assert.equal(scrubSecrets("NODE_ENV=production PORT=8080 node server.js"), "NODE_ENV=production PORT=8080 node server.js");
});

test("scrubbing stays fast on a long adversarial command", () => {
  const started = process.hrtime.bigint();
  scrubSecrets("A_".repeat(200_000) + " " + "--token ".repeat(20_000) + "=".repeat(100_000));
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000, `took ${ms.toFixed(0)} ms`);
});

// End to end: what is signed, stored on disk and queued for the Cloud export.
test("no secret reaches the signed receipt, the local store or the Cloud export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-hook-min-"));
  scaffold(dir);
  writeFileSync(join(dir, "policy.json"), JSON.stringify({
    vocabulary_version: "1.0", policy_id: "min", version: 1,
    clauses: [{ id: "all", type: "action_allowlist", mode: "enforce", action_types: ["shell.exec", "git.push", "net.fetch"] }],
  }));
  const exported = [];
  const runtime = createHookRuntime({
    policyPath: join(dir, "policy.json"), keyPath: join(dir, "agent.key"),
    attesterPath: join(dir, "attester.key"), dbPath: join(dir, "receipts.db"),
    cloud: {
      connection: { url: "https://cloud.example.test", credential: "sbm_test", attester_kid: "k" },
      fetch: async (_url, init) => { exported.push(String(init?.body ?? "")); return new Response(JSON.stringify({ accepted: 1 }), { status: 202 }); },
      flushTimeoutMs: 2000,
    },
  });
  const rand = rng(99);
  const secrets = Object.values(FAMILIES).map((make) => make(rand));
  const receipts = [];
  for (const [i, secret] of secrets.entries()) {
    const command = TEMPLATES[i % TEMPLATES.length](secret);
    const d = await runtime.evaluate(mapClaudeToolUse({ tool_name: "Bash", tool_input: { command } }));
    receipts.push(JSON.stringify(d.receipt));
  }
  await runtime.flush?.();
  const onDisk = readdirSync(dir).filter((f) => f.includes(".db")).map((f) => readFileSync(join(dir, f)).toString("latin1")).join("\n");
  for (const secret of secrets) {
    assertAbsent(receipts.join("\n"), secret, "signed receipt");
    assertAbsent(onDisk, secret, "local store and outbox files");
    assertAbsent(exported.join("\n"), secret, "Cloud export body");
  }
});
