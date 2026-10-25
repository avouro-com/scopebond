// The command line as one file. Coding agents run `dist/cli.js` on every tool call, and loading the hook's modules one by
// one (about a hundred files, each resolved, read and compiled) took longer than the decision itself. The package build
// (`build`, after `tsc`) bundles what cli.js loads into dist/cli-bundle.js and points cli.js at it:
//
//   dist/cli-bundle.js  hook-deadline.js and cli-main.js with everything they import (the workspace packages included),
//                       one ES module, exporting `armHookDeadline` and `main`
//   dist/cli.js         tsc's own output, with its two `import()`s of those modules changed to the bundle; its fail-closed
//                       answer stays in that file, ahead of the bundle, so a bundle that cannot load still denies
//
// Every other file in dist/ is left as tsc wrote it: the library (`exports`) does not change. A later plain `tsc` puts
// cli.js back to loading the separate modules, so a bundle older than the sources is never what runs.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const BUNDLE_FILE = "cli-bundle.js";
const LOADED = ["./hook-deadline.js", "./cli-main.js"];

const result = await build({
  stdin: {
    contents: `export { armHookDeadline } from "${LOADED[0]}";\nexport { main } from "${LOADED[1]}";\n`,
    resolveDir: dist, sourcefile: "cli-bundle-entry.js", loader: "js",
  },
  outfile: join(dist, BUNDLE_FILE),
  bundle: true, platform: "node", format: "esm", target: "node22",
  // Names stay as written (error messages and class names read them); the rest is minified, which also parses faster.
  minify: true, keepNames: true, legalComments: "none", logLevel: "silent",
  banner: { js: "// @scopebond/hook command line, bundled by scripts/bundle-cli.mjs from this package's dist/ (Apache-2.0)." },
});
if (result.warnings.length) throw new Error(`the command-line bundle has warnings:\n${result.warnings.map((w) => w.text).join("\n")}`);
const bundled = readFileSync(join(dist, BUNDLE_FILE), "utf8");
// Anything the bundle still loads by a path at run time would be read from beside it, and could be missing or stale.
if (/\bimport\(\s*["'`]\.{1,2}\//.test(bundled) || /\brequire\(\s*["'`]\.{1,2}\//.test(bundled)) throw new Error("the command-line bundle still loads a relative module at run time");

const cliFile = join(dist, "cli.js");
let cli = readFileSync(cliFile, "utf8");
const target = `import("./${BUNDLE_FILE}")`;
const already = cli.split(target).length - 1;
if (already === 0) {
  for (const path of LOADED) {
    const call = `import("${path}")`;
    const count = cli.split(call).length - 1;
    if (count !== 1) throw new Error(`dist/cli.js should load ${path} exactly once with import(), found ${count}: has cli.ts changed?`);
    cli = cli.replace(call, target);
  }
  writeFileSync(cliFile, cli);
} else if (already !== LOADED.length || LOADED.some((path) => cli.includes(`import("${path}")`))) {
  throw new Error("dist/cli.js is partly pointed at the bundle: rebuild with tsc first");
}
console.log(`bundled the command line: dist/${BUNDLE_FILE} (${Math.round(bundled.length / 1024)} KiB)`);
