// The block message is the one sentence a person and their coding agent actually read,
// so its content is asserted rather than left to chance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { explainDeny, describeAction, findClause } from "../dist/index.js";

const policy = {
  clauses: [
    {
      id: "protect-branches", type: "action_allowlist", mode: "enforce",
      description: "Deny pushes to main, master and release/* (any case, any refspec spelling).",
    },
    { id: "observe-net", type: "action_allowlist", mode: "monitor", description: "Observe network fetches." },
    { id: "no-words", type: "action_allowlist", mode: "enforce" },
  ],
};
const pushIntent = { action_type: "git.push", params: { remote: "origin", ref: "main", force: true } };

test("describeAction names the action for every mapped type", () => {
  assert.equal(describeAction(pushIntent), "git.push origin main");
  assert.equal(describeAction({ action_type: "shell.exec", params: { program: "rm" } }), "shell.exec rm");
  assert.equal(describeAction({ action_type: "file.read", params: { path: ".env" } }), "file.read .env");
  assert.equal(describeAction({ action_type: "mcp.tool.call", params: { server: "s", tool: "t" } }), "mcp.tool.call s/t");
  assert.equal(describeAction({ action_type: "net.fetch", params: { host: "example.com" } }), "net.fetch example.com");
  assert.equal(describeAction(undefined), "?");
});

test("findClause resolves the deciding clause, and nothing else", () => {
  assert.equal(findClause(policy, "protect-branches").mode, "enforce");
  assert.equal(findClause(policy, "absent"), null);
  assert.equal(findClause(policy, null), null);
  assert.equal(findClause(undefined, "protect-branches"), null);
});

test("the message names the action, the rule, the reason and where to change it", () => {
  const message = explainDeny({
    policy, clauseId: "protect-branches", detail: "param ref fails pattern",
    intent: pushIntent, policyPath: "/repo/.scopebond/policy.json",
  });
  assert.match(message, /^Scopebond blocked git\.push origin main — rule "protect-branches" \(enforce\)\./);
  assert.match(message, /Why: Deny pushes to main/);
  // The engine's own wording is kept, so a surprising decision stays debuggable.
  assert.match(message, /Detail: param ref fails pattern/);
  assert.match(message, /Change the rule: edit clause "protect-branches" in \/repo\/\.scopebond\/policy\.json/);
  // The old message was this and nothing else; it must no longer be the whole story.
  assert.notEqual(message, "param ref fails pattern");
});

test("a post-hoc decision never claims the action was prevented", () => {
  const message = explainDeny({
    policy, clauseId: "protect-branches", detail: "param ref fails pattern",
    intent: pushIntent, postHoc: true,
  });
  assert.doesNotMatch(message, /blocked/, "post-hoc wording must not say blocked");
  assert.match(message, /recorded an out-of-policy/);
});

test("the clause mode is reported, so monitor is not mistaken for enforcement", () => {
  const message = explainDeny({ policy, clauseId: "observe-net", detail: "out of bounds", intent: { action_type: "net.fetch", params: { host: "x" } } });
  assert.match(message, /rule "observe-net" \(monitor\)/);
});

test("a clause with no description still names the rule and the next step", () => {
  const message = explainDeny({ policy, clauseId: "no-words", detail: "param x fails pattern", intent: pushIntent });
  assert.match(message, /rule "no-words"/);
  assert.doesNotMatch(message, /Why:/);
  assert.match(message, /Change the rule/);
});

test("with no deciding clause it reports the engine reason and invents no rule", () => {
  const message = explainDeny({ policy, clauseId: null, detail: "kill switch active (fail closed)", intent: pushIntent });
  assert.equal(message, "Scopebond blocked git.push origin main: kill switch active (fail closed)");
  assert.doesNotMatch(message, /rule "/);
});

test("a long description is cut on a word boundary, not mid-word", () => {
  const long = { clauses: [{ id: "x", mode: "enforce", description: `${"alpha bravo ".repeat(60)}omega` }] };
  const message = explainDeny({ policy: long, clauseId: "x", detail: "d", intent: pushIntent });
  const why = message.split("\n").find((l) => l.startsWith("Why: "));
  assert.ok(why.length < 340, `Why line stays bounded: ${why.length}`);
  assert.match(why, /…$/, "truncation is marked");
  assert.doesNotMatch(why, /alph…|brav…/, "cut falls between words");
});
