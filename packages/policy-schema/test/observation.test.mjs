import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  observationSchema, OBSERVATION_DOMAIN, SOURCE_RECEIPT_DOMAIN, OBSERVATION_KINDS, OBSERVATION_LIMITS, OBSERVATION_VERSION,
  observationSigningInput, canonical,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, "../vectors/observation-contract.json"), "utf8"));

// A small JSON Schema (2020-12 subset) checker: exactly the keywords the observation
// schema uses. Enough to prove the closed shape without adding a validator dependency.
function validate(schema, value, root = observationSchema) {
  if (schema.$ref !== undefined) {
    const target = schema.$ref === "#" ? root : schema.$ref.slice(2).split("/").reduce((node, key) => node[key], root);
    return validate(target, value, root);
  }
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern comes from the observation schema this package exports, the thing under test
  if (schema.type === "string" && (typeof value !== "string" || value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false;
  if (schema.type === "integer" && (!Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  if (schema.type === "null" && value !== null) return false;
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.items && !value.every((item) => validate(schema.items, item, root))) return false;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    for (const key of schema.required ?? []) if (!(key in value)) return false;
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) { if (!validate(schema.properties[key], item, root)) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  if (schema.properties && schema.type === undefined && value && typeof value === "object") {
    for (const [key, sub] of Object.entries(schema.properties)) if (key in value && !validate(sub, value[key], root)) return false;
  }
  if (schema.oneOf && schema.oneOf.filter((alternative) => validate(alternative, value, root)).length !== 1) return false;
  return true;
}
const valid = (payload) => validate(observationSchema, payload);

const sha256hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const signatureValid = (pem, payload, signature) =>
  verify(null, Buffer.from(observationSigningInput(payload), "utf8"), createPublicKey(pem), Buffer.from(signature.value, "base64url"));

test("schema is 2020-12, closed, and covers exactly the ten observation kinds", () => {
  assert.equal(observationSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(observationSchema.additionalProperties, false);
  assert.equal(observationSchema.properties.version.const, OBSERVATION_VERSION);
  assert.deepEqual(observationSchema.properties.kind.enum, [...OBSERVATION_KINDS]);
  assert.equal(OBSERVATION_KINDS.length, 10);
  for (const kind of OBSERVATION_KINDS) {
    const data = observationSchema.$defs[`data_${kind}`];
    assert.ok(data?.oneOf?.length > 0, `data_${kind} has event variants`);
    for (const variant of data.oneOf) assert.equal(variant.additionalProperties, false, `${kind}.${variant.properties.event.const} is closed`);
  }
});

test("every typed operation variant is a closed object tagged by type", () => {
  const types = observationSchema.$defs.operation.oneOf.map((ref) => observationSchema.$defs[ref.$ref.split("/").pop()]);
  assert.deepEqual(types.map((t) => t.properties.type.const).sort(), [
    "browser", "cloudflare_resource", "communication", "database", "deploy", "evidence_delete", "file", "git", "github_resource", "mcp", "network", "package", "privilege", "shell", "visibility",
  ]);
  for (const t of types) {
    assert.equal(t.additionalProperties, false);
    for (const field of ["resource_id", "environment_class", "reference_set_version", "request_digest", "digest_key_generation"]) assert.ok(t.required.includes(field), `${t.properties.type.const} requires ${field}`);
  }
});

test("constants and limits match the contract", () => {
  assert.equal(OBSERVATION_DOMAIN, "scopebond:observation/v1\n");
  assert.equal(SOURCE_RECEIPT_DOMAIN, "scopebond:source-receipt/v1\n");
  assert.deepEqual(OBSERVATION_LIMITS, { maxBatchItems: 100, maxObservationBytes: 16384, maxBatchBodyBytes: 1048576 });
  assert.equal(vectors.domain, OBSERVATION_DOMAIN);
  assert.equal(vectors.source_receipt_domain, SOURCE_RECEIPT_DOMAIN);
});

test("positive vectors: valid shape, canonical bytes, observation_hash and signature all reproduce", () => {
  assert.ok(vectors.positive.length >= 4);
  for (const v of vectors.positive) {
    assert.ok(valid(v.payload), `${v.name} matches the schema`);
    assert.equal(canonical(v.payload), v.canonical, `${v.name} canonical`);
    assert.equal(observationSigningInput(v.payload), OBSERVATION_DOMAIN + v.canonical);
    assert.equal(sha256hex(OBSERVATION_DOMAIN + v.canonical), v.observation_hash, `${v.name} hash`);
    assert.equal(v.signature.alg, "Ed25519");
    assert.match(v.signature.value, /^[A-Za-z0-9_-]{86}$/);
    assert.ok(valid_signed(v), `${v.name} wrapper matches the schema`);
    assert.ok(signatureValid(vectors.public_key_pem, v.payload, v.signature), `${v.name} signature`);
  }
});

function valid_signed(v) {
  return validate({ $ref: "#/$defs/signed_observation" }, { payload: v.payload, signature: v.signature });
}

test("negative vectors fail exactly as declared", () => {
  const names = new Set();
  for (const n of vectors.negative) {
    names.add(n.name);
    if ("schema_valid" in n.expect) assert.equal(valid(n.payload), n.expect.schema_valid, n.name);
    if (n.expect.hash_differs) {
      const original = vectors.positive.find((v) => v.name === "session_start");
      assert.notEqual(sha256hex(observationSigningInput(n.payload)), original.observation_hash, n.name);
    }
    if ("signature_valid" in n.expect) assert.equal(signatureValid(n.public_key_pem ?? vectors.public_key_pem, n.payload, n.signature), n.expect.signature_valid, n.name);
  }
  for (const required of ["tampered_payload", "wrong_signer", "signature_without_domain", "unknown_field", "unknown_nested_field", "unknown_version", "unknown_event"]) assert.ok(names.has(required), `${required} vector present`);
});

test("schema rejects oversize collections, bad digests, non-UTC timestamps and forbidden tenant claims", () => {
  const base = vectors.positive.find((v) => v.name === "session_start").payload;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const tooMany = clone(vectors.positive.find((v) => v.name === "tool_intent_file_write").payload);
  tooMany.data.operation.target_ids = Array.from({ length: 101 }, (_, i) => `t-${i}`);
  assert.equal(valid(tooMany), false);
  const badDigest = clone(vectors.positive.find((v) => v.name === "tool_intent_file_write").payload);
  badDigest.data.operation.request_digest = "plain-text";
  assert.equal(valid(badDigest), false);
  const offset = clone(base); offset.occurred_at = "2026-01-01T00:00:00+02:00";
  assert.equal(valid(offset), false);
  for (const claim of ["tenant_id", "agent_id", "organization_id", "owner"]) assert.equal(valid({ ...clone(base), [claim]: "x" }), false, claim);
  const upperUuid = clone(base); upperUuid.observation_id = upperUuid.observation_id.toUpperCase().replace(/^(.{8})/, "AAAAAAAA");
  assert.equal(valid(upperUuid), false);
});

test("source_receipt_hash vector is the domain-separated hash of the full envelope", () => {
  assert.equal(sha256hex(SOURCE_RECEIPT_DOMAIN + canonical(vectors.source_receipt_hash.envelope)), vectors.source_receipt_hash.hash);
  assert.notEqual(vectors.source_receipt_hash.hash, sha256hex(canonical(vectors.source_receipt_hash.envelope)));
});

test("restricted kinds are declared for separately registered sources", () => {
  assert.deepEqual([...vectors.restricted_kinds].sort(), ["integrity", "platform_outcome", "verification"]);
});
