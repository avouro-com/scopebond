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

const STAYS = "It stays blocked. Don't retry or work around it; tell the person what you were trying to do.";

test("the message has five lines: what was blocked, why, what to do, for the person, and the references", () => {
  const message = explainDeny({
    policy, clauseId: "protect-branches", detail: "param ref fails pattern",
    intent: pushIntent, policyPath: "/repo/.scopebond/policy.json", actionId: "act-123",
  });
  assert.deepEqual(message.split("\n"), [
    // The action in plain words and the rule by the name the tray uses, not its clause id.
    'Scopebond blocked: git push --force origin main ("Push straight to a protected branch").',
    "Why: Deny pushes to main, master and release/* (any case, any refspec spelling).",
    // The agent is told the block is final, not to edit its own rules.
    `What to do: ${STAYS}`,
    'For the person: edit clause "protect-branches" in /repo/.scopebond/policy.json',
    // The clause, the mode, the record and the engine's own wording, so a surprising decision stays debuggable.
    "Ref: protect-branches · enforce · act-123 (param ref fails pattern)",
  ]);
  // The old message was this and nothing else; it must no longer be the whole story.
  assert.notEqual(message, "param ref fails pattern");
});

test("the final instruction follows the outcome the caller gives", () => {
  for (const instruction of [
    "The person can unblock it from the Scopebond icon; ask them, then try once more.",
    "The person can ask an admin from the Scopebond icon; tell them, and wait for the answer before trying again.",
    "The person chose to keep this blocked; do not ask again or retry.",
  ]) {
    const message = explainDeny({ policy, clauseId: "protect-branches", detail: "denied", intent: pushIntent, instruction });
    assert.equal(message.split("\n")[2], `What to do: ${instruction}`);
  }
});

test("a post-hoc decision never claims the action was prevented", () => {
  const message = explainDeny({
    policy, clauseId: "protect-branches", detail: "param ref fails pattern",
    intent: pushIntent, postHoc: true,
  });
  assert.doesNotMatch(message, /blocked/, "post-hoc wording must not say blocked");
  assert.match(message, /^Scopebond recorded an out-of-policy action: git push --force origin main \("Push straight to a protected branch"\)\./);
});

test("the clause mode is reported, so monitor is not mistaken for enforcement", () => {
  const message = explainDeny({ policy, clauseId: "observe-net", detail: "out of bounds", intent: { action_type: "net.fetch", params: { host: "x" } } });
  assert.equal(message.split("\n").at(-1), "Ref: observe-net · monitor (out of bounds)");
});

test("a clause with no description still names the rule and the next step", () => {
  const message = explainDeny({ policy, clauseId: "no-words", detail: "param x fails pattern", intent: pushIntent });
  assert.match(message, /^Ref: no-words · enforce/m);
  assert.doesNotMatch(message, /Why:/);
  assert.match(message, /For the person:/);
  assert.match(message, /What to do:/);
});

test("a workspace rule is named as the tray names it, and the record id is on the Ref line", () => {
  const message = explainDeny({ policy, clauseId: "protect-branches", detail: "denied", intent: pushIntent, actionId: "act-123", remedy: "this computer follows your Scopebond workspace's rules; ask an admin of the workspace to change the rule or unblock this action" });
  const lines = message.split("\n");
  assert.equal(lines[0], 'Scopebond blocked: git push --force origin main ("Push straight to a protected branch").');
  assert.match(message, /For the person: this computer follows your Scopebond workspace's rules/);
  assert.equal(lines.at(-1), "Ref: protect-branches · enforce · act-123");
  assert.doesNotMatch(message, /edit .*rules\.json/);
});

test("Scopebond's own protection is named as the tray names it, says it is always on, and says it stays blocked", () => {
  const message = explainDeny({ policy: { clauses: [{ id: "protect-scopebond-read", mode: "enforce", description: "Never read Scopebond's own folder." }] }, clauseId: "protect-scopebond-read", detail: "denied",
    intent: { action_type: "file.read", params: { path: "~/.scopebond/receipts.db" } }, actionId: "047f8682", remedy: "this computer follows your Scopebond workspace's rules; ask an admin of the workspace to change the rule or unblock this action" });
  assert.deepEqual(message.split("\n"), [
    'Scopebond blocked: Read ~/.scopebond/receipts.db ("Read passwords, keys or secrets").',
    "Why: Never read Scopebond's own folder.",
    `What to do: ${STAYS}`,
    "For the person: this is Scopebond's own protection, always on: no one can unblock it. The Scopebond icon lists it under Blocked.",
    "Ref: protect-scopebond-read · enforce · 047f8682",
  ]);
  const write = explainDeny({ policy: { clauses: [{ id: "protect-scopebond-write", mode: "enforce" }] }, clauseId: "protect-scopebond-write", detail: "denied", intent: pushIntent });
  assert.match(write.split("\n")[0], /\("Change Scopebond's or the agent's safety settings"\)\.$/);
});

test("a post-hoc record carries no instruction to stop (the action already ran)", () => {
  const message = explainDeny({ policy, clauseId: "protect-branches", detail: "x", intent: pushIntent, postHoc: true });
  assert.doesNotMatch(message, /What to do:/);
});

test("with no deciding clause it reports the engine reason and invents no rule", () => {
  const message = explainDeny({ policy, clauseId: null, detail: "kill switch active (fail closed)", intent: pushIntent });
  assert.equal(message, "Scopebond blocked git.push origin main: kill switch active (fail closed)");
  assert.doesNotMatch(message, /rule "|Ref:/);
});

test("a long description is cut on a word boundary, not mid-word", () => {
  const long = { clauses: [{ id: "x", mode: "enforce", description: `${"alpha bravo ".repeat(60)}omega` }] };
  const message = explainDeny({ policy: long, clauseId: "x", detail: "d", intent: pushIntent });
  const why = message.split("\n").find((l) => l.startsWith("Why: "));
  assert.ok(why.length < 340, `Why line stays bounded: ${why.length}`);
  assert.match(why, /…$/, "truncation is marked");
  assert.doesNotMatch(why, /alph…|brav…/, "cut falls between words");
});
