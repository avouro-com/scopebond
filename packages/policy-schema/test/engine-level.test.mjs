// Engine levels and signed taxonomy extensions: the pack format grows only by adding level-2 fields, a level-1 reading of the
// format refuses them, and an extension adds action types after the built-in registry without ever replacing one.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  validatePack, packEngineProblem, packRequiredEngine, PACK_ENGINE_LEVEL, PACK_LEVEL2_FIELDS,
  validateTaxonomyExtension, taxonomyExtSigningInput, actionTypesOfExtension, TAXONOMY_EXT_FORMAT, TAXONOMY_EXT_SIGNATURE_DOMAIN,
  getActionType, getBuiltinActionType, setActionTypeExtension, extensionActionTypes, validateActionParams, canonical,
} from "../dist/index.js";
import { testPackKey } from "./build-example-pack.mjs";
import { sign } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(here, "../vectors/example-pack.json"), "utf8"));
afterEach(() => setActionTypeExtension([]));

const ext = (types, issued_at = "2026-10-20T00:00:00Z") => {
  const key = testPackKey();
  const unsigned = { format: TAXONOMY_EXT_FORMAT, issued_at, types, signature: { alg: "Ed25519", key_id: key.key_id, value: "A".repeat(86) + "==" } };
  const value = sign(null, Buffer.from(taxonomyExtSigningInput(unsigned), "utf8"), key.privateKey).toString("base64");
  return { ...unsigned, signature: { ...unsigned.signature, value } };
};
const widget = { action_type: "example.widget.delete", params: { name_digest: "string", count: "number", force: "boolean" }, mutating: true, target_opt_in: true };

test("the engine level is 2, and level 2 names its fields", () => {
  assert.equal(PACK_ENGINE_LEVEL, 2);
  assert.deepEqual([...PACK_LEVEL2_FIELDS.pack], ["requires"]);
  assert.deepEqual([...PACK_LEVEL2_FIELDS.rule], ["title", "blockable", "default_mode", "safer_way", "allow_patterns"]);
});

test("every level-1 pack reads the same at level 1 and at level 2", () => {
  assert.equal(validatePack(example).valid, true);
  assert.equal(validatePack(example, { engine: 1 }).valid, true);
  assert.equal(packEngineProblem(example, 1), null);
  assert.equal(packRequiredEngine(example), 1);
});

test("a level-2 pack: valid at level 2, refused as invalid at level 1, and too new for a level-1 engine", () => {
  const pack = structuredClone(example);
  pack.requires = { engine: 2 };
  Object.assign(pack.rules[0], { title: "Delete example resources", blockable: true, default_mode: "block", safer_way: "Delete one resource by name." });
  assert.deepEqual(validatePack(pack).errors, []);
  const old = validatePack(pack, { engine: 1 });
  assert.equal(old.valid, false);
  assert.ok(old.errors.some((e) => e.includes('unknown field "requires"')), JSON.stringify(old.errors));
  const titled = structuredClone(example);
  titled.rules[0].title = "Delete example resources";
  assert.ok(validatePack(titled, { engine: 1 }).errors.some((e) => e.includes('unknown field "title"')));
  assert.deepEqual(packEngineProblem(pack, 1), { reason: "engine_too_old", needs: 2 });
  assert.equal(packEngineProblem(pack, 2), null);
  assert.equal(packRequiredEngine(pack), 2);
  assert.deepEqual(packEngineProblem({ requires: { engine: 3 } }, 2), { reason: "engine_too_old", needs: 3 });
  assert.equal(packRequiredEngine({ requires: { engine: "x" } }), null);
});

test("an action type beyond the registry: the pack names it in requires, and an engine that does not know it skips the pack", () => {
  const pack = structuredClone(example);
  pack.grammars[0].commands[1].emit[0].action_type = "example.widget.delete";
  assert.equal(validatePack(pack).valid, false, "not registered, not required");
  pack.requires = { engine: 2, action_types: ["example.widget.delete"] };
  assert.deepEqual(validatePack(pack).errors, []);
  assert.deepEqual(packEngineProblem(pack, 2), { reason: "unknown_action_type", needs: "example.widget.delete" });
  setActionTypeExtension(actionTypesOfExtension(ext([widget])));
  assert.equal(packEngineProblem(pack, 2), null);
});

test("a taxonomy extension: closed shape, signed over its domain, never redefines a built-in type", () => {
  const doc = ext([widget]);
  assert.deepEqual(validateTaxonomyExtension(doc).errors, []);
  const key = testPackKey();
  const input = taxonomyExtSigningInput(doc);
  const { signature, ...rest } = doc;
  assert.equal(input, TAXONOMY_EXT_SIGNATURE_DOMAIN + canonical(rest));
  assert.equal(verify(null, Buffer.from(input, "utf8"), createPublicKey(key.public_key), Buffer.from(signature.value, "base64")), true);
  // A pack signature never verifies as an extension: the domains differ.
  assert.notEqual(input.split("\n")[0], "scopebond:pack/v1");
  const bad = (types, extra = {}) => validateTaxonomyExtension({ ...ext(types), ...extra }).valid;
  assert.equal(bad([{ ...widget, action_type: "file.write" }]), false, "a built-in type");
  assert.equal(bad([{ ...widget, action_type: "shell.exec" }]), false, "the call itself");
  assert.equal(bad([widget, widget]), false, "twice");
  assert.equal(bad([{ ...widget, params: { via: "string" } }]), false, "a reserved parameter");
  assert.equal(bad([{ ...widget, params: { name: "date" } }]), false, "an unknown kind");
  assert.equal(bad([{ ...widget, mutating: "yes" }]), false);
  assert.equal(bad([{ ...widget, extra: 1 }]), false);
  assert.equal(bad([widget], { version: "1.0.0" }), false, "a closed document");
  assert.equal(bad([]), false, "at least one type");
});

test("the registry reads an extension after the built-in types", () => {
  assert.equal(getActionType("example.widget.delete"), undefined);
  setActionTypeExtension([...actionTypesOfExtension(ext([widget])), { ...getBuiltinActionType("file.write"), summary: "replaced" }]);
  assert.equal(getActionType("example.widget.delete").risk_class, "sensitive");
  assert.notEqual(getActionType("file.write").summary, "replaced", "a built-in type is never replaced");
  assert.deepEqual(extensionActionTypes().map((t) => t.id), ["example.widget.delete"]);
  assert.equal(validateActionParams("example.widget.delete", { count: 2 }).valid, true);
  assert.equal(validateActionParams("example.widget.delete", { count: "2" }).valid, false);
  setActionTypeExtension([]);
  assert.equal(getActionType("example.widget.delete"), undefined);
});
