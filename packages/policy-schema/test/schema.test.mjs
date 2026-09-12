import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { policySchema, receiptSchema, CLAUSE_TYPES, CLAUSE_MODES, VOCABULARY_VERSION } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(here, "../vectors/example-policy.json"), "utf8"));

test("schemas parse and are 2020-12", () => {
  assert.equal(policySchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(receiptSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("policy schema is closed at the top level", () => {
  assert.equal(policySchema.additionalProperties, false);
});

test("every clause type in $defs is exported in CLAUSE_TYPES", () => {
  for (const t of CLAUSE_TYPES) {
    assert.ok(policySchema.$defs[t], `schema is missing $def for clause type "${t}"`);
  }
});

test("example vector declares the current vocabulary version", () => {
  assert.equal(example.vocabulary_version, VOCABULARY_VERSION);
});

test("example vector uses only known clause types and modes", () => {
  for (const c of example.clauses) {
    assert.ok(CLAUSE_TYPES.includes(c.type), `unknown clause type ${c.type}`);
    if (c.mode) assert.ok(CLAUSE_MODES.includes(c.mode), `unknown mode ${c.mode}`);
    assert.ok(c.id, "clause missing id");
  }
});

test("receipt schema fixes the namespaced type", () => {
  assert.equal(receiptSchema.properties.payload.properties.type.const, "scopebond:receipt");
});
