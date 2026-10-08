// A CycloneDX software bill of materials for the signed Windows files: every package the single executable's bundle
// contains (from esbuild's metafile), the Node it is built on, and every crate the native tray is built from (its
// committed Cargo.lock).
//
//   node sbom.mjs [build/meta.json] [out.cdx.json] [../tray/Cargo.lock]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The package.json that owns a bundled file: the nearest one above it. */
function owner(file) {
  let dir = dirname(resolve(here, file));
  while (dir !== dirname(dir)) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const json = JSON.parse(readFileSync(pkg, "utf8"));
      if (json.name && json.version) return { name: json.name, version: json.version, license: json.license ?? null };
    }
    dir = dirname(dir);
  }
  return null;
}

/** The crates a Cargo.lock names (version 3 or 4): name, version, and whether they come from crates.io. The lock's own
 *  packages (no `source`, such as the tray itself) are left out. */
export function cargoCrates(lockText) {
  const crates = [];
  for (const block of lockText.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (key) => new RegExp(`^${key} = "([^"]*)"\\s*$`, "m").exec(block)?.[1] ?? null;
    const name = field("name"), version = field("version"), source = field("source");
    if (!name || !version || !source) continue;
    crates.push({ name, version, registry: source.startsWith("registry+https://github.com/rust-lang/crates.io-index") || source === "sparse+https://index.crates.io/" });
  }
  return crates.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export function sbom(metafile, nodeVersion = process.versions.node, cargoLock = null) {
  const seen = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (input.startsWith("<")) continue;
    const pkg = owner(input.split("/").join(sep));
    if (!pkg || pkg.name === "@scopebond/native" || pkg.name === "scopebond") continue;
    seen.set(`${pkg.name}@${pkg.version}`, pkg);
  }
  const purl = (name, version) => `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
  const components = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({
    type: "library", name: p.name, version: p.version, purl: purl(p.name, p.version),
    ...(p.license ? { licenses: [{ license: { id: p.license } }] } : {}),
  }));
  components.push({ type: "platform", name: "node", version: nodeVersion, purl: `pkg:generic/node@${nodeVersion}`, licenses: [{ license: { id: "MIT" } }] });
  // The native tray's crates, as its Cargo.lock pins them (crates.io purls; a crate from elsewhere keeps a generic one).
  for (const c of cargoLock ? cargoCrates(cargoLock) : []) {
    components.push({
      type: "library", name: c.name, version: c.version,
      purl: c.registry ? `pkg:cargo/${c.name}@${c.version}` : `pkg:generic/${c.name}@${c.version}`,
      properties: [{ name: "scopebond:component", value: "scopebond-tray" }],
    });
  }
  return {
    bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
    metadata: { component: { type: "application", name: "scopebond-agent", version: seen.get([...seen.keys()].find((k) => k.startsWith("@scopebond/agent@")) ?? "")?.version ?? "0.0.0" } },
    components,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const meta = resolve(process.argv[2] ?? join(here, "build", "meta.json"));
  const out = resolve(process.argv[3] ?? join(here, "build", "scopebond-agent.cdx.json"));
  const lock = resolve(process.argv[4] ?? join(here, "..", "tray", "Cargo.lock"));
  if (!existsSync(lock)) throw new Error(`no Cargo.lock at ${lock}: the tray's crates would be missing from the SBOM`);
  writeFileSync(out, `${JSON.stringify(sbom(JSON.parse(readFileSync(meta, "utf8")), process.versions.node, readFileSync(lock, "utf8")), null, 2)}\n`);
  console.log(`wrote ${out}`);
}
