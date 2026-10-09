import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const gate = (...args) => spawnSync(process.execPath, ["scripts/oss-gate.mjs", ...args], { encoding: "utf8" });

test("a commit range is one git revision expression: any letters pass, an option or whitespace is refused", () => {
  const ok = gate("--messages-range", "HEAD..HEAD"); // always a valid range, even in a shallow clone
  assert.equal(ok.status, 0, ok.stderr);
  // Branch names with any letters are ranges too (a mangled validator once refused every range containing "s"). The branch
  // need not exist: the validator must let it through to git, which then reports the unknown revision itself.
  const named = gate("--messages-range", "origin/ci/more-scanners..HEAD");
  assert.equal(named.stderr.includes("not a revision range"), false, named.stderr);
  for (const bad of ["--output=/tmp/x", "-p", "HEAD~1 HEAD", ""]) {
    const r = gate("--messages-range", bad);
    if (bad === "") continue; // an empty argument falls back to the default range
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /not a revision range/, bad);
  }
});
