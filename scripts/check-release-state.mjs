#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));

const packages = {
  "policy-schema": json("packages/policy-schema/package.json").version,
  verify: json("packages/verify/package.json").version,
  gateway: json("packages/gateway/package.json").version,
  sdk: json("packages/sdk/package.json").version,
  hook: json("packages/hook/package.json").version,
  agent: json("packages/agent/package.json").version,
  "github-action": json("packages/github-action/package.json").version,
  mcp: json("packages/mcp/package.json").version,
  framework: json("packages/framework/package.json").version,
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

const enrollment = "@scopebond/gateway@latest enroll";
if (!gatewayReadme.includes(enrollment)) {
  failures.push(`packages/gateway/README.md must use ${enrollment}`);
}

// The Claude Code plugin is served from this repository (the marketplace entry points at packages/hook), so its hooks
// file reaches plugin users on their next plugin update with no npm publish and no Version packages pull request. It
// must therefore be exactly the one command this repository ships: the hook, pinned to the version released here
// (scripts/sync-plugin-version.mjs keeps the pin in step). Anything else in it, a second hook included, fails.
const hookVersion = json("packages/hook/package.json").version;
const pluginHooksFile = "packages/hook/hooks/hooks.json";
const expectedPluginHooks = {
  hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `npx -y @scopebond/hook@${hookVersion} claude` }] }] },
};
let pluginHooks;
try { pluginHooks = json(pluginHooksFile); } catch (error) { failures.push(`${pluginHooksFile} is not valid JSON (${error.message})`); }
if (pluginHooks !== undefined && JSON.stringify(pluginHooks) !== JSON.stringify(expectedPluginHooks)) {
  const pins = JSON.stringify(pluginHooks).match(/@scopebond\/hook@[0-9A-Za-z.+-]+/g) ?? [];
  const stale = pins.find((pin) => pin !== `@scopebond/hook@${hookVersion}`);
  failures.push(stale
    ? `${pluginHooksFile} pins ${stale}; expected @scopebond/hook@${hookVersion} (run node scripts/sync-plugin-version.mjs)`
    : `${pluginHooksFile} must be exactly ${JSON.stringify(expectedPluginHooks)}: the plugin runs only the pinned hook`);
}
const pluginManifest = json("packages/hook/.claude-plugin/plugin.json");
if (pluginManifest.version !== hookVersion) failures.push(`packages/hook/.claude-plugin/plugin.json version ${pluginManifest.version}; expected ${hookVersion} (run node scripts/sync-plugin-version.mjs)`);
if (pluginManifest.hooks !== "./hooks/hooks.json") failures.push(`packages/hook/.claude-plugin/plugin.json must name "./hooks/hooks.json" as its hooks, not ${JSON.stringify(pluginManifest.hooks)}`);
// Claude Code also loads these from a plugin's folder without the manifest naming them; the plugin ships only the hook.
for (const key of ["commands", "agents", "skills", "mcpServers", "lspServers"]) {
  if (pluginManifest[key] !== undefined) failures.push(`packages/hook/.claude-plugin/plugin.json must not add ${key}: the plugin ships only the hook`);
}
for (const path of ["commands", "agents", "skills", ".mcp.json", ".lsp.json"]) {
  if (existsSync(`packages/hook/${path}`)) failures.push(`packages/hook/${path} would ship with the Claude Code plugin; the plugin ships only the hook`);
}
const marketplace = json(".claude-plugin/marketplace.json");
const listed = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
if (listed.length !== 1 || listed[0]?.source !== "./packages/hook") {
  failures.push(`.claude-plugin/marketplace.json must list exactly one plugin, with source "./packages/hook" (found ${JSON.stringify(listed.map((p) => p?.source))})`);
}

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
  + `gateway ${packages.gateway}, sdk ${packages.sdk}; all nine package references checked`,
);
