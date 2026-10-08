import { test } from "node:test";
import assert from "node:assert/strict";
import { signedIn, claVerdict, SIGNING_SENTENCE } from "./cla-check.mjs";

const template = (box) => `## What & why

Fixes a thing.

## Checklist

- [ ] \`pnpm run gate\` passes locally (no private material, no secrets).
- ${box} I agree to the [CLA](../CLA.md).

<!-- Reminder: this repo is PUBLIC. -->`;

test("signedIn: the template's box, ticked, signs; unticked does not", () => {
  assert.equal(signedIn(template("[x]")), true);
  assert.equal(signedIn(template("[X]")), true);
  assert.equal(signedIn(template("[ ]")), false);
  assert.equal(signedIn("* [x] I agree to the CLA"), true);
  assert.equal(signedIn("> - [x] I agree to the [CLA](CLA.md)."), true); // copied from CLA.md
});

test("signedIn: the signing sentence on its own line, quoted or not, signs", () => {
  assert.equal(signedIn(`Some text.\n\n${SIGNING_SENTENCE}\n`), true);
  assert.equal(signedIn(`> ${SIGNING_SENTENCE}.`), true);
  assert.equal(signedIn(`I did not say "${SIGNING_SENTENCE}" here`), false);
});

test("signedIn: nothing inside an HTML comment counts, and empty bodies do not sign", () => {
  assert.equal(signedIn(`<!-- - [x] I agree to the [CLA](../CLA.md). -->`), false);
  assert.equal(signedIn(`<!--\n${SIGNING_SENTENCE}\n`), false);
  assert.equal(signedIn(""), false);
  assert.equal(signedIn(null), false);
});

test("claVerdict: maintainers and dependency bots pass; other authors must sign", () => {
  const pr = (login, author_association, body = "") => ({ pull_request: { user: { login }, author_association, body } });
  assert.equal(claVerdict(pr("avourohq", "OWNER")).ok, true);
  assert.equal(claVerdict(pr("someone", "MEMBER")).ok, true);
  assert.equal(claVerdict(pr("someone", "COLLABORATOR")).ok, true);
  assert.equal(claVerdict(pr("dependabot[bot]", "NONE")).ok, true);
  assert.equal(claVerdict(pr("contributor", "CONTRIBUTOR")).ok, false);
  assert.equal(claVerdict(pr("contributor", "FIRST_TIME_CONTRIBUTOR", template("[x]"))).ok, true);
  // A bot-looking login that is not one of the two exempt bots still signs.
  assert.equal(claVerdict(pr("evil[bot]", "NONE")).ok, false);
});
