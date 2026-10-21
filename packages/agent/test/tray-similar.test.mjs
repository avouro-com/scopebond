// "Similar commands in this project" in the tray: where the hook offers a pattern for a block (a recipe fits and the workspace
// lets a person make one), the block's offers carry it in words with an example of what it covers and one of what it does
// not, and the tray's form answers it with `scope: "similar"` and a length. Where it is not offered, a similar answer is
// refused and nothing is allowed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readAllowances, readBlocked } from "@scopebond/hook";
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

test("the tray offers similar commands in words, and the answer allows them for the length chosen", async () => {
  const dir = computer({ "destructive-shell": { mode: "override", override: terms("person") } });
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: `rm -rf ${REPO}/old-build` } }], { handler });
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    const block = tray.recent_blocks.find((b) => b.action_id === id);
    assert.deepEqual(block.offers.similar, {
      recipe_id: "delete-in-folder", words: `Deleting folders inside ${REPO} with rm`, covers: [`rm -r ${REPO}/old-build`], not_covers: ["rm -rf /work"],
    });
    const done = await answer(dir, { action_id: id, choice: "always", reason: "", scope: "similar" });
    assert.equal(done.outcome, "allowed");
    assert.equal(done.scope, "similar");
    assert.equal(done.text, `Allowed for 30 days: deleting folders inside ${REPO} with rm · recorded on this computer`);
    const pattern = readAllowances(dir).find((a) => a.match);
    assert.equal(pattern.match.bounds.value, REPO);
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

test("where an admin must approve, the offer says so and the pattern waits", async () => {
  const dir = computer({ "destructive-shell": { mode: "override", override: terms("needs_admin") } });
  await blockActions(dir, [{ tool_name: "Bash", tool_input: { command: `rm -rf ${REPO}/old-build` } }], { handler });
  const id = readBlocked(dir).at(-1).id;
  const service = await serviceFor(dir);
  try {
    const { tray } = await callAgent(dir, "GET", "/tray", undefined, 10_000);
    assert.equal(tray.recent_blocks.find((b) => b.action_id === id).offers.similar.needs_admin, true);
    assert.equal((await answer(dir, { action_id: id, choice: "always", reason: "", scope: "similar" })).outcome, "proposed");
    assert.equal(readAllowances(dir).find((a) => a.match).state, "proposed");
  } finally { await service.stop(); }
});
