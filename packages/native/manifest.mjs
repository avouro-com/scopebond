// The release manifest a signed install trusts before it installs an update: each file's name, SHA-256 and size, signed
// with the updater key (Ed25519, kept as the `UPDATER_SIGNING_KEY` secret of the `signing` environment, separate from the
// Authenticode certificate). The agent checks it with the public key built into it (updater-public-key.txt).
//
//   UPDATER_SIGNING_KEY=<PEM> node manifest.mjs <version> <folder>   → <folder>/scopebond-agent-<version>.manifest.json(.sig)

import { createHash, createPrivateKey, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_DOMAIN = "scopebond:agent-release/v1\n";

export function manifestFor(version, folder) {
  const files = readdirSync(folder).filter((name) => /\.(exe|msi)$/i.test(name)).sort().map((name) => {
    const bytes = readFileSync(join(folder, name));
    return { name, sha256: createHash("sha256").update(bytes).digest("hex"), size: statSync(join(folder, name)).size };
  });
  return `${JSON.stringify({ type: "scopebond:agent-release", version, files }, null, 2)}\n`;
}

export function signManifest(text, privateKeyPem) {
  return sign(null, Buffer.from(MANIFEST_DOMAIN + text, "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [version, folder] = process.argv.slice(2);
  const key = process.env.UPDATER_SIGNING_KEY;
  if (!version || !folder) { console.error("usage: node manifest.mjs <version> <folder>"); process.exit(1); }
  if (!key) { console.error("UPDATER_SIGNING_KEY is not set: no manifest, so signed installs will not update to this release by themselves"); process.exit(0); }
  const text = manifestFor(version, folder);
  const name = join(folder, `scopebond-agent-${version}.manifest.json`);
  writeFileSync(name, text);
  writeFileSync(`${name}.sig`, `${signManifest(text, key)}\n`);
  console.log(`signed ${name}`);
}
