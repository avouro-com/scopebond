// Conformance suite runner. Each vector in vectors/conformance.json is run
// through violates() and checked against its expected verdict. This is the
// moat-bearing artifact (D27): a gateway build passes conformance only if it
// produces identical verdicts on every vector here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { violates } from "../dist/violates.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "../vectors/conformance.json"), "utf8"));

test("conformance suite has coverage across clause types", () => {
  assert.ok(cases.length >= 25, `expected a substantial suite, got ${cases.length}`);
});

for (const c of cases) {
  test(`conformance: ${c.name}`, () => {
    const v = violates(c.policy, c.receipts || [], c.claimed, c.opts || {});
    assert.equal(v.violated, c.expect.violated, `${c.name}: violated`);
    if (c.expect.clause_id !== undefined) assert.equal(v.clause_id, c.expect.clause_id, `${c.name}: clause_id`);
    if (c.expect.undetermined !== undefined) assert.equal(!!v.undetermined, c.expect.undetermined, `${c.name}: undetermined`);
    assert.match(v.inputs_hash, /^[0-9a-f]{64}$/, `${c.name}: inputs_hash`);
  });
}
