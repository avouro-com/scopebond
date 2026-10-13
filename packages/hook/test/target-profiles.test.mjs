// Target profiles: every fixture in test/profiles/*.json is a command line and the exact taxonomy actions the hook derives
// from it (none, for the negative cases). Digests are compared through the same keyed helper under a fixed test key, so a
// fixture names the parts a digest covers, never a digest value. A fixture's `{{SECRET}}` is replaced by a secret-shaped
// value built here at run time (no such value is ever committed), and no derived action may carry it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { validateActionParams } from "@scopebond/policy-schema/registry";
import { deriveTargetOperations, targetDigest, TARGET_TOOLS, useDigestKey, toolOf, envOfName, mapClaudeToolUse } from "../dist/index.js";
import { decomposeShell } from "../dist/shell.js";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "profiles");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
useDigestKey("5a".repeat(32));

// A value shaped like a provider token, assembled at run time.
const SECRET = ["sk", "live", randomBytes(12).toString("hex")].join("_");

const resolve = (value) => {
  if (Array.isArray(value)) return value.map(resolve);
  if (value && typeof value === "object") {
    if (Array.isArray(value.$digest)) return targetDigest(...value.$digest);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v)]));
  }
  return value;
};

const derive = (command) => decomposeShell(command).flatMap((sc) => deriveTargetOperations(sc));

test("there is a fixture file for each of the first ten tools, and every known tool appears in one", () => {
  for (const name of ["aws", "gcloud", "az", "kubectl", "helm", "terraform", "wrangler", "vercel", "fly", "gh"]) {
    assert.ok(files.includes(`${name}.json`), `${name}.json exists`);
  }
  const used = new Set();
  for (const file of files) {
    for (const c of JSON.parse(readFileSync(join(dir, file), "utf8")).cases) {
      for (const sc of decomposeShell(c.command.replaceAll("{{SECRET}}", "x"))) { const t = toolOf(sc); if (t) used.add(t.tool); }
    }
  }
  for (const tool of TARGET_TOOLS) {
    // `rake` and `sequelize` stand for their siblings (`rails`, `sequelize-cli`), which the fixtures use.
    if (tool === "sequelize") continue;
    assert.ok(used.has(tool), `${tool} is exercised by a fixture`);
  }
});

for (const file of files) {
  const fixture = JSON.parse(readFileSync(join(dir, file), "utf8"));
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0, `${file} has cases`);
  assert.ok(fixture.cases.some((c) => c.expect.length === 0), `${file} has a negative case`);
  for (const c of fixture.cases) {
    test(`${file}: ${c.name}`, () => {
      const command = c.command.replaceAll("{{SECRET}}", SECRET);
      const actual = derive(command);
      const via = c.via ?? fixture.via ?? fixture.tool;
      const expected = c.expect.map((e) => ({ action_type: e.action_type, params: { ...resolve(e.params), via, derived_from: "shell.exec" } }));
      assert.deepEqual(actual, expected, command);
      for (const op of actual) {
        const v = validateActionParams(op.action_type, op.params);
        assert.ok(v.known && v.valid, `${op.action_type} is a valid taxonomy action: ${v.errors.join("; ")}`);
      }
      assert.ok(!JSON.stringify(actual).includes(SECRET), "a secret value never reaches a derived action");
      // Deterministic: the same command derives the same actions.
      assert.deepEqual(derive(command), actual);
    });
  }
}

test("the mapper records derived actions beside the command, in order, marked derived", () => {
  const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "aws s3 rb s3://acme-old --force && kubectl delete ns/feature-x" } });
  assert.deepEqual(mapped.map((m) => m.intent.action_type), ["shell.exec", "cloud.resource.delete", "shell.exec", "k8s.delete"]);
  assert.deepEqual(mapped.map((m) => m.derived === true), [false, true, false, true]);
  assert.equal(mapped[0].intent.params.program, "aws", "the command's own intent is unchanged");
  assert.ok(mapped.every((m) => m.evaluated));
});

test("a command the profiles do not know maps exactly as before", () => {
  const mapped = mapClaudeToolUse({ tool_name: "Bash", tool_input: { command: "pnpm test && git status" } });
  assert.deepEqual(mapped.map((m) => m.intent.action_type), ["shell.exec", "shell.exec"]);
  assert.ok(mapped.every((m) => m.derived === undefined));
});

test("an environment is read from a name's words, and two different ones read as none", () => {
  assert.equal(envOfName("acme-prod"), "production");
  assert.equal(envOfName("infra/envs/staging"), "staging");
  assert.equal(envOfName("dev.tfvars"), "development");
  assert.equal(envOfName("devops"), undefined, "a word that only starts like one is not one");
  assert.equal(envOfName("prod-to-dev-copy"), undefined, "two environments named: none");
  assert.equal(envOfName(undefined), undefined);
});

test("a name known only at run time is never digested as a name", () => {
  const [op] = derive("aws lambda delete-function --function-name \"$FN\"");
  assert.equal(op.action_type, "cloud.resource.delete");
  assert.equal(op.params.resource_digest, undefined);
  const [secret] = derive("gh secret set \"$(echo NAME)\" --body x");
  assert.equal(secret.action_type, "secret.write");
  assert.equal(secret.params.name_digest, undefined);
});

test("an unreadable command derives nothing", () => {
  for (const command of ["eval \"$CMD\"", "$TOOL s3 rm s3://b/k", "aws", "kubectl", "terraform"]) {
    assert.deepEqual(derive(command), [], command);
  }
});
