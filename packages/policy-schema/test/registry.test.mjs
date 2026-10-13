import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { actionRegistry, TAXONOMY_VERSION, getActionType, validateActionParams } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../vectors/action-taxonomy.json"), "utf8"));

const PARAM_TYPES = new Set(["string", "integer", "boolean", "array", "enum"]);
const RISK_CLASSES = new Set(["routine", "sensitive", "destructive", "money", "identity"]);

// Each action carries the taxonomy version that introduced it; the registry carries the current one.
const KNOWN_VERSIONS = ["1.0", "1.1"];
const FIRST_TYPES = ["shell.exec", "file.read", "file.write", "git.push", "package.install", "net.fetch", "http.call", "mcp.tool.call", "pr.open", "pr.merge", "deploy.release"];

test("the registry is internally consistent", () => {
  assert.equal(actionRegistry.taxonomy_version, "1.1");
  assert.equal(TAXONOMY_VERSION, "1.1");
  const ids = actionRegistry.actions.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "action ids are unique");
  for (const a of actionRegistry.actions) {
    assert.ok(KNOWN_VERSIONS.includes(a.taxonomy_version), `${a.id} carries a known taxonomy version`);
    assert.equal(a.taxonomy_version, FIRST_TYPES.includes(a.id) ? "1.0" : "1.1", `${a.id} carries the version that introduced it`);
    assert.ok(RISK_CLASSES.has(a.risk_class), `${a.id} has a known risk_class`);
    assert.ok(Array.isArray(a.parameters) && a.parameters.length > 0, `${a.id} declares parameters`);
    const names = a.parameters.map((p) => p.name);
    assert.equal(new Set(names).size, names.length, `${a.id} parameter names are unique`);
    for (const p of a.parameters) {
      assert.ok(PARAM_TYPES.has(p.type), `${a.id}.${p.name} has a known type`);
      assert.equal(typeof p.required, "boolean", `${a.id}.${p.name} required is boolean`);
      assert.equal(typeof p.boundable, "boolean", `${a.id}.${p.name} boundable is boolean`);
      if (p.type === "enum") assert.ok(Array.isArray(p.enum) && p.enum.length > 0, `${a.id}.${p.name} enum defines values`);
      else assert.equal(p.enum, undefined, `${a.id}.${p.name} only enum types carry an enum`);
    }
  }
});

test("taxonomy 1.1 keeps every 1.0 type and adds the target types", () => {
  const ids = actionRegistry.actions.map((a) => a.id);
  for (const id of FIRST_TYPES) assert.ok(ids.includes(id), `${id} is still registered`);
  for (const id of ["cloud.resource.create", "cloud.resource.modify", "cloud.resource.delete", "k8s.apply", "k8s.delete", "k8s.exec", "db.migrate", "db.exec", "secret.write", "iam.change", "communication.send", "work.item.create", "work.item.update"]) {
    assert.ok(ids.includes(id), `${id} is registered`);
  }
  const risk = Object.fromEntries(actionRegistry.actions.map((a) => [a.id, a.risk_class]));
  assert.equal(risk["cloud.resource.delete"], "destructive");
  assert.equal(risk["cloud.resource.modify"], "sensitive");
  assert.equal(risk["cloud.resource.create"], "sensitive");
  assert.equal(risk["k8s.delete"], "destructive");
  assert.equal(risk["k8s.exec"], "destructive");
  assert.equal(risk["k8s.apply"], "sensitive");
  assert.equal(risk["db.migrate"], "destructive");
  assert.equal(risk["secret.write"], "sensitive");
  assert.equal(risk["iam.change"], "identity");
  assert.equal(risk["communication.send"], "sensitive");
  assert.equal(risk["work.item.create"], "routine");
  // The deployment type the hook now also derives keeps its 1.0 shape.
  assert.deepEqual(getActionType("deploy.release").parameters.map((p) => p.name), ["repo", "environment", "sha"]);
});

test("getActionType resolves registered ids and rejects unknown ones", () => {
  assert.equal(getActionType("git.push")?.id, "git.push");
  assert.equal(getActionType("not.a.real.type"), undefined);
});

test("every registry action has a matching schema vector", () => {
  const covered = new Set(vectors.schema_cases.map((c) => c.action_type));
  for (const a of actionRegistry.actions) {
    assert.ok(covered.has(a.id), `${a.id} is exercised by at least one schema vector`);
  }
});

for (const c of vectors.schema_cases) {
  test(`schema vector: ${c.action_type} ${c.valid ? "valid" : "invalid"}${c.reason ? ` (${c.reason})` : ""}`, () => {
    const result = validateActionParams(c.action_type, c.params);
    assert.equal(result.valid, c.valid, `${c.action_type}: ${JSON.stringify(result.errors)}`);
    if (c.known !== undefined) assert.equal(result.known, c.known, `${c.action_type}: known`);
    if (!c.valid) assert.ok(result.errors.length > 0, `${c.action_type}: invalid cases report an error`);
  });
}
