// The rule set is a readable front end for patterns that are deliberately careful. The one
// thing that must never happen is the front end quietly changing what is enforced, so the
// compiled patterns are pinned against the shipped starter policy, byte for byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compile, defaultRules, describeRules, pathRuleFor } from "../dist/index.js";
import { starterPolicy } from "../dist/index.js";

const boundsOf = (policy) => Object.fromEntries(
  (policy.clauses ?? [])
    .filter((c) => c.param_bounds)
    .map((c) => [c.id, Object.fromEntries(Object.entries(c.param_bounds).map(([k, v]) => [k, v.pattern]))]),
);

test("the default rule set compiles to the shipped starter policy's exact patterns", () => {
  const compiled = compile(defaultRules(), "key:abc");
  const shipped = starterPolicy("key:abc");
  // Enforcement is the patterns. If this ever differs, the rules front end has changed
  // what the hook blocks — which is the one thing it must not do.
  assert.deepEqual(boundsOf(compiled), boundsOf(shipped), "compiled patterns must equal the starter policy's");
});

test("the compiled policy keeps the same clauses, ids, modes and action types", () => {
  const compiled = compile(defaultRules(), "key:abc");
  const shipped = starterPolicy("key:abc");
  const shape = (p) => (p.clauses ?? []).map((c) => ({ id: c.id, type: c.type, mode: c.mode ?? null, action_types: c.action_types ?? null }));
  assert.deepEqual(shape(compiled), shape(shipped));
  assert.equal(compiled.policy_id, shipped.policy_id);
  assert.equal(compiled.vocabulary_version, shipped.vocabulary_version);
  assert.deepEqual(
    compiled.clauses.find((c) => c.type === "key_policy").active_keys,
    ["key:abc"],
    "only the enrolled machine key may sign",
  );
});

test("every clause description says where to change the rule", () => {
  const compiled = compile(defaultRules(), "key:abc");
  for (const clause of compiled.clauses) {
    if (clause.type === "key_policy") continue;
    assert.match(clause.description, /rules\.json/, `${clause.id} points at the editable file`);
  }
});

test("a description lists what it actually covers, so an edit cannot make it lie", () => {
  const rules = defaultRules();
  rules.destructive_programs = ["rm", "dd"];
  const clause = compile(rules, "key:abc").clauses.find((c) => c.id === "safe-shell");
  assert.match(clause.description, /rm, dd/);
  assert.doesNotMatch(clause.description, /sudo/, "a removed program is not still described as blocked");
});

test("removing a program from the list stops it being denied", () => {
  const rules = defaultRules();
  const before = compile(rules, "k").clauses.find((c) => c.id === "safe-shell").param_bounds.program.pattern;
  assert.equal(new RegExp(before).test("dd"), false, "dd is denied by default");
  rules.destructive_programs = rules.destructive_programs.filter((p) => p !== "dd");
  const after = compile(rules, "k").clauses.find((c) => c.id === "safe-shell").param_bounds.program.pattern;
  assert.equal(new RegExp(after).test("dd"), true, "dd is allowed once removed");
  assert.equal(new RegExp(after).test("rm"), false, "the rest of the list still applies");
});

test("adding a protected branch denies it, in any case", () => {
  const rules = defaultRules();
  rules.protected_branches.push("production");
  const pattern = compile(rules, "k").clauses.find((c) => c.id === "protect-branches").param_bounds.ref.pattern;
  const re = new RegExp(pattern);
  assert.equal(re.test("production"), false);
  assert.equal(re.test("PRODUCTION"), false, "case-insensitive, like the shipped rules");
  assert.equal(re.test("feature/x"), true, "an ordinary branch is still allowed");
  assert.equal(re.test("main"), false, "the defaults still apply");
});

test("a release/* prefix rule matches the prefix, not just the bare name", () => {
  const pattern = compile(defaultRules(), "k").clauses.find((c) => c.id === "protect-branches").param_bounds.ref.pattern;
  const re = new RegExp(pattern);
  assert.equal(re.test("release/1.2"), false);
  assert.equal(re.test("releases/1.2"), true, "only the release/ prefix is protected");
  assert.equal(re.test("--tags"), true, "a tags-only push stays allowed");
  assert.equal(re.test("--all"), false, "pushing every branch at once is denied");
});

test("adding a protected path denies writes to it and inside it", () => {
  const rules = defaultRules();
  rules.protected_write.push(pathRuleFor("infra/"));
  const pattern = compile(rules, "k").clauses.find((c) => c.id === "protect-write").param_bounds.path.pattern;
  const re = new RegExp(pattern);
  assert.equal(re.test("infra/main.tf"), false);
  assert.equal(re.test("infra"), false, "the directory itself too");
  assert.equal(re.test("src/app.ts"), true, "ordinary work is untouched");
});

test("pathRuleFor reads a trailing slash or a dotless name as a directory", () => {
  assert.equal(pathRuleFor("infra/").kind, "under");
  assert.equal(pathRuleFor("secrets").kind, "under");
  assert.equal(pathRuleFor("deploy.sh").kind, "named");
  assert.equal(pathRuleFor("./src/app.ts").label, "src/app.ts", "a leading ./ is dropped");
  assert.equal(pathRuleFor("infra///").label, "infra/ and everything in it", "trailing separators collapse");
  assert.equal(pathRuleFor("infra\\terraform\\").kind, "under", "a Windows path is normalised");
  assert.equal(pathRuleFor("infra\\terraform\\").label, "infra/terraform/ and everything in it");
});

/** The value goes into a rule that decides what the agent may touch, so a typed path has to
 *  be treated as literal text — every metacharacter escaped, none interpreted. */
test("a user-typed path is literal: every metacharacter is escaped", () => {
  const protectedBy = (input) => {
    const pattern = compile({ ...defaultRules(), protected_write: [pathRuleFor(input)] }, "k")
      .clauses.find((c) => c.id === "protect-write").param_bounds.path.pattern;
    return (candidate) => new RegExp(pattern).test(candidate) === false;
  };

  let blocks = protectedBy("weird+name.txt");
  assert.equal(blocks("weird+name.txt"), true, "the literal path is protected");
  assert.equal(blocks("weirdXname.txt"), false, "the + is not a quantifier");

  blocks = protectedBy("a.b.c");
  assert.equal(blocks("a.b.c"), true);
  assert.equal(blocks("aXbXc"), false, "the dots are not wildcards");

  // A path full of metacharacters must not blow up the pattern or match anything else.
  for (const input of ["a(b)c.txt", "x[y]z.txt", "q{1,2}.txt", "a|b.txt", "^start.txt", "end$.txt", "a*b.txt"]) {
    const check = protectedBy(input);
    assert.equal(check(input), true, `${input} is protected literally`);
    assert.equal(check("unrelated/file.txt"), false, `${input} does not over-match`);
  }
});

test("pathRuleFor stays linear on adversarial input", () => {
  // The previous normalisation used `^[./\\]+` with a callback, which CodeQL flagged as
  // polynomial on a path of many leading dots.
  const hostile = `${".".repeat(50000)}/x.txt`;
  const started = process.hrtime.bigint();
  pathRuleFor(hostile);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 250, `normalisation must not blow up (took ${ms.toFixed(0)}ms)`);
});

test("describeRules names every protected location in plain words", () => {
  const text = describeRules(defaultRules());
  assert.match(text, /Blocked before it runs:/);
  assert.match(text, /pushes to\s+main, master, release\/\*/);
  assert.match(text, /environment secret files/);
  assert.match(text, /Recorded, not blocked:/);
  assert.match(text, /net\.fetch, mcp\.tool\.call/);
  // The point of the command: no regex in the human output.
  assert.doesNotMatch(text, /\(\?!/, "no lookaheads in the plain-English view");
  assert.doesNotMatch(text, /\[rR\]/, "no case-folded character classes either");
});
