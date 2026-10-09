// Build the single executable: bundle the agent and the hook into one CommonJS file, turn it into a Node single
// executable application blob (with a code cache), copy this Node, and inject the blob.
//
//   node build-sea.mjs            → build/scopebond-agent(.exe)
//
// The copy of Node keeps its own version resources; signing happens in the release workflow, after this. A copy of a
// signed node.exe carries Node's signature, which no longer matches once the blob is in, so it is removed first.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyId } from "./manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "build");
const windows = process.platform === "win32";
const exe = join(out, windows ? "scopebond-agent.exe" : "scopebond-agent");
const version = (pkg) => JSON.parse(readFileSync(join(here, "..", pkg, "package.json"), "utf8")).version;
export const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** The updater keys, as the JSON text the agent reads: updater-keys.json ([{ kid, key, not_after }]) when it exists, else
 *  the one key in updater-public-key.txt with no last day; `undefined` when there is neither. */
export function updaterKeysDefine(folder = here) {
  const list = join(folder, "updater-keys.json");
  const single = join(folder, "updater-public-key.txt");
  let keys = null;
  if (existsSync(list)) keys = JSON.parse(readFileSync(list, "utf8"));
  else if (existsSync(single)) {
    const key = readFileSync(single, "utf8").trim();
    keys = [{ kid: keyId(key), key, not_after: null }];
  }
  if (!Array.isArray(keys) || !keys.length) return "undefined";
  for (const k of keys) {
    if (typeof k?.key !== "string" || !k.key) throw new Error("updater-keys.json: every entry needs a key");
    if (k.kid !== undefined && k.kid !== keyId(k.key)) throw new Error(`updater-keys.json: kid ${k.kid} is not the id of its key (${keyId(k.key)})`);
    if (k.not_after != null && Number.isNaN(Date.parse(k.not_after))) throw new Error(`updater-keys.json: not_after ${k.not_after} is not a date`);
  }
  return JSON.stringify(JSON.stringify(keys.map((k) => ({ kid: keyId(k.key), key: k.key, not_after: k.not_after ?? null }))));
}

export async function bundle() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const result = await build({
    entryPoints: [join(here, "src", "sea-main.mjs")],
    outfile: join(out, "sea-main.cjs"),
    bundle: true, platform: "node", format: "cjs", target: "node22",
    // In the bundle there is no module file to point at: import.meta.url becomes the executable's own URL (code that
    // reads a file beside itself is guarded, and uses its fallbacks), and the versions are fixed at build time.
    define: {
      "import.meta.url": "__sbUrl",
      __SCOPEBOND_HOOK_VERSION__: JSON.stringify(version("hook")),
      __SCOPEBOND_AGENT_VERSION__: JSON.stringify(version("agent")),
      // The updater keys this build trusts (updater-keys.json, or the single updater-public-key.txt), when there are any;
      // without them the build never updates itself.
      __SCOPEBOND_UPDATER_KEYS__: updaterKeysDefine(),
    },
    banner: { js: 'var __sbUrl = require("node:url").pathToFileURL(process.execPath).href;' },
    minify: false, keepNames: true, sourcemap: "external", metafile: true, logLevel: "silent",
  });
  if (result.warnings.length) throw new Error(`the bundle has warnings:\n${result.warnings.map((w) => w.text).join("\n")}`);
  const code = readFileSync(join(out, "sea-main.cjs"), "utf8");
  // A real dynamic import cannot load anything in a single executable: everything must be in the file.
  if (/\bimport\(\s*["'`]/.test(code)) throw new Error("the bundle still loads a module at run time (import())");
  writeFileSync(join(out, "meta.json"), JSON.stringify(result.metafile));
  return join(out, "sea-main.cjs");
}

function signtool() {
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!existsSync(kits)) return null;
  const versions = readdirSync(kits).filter((d) => /^10\./.test(d)).sort().reverse();
  for (const v of versions) { const tool = join(kits, v, "x64", "signtool.exe"); if (existsSync(tool)) return tool; }
  return null;
}

export async function buildSea() {
  const main = await bundle();
  const config = join(out, "sea-config.json");
  writeFileSync(config, JSON.stringify({ main, output: join(out, "sea-prep.blob"), disableExperimentalSEAWarning: true, useCodeCache: true, useSnapshot: false }, null, 2));
  execFileSync(process.execPath, ["--experimental-sea-config", config], { stdio: "inherit" });
  copyFileSync(process.execPath, exe);
  if (!windows) chmodSync(exe, 0o755);
  if (windows) {
    const tool = signtool();
    if (tool) { try { execFileSync(tool, ["remove", "/s", exe], { stdio: "ignore" }); } catch { /* an unsigned Node */ } }
  } else if (process.platform === "darwin") {
    execFileSync("codesign", ["--remove-signature", exe], { stdio: "inherit" });
  }
  const postject = join(here, "node_modules", "postject", "dist", "cli.js");
  execFileSync(process.execPath, [postject, exe, "NODE_SEA_BLOB", join(out, "sea-prep.blob"), "--sentinel-fuse", FUSE,
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : [])], { stdio: "inherit" });
  return exe;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const built = await buildSea();
  console.log(`built ${built}`);
}
