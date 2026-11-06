// A hook entry pinned to a Node that a version manager can uninstall: the health checks must notice when it is gone,
// and new entries name a launcher that outlives the uninstall when there is one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absoluteHookCommand, hookCommandResolves, isVersionManagedNode, MIN_NODE, stableNodePath } from "../dist/index.js";

test("hookCommandResolves: a pinned Node with no extension that was uninstalled is reported broken", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-fnm-"));
  const node = join(root, "node-versions", "v22.20.0", "installation", "bin", "node");
  mkdirSync(join(root, "node-versions", "v22.20.0", "installation", "bin"), { recursive: true });
  writeFileSync(node, "");
  const cli = join(root, "cli.js");
  writeFileSync(cli, "");
  const command = `${node} ${cli} claude`;
  assert.equal(hookCommandResolves(command), true);
  assert.equal(hookCommandResolves(`"${node}" "${cli}" claude`), true);
  rmSync(join(root, "node-versions"), { recursive: true, force: true }); // fnm uninstall 22.20.0
  assert.equal(hookCommandResolves(command), false, "the Node is gone, the script is not: the hook cannot start");
  assert.equal(hookCommandResolves(`"${node}" "${cli}" claude`), false);
  rmSync(root, { recursive: true, force: true });
});

test("Node folders of the version managers are recognised; system ones are not", () => {
  for (const p of [
    "/opt/person/.local/share/fnm/node-versions/v22.20.0/installation/bin/node",
    "/opt/person/Library/Application Support/fnm/node-versions/v22.20.0/installation/bin/node",
    "/var/folders/x/T/fnm_multishells/123_456/bin/node",
    "/opt/person/.volta/tools/image/node/22.20.0/bin/node",
    "/opt/person/.nvm/versions/node/v22.20.0/bin/node",
    "/opt/nvm/versions/node/v22.20.0/bin/node",
    "/opt/person/.asdf/installs/nodejs/22.20.0/bin/node",
    "/opt/person/.local/share/mise/installs/node/22.20.0/bin/node",
    "/opt/person/.nodenv/versions/22.20.0/bin/node",
  ]) assert.ok(isVersionManagedNode(p), p);
  for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "C:\\Program Files\\nodejs\\node.exe"]) assert.ok(!isVersionManagedNode(p), p);
});

test("a version-managed Node is swapped for fnm's default alias, else a system Node, when it starts a supported Node", () => {
  const home = "/opt/person";
  const fnmNode = `${home}/.local/share/fnm/node-versions/v22.20.0/installation/bin/node`;
  const alias = `${home}/.local/share/fnm/aliases/default/bin/node`;
  const base = { platform: "darwin", env: {}, home, realpath: (p) => p };
  const present = (...paths) => (p) => paths.includes(p);
  assert.equal(stableNodePath(fnmNode, { ...base, exists: present(alias, "/opt/homebrew/bin/node"), version: () => "22.20.0" }), alias);
  assert.equal(stableNodePath(fnmNode, { ...base, exists: present("/opt/homebrew/bin/node"), version: () => "24.1.0" }), "/opt/homebrew/bin/node");
  assert.equal(stableNodePath(fnmNode, { ...base, exists: present(alias), version: () => "20.11.0" }), fnmNode, `below ${MIN_NODE}: kept`);
  assert.equal(stableNodePath(fnmNode, { ...base, exists: present(alias), version: () => null }), fnmNode, "does not start: kept");
  // A Homebrew-path Node that is itself a link into a version manager is no more stable.
  const nvmNode = `${home}/.nvm/versions/node/v22.20.0/bin/node`;
  assert.equal(stableNodePath(nvmNode, { ...base, exists: present("/usr/local/bin/node"), realpath: (p) => (p === "/usr/local/bin/node" ? nvmNode : p), version: () => "22.20.0" }), nvmNode);
  // A Node outside any version manager is used as it is.
  assert.equal(stableNodePath("/opt/homebrew/bin/node", { ...base, exists: () => true, version: () => "22.20.0" }), "/opt/homebrew/bin/node");
});

test("absoluteHookCommand names the Node it is given", () => {
  if (process.platform === "win32") return;
  assert.equal(absoluteHookCommand("/opt/sb/cli.js", "claude", undefined, "/opt/homebrew/bin/node"), "/opt/homebrew/bin/node /opt/sb/cli.js claude");
});
