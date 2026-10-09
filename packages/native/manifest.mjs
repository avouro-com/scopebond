// The release manifest a signed install trusts before it installs an update: each file's name, SHA-256 and size, signed
// with the updater key (Ed25519, kept as the `UPDATER_SIGNING_KEY` secret of the `signing` environment, separate from the
// Authenticode certificate). The manifest names the id of the key that signed it (`kid`), so an agent that trusts several
// keys (during a rotation) checks it with that one. The agent checks it with the public keys built into it
// (updater-keys.json, or updater-public-key.txt).
//
//   UPDATER_SIGNING_KEY=<PEM> node manifest.mjs <version> <folder>   → <folder>/scopebond-agent-<version>.manifest.json(.sig)

import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_DOMAIN = "scopebond:agent-release/v1\n";

/** A public key's id (base64 SPKI): the first 16 hex digits of the SHA-256 of its SPKI bytes, as the agent computes it. */
export function keyId(publicKeyB64) {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex").slice(0, 16);
}

/** The id of the key whose private half is `privateKeyPem`. */
export function keyIdOfPrivate(privateKeyPem) {
  return keyId(createPublicKey(createPrivateKey(privateKeyPem)).export({ type: "spki", format: "der" }).toString("base64"));
}

export function manifestFor(version, folder, kid = undefined) {
  const files = readdirSync(folder).filter((name) => /\.(exe|msi)$/i.test(name)).sort().map((name) => {
    const bytes = readFileSync(join(folder, name));
    return { name, sha256: createHash("sha256").update(bytes).digest("hex"), size: statSync(join(folder, name)).size };
  });
  return `${JSON.stringify({ type: "scopebond:agent-release", version, ...(kid ? { kid } : {}), files }, null, 2)}\n`;
}

export function signManifest(text, privateKeyPem) {
  return sign(null, Buffer.from(MANIFEST_DOMAIN + text, "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [version, folder] = process.argv.slice(2);
  const key = process.env.UPDATER_SIGNING_KEY;
  if (!version || !folder) { console.error("usage: node manifest.mjs <version> <folder>"); process.exit(1); }
  // A release without a signed manifest is one signed installs never update to: that fails the release, never passes it.
  if (!key) { console.error("UPDATER_SIGNING_KEY is not set: a release needs its signed manifest (signed installs update only to a release that has one)"); process.exit(1); }
  const text = manifestFor(version, folder, keyIdOfPrivate(key));
  const name = join(folder, `scopebond-agent-${version}.manifest.json`);
  writeFileSync(name, text);
  writeFileSync(`${name}.sig`, `${signManifest(text, key)}\n`);
  console.log(`signed ${name}`);
}
