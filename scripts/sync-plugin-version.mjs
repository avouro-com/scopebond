#!/usr/bin/env node
// Keep every version pin in the repository in step with the package.json versions.
// Runs after `changeset version` (`pnpm run version:packages`), so a Version-packages
// PR updates the pins together with the packages and `check-release-state.mjs` passes
// without manual edits:
//   - the Claude Code plugin's hook command (packages/hook/hooks/hooks.json) and the
//     plugin manifest version (packages/hook/.claude-plugin/plugin.json) → the hook version;
//   - README.md `@scopebond/<pkg>@x.y.z` pins → each package's version;
//   - packages/README.md "published x.y.z" in each package's table row;
//   - packages/gateway/README.md `@scopebond/gateway@x.y.z` pins.

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const versions = {};
for (const dir of readdirSync("packages", { withFileTypes: true })) {
  const file = `packages/${dir.name}/package.json`;
  if (!dir.isDirectory() || !existsSync(file)) continue;
  const pkg = JSON.parse(read(file));
  if (pkg.name?.startsWith("@scopebond/") && pkg.version) versions[dir.name] = { name: pkg.name, version: pkg.version };
}
const VERSION = "[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?";
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

function update(file, transform) {
  if (!existsSync(file)) return;
  const before = read(file);
  const after = transform(before);
  if (after !== before) {
    writeFileSync(file, after);
    console.log(`${file}: updated version pins`);
  }
}

/** Rewrite every `@scopebond/<pkg>@x.y.z` to the package's current version. */
const pinScoped = (text) => {
  let out = text;
  for (const { name, version } of Object.values(versions)) {
    out = out.replace(new RegExp(`${escape(name)}@${VERSION}`, "g"), `${name}@${version}`);
  }
  return out;
};

const hook = versions.hook?.version;
if (hook) {
  update("packages/hook/hooks/hooks.json", (t) => t.replace(new RegExp(`@scopebond/hook@${VERSION}`, "g"), `@scopebond/hook@${hook}`));
  update("packages/hook/.claude-plugin/plugin.json", (t) => t.replace(/("version"\s*:\s*")[^"]*(")/, `$1${hook}$2`));
}
update("README.md", pinScoped);
update("packages/gateway/README.md", pinScoped);
// packages/README.md: the status column of each package's row, `| \`<dir>\` | … (published x.y.z`.
update("packages/README.md", (text) => text.split("\n").map((line) => {
  const m = /^\| `([a-z-]+)` \|/.exec(line);
  const v = m && versions[m[1]]?.version;
  return v ? line.replace(new RegExp(`published ${VERSION}`), `published ${v}`) : line;
}).join("\n"));
