import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  packSchema, validatePack, packSigningInput, packRef, comparePackVersions, PACK_FORMAT, PACK_SIGNATURE_DOMAIN,
  EXPRESSION_OPERATORS, CONDITION_OPERATORS, canonical,
} from "../dist/index.js";
import { buildExamplePack } from "./build-example-pack.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, "../vectors", name), "utf8"));
const example = read("example-pack.json");
const exampleKey = read("example-pack-key.json");
const formatCases = read("pack-format.json").cases;

// A JSON Schema (2020-12 subset) checker: exactly the keywords pack.schema.json uses. Enough to prove the closed shape and
// to check that the schema and the validator agree, without adding a validator dependency.
function validate(schema, value, root = packSchema) {
  if (schema === true) return true;
  if (schema.$ref !== undefined) return validate(schema.$ref.slice(2).split("/").reduce((node, key) => node[key], root), value, root);
  if (schema.oneOf && schema.oneOf.filter((s) => validate(s, value, root)).length !== 1) return false;
  if (schema.anyOf && !schema.anyOf.some((s) => validate(s, value, root))) return false;
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const types = schema.type === undefined ? null : Array.isArray(schema.type) ? schema.type : [schema.type];
  const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
  if (types && !types.some((t) => t === typeOf(value) || (t === "number" && typeof value === "number"))) return false;
  if (typeof value === "string") {
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity)) return false;
    // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern comes from the pack schema this package exports, the thing under test
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
  }
  if (typeof value === "number" && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) return false;
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) return false;
    if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return false;
    const prefix = schema.prefixItems ?? [];
    for (let i = 0; i < value.length; i++) {
      const s = i < prefix.length ? prefix[i] : schema.items;
      if (s && !validate(s, value[i], root)) return false;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length < (schema.minProperties ?? 0) || keys.length > (schema.maxProperties ?? Infinity)) return false;
    for (const key of schema.required ?? []) if (!(key in value)) return false;
    for (const key of keys) {
      if (schema.propertyNames && !validate(schema.propertyNames, key, root)) return false;
      if (schema.properties?.[key]) { if (!validate(schema.properties[key], value[key], root)) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (typeof schema.additionalProperties === "object" && !validate(schema.additionalProperties, value[key], root)) return false;
    }
  }
  return true;
}

function change(doc, step) {
  const copy = structuredClone(doc);
  const path = step.set ?? step.delete;
  if (!path) return copy;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key];
  const last = path[path.length - 1];
  if (step.delete) delete node[last]; else node[last] = structuredClone(step.value);
  return copy;
}

test("the example pack is valid and its signature verifies with the test-only key", () => {
  const result = validatePack(example);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
  assert.equal(example.format, PACK_FORMAT);
  assert.equal(packRef(example), "example@1.0.0");
  const key = createPublicKey(exampleKey.public_key);
  assert.equal(example.signature.key_id, exampleKey.key_id);
  assert.equal(verify(null, Buffer.from(packSigningInput(example), "utf8"), key, Buffer.from(example.signature.value, "base64")), true);
  // A changed pack no longer verifies.
  const changed = { ...example, version: "1.0.1" };
  assert.equal(verify(null, Buffer.from(packSigningInput(changed), "utf8"), key, Buffer.from(example.signature.value, "base64")), false);
});

test("the signing input is the domain, then the canonical pack without its signature", () => {
  const input = packSigningInput(example);
  assert.ok(input.startsWith(PACK_SIGNATURE_DOMAIN));
  const { signature, ...rest } = example;
  void signature;
  assert.equal(input, PACK_SIGNATURE_DOMAIN + canonical(rest));
  // Member order does not change it.
  const reordered = Object.fromEntries(Object.entries(example).reverse());
  assert.equal(packSigningInput(reordered), input);
});

test("the example pack is up to date with its builder (deterministic, byte for byte)", () => {
  assert.equal(`${JSON.stringify(buildExamplePack(), null, 2)}\n`, readFileSync(join(here, "../vectors/example-pack.json"), "utf8"));
});

test("pack versions compare numerically", () => {
  assert.ok(comparePackVersions("1.10.0", "1.9.9") > 0);
  assert.ok(comparePackVersions("2.0.0", "10.0.0") < 0);
  assert.equal(comparePackVersions("1.2.3", "1.2.3"), 0);
});

test("the pack schema is closed: every object it defines refuses unknown members", () => {
  const open = [];
  const walk = (node, at) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${at}[${i}]`)); return; }
    if (node.properties && node.additionalProperties !== false) open.push(at);
    for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`);
  };
  walk(packSchema, "#");
  assert.deepEqual(open, []);
  assert.equal(packSchema.additionalProperties, false);
});

test("the schema and the validator name the same operators", () => {
  const names = (def) => new Set(packSchema.$defs[def].oneOf.map((v) => v.required[0]));
  const shell = names("shellExpr");
  const mcp = names("mcpExpr");
  assert.deepEqual([...new Set([...shell, ...mcp])].sort(), Object.keys(EXPRESSION_OPERATORS).sort());
  assert.deepEqual([...new Set([...names("shellCondition"), ...names("mcpCondition")])].sort(), [...CONDITION_OPERATORS].sort());
  for (const op of ["arg", "arg_list", "arg_items", "server"]) { assert.ok(mcp.has(op)); assert.ok(!shell.has(op)); }
  for (const op of ["flag", "positional", "var", "config_value"]) { assert.ok(shell.has(op)); assert.ok(!mcp.has(op)); }
});

for (const c of formatCases) {
  test(`pack format: ${c.name}`, () => {
    let doc = change(example, c);
    for (const step of c.also ?? []) doc = change(doc, step);
    const result = validatePack(doc);
    assert.equal(result.valid, c.valid, `validatePack: ${JSON.stringify(result.errors)}`);
    if (!c.valid) assert.ok(result.errors.length > 0);
    assert.equal(validate(packSchema, doc), c.schema ?? c.valid, "pack.schema.json");
  });
}

test("validatePack refuses what is not an object, and reports where", () => {
  for (const doc of [null, [], "pack", 1]) assert.equal(validatePack(doc).valid, false);
  const result = validatePack({ ...example, grammars: [{ ...example.grammars[0], commands: [{ path: [], emit: [{ action_type: "made.up", params: {} }] }] }] });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes("pack.grammars[0].commands[0].emit[0].action_type")), JSON.stringify(result.errors));
});
