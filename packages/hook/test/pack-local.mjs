// Packs workspace packages so that installing one of them never reaches the registry for another
// @scopebond package. `pnpm pack` rewrites `workspace:` dependencies to the versions this tree is
// about to publish, which npm cannot find until they are published (ETARGET on a release branch).
// Each tarball is unpacked, its @scopebond dependencies are pointed at the sibling tarballs with
// `file:`, and it is packed again, dependencies first. A global install, `npx -y <tarball>` and a
// project install then resolve the whole @scopebond tree from this checkout.
//
// The packages must be built (`pnpm -r build`). Tarballs already in `packDir` (for example the one
// a CI step packed) are reused; the rest are packed there.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const isWin = process.platform === "win32";
// Windows' own tar: Git's GNU tar, often first on PATH, reads "C:" as a remote host.
const tar = isWin ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
// CI puts pnpm on PATH; a developer may only have it through corepack.
let pnpmCommand = null;
const pnpm = (args) => {
  pnpmCommand ??= spawnSync("pnpm", ["--version"], { encoding: "utf8", shell: isWin }).status === 0 ? ["pnpm"] : ["corepack", "pnpm"];
  return spawnSync(pnpmCommand[0], [...pnpmCommand.slice(1), ...args], { encoding: "utf8", shell: isWin });
};

/** Every workspace package by name: its folder and manifest. */
function workspacePackages() {
  const packages = new Map();
  for (const dir of readdirSync(join(root, "packages"))) {
    const manifest = join(root, "packages", dir, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    packages.set(pkg.name, { dir: join(root, "packages", dir), pkg });
  }
  return packages;
}

const scoped = (pkg) => Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith("@scopebond/"));
const tarballName = (pkg) => `${pkg.name.replace(/^@/, "").replace("/", "-")}-${pkg.version}.tgz`;

/**
 * Packs `names` and every @scopebond package they depend on into `packDir`, then writes linked copies
 * (dependencies named by `file:` path) into `outDir`. Returns a map from package name to linked tarball.
 */
export function packLinked(names, { packDir = mkdtempSync(join(tmpdir(), "sb-pack-")), outDir = join(packDir, "linked") } = {}) {
  const packages = workspacePackages();
  mkdirSync(packDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  const order = [];
  const visit = (name, path = []) => {
    if (order.includes(name)) return;
    assert.ok(!path.includes(name), `dependency cycle: ${[...path, name].join(" -> ")}`);
    const entry = packages.get(name);
    assert.ok(entry, `${name} is not a workspace package`);
    assert.ok(!entry.pkg.private, `${name} is private and is never published`);
    for (const dep of scoped(entry.pkg)) visit(dep, [...path, name]);
    order.push(name);
  };
  for (const name of names) visit(name);

  const linked = new Map();
  for (const name of order) {
    const { dir, pkg } = packages.get(name);
    const packed = join(packDir, tarballName(pkg));
    if (!existsSync(packed)) {
      const r = pnpm(["--dir", dir, "pack", "--pack-destination", packDir]);
      assert.equal(r.status, 0, `pnpm pack ${name}: ${r.stdout}${r.stderr}`);
      assert.ok(existsSync(packed), `pnpm pack ${name} wrote no ${tarballName(pkg)} in ${packDir}`);
    }
    const work = mkdtempSync(join(tmpdir(), "sb-pack-unpacked-"));
    const untar = spawnSync(tar, ["-xzf", packed, "-C", work], { encoding: "utf8" });
    assert.equal(untar.status, 0, `tar ${packed}: ${untar.stderr}`);
    const manifest = join(work, "package", "package.json");
    const unpacked = JSON.parse(readFileSync(manifest, "utf8"));
    for (const dep of scoped(unpacked)) unpacked.dependencies[dep] = "file:" + linked.get(dep).replace(/\\/g, "/");
    writeFileSync(manifest, JSON.stringify(unpacked, null, 2) + "\n");
    // --ignore-scripts: the folder is a published package, not a source tree; nothing may rebuild it.
    const repack = spawnSync("npm", ["pack", "--ignore-scripts", "--pack-destination", outDir, join(work, "package")], { encoding: "utf8", shell: isWin });
    assert.equal(repack.status, 0, `npm pack ${name}: ${repack.stdout}${repack.stderr}`);
    const out = join(outDir, tarballName(pkg));
    assert.ok(existsSync(out), `npm pack ${name} wrote no ${tarballName(pkg)} in ${outDir}`);
    linked.set(name, out);
  }
  return linked;
}
