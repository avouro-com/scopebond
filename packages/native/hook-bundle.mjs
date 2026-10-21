// The engine bundle: the hook as one signed file the agent can put in place without a new installer (engine-shim.ts in the
// hook loads it). Built from main by the release workflow, beside the signed executable:
//
//   node hook-bundle.mjs build <folder> <commit>
//     → <folder>/scopebond-hook-bundle-<v>.tgz            scopebond-hook.cjs (esbuild, one CommonJS file), LICENSE, NOTICE
//       <folder>/scopebond-hook-bundle-<v>.manifest.json  { type, version, sha256, files, built_from }, not signed yet
//
//   UPDATER_SIGNING_KEY=<PEM> node hook-bundle.mjs sign <folder> <commit>
//     → the manifest again with the signing key's id (`kid`), and <manifest>.sig: Ed25519 over
//       "scopebond:hook-bundle/v1\n" + the manifest's bytes, with the same updater key the release manifest uses.
//
// `<v>` is the hook's version. The signing step uses Node's built-ins only (the job that holds the key installs nothing):
// it checks the archive's digest, the version and the commit against the unsigned manifest before it signs.

import { createHash, createPrivateKey, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { COMMIT_ID, keyIdOfPrivate } from "./manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
export const BUNDLE_DOMAIN = "scopebond:hook-bundle/v1\n";
export const BUNDLE_FILE = "scopebond-hook.cjs";
export const hookVersion = () => JSON.parse(readFileSync(join(here, "..", "hook", "package.json"), "utf8")).version;
export const bundleName = (version) => `scopebond-hook-bundle-${version}.tgz`;
export const manifestName = (version) => `scopebond-hook-bundle-${version}.manifest.json`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Bundle the hook into one CommonJS file: the bundle entry (src/hook-bundle-main.mjs) with every dependency inside,
 *  `import.meta.url` as the file's own URL, the hook version fixed, and Node running the file as the command line. */
export async function bundleHookFile(outFile, version = hookVersion()) {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [join(here, "src", "hook-bundle-main.mjs")],
    outfile: outFile,
    bundle: true, platform: "node", format: "cjs", target: "node22",
    define: {
      "import.meta.url": "__sbBundleUrl",
      __SCOPEBOND_HOOK_VERSION__: JSON.stringify(version),
      __SCOPEBOND_HOOK_BUNDLE__: "true",
    },
    banner: { js: 'var __sbBundleUrl = require("node:url").pathToFileURL(__filename).href;' },
    // Run as a program (`node scopebond-hook.cjs packs test --all`); loaded by the shim, it only exports `run`.
    footer: { js: "if (typeof require !== \"undefined\" && require.main === module) module.exports.run(process.argv.slice(2));" },
    minify: true, keepNames: true, legalComments: "none", metafile: false, logLevel: "silent",
  });
  if (result.warnings.length) throw new Error(`the bundle has warnings:\n${result.warnings.map((w) => w.text).join("\n")}`);
  const code = readFileSync(outFile, "utf8");
  if (/\bimport\(\s*["'`]/.test(code)) throw new Error("the bundle still loads a module at run time (import())");
  return outFile;
}

/** The unsigned manifest for an archive: its version, SHA-256, the files inside it and the commit it was built from. */
export function bundleManifest({ version, tgz, files, commit, kid }) {
  if (typeof commit !== "string" || !COMMIT_ID.test(commit)) throw new Error(`a bundle manifest names its full commit id, not ${commit}`);
  return `${JSON.stringify({
    type: "scopebond:hook-bundle", version, ...(kid ? { kid } : {}), sha256: sha256(tgz),
    files: files.map((f) => ({ name: f.name, sha256: sha256(f.bytes), size: f.bytes.length })), built_from: commit,
  }, null, 2)}\n`;
}

export function signBundleManifest(text, privateKeyPem) {
  return sign(null, Buffer.from(BUNDLE_DOMAIN + text, "utf8"), createPrivateKey(privateKeyPem)).toString("base64");
}

/** Build the archive and its unsigned manifest into `folder`. Returns their paths. */
export async function buildBundle(folder, commit, version = hookVersion()) {
  mkdirSync(folder, { recursive: true });
  const file = await bundleHookFile(join(folder, BUNDLE_FILE), version);
  // The archive writer is the agent's (tgz.ts), so the agent reads exactly what this writes.
  const { packTgz } = await import(pathToFileURL(join(here, "..", "agent", "dist", "tgz.js")).href);
  const files = [
    { name: BUNDLE_FILE, bytes: readFileSync(file) },
    { name: "LICENSE", bytes: readFileSync(join(root, "LICENSE")) },
    { name: "NOTICE", bytes: readFileSync(join(root, "NOTICE")) },
  ];
  const tgz = packTgz(files);
  const archive = join(folder, bundleName(version));
  writeFileSync(archive, tgz);
  const manifest = join(folder, manifestName(version));
  writeFileSync(manifest, bundleManifest({ version, tgz, files, commit }));
  return { archive, manifest };
}

/** Sign the manifest in `folder` with the updater key, after checking it still describes the archive beside it. */
export function signBundle(folder, commit, privateKeyPem, version = hookVersion()) {
  const manifestFile = join(folder, manifestName(version));
  const archive = join(folder, bundleName(version));
  if (!existsSync(manifestFile) || !existsSync(archive)) throw new Error(`no bundle ${version} in ${folder}`);
  const unsigned = JSON.parse(readFileSync(manifestFile, "utf8"));
  const tgz = readFileSync(archive);
  if (unsigned.type !== "scopebond:hook-bundle" || unsigned.version !== version) throw new Error(`the manifest is not for the hook bundle ${version}`);
  if (unsigned.sha256 !== sha256(tgz)) throw new Error("the archive is not the one the manifest names");
  if (unsigned.built_from !== commit) throw new Error(`the manifest names commit ${unsigned.built_from}, not ${commit}`);
  const text = `${JSON.stringify({ type: unsigned.type, version, kid: keyIdOfPrivate(privateKeyPem), sha256: unsigned.sha256, files: unsigned.files, built_from: commit }, null, 2)}\n`;
  writeFileSync(manifestFile, text);
  writeFileSync(`${manifestFile}.sig`, `${signBundleManifest(text, privateKeyPem)}\n`);
  return manifestFile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [command, folder, commit] = process.argv.slice(2);
  if (!["build", "sign"].includes(command) || !folder || !commit) { console.error("usage: node hook-bundle.mjs build|sign <folder> <commit>"); process.exit(1); }
  if (!COMMIT_ID.test(commit)) { console.error(`not a full commit id: ${commit}`); process.exit(1); }
  if (command === "build") {
    const built = await buildBundle(resolve(folder), commit);
    console.log(`built ${built.archive}`);
  } else {
    const key = process.env.UPDATER_SIGNING_KEY;
    // A bundle without a signed manifest is one no signed install would load: that fails the release, never passes it.
    if (!key) { console.error("UPDATER_SIGNING_KEY is not set: the engine bundle needs its signed manifest"); process.exit(1); }
    console.log(`signed ${signBundle(resolve(folder), commit, key)}`);
  }
}
