// A CycloneDX software bill of materials for the single executable: every package the bundle contains (from esbuild's
// metafile), and the Node it is built on.
//
//   node sbom.mjs [build/meta.json] [out.cdx.json]

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

export function sbom(metafile, nodeVersion = process.versions.node) {
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
  return {
    bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
    metadata: { component: { type: "application", name: "scopebond-agent", version: seen.get([...seen.keys()].find((k) => k.startsWith("@scopebond/agent@")) ?? "")?.version ?? "0.0.0" } },
    components,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const meta = resolve(process.argv[2] ?? join(here, "build", "meta.json"));
  const out = resolve(process.argv[3] ?? join(here, "build", "scopebond-agent.cdx.json"));
  writeFileSync(out, `${JSON.stringify(sbom(JSON.parse(readFileSync(meta, "utf8"))), null, 2)}\n`);
  console.log(`wrote ${out}`);
}
