// Make the updater key, once, on a computer the owner trusts. It prints only the public half's location; the private half
// goes to a file for the owner to store as the `UPDATER_SIGNING_KEY` secret of the `signing` environment and then keep
// offline. The public half is committed (updater-public-key.txt) and built into every signed agent.
//
//   node updater-key.mjs [private-key-file]

import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const privateFile = resolve(process.argv[2] ?? "scopebond-updater-key.pem");
const publicFile = join(here, "updater-public-key.txt");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
// Exclusive create: never write the private key into a file (or through a link) that someone else made first.
try {
  writeFileSync(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
  console.error(`${privateFile} exists already; nothing changed`);
  process.exit(1);
}
writeFileSync(publicFile, `${publicKey.export({ type: "spki", format: "der" }).toString("base64")}\n`);
console.log(`Public key: ${publicFile} (commit it).`);
console.log(`Private key: ${privateFile}. Store it as the signing environment's secret, then keep it offline and delete this copy:`);
console.log(process.platform === "win32"
  ? `  Get-Content -Raw "${privateFile}" | gh secret set UPDATER_SIGNING_KEY --env signing --repo avouro-com/scopebond`
  : `  gh secret set UPDATER_SIGNING_KEY --env signing --repo avouro-com/scopebond < "${privateFile}"`);
