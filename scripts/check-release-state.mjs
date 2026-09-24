#!/usr/bin/env node

import { readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));

const packages = {
  "policy-schema": json("packages/policy-schema/package.json").version,
  verify: json("packages/verify/package.json").version,
  gateway: json("packages/gateway/package.json").version,
  sdk: json("packages/sdk/package.json").version,
};

const rootReadme = read("README.md");
const packageReadme = read("packages/README.md");
const gatewayReadme = read("packages/gateway/README.md");
const failures = [];

for (const [name, version] of Object.entries(packages)) {
  const scoped = `@scopebond/${name}@${version}`;
  if (!rootReadme.includes(scoped)) failures.push(`README.md must name ${scoped}`);
  if (!packageReadme.includes(`published ${version}`)) {
    failures.push(`packages/README.md must mark ${name} as published ${version}`);
  }
}

const enrollment = `@scopebond/gateway@${packages.gateway} enroll`;
if (!gatewayReadme.includes(enrollment)) {
  failures.push(`packages/gateway/README.md must use ${enrollment}`);
}

// The Claude Code plugin runs the hook through a pinned npx command; it must pin the
// version this repository ships (scripts/sync-plugin-version.mjs keeps it in step).
const hookVersion = json("packages/hook/package.json").version;
const pluginHooks = read("packages/hook/hooks/hooks.json");
for (const pin of pluginHooks.match(/@scopebond\/hook@[0-9A-Za-z.+-]+/g) ?? []) {
  if (pin !== `@scopebond/hook@${hookVersion}`) failures.push(`packages/hook/hooks/hooks.json pins ${pin}; expected @scopebond/hook@${hookVersion} (run node scripts/sync-plugin-version.mjs)`);
}
const pluginVersion = json("packages/hook/.claude-plugin/plugin.json").version;
if (pluginVersion !== hookVersion) failures.push(`packages/hook/.claude-plugin/plugin.json version ${pluginVersion}; expected ${hookVersion} (run node scripts/sync-plugin-version.mjs)`);

const staleClaims = [
  [rootReadme, "README.md", /reviewed but unpublished|Published versions remain/i],
  [packageReadme, "packages/README.md", /not yet published|local publication candidate/i],
];
for (const [content, path, pattern] of staleClaims) {
  if (pattern.test(content)) failures.push(`${path} contains stale publication language (${pattern})`);
}

if (failures.length) {
  console.error(`Release-state check failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `release-state: schema ${packages["policy-schema"]}, verify ${packages.verify}, `
  + `gateway ${packages.gateway}, sdk ${packages.sdk}`,
);
