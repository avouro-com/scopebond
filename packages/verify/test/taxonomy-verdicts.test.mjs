// Action Taxonomy v1 verdict conformance. Each vector runs a normalized taxonomy
// action (git.push, http.call, package.install, deploy.release, …) through
// violates() against an action_allowlist / require_approval policy and checks the
// verdict. This proves the taxonomy's scalar parameter bounds — enum, pattern,
// boolean-as-enum, omitted-parameter-denies — and the closed-allowlist deny of an
// unlisted type. NOTE: array parameters (e.g. pr.* paths) are declared bound-able
// in the registry, but the current engine's param_bounds only match scalar values;
// element-wise array bounds await a vocabulary decision, so no array-bound vector
// is asserted here (see docs/integrations/ACTION_TAXONOMY.md open questions).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { violates } from "../dist/violates.js";

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, "../vectors/taxonomy-verdicts.json"), "utf8"));

test("taxonomy verdict suite covers allow, deny, boolean, omitted-param, unknown and approval", () => {
  assert.ok(cases.length >= 12, `expected a substantial taxonomy suite, got ${cases.length}`);
});

for (const c of cases) {
  test(`taxonomy-verdict: ${c.name}`, () => {
    const v = violates(c.policy, c.receipts || [], c.claimed, c.opts || {});
    assert.equal(v.violated, c.expect.violated, `${c.name}: violated`);
    if (c.expect.clause_id !== undefined) assert.equal(v.clause_id, c.expect.clause_id, `${c.name}: clause_id`);
    assert.match(v.inputs_hash, /^[0-9a-f]{64}$/, `${c.name}: inputs_hash`);
  });
}
