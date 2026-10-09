import { test } from "node:test";
import assert from "node:assert/strict";
import { dropSuppressed } from "./sarif-drop-suppressed.mjs";

test("suppressed results are left out; open results, other runs and the rest of the log are kept", () => {
  const log = {
    version: "2.1.0",
    runs: [
      { tool: { driver: { name: "ESLint" } }, results: [
        { ruleId: "a", message: { text: "open" } },
        { ruleId: "b", message: { text: "justified" }, suppressions: [{ kind: "inSource", justification: "linear" }] },
        { ruleId: "c", message: { text: "empty list counts as open" }, suppressions: [] },
      ] },
      { tool: { driver: { name: "other" } } },
    ],
  };
  const { log: out, removed } = dropSuppressed(log);
  assert.equal(removed, 1);
  assert.deepEqual(out.runs[0].results.map((r) => r.ruleId), ["a", "c"]);
  assert.equal(out.version, "2.1.0");
  assert.equal(out.runs[1].results, undefined);
});
