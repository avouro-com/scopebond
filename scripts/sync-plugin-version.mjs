#!/usr/bin/env node
// Keep the Claude Code plugin's hook command pinned to the @scopebond/hook version in
// this repository. Runs after `changeset version`, so a Version-packages PR updates the
// plugin together with the package; `check-release-state.mjs` fails if they drift.

import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("packages/hook/package.json", "utf8")).version;
const file = "packages/hook/hooks/hooks.json";
const before = readFileSync(file, "utf8");
const after = before.replace(/@scopebond\/hook@[0-9A-Za-z.+-]+/g, `@scopebond/hook@${version}`);
if (after !== before) {
  writeFileSync(file, after);
  console.log(`${file}: pinned @scopebond/hook@${version}`);
}
