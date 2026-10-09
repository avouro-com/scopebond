// Node-only: persist the attester's Ed25519 key to a file so receipts are
// verifiable across restarts. The gateway core stays runtime-agnostic; this file
// (fs) is imported only by the Node CLI and via "@scopebond/gateway/node".

import { generateKeyPairSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { attesterFromPrivateKeyPem } from "./receipts.js";
import { keepOwnerOnly, placeOwnerOnly, readSettled } from "./node-files.js";
import type { Attester } from "./receipts.js";

/** A whole PEM: a file another process has claimed but not yet written is not one. */
const completePem = (text: string): boolean => /-----END [A-Z ]*PRIVATE KEY-----/.test(text);

/** Load the attester key from `file`, or generate and persist one, readable by its owner alone from its first byte.
 *  Processes that create it at the same moment all use the one that reached the name first. An existing key file made
 *  by an older version is restricted to its owner. The kid, unless given, is derived from the public key. */
export function loadOrCreateAttester(opts: { file: string; kid?: string }): { attester: Attester; created: boolean } {
  const { file, kid } = opts;
  const existing = readSettled(file, completePem);
  if (existing !== undefined) {
    keepOwnerOnly(file);
    return { attester: attesterFromPrivateKeyPem(existing, kid), created: false };
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = dirname(file);
  if (dir) mkdirSync(dir, { recursive: true });
  // Exclusive: a key file made by someone else in the meantime is read, never written into.
  if (!placeOwnerOnly(file, pem, true)) {
    return { attester: attesterFromPrivateKeyPem(readSettled(file, completePem) ?? "", kid), created: false };
  }
  return { attester: attesterFromPrivateKeyPem(pem, kid), created: true };
}
