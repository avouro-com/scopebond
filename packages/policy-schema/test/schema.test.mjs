import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  policySchema, actionSchema, receiptSchema, legacyReceiptSchema, CLAUSE_TYPES, CLAUSE_MODES,
  VOCABULARY_VERSION, EVIDENCE_VERSION, CANONICALIZATION, EXECUTION_STATES, REALTIME_RESULTS,
  canonical,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(here, "../vectors/example-policy.json"), "utf8"));
const evidence = JSON.parse(readFileSync(join(here, "../vectors/evidence-contract.json"), "utf8"));
const canonicalization = JSON.parse(readFileSync(join(here, "../vectors/canonicalization.json"), "utf8"));

test("schemas parse and are 2020-12", () => {
  assert.equal(policySchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(actionSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(receiptSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

test("action schema is closed and requires an action type", () => {
  assert.equal(actionSchema.additionalProperties, false);
  assert.deepEqual(actionSchema.required, ["action_type"]);
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
  assert.equal(receiptSchema.properties.payload.properties.evidence_version.const, EVIDENCE_VERSION);
  assert.equal(receiptSchema.properties.payload.properties.canonicalization.const, CANONICALIZATION);
  assert.deepEqual(receiptSchema.properties.payload.properties.execution.properties.state.enum, EXECUTION_STATES);
  assert.ok(receiptSchema.properties.payload.required.includes("authorization"));
  assert.deepEqual(receiptSchema.$defs.identity.properties.alg, { const: "Ed25519" });
  assert.equal(receiptSchema.$defs.intentAuthorization.additionalProperties, false);
  assert.equal(receiptSchema.$defs.approval.properties.decision.const, "approve");
  assert.equal(legacyReceiptSchema.properties.payload.properties.type.const, "scopebond:receipt");
  assert.deepEqual(evidence.execution_states, EXECUTION_STATES);
  assert.deepEqual(evidence.realtime_results, REALTIME_RESULTS);
  assert.equal(evidence.version, EVIDENCE_VERSION);
});

test("canonical serialization matches the shared vectors", () => {
  assert.equal(canonicalization.canonicalization, CANONICALIZATION);
  for (const vector of canonicalization.cases) {
    assert.equal(canonical(vector.value), vector.canonical, vector.name);
  }
  assert.throws(() => canonical({ missing: undefined }), /undefined/);
  assert.throws(() => canonical([, 1]), /sparse/);
  assert.throws(() => canonical({ invalid: Number.NaN }), /non-finite/);
});
