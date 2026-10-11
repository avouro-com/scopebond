// SCOPEBOND_HOSTNAME_MODE: the computer name a sign-in sends is the host name (full, the default), a short stable hash
// of it (hash), or nothing (off).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { clientNameField, computerName, hashedHostname, hostnameMode } from "../dist/index.js";

test("the mode: full by default, hash or off when asked, and hash for a value it does not know", () => {
  assert.equal(hostnameMode({}), "full");
  assert.equal(hostnameMode({ SCOPEBOND_HOSTNAME_MODE: "" }), "full");
  assert.equal(hostnameMode({ SCOPEBOND_HOSTNAME_MODE: "FULL" }), "full");
  assert.equal(hostnameMode({ SCOPEBOND_HOSTNAME_MODE: " hash " }), "hash");
  assert.equal(hostnameMode({ SCOPEBOND_HOSTNAME_MODE: "off" }), "off");
  assert.equal(hostnameMode({ SCOPEBOND_HOSTNAME_MODE: "something-else" }), "hash", "less is sent, never more");
});

test("full sends the host name; hash the first 12 hex of its SHA-256, the same for every spelling of its case; off nothing", () => {
  assert.equal(computerName("full", "JANES-LAPTOP"), "JANES-LAPTOP");
  const expected = createHash("sha256").update("janes-laptop").digest("hex").slice(0, 12);
  assert.equal(computerName("hash", "JANES-LAPTOP"), expected);
  assert.equal(hashedHostname("janes-laptop"), expected);
  assert.match(expected, /^[0-9a-f]{12}$/);
  assert.notEqual(computerName("hash", "BOBS-LAPTOP"), expected);
  assert.equal(computerName("off", "JANES-LAPTOP"), null);
  assert.equal(computerName("full", "  "), null, "no name to give");
  assert.equal(computerName("full"), hostname() || null, "the system's host name by default");
});

test("the sign-in field: present for full and hash, left out for off", () => {
  assert.deepEqual(clientNameField("full", "JANES-LAPTOP"), { client_name: "JANES-LAPTOP" });
  assert.deepEqual(clientNameField("hash", "JANES-LAPTOP"), { client_name: hashedHostname("JANES-LAPTOP") });
  assert.deepEqual(clientNameField("off", "JANES-LAPTOP"), {});
});
