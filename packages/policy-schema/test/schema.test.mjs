import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  policySchema, actionSchema, receiptSchema, legacyReceiptSchema, CLAUSE_TYPES, CLAUSE_MODES,
  VOCABULARY_VERSION, EVIDENCE_VERSION, CANONICALIZATION, EXECUTION_STATES, REALTIME_RESULTS,
  canonical, RECEIPT_CONTEXT_KEYS, sessionBudgetsSchema, SESSION_BUDGET_DEFAULT_SECONDS, SESSION_BUDGET_MODES, RECEIPT_BUDGET_STATES,
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
  const holey = []; holey[1] = 1; // a sparse array: index 0 is a hole
  assert.throws(() => canonical(holey), /sparse/);
  assert.throws(() => canonical({ invalid: Number.NaN }), /non-finite/);
  // RFC 8785 canonicalizes valid Unicode; a lone surrogate is malformed and must be
  // refused, not silently escaped into a signable string (N-034).
  assert.throws(() => canonical("\uD800"), /lone surrogate/);          // high, unpaired
  assert.throws(() => canonical("\uDC00"), /lone surrogate/);          // low, unpaired
  assert.throws(() => canonical("a\uD834b"), /lone surrogate/);        // high mid-string
  assert.throws(() => canonical({ "\uD800": 1 }), /lone surrogate/);   // in an object key
  // a valid surrogate pair (an astral character) is accepted
  assert.equal(canonical("𝄞"), JSON.stringify("𝄞")); // U+1D11E 𝄞
  assert.equal(canonical("café ❤"), JSON.stringify("café ❤"));   // ordinary non-ASCII
});

// A JSON Schema (2020-12 subset) checker covering exactly the keywords the receipt schema uses, so the
// receipt-context vectors are checked against the whole receipt schema without a validator dependency.
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function typeMatches(type, value) {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return Number.isInteger(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    default: throw new Error(`unsupported type ${type}`);
  }
}
function conforms(schema, value, root = receiptSchema) {
  if (schema.$ref !== undefined) {
    const target = schema.$ref.slice(2).split("/").reduce((node, key) => node[key], root);
    if (!conforms(target, value, root)) return false;
  }
  if ("const" in schema && !sameJson(value, schema.const)) return false;
  if (schema.enum && !schema.enum.some((option) => sameJson(option, value))) return false;
  if (schema.type !== undefined && ![schema.type].flat().some((type) => typeMatches(type, value))) return false;
  if (typeof value === "string") {
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) return false;
    // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern comes from the receipt schema this package exports, the thing under test
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value)) {
    if (schema.items && !value.every((item) => conforms(schema.items, item, root))) return false;
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false;
  }
  if (typeMatches("object", value)) {
    for (const key of schema.required ?? []) if (!(key in value)) return false;
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) { if (!conforms(schema.properties[key], item, root)) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  if (schema.allOf && !schema.allOf.every((sub) => conforms(sub, value, root))) return false;
  if (schema.oneOf && schema.oneOf.filter((sub) => conforms(sub, value, root)).length !== 1) return false;
  if (schema.not && conforms(schema.not, value, root)) return false;
  if (schema.if) {
    const branch = conforms(schema.if, value, root) ? schema.then : schema.else;
    if (branch && !conforms(branch, value, root)) return false;
  }
  return true;
}
const withContext = (context) => {
  const receipt = structuredClone(evidence.receipt_context.receipt);
  receipt.payload.context = context;
  return receipt;
};

test("receipt context is an optional, closed payload member with the documented keys", () => {
  const payload = receiptSchema.properties.payload;
  const context = payload.properties.context;
  assert.ok(context, "payload.properties.context exists");
  assert.equal(payload.required.includes("context"), false, "context is optional");
  assert.equal(context.type, "object");
  assert.equal(context.additionalProperties, false);
  assert.equal(context.required, undefined, "every member is optional");
  assert.deepEqual(Object.keys(context.properties), [...RECEIPT_CONTEXT_KEYS]);
  for (const key of RECEIPT_CONTEXT_KEYS) assert.deepEqual(context.properties[key].type, ["string", "null"], `${key} is a nullable string`);
});

test("a receipt without context is unchanged and still valid", () => {
  const receipt = evidence.receipt_context.receipt;
  assert.equal("context" in receipt.payload, false);
  assert.equal(conforms(receiptSchema, receipt), true);
  // The checker is not vacuous: an unknown payload key is refused.
  assert.equal(conforms(receiptSchema, { ...receipt, payload: { ...receipt.payload, extra: 1 } }), false);
});

test("receipt context vectors: valid contexts validate, invalid ones (unknown keys included) do not", () => {
  for (const vector of evidence.receipt_context.valid) assert.equal(conforms(receiptSchema, withContext(vector.context)), true, vector.name);
  for (const vector of evidence.receipt_context.invalid) assert.equal(conforms(receiptSchema, withContext(vector.context)), false, vector.name);
  assert.ok(evidence.receipt_context.invalid.some((vector) => vector.name === "unknown-key"));
});

test("a context object canonicalizes like any other member (RFC 8785 key order)", () => {
  const vector = canonicalization.cases.find((c) => c.name === "receipt-context-member-order");
  assert.ok(vector);
  assert.equal(canonical(vector.value), vector.canonical);
  const receipt = withContext(evidence.receipt_context.valid[0].context);
  const text = canonical(receipt.payload);
  assert.ok(text.includes('"context":{"branch":"main","harness":"claude","harness_version":null,"model":"example-model-1"'), text);
});

const sessionVectors = JSON.parse(readFileSync(join(here, "../vectors/session-budgets.json"), "utf8"));

test("session budgets: a closed schema in the gateway's budget words, scope session only", () => {
  const budget = sessionBudgetsSchema.$defs.sessionBudget;
  assert.equal(sessionBudgetsSchema.type, "array");
  assert.equal(budget.additionalProperties, false);
  assert.equal(sessionBudgetsSchema.$defs.limit.additionalProperties, false);
  assert.deepEqual(budget.properties.scope, { const: "session" });
  assert.deepEqual(budget.properties.mode.enum, [...SESSION_BUDGET_MODES]);
  for (const key of ["budget_id", "limits", "mode", "version", "expires_at", "session_id"]) assert.ok(budget.required.includes(key), key);
  assert.equal(budget.required.includes("source"), false);
  assert.equal(SESSION_BUDGET_DEFAULT_SECONDS, 7200);
});

test("session budget vectors: valid lists validate, invalid ones (unknown keys included) do not", () => {
  for (const vector of sessionVectors.valid) assert.equal(conforms(sessionBudgetsSchema, vector.session_budgets, sessionBudgetsSchema), true, vector.name);
  for (const vector of sessionVectors.invalid) assert.equal(conforms(sessionBudgetsSchema, vector.session_budgets, sessionBudgetsSchema), false, vector.name);
  assert.ok(sessionVectors.invalid.some((vector) => vector.name === "unknown-key"));
});

test("receipt budget: an optional, closed payload member; valid ones validate, invalid ones do not", () => {
  const payload = receiptSchema.properties.payload;
  assert.equal(payload.required.includes("budget"), false);
  assert.equal(payload.properties.budget.additionalProperties, false);
  assert.deepEqual(payload.properties.budget.properties.state.enum, [...RECEIPT_BUDGET_STATES]);
  const withBudget = (budget) => {
    const receipt = structuredClone(evidence.receipt_context.receipt);
    receipt.payload.budget = budget;
    return receipt;
  };
  for (const vector of sessionVectors.receipt_budget.valid) assert.equal(conforms(receiptSchema, withBudget(vector.budget)), true, vector.name);
  for (const vector of sessionVectors.receipt_budget.invalid) assert.equal(conforms(receiptSchema, withBudget(vector.budget)), false, vector.name);
});
