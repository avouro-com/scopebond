// Builds dist/action.mjs: the check CLI with every dependency inlined. The composite action runs this file
// from the published package without installing any dependency, so the action's version (and therefore a
// pinned commit of the action) fixes all of the code that decides the check, not only this package's own.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "action.mjs");

const result = await build({
  entryPoints: [join(root, "dist", "cli.js")],
  outfile,
  bundle: true, platform: "node", format: "esm", target: "node20",
  // Bundled CommonJS dependencies may call require() for Node built-ins.
  banner: { js: 'import { createRequire as __sbCreateRequire } from "node:module"; const require = __sbCreateRequire(import.meta.url);' },
  minify: false, keepNames: true, legalComments: "inline", logLevel: "silent",
});
if (result.warnings.length) throw new Error(`the bundle has warnings:\n${result.warnings.map((w) => w.text).join("\n")}`);

const code = readFileSync(outfile, "utf8");
// Nothing may be loaded from node_modules at run time: every import left in the file must be a Node built-in.
const external = [...code.matchAll(/(?:^|[\s;])(?:import\s*(?:[^"'`;]*?\s+from\s*)?|import\(\s*|require\(\s*)["'`]([^"'`]+)["'`]/g)]
  .map((m) => m[1]).filter((spec) => !spec.startsWith("node:") && !builtinModules.includes(spec));
if (external.length) throw new Error(`the bundle still loads modules at run time: ${[...new Set(external)].join(", ")}`);
console.log(`bundled ${outfile} (${(code.length / 1024).toFixed(0)} KiB)`);
