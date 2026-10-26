// Policy patterns and globs are tested against values an AI agent chooses, so neither may take time the agent can stretch.
//   - A pattern that can backtrack catastrophically makes the policy invalid when it is validated (the same check rule-pack
//     patterns pass), so violates() fails closed instead of stalling.
//   - A value longer than the input limit fails a pattern without being tested; one within it is tested in bounded time.
//   - Endpoint and ref globs are matched without a regular expression, in time linear in the value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { POLICY_PATTERN_INPUT_MAX } from "@scopebond/policy-schema/pattern";
import { validatePolicy } from "../dist/violates.js";
import { violatesBoth as violates } from "./bounded.mjs";

const AT = "2026-10-26T12:00:00Z";
const policyOf = (...clauses) => ({ vocabulary_version: "1.0", policy_id: "p", version: 1, clauses });
const act = (action_type, params) => ({ intent: { action_type, params }, executed: true, realtime_result: "allow", timestamp: AT, attester: { kind: "gateway", kid: "g1" } });
const bounded = (pattern, extra = {}) => policyOf({ id: "files", type: "action_allowlist", mode: "enforce", action_types: ["file.write"], param_bounds: { path: { pattern } }, ...extra });

const CATASTROPHIC = [
  "^(a+)+$", // a repeat that holds a repeat
  "^((?:a|b)+)*$", // the same, one group further in
  "^(?:a|ab)*$", // alternatives under a repeat that begin alike
  "^(?:a|a)*c$",
  "^.*.*x$", // adjacent unbounded wildcards
  "^\\w+\\d*$",
  "^.*a.*a.*a.*b$", // four overlapping unbounded repeats in a row: polynomial of degree four
  "^(a)\\1$", // a back-reference
  "(?<=a)b", // a look-behind
];

test("a policy whose pattern can backtrack catastrophically is invalid, and violates() fails closed on it", () => {
  for (const pattern of CATASTROPHIC) {
    const policy = bounded(pattern);
    const result = validatePolicy(policy);
    assert.equal(result.valid, false, `${pattern} is refused`);
    assert.match(result.errors.join("; "), /\/clauses\/files\/param_bounds\/path has an invalid pattern: it /);
    const v = violates(policy, [], act("file.write", { path: "a".repeat(40) + "!" }));
    assert.equal(v.violated, true, "an invalid policy is a violation, never an allow");
    assert.match(v.explanation, /^invalid policy: /);
  }
  // The same check for an array bound's items and for an exception's patterns.
  const items = policyOf({ id: "tags", type: "action_allowlist", action_types: ["x.tag"], param_bounds: { tags: { items: { pattern: "^(a+)+$" } } } });
  assert.equal(validatePolicy(items).valid, false);
  const exception = bounded("^(?!/etc/).+", { exceptions: [{ path: { pattern: "^(?:a|ab)*$" } }] });
  assert.equal(validatePolicy(exception).valid, false);
  assert.match(validatePolicy(exception).errors.join("; "), /exceptions\/path has an invalid pattern: it alternatives under a repeat/);
});

test("ordinary bounded patterns stay valid", () => {
  for (const pattern of ["^(?!/etc/).+", "^(?:kind-.+|minikube)$", "^[a-z0-9-]+$", "^(?!(?:.*/)?\\.env(?:\\.[^/]*)?$).+", "^[^/]+(?:/[^/]+)*$", "^.*\\.ts$", "^(?:ab|cd)*$", "^\\d{1,5}$"]) {
    assert.equal(validatePolicy(bounded(pattern)).valid, true, `${pattern}: ${JSON.stringify(validatePolicy(bounded(pattern)).errors)}`);
  }
});

test("a long agent-chosen value against a policy pattern returns quickly, and fails the pattern", () => {
  // Quadratic on its own (`.*` backtracks over every `a`, and the second `.*` scans the rest each time): bounded only by the
  // input limit.
  const policy = bounded("^.*a.*b$");
  assert.equal(validatePolicy(policy).valid, true);
  const long = "a".repeat(100_000);
  let t0 = performance.now();
  const v = violates(policy, [], act("file.write", { path: long }));
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `answered in ${ms.toFixed(0)} ms`);
  assert.equal(v.violated, true, "a value over the limit fails the pattern (closed)");
  assert.equal(v.failed_bound, "path:pattern");
  // A value at the limit is still tested, and still quickly.
  t0 = performance.now();
  assert.equal(violates(policy, [], act("file.write", { path: "a".repeat(POLICY_PATTERN_INPUT_MAX - 1) + "b" })).violated, false);
  assert.equal(violates(policy, [], act("file.write", { path: "a".repeat(POLICY_PATTERN_INPUT_MAX) })).violated, true);
  assert.ok(performance.now() - t0 < 500, "at the limit");
  // An exception is not met by an over-long value either: it excuses nothing.
  const excused = bounded("^(?!/etc/).+", { exceptions: [{ path: { pattern: "^/etc/.*$" } }] });
  assert.equal(violates(excused, [], act("file.write", { path: "/etc/" + "x".repeat(10) })).violated, false);
  assert.equal(violates(excused, [], act("file.write", { path: "/etc/" + "x".repeat(POLICY_PATTERN_INPUT_MAX) })).violated, true);
});

// ---- globs ----------------------------------------------------------------------------------------------------------------

const call = (path) => ({ intent: { action_type: "http.call", params: { host: "api.example.com", path, method: "GET" } }, executed: true, timestamp: AT });
const denyPaths = (paths) => policyOf({ id: "deny", type: "endpoint_denylist", mode: "enforce", hosts: ["api.example.com"], paths });
const globHit = (glob, path) => violates(denyPaths([glob]), [], call(path)).violated;

test("a glob with many `**` on a long path that does not match is linear", () => {
  const glob = "/a/**/**/**/**/**/z";
  const path = "/a/" + "/".repeat(400) + "y";
  const t0 = performance.now();
  assert.equal(globHit(glob, path), false);
  assert.equal(globHit(glob, "/a/" + "x/".repeat(50_000) + "z"), true);
  assert.equal(globHit("/a/*/*/*/*/z", "/a/" + "b".repeat(100_000)), false);
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `matched in ${ms.toFixed(0)} ms`);
});

test("globs keep their meaning: `*` within a segment, `**` across segments, everything else literal", () => {
  // The regular expression the matcher replaces, as the reference.
  const reference = (glob, s) => {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i];
      if (ch === "*") { if (glob[i + 1] === "*") { re += ".*"; i++; } else re += "[^/]*"; }
      else if (".+?^${}()|[]\\".includes(ch)) re += "\\" + ch;
      else re += ch;
    }
    // eslint-disable-next-line security/detect-non-literal-regexp -- the reference: every metacharacter escaped, as the old matcher built it
    return new RegExp("^" + re + "$").test(s);
  };
  const cases = [
    ["/admin/**", "/admin/x/y"], ["/admin/**", "/admin/"], ["/admin/**", "/admin"], ["/admin/*", "/admin/x"], ["/admin/*", "/admin/x/y"],
    ["/v1/*/items", "/v1/abc/items"], ["/v1/*/items", "/v1//items"], ["/v1/*/items", "/v1/a/b/items"], ["**", ""], ["*", "a/b"],
    ["/a.b", "/axb"], ["/a.b", "/a.b"], ["/a+(b)?", "/a+(b)?"], ["/**", "/x\ny"], ["/*", "/x\ny"], ["***", "a/b"], ["", ""], ["", "x"],
    ["refs/heads/*", "refs/heads/main"], ["refs/heads/release/**", "refs/heads/release/1.2"], ["refs/heads/*", "refs/heads/a/b"],
  ];
  // An endpoint path starts with "/" (any other is denied before globs are read), so each case is read after one.
  const same = (glob, path) => globHit("/" + glob, "/" + path) === reference("/" + glob, "/" + path);
  for (const [glob, path] of cases) assert.ok(same(glob, path), `${JSON.stringify(glob)} on ${JSON.stringify(path)}`);
  // And a sweep of small globs and paths over the characters that matter.
  const alphabet = ["a", "/", "*", ".", "\n"];
  let seed = 7;
  const pick = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return alphabet[seed % alphabet.length]; };
  for (let k = 0; k < 2000; k++) {
    const glob = Array.from({ length: 1 + (k % 6) }, pick).join("");
    const path = Array.from({ length: k % 8 }, pick).join("").replaceAll("*", "b");
    assert.ok(same(glob, path), `${JSON.stringify(glob)} on ${JSON.stringify(path)}`);
  }
});
