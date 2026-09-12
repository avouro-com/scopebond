// Node-only: persist the attester's Ed25519 key to a file so receipts are
// verifiable across restarts. The gateway core stays runtime-agnostic; this file
// (fs) is imported only by the Node CLI and via "@scopebond/gateway/node".

import { generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { attesterFromPrivateKeyPem } from "./receipts.js";
import type { Attester } from "./receipts.js";

/** Load the attester key from `file`, or generate + persist one (0600) if absent.
 *  The kid, unless given, is derived from the public key and is stable thereafter. */
export function loadOrCreateAttester(opts: { file: string; kid?: string }): { attester: Attester; created: boolean } {
  const { file, kid } = opts;
  if (existsSync(file)) {
    return { attester: attesterFromPrivateKeyPem(readFileSync(file, "utf8"), kid), created: false };
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const dir = dirname(file);
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(file, pem, { mode: 0o600 });
  return { attester: attesterFromPrivateKeyPem(pem, kid), created: true };
}
