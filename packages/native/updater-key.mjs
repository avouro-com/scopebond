// Make the updater key, once, on a computer the owner trusts. It prints only the public half's location; the private half
// goes to a file for the owner to store as the `UPDATER_SIGNING_KEY` secret of the `signing` environment and then keep
// offline. The public half is committed (updater-public-key.txt) and built into every signed agent.
//
//   node updater-key.mjs [private-key-file]
//
// Rotating it: `--add` makes a new key and adds its public half to updater-keys.json (created from updater-public-key.txt
// the first time), so the next release trusts both. Release that (still signed with the old key), then switch the secret
// to the new private key; set the old entry's `not_after` (its last day, YYYY-MM-DD) and, once every install has moved,
// remove it. An agent never accepts a manifest signed by a key past its `not_after`.
//
//   node updater-key.mjs --add [private-key-file] [--not-after YYYY-MM-DD]

import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const add = args.includes("--add");
const notAfterAt = args.indexOf("--not-after");
const notAfter = notAfterAt >= 0 ? args[notAfterAt + 1] : null;
const positional = args.filter((a, i) => !a.startsWith("--") && i !== notAfterAt + 1);
const privateFile = resolve(positional[0] ?? "scopebond-updater-key.pem");
const publicFile = join(here, "updater-public-key.txt");
const listFile = join(here, "updater-keys.json");
const keyId = (b64) => createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").slice(0, 16);

if (existsSync(privateFile)) { console.error(`${privateFile} exists already; nothing changed`); process.exit(1); }
if (notAfter !== null && !/^\d{4}-\d{2}-\d{2}$/.test(notAfter ?? "")) { console.error("--not-after takes a date, YYYY-MM-DD"); process.exit(1); }
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");
writeFileSync(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
if (add) {
  const list = existsSync(listFile) ? JSON.parse(readFileSync(listFile, "utf8"))
    : existsSync(publicFile) ? [{ kid: keyId(readFileSync(publicFile, "utf8").trim()), key: readFileSync(publicFile, "utf8").trim(), not_after: null }] : [];
  list.push({ kid: keyId(pub), key: pub, not_after: notAfter });
  writeFileSync(listFile, `${JSON.stringify(list, null, 2)}\n`);
  console.log(`Added key ${keyId(pub)} to ${listFile} (commit it; the next release trusts every key listed there).`);
} else {
  writeFileSync(publicFile, `${pub}\n`);
  console.log(`Public key: ${publicFile} (commit it).`);
}
console.log(`Private key: ${privateFile}. Store it as the signing environment's secret, then keep it offline and delete this copy:`);
console.log(process.platform === "win32"
  ? `  Get-Content -Raw "${privateFile}" | gh secret set UPDATER_SIGNING_KEY --env signing --repo avouro-com/scopebond`
  : `  gh secret set UPDATER_SIGNING_KEY --env signing --repo avouro-com/scopebond < "${privateFile}"`);
