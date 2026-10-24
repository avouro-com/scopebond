// The version every installer of a release carries: three numbers, the agent package's. The Windows installer
// (build-msi.mjs) and the macOS package (build-pkg.mjs) both take it from here, so the macOS signing job can build the
// package without the Windows installer's script.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The installer's version: three numbers (the agent package's, unless `version` says otherwise). */
export function installerVersion(version = JSON.parse(readFileSync(join(here, "..", "agent", "package.json"), "utf8")).version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`an installer version is three numbers, not ${version}`);
  return version;
}
