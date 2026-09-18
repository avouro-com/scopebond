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

test("the registry is internally consistent", () => {
  assert.equal(actionRegistry.taxonomy_version, "1.0");
  assert.equal(TAXONOMY_VERSION, "1.0");
  const ids = actionRegistry.actions.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "action ids are unique");
  for (const a of actionRegistry.actions) {
    assert.equal(a.taxonomy_version, actionRegistry.taxonomy_version, `${a.id} carries the registry version`);
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
