// "Similar commands in this project" in the tray: where the hook offers a pattern for a block (a recipe fits and the workspace
// lets a person make one), the block's offers carry it in words with an example of what it covers and one of what it does
// not, and the tray's form answers it with `scope: "similar"` and a length. From the tray's channel it is only ever sent as a
// request to an admin (local-approvals.test.mjs). Where it is not offered, a similar answer is refused and nothing is allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actOnBlocked, readAllowances, readBlocked } from "@scopebond/hook";
import { callAgent } from "../dist/index.js";
import { parseBlockedAnswer } from "../dist/service.js";
import { computer, blockActions, serviceFor } from "./tray-helpers.mjs";

const REASON = "Removing an old worktree";
const REPO = "/work/app";
const handler = { repositoryTop: (p) => (p === REPO || p.startsWith(`${REPO}/`) ? REPO : null), real: () => null, cwd: "/repo" };
const terms = (patterns) => ({ reason_min: 0, minutes: 0, daily_limit: 5, harness_prompt: false, always: "at_once", always_days: 30, patterns });
const answer = (dir, body) => callAgent(dir, "POST", "/blocked/answer", body, 10_000);

test("a similar answer is read strictly: only with a length longer than once", () => {
  const base = { action_id: "act-1", choice: "always", reason: REASON };
  assert.deepEqual(parseBlockedAnswer({ ...base, scope: "similar" }), { ...base, scope: "similar" });
  assert.deepEqual(parseBlockedAnswer({ ...base, scope: "exact" }), base);
  for (const bad of [{ ...base, scope: "everything" }, { ...base, scope: "similar", choice: "ask" }, { ...base, scope: "similar", choice: "quiet" }, { ...base, scope: "similar", choice: "once" }, { ...base, scope: 1 }]) {
    assert.equal(parseBlockedAnswer(bad), null, JSON.stringify(bad));
  }
});

test("similar commands are never allowed from the tray's channel: with no request to send them as, the form shows none and an answer is refused", async () => {
  const dir = computer({ "destructive-shell": { mode: "override", override: terms("person") } });
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: `rm -rf ${REPO}/old-build` } }], { handler });
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.equal(tray.recent_blocks.find((b) => b.action_id === id).offers.similar, null);
    const done = await answer(dir, { action_id: id, choice: "always", reason: "", scope: "similar" });
    assert.equal(done.outcome, "needs_workspace");
    assert.equal(readAllowances(dir).length, 0, "nothing allowed");
    // The Scopebond window's answer (the hook's own path) still makes the pattern.
    assert.equal(actOnBlocked(dir, id, { decision: "allow", reason: "", lasts: "always", scope: "similar" }).outcome, "allowed");
    assert.equal(readAllowances(dir).find((a) => a.match).match.bounds.value, REPO);
    const { allowances } = await callAgent(dir, "GET", "/allowances", undefined, 10_000);
    assert.ok(allowances.some((a) => a.what === `Deleting folders inside ${REPO} with rm`), "the Allowed list says what it lets through");
  } finally { await service.stop(); }
});

test("where the workspace offers no similar commands, the form shows none and a similar answer is refused", async () => {
  const dir = computer({ "destructive-shell": { mode: "override", override: terms("off") } });
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: `rm -rf ${REPO}/old-build` } }], { handler });
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.equal(tray.recent_blocks.find((b) => b.action_id === id).offers.similar, null);
    assert.equal((await answer(dir, { action_id: id, choice: "always", reason: "", scope: "similar" })).outcome, "not_offered");
    assert.equal(readAllowances(dir).length, 0, "nothing allowed");
  } finally { await service.stop(); }
});

test("where an admin must approve, the Scopebond window's answer makes a pattern that waits", async () => {
  const dir = computer({ "destructive-shell": { mode: "override", override: terms("needs_admin") } });
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: `rm -rf ${REPO}/old-build` } }], { handler });
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    assert.equal((await answer(dir, { action_id: id, choice: "always", reason: "", scope: "similar" })).outcome, "needs_workspace", "never from the tray's channel");
    assert.equal(actOnBlocked(dir, id, { decision: "allow", reason: "", lasts: "always", scope: "similar" }).outcome, "proposed");
    assert.equal(readAllowances(dir).find((a) => a.match).state, "proposed");
  } finally { await service.stop(); }
});
