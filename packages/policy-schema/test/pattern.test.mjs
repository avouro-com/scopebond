// The shared pattern check (pattern.ts): every pattern a policy or a rule pack carries is refused when its shape can take more
// than quadratic time on a value the agent chooses, and accepted otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PACK_PATTERN_MAX, POLICY_PATTERN_INPUT_MAX, POLICY_PATTERN_MAX, patternProblem } from "../dist/pattern.js";

const REFUSED = {
  "a repeated group that holds a repeat": ["(a+)+", "^(a*)*$", "((a+))+", "^(?:x*x)*$", "(?:a[^b]*)*", "(?:[^.]+\\.?)*", "(?:a+a)*", "(?:(?!.*x).)*", "(a{2,}){2,}"],
  "a repeated group that can match nothing": ["(a?)*", "^(?:a|){20}$", "(?:\\b)+"],
  "alternatives under a repeat that can begin with the same character": ["(a|ab)*", "^(?:a|a)*$", "(?:\\d|[0-9a-f])+", "^(?:x(?:a|ab)y)+$", "(?:ab|ac){2,}"],
  "unbounded repeats next to each other": [".*.*", "^.*.*$", "\\w+\\d*", ".*x?.*", "(?:.*)(?:.*)", ".*(?!x).*", "a*(?:ab)*", "^[a-z]*[a-z]+$"],
  "three or more unbounded repeats in a row": ["^.*a.*a.*a$", "a.*a.*a", "x.*x.*", "^.*/.*/.*\\.ts$"],
  "places that can match the same input two ways": ["a?a?a?a?a?a?a?a?a?aaaaaaaaa", "^(?:a|ab)(?:a|ab)(?:a|ab)(?:a|ab)(?:a|ab)(?:a|ab)(?:a|ab)(?:a|ab)(?:a|ab)c$", "^(?:xa?a){9}$"],
  "back-references": ["^(a)\\1$", "(?<n>a)\\k<n>"],
  "look-behind": ["(?<=a)b", "(?<!a)b"],
  "not a valid regular expression": ["(", "[", "a**", "(?<n>a)(?<n>b)"],
};

const ACCEPTED = [
  "^(?:a|b)+$", "^[a-z0-9-]+$", "^(?!.*foo).+", "^.*a.*b$", ".*foo", "^(?:ab|cd)*$", "^[^/]+(?:/[^/]+)*$", "^\\d{1,5}$",
  "^(?:.*/)?\\.env$", "[\\d-x]+", "^a{2,}b", "^(?!(?:main|master)$)(?!release/)(?!-(?!-tags$)).+", "^(?:kind-.+|minikube)$",
  "^(?![\\s\\S]*?(?:a|b))[\\s\\S]*$", "\\\\1", "[\\1]", "^(?!(?:.*/)?(?:\\.github/(?:workflows|actions)/.*|\\.travis\\.yml)$)",
  "^https://[a-z0-9.-]+/", "a{", "x]", "^(?<name>a)b$", "\\u0041\\x41\\cA\\0", "^(?:\\.[^/]*)?$",
];

// A repeated group whose inner repeat is closed by a separator it cannot consume splits an input one way only.
const SEPARATED = [
  "^(?:(?:[^.]+\\.)+[eE][xX][aA][mM][pP][lL][eE]\\.[cC][oO][mM]|[aA][pP][iI]\\.[oO][rR][gG])$", // a host list with a wildcard
  "^(?:[a-z0-9-]+\\.)*[a-z]+$", "^(?:[^/]+/)*[^/]*$", "^(?:x*y)*$", "^(?:[a-z]+-[0-9]+\\.)+$", "^(?:a*(?:b|c))*$",
];
ACCEPTED.push(...SEPARATED);

test("separator-closed repeats in a repeated group are accepted, and run in linear time", () => {
  for (const p of SEPARATED) assert.equal(patternProblem(p), null, `${JSON.stringify(p)}: ${patternProblem(p)}`);
  // Long adversarial values: many turns, and one turn that never meets its separator, each followed by a mismatch.
  // eslint-disable-next-line security/detect-non-literal-regexp -- the test's own accepted patterns, run to time them
  const time = (pattern, value) => { const re = new RegExp(pattern); const t0 = performance.now(); re.test(value); return performance.now() - t0; };
  for (const [p, values] of [
    [SEPARATED[0], ["a.".repeat(50_000) + "x", "a".repeat(100_000), "a.".repeat(50_000) + "example.co"]],
    [SEPARATED[1], ["a.".repeat(50_000) + "!", "a".repeat(100_000) + "!", "a-".repeat(50_000) + "."]],
    [SEPARATED[2], ["a/".repeat(50_000) + "b/", "a".repeat(100_000)]],
  ]) {
    for (const v of values) {
      const small = time(p, v.slice(0, 10_000)), large = time(p, v);
      assert.ok(large < 250, `${p} on ${v.length} characters took ${large.toFixed(0)} ms`);
      // Ten times the input stays within a generous linear factor (not the hundredfold a quadratic would take).
      assert.ok(large < Math.max(small, 1) * 40, `${p}: ${small.toFixed(1)} ms for 10k, ${large.toFixed(1)} ms for 100k`);
    }
  }
});

test("shapes that can backtrack catastrophically are refused, each with its reason", () => {
  for (const [reason, patterns] of Object.entries(REFUSED)) {
    for (const p of patterns) {
      const problem = patternProblem(p);
      assert.ok(problem && problem.includes(reason), `${JSON.stringify(p)}: expected "${reason}", got ${JSON.stringify(problem)}`);
    }
  }
});

test("bounded shapes are accepted", () => {
  for (const p of ACCEPTED) assert.equal(patternProblem(p), null, `${JSON.stringify(p)}: ${patternProblem(p)}`);
});

test("lengths: a pack pattern is at most 200 characters, a policy pattern at most 16 KiB, and a non-string is refused", () => {
  assert.equal(PACK_PATTERN_MAX, 200);
  assert.equal(patternProblem("a".repeat(201), PACK_PATTERN_MAX), "is longer than 200 characters");
  assert.equal(patternProblem("a".repeat(200), PACK_PATTERN_MAX), null);
  assert.equal(patternProblem("a".repeat(POLICY_PATTERN_MAX)), null);
  assert.match(patternProblem("a".repeat(POLICY_PATTERN_MAX + 1)), /longer than/);
  assert.equal(patternProblem(7), "must be a string");
  // A pattern nested too deeply to read is refused, never assumed safe.
  assert.match(patternProblem("(".repeat(5000) + "a" + ")".repeat(5000)) ?? "", /could not be checked|not a valid/);
});

test("the check itself is quick on a long pattern", () => {
  const long = "^" + Array.from({ length: 400 }, (_, i) => `(?!(?:.*/)?x${i}(?:/|$))`).join("") + ".+";
  const t0 = performance.now();
  assert.equal(patternProblem(long), null);
  assert.ok(performance.now() - t0 < 1000, `${(performance.now() - t0).toFixed(0)} ms`);
});

test("every pattern the check accepts runs in bounded time on adversarial values at the input limit", () => {
  // Random patterns over a small alphabet, the shapes that go wrong (groups, alternatives, look-aheads, every quantifier).
  let seed = 20261026;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const atoms = ["a", "b", ".", "[ab]", "[^a]", "\\w", "\\d", "x", "a?", "a?a?", "(?:a|ab)"];
  const quantifiers = ["", "", "*", "+", "?", "{2,}", "{0,3}"];
  const gen = (depth) => {
    let s = "";
    for (let i = 1 + rnd(3); i > 0; i--) {
      const r = rnd(10);
      const atom = depth < 3 && r < 2 ? `(?:${gen(depth + 1)}|${gen(depth + 1)})` : depth < 3 && r < 4 ? `(?:${gen(depth + 1)})`
        : depth < 3 && r < 5 ? `(?!${gen(depth + 1)})` : atoms[rnd(atoms.length)];
      s += atom + quantifiers[rnd(quantifiers.length)];
    }
    return s;
  };
  const values = ["a", "b", "ab", "a1", "aab"].flatMap((unit) => {
    const v = unit.repeat(Math.ceil(POLICY_PATTERN_INPUT_MAX / unit.length)).slice(0, POLICY_PATTERN_INPUT_MAX - 1);
    return [v + "!", v];
  });
  let accepted = 0, worst = 0;
  for (let k = 0; k < 600; k++) {
    const p = (rnd(2) ? "^" : "") + gen(0) + (rnd(2) ? "$" : "");
    // eslint-disable-next-line security/detect-non-literal-regexp -- generated test patterns, run to time them
    try { new RegExp(p); } catch { continue; }
    if (patternProblem(p) !== null) continue;
    accepted++;
    // eslint-disable-next-line security/detect-non-literal-regexp -- generated test patterns, run to time them
    const re = new RegExp(p);
    for (const v of values) {
      const t0 = performance.now();
      re.test(v);
      worst = Math.max(worst, performance.now() - t0);
    }
  }
  assert.ok(accepted > 50, `${accepted} accepted`);
  assert.ok(worst < 250, `slowest accepted pattern took ${worst.toFixed(0)} ms`);
});
